// Builtin Policy Pack: `solution-acceptance`.
//
// Consumer half of the solution-acceptance gate (the "Verifier-gated Done"
// anti-lazyness mechanism). Makes a task's completion EARNED from a real
// preflight run, not self-attested. The producer is grounding-mcp's
// `solution_evaluate` (>= 0.3.2); harness reads the HEAD-pinned verdict
// marker it writes and gates the task-finishing tools on it.
//
// Two PreToolUse hooks, both `blocking: hard`:
//
//   1. completion-gate (`harness pack hook solution-acceptance`): denies the
//      agent-tasks completion verbs (task_finish / task_submit_pr /
//      task_merge / pull_requests_merge) — and, belt-and-suspenders, a
//      `git push` / `gh pr merge` bash command — unless a READY verdict
//      exists at the CURRENT git HEAD. The verdict id is the active-claim
//      task id; with no active claim the gate fails CLOSED.
//
//   2. write-guard (`harness pack hook solution-acceptance-writeguard`): the
//      actual anti-forgery closure. Relocating the verdict dir is NOT enough
//      — understanding-gate allows all Bash post-approval — so this hook
//      blocks the agent's enumerated write paths (Bash redirects/`tee`/`mv`/
//      `cp`/`ln`/interpreter writes that reference the dir, `chmod`/`chattr`
//      on the dir, and Write/Edit/MultiEdit/NotebookEdit whose `file_path`
//      lands inside the dir). The ONLY remaining writer is the producer
//      (the operator-launched grounding-mcp MCP server, which runs real
//      preflight and does not flow through the agent's gated tool surface).
//
// Anti-forgery scope (operator decision, 2026-05-30): v1 closes the
// ENUMERATED-WRITE-PATH residual, NOT arbitrary same-uid forgery. Content
// signing (a cross-repo follow-up that also touches the producer) is what
// closes an unguarded write primitive. See solution-acceptance-runtime.ts.
//
// Pack is OFF by default; enable per-installation via
// `harness pack add solution-acceptance`. The `full` init template wires it
// as a disabled-by-policy exemplar... (see templates.ts). It REQUIRES
// grounding-mcp under `tools.mcp` (the producer) and the `preflight` binary
// on PATH; `harness validate` / `harness doctor` warn when the producer is
// absent (a missing producer means the gate can never see a verdict and
// would deadlock).

import { z } from "zod";
import { PolicyUxSchema } from "../../schema/policies.js";
import type { Hook, PolicyPack } from "../../schema/index.js";
import { DEFAULT_RUNTIME, type Runtime } from "../runtime.js";
import type { PackContribution, PackContributionFile } from "../types.js";
import {
  PACK_NAME,
  resolveProtectedCompletionTools,
  VERDICT_DIR_ENV,
} from "./solution-acceptance-runtime.js";
import {
  shellQuoteSingle,
  type ResolvePackOptions,
} from "./understanding-before-execution.js";

export { PACK_NAME };

/**
 * Zod schema for this pack's `config:` block. Strict by design so typo'd
 * keys fail loud at lint time (mirrors sibling packs).
 */
export const configSchema = z
  .object({
    // Override the agent-tasks completion verbs the gate fires on. The
    // names are bare verbs (e.g. "task_finish"); the matcher prefixes
    // `mcp__agent-tasks__`. Defaults to DEFAULT_PROTECTED_COMPLETION_TOOLS.
    protected_completion_tools: z.array(z.string().min(1)).min(1).optional(),
    // `ux` renders the agent-facing remediation block when a gate trips.
    ux: PolicyUxSchema.optional(),
  })
  .strict();

const HOOK_NAME_PREFIX = `policy-pack:${PACK_NAME}`;

const COMPLETION_BLOCKER_COMMAND = "harness pack hook solution-acceptance";
const WRITEGUARD_BLOCKER_COMMAND = "harness pack hook solution-acceptance-writeguard";

// Mirrors the REPORTS_DIR_ENV pattern in understanding-before-execution.ts:
// imported from the runtime so the const is defined in exactly one place.
const SOLUTION_VERDICT_DIR_ENV = VERDICT_DIR_ENV;

function prefixCommandWithVerdictDir(
  command: string,
  verdictDir: string | undefined,
): string {
  if (!verdictDir) return command;
  return `${SOLUTION_VERDICT_DIR_ENV}=${shellQuoteSingle(verdictDir)} ${command}`;
}

const WRITEGUARD_MATCH_CLAUDE = "Edit|Write|MultiEdit|NotebookEdit|Bash";
const WRITEGUARD_MATCH_CODEX = "apply_patch|Bash";

/**
 * PreToolUse `match` for the completion-gate. `Bash` is always included for
 * the `git push` / `gh pr merge` belt-and-suspenders arm; on the Claude
 * runtime the agent-tasks MCP verbs are appended (the reliable choke
 * points). Codex has no agent-tasks MCP surface here, so it gets the Bash
 * arm only (documented limitation).
 */
function completionMatch(runtime: Runtime, tools: readonly string[]): string {
  if (runtime === "codex") return "Bash";
  const mcp = tools.map((t) => `mcp__agent-tasks__${t}`).join("|");
  return `Bash|${mcp}`;
}

