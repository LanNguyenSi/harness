// `harness pack hook solution-acceptance-writeguard` — PreToolUse
// anti-forgery write-guard for the `solution-acceptance` policy pack.
//
// This is the load-bearing closure of the gate. The completion-gate alone
// is forgeable: relocating the verdict dir does NOT help because
// understanding-gate allows all Bash once approved, so an approved agent
// could `echo '{...ready:true}' > <verdict-dir>/<id>.json` and walk the gate.
// This hook restores the invariant that the ONLY writer of the verdict dir
// is the producer (the operator-launched grounding-mcp MCP server, which
// runs real preflight and does not flow through the agent's gated tools).
//
// It denies, on the agent's tool surface:
//   - Write / Edit / MultiEdit / NotebookEdit whose target file resolves
//     inside the verdict dir.
//   - Codex `apply_patch` whose patch body references the verdict dir.
//   - Bash that is NOT provably read-only AND references the verdict dir
//     (covers `echo >`, `$SOLUTION_VERDICT_DIR` spellings, `tee`, `mv`/`cp`/
//     `ln`/`install`, `python3 -c '...path...'`, and `chmod`/`chattr` that
//     would loosen perms) — or whose shell cwd is inside the dir.
//   - Bash `cd` whose RESOLVED target is inside the verdict dir. `cd` itself
//     is provably read-only (task fb67b402 added it to the shared
//     read-only-bash floor: it mutates only the invoking shell's own cwd,
//     never the filesystem), so it no longer reaches the "not read-only"
//     checks below. But stepping into the dir is the setup half of a
//     two-call forge (`cd <dir>` then, in a LATER un-chained Bash call,
//     a bare relative write): this pre-check keeps that first step blocked
//     as defense-in-depth, ahead of (not instead of) the cwd-inside check
//     below, which is what actually closes the later relative-write call
//     once cwd has genuinely moved. A `cd` target that `path.resolve`
//     cannot literally evaluate does NOT get `cd`'s read-only fast path
//     either: it falls through to the same reference-based checks as any
//     other non-read-only Bash. `CD_TARGET_UNRESOLVABLE_CHARS` documents
//     exactly WHICH expansions this enumerates (quoting, `$`/env-var,
//     `~`, glob, and `{...}` brace expansion) — that list is what this
//     check catches, not a claim that every shell-expansion class is
//     closed. Known-open residual, pre-existing (not introduced by this
//     branch, since it applies to `bashReferencesVerdictDir`'s textual
//     match on ANY Bash command, not just `cd`): a backslash-escaped
//     spelling of the leaf, e.g. `cd <parent>/solution\-verdicts`, still
//     navigates into the dir under bash (verified against bash 3.2.57)
//     while `bashReferencesVerdictDir` returns false — the backslash
//     breaks the literal-leaf substring match and no metacharacter here
//     triggers the glob/brace fallback either. Closing it needs
//     shell-unescaping in the textual check itself, which is more than
//     this task absorbs; do not assume the class is closed.
//     A SECOND residual of the same class, and on a macOS operator
//     machine the more reachable of the two: case variance.
//     `cd <parent>/SOLUTION-VERDICTS` navigates into the dir on a
//     case-insensitive APFS volume, but `isInsideDir` compares with a
//     case-sensitive `path.relative` and the textual check uses a
//     case-sensitive `includes`, so both return false. Also allowed:
//     a trailing backslash, `cd <DIR>\`. Both pre-existing; closing
//     them needs case-folding in the textual check.
//
// Pure reads (`cat <dir>/x.json`) are allowed so the guard is not over-broad.
//
// No manifest is consulted: the decision is a pure target-vs-dir check, so
// the guard cannot be broken by a manifest issue and never blocks a write
// that does not target the verdict dir. The hook is only wired into settings
// when the pack is enabled, so a disabled pack never invokes it. It yields to
// `harness pause` like every other gate.
//
// Honest residual (operator decision, 2026-05-30): v1 closes the ENUMERATED
// write paths above. A path constructed at runtime inside an interpreter
// with no textual reference is NOT caught; marker signing (a cross-repo
// follow-up) closes content-authenticity against an unguarded write
// primitive. The `cd`-target check added later (task fb67b402) has its own
// enumerated, not exhaustive, expansion list — see the bullet above and
// `CD_TARGET_UNRESOLVABLE_CHARS`'s docstring for the backslash-escaping
// residual specifically.

