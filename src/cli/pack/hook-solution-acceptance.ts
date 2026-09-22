// `harness pack hook solution-acceptance` — PreToolUse completion-gate for
// the `solution-acceptance` policy pack.
//
// Receives Claude Code's PreToolUse event JSON on stdin and emits a
// `{ decision: "block" }` envelope when the agent is about to FINISH a task
// (agent-tasks completion verb, or a `git push` / `gh pr merge` bash
// command) without a READY solution-acceptance verdict at the current git
// HEAD.
//
// The verdict id is the active-claim task id (the same `active-claim` file
// `harness approve understanding` consumes). For solo / non-agent-tasks
// sessions that never call `task_start`, the `SOLUTION_VERDICT_ID` env knob
// supplies the id instead; it is consulted only when no active claim is
// present, so a claimed session's id stays authoritative (an env var cannot
// redirect a claimed task's verdict). With neither source the gate fails
// CLOSED — a sessionId fallback would reopen the wrong-scope bug class
// understanding-gate already fixed.
//
// Failure mode: any error in load / parse / HEAD-resolution / verdict-read
// resolves to BLOCK (branch-protection's fail-closed posture, not
// understanding-gate's fail-open). The gate's whole job is to prevent
// completion without earned acceptance, so a bug that silently allowed a
// finish through would defeat the purpose. The block envelope always names
// `solution_evaluate` as the recovery path so the operator is never wedged;
// `harness pause` (honored first) is the operator's hard override.

import * as path from "node:path";
import {
  readActiveClaim,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  DEFAULT_PUSH_BASH_RE,
  evaluateGate,
  PACK_NAME,
  readVerdict,
  resolveExplicitVerdictId,
  resolveProtectedCompletionTools,
  sanitizeVerdictId,
  VERDICT_ID_ENV,
  verdictDir as resolveVerdictDir,
  verdictPathFor,
} from "../../policy-packs/builtin/solution-acceptance-runtime.js";
import { renderReconnectDenyParagraph } from "../../policy-packs/builtin/solution-acceptance-reconnect.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import { checkFileLock, type LockCheckResult } from "../../io/lock.js";
import { probePathPresence } from "../../io/read-regular-file.js";
import { resolveGitContext } from "../../runtime/git-context.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import {
  canonicalAgentTasksVerb,
  DEFAULT_PROTECTED_COMPLETION_TOOLS,
} from "../../runtime/task-providers/agent-tasks.js";
import { type Manifest, type PolicyUx } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  parseConfigUx,
  readStdin,
} from "./hook-bootstrap.js";

export interface PackHookSolutionAcceptanceOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Override cwd resolution (test injection). */
  cwd?: string;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Override the verdict directory (test injection; default = producer default). */
  verdictDir?: string;
  /** Override the active-claim resolution (test injection). */
  activeClaim?: string | null;
  /** Override process.env (test injection); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface PackHookSolutionAcceptanceResult {
  exitCode: number;
  blocked: boolean;
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
}

function bashCommandOf(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const cmd = (toolInput as Record<string, unknown>)["command"];
  return typeof cmd === "string" ? cmd : "";
}

/**
 * Decide whether this PreToolUse call is a gated completion action. Returns
 * the human label of the action when gated, or null when this call should
 * pass through (the hook matches all Bash, but only push/merge bash commands
 * are completion actions).
 */
function completionActionLabel(
  toolName: string,
  toolInput: unknown,
  protectedVerbs: readonly string[],
): string | null {
  const agentTasksVerb = canonicalAgentTasksVerb(toolName, protectedVerbs);
  if (agentTasksVerb !== null) {
    return `agent-tasks ${agentTasksVerb}`;
  }
  if (toolName === "Bash") {
    const command = bashCommandOf(toolInput);
    if (command && DEFAULT_PUSH_BASH_RE.test(command)) return "git push / gh pr merge";
    return null;
  }
  return null;
}


