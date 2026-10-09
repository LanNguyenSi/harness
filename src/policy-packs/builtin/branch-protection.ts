// Builtin Policy Pack: `branch-protection`.
//
// Blocks Write/Edit (and the codex `apply_patch` equivalent) when the
// target lives in a repository whose checked-out branch is protected
// (default: master, main, develop), at the FIRST source mutation.
//
// Mechanics (task a4d8adc5): one PreToolUse blocker, `harness pack hook
// branch-protection`. For each directory the tool call writes into it asks
// git for the branch (`git -C <dir> symbolic-ref -q HEAD`, see
// src/runtime/git-branch.ts) and refuses when git names a protected branch
// or cannot answer. A directory with no `.git` entry above it is outside
// every repository and allowed without spawning git; a detached HEAD is
// allowed. There is no producer, ledger tag or override marker: the escape
// for the agent is `git checkout -b <feature>`, and the operator disables
// the gate from an un-hooked shell (`harness gate disable`).
//
// Enabled per-installation via `harness pack add branch-protection`.
// The `solo`, `team` and `full` init templates wire it with
// `enabled: true` (src/cli/init/profiles.ts, src/cli/init/templates.ts);
// `minimal` does not.

import { z } from "zod";
import { PolicyUxSchema } from "../../schema/policies.js";
import type { Hook, PolicyPack, PolicyUx } from "../../schema/index.js";
import { DEFAULT_RUNTIME, type Runtime } from "../runtime.js";
import type { PackContribution, PackContributionFile } from "../types.js";
import {
  DEFAULT_PROTECTED_BRANCHES,
  PACK_NAME,
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
    run: ["git checkout -b feat/<your-task>"],
  };
}

const HOOK_NAME_PREFIX = `policy-pack:${PACK_NAME}`;

const PRE_TOOL_USE_MATCH_CLAUDE = "Write|Edit";
const PRE_TOOL_USE_MATCH_CODEX = "apply_patch";

const BLOCKER_COMMAND = "harness pack hook branch-protection";
// Codex reads a PreToolUse block as exit 2 with the reason on stderr, not as
// the JSON envelope Claude Code reads, so the Codex command names its runtime
// and the hook answers in that runtime's contract.
const BLOCKER_COMMAND_CODEX = `${BLOCKER_COMMAND} --runtime codex`;

function buildHooks(runtime: Runtime): Hook[] {
  const isCodex = runtime === "codex";
  const blockerMatch = isCodex ? PRE_TOOL_USE_MATCH_CODEX : PRE_TOOL_USE_MATCH_CLAUDE;
  return [
    {
      name: `${HOOK_NAME_PREFIX}:pre-tool-use`,
      event: "PreToolUse",
      match: blockerMatch,
      command: isCodex ? BLOCKER_COMMAND_CODEX : BLOCKER_COMMAND,
      blocking: "hard",
      // 5000 (task a4d8adc5): the hook's slow parts are node start-up, the
      // manifest load and the git reads, and the hook bounds the git reads
      // itself (2000 ms per call, 3000 ms from the hook's start for all
      // target directories, src/cli/pack/hook-branch-protection.ts), so it answers
      // well inside this budget. A hook the runtime kills at its budget is
      // read as an allow, which is why the hook's own bound sits below it.
      budget_ms: 5000,
      description: `Blocker: deny ${blockerMatch} when git names a protected branch for a target directory, or cannot answer.`,
    },
  ];
}

function buildInstructions(pack: PolicyPack, branches: readonly string[], runtime: Runtime): string {
  const description = pack.description?.trim() ?? "";
  const isCodex = runtime === "codex";
  const isOpencode = runtime === "opencode";
  const blockerMatch = isCodex ? PRE_TOOL_USE_MATCH_CODEX : PRE_TOOL_USE_MATCH_CLAUDE;
  const settingsArtefact = isCodex
    ? "`harness.generated/codex/config.toml`"
    : "harness-managed `settings.json`";
  // Task f34eb233 (a review fix): before this, opencode
  // fell through to the claude-code `else` branch above and the
  // "## Effect" text below claimed hooks were wired into
  // `settings.json` even though opencode has no declarative hook/event
  // field and `harness apply --runtime opencode` never projects
  // `hooks[]` into the generated opencode artefact (see runtime.ts's
  // header). Carries the "## Runtime" UNSUPPORTED marker.
  const runtimeUnsupportedNote = isOpencode
    ? " (UNSUPPORTED — opencode has no declarative hook/event wiring; this pack's hooks are not projected into any opencode artefact)"
    : "";
  const wiringSentence = isOpencode
    ? "This pack's hooks are **not wired** under `--runtime opencode`: opencode has no declarative hook/event field (only a JS/TS plugin API), and `harness apply --runtime opencode` never projects `hooks[]` into the generated opencode artefact. The mechanics below describe the Claude Code / Codex behavior this pack implements; none of it fires today under opencode."
    : `While this pack is enabled, hooks are wired into the ${settingsArtefact}:`;
  return `# Policy Pack: ${PACK_NAME}

> Operator audit copy. This pack blocks source-mutating tool calls when
> the target lives in a repository checked out on a protected branch,
> closing the loop on the "edit-on-master" incident pattern.

## Runtime

${runtime}${runtimeUnsupportedNote}

## Protected branches

${branches.map((b) => `- \`${b}\``).join("\n")}

Set \`config.protected_branches\` in your manifest to override. Names are
compared case-insensitively.

## Effect

${wiringSentence}

\`PreToolUse\` blocker (\`${isCodex ? BLOCKER_COMMAND_CODEX : BLOCKER_COMMAND}\`, blocking: hard) on
\`${blockerMatch}\`. For each directory the tool call writes into (the
nearest existing directory of the target path, the paths named by an
\`apply_patch\` body, or the session cwd for other tools) it asks git:
\`git -C <dir> symbolic-ref -q HEAD\`, with every \`GIT_*\` variable removed
from git's environment and a 2000 ms bound per call. Three outcomes:

1. git names a protected branch: the call is refused; the agent is told to
   branch off (\`git checkout -b <feature>\`).
2. git could not answer (an error, a timeout, git missing, an unexpected
   answer): the call is refused, naming git's first stderr line.
3. No \`.git\` entry above the directory (outside every repository) or a
   detached HEAD: the call is allowed.

${isCodex ? "Codex contract: a refusal exits 2 with the reason on stderr." : "Claude Code contract: a refusal is a JSON deny envelope on stdout (exit 0)."}
A manifest that cannot be loaded refuses every call.

## Escape hatches

- **Branch off**: \`git checkout -b <feature>\` and retry; the next call
  is judged against the new branch.
- **Operator only**: ${isCodex ? "set \`enabled: false\` on this pack and re-run \`harness apply --runtime codex --install\` from an un-hooked shell (\`harness gate disable\` edits the Claude Code settings only)." : "disable the gate from an un-hooked shell with \`harness gate disable\` (without \`--matcher\` it only lists the hook groups; \`harness gate enable\` restores them), or set \`enabled: false\` on this pack and re-run \`harness apply\`."}

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
