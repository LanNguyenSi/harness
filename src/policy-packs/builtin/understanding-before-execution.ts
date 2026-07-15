// Builtin Policy Pack: `understanding-before-execution`.
//
// Bundles three hook contributions for Claude Code (UserPromptSubmit,
// Stop, PreToolUse), plus a per-mode instructions.md that documents what
// the pack is doing for human auditors. The actual prompt that the agent
// sees at UserPromptSubmit time is owned by `@lannguyensi/understanding-gate`
// (specifically `src/prompts/{full,fast-confirm,grill-me}.ts`); harness's
// instructions.md is the operator-facing summary, not the agent-injected
// text. Drift on instructions.md is therefore meaningful (someone edited
// the audit copy), distinct from drift on the package's own templates
// (which the package's own drift detection would handle on a future
// `understanding-gate init` reinstall).

import { z } from "zod";
import { PolicyUxSchema, ProducerSchema } from "../../schema/policies.js";
import type { Hook, PolicyPack, PolicyUx, Producer } from "../../schema/index.js";
import { profileToSettingsPermissions } from "../permission-translator.js";
import { DEFAULT_RUNTIME, type Runtime } from "../runtime.js";
import type {
  PackContribution,
  PackContributionFile,
  PackPermissionsContribution,
} from "../types.js";
import {
  isKnownProfileName,
  resolveProfile,
  KNOWN_PROFILE_NAMES,
} from "./permission-profiles.js";
import { REPORTS_DIR_ENV } from "./understanding-before-execution-runtime.js";
import { SHELL_ALIASES } from "../../runtime/tool-name-aliases.js";

export const PACK_NAME = "understanding-before-execution";

// Canonical version probe for the pack's package-side bin. Consumed by
// `harness doctor` when the operator declares a pack-level `min_version`
// floor. Mirrors the hook-level UG_VERSION_COMMAND (which is scoped to
// individual hooks); a pack-level floor exists so a `config:` key only
// the newer package honours (e.g. the v0.25.0 `--task` variadic flag)
// can be caught at health-check time independent of any one hook.
export const VERSION_COMMAND: readonly [string, string] = [
  "understanding-gate",
  "--version",
];

export type Mode = "fast_confirm" | "grill_me" | "strict";

const MODES: readonly Mode[] = ["fast_confirm", "grill_me", "strict"];

export const DEFAULT_MODE: Mode = "grill_me";

/**
 * The agent-facing `required:` phrase for the understanding-gate deny
 * envelope, derived from the configured mode. Only `strict` forces
 * `requiresHumanApproval` (see {@link modeFriction}); in `fast_confirm`
 * and `grill_me` the agent self-attests and a structural validator
 * checks the report, so naming it "human-approved" there would overstate
 * what the gate actually enforces. Generation surfaces (the Custom
 * composer, the init templates) call this so the wording can never drift
 * from the mode it is paired with.
 */
export function understandingApprovalRequirement(mode: Mode): string {
  return mode === "strict"
    ? "a human-approved Understanding Report for this session"
    : "an approved Understanding Report for this session";
}

/**
 * Shipped default `config.producers` for this pack (agent-tasks/25bced52).
 * Canonical source for the "golden path" recovery command: both `harness
 * init` generation surfaces (Solo/Team/Full templates, the Custom
 * composer) and `harness pack reseed` (task 68b9ad9c) read from here, so
 * a future wording change to the producer descriptions only has to land
 * in one place to reach every manifest-generating surface plus the
 * reseed path used to backfill already-installed manifests.
 */
export function defaultProducers(): Producer[] {
  return [
    {
      kind: "ask",
      command: "harness approve understanding",
      description:
        "Bare command, no pipes or chaining. The hook recognises it via isEscapeCommand and emits permissionDecision:ask; the operator's go on that prompt IS the gate approval. Golden path.",
    },
    {
      kind: "bash",
      command: "harness approve understanding",
      description:
        "Same command from any un-hooked terminal (operator only, not reachable from inside the gated session). Writes the canonical marker at harness.generated/.approvals/${SESSION_ID}.",
    },
  ];
}

/**
 * Shipped default `config.ux` for this pack, parameterised on the
 * resolved mode (only the `required` line varies across modes — see
 * `understandingApprovalRequirement` above). Canonical source consumed
 * by the same generation surfaces as `defaultProducers()`, plus
 * `harness doctor`'s divergence warning and `harness pack reseed` (task
 * 68b9ad9c): the dogfood motivating that task found that a deny-message
 * wording fix (e.g. the heredoc submission form, agent-tasks/e48e3b45)
 * only reached NEW `harness init` manifests, because nothing propagated
 * the improved text into an already-installed operator manifest whose
 * `config.ux` still taught the old wording. Reading from one function
 * here means a future wording fix is available to `pack reseed`
 * automatically, with no separate update needed.
 */
export function defaultUx(mode: Mode): PolicyUx {
  return {
    cannot: "You cannot use write-capable tools yet.",
    required: [understandingApprovalRequirement(mode)],
    run: [
      "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)",
      "Run `harness approve understanding` with the report attached as a quoted heredoc (harness approve understanding <<'UNDERSTANDING_REPORT' ...report... UNDERSTANDING_REPORT) so it is persisted for audit, then approve the prompt; the heredoc is the only extra shell shape the gate allows (no pipes, chaining, or other redirection)",
    ],
  };
}

const HOOK_NAME_PREFIX = `policy-pack:${PACK_NAME}`;