function buildHooks(
  runtime: Runtime,
  tools: readonly string[],
  opts: ResolvePackOptions = {},
): Hook[] {
  const writeGuardMatch =
    runtime === "codex" ? WRITEGUARD_MATCH_CODEX : WRITEGUARD_MATCH_CLAUDE;
  // When `opts.solutionVerdictDir` is set (the apply path), each command is
  // prefixed with `SOLUTION_VERDICT_DIR=<absolute>` so the completion-gate
  // hook reads from the same directory the producer (grounding-mcp) writes to,
  // regardless of each process's cwd.
  const wrap = (cmd: string): string =>
    prefixCommandWithVerdictDir(cmd, opts.solutionVerdictDir);
  return [
    {
      name: `${HOOK_NAME_PREFIX}:completion-gate`,
      event: "PreToolUse",
      match: completionMatch(runtime, tools),
      command: wrap(COMPLETION_BLOCKER_COMMAND),
      blocking: "hard",
      budget_ms: 5000,
      description:
        "Blocker: deny the task-finishing tools (agent-tasks completion verbs + `git push` / `gh pr merge`) unless a ready solution-acceptance verdict exists at the current git HEAD. Fail-closed.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:write-guard`,
      event: "PreToolUse",
      match: writeGuardMatch,
      command: wrap(WRITEGUARD_BLOCKER_COMMAND),
      blocking: "hard",
      budget_ms: 5000,
      description:
        "Anti-forgery write-guard: deny any agent write into the solution-verdict dir (redirects/tee/mv/cp/ln/interpreter writes that reference it, chmod/chattr on it, and path-tool file_path inside it). The producer (grounding-mcp MCP server) is the only legitimate writer.",
    },
  ];
}

function buildInstructions(
  pack: PolicyPack,
  tools: readonly string[],
  runtime: Runtime,
): string {
  const description = pack.description?.trim() ?? "";
  return `# Policy Pack: ${PACK_NAME}

> Operator audit copy. This pack makes task completion EARNED from a real
> preflight run (the producer, grounding-mcp \`solution_evaluate\`) rather
> than self-attested, and closes the enumerated-write-path forgery residual
> on the verdict marker.

## Runtime

${runtime}

## Producer (required)

This pack is a pure CONSUMER. It needs the producer wired:

- \`grounding-mcp\` (>= 0.3.2) declared under \`tools.mcp\`, exposing
  \`solution_evaluate\` / \`solution_gate\`.
- The \`preflight\` binary (\`@lannguyensi/agent-preflight\`) on PATH (or
  \`SOLUTION_PREFLIGHT_BIN\`), which \`solution_evaluate\` shells out to.

If the producer is absent the gate can never see a verdict and would
deadlock; \`harness validate\` / \`harness doctor\` warn about this.

## Effect

Two \`PreToolUse\` hooks (both blocking: hard) are wired into the
harness-managed settings:

1. \`completion-gate\` (\`${COMPLETION_BLOCKER_COMMAND}\`): denies the
   completion verbs unless a READY verdict exists at the CURRENT git HEAD.
   Gated tools: ${tools.map((t) => `\`${t}\``).join(", ")} (matched as
   \`mcp__agent-tasks__<verb>\`), plus a \`git push\` / \`gh pr merge\` bash
   match. The verdict id is the active-claim task id; with no active claim
   the gate fails CLOSED.

2. \`write-guard\` (\`${WRITEGUARD_BLOCKER_COMMAND}\`): denies any agent write
   into the verdict dir. The only legitimate writer is the producer.

## Earning a verdict

\`\`\`
mcp__grounding-mcp__solution_evaluate({ id: "<active-task-id>" })
\`\`\`

This runs \`preflight run --json\` and records a HEAD-pinned verdict. A
not-ready run (failing checks, dirty tree) records a not-ready verdict; any
commit after a green run shifts HEAD and invalidates it, so re-run after
every change.

## Orchestrator-workflow process arm (grounding-mcp >= 0.5.0)

From grounding-mcp >= 0.5.0, \`solution_evaluate\` also folds
orchestrator-workflow process-completeness into \`ready\` and surfaces any
failure reasons through the EXISTING \`blockers\` (each prefixed
\`orchestrator-workflow: \`). No new verdict field is added, so this consumer
is unchanged: a not-ready verdict still denies the completion verbs and the
OW reasons appear in the deny message. Markers from older producers
(< 0.5.0) stay shape-compatible and remain preflight-only (no OW arm); there
is no hard incompatibility.

## Anti-forgery scope (v1)

v1 closes the ENUMERATED-WRITE-PATH residual: the write-guard blocks the
agent's Bash/Edit/Write spellings that target the verdict dir. It does NOT
close arbitrary same-uid forgery (an unguarded write primitive). Marker
signing — a follow-up that also changes the producer — is what closes
content-authenticity. A \`0500\` chmod on the dir is deliberately NOT used:
producer and agent share a uid, so it would block the producer too.

## Out of scope (v1)

- Goodhart test-count-delta guard (producer side).
- LLM-judge layer / relative best-of-N ranking.
- Explicit verdict-id source for untasked sessions (follow-up; today an
  untasked session fails closed).

## Pack metadata
${description ? `\n> ${description.replace(/\n/g, "\n> ")}\n` : ""}
- Source: \`builtin\`
- Pack: \`${PACK_NAME}\`
- Runtime: \`${runtime}\`
`;
}

export function resolve(
  pack: PolicyPack,
  runtime: Runtime = DEFAULT_RUNTIME,
  opts: ResolvePackOptions = {},
): { contribution: PackContribution; warnings: string[] } {
  const tools = resolveProtectedCompletionTools(pack);
  const hooks = buildHooks(runtime, tools, opts);
  const files: PackContributionFile[] = [
    {
      relativePath: `policy-packs/${PACK_NAME}/instructions.md`,
      content: buildInstructions(pack, tools, runtime),
    },
  ];
  return { contribution: { hooks, files }, warnings: [] };
}
