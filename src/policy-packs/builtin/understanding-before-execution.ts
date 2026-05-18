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

import type { Hook, PolicyPack } from "../../schema/index.js";
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

export const PACK_NAME = "understanding-before-execution";

export type Mode = "fast_confirm" | "grill_me" | "strict";

const MODES: readonly Mode[] = ["fast_confirm", "grill_me", "strict"];

export const DEFAULT_MODE: Mode = "grill_me";

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

export function isMode(value: unknown): value is Mode {
  return (
    typeof value === "string" && (MODES as readonly string[]).includes(value)
  );
}

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
}

/**
 * POSIX single-quote-escape for an arbitrary path. Safe inside the
 * `VAR=<value>` prefix of a `sh -c` command line. Always quotes — paths
 * derived from `path.dirname()` may contain spaces or other shell
 * metacharacters, and a plain `VAR=$path` would split on whitespace.
 */
function shellQuoteSingle(s: string): string {
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
const TRACK_ACTIVE_CLAIM_COMMAND_CLAUDE =
  "harness pack hook track-active-claim";

// Hardcoded matcher for the v2 active-claim tracker (harness/494fd1e5).
// Agent-tasks specific; operators on other tasking systems can ignore
// this hook (the matcher won't fire for their tools). A config-driven
// extension can land later if a second tasking system asks for it.
const TRACK_ACTIVE_CLAIM_MATCH =
  "^(?:mcp__agent-tasks__task_start|mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__tasks_transition)$";

/**
 * Compose the PostToolUse `match` regex from the configured tool list.
 * Each tool name is regex-escaped and joined with `|` so settings.json
 * fires the hook only when the just-completed tool is one we care
 * about. When the operator declared `approval_lifecycle: { mode: session }`
 * (or cleared the list), no PostToolUse hook is emitted at all (caller
 * filters).
 */
function postToolUseMatchPattern(tools: ReadonlyArray<string>): string {
  const escaped = tools.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})$`;
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
    ];
  }
  // `min_version` floor on the npm-backed bins: 0.3.1 is the first release
  // whose published `understanding-gate --version` reports the actual
  // installed version rather than a stale literal (agent-grounding PRs
  // #80 + #81). 0.3.0 shipped the parser-side fast_confirm fix but the
  // dist cli.js hardcoded "0.2.3" so every install looked stale to
  // doctor; without this floor, an operator on 0.2.x would silently get
  // the no_marker_fast_confirm_attempt parse-error noise documented in
  // harness PR #169. The PreToolUse blocker below is the harness CLI
  // itself, not an npm-backed bin, so it does not carry a floor here.
  const UG_MIN_VERSION = "0.3.1";
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
    // configured task-boundary tools and deletes the approval marker so
    // the next Edit / Write / Bash forces a fresh Understanding Report.
    // Default tool list expires on agent-tasks task_finish / task_abandon /
    // pull_requests_merge. Operators on other task systems override the
    // list via config.approval_lifecycle.expire_on_tool_match; setting
    // `approval_lifecycle: { mode: session }` opts out entirely and
    // suppresses this hook from being emitted at all.
    ...((): Hook[] => {
      const { tools, emitHook } = resolveExpireOnToolMatch(pack);
      if (!emitHook) return [];
      const hook: Hook = {
        name: `${HOOK_NAME_PREFIX}:post-tool-use`,
        event: "PostToolUse",
        match: postToolUseMatchPattern(tools),
        // Wrap with UNDERSTANDING_GATE_REPORT_DIR so the post-tool-use
        // hook resolves the same persisted-reports directory as the
        // pre-tool-use blocker; otherwise it can't expire the persisted
        // report alongside the marker (harness/1ee26e77 follow-up).
        command: wrap(POST_TOOL_USE_COMMAND_CLAUDE),
        blocking: false,
        budget_ms: 2000,
        description:
          "Expire the approval marker AND the persisted report after a task-completion boundary tool (default: agent-tasks task_finish / task_abandon / pull_requests_merge). Forces a fresh Understanding Report on the next task.",
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
      command: TRACK_ACTIVE_CLAIM_COMMAND_CLAUDE,
      blocking: false,
      budget_ms: 2000,
      description:
        "Track the active agent-tasks claim by writing/clearing <generatedDir>/active-claim on task_start / task_finish / task_abandon. Lets `harness approve understanding` auto-resolve the task id (harness/494fd1e5).",
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
