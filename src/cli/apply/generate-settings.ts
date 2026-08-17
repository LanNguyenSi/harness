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
//     UNIT: Claude Code's settings.json `timeout` is documented in SECONDS,
//     not milliseconds like the manifest's `budget_ms`; see
//     `hookTimeoutSeconds` below for the conversion and its history.
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
import { expandHome } from "../../io/expand-home.js";

export const DEFAULT_BUDGET_MS = 30_000;

/** The manifest `tools.mcp[]` entry name that grounding enforcement keys off. */
export const GROUNDING_MCP_SERVER_NAME = "grounding-mcp";
/** The env var grounding-mcp's ledger-bridge reads for the evidence-ledger DB path. */
export const EVIDENCE_LEDGER_DB_ENV = "EVIDENCE_LEDGER_DB";

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
  permissions?: SettingsPermissions;
}

export interface GenerateSettingsResult {
  root: SettingsRoot;
  warnings: string[];
  /**
   * The manifest's `tools.mcp[]` entries translated into Claude Code's
   * server-spec shape (command/args/env), INCLUDING the grounding-mcp
   * `EVIDENCE_LEDGER_DB` projection (`projectGroundingEnv`). Deliberately
   * NOT part of `root` and never serialized into settings.json (task
   * init-mcp-wiring-claude-code/T-002): Claude Code does not read the
   * settings.json `mcpServers` block at runtime — see
   * `src/io/claude-mcp.ts`'s module header. User-scope MCP registration
   * goes exclusively through the `claude mcp` CLI now
   * (`ensureMcpServers`); this field is what feeds that path. The init
   * wizard (`src/cli/init/interactive.ts`) reads it directly instead of
   * reading it back out of a written settings.json.
   */
  mcpServers: Record<string, SettingsMcpServer>;
}

export interface GenerateSettingsExtras {
  /**
   * Phase 6 #5 — pack-contributed permissions emitted into the
   * settings.json `permissions` block. Empty buckets are dropped from
   * the output so a no-op contribution doesn't pollute the JSON.
   */
  packPermissions?: SettingsPermissions;
  /**
   * Home directory used to expand `~/` in projected values (the
   * grounding evidence-ledger path). Defaults to `os.homedir()`;
   * injected by tests for determinism.
   */
  homeDir?: string;
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

  // buildMcpServers/projectGroundingEnv still run here (not moved) so the
  // env-tilde and empty-command warnings stay attached to the same
  // `warnings` array regardless of which path (settings.json hooks vs.
  // the claude-mcp Ensure path) consumes the resulting spec map. The
  // result is intentionally NOT projected into `out` — see
  // GenerateSettingsResult.mcpServers.
  const mcp = buildMcpServers(manifest.tools.mcp, warnings);
  projectGroundingEnv(manifest, mcp, extras.homeDir);

  const permissions = compactPermissions(extras.packPermissions);
  if (permissions) out.permissions = permissions;

  return { root: out, warnings, mcpServers: mcp };
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

/**
 * Wire the manifest's `grounding:` section into the grounding-mcp server
 * entry (task 129e1b94, harness-review-2026-07-01/grounding-decorative).
 *
 * `grounding.evidence_ledger.path` becomes the `EVIDENCE_LEDGER_DB` env on
 * the `tools.mcp[grounding-mcp]` entry — the exact variable grounding-mcp's
 * ledger-bridge reads (agent-grounding
 * packages/grounding-mcp/src/ledger-bridge.ts). This makes `grounding:` the
 * section that CONFIGURES the grounding-mcp entry instead of a decorative
 * namesake, resolving the naming collision the 2026-07-01 review flagged.
 *
 * Rules:
 * - Projection only fires when a grounding-mcp entry exists; without one
 *   there is no consumer (doctor surfaces that inertness separately).
 * - An operator-declared `env.EVIDENCE_LEDGER_DB` on the entry wins — an
 *   explicit override is never clobbered (doctor warns when it diverges
 *   from `grounding.evidence_ledger.path`).
 * - The projected value is `~`-expanded to an absolute path, so the
 *   literal-tilde child-process footgun (agent-tasks/42d224a6, the very
 *   warning above in buildMcpServers) cannot re-enter via this path.
 * - `retention_days`, `policies_source`, and `session.*` stay RESERVED:
 *   nothing consumes them yet (evidence-ledger has no retention pruning),
 *   and projecting an env no server reads would be decorative again. See
 *   the status comments in src/schema/grounding.ts.
 */
export function projectGroundingEnv(
  manifest: Manifest,
  mcp: Record<string, SettingsMcpServer>,
  homeDir?: string,
): void {
  const server = mcp[GROUNDING_MCP_SERVER_NAME];
  if (!server) return;
  const env = server.env ?? {};
  // Truthiness (not `=== undefined`) on purpose: an empty-string operator
  // "override" would project an empty ledger path, which guarantees a
  // broken ledger — treat it as absent and let the manifest value apply.
  if (!env[EVIDENCE_LEDGER_DB_ENV]) {
    env[EVIDENCE_LEDGER_DB_ENV] = groundingLedgerEnvValue(manifest, homeDir);
    server.env = env;
  }
}

/**
 * The value apply projects for `EVIDENCE_LEDGER_DB`: the manifest's
 * `grounding.evidence_ledger.path`, `~`-expanded to an absolute path.
 * Shared with adopt's manifest→settings projection so the apply→adopt
 * round-trip stays drift-free by construction.
 */
export function groundingLedgerEnvValue(
  manifest: Manifest,
  homeDir?: string,
): string {
  return expandHome(manifest.grounding.evidence_ledger.path, homeDir);
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

/**
 * Convert the manifest's `budget_ms` (milliseconds) into the seconds unit
 * both runtime projections' `timeout` field expects.
 *
 * Claude Code's settings.json hook `timeout` is documented in seconds
 * ("Seconds before canceling", https://code.claude.com/docs/en/hooks), NOT
 * milliseconds like the manifest's `budget_ms`. Before this helper existed,
 * `toSettingsCommand` emitted `h.budget_ms` unconverted, so every Claude
 * hook kill-timer was 1000x too large (a 1000-2000ms template budget became
 * a 1000-2000 SECOND, 16-33 minute, Claude Code timeout). Codex's
 * projection (generate-codex-config.ts) already converted correctly; this
 * helper is the single source of truth both projections now share so they
 * cannot diverge again.
 *
 * `Math.ceil` never rounds a budget down to 0s. The floor (2s for `harness
 * policy intercept`, 1s otherwise) matches Codex's existing floor rationale
 * (generate-codex-config.ts): the policy-intercept engine's own ledger
 * round-trip regularly needs slightly longer than a bare 1s floor would
 * allow.
 */
export function hookTimeoutSeconds(h: Hook): number {
  const minimumSeconds = h.command.trim() === "harness policy intercept" ? 2 : 1;
  return Math.max(minimumSeconds, Math.ceil(h.budget_ms / 1000));
}

function toSettingsCommand(h: Hook): SettingsHookCommand {
  return { type: "command", command: h.command, timeout: hookTimeoutSeconds(h) };
}