import {
  bashReferencesVerdictDir,
  isInsideDir,
  PACK_NAME,
  verdictDir as resolveVerdictDir,
} from "../../policy-packs/builtin/solution-acceptance-runtime.js";
import { isReadOnlyBashCommand } from "../../runtime/read-only-bash.js";
import type { LoaderOptions } from "../loader.js";
import { checkHookPause, readStdin } from "./hook-bootstrap.js";

export interface PackHookSolutionAcceptanceWriteguardOptions extends LoaderOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Override cwd resolution (test injection). */
  cwd?: string;
  /** Override the verdict directory (test injection; default = producer default). */
  verdictDir?: string;
}

export interface PackHookSolutionAcceptanceWriteguardResult {
  exitCode: number;
  blocked: boolean;
  diagnostic: string;
}

interface ToolEventLite {
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
}

/** Single-file target for path-mutating tools, or null when not applicable. */
function pathToolTarget(toolName: string, toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  switch (toolName) {
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const fp = input["file_path"];
      return typeof fp === "string" && fp.length > 0 ? fp : null;
    }
    case "NotebookEdit": {
      const np = input["notebook_path"];
      return typeof np === "string" && np.length > 0 ? np : null;
    }
    default:
      return null;
  }
}

function bashCommandOf(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const cmd = (toolInput as Record<string, unknown>)["command"];
  return typeof cmd === "string" ? cmd : "";
}

/**
 * Extract `cd`'s destination argument from a Bash command string, or null
 * when the command is not a `cd` invocation or has no statically resolvable
 * destination. Whitespace-tokenized, same as `read-only-bash.ts`'s own
 * classifier (this hook does not shell-parse either).
 *
 * Deliberately narrow:
 *   - Only fires when the FIRST token is exactly `cd`. `env cd x` or a
 *     chained `foo && cd x` do not match here (tokens[0] would be `env` /
 *     `foo`); those are unaffected by this pre-check and are still governed
 *     by the existing not-read-only + `bashReferencesVerdictDir` checks
 *     below, which already close the `cd <parent> && write <relative>`
 *     descent via the leaf-segment match.
 *   - `cd`'s own flags (`-L`, `-P`, `-e`, `-@`, and combinations) are
 *     skipped to find the first positional path argument.
 *   - `cd -` (switch to `$OLDPWD`) and a bare `cd` (goes to `$HOME`) have no
 *     destination this function can resolve without ambient shell state;
 *     both return null (not flagged), the same conservative stance as the
 *     rest of this module's enumerated-path checks.
 *   - A single layer of surrounding quotes (`"..."` or `'...'`) is stripped
 *     from the returned token before the caller does anything with it, so
 *     `cd "<path>"` and `cd <path>` are treated identically (both the
 *     resolved-path inside-dir check AND the unresolvable-chars check see
 *     the same unquoted value). Without this, a quoted literal that merely
 *     shares a text prefix with the verdict dir (`cd "<dir>-decoy"`) would
 *     route to the textual leaf match and be wrongly blocked, while the
 *     unquoted `cd <dir>-decoy` correctly passes via the resolved-path
 *     check — spelling-dependent behavior for what is the same destination.
 */
function cdTargetArgument(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "cd") return null;
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === "-") return null;
    if (t.startsWith("-")) continue;
    return stripSurroundingQuotes(t);
  }
  return null;
}