/**
 * Suffix of the attempt-lock ANCHOR file grounding-mcp writes beside the
 * verdict marker, mirroring its own `LOCK_ANCHOR_SUFFIX`
 * (grounding-mcp-v0.12.0 packages/grounding-mcp/src/solution-attempt-log.ts:209)
 * and README table row "Attempt lock anchor" (`<verdict dir>/<id>.attempt-lock`,
 * mode `0600`; the lock itself is the `<id>.attempt-lock.lock` directory
 * `proper-lockfile` manages beside it, packages/grounding-mcp/README.md:42
 * at that tag).
 */
const ATTEMPT_LOCK_ANCHOR_SUFFIX = ".attempt-lock";

/**
 * Staleness window this hook applies when READING the attempt-lock anchor:
 * the producer's own DOCUMENTED default, `DEFAULT_ATTEMPT_LOCK_STALE_MS`
 * (grounding-mcp-v0.12.0 packages/grounding-mcp/src/solution-attempt-log.ts:102,
 * `= 30_000`), the `staleMs` `acquireAttemptLock` passes straight through
 * to `lockfile.lock(anchor, { retries: 0, realpath: false, stale:
 * options.staleMs, ... })` (same file, lines 472-475) on every DEFAULT
 * acquisition, pinned here as a literal rather than imported (this package
 * has no dependency on grounding-mcp's internals). This hook applies the
 * producer's documented default window pinned to grounding-mcp-v0.12.0; it
 * diverges from what the producer actually enforces for a given attempt
 * if the producer's own default changes in a later release, or if a
 * caller of `acquireAttemptLock` overrides `staleMs` away from that
 * default (the producer's own option is caller-settable, same file),
 * since neither is observable from this side of the lock: an operational
 * pin, not a mathematical guarantee, that needs re-checking on every
 * grounding-mcp bump this pack's producer floor moves past.
 */
export const ATTEMPT_LOCK_STALE_MS = 30_000;

export type NullVerdictReading = "live-attempt" | "never-evaluated" | "unreadable-marker";

/**
 * Three-valued liveness read, never a boolean: `"live"`, `"not-live"` (no
 * lock directory, or one past the stale window: `proper-lockfile`'s own
 * check answers `false` for both, swallowing the absent-lock `ENOENT`
 * inside the library), or `"unknown"` (the check threw: an unreadable
 * directory, a symlink loop, ...). `"unknown"` must never be
 * treated as `"not-live"` downstream: that would assert an attempt is
 * confirmed absent when liveness simply could not be determined (see
 * `classifyNullVerdictReading` and `nullVerdictReadingNote` below, which
 * keep the two states distinct all the way into the agent-facing text).
 */
export type AttemptLockLiveness = LockCheckResult;

/** `classifyNullVerdictReading`'s result: WHICH reading, and the raw liveness it rests on. */
interface NullVerdictInfo {
  reading: NullVerdictReading;
  liveness: AttemptLockLiveness;
}

function attemptLockAnchorPath(dir: string, id: string): string {
  return path.join(dir, `${sanitizeVerdictId(id)}${ATTEMPT_LOCK_ANCHOR_SUFFIX}`);
}

/**
 * Read-only, three-valued liveness check: does `id`'s attempt-lock
 * anchor's `.lock` directory exist and read as NOT stale under
 * `ATTEMPT_LOCK_STALE_MS`? Routed through `src/io/lock.ts`'s
 * `checkFileLock` (the designated read-only wrapper around
 * `proper-lockfile`'s own `checkSync`, the SAME library the producer
 * acquires the lock with), so the stale/live split is decided by the
 * producer's own mechanism, not a reimplementation of its mtime
 * arithmetic. `realpath: false` mirrors the producer's own
 * `acquireAttemptLock` call (cited above): with the library default
 * `realpath: true`, checking an anchor that was never created (the
 * anchor is created lazily, on first acquisition, the common "never
 * evaluated" case) would `realpath` the anchor FILE itself first and
 * throw `ENOENT`, instead of answering the ordinary "not locked" case.
 * Never acquires or mutates the lock; a check-only read has no cleanup
 * to restore.
 */
function readAttemptLockLiveness(dir: string, id: string): AttemptLockLiveness {
  let anchor: string;
  try {
    anchor = attemptLockAnchorPath(dir, id);
  } catch {
    return "unknown";
  }
  return checkFileLock(anchor, { staleMs: ATTEMPT_LOCK_STALE_MS });
}

