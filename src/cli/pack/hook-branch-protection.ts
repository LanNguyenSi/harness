// `harness pack hook branch-protection`: PreToolUse blocker for the
// `branch-protection` policy pack (task a4d8adc5).
//
// Receives the runtime's PreToolUse event JSON on stdin and refuses the tool
// call when a directory it writes into belongs to a repository whose
// checked-out branch is protected. The branch is git's own answer
// (`git -C <dir> symbolic-ref -q HEAD`, src/runtime/git-branch.ts); this hook
// never reads git's files itself.
//
// Every event is judged twice, and the hook refuses when either judgment
// refuses or cannot answer; it allows only when both allow. The as-written
// judgment runs first.
//
//   1. As written: each path made absolute against the event cwd with `.` and
//      `..` resolved on the text (`path.resolve`), symlinks left in the path;
//      the presence walk runs on that text and git runs in that directory.
//      Write, Edit, MultiEdit, NotebookEdit: the nearest existing directory
//      holding the target path. Codex `apply_patch`: the same for every path
//      named by an `*** Add File:`, `*** Update File:`, `*** Delete File:` or
//      `*** Move to:` header line of the patch text in tool_input.patch,
//      tool_input.input or a string tool_input, relative to the event cwd.
//      Anything else, or a patch without a header there: the event cwd.
//   2. Physical, as the operating system resolves the path (symlinks
//      followed, `..` taken from the directory reached so far), which is the
//      directory `git -C` changes into. Write, Edit, MultiEdit, NotebookEdit:
//      the nearest existing directory of the target path (a Write may create
//      the directories in between), and, when the target is a symlink, the
//      directory it leads to as well. Codex `apply_patch`: the same for every
//      path named by a header line found in any string of the event (any
//      field or array of tool_input, raw_input or input, and JSON text inside
//      a string: the field Codex carries the patch in is not pinned). A
//      relative path resolves against the event cwd and, when the tool input
//      names a per-call `workdir` or `cwd`, against that as well. Anything
//      else, or a patch without a header: the event cwd (and that per-call
//      directory).
//
// Decision, per directory: git names a protected branch (compared
// case-insensitively) -> refuse; git could not answer (any error, a timeout,
// git missing, an unexpected answer) -> refuse with one fixed sentence naming
// git's first stderr line; a detached HEAD, or no `.git` entry anywhere above
// the directory -> allow. A manifest that does not load refuses every call.
// Resolving the paths and every git call are bounded, together, from the
// hook's start and below the pack's hook budget (a hook the runtime kills at
// its budget is read as an allow): past the bound the hook refuses.
//
// Block contract per runtime: Claude Code reads a JSON deny envelope on
// stdout (exit 0); Codex reads exit 2 with the reason on stderr
// (`--runtime codex`). The agent-facing text names `git checkout -b` as the
// way forward and nothing else.

import * as path from "node:path";
import {
  PACK_NAME,
  isProtectedBranch,
  resolveProtectedBranches,
} from "../../policy-packs/builtin/branch-protection-runtime.js";
import {
  GIT_BRANCH_TIMEOUT_MS,
  PathBoundError,
  absolutePath,
  nearestExistingDirectory,
  nearestExistingDirectoryAsWritten,
  readBranchAt,
  resolveDirectory,
  writeTargetDirectories,
  type BranchRead,
  type GitHeadReader,
  type PathResolution,
} from "../../runtime/git-branch.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import { type Manifest, type PolicyUx } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  loadManifestOrInjected,
  parseConfigUx,
  pickString,
  readStdinChecked,
} from "./hook-bootstrap.js";

/**
 * Bound on resolving the paths and on all git calls of one event together,
 * in ms, counted from the moment the hook starts (the stdin read and the
 * manifest load included), so neither a slow stdin nor a large event can
 * push the hook past its budget.
 */
export const GIT_READ_DEADLINE_MS = 3000;

/** The runtimes whose block contract this hook speaks. */
export const BRANCH_PROTECTION_RUNTIMES = ["claude-code", "codex"] as const;

const CODEX_EXIT_BLOCK = 2;

