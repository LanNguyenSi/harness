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

export const PACK_NAME = "understanding-before-execution";

export type Mode = "fast_confirm" | "grill_me" | "strict";

const MODES: readonly Mode[] = ["fast_confirm", "grill_me", "strict"];

export const DEFAULT_MODE: Mode = "grill_me";

const HOOK_NAME_PREFIX = `policy-pack:${PACK_NAME}`;

const PRE_TOOL_USE_MATCH = "Edit|Write|Bash";

// UserPromptSubmit + Stop hooks point at `@lannguyensi/understanding-gate`
// bare bin names (npm i -g). The harness validator's checkHooks skips
// PATH lookup for non-rooted commands by design, so missing-bin shows
// up at runtime, not at lint. `harness doctor` (Phase 6 #4 follow-up)
// will add the presence check.
const BIN_USER_PROMPT_SUBMIT = "understanding-gate-claude-hook";
const BIN_STOP = "understanding-gate-claude-stop";
// PreToolUse blocker is the harness CLI itself (Phase 6 #4): it consults
// BOTH the evidence-ledger tag (canonical for harnessed sessions) AND
// the persisted JSON report under `.understanding-gate/reports/`
// (fallback for sessions without grounding-mcp wired). The npm package's
// own bin remains available for solo users; the harness blocker is
// strictly more powerful.
const PRE_TOOL_USE_COMMAND = "harness pack hook pre-tool-use";

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
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

function buildHooks(): Hook[] {
  // Per-mode hook commands are identical (the mode is passed via the
  // package's UNDERSTANDING_GATE_MODE env var, set elsewhere — out of
  // scope for Phase 6 #2). What changes per mode is the instructions.md
  // content + the actual injected prompt (owned by the npm package).
  return [
    {
      name: `${HOOK_NAME_PREFIX}:user-prompt-submit`,
      event: "UserPromptSubmit",
      command: BIN_USER_PROMPT_SUBMIT,
      blocking: false,
      budget_ms: 5000,
      description:
        "Inject the Understanding-Gate instruction template before the agent acts. Source: @lannguyensi/understanding-gate.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:stop`,
      event: "Stop",
      command: BIN_STOP,
      blocking: false,
      budget_ms: 5000,
      description:
        "Capture the agent's Understanding Report into .understanding-gate/reports/. Source: @lannguyensi/understanding-gate.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:pre-tool-use`,
      event: "PreToolUse",
      match: PRE_TOOL_USE_MATCH,
      command: PRE_TOOL_USE_COMMAND,
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

function buildInstructions(pack: PolicyPack, mode: Mode): string {
  const description = pack.description?.trim() ?? "";
  return `# Policy Pack: ${PACK_NAME}

> Operator audit copy. The agent-facing prompt is injected at runtime by
> the \`${BIN_USER_PROMPT_SUBMIT}\` UserPromptSubmit hook; that text lives
> in the \`@lannguyensi/understanding-gate\` package, not here. This file
> records WHAT the pack is doing and HOW it is configured so that
> \`harness diff --since-apply\` can flag operator-facing drift.

## Mode

${mode}

${modeFriction(mode)}

## Effect

While this pack is enabled, three hooks are wired into the harness-managed
\`settings.json\`:

1. \`UserPromptSubmit\` injector (\`${BIN_USER_PROMPT_SUBMIT}\`): inserts the
   Understanding-Gate instruction template into the agent's first response.
2. \`Stop\` capture (\`${BIN_STOP}\`): persists the emitted Understanding
   Report under \`.understanding-gate/reports/\` for audit and downstream
   approval consumption.
3. \`PreToolUse\` blocker (\`${PRE_TOOL_USE_COMMAND}\`, blocking: hard)
   on \`Edit|Write|Bash\`: refuses the tool call until an approved
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

export function resolve(pack: PolicyPack): { contribution: PackContribution; warnings: string[] } {
  const { mode, warning } = resolveMode(pack);
  const hooks = buildHooks();
  const instructionsContent = buildInstructions(pack, mode);
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