/**
 * Classify WHY `gate.verdict === null` for `id`: which of the three
 * readings applies, AND the raw liveness result the classification rests
 * on, so the deny text can name the reading it detected without ever
 * collapsing "liveness could not be determined" into "confirmed not
 * live" (see docs/policy-packs/solution-acceptance.md, "Reading the
 * attempt-lock anchor to distinguish the three readings", for the
 * record). Live-attempt takes priority over the marker-presence check: a
 * live attempt can coexist with a stale or corrupt marker left by an
 * earlier run for the same id, and "reconnect to the live attempt" is
 * the actionable reading in that overlap.
 */
function classifyNullVerdictReading(dir: string, id: string): NullVerdictInfo {
  const liveness = readAttemptLockLiveness(dir, id);
  if (liveness === "live") return { reading: "live-attempt", liveness };
  let markerPath: string;
  try {
    markerPath = verdictPathFor(dir, id);
  } catch {
    return { reading: "never-evaluated", liveness };
  }
  const reading: NullVerdictReading =
    probePathPresence(markerPath).kind === "present" ? "unreadable-marker" : "never-evaluated";
  return { reading, liveness };
}

/**
 * Short, reading-specific line for readings (1) and (3); see
 * `classifyNullVerdictReading`. Its liveness clause names what was
 * actually observed ("no attempt reads as currently live" vs "liveness
 * could not be determined") instead of always asserting absence: an
 * earlier version hardcoded absence here even when the underlying check
 * had thrown and could not tell (review finding, harness/799de976).
 */
function nullVerdictReadingNote(taskId: string, info: NullVerdictInfo): string {
  const clause =
    info.liveness === "unknown" ? "liveness could not be determined" : "no attempt reads as currently live";
  switch (info.reading) {
    case "never-evaluated":
      if (info.liveness === "unknown") {
        // Neither axis is established here: the marker probe folds an
        // unreadable verdict directory into "missing", and the lock check
        // threw, so the note asserts nothing about either.
        return `No readable verdict marker for "${taskId}" and liveness could not be determined: the verdict directory could not be read. Check the verdict directory, then run solution_evaluate for this id.`;
      }
      return `No verdict marker exists for "${taskId}"; ${clause}: solution_evaluate has not (yet) been called for this id, or a prior call never got far enough to record one.`;
    case "unreadable-marker":
      return `A verdict marker exists for "${taskId}" but could not be read or parsed; ${clause}: re-run solution_evaluate to record a fresh one.`;
    case "live-attempt":
      return `A solution_evaluate attempt for "${taskId}" is still live: its attempt-lock anchor is held.`;
  }
}

/**
 * Reconnect-vs-retry guidance appended to the default deny text only for
 * reading (2), "an attempt is live" (`classifyNullVerdictReading` above
 * returned `reading: "live-attempt"`): the paragraph is rendered from
 * `solution-acceptance-reconnect.ts`, the SAME fact source the pack's
 * `instructions.md` "Reconnecting vs. retrying" section renders from, so
 * the two surfaces cannot silently drift apart. Readings (1)
 * (never-evaluated) and (3) (unreadable-marker) instead get their own
 * short `nullVerdictReadingNote` line, with no reconnect paragraph: there
 * is no live attempt to reconnect to. See
 * docs/policy-packs/solution-acceptance.md, "Reading the attempt-lock
 * anchor to distinguish the three readings", for the decision record.
 */
function reconnectGuidanceFor(taskId: string, info: NullVerdictInfo | null): string {
  if (info === null || info.reading !== "live-attempt") return "";
  return renderReconnectDenyParagraph(taskId);
}