export interface PackHookBranchProtectionOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Override the cwd resolution (test injection). */
  cwd?: string;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Block contract: `claude-code` (default) or `codex`. */
  runtime?: string;
  /** Inject the git runner (test). */
  gitReader?: GitHeadReader;
  /** Bound on one git call in ms (test). */
  gitTimeoutMs?: number;
  /** Bound on the path resolution and all git calls of one event, from the hook's start, in ms (test). */
  gitDeadlineMs?: number;
  /** Inject the clock the bound is measured with, in ms (test). Defaults to Date.now. */
  now?: () => number;
}

export interface PackHookBranchProtectionResult {
  exitCode: number;
  blocked: boolean;
  /** Diagnostic line emitted to stderr (always, even on allow). */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  tool?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
  raw_input?: unknown;
  input?: unknown;
}

/** Target path of the Claude Code tools that write a single file. */
function singleTargetPath(toolName: string, toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  switch (toolName) {
    case "Write":
    case "Edit":
    case "MultiEdit":
      return pickString(input["file_path"]) ?? null;
    case "NotebookEdit":
      return pickString(input["notebook_path"]) ?? null;
    default:
      return null;
  }
}

/**
 * Every string in `value`, in document order: objects and arrays are walked,
 * and a string holding JSON text is parsed and walked too.
 */
function stringsIn(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      out.push(v);
      const t = v.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          stack.push(JSON.parse(t));
        } catch {
          /* not JSON text */
        }
      }
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i -= 1) stack.push(v[i]);
    } else if (typeof v === "object" && v !== null) {
      const children = Object.values(v as Record<string, unknown>);
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return out;
}

const PATCH_HEADER = /^\*\*\*\s*(?:Add File|Update File|Delete File|Move to):\s*(.+)$/;

/** The paths named by the file header lines of one text. */
function headerPaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const m = PATCH_HEADER.exec(raw.trim());
    const target = m?.[1]?.trim() ?? "";
    if (target.length > 0) out.push(target);
  }
  return out;
}

/**
 * Every path an `apply_patch` call names in a file header line, read from
 * every string of `value` (the whole event, or any part of it), each once.
 */
export function patchTargetPaths(value: unknown): string[] {
  return [...new Set(stringsIn(value).flatMap(headerPaths))];
}

/** The patch text the as-written judgment reads: tool_input.patch, tool_input.input or a string tool_input. */
function asWrittenPatchText(toolInput: unknown): string {
  if (typeof toolInput === "string") return toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const input = toolInput as Record<string, unknown>;
  return pickString(input["patch"], input["input"]) ?? "";
}

/**
 * The directories an `apply_patch` call's relative paths resolve against:
 * the event cwd, plus a per-call `workdir` or `cwd` named in tool_input,
 * raw_input or input.
 */
function patchBaseDirectories(event: ToolEventLite, cwd: string): string[] {
  const bases = [cwd];
  for (const holder of [event.tool_input, event.raw_input, event.input]) {
    if (typeof holder !== "object" || holder === null || Array.isArray(holder)) continue;
    const fields = holder as Record<string, unknown>;
    for (const key of ["workdir", "cwd"]) {
      const value = pickString(fields[key]);
      if (value !== undefined) bases.push(absolutePath(value, cwd));
    }
  }
  return [...new Set(bases)];
}

interface CheckTargets {
  source: "target" | "patch" | "cwd";
  dirs: string[];
}

/**
 * The directories of the as-written judgment: each path made absolute
 * against the event cwd with `.` and `..` resolved on the text, then its
 * nearest existing directory with symlinks left in place.
 */
function asWrittenTargets(toolName: string, toolInput: unknown, cwd: string, res: PathResolution): CheckTargets {
  const single = singleTargetPath(toolName, toolInput);
  const paths = single !== null ? [single] : toolName === "apply_patch" ? [...new Set(headerPaths(asWrittenPatchText(toolInput)))] : [];
  if (paths.length === 0) return { source: "cwd", dirs: [nearestExistingDirectoryAsWritten(cwd, res)] };
  const dirs = paths.map((p) => nearestExistingDirectoryAsWritten(path.dirname(path.resolve(cwd, p)), res));
  return { source: single !== null ? "target" : "patch", dirs: [...new Set(dirs)] };
}

