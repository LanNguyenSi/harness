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

export interface SettingsPermissions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface SettingsRoot {
  hooks: Record<string, SettingsHookGroup[]>;
  mcpServers?: Record<string, SettingsMcpServer>;
  permissions?: SettingsPermissions;
}

export interface GenerateSettingsResult {
  root: SettingsRoot;
  warnings: string[];
}

export interface GenerateSettingsExtras {
  /**
   * Phase 6 #5 — pack-contributed permissions emitted into the
   * settings.json `permissions` block. Empty buckets are dropped from
   * the output so a no-op contribution doesn't pollute the JSON.
   */
  packPermissions?: SettingsPermissions;
}

export function generateSettings(manifest: Manifest): SettingsRoot {
  return generateSettingsWithWarnings(manifest).root;
}

export function generateSettingsWithWarnings(
  manifest: Manifest,
  extras: GenerateSettingsExtras = {},
): GenerateSettingsResult {
  const warnings: string[] = [];
  const byEvent = new Map<string, Hook[]>();
  for (const h of manifest.hooks) {
    const list = byEvent.get(h.event) ?? [];
    list.push(h);
    byEvent.set(h.event, list);
  }

  // memory.router projects into a UserPromptSubmit hook so per-prompt
  // memory augmentation actually fires (PR #203, agent-tasks/eefbcaa8).
  // Pre-#203 the router was declared in the manifest, asset-locked by
  // harness-lock, restart-hinted on change, but never written into
  // settings.json — a silent install-time wiring gap that left
  // memory-router on PATH but inert in every Claude Code session.
  const routerHook = buildMemoryRouterHook(manifest);
  if (routerHook !== null) {
    const list = byEvent.get(routerHook.event) ?? [];
    list.push(routerHook);
    byEvent.set(routerHook.event, list);
  }

  const out: SettingsRoot = { hooks: {} };
  const eventNames = [...byEvent.keys()].sort();

  for (const event of eventNames) {
    const hooks = byEvent.get(event) ?? [];
    out.hooks[event] = buildGroups(hooks);
  }

  const mcp = buildMcpServers(manifest.tools.mcp, warnings);
  if (Object.keys(mcp).length > 0) out.mcpServers = mcp;

  const permissions = compactPermissions(extras.packPermissions);
  if (permissions) out.permissions = permissions;

  return { root: out, warnings };
}

function compactPermissions(p: SettingsPermissions | undefined): SettingsPermissions | null {
  if (!p) return null;
  const out: SettingsPermissions = {};
  if (p.allow && p.allow.length > 0) out.allow = [...p.allow].sort();
  if (p.ask && p.ask.length > 0) out.ask = [...p.ask].sort();
  if (p.deny && p.deny.length > 0) out.deny = [...p.deny].sort();
  return Object.keys(out).length > 0 ? out : null;
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
    if (e.env && Object.keys(e.env).length > 0) {
      // Warn on values that look like paths starting with a literal `~`.
      // Claude Code passes these to the MCP child verbatim; libraries that
      // do file-system lookups (better-sqlite3, fs.readFileSync, ...) then
      // open them as cwd-relative paths, NOT $HOME-relative. The bug
      // surfaced in agent-tasks/42d224a6 where `EVIDENCE_LEDGER_DB:
      // ~/.evidence-ledger/ledger.db` silently created rogue DBs scattered
      // across spawn cwds. We only warn (not error) because a literal
      // tilde could be intentional in a few exotic cases, but the
      // diagnostic surface tells the operator to switch to an absolute
      // path or drop the env so the bundled default fires.
      for (const [key, value] of Object.entries(e.env)) {
        if (typeof value === "string" && value.startsWith("~/")) {
          warnings.push(
            `tools.mcp.${e.name}.env.${key}: value "${value}" starts with a literal ~ ; child processes will treat this as cwd-relative, not $HOME-relative. Use an absolute path (e.g. "/home/you/...") or drop the env if the default suffices.`,
          );
        }
      }
      spec.env = { ...e.env };
    }
    out[e.name] = spec;
  }
  return out;
}

// Translate manifest `memory.router` into a synthetic UserPromptSubmit
// hook so per-prompt context augmentation actually fires alongside the
// understanding-gate hook. Returns null when memory.router is absent or
// `enabled: false`, in which case no entry lands in settings.json.
//
// Command joining: the schema accepts `command: string[]` (min 1). For
// the typical single-bin case `[memory-router-user-prompt-submit]` the
// projection emits exactly that; for multi-token commands the array is
// space-joined to produce a single shell-string that Claude Code can
// spawn (same convention `harness-lock.ts` uses when iterating the
// command tokens). Embedded whitespace inside a single token is a known
// limitation of this projection; operators with such paths should use
// the `tools.mcp[].command: string` form on a different surface, or
// avoid spaces in installed binary paths.
//
// Timeout: `memory.router` has no manifest-level budget_ms field, so we
// pick 5000ms to match the existing `understanding-gate-claude-hook`
// timeout. A per-prompt augmentation that visibly delays prompt-submit
// would be hostile UX; 5s is generous for the router's typical
// memory-file scan.
export function buildMemoryRouterHook(manifest: Manifest): Hook | null {
  const router = manifest.memory.router;
  if (!router) return null;
  if (router.enabled === false) return null;
  const tokens = router.command.filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const hook: Hook = {
    name: "memory:router",
    event: "UserPromptSubmit",
    command: tokens.join(" "),
    blocking: false,
    budget_ms: 5000,
  };
  // Forward min_version + version_command so `harness doctor` keeps
  // probing the router binary the same way it would for any other
  // hook with a declared floor. Both fields must be carried together
  // per HookSchema's invariant; carry neither when only one is set.
  if (router.min_version !== undefined && router.version_command !== undefined) {
    hook.min_version = router.min_version;
    hook.version_command = router.version_command;
  }
  return hook;
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
    // Multiple harness hooks frequently share the same command (the
    // generic `harness policy intercept` engine is the obvious case:
    // every PreToolUse policy in the full template wires to it). Claude
    // Code spawns each entry in `hooks[]` independently for the same
    // tool event, so emitting duplicates causes redundant Node bootstraps
    // and ledger queries per tool call. Dedupe by (command, timeout)
    // inside each matcher group so only one spawn happens per
    // logically-identical hook, regardless of how many manifest entries
    // map to it.
    const seen = new Set<string>();
    const inner: SettingsHookCommand[] = [];
    for (const h of [...groupHooks].sort((a, b) =>
      a.command < b.command ? -1 : a.command > b.command ? 1 : 0,
    )) {
      const cmd = toSettingsCommand(h);
      const fingerprint = `${cmd.command} ${cmd.timeout ?? ""}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      inner.push(cmd);
    }
    const group: SettingsHookGroup =
      key === "" ? { hooks: inner } : { matcher: key, hooks: inner };
    groups.push(group);
  }

  return groups;
}

function toSettingsCommand(h: Hook): SettingsHookCommand {
  return { type: "command", command: h.command, timeout: h.budget_ms };
}
