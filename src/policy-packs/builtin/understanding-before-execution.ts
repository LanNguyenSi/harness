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
// Codex's write surface is `apply_patch` + `Bash`/`shell` (the task's
// in-scope list). The hook contract Codex feeds to the adapter is the
// same generic envelope harness publishes: `{ session_id, tool_name,
// raw_input, event }` on stdin, `{ decision }` on stdout, exit 2 on
// block. See dogfood/phase6-6/README.md for the wire format.
const PRE_TOOL_USE_MATCH_CLAUDE = "Edit|Write|Bash";
const PRE_TOOL_USE_MATCH_CODEX = "apply_patch|Bash|shell";

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
//   - PreToolUse blocker on apply_patch/Bash/shell (Phase 6 #6).
//
// Cross-runtime sessions can still approve from a Claude Code report:
// the ledger tag is the canonical source for harnessed sessions,
// independent of which runtime captured the report. The persisted-
// report directory is shared between runtimes, so a Codex stop that
// writes a report is approvable via `harness approve understanding`
// regardless of which runtime invokes the next tool call.
const COMMAND_USER_PROMPT_SUBMIT_CODEX = "harness pack hook codex-user-prompt-submit";
const COMMAND_STOP_CODEX = "harness pack hook codex-stop";
const COMMAND_PRE_TOOL_USE_CODEX = "harness pack hook codex-pre-tool-use";

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
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

function prefixCommandWithReportsDir(command: string, reportsDir: string | undefined): string {
  if (!reportsDir) return command;
  return `${REPORTS_DIR_ENV}=${shellQuoteSingle(reportsDir)} ${command}`;
}

export function resolveMode(pack: PolicyPack): { mode: Mode; warning: string | null } {
  const raw = pack.config["mode"];
  if (raw === undefined) return { mode: DEFAULT_MODE, warning: null };
  if (isMode(raw)) return { mode: raw, warning: null };
  const warning = `policy_packs[${pack.name}].config.mode: unrecognised value ${JSON.stringify(
    raw,
  )}, falling back to "${DEFAULT_MODE}". Allowed: ${MODES.join(", ")}.`;
  return { mode: DEFAULT_MODE, warning };
}

function buildHooks(runtime: Runtime, opts: ResolvePackOptions = {}): Hook[] {
  // Per-mode hook commands are identical (the mode is passed via the
  // package's UNDERSTANDING_GATE_MODE env var, set elsewhere — out of
  // scope for Phase 6 #2). What changes per mode is the instructions.md
  // content + the actual injected prompt (owned by the npm package).
  //
  // When `opts.reportsDir` is set (the apply path), each command is
  // prefixed with `UNDERSTANDING_GATE_REPORT_DIR=<absolute>` so all hooks
  // — including the standalone-package Stop bin which honors the same
  // env var — write/read the same directory.
  const wrap = (cmd: string): string => prefixCommandWithReportsDir(cmd, opts.reportsDir);
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
          "Codex adapter: block apply_patch/Bash/shell until an approved Understanding Report exists for the session. Consults both the evidence-ledger tag and the persisted JSON report.",
      },
    ];
  }
  return [
    {
      name: `${HOOK_NAME_PREFIX}:user-prompt-submit`,
      event: "UserPromptSubmit",
      command: BIN_USER_PROMPT_SUBMIT_CLAUDE,
      blocking: false,
      budget_ms: 5000,
      description:
        "Inject the Understanding-Gate instruction template before the agent acts. Source: @lannguyensi/understanding-gate.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:stop`,
      event: "Stop",
      command: wrap(BIN_STOP_CLAUDE),
      blocking: false,
      budget_ms: 5000,
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

function buildInstructions(pack: PolicyPack, mode: Mode, runtime: Runtime): string {
  const description = pack.description?.trim() ?? "";
  const isCodex = runtime === "codex";
  const injectorCmd = isCodex ? COMMAND_USER_PROMPT_SUBMIT_CODEX : BIN_USER_PROMPT_SUBMIT_CLAUDE;
  const stopCmd = isCodex ? COMMAND_STOP_CODEX : BIN_STOP_CLAUDE;
  const blockerCmd = isCodex ? COMMAND_PRE_TOOL_USE_CODEX : PRE_TOOL_USE_COMMAND_CLAUDE;
  const blockerMatch = isCodex ? PRE_TOOL_USE_MATCH_CODEX : PRE_TOOL_USE_MATCH_CLAUDE;
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

function resolvePermissionProfile(
  pack: PolicyPack,
): { permissions: PackPermissionsContribution | null; warning: string | null } {
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
  const hooks = buildHooks(runtime, opts);
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
  if (profileResult.permissions) contribution.permissions = profileResult.permissions;

  return { contribution, warnings };
}
