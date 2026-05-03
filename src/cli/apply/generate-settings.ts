// Inverse of `src/cli/adopt/derive.ts#parseSettingsHooks`: turn the manifest's
// `hooks[]` into the nested Claude Code settings.json shape that `harness apply`
// writes to `harness.generated/settings.json`. Pure function, no I/O.
//
// Output shape (matches Claude Code's settings.json `hooks` section):
//
//   { hooks: { <EventName>: [ { matcher?, hooks: [{ type, command, timeout? }] } ] } }
//
// Field decisions for v1 (per ARCHITECTURE §5 + Phase 3 #2 task scope):
//   - `type: "command"` is always emitted explicitly. Claude Code accepts
//     missing `type` (it defaults to "command") but explicit is friendlier
//     to humans diffing the file.
//   - `matcher` is omitted when the manifest hook has no `match`. Hooks with
//     a match string emit a `matcher` field with that exact string. Regex
//     metacharacters are passed through unchanged.
//   - `timeout` is always emitted (the manifest's `budget_ms` is always set
//     after schema-defaulting). Always-emit is the conservative choice
//     against an unknown runtime default; an explicit value is consumed
//     identically whether or not the runtime would have defaulted to it.
//   - `path_match` and `bash_match` are NOT projected. Claude Code's
//     settings.json `matcher` filters only on the tool name, so there is
//     no native settings.json field for "additional filter when this hook
//     fires". Per the canonical example in ARCHITECTURE.md Appendix A
//     (e.g. `require-preflight-evidence` with `bash_match: "^git ..."`),
//     these filters are enforced inside the referenced hook script, not by
//     harness's wiring. The manifest fields are documentation: they tell
//     `harness validate`/`doctor` what the script claims to filter on, so
//     the script's behaviour can be cross-checked, but `harness apply`
//     does not synthesise wrapper shell to enforce them. Wrapping was
//     considered and rejected: it (a) doubles the surface for hook bugs,
//     (b) hard-codes shell semantics into the manifest projection, and
//     (c) the canonical hook scripts already enforce these filters.
//   - `blocking` is harness-internal: it tells `validate`/`doctor` how to
//     classify a hook for soft/hard-failure reporting. Claude Code's
//     settings.json has no documented equivalent (verified against the
//     ecosystem as of 2026-04 — revisit if a runtime field appears), so
//     it does NOT survive the projection.
//
// Stable-output rules (load-bearing for byte-equivalent regeneration on a
// no-op apply):
//   - Event keys sorted ascending by name (insertion order in the JSON
//     object reflects this; JSON.stringify preserves it).
//   - Within an event, groups sorted by (matcher, command).
//   - Within a group, the inner hooks[] preserves matcher-grouping order
//     and is sorted by command for the same reason.

import type { Hook, Manifest, McpServer } from "../../schema/index.js";

export const DEFAULT_BUDGET_MS = 30_000;

export interface SettingsHookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface SettingsHookGroup {
  matcher?: string;
  hooks: SettingsHookCommand[];
}

// Claude Code's settings.json `mcpServers` shape: command + args + env.
// The manifest's `tools.mcp[].command` is either a single shell string or
// a pre-split string[]; either way Claude Code wants `command` as the
// first token (the executable) and `args` as the rest.
export interface SettingsMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SettingsRoot {
  hooks: Record<string, SettingsHookGroup[]>;
  mcpServers?: Record<string, SettingsMcpServer>;
}

export interface GenerateSettingsResult {
  root: SettingsRoot;
  warnings: string[];
}

export function generateSettings(manifest: Manifest): SettingsRoot {
  return generateSettingsWithWarnings(manifest).root;
}

export function generateSettingsWithWarnings(manifest: Manifest): GenerateSettingsResult {
  const warnings: string[] = [];
  const byEvent = new Map<string, Hook[]>();
  for (const h of manifest.hooks) {
    const list = byEvent.get(h.event) ?? [];
    list.push(h);
    byEvent.set(h.event, list);
  }

  const out: SettingsRoot = { hooks: {} };
  const eventNames = [...byEvent.keys()].sort();

  for (const event of eventNames) {
    const hooks = byEvent.get(event) ?? [];
    out.hooks[event] = buildGroups(hooks);
  }

  const mcp = buildMcpServers(manifest.tools.mcp, warnings);
  if (Object.keys(mcp).length > 0) out.mcpServers = mcp;

  return { root: out, warnings };
}

// Translate manifest `tools.mcp[]` into Claude Code's `mcpServers` map.
// - `enabled: false` entries are dropped (matches ARCHITECTURE §3 and the
//   asset-locking surface in harness-lock.ts: disabled MCPs are removed
//   from runtime config).
// - String `command` is split on whitespace, informed by the splitting at
//   harness-lock.ts:259. Caveat: a string command with embedded spaces in
//   a path (e.g. `"node /opt/path with spaces.js"`) is mis-split into
//   individual tokens. The schema accepts both string and array forms;
//   users with embedded whitespace MUST use the array form to preserve
//   token boundaries.
// - Empty `args` and `env` are omitted to keep the JSON tight.
// - Server names are emitted in stable lexical order so two applies of
//   the same manifest produce byte-identical settings.json.
// - Warnings (not errors) for entries that survive schema but produce no
//   runnable command (defensive: schema's `min(1)` makes this nearly
//   impossible to hit, but a string of pure whitespace would).
export function buildMcpServers(
  entries: McpServer[],
  warnings: string[],
): Record<string, SettingsMcpServer> {
  const out: Record<string, SettingsMcpServer> = {};
  const enabled = entries.filter((e) => e.enabled !== false);
  const sorted = [...enabled].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const e of sorted) {
    const tokens = Array.isArray(e.command)
      ? e.command.filter((t) => t.length > 0)
      : e.command.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      warnings.push(`tools.mcp.${e.name}: empty command, skipping`);
      continue;
    }
    // tokens[0]! is safe — guarded by the length check above.
    const spec: SettingsMcpServer = { command: tokens[0]! };
    if (tokens.length > 1) spec.args = tokens.slice(1);
    if (e.env && Object.keys(e.env).length > 0) spec.env = { ...e.env };
    out[e.name] = spec;
  }
  return out;
}

function buildGroups(hooks: Hook[]): SettingsHookGroup[] {
  // Group by exact `match` value. Unmatched hooks share the empty-string
  // bucket and emit a group without a `matcher` field.
  const byMatcher = new Map<string, Hook[]>();
  for (const h of hooks) {
    const key = h.match ?? "";
    const list = byMatcher.get(key) ?? [];
    list.push(h);
    byMatcher.set(key, list);
  }

  const matcherKeys = [...byMatcher.keys()].sort();
  const groups: SettingsHookGroup[] = [];
  for (const key of matcherKeys) {
    const groupHooks = byMatcher.get(key) ?? [];
    const inner: SettingsHookCommand[] = [...groupHooks]
      .sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0))
      .map(toSettingsCommand);
    const group: SettingsHookGroup =
      key === "" ? { hooks: inner } : { matcher: key, hooks: inner };
    groups.push(group);
  }

  return groups;
}

function toSettingsCommand(h: Hook): SettingsHookCommand {
  return { type: "command", command: h.command, timeout: h.budget_ms };
}
