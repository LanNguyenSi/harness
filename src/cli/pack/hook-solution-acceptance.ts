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
import { type Manifest, type PolicyUx } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  parseConfigUx,
  readStdin,
} from "./hook-bootstrap.js";

const MCP_AGENT_TASKS_PREFIX = "mcp__agent-tasks__";

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
  if (toolName.startsWith(MCP_AGENT_TASKS_PREFIX)) {
    const verb = toolName.slice(MCP_AGENT_TASKS_PREFIX.length);
    if (protectedVerbs.includes(verb)) return `agent-tasks ${verb}`;
    return null;
  }
  if (toolName === "Bash") {
    const command = bashCommandOf(toolInput);
    if (command && DEFAULT_PUSH_BASH_RE.test(command)) return "git push / gh pr merge";
    return null;
  }
  return null;
}


function blockJson(
  actionLabel: string,
  toolName: string,
  taskId: string,
  detail: string,
  ux: PolicyUx | undefined,
  sessionId: string,
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
    const label = completionActionLabel(toolName, event.tool_input, [
      "task_finish",
      "task_submit_pr",
      "task_merge",
      "pull_requests_merge",
    ]);
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
      `no verdict id: no active-claim task id recorded${detail} and ${VERDICT_ID_ENV} is unset or invalid. ` +
      `Call mcp__agent-tasks__task_start first (agent-tasks workflow; the verdict id is the active task), ` +
      `or set ${VERDICT_ID_ENV} to the verdict id for a solo / non-agent-tasks session.`;
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

  const diagnostic = `BLOCK — ${gate.reason}`;
  note(diagnostic);
  stdout.write(`${blockJson(actionLabel, toolName, taskId, gate.reason, configUx, sessionId)}\n`);
  return { exitCode: 0, blocked: true, diagnostic };
}
