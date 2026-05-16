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
//        - a `branch-protection-ack:` override tag exists (any age,
//          written by the operator via `mcp__agent-grounding__ledger_add`
//          since Bash is gated by this same pack).
//
// The producer is also runnable on-demand from the operator's `!` shell
// — same CLI verb, no SessionStart event piped on stdin — so an agent
// that just branched can refresh the gate without restarting the
// session.
//
// Pack is OFF by default: it must be enabled per-installation via
// `harness pack add branch-protection`. The `full` init template does
// NOT wire it (revisit after one cycle of operator feedback).

import type { Hook, PolicyPack } from "../../schema/index.js";
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
      description: `Blocker: deny ${blockerMatch} on protected branches unless a fresh branch:non-protected tag or a branch-protection-ack override exists in the ledger.`,
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
   - a \`${ACK_TAG_PREFIX}:<reason>\` override tag exists (any age).

## Escape hatches

- **Refresh after branching**: the producer is runnable on demand from
  the operator's \`!\` shell as \`${PRODUCER_COMMAND}\`. The agent's Bash
  is gated by the Understanding Gate but the producer command is itself
  a \`harness ...\` invocation that the gate's allowlist accepts.

- **Explicit override** (any age, lasts the session): write the ack tag
  via \`mcp__agent-grounding__ledger_add\` with
  \`content: "${ACK_TAG_PREFIX}:<reason>"\`. Use this when you have a
  deliberate reason to edit a protected branch — version bumps, CI
  workflow patches, etc. The override survives session restarts only as
  long as the ledger row does.

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