/**
 * Strip one layer of surrounding double or single quotes from `token`, or
 * return it unchanged if it is not fully wrapped in a matching pair. Does
 * NOT attempt any other shell-quoting semantics (no backslash-escape
 * handling, no nested-quote handling) — this is a narrow normalization so a
 * simple quoted literal reads the same as its unquoted form, not a shell
 * parser.
 */
function stripSurroundingQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Characters/sequences that make a `cd` destination token something
 * `path.resolve` cannot literally evaluate: quoting (`"`, `'` — the residual
 * case after `stripSurroundingQuotes` has already removed a clean single
 * layer, e.g. an unbalanced or embedded quote), env-var expansion (`$`),
 * home-directory expansion (`~`), shell globbing (`*`, `?`, `[`), and brace
 * expansion (`{`, `}`, `,`). `path.resolve` treats the raw token as a
 * literal path segment, so `cd "$SOLUTION_VERDICT_DIR"`, `cd
 * ~/.../solution-verdicts`, or `cd <parent>/{solution-verdicts,x}` all
 * resolve to a nonsense path that is never "inside" the dir even though a
 * real shell would expand each of them TO (or, for the brace form, INTO)
 * the dir. A `cd` target containing any of these must therefore NOT take
 * the read-only fast path in `evaluateWriteGuard`: control must fall
 * through to the same `bashReferencesVerdictDir` text-reference check any
 * other non-read-only Bash command goes through, which DOES recognize
 * these spellings (the env-var token, the `agent-grounding/solution-verdicts`
 * tail, and — after the matching widening in
 * `solution-acceptance-runtime.ts`'s glob-metacharacter test — glob- and
 * brace-obscured leaf words).
 *
 * This list is enumerated, not exhaustive: it is exactly the expansion
 * classes this check has been reasoned about, not a claim that every way a
 * shell can rewrite a `cd` argument is covered. A known-open residual
 * (pre-existing, not introduced by this check) is backslash escaping — see
 * the module header's "Known-open residual" note.
 */