// Per-runtime hook surface. Claude Code keys on tool name (Edit|Write|Bash);
// Codex's write surface is `apply_patch` plus shell tool aliases used by
// current runtimes (`Bash`/`shell`/`exec_command`). The hook contract Codex
// feeds to the adapter is the same generic envelope harness publishes:
// `{ session_id, tool_name, raw_input, event }` on stdin, `{ decision }`
// on stdout, exit 2 on block. See dogfood/phase6-6/README.md for the wire
// format.
const PRE_TOOL_USE_MATCH_CLAUDE = "Edit|Write|Bash";
const PRE_TOOL_USE_MATCH_CODEX =
  "apply_patch|Bash|shell|exec_command|functions.exec_command";

// UserPromptSubmit + Stop hooks point at `@lannguyensi/understanding-gate`
// bare bin names (npm i -g). The harness validator's checkHooks skips
// PATH lookup for non-rooted commands by design, so missing-bin shows
// up at runtime, not at lint. `harness doctor` (Phase 6 #4 follow-up)
// will add the presence check.
const BIN_USER_PROMPT_SUBMIT_CLAUDE = "understanding-gate-claude-hook";
const BIN_STOP_CLAUDE = "understanding-gate-claude-stop";
// PreToolUse blocker is the harness CLI itself (Phase 6 #4): it consults
// BOTH the evidence-ledger tag (canonical for harnessed sessions) AND
// the persisted JSON report under `.understanding-gate/reports/`
// (fallback for sessions without grounding-mcp wired). The npm package's
// own bin remains available for solo users; the harness blocker is
// strictly more powerful.
const PRE_TOOL_USE_COMMAND_CLAUDE = "harness pack hook pre-tool-use";

// Codex variants. The package `@lannguyensi/understanding-gate` does
// not yet ship Codex bins, so harness owns the adapter:
//
//   - UserPromptSubmit-equivalent injector (Phase 6 #6).
//   - Stop-equivalent capture into `.understanding-gate/reports/`
//     (Phase 6 #6 follow-up).
//   - PreToolUse blocker on apply_patch plus Codex shell aliases (Phase 6 #6).
//   - PostToolUse marker-expiry (task a1348c89): Codex's published hooks
//     reference (developers.openai.com/codex/hooks) documents
//     `PostToolUse` as a first-class event — `[[hooks.PostToolUse]]`
//     with a `matcher` on `tool_name`, same allow/exit-0 or
//     block/exit-2 contract as PreToolUse. Mirrors the Claude
//     `post-tool-use` hook via the shared matching/clearing core in
//     understanding-before-execution-runtime.ts.
//
// Cross-runtime sessions can still approve from a Claude Code report:
// the ledger tag is the canonical source for harnessed sessions,
// independent of which runtime captured the report. The persisted-
// report directory is shared between runtimes, so a Codex stop that
// writes a report is approvable via `harness approve understanding`
// regardless of which runtime invokes the next tool call.
const COMMAND_USER_PROMPT_SUBMIT_CODEX =
  "harness pack hook codex-user-prompt-submit";
const COMMAND_STOP_CODEX = "harness pack hook codex-stop";
const COMMAND_PRE_TOOL_USE_CODEX = "harness pack hook codex-pre-tool-use";
const COMMAND_POST_TOOL_USE_CODEX = "harness pack hook codex-post-tool-use";

export function isMode(value: unknown): value is Mode {
  return (
    typeof value === "string" && (MODES as readonly string[]).includes(value)
  );
}

/**
 * Zod schema for this pack's `config:` block. Surfaced via
 * `resolveBuiltinConfigSchema()` and consumed by `harness validate` /
 * `harness doctor` so typo'd keys (e.g. `permision_profile`) or values
 * (e.g. `mode: fastConfirm`) fail loud at lint time instead of falling
 * through to the runtime fallback. Each shape mirrors what the pack's
 * own resolvers (`resolveMode`, `resolveExpireOnToolMatch`,
 * `resolvePermissionProfile`) accept — the schema is a typo guard, not
 * a replacement parser; the resolvers still own defaults + warnings for
 * borderline cases the schema lets through.
 *
 * `.strict()` is intentional: this pack already documents every
 * supported key, and an unknown key in the operator's manifest is far
 * more likely to be a typo than forward-compat. New keys added in a
 * future harness version land in this schema first, then in the pack.
 */