/** The directories of the physical judgment: where the operating system resolves each path. */
function checkTargets(toolName: string, event: ToolEventLite, cwd: string, res: PathResolution): CheckTargets {
  const single = singleTargetPath(toolName, event.tool_input);
  if (single !== null) return { source: "target", dirs: writeTargetDirectories(single, cwd, res) };
  if (toolName !== "apply_patch") return { source: "cwd", dirs: [nearestExistingDirectory(cwd, res)] };
  const bases = patchBaseDirectories(event, cwd);
  const paths = patchTargetPaths(event);
  if (paths.length === 0) return { source: "cwd", dirs: [...new Set(bases.map((b) => nearestExistingDirectory(b, res)))] };
  const dirs = paths.flatMap((p) => (path.isAbsolute(p) ? [cwd] : bases).flatMap((b) => writeTargetDirectories(p, b, res)));
  return { source: "patch", dirs: [...new Set(dirs)] };
}

/** One judgment of an event: the directories it names, and where each one is walked and asked. */
interface Judgment {
  targets: (res: PathResolution) => CheckTargets;
  /** The directory the presence walk and git run in for `dir`, or why there is none. */
  at: (dir: string) => { kind: "path"; path: string } | { kind: "error"; detail: string };
}

function claudeBlockEnvelope(reason: string): string {
  return JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** Agent-facing text for a protected branch: the ux block, or the default. */
function protectedBranchText(
  toolName: string,
  branch: string,
  dir: string,
  protectedList: readonly string[],
  ux: PolicyUx | undefined,
  sessionId: string,
): string {
  if (ux) {
    return renderAgentFacing(ux, { BRANCH: branch, TOOL_NAME: toolName, SESSION_ID: sessionId });
  }
  return (
    `branch-protection: refusing ${toolName} on protected branch "${branch}" (checked in ${dir}).\n` +
    `Create a feature branch first, then retry:\n` +
    `  git checkout -b <feature>\n` +
    `Protected branches: ${protectedList.join(", ")}.`
  );
}

/**
 * `harness pack hook branch-protection`. `opts.runtime` selects the block
 * contract; an unknown value refuses with exit 2, which both runtimes read as
 * a block.
 */
export async function runPackHookBranchProtectionCli(
  opts: PackHookBranchProtectionOptions = {},
): Promise<PackHookBranchProtectionResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook branch-protection: ${msg}\n`);
  };
  const allow = (diagnostic: string): PackHookBranchProtectionResult => {
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  };

  const runtime = opts.runtime ?? "claude-code";
  if (!(BRANCH_PROTECTION_RUNTIMES as readonly string[]).includes(runtime)) {
    const diagnostic = `BLOCK: unknown --runtime ${JSON.stringify(runtime)} (expected ${BRANCH_PROTECTION_RUNTIMES.join(" or ")}); refusing`;
    note(diagnostic);
    return { exitCode: CODEX_EXIT_BLOCK, blocked: true, diagnostic };
  }
  const block = (detail: string, agentText: string): PackHookBranchProtectionResult => {
    const diagnostic = `BLOCK: ${detail}`;
    note(diagnostic);
    if (runtime === "codex") {
      stderr.write(`${agentText}\n`);
      return { exitCode: CODEX_EXIT_BLOCK, blocked: true, diagnostic };
    }
    stdout.write(`${claudeBlockEnvelope(agentText)}\n`);
    return { exitCode: 0, blocked: true, diagnostic };
  };

  // A read that timed out never received the whole event, so nothing can be
  // judged: refuse. Same wording as the other gates' stdin-timeout refusal,
  // minus their operator-pause hint: this gate does not yield to a pause.
  const read = await readStdinChecked(opts.stdin ?? process.stdin);
  if (read.timedOut) {
    const reason =
      `stdin timeout: no complete event arrived and closed on stdin within ${read.idleTimeoutMs} ms, ` +
      `so branch-protection cannot judge the tool call and refuses it (fail closed). Retry the tool call.`;
    return block(reason, reason);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const detail = "the event on stdin is not a JSON object";
    return block(detail, `branch-protection: refusing the tool call: ${detail}, so it cannot be judged.`);
  }
  const event = parsed as ToolEventLite;

  const toolName = pickString(event.tool_name, event.tool) ?? "(unknown)";
  const sessionId = pickString(event.session_id) ?? "";
  const cwdText = pickString(opts.cwd, event.cwd) ?? process.cwd();

  // Without the manifest the gate cannot know whether it is enabled or what
  // is protected, so a load failure refuses.
  let manifest: Manifest;
  try {
    ({ manifest } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    const detail = `the harness manifest could not be loaded (${(err as Error).message})`;
    return block(`${detail}; refusing on failsafe`, `branch-protection: refusing ${toolName}: ${detail}.`);
  }

  const pack = manifest.policy_packs.find((p) => p.name === PACK_NAME);
  if (!pack) return allow(`pack "${PACK_NAME}" not declared in manifest, allowing`);
  if (!pack.enabled) return allow(`pack "${PACK_NAME}" is enabled:false, allowing`);

  const { branches: protectedList } = resolveProtectedBranches(pack);
  const configUx = parseConfigUx(
    (pack.config as Record<string, unknown>)["ux"],
    stderr,
    "harness pack hook branch-protection",
  );

  const deadlineMs = opts.gitDeadlineMs ?? GIT_READ_DEADLINE_MS;
  const perCallMs = opts.gitTimeoutMs ?? GIT_BRANCH_TIMEOUT_MS;
  const deadline = startedAt + deadlineMs;
  const bound: PathResolution = { overBound: () => now() >= deadline, memo: new Map() };
  const asWritten: Judgment = {
    targets: (res) => asWrittenTargets(toolName, event.tool_input, path.resolve(cwdText), res),
    at: (dir) => ({ kind: "path", path: dir }),
  };
  const physical: Judgment = {
    targets: (res) => checkTargets(toolName, event, absolutePath(cwdText), res),
    at: resolveDirectory,
  };
  // Both judgments, the as-written one first: the hook allows only what both allow.
  const judgments = [asWritten, physical];

  // Each directory git ran in is read once per event.
  const answers = new Map<string, BranchRead>();
  const sources: string[] = [];
  const seen: string[] = [];
  try {
    for (const judgment of judgments) {
      const targets = judgment.targets(bound);
      if (!sources.includes(targets.source)) sources.push(targets.source);
      for (const dir of targets.dirs) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          const detail = `the branch of ${dir} was not checked: the hook passed its ${deadlineMs} ms bound`;
          return block(detail, `branch-protection: refusing ${toolName}: git could not report the branch of ${dir} (${detail}).`);
        }
        const at = judgment.at(dir);
        let branchRead: BranchRead;
        if (at.kind === "error") {
          branchRead = at;
        } else {
          const known = answers.get(at.path);
          if (known !== undefined) continue;
          branchRead = await readBranchAt(at.path, {
            ...(opts.gitReader !== undefined ? { reader: opts.gitReader } : {}),
            timeoutMs: Math.min(perCallMs, remaining),
          });
          answers.set(at.path, branchRead);
        }
        switch (branchRead.kind) {
          case "error":
            return block(
              `git could not report the branch of ${dir}: ${branchRead.detail}`,
              `branch-protection: refusing ${toolName}: git could not report the branch of ${dir} (${branchRead.detail}).`,
            );
          case "branch":
            if (isProtectedBranch(branchRead.name, protectedList)) {
              return block(
                `branch "${branchRead.name}" of ${dir} is protected (${protectedList.join(", ")})`,
                protectedBranchText(toolName, branchRead.name, dir, protectedList, configUx, sessionId),
              );
            }
            seen.push(`${dir}: branch "${branchRead.name}" is not in the protected list (${protectedList.join(", ")})`);
            break;
          case "detached":
            seen.push(`${dir}: detached HEAD`);
            break;
          case "outside":
            seen.push(`${dir}: outside any git repository`);
            break;
        }
      }
    }
  } catch (err) {
    // Fail closed: a path that could not be resolved within the bound, or
    // any other failure while judging, refuses.
    const detail =
      err instanceof PathBoundError
        ? `the paths of the tool call were not resolved: the hook passed its ${deadlineMs} ms bound`
        : `the tool call could not be judged (${err instanceof Error ? err.message : String(err)})`;
    return block(detail, `branch-protection: refusing ${toolName}: ${detail}.`);
  }
  return allow(`${sources.join("+")} ${seen.join("; ")}; allowing`);
}