function blockJson(
  actionLabel: string,
  toolName: string,
  taskId: string,
  detail: string,
  ux: PolicyUx | undefined,
  sessionId: string,
  nullVerdict: NullVerdictInfo | null = null,
): string {
  let reasonText: string;
  if (ux) {
    reasonText = renderAgentFacing(ux, {
      TOOL_NAME: toolName,
      SESSION_ID: sessionId,
    });
  } else {
    reasonText =
      `solution-acceptance: refusing ${actionLabel} (${toolName}). ${detail}\n` +
      (nullVerdict !== null ? `${nullVerdictReadingNote(taskId, nullVerdict)}\n` : "") +
      `Completion must be EARNED from a real preflight run at the CURRENT HEAD, not claimed.\n` +
      `Converge in this order, all at one commit:\n` +
      `  1. If the working tree is dirty, COMMIT first. The verdict is pinned to the HEAD it was evaluated at, so any commit you make afterward makes it stale; commit the change before evaluating so the verdict pins to the final HEAD.\n` +
      `  2. mcp__grounding-mcp__solution_evaluate({ id: "${taskId}" }) — runs \`preflight run --json\` (lint/typecheck/test/audit/secret) and records a HEAD-pinned verdict. A clean run at the current HEAD unblocks this tool; a failing run lists the blockers to fix (then back to step 1).\n` +
      `  3. For \`git push\` / \`gh pr merge\`: the separate preflight-before-push gate is satisfied by a preflight at the current HEAD (its \`at_head\` rule), so refresh it at this same commit with \`harness preflight\` before retrying. Satisfy both push-gates at one HEAD.\n` +
      reconnectGuidanceFor(taskId, nullVerdict) +
      `\n` +
      `Operator override: \`harness pause\` (yields this and every other gate).`;
  }
  return JSON.stringify({
    decision: "block",
    reason: reasonText,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasonText,
    },
  });
}