export const configSchema = z
  .object({
    mode: z.enum(MODES as readonly [Mode, ...Mode[]]).optional(),
    permission_profile: z
      .enum(KNOWN_PROFILE_NAMES as readonly [string, ...string[]])
      .optional(),
    approval_lifecycle: z
      .object({
        // `mode: session` opts out of the PostToolUse marker-expiry hook
        // entirely (legacy "one approval per session" UX).
        mode: z.literal("session").optional(),
        // Tool-name boundaries: clear the marker after one of these
        // agent-tasks (or operator-overridden) MCP tools fires.
        expire_on_tool_match: z.array(z.string().min(1)).optional(),
        // Bash-command boundaries: clear the marker when a Bash call
        // matches any of these regexes (e.g. `^gh pr (merge|close)\b`).
        // Operators on gh-cli workflows use this in place of MCP tools.
        expire_on_bash_match: z.array(z.string().min(1)).optional(),
        // Safety net for sessions that never hit a listed tool/Bash
        // boundary. Duration strings like `1h`, `4h`, `30m` are parsed
        // by the post-tool-use hook; format validation lives there.
        max_age: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    // `ux` + `producers` are consumed by the PreToolUse blocker
    // (`src/cli/pack/hook-pre-tool-use.ts`) to render an agent-facing
    // remediation block when the gate trips. Same shape as the
    // policy-layer `ux:` / `producers:` keys.
    ux: PolicyUxSchema.optional(),
    producers: z.array(ProducerSchema).min(1).optional(),
  })
  .strict();

export interface ResolvePackOptions {
  /**
   * Absolute path to the persisted-report directory the pack's hooks
   * should write/read. When provided, the pack prefixes each contributed
   * hook command with `UNDERSTANDING_GATE_REPORT_DIR=<path>` so the
   * Stop hook (writes the report), the PreToolUse blocker (reads it),
   * and `harness approve understanding` (flips it) all resolve the same
   * directory regardless of each process's cwd. Apply sets this to a
   * manifest-anchored absolute path; in test/legacy paths it may be
   * omitted, in which case the commands are emitted unchanged and the
   * runtime `defaultReportsDir()` falls back to the env-var-or-cwd
   * precedence.
   */
  reportsDir?: string;
  /**
   * Path to the solution-verdict directory the solution-acceptance
   * completion-gate hook should read; should be absolute (a relative value is
   * flagged by `harness validate` because it resolves against each process's
   * cwd and cannot be reconciled). When provided, the pack prefixes each
   * contributed hook command with `SOLUTION_VERDICT_DIR=<path>` so the
   * hook (consumer) and the grounding-mcp server (producer) resolve the same
   * directory regardless of each process's cwd. Apply sets this to the value
   * declared in `tools.mcp[grounding-mcp].env.SOLUTION_VERDICT_DIR` when
   * present; when absent the env var is not injected and the runtime
   * `verdictDir()` falls back to the env-var-or-XDG precedence.
   */
  solutionVerdictDir?: string;
}

/**
 * POSIX single-quote-escape for an arbitrary path. Safe inside the
 * `VAR=<value>` prefix of a `sh -c` command line. Always quotes — paths
 * derived from `path.dirname()` may contain spaces or other shell
 * metacharacters, and a plain `VAR=$path` would split on whitespace.
 */
export function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function prefixCommandWithReportsDir(
  command: string,
  reportsDir: string | undefined,
): string {
  if (!reportsDir) return command;
  return `${REPORTS_DIR_ENV}=${shellQuoteSingle(reportsDir)} ${command}`;
}

export function resolveMode(pack: PolicyPack): {
  mode: Mode;
  warning: string | null;
} {
  const raw = pack.config["mode"];
  if (raw === undefined) return { mode: DEFAULT_MODE, warning: null };
  if (isMode(raw)) return { mode: raw, warning: null };
  const warning = `policy_packs[${pack.name}].config.mode: unrecognised value ${JSON.stringify(
    raw,
  )}, falling back to "${DEFAULT_MODE}". Allowed: ${MODES.join(", ")}.`;
  return { mode: DEFAULT_MODE, warning };
}

// Default tools that mark task-completion boundaries when the operator
// has not overridden `config.approval_lifecycle.expire_on_tool_match`.
// agent-tasks verbs are the dogfood case; operators on Linear / JIRA /
// other task systems override the list in their manifest. Kept here so
// the PostToolUse hook always emits a sensible match pattern even when
// the operator hasn't set the config explicitly.
const DEFAULT_EXPIRE_ON_TOOL_MATCH: ReadonlyArray<string> = [
  "mcp__agent-tasks__task_finish",
  "mcp__agent-tasks__task_abandon",
  "mcp__agent-tasks__pull_requests_merge",
  // Legacy v1 verb; the post-tool-use hook applies a status filter so only
  // `tool_input.status === "done"` actually clears the marker (PR #200,
  // agent-tasks 9e06175f). Listed here so settings.json fires the hook
  // at all; the status refinement happens in TypeScript.
  "mcp__agent-tasks__tasks_transition",
];

const POST_TOOL_USE_COMMAND_CLAUDE = "harness pack hook post-tool-use";

// Task cf4cdc93 (Codex parity gap #3): unlike stop/pre-tool-use/
// post-tool-use, the active-claim tracker and stay-in-scope reminder
// need NO runtime-specific CLI verb — both hook bodies only ever
// inspect the generic `tool_name` / `tool_input` fields already common
// to Claude's and Codex's PostToolUse envelope (no session_id, no
// shell-command extraction, no Codex-only synonym). One shared command
// constant per hook is therefore reused verbatim on both runtimes below
// instead of a `codex-track-active-claim` / `codex-stay-in-scope`
// sibling binary — avoids reintroducing the exact Claude/Codex drift
// class task e7c2ec3c fixed on the PreToolUse side.
const TRACK_ACTIVE_CLAIM_COMMAND = "harness pack hook track-active-claim";

// Hardcoded matcher for the v2 active-claim tracker (harness/494fd1e5).
// Agent-tasks specific; operators on other tasking systems can ignore
// this hook (the matcher won't fire for their tools). A config-driven
// extension can land later if a second tasking system asks for it.
const TRACK_ACTIVE_CLAIM_MATCH =
  "^(?:mcp__agent-tasks__task_start|mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__tasks_transition)$";

// Codex sibling of TRACK_ACTIVE_CLAIM_MATCH above (task cf4cdc93): a
// bare, unescaped `|`-joined list, NOT the anchored `^(?:...)$` form —
// same rationale as `codexPostToolUseMatchPattern`'s own doc comment
// (task a1348c89 review finding): `expandCodexHookMatchPattern`'s
// "simple token" guard (`isSimpleToolPatternToken`, generate-codex-config.ts)
// only alias-expands a match string whose tokens are ALL "simple"; the
// anchor characters `^`, `(`, `?` trip that guard and the anchored form
// is passed through UNCHANGED at TOML-emit time, so a Codex session
// sending a dotted/underscore-server MCP tool-name variant would never
// even reach the hook. This bare form lets the emitted `config.toml`
// matcher — and therefore Codex's own dispatcher — recognize those
// variants, exactly like `PRE_TOOL_USE_MATCH_CODEX` already does.
const TRACK_ACTIVE_CLAIM_MATCH_CODEX =
  "mcp__agent-tasks__task_start|mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__tasks_transition";

// Hardcoded matcher for the stay-in-scope reminder (harness/2ba06030).
// Fires on the three task-mutation verbs that can carry labels and
// description fields. tasks_update is included so a label added
// post-hoc (e.g. `tasks_update { labels: ["from-review"] }`) still
// surfaces the reminder.
const STAY_IN_SCOPE_MATCH =
  "^(?:mcp__agent-tasks__task_create|mcp__agent-tasks__tasks_create|mcp__agent-tasks__tasks_update)$";

// Codex sibling of STAY_IN_SCOPE_MATCH above (task cf4cdc93), same
// bare-unanchored-list rationale as TRACK_ACTIVE_CLAIM_MATCH_CODEX.
const STAY_IN_SCOPE_MATCH_CODEX =
  "mcp__agent-tasks__task_create|mcp__agent-tasks__tasks_create|mcp__agent-tasks__tasks_update";

const STAY_IN_SCOPE_COMMAND = "harness pack hook stay-in-scope";

// Bash tool name used to widen the PostToolUse matcher when
// `expire_on_bash_match` is configured (task bea04a03). Matches the
// single entry of `DEFAULT_BASH_TOOL_NAMES` in
// understanding-before-execution-runtime.ts.
const BASH_TOOL_NAME_CLAUDE = "Bash";

// Codex shell-tool aliases used for the same widening on the Codex
// matcher builder below. Derived from the canonical `SHELL_ALIASES` in
// `src/runtime/tool-name-aliases.ts` (task bea04a03 review finding) —
// `policy-packs/` IS allowed to depend on `runtime/` (layering rule,
// `.dependency-cruiser.cjs`; the sibling understanding-before-execution-runtime.ts
// already imports from there), so this is a shared source of truth
// rather than a third hand-maintained copy. `CODEX_SHELL_TOOLS` in
// `src/cli/pack/hook-codex-pre-tool-use.ts` stays a separate literal:
// `policy-packs/` may not depend on `cli/` (same layering rule), so that
// one cannot be unified with this without a boundary violation.
const BASH_TOOL_NAMES_CODEX: ReadonlyArray<string> = SHELL_ALIASES;

/**
 * Compose the PostToolUse `match` regex from the configured tool list,
 * widened with the Bash tool name when `includeBash` is true (task
 * bea04a03: `approval_lifecycle.expire_on_bash_match` carries at least
 * one pattern). Before this widening, `expire_on_tool_match` alone
 * gated the matcher, so a real `Bash` call never reached the hook at
 * all — `matchPostToolUseBoundary`'s bash-regex check (which DOES
 * correctly evaluate `expire_on_bash_match` once invoked) was
 * unreachable in practice. Adding "Bash" here only ROUTES the call to
 * the hook; it does not add "Bash" to `expire_on_tool_match`'s own
 * semantics — the hook body still classifies a matched Bash call as a
 * bash-regex match (`toolNameMatched: false`), never a tool-name match.
 * Each tool name is regex-escaped and joined with `|` so settings.json
 * fires the hook only when the just-completed tool is one we care
 * about. When the operator declared `approval_lifecycle: { mode: session }`
 * (or cleared both lists), no PostToolUse hook is emitted at all (caller
 * filters).
 */
function postToolUseMatchPattern(
  tools: ReadonlyArray<string>,
  includeBash: boolean,
): string {
  const widened =
    includeBash && !tools.includes(BASH_TOOL_NAME_CLAUDE)
      ? [...tools, BASH_TOOL_NAME_CLAUDE]
      : tools;
  const escaped = widened.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})$`;
}

/**
 * Compose the CODEX PostToolUse `match` field — deliberately NOT
 * `postToolUseMatchPattern` above (review finding on task a1348c89,
 * verified via a direct probe of `expandCodexHookMatchPattern`). The
 * Claude builder anchors its output in `^(?:...)$` and regex-escapes
 * every tool name; `expandCodexHookMatchPattern` in
 * `generate-codex-config.ts` only alias-expands a match string whose
 * `|`-split tokens are ALL "simple" (`isSimpleToolPatternToken`,
 * `/^[A-Za-z0-9_.:-]+$/`) — the anchor characters `^`, `(`, `?` on the
 * first/last token trip that guard, so an anchored match is passed
 * through UNCHANGED at emit time. Concretely: a Codex session sending
 * the dotted `mcp__agent-tasks__.task_finish` or an underscore-server
 * `mcp__agent_tasks__task_finish` variant would never even reach the
 * hook — Codex's own dispatcher tests `tool_name` against the emitted
 * `matcher`, and the anchored form only contains the canonical forms.
 * (`matchPostToolUseBoundary`'s alias-aware body-side fix, same task,
 * only helps once the hook is actually invoked — it cannot compensate
 * for a dispatcher that never calls it.)
 *
 * This builder instead emits a BARE, unescaped `|`-joined list — same
 * shape as the existing `PRE_TOOL_USE_MATCH_CODEX` constant above —
 * so every token stays "simple" and `expandCodexHookMatchPattern`
 * expands each MCP tool name into its full alias set (server
 * hyphen/underscore swap, the `mcp__server__.tool` dotted form) at
 * `harness apply --runtime codex` time, exactly like the Codex
 * PreToolUse blocker's own matcher already does. No anchoring is
 * needed here: Codex's own hook dispatch (like the sibling PreToolUse
 * matcher) is unanchored substring-style matching already, and this
 * keeps the Codex and Claude builders independently tunable rather
 * than smuggling a Codex-only branch into the shared Claude helper.
 *
 * Like the Claude builder above, `includeBash` (task bea04a03) widens
 * the emitted list with the Codex shell-tool aliases
 * (`BASH_TOOL_NAMES_CODEX`: Bash/shell/exec_command/functions.exec_command)
 * when `approval_lifecycle.expire_on_bash_match` carries at least one
 * pattern, so a real Codex shell call is actually routed to the hook.
 * The aliases stay simple tokens (no anchors), so they still pass
 * through `expandCodexHookMatchPattern` unchanged — they have no MCP-style
 * variants to expand, but they must not trip the "simple token" guard
 * either.
 */
function codexPostToolUseMatchPattern(
  tools: ReadonlyArray<string>,
  includeBash: boolean,
): string {
  const widened = includeBash
    ? [...tools, ...BASH_TOOL_NAMES_CODEX.filter((t) => !tools.includes(t))]
    : tools;
  return widened.join("|");
}

function resolveExpireOnToolMatch(pack: PolicyPack): {
  tools: string[];
  emitHook: boolean;
} {
  const raw = (pack.config as Record<string, unknown>)["approval_lifecycle"];
  // No config block at all: default-on with the agent-tasks tool list.
  // This is the intentional behaviour change in v0.18 — operators who
  // want the legacy "one approval per session" UX opt out via
  // `approval_lifecycle: { mode: session }`.
  if (raw === undefined || raw === null) {
    return { tools: [...DEFAULT_EXPIRE_ON_TOOL_MATCH], emitHook: true };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { tools: [...DEFAULT_EXPIRE_ON_TOOL_MATCH], emitHook: true };
  }
  const obj = raw as Record<string, unknown>;
  if (obj["mode"] === "session") {
    return { tools: [], emitHook: false };
  }
  const list = obj["expire_on_tool_match"];
  if (Array.isArray(list)) {
    const tools = list.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    return { tools, emitHook: tools.length > 0 };
  }
  return { tools: [...DEFAULT_EXPIRE_ON_TOOL_MATCH], emitHook: true };
}

/**
 * Whether `approval_lifecycle.expire_on_bash_match` carries at least one
 * non-empty pattern (task bea04a03). Used ONLY to decide whether the
 * emitted PostToolUse matcher should be widened to route Bash (Claude) /
 * shell-alias (Codex) calls to the hook at all — the actual regex
 * compiling and matching against `tool_input.command` happens downstream
 * in `parseApprovalLifecycle` / `matchPostToolUseBoundary`
 * (understanding-before-execution-runtime.ts). An entry that turns out to
 * be an invalid regex is silently dropped there with a warning; that is
 * harmless here — the matcher merely routes the call to the hook, and a
 * hook invocation that finds no live bash-regex match just no-ops
 * (mirrors the existing `noBoundariesConfigured` / `boundary.matched`
 * no-op paths in hook-post-tool-use.ts / hook-codex-post-tool-use.ts).
 *
 * Mirrors `resolveExpireOnToolMatch`'s traversal of the same config
 * block (undefined/non-object/`mode: session` all resolve to "not
 * configured"), but returns a bare boolean since the matcher builders
 * only need presence, not the pattern strings themselves.
 */
function resolveExpireOnBashMatchConfigured(pack: PolicyPack): boolean {
  const raw = (pack.config as Record<string, unknown>)["approval_lifecycle"];
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if (obj["mode"] === "session") return false;
  const list = obj["expire_on_bash_match"];
  if (!Array.isArray(list)) return false;
  return list.some((v) => typeof v === "string" && v.length > 0);
}

interface PostToolUseBoundaries {
  tools: string[];
  bashConfigured: boolean;
  /** `true` when the PostToolUse hook should be emitted at all: either
   * `expire_on_tool_match` resolved a non-empty list, or
   * `expire_on_bash_match` is configured (task bea04a03) — the latter
   * matters on its own because an operator can set
   * `expire_on_tool_match: []` while still wanting a Bash-only boundary,
   * which `resolveExpireOnToolMatch`'s own `emitHook` alone would have
   * suppressed entirely. */
  emit: boolean;
}

/**
 * Shared PostToolUse boundary resolution for BOTH the Claude and Codex
 * `buildHooks` branches (task bea04a03): combines
 * `resolveExpireOnToolMatch` and `resolveExpireOnBashMatchConfigured`
 * into the one decision each branch's IIFE needs. Extracted specifically
 * to avoid re-introducing the exact clone-avoidance problem
 * `understanding-before-execution-runtime.ts`'s `matchPostToolUseBoundary`
 * / `applyPostToolUseExpiry` / `describePostToolUseExpiry` extraction
 * already solved once for the two runtimes' hook CLIs (`check:duplication`
 * flagged the inline duplicate when this task first wired the two nearly-
 * identical IIFEs by hand).
 */
function resolvePostToolUseBoundaries(pack: PolicyPack): PostToolUseBoundaries {
  const { tools, emitHook: toolsEmitHook } = resolveExpireOnToolMatch(pack);
  const bashConfigured = resolveExpireOnBashMatchConfigured(pack);
  return { tools, bashConfigured, emit: toolsEmitHook || bashConfigured };
}

function buildHooks(
  runtime: Runtime,
  pack: PolicyPack,
  opts: ResolvePackOptions = {},
): Hook[] {
  // Per-mode hook commands are identical (the mode is passed via the
  // package's UNDERSTANDING_GATE_MODE env var, set elsewhere — out of
  // scope for Phase 6 #2). What changes per mode is the instructions.md
  // content + the actual injected prompt (owned by the npm package).
  //
  // When `opts.reportsDir` is set (the apply path), each command is
  // prefixed with `UNDERSTANDING_GATE_REPORT_DIR=<absolute>` so all hooks
  // — including the standalone-package Stop bin which honors the same
  // env var — write/read the same directory.
  const wrap = (cmd: string): string =>
    prefixCommandWithReportsDir(cmd, opts.reportsDir);
  if (runtime === "codex") {
    return [
      {
        name: `${HOOK_NAME_PREFIX}:codex:user-prompt-submit`,
        event: "UserPromptSubmit",
        command: COMMAND_USER_PROMPT_SUBMIT_CODEX,
        blocking: false,
        budget_ms: 5000,
        description:
          "Codex adapter: inject the Understanding-Gate instruction template before the agent acts. Phase 6 #6.",
      },
      {
        name: `${HOOK_NAME_PREFIX}:codex:stop`,
        event: "Stop",
        command: wrap(COMMAND_STOP_CODEX),
        blocking: false,
        budget_ms: 5000,
        description:
          "Codex adapter: capture the agent's Understanding Report into .understanding-gate/reports/ as approvalStatus:pending. Phase 6 #6 follow-up.",
      },
      {
        name: `${HOOK_NAME_PREFIX}:codex:pre-tool-use`,
        event: "PreToolUse",
        match: PRE_TOOL_USE_MATCH_CODEX,
        command: wrap(COMMAND_PRE_TOOL_USE_CODEX),
        blocking: "hard",
        budget_ms: 5000,
        description:
          "Codex adapter: block apply_patch and Codex shell tools until an approved Understanding Report exists for the session. Consults both the evidence-ledger tag and the persisted JSON report.",
      },
      // PostToolUse marker-expiry (task a1348c89, widened by task
      // bea04a03). Same boundary-tool list as the Claude hook below
      // (resolveExpireOnToolMatch) so Codex expires on the identical
      // default set (agent-tasks task_finish / task_abandon /
      // pull_requests_merge / tasks_transition) — but a DIFFERENT
      // `match` builder (`codexPostToolUseMatchPattern`, not
      // `postToolUseMatchPattern`): see that function's own doc comment
      // for why the Claude builder's anchored regex form silently
      // defeats the Codex generator's MCP tool-name alias expansion
      // (review finding on task a1348c89).
      // `match` is ALSO widened with the Codex shell-tool aliases
      // (Bash/shell/exec_command/functions.exec_command) whenever
      // `approval_lifecycle.expire_on_bash_match` carries at least one
      // pattern (task bea04a03): before this, `match` was built ONLY
      // from `expire_on_tool_match`, so a real shell call never reached
      // the hook body at all on EITHER runtime, even though
      // `matchPostToolUseBoundary`'s bash-regex check correctly
      // evaluates `expire_on_bash_match` once invoked. The widened
      // aliases are NEVER added to `expire_on_tool_match` itself — the
      // hook body still classifies a matched shell call as a bash-regex
      // match, not a tool-name match, via `CODEX_SHELL_TOOLS.has(toolName)`
      // in the caller (hook-codex-post-tool-use.ts).
      ...((): Hook[] => {
        const { tools, bashConfigured, emit } = resolvePostToolUseBoundaries(pack);
        if (!emit) return [];
        const hook: Hook = {
          name: `${HOOK_NAME_PREFIX}:codex:post-tool-use`,
          event: "PostToolUse",
          match: codexPostToolUseMatchPattern(tools, bashConfigured),
          command: wrap(COMMAND_POST_TOOL_USE_CODEX),
          blocking: false,
          budget_ms: 2000,
          description:
            "Codex adapter: expire the approval marker AND the persisted report after a task-completion boundary tool or expire_on_bash_match shell command (default tools: agent-tasks task_finish / task_abandon / pull_requests_merge). Forces a fresh Understanding Report on the next task.",
        };
        return [hook];
      })(),
      // Active-claim tracker (harness/494fd1e5), Codex parity task
      // cf4cdc93 (parity-gaps doc gap #3). Always emitted alongside the
      // pack, mirroring the Claude sibling below — the matcher won't
      // fire for operators on non-agent-tasks tasking systems, so the
      // file simply never appears for them. Same command as Claude
      // (see TRACK_ACTIVE_CLAIM_COMMAND's doc comment above): the hook
      // body needs no Codex-specific handling.
      {
        name: `${HOOK_NAME_PREFIX}:codex:track-active-claim`,
        event: "PostToolUse",
        match: TRACK_ACTIVE_CLAIM_MATCH_CODEX,
        command: TRACK_ACTIVE_CLAIM_COMMAND,
        blocking: false,
        budget_ms: 2000,
        description:
          "Codex adapter: track the active agent-tasks claim by writing/clearing <generatedDir>/active-claim on task_start / task_finish / task_abandon. Lets `harness approve understanding` auto-resolve the task id (harness/494fd1e5, Codex parity task cf4cdc93).",
      },
      // Stay-in-scope reminder (harness/2ba06030), Codex parity task
      // cf4cdc93 (parity-gaps doc gap #3). Same always-on / soft-only
      // semantics as the Claude sibling below.
      {
        name: `${HOOK_NAME_PREFIX}:codex:stay-in-scope`,
        event: "PostToolUse",
        match: STAY_IN_SCOPE_MATCH_CODEX,
        command: STAY_IN_SCOPE_COMMAND,
        blocking: false,
        budget_ms: 2000,
        description:
          "Codex adapter: emit a soft reminder + audit row when a review-derived follow-up task gets created. Surfaces user-memory feedback_reviewer_findings_stay_in_scope. Disable: STAY_IN_SCOPE_DISABLED=1 (harness/2ba06030, Codex parity task cf4cdc93).",
      },
    ];
  }
  // `min_version` floor on the npm-backed bins: 0.4.0 ships the
  // required "Prior Art" 10th section of the Understanding Report
  // (agent-grounding PR #85, harness task 798d7173). Operators below
  // this floor would silently miss the section because the Stop-capture
  // parser doesn't yet enforce it. The prior floor was 0.3.1 (first
  // release whose `understanding-gate --version` reported the actual
  // installed version rather than a stale literal; agent-grounding PRs
  // #80 + #81); 0.4.0 supersedes it. The PreToolUse blocker below is
  // the harness CLI itself, not an npm-backed bin, so it does not carry
  // a floor here.
  const UG_MIN_VERSION = "0.4.0";
  const UG_VERSION_COMMAND: [string, string] = [
    "understanding-gate",
    "--version",
  ];
  return [
    {
      name: `${HOOK_NAME_PREFIX}:user-prompt-submit`,
      event: "UserPromptSubmit",
      command: BIN_USER_PROMPT_SUBMIT_CLAUDE,
      blocking: false,
      budget_ms: 5000,
      min_version: UG_MIN_VERSION,
      version_command: UG_VERSION_COMMAND,
      description:
        "Inject the Understanding-Gate instruction template before the agent acts. Source: @lannguyensi/understanding-gate.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:stop`,
      event: "Stop",
      command: wrap(BIN_STOP_CLAUDE),
      blocking: false,
      budget_ms: 5000,
      min_version: UG_MIN_VERSION,
      version_command: UG_VERSION_COMMAND,
      description:
        "Capture the agent's Understanding Report into .understanding-gate/reports/. Source: @lannguyensi/understanding-gate.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:pre-tool-use`,
      event: "PreToolUse",
      match: PRE_TOOL_USE_MATCH_CLAUDE,
      command: wrap(PRE_TOOL_USE_COMMAND_CLAUDE),
      blocking: "hard",
      budget_ms: 5000,
      description:
        "Block Edit/Write/Bash until an approved Understanding Report exists for the session. Consults both the evidence-ledger tag (understanding-approved:${SESSION_ID}) and the persisted JSON report.",
    },
    // PostToolUse marker-expiry hook (agent-tasks/d8ee60ca). Fires on the
    // configured task-boundary tools, and (task bea04a03) on a Bash call
    // when `approval_lifecycle.expire_on_bash_match` carries at least one
    // pattern, and deletes the approval marker so the next Edit / Write /
    // Bash forces a fresh Understanding Report. Default tool list expires
    // on agent-tasks task_finish / task_abandon / pull_requests_merge.
    // Operators on other task systems override the list via
    // config.approval_lifecycle.expire_on_tool_match; setting
    // `approval_lifecycle: { mode: session }` opts out entirely and
    // suppresses this hook from being emitted at all.
    //
    // Before task bea04a03, `match` was built ONLY from
    // `expire_on_tool_match`, so a real `Bash` call never invoked this
    // hook at all — `matchPostToolUseBoundary`'s bash-regex check (which
    // DOES correctly evaluate `expire_on_bash_match` once invoked)
    // was unreachable. Widening `match` to include "Bash" does not
    // change how the hook body classifies the match: a Bash call that
    // fires the hook is still evaluated as a bash-regex match
    // (`toolNameMatched: false`), never folded into
    // `expire_on_tool_match`'s own tool-name semantics.
    ...((): Hook[] => {
      const { tools, bashConfigured, emit } = resolvePostToolUseBoundaries(pack);
      if (!emit) return [];
      const hook: Hook = {
        name: `${HOOK_NAME_PREFIX}:post-tool-use`,
        event: "PostToolUse",
        match: postToolUseMatchPattern(tools, bashConfigured),
        // Wrap with UNDERSTANDING_GATE_REPORT_DIR so the post-tool-use
        // hook resolves the same persisted-reports directory as the
        // pre-tool-use blocker; otherwise it can't expire the persisted
        // report alongside the marker (harness/1ee26e77 follow-up).
        command: wrap(POST_TOOL_USE_COMMAND_CLAUDE),
        blocking: false,
        budget_ms: 2000,
        description:
          "Expire the approval marker AND the persisted report after a task-completion boundary tool or expire_on_bash_match Bash command (default tools: agent-tasks task_finish / task_abandon / pull_requests_merge). Forces a fresh Understanding Report on the next task.",
      };
      return [hook];
    })(),
    // Active-claim tracker (harness/494fd1e5). PostToolUse hook on
    // agent-tasks task_start / task_finish / task_abandon. Maintains a
    // small file at <generatedDir>/active-claim so `harness approve
    // understanding` can auto-resolve the task id when --task is
    // absent. Always emitted alongside the pack — operators on other
    // tasking systems are unaffected (the matcher won't fire for
    // their tools), the file simply never appears.
    {
      name: `${HOOK_NAME_PREFIX}:track-active-claim`,
      event: "PostToolUse",
      match: TRACK_ACTIVE_CLAIM_MATCH,
      command: TRACK_ACTIVE_CLAIM_COMMAND,
      blocking: false,
      budget_ms: 2000,
      description:
        "Track the active agent-tasks claim by writing/clearing <generatedDir>/active-claim on task_start / task_finish / task_abandon. Lets `harness approve understanding` auto-resolve the task id (harness/494fd1e5).",
    },
    // Stay-in-scope reminder (harness/2ba06030). PostToolUse hook on
    // agent-tasks task_create / tasks_create / tasks_update. Emits a
    // one-line stderr reminder + JSONL audit row when the new task's
    // labels or description suggest it was carved out of a review
    // finding that may have been inline-fixable. Soft (no block);
    // enforces user-memory feedback_reviewer_findings_stay_in_scope.
    // Bundled with this pack for operational convenience — operators
    // on non-agent-tasks tasking systems are unaffected (matcher
    // won't fire). Disable via STAY_IN_SCOPE_DISABLED=1 in the hook's
    // env; override audit log path via STAY_IN_SCOPE_LOG.
    {
      name: `${HOOK_NAME_PREFIX}:stay-in-scope`,
      event: "PostToolUse",
      match: STAY_IN_SCOPE_MATCH,
      command: STAY_IN_SCOPE_COMMAND,
      blocking: false,
      budget_ms: 2000,
      description:
        "Emit a soft reminder + audit row when a review-derived follow-up task gets created. Surfaces user-memory feedback_reviewer_findings_stay_in_scope. Disable: STAY_IN_SCOPE_DISABLED=1.",
    },
  ];
}

