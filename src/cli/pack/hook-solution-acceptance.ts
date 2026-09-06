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
  VERDICT_ID_ENV,
  verdictDir as resolveVerdictDir,
} from "../../policy-packs/builtin/solution-acceptance-runtime.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
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
 * Reconnect-vs-retry guidance appended to the default deny text only when
 * `showReconnectGuidance` is set (the `gate.verdict === null` case: no
 * verdict marker on record for this id). That single condition is
 * DELIBERATELY ambiguous between "solution_evaluate was never called for
 * this id" and "a solution_evaluate attempt for this id is still running
 * in the background" (grounding-mcp >= 0.11.0's `{status: "running"}`
 * reply, or a call that timed out before it ever returned a handle): the
 * verdict marker is written only once an attempt finishes, so this hook
 * has no signal that distinguishes the two (no attempt-log read, no
 * `running` status visibility from here). Rather than let the agent read
 * "no verdict recorded" as licence to retry, the SAME deny message covers
 * both readings with the facts an agent needs either way (see
 * docs/policy-packs/solution-acceptance.md, "Agent-facing surface for the
 * in-flight case", for the decision and this limitation).
 */
function reconnectGuidanceFor(taskId: string, showReconnectGuidance: boolean): string {
  if (!showReconnectGuidance) return "";
  return (
    `\n` +
    `Reconnecting vs. retrying: this same "no verdict recorded" message fires whether ` +
    `solution_evaluate for "${taskId}" was never called, or a call for it is still running ` +
    `in the background (the verdict marker only appears once an attempt finishes, so this ` +
    `hook cannot tell the two apart from here). If you already called solution_evaluate for ` +
    `this id, do not call it again: poll \`mcp__grounding-mcp__solution_evaluate_status\` / ` +
    `\`mcp__grounding-mcp__solution_evaluate_result\` for the SAME id, passing the attemptId ` +
    `you were given (or omitting it to resolve the latest attempt, the recovery path when your ` +
    `own call timed out before it ever returned one), waiting at least the returned pollAfterMs ` +
    `(advertised as 5000ms) between polls. A live attempt's lock refuses a second ` +
    `solution_evaluate call and refuses forceNewAttempt while it holds; attempt records are ` +
    `retained 24h by default (always at least 100x pollAfterMs), and a pruned terminal attempt ` +
    `reads "expired".\n`
  );
}

function blockJson(
  actionLabel: string,
  toolName: string,
  taskId: string,
  detail: string,
  ux: PolicyUx | undefined,
  sessionId: string,
  showReconnectGuidance = false,
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
      `Completion must be EARNED from a real preflight run at the CURRENT HEAD, not claimed.\n` +
      `Converge in this order, all at one commit:\n` +
      `  1. If the working tree is dirty, COMMIT first. The verdict is pinned to the HEAD it was evaluated at, so any commit you make afterward makes it stale; commit the change before evaluating so the verdict pins to the final HEAD.\n` +
      `  2. mcp__grounding-mcp__solution_evaluate({ id: "${taskId}" }) — runs \`preflight run --json\` (lint/typecheck/test/audit/secret) and records a HEAD-pinned verdict. A clean run at the current HEAD unblocks this tool; a failing run lists the blockers to fix (then back to step 1).\n` +
      `  3. For \`git push\` / \`gh pr merge\`: the separate preflight-before-push gate is satisfied by a preflight at the current HEAD (its \`at_head\` rule), so refresh it at this same commit with \`harness preflight\` before retrying. Satisfy both push-gates at one HEAD.\n` +
      reconnectGuidanceFor(taskId, showReconnectGuidance) +
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
  stdout.write(
    `${blockJson(actionLabel, toolName, taskId, gate.reason, configUx, sessionId, gate.verdict === null)}\n`,
  );
  return { exitCode: 0, blocked: true, diagnostic };
}