const CD_TARGET_UNRESOLVABLE_CHARS = /[$~*?[{},"']/;

interface Decision {
  blocked: boolean;
  reason: string;
}

/**
 * Pure write-guard decision for a tool event. Exported for direct unit
 * testing of the full forge-attempt matrix without spinning up the CLI.
 */
export function evaluateWriteGuard(
  toolName: string,
  toolInput: unknown,
  dir: string,
  cwd: string,
): Decision {
  // Path-mutating tools: block iff the target resolves inside the dir.
  const target = pathToolTarget(toolName, toolInput);
  if (target !== null) {
    if (isInsideDir(target, dir, cwd)) {
      return {
        blocked: true,
        reason: `${toolName} target resolves inside the harness-protected solution-verdict dir (${dir}); the verdict marker may only be written by the grounding-mcp producer`,
      };
    }
    return { blocked: false, reason: `${toolName} target is outside the verdict dir` };
  }

  // Codex apply_patch: best-effort textual reference check on the patch body.
  if (toolName === "apply_patch") {
    const input =
      typeof toolInput === "object" && toolInput !== null
        ? (toolInput as Record<string, unknown>)
        : {};
    const body =
      typeof input["patch"] === "string"
        ? (input["patch"] as string)
        : typeof input["input"] === "string"
          ? (input["input"] as string)
          : JSON.stringify(toolInput ?? "");
    if (bashReferencesVerdictDir(body, dir)) {
      return {
        blocked: true,
        reason: `apply_patch references the harness-protected solution-verdict dir (${dir})`,
      };
    }
    return { blocked: false, reason: "apply_patch does not reference the verdict dir" };
  }

  // Bash: allow provable reads; block non-read-only commands that reference
  // the dir, or whose shell cwd is inside it.
  if (toolName === "Bash") {
    const command = bashCommandOf(toolInput);
    if (command === "") return { blocked: false, reason: "empty Bash command" };

    // Defense-in-depth, ahead of the read-only fast path below: `cd` itself
    // cannot write, but `cd`ing into the verdict dir is the setup half of a
    // two-call forge (see the module header). Only a RESOLVED-path check
    // (via the shared `isInsideDir`, not a substring match) so a sibling
    // that merely shares a text prefix with the dir (`solution-verdicts-decoy`,
    // or a parent directory of it) is not wrongly flagged.
    const cdTarget = cdTargetArgument(command);
    if (cdTarget !== null && isInsideDir(cdTarget, dir, cwd)) {
      return {
        blocked: true,
        reason: `cd targets the harness-protected solution-verdict dir (${dir}); stepping into it would set up a later un-chained relative write to forge the verdict marker`,
      };
    }
    // A `cd` target containing one of the enumerated unresolvable
    // expansions (see `CD_TARGET_UNRESOLVABLE_CHARS`'s docstring for the
    // exact list and its non-exhaustive scope) must not take `cd`'s
    // read-only fast path below: without this, `cd "$SOLUTION_VERDICT_DIR"`
    // etc. would be waved through by `isReadOnlyBashCommand` (true for ANY
    // `cd`, per the shared read-only-bash floor) before ever reaching the
    // reference check that recognizes these exact spellings.
    const cdTargetUnresolvable =
      cdTarget !== null && CD_TARGET_UNRESOLVABLE_CHARS.test(cdTarget);

    if (!cdTargetUnresolvable && isReadOnlyBashCommand(command)) {
      return { blocked: false, reason: "read-only Bash command" };
    }
    if (isInsideDir(".", dir, cwd)) {
      return {
        blocked: true,
        reason: `non-read-only Bash with a shell cwd inside the harness-protected solution-verdict dir (${dir})`,
      };
    }
    if (bashReferencesVerdictDir(command, dir)) {
      return {
        blocked: true,
        reason: `non-read-only Bash references the harness-protected solution-verdict dir (${dir}); the verdict marker may only be written by the grounding-mcp producer`,
      };
    }
    return { blocked: false, reason: "non-read-only Bash does not reference the verdict dir" };
  }

  return { blocked: false, reason: `${toolName} is not a guarded write surface` };
}

function blockJson(toolName: string, reason: string): string {
  const text =
    `solution-acceptance write-guard: refusing ${toolName}. ${reason}.\n` +
    `The solution-acceptance verdict marker is derived by the producer from a ` +
    `real preflight run; hand-writing it would forge a green "done". ` +
    `Run \`mcp__agent-grounding__solution_evaluate({ id: "<task-id>" })\` instead, ` +
    `which writes the marker for you.\n` +
    `Operator override: \`harness pause\`.`;
  return JSON.stringify({
    decision: "block",
    reason: text,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: text,
    },
  });
}

export async function runPackHookSolutionAcceptanceWriteguardCli(
  opts: PackHookSolutionAcceptanceWriteguardOptions = {},
): Promise<PackHookSolutionAcceptanceWriteguardResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook solution-acceptance-writeguard: ${msg}\n`);
  };

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    /* event stays {} -> not a guarded surface -> allow */
  }

  if (checkHookPause(`${PACK_NAME}-writeguard`, stderr, opts).paused) {
    const diagnostic = "harness paused; write-guard allowing without evaluating.";
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";
  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();
  const dir = opts.verdictDir ?? resolveVerdictDir();

  const decision = evaluateWriteGuard(toolName, event.tool_input, dir, cwd);
  if (!decision.blocked) {
    const diagnostic = `allow — ${decision.reason}`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const diagnostic = `BLOCK — ${decision.reason}`;
  note(diagnostic);
  stdout.write(`${blockJson(toolName, decision.reason)}\n`);
  return { exitCode: 0, blocked: true, diagnostic };
}