function modeFriction(mode: Mode): string {
  switch (mode) {
    case "fast_confirm":
      return "low friction. The gate fires on prompts the classifier flags as execution-relevant. Brief Understanding Report; one-line approval.";
    case "grill_me":
      return "medium friction (default). The gate fires on any prompt the agent might respond to with a write. Full Understanding Report (assumptions, openQuestions, outOfScope, risks, verificationPlan). Push-back is encouraged.";
    case "strict":
      return "high friction. The gate fires on every prompt. Report MUST include verificationPlan and outOfScope; requiresHumanApproval is forced to true.";
  }
}

function buildInstructions(
  pack: PolicyPack,
  mode: Mode,
  runtime: Runtime,
): string {
  const description = pack.description?.trim() ?? "";
  const isCodex = runtime === "codex";
  const injectorCmd = isCodex
    ? COMMAND_USER_PROMPT_SUBMIT_CODEX
    : BIN_USER_PROMPT_SUBMIT_CLAUDE;
  const stopCmd = isCodex ? COMMAND_STOP_CODEX : BIN_STOP_CLAUDE;
  const blockerCmd = isCodex
    ? COMMAND_PRE_TOOL_USE_CODEX
    : PRE_TOOL_USE_COMMAND_CLAUDE;
  const blockerMatch = isCodex
    ? PRE_TOOL_USE_MATCH_CODEX
    : PRE_TOOL_USE_MATCH_CLAUDE;
  const settingsArtefact = isCodex
    ? "`harness.generated/codex/config.toml`"
    : "harness-managed `settings.json`";
  const stopBullet = `2. \`Stop\` capture (\`${stopCmd}\`): persists the emitted Understanding
   Report under \`.understanding-gate/reports/\` for audit and downstream
   approval consumption.
`;
  const blockerOrdinal = "3";
  return `# Policy Pack: ${PACK_NAME}

> Operator audit copy. The agent-facing prompt is injected at runtime by
> the \`${injectorCmd}\` UserPromptSubmit hook; that text lives
> in the \`@lannguyensi/understanding-gate\` package, not here. This file
> records WHAT the pack is doing and HOW it is configured so that
> \`harness diff --since-apply\` can flag operator-facing drift.

## Runtime

${runtime}

## Mode

${mode}

${modeFriction(mode)}

## Effect

While this pack is enabled, hooks are wired into the ${settingsArtefact}:

1. \`UserPromptSubmit\` injector (\`${injectorCmd}\`): inserts the
   Understanding-Gate instruction template into the agent's first response.
${stopBullet}${blockerOrdinal}. \`PreToolUse\` blocker (\`${blockerCmd}\`, blocking: hard)
   on \`${blockerMatch}\`: refuses the tool call until an approved
   report exists for the session. Consults BOTH the evidence-ledger
   tag (\`understanding-approved:\${SESSION_ID}\`, canonical for
   harnessed sessions) AND the persisted JSON report under
   \`.understanding-gate/reports/\` (fallback for sessions without
   grounding-mcp wired). Either source approves.

## Approval

The standalone blocker shipped in \`@lannguyensi/understanding-gate@>=0.2.0\`
checks the persisted JSON report's \`approvalStatus\`. Phase 6 #4 will
add a harness-side blocker that ALSO consults the evidence-ledger tag
\`understanding-approved:\${SESSION_ID}\` (canonical for harnessed
sessions), and \`harness approve understanding\` will round-trip both.
Until then, approval flows through the package's own CLI.

## Pack metadata
${description ? `\n> ${description.replace(/\n/g, "\n> ")}\n` : ""}
- Source: \`builtin\`
- Pack: \`${PACK_NAME}\`
- Mode: \`${mode}\`
- Runtime: \`${runtime}\`

## See also

- \`docs/policy-packs/understanding-before-execution.md\` (full reference)
- \`docs/ROADMAP.md\` Phase 6 sub-task decomposition
`;
}