export async function runPackHookSolutionAcceptanceCli(
  opts: PackHookSolutionAcceptanceOptions = {},
): Promise<PackHookSolutionAcceptanceResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook solution-acceptance: ${msg}\n`);
  };
  const env = opts.env ?? process.env;

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    /* event stays {} */
  }

  // Operator pause yields even this gate.
  if (checkHookPause(PACK_NAME, stderr, opts).paused) {
    const diagnostic = "harness paused; solution-acceptance allowing without evaluating.";
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    env["CLAUDE_CODE_SESSION_ID"] ??
    env["CLAUDE_SESSION_ID"] ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";
  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();

  // Load manifest to resolve the pack config. A load failure forces BLOCK
  // only if this turns out to be a completion action; resolve it first.
  // `manifestPath` (the resolved manifest base) feeds the harness.generated/
  // lookup below — it is populated whether the operator passed --config or
  // the default (~/.harness/harness.yaml) was resolved, so the bare
  // production hook command still resolves the active-claim id.
  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    // We cannot tell if this is a gated action without the config, but a
    // manifest load failure should not block unrelated tool calls. Only
    // the completion verbs / push commands are ever gated, so classify
    // by tool name with the DEFAULT verb set as a failsafe.
    const label = completionActionLabel(
      toolName,
      event.tool_input,
      DEFAULT_PROTECTED_COMPLETION_TOOLS,
    );
    if (label === null) {
      const diagnostic = `manifest load failed (${(err as Error).message}) but ${toolName} is not a completion action; allowing`;
      note(diagnostic);
      return { exitCode: 0, blocked: false, diagnostic };
    }
    const reason = `manifest load failed (${(err as Error).message}); refusing ${label} on failsafe`;
    const diagnostic = `BLOCK — ${reason}`;
    note(diagnostic);
    stdout.write(`${blockJson(label, toolName, "<unknown>", reason, undefined, sessionId)}\n`);
    return { exitCode: 0, blocked: true, diagnostic };
  }

  const pack = manifest.policy_packs.find((p) => p.name === PACK_NAME);
  if (!pack) {
    const diagnostic = `pack "${PACK_NAME}" not declared in manifest, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }
  if (!pack.enabled) {
    const diagnostic = `pack "${PACK_NAME}" is enabled:false, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const protectedVerbs = resolveProtectedCompletionTools(pack);
  const actionLabel = completionActionLabel(toolName, event.tool_input, protectedVerbs);
  if (actionLabel === null) {
    const diagnostic = `${toolName} is not a gated completion action; allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const configUx = parseConfigUx(
    (pack.config as Record<string, unknown>)["ux"],
    stderr,
    "harness pack hook solution-acceptance",
  );

  // Resolve the verdict id. Precedence: the agent-tasks active-claim task id
  // first (authoritative for claimed sessions — an env var must not redirect a
  // claimed task's verdict), then the SOLUTION_VERDICT_ID env knob for solo /
  // non-agent-tasks sessions, then fail CLOSED. A sessionId fallback is
  // intentionally NOT a source (it would reopen the wrong-scope bug class).
  const generatedDir =
    opts.generatedDir ??
    (manifestPath !== undefined
      ? resolveGeneratedDir({
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          manifestPath,
        })
      : undefined);
  const activeClaim =
    opts.activeClaim !== undefined
      ? opts.activeClaim
      : generatedDir !== undefined
        ? readActiveClaim(generatedDir)
        : null;
  const taskId = activeClaim ?? resolveExplicitVerdictId(env);
  if (!taskId) {
    const detail =
      opts.activeClaim === undefined && generatedDir === undefined
        ? " (could not resolve harness.generated/; pass --config)"
        : "";
    const reason =
      `no verdict id: no active-claim task id recorded${detail} and ${VERDICT_ID_ENV} is unset or invalid.\n` +
      `\n` +
      `Converge one of two ways:\n` +
      `\n` +
      `1. Agent-tasks workflow: Call mcp__agent-tasks__task_start first to claim the task (the verdict id is the active task). For post-done work (Release, deploy, etc.), create a separate task and call task_start for it.\n` +
      `\n` +
      `2. Solo / non-agent-tasks session: ${VERDICT_ID_ENV} must be set in the environment at Session-Start time (Operator option; it is read at Hook startup, not agent-sideeffect-settable from within the session).`;
    const diagnostic = `BLOCK — ${reason}`;
    note(diagnostic);
    stdout.write(`${blockJson(actionLabel, toolName, "<no-verdict-id>", reason, configUx, sessionId)}\n`);
    return { exitCode: 0, blocked: true, diagnostic };
  }

  // The verdict DIR still resolves SOLUTION_VERDICT_DIR from process.env (the
  // `env` seam above covers the verdict id + sessionId, not the dir); in
  // production both see the same process.env, and tests inject opts.verdictDir.
  const dir = opts.verdictDir ?? resolveVerdictDir();
  const currentHead = resolveGitContext(cwd).sha || null;
  const verdict = readVerdict(dir, taskId);
  // generatedDir (harness's own .generated/ dir, NOT the verdict dir) holds
  // the shared approval-signing key evaluateGate needs to verify the
  // verdict's HMAC signature (harness/c7c3f606); undefined fails closed
  // inside evaluateGate with its own distinct reason.
  const gate = evaluateGate(verdict, currentHead, taskId, generatedDir);

  if (gate.allowed) {
    const diagnostic = `${gate.reason}; allowing ${actionLabel}`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  // Distinct operator-facing audit tag when the gate blocked SPECIFICALLY
  // because the verdict was forged/unsigned or identity-mismatched
  // (GateResult.forged, harness/c7c3f606), not the routine "no verdict" /
  // "not ready" / "stale" cases — mirrors the `ackEcho` audit-echo pattern
  // in hook-branch-protection.ts (a short, greppable tag appended only to
  // the STDERR diagnostic), NOT that same hook's `markerForgedNote`: that
  // one folds its forged-marker wording into the AGENT-facing block reason
  // too (`why` there feeds both `note()` and `blockJson`). This tag stays
  // out of the agent-facing reason on purpose — `gate.reason` already
  // narrates the forgery in prose for the agent, so there is nothing this
  // tag would add there; it exists so an operator scanning hook logs for
  // active forgery attempts does not have to pattern-match the prose.
  const forgedTag = gate.forged ? " [audit: forged/unsigned verdict marker rejected]" : "";
  const diagnostic = `BLOCK — ${gate.reason}${forgedTag}`;
  note(diagnostic);
  const nullVerdict = gate.verdict === null ? classifyNullVerdictReading(dir, taskId) : null;
  stdout.write(
    `${blockJson(actionLabel, toolName, taskId, gate.reason, configUx, sessionId, nullVerdict)}\n`,
  );
  return { exitCode: 0, blocked: true, diagnostic };
}
