// Phase 6 #6 — runtime target identifier threaded through policy-pack
// expansion. Selects which adapter shape a pack emits.
//
// `claude-code` (default): hook commands point at the harness PreToolUse
// blocker. Output of `harness apply` is the Claude Code `settings.json`
// shape under `harness.generated/settings.json`.
//
// `codex`: hook commands point at the Codex adapter commands the pack
// emits. Output of `harness apply` is a Codex-flavoured config artefact
// under `harness.generated/codex/`. The branch-protection pack is the only
// builtin; additional runtimes are out of v1 scope.
//
// `opencode`: unlike `codex`, this runtime does NOT get its own hook
// command shape from `expandPolicyPacks` (task f34eb233 / batch18) --
// opencode's config.json has no declarative hook/event field at all, so
// there is nothing for a pack to emit commands for. Output of `harness
// apply --runtime opencode` is `harness.generated/opencode/opencode.json`,
// which projects `tools.mcp[]` only. See
// `src/cli/apply/generate-opencode-config.ts`'s header for the full
// adapter-mapping ADR (mcp projected, hooks and permission deferred).

export const KNOWN_RUNTIMES = ["claude-code", "codex", "opencode"] as const;
export type Runtime = (typeof KNOWN_RUNTIMES)[number];
export const DEFAULT_RUNTIME: Runtime = "claude-code";

export function isRuntime(value: unknown): value is Runtime {
  return typeof value === "string" && (KNOWN_RUNTIMES as readonly string[]).includes(value);
}
