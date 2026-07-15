// Builtin Policy Pack: `branch-protection`.
//
// Blocks Write/Edit (and the codex `apply_patch` equivalent) when the
// agent is on a protected branch (default: master, main, develop). The
// gate fires at the FIRST source mutation, complementing the existing
// `preflight-before-push` gate which fires at the LAST reversible step.
//
// Mechanics, mirroring `understanding-before-execution`:
//
//   1. SessionStart producer (`harness session-start branch-check`) reads
//      `.git/HEAD` for the cwd and, if the branch is NOT protected,
//      writes a `branch:non-protected:<branch>` fact to the evidence
//      ledger for the current session.
//
//   2. PreToolUse blocker (`harness pack hook branch-protection`)
//      consults the ledger on every Write/Edit (or `apply_patch`) and
//      emits a Claude Code deny envelope unless either:
//        - a fresh (<5m) `branch:non-protected` tag exists, OR
//        - the operator-only override marker exists at
//          `harness.generated/.approvals/branch-protection-<sessionId>`,
//          written by `harness approve branch-protection`. The legacy
//          `branch-protection-ack:` ledger tag is no longer trusted as an
//          override (audit finding #39): it is agent-writable via
//          `mcp__agent-grounding__ledger_add`, so it could self-bless an
//          edit. The marker lives under `harness.generated/`, which Edit /
//          Write / Bash are all gated from writing.
//
// The producer is also runnable on-demand from the operator's `!` shell
// — same CLI verb, no SessionStart event piped on stdin — so an agent
// that just branched can refresh the gate without restarting the
// session.
//
// Enabled per-installation via `harness pack add branch-protection`.
// The `full` init template wires it with `enabled: true` (see
// src/cli/init/templates.ts); the `solo` / `team` templates do not.

import { z } from "zod";
import { PolicyUxSchema } from "../../schema/policies.js";
import type { Hook, PolicyPack, PolicyUx } from "../../schema/index.js";
import { DEFAULT_RUNTIME, type Runtime } from "../runtime.js";
import type { PackContribution, PackContributionFile } from "../types.js";
import {
  ACK_TAG_PREFIX,
  DEFAULT_PROTECTED_BRANCHES,
  NON_PROTECTED_TAG_PREFIX,
  PACK_NAME,
  PRODUCER_FRESHNESS_MS,
  resolveProtectedBranches,
} from "./branch-protection-runtime.js";

export { PACK_NAME };

/**
 * Zod schema for this pack's `config:` block. See sibling pack
 * `understanding-before-execution.configSchema` for rationale: strict
 * by design so typo'd keys fail loud at lint time. `protected_branches`
 * is the only operator-tunable key today; new keys land here first,
 * then in `resolveProtectedBranches`.
 */
export const configSchema = z
  .object({
    protected_branches: z.array(z.string().min(1)).optional(),
    // `ux` is consumed by the PreToolUse blocker to render an
    // agent-facing remediation block when the gate trips.
    ux: PolicyUxSchema.optional(),
  })
  .strict();

/**
 * Shipped default `config.ux` for this pack (agent-tasks/9806d4f8).
 * Canonical source for the `full` init template and `harness pack
 * reseed` (task 68b9ad9c): a future wording fix to the deny-message
 * text lands here once and reaches both a fresh `harness init --template
 * full` and an operator running `harness pack reseed branch-protection`
 * against an already-installed manifest.
 */
export function defaultUx(): PolicyUx {
  return {
    cannot: "You cannot edit files on protected branch ${BRANCH} yet.",
    required: [
      "a checkout of a non-protected branch (current `${BRANCH}` is protected)",
    ],
    run: ["git checkout -b feat/<your-task>", "harness session-start branch-check"],
  };
}

const HOOK_NAME_PREFIX = `policy-pack:${PACK_NAME}`;

const PRE_TOOL_USE_MATCH_CLAUDE = "Write|Edit";
const PRE_TOOL_USE_MATCH_CODEX = "apply_patch";

const PRODUCER_COMMAND = "harness session-start branch-check";
const BLOCKER_COMMAND = "harness pack hook branch-protection";

