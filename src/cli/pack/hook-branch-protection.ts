// `harness pack hook branch-protection`: PreToolUse blocker for the
// `branch-protection` policy pack (task a4d8adc5).
//
// Receives the runtime's PreToolUse event JSON on stdin and refuses the tool
// call when a directory it writes into belongs to a repository whose
// checked-out branch is protected. The branch is git's own answer
// (`git -C <dir> symbolic-ref -q HEAD`, src/runtime/git-branch.ts); this hook
// never reads git's files itself.
//
// Directories checked, each as the operating system resolves the path
// (symlinks followed, `..` taken from the directory reached so far), which is
// where the write lands and where `git -C` looks:
//   - Write, Edit, MultiEdit, NotebookEdit: the nearest existing directory of
//     the target path (a Write may create the directories in between), and,
//     when the target is a symlink, the directory it leads to as well.
//   - Codex `apply_patch`: the same for every path named by an
//     `*** Add File:`, `*** Update File:`, `*** Delete File:` or
//     `*** Move to:` header line found in any string of the event (any field
//     or array of tool_input, raw_input or input, and JSON text inside a
//     string: the field Codex carries the patch in is not pinned). A relative
//     path resolves against the event cwd and, when the tool input names a
//     per-call `workdir` or `cwd`, against that as well.
//   - Anything else, or a patch without a header: the event cwd (and a
//     per-call `workdir` or `cwd` of an `apply_patch`).
//
// Decision, per directory: git names a protected branch (compared
// case-insensitively) -> refuse; git could not answer (any error, a timeout,
// git missing, an unexpected answer) -> refuse with one fixed sentence naming
// git's first stderr line; a detached HEAD, or no `.git` entry anywhere above
// the directory -> allow. A manifest that does not load refuses every call.
// Every git call is bounded, and so are all calls of one event together,
// below the pack's hook budget: a hook the runtime kills at its budget is
// read as an allow.
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
  absolutePath,
  nearestExistingDirectory,
  readBranch,
  writeTargetDirectories,
  type GitHeadReader,
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
 * Bound on all git calls of one event together, in ms, counted from the
 * moment the hook starts (the stdin read and the manifest load included), so
 * a slow stdin cannot push the git reads past the hook budget.
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
  /** Bound on all git calls of one event, from the hook's start, in ms (test). */
  gitDeadlineMs?: number;
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

/**
 * Every path an `apply_patch` call names in a file header line, read from
 * every string of `value` (the whole event, or any part of it).
 */
export function patchTargetPaths(value: unknown): string[] {
  const out: string[] = [];
  for (const text of stringsIn(value)) {
    for (const raw of text.split("\n")) {
      const m = PATCH_HEADER.exec(raw.trim());
      const target = m?.[1]?.trim() ?? "";
      if (target.length > 0) out.push(target);
    }
  }
  return out;
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

function checkTargets(toolName: string, event: ToolEventLite, cwd: string): CheckTargets {
  const single = singleTargetPath(toolName, event.tool_input);
  if (single !== null) return { source: "target", dirs: writeTargetDirectories(single, cwd) };
  if (toolName !== "apply_patch") return { source: "cwd", dirs: [nearestExistingDirectory(cwd)] };
  const bases = patchBaseDirectories(event, cwd);
  const paths = patchTargetPaths(event);
  if (paths.length === 0) return { source: "cwd", dirs: [...new Set(bases.map((b) => nearestExistingDirectory(b)))] };
  const dirs = paths.flatMap((p) => (path.isAbsolute(p) ? [cwd] : bases).flatMap((b) => writeTargetDirectories(p, b)));
  return { source: "patch", dirs: [...new Set(dirs)] };
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
  const startedAt = Date.now();
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
  // Kept as written: the directories are resolved through the filesystem.
  const cwd = absolutePath(pickString(opts.cwd, event.cwd) ?? process.cwd());

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

  const targets = checkTargets(toolName, event, cwd);
  const deadlineMs = opts.gitDeadlineMs ?? GIT_READ_DEADLINE_MS;
  const perCallMs = opts.gitTimeoutMs ?? GIT_BRANCH_TIMEOUT_MS;
  const deadline = startedAt + deadlineMs;
  const seen: string[] = [];
  for (const dir of targets.dirs) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const detail = `the branch of ${dir} was not checked: the hook passed its ${deadlineMs} ms bound`;
      return block(detail, `branch-protection: refusing ${toolName}: git could not report the branch of ${dir} (${detail}).`);
    }
    const branchRead = await readBranch(dir, {
      ...(opts.gitReader !== undefined ? { reader: opts.gitReader } : {}),
      timeoutMs: Math.min(perCallMs, remaining),
    });
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
  return allow(`${targets.source} ${seen.join("; ")}; allowing`);
}