function resolvePermissionProfile(pack: PolicyPack): {
  permissions: PackPermissionsContribution | null;
  warning: string | null;
} {
  const raw = pack.config["permission_profile"];
  if (raw === undefined) return { permissions: null, warning: null };
  if (typeof raw !== "string") {
    return {
      permissions: null,
      warning: `policy_packs[${pack.name}].config.permission_profile: expected a string, got ${typeof raw}; skipping permission contribution.`,
    };
  }
  if (!isKnownProfileName(raw)) {
    return {
      permissions: null,
      warning: `policy_packs[${pack.name}].config.permission_profile: unrecognised profile ${JSON.stringify(
        raw,
      )}. Allowed: ${KNOWN_PROFILE_NAMES.join(", ")}. Skipping permission contribution.`,
    };
  }
  const profile = resolveProfile(raw);
  if (!profile) return { permissions: null, warning: null };
  return { permissions: profileToSettingsPermissions(profile), warning: null };
}

export function resolve(
  pack: PolicyPack,
  runtime: Runtime = DEFAULT_RUNTIME,
  opts: ResolvePackOptions = {},
): { contribution: PackContribution; warnings: string[] } {
  const { mode, warning } = resolveMode(pack);
  const hooks = buildHooks(runtime, pack, opts);
  const instructionsContent = buildInstructions(pack, mode, runtime);
  const files: PackContributionFile[] = [
    {
      relativePath: `policy-packs/${PACK_NAME}/instructions.md`,
      content: instructionsContent,
    },
  ];
  const warnings: string[] = [];
  if (warning) warnings.push(warning);

  const profileResult = resolvePermissionProfile(pack);
  if (profileResult.warning) warnings.push(profileResult.warning);
  const contribution: PackContribution = { hooks, files };
  if (profileResult.permissions)
    contribution.permissions = profileResult.permissions;

  return { contribution, warnings };
}