function buildHooks(runtime: Runtime): Hook[] {
  const isCodex = runtime === "codex";
  const blockerMatch = isCodex ? PRE_TOOL_USE_MATCH_CODEX : PRE_TOOL_USE_MATCH_CLAUDE;
  return [
    {
      name: `${HOOK_NAME_PREFIX}:session-start`,
      event: "SessionStart",
      command: PRODUCER_COMMAND,
      blocking: false,
      budget_ms: 5000,
      description:
        "Producer: write `branch:non-protected:<branch>` to the evidence ledger when the session opens on a non-protected branch. Non-blocking; failures leave the gate closed.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:pre-tool-use`,
      event: "PreToolUse",
      match: blockerMatch,
      command: BLOCKER_COMMAND,
      blocking: "hard",
      budget_ms: 5000,
      description: `Blocker: deny ${blockerMatch} on protected branches unless a fresh branch:non-protected tag exists in the ledger or the operator-only override marker (harness approve branch-protection) is present.`,
    },
  ];
}

function buildInstructions(pack: PolicyPack, branches: readonly string[], runtime: Runtime): string {
  const description = pack.description?.trim() ?? "";
  const isCodex = runtime === "codex";
  const blockerMatch = isCodex ? PRE_TOOL_USE_MATCH_CODEX : PRE_TOOL_USE_MATCH_CLAUDE;
  const settingsArtefact = isCodex
    ? "`harness.generated/codex/config.toml`"
    : "harness-managed `settings.json`";
  const minutes = Math.round(PRODUCER_FRESHNESS_MS / 60000);
  return `# Policy Pack: ${PACK_NAME}

> Operator audit copy. This pack blocks source-mutating tool calls when
> the agent is on a protected branch, closing the loop on the
> "edit-on-master" incident pattern.

## Runtime

${runtime}

## Protected branches

${branches.map((b) => `- \`${b}\``).join("\n")}

Set \`config.protected_branches\` in your manifest to override.

## Effect

While this pack is enabled, hooks are wired into the ${settingsArtefact}:

1. \`SessionStart\` producer (\`${PRODUCER_COMMAND}\`, blocking: false):
   reads the cwd's \`.git/HEAD\`. If the branch is NOT in the protected
   list, writes \`${NON_PROTECTED_TAG_PREFIX}:<branch>\` to the evidence
   ledger for the current session.

2. \`PreToolUse\` blocker (\`${BLOCKER_COMMAND}\`, blocking: hard) on
   \`${blockerMatch}\`: refuses the tool call unless EITHER
   - a \`${NON_PROTECTED_TAG_PREFIX}\` tag exists in the ledger from
     within the last ${minutes} minutes, OR
   - the operator-only override marker exists at
     \`harness.generated/.approvals/branch-protection-<sessionId>\`.

## Escape hatches

- **Refresh after branching**: the producer is runnable on demand from
  the operator's \`!\` shell as \`${PRODUCER_COMMAND}\`. The agent's Bash
  is gated by the Understanding Gate but the producer command is itself
  a \`harness ...\` invocation that the gate's allowlist accepts.

- **Explicit override** (operator only): from an un-hooked shell run
  \`harness approve branch-protection --session <sessionId>\`. This writes
  the canonical approval marker the blocker consults. Use it when you have
  a deliberate reason to edit a protected branch (version bumps, CI
  workflow patches, hotfixes). SECURITY (audit finding #39): a
  \`${ACK_TAG_PREFIX}:<reason>\` ledger tag is NO LONGER sufficient on its
  own — it is agent-writable via \`mcp__agent-grounding__ledger_add\`, so
  the gate would otherwise be self-approvable. The approve verb still
  records that ledger tag for audit, but only the marker file (which the
  agent cannot write) opens the gate.

## Out of scope (v1)

- Locking down \`git\` itself (would create false-positive churn on
  read-only commands like \`git status\`).
- Auto-branching on Write attempt (silent autocorrect is wrong; the
  agent should be the one who notices and branches).
- Path-allowlist for safe-on-master files (CHANGELOG.md, version
  bumps). Open for v2 if operators report friction.

## Pack metadata
${description ? `\n> ${description.replace(/\n/g, "\n> ")}\n` : ""}
- Source: \`builtin\`
- Pack: \`${PACK_NAME}\`
- Runtime: \`${runtime}\`
- Defaults: ${DEFAULT_PROTECTED_BRANCHES.join(", ")}
`;
}

export function resolve(
  pack: PolicyPack,
  runtime: Runtime = DEFAULT_RUNTIME,
): { contribution: PackContribution; warnings: string[] } {
  const { branches, warning } = resolveProtectedBranches(pack);
  const hooks = buildHooks(runtime);
  const files: PackContributionFile[] = [
    {
      relativePath: `policy-packs/${PACK_NAME}/instructions.md`,
      content: buildInstructions(pack, branches, runtime),
    },
  ];
  const warnings: string[] = [];
  if (warning) warnings.push(warning);
  return { contribution: { hooks, files }, warnings };
}
