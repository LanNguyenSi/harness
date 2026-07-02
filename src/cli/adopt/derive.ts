import type { Manifest, McpServer } from "../../schema/index.js";
import {
  EVIDENCE_LEDGER_DB_ENV,
  GROUNDING_MCP_SERVER_NAME,
  groundingLedgerEnvValue,
} from "../apply/generate-settings.js";

const KNOWN_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
]);

export interface DerivedHook {
  event: string;
  command: string;
  match?: string;
  /**
   * settings.json hook `timeout`, captured verbatim (task 059b669c).
   * apply emits `timeout: budget_ms` 1:1 (generate-settings.ts,
   * toSettingsCommand), so carrying it back into `budget_ms` keeps the
   * adopt→apply round-trip drift-free by construction. Deliberately NOT
   * part of the drift key (`keyOf`): a timeout-only edit must not turn
   * into an add-only "new hook" adoption of a duplicate entry.
   */
  timeout?: number;
}

export interface SettingsHookGroup {
  matcher?: string;
  hooks: { type?: string; command: string; timeout?: number }[];
}

export interface SettingsRoot {
  hooks?: Record<string, SettingsHookGroup[]>;
}

/**
 * Flatten the nested ~/.claude/settings.json hooks tree into a list of
 * manifest-style hook records so we can diff it against the manifest.
 */
export function parseSettingsHooks(raw: unknown): DerivedHook[] {
  if (!isRecord(raw)) return [];
  const root = raw as SettingsRoot;
  if (!root.hooks || !isRecord(root.hooks)) return [];
  const out: DerivedHook[] = [];
  for (const [event, groups] of Object.entries(root.hooks)) {
    if (!KNOWN_EVENTS.has(event)) continue;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher =
        typeof group.matcher === "string" && group.matcher.length > 0
          ? group.matcher
          : undefined;
      const inner = (group as SettingsHookGroup).hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (!isRecord(h)) continue;
        if (typeof h.command !== "string" || h.command.length === 0) continue;
        // Capture only values the manifest schema would accept
        // (budget_ms: positive integer); anything else is ignored so a
        // malformed hand-edit cannot poison the proposed manifest.
        const timeout =
          typeof h.timeout === "number" && Number.isInteger(h.timeout) && h.timeout > 0
            ? h.timeout
            : undefined;
        out.push({
          event,
          command: h.command,
          ...(matcher !== undefined ? { match: matcher } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Project the manifest's hooks[] into the same flat shape so drift comparison
 * is symmetric.
 */
export function manifestProjection(manifest: Manifest): DerivedHook[] {
  return manifest.hooks.map((h) => {
    const out: DerivedHook = { event: h.event, command: h.command };
    if (h.match !== undefined) out.match = h.match;
    return out;
  });
}

/**
 * settings.json minus manifest, keyed on (event, command, match).
 * Returns hooks present in settings but not declared in the manifest.
 */
export function computeDrift(
  settingsHooks: DerivedHook[],
  manifestHooks: DerivedHook[],
): DerivedHook[] {
  const declared = new Set(manifestHooks.map(keyOf));
  return settingsHooks.filter((h) => !declared.has(keyOf(h)));
}

function keyOf(h: DerivedHook): string {
  return `${h.event}\x00${h.command}\x00${h.match ?? ""}`;
}

/**
 * Synthesize a manifest hook name from the derived entry.
 * Strategy: take the command's first token's basename without extension; if
 * that collides with an existing name, append -2, -3, etc. Falls back to
 * `adopted-hook` if the command has no recognisable basename.
 */
export function synthesizeName(
  d: DerivedHook,
  taken: Set<string>,
): string {
  const firstToken = d.command.trim().split(/\s+/)[0] ?? "";
  const last = firstToken.split("/").pop() ?? "";
  const stem = last.replace(/\.[^.]+$/, "");
  const base = stem.length > 0 ? stem : "adopted-hook";
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ---------------------------------------------------------------------------
// MCP servers — reverse projection of `buildMcpServers` in
// src/cli/apply/generate-settings.ts. settings.json's `mcpServers` map is
// flattened into a list of `{ name, command: string[], env? }`, which is the
// canonical shape used by `tools.mcp[]` (we always emit array-form on adopt;
// the apply side accepts both string and array forms).
// ---------------------------------------------------------------------------

export interface DerivedMcp {
  name: string;
  command: string[];
  env?: Record<string, string>;
}

export interface SettingsMcpSpec {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

export interface SettingsRootWithMcp extends SettingsRoot {
  mcpServers?: Record<string, SettingsMcpSpec>;
}

export function parseSettingsMcpServers(raw: unknown): DerivedMcp[] {
  if (!isRecord(raw)) return [];
  const root = raw as SettingsRootWithMcp;
  if (!isRecord(root.mcpServers)) return [];
  const out: DerivedMcp[] = [];
  for (const [name, specRaw] of Object.entries(root.mcpServers)) {
    if (!isRecord(specRaw)) continue;
    const spec = specRaw as SettingsMcpSpec;
    if (typeof spec.command !== "string" || spec.command.length === 0) continue;
    const args = Array.isArray(spec.args)
      ? spec.args.filter((a): a is string => typeof a === "string")
      : [];
    const command = [spec.command, ...args];
    const entry: DerivedMcp = { name, command };
    if (isRecord(spec.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.env)) {
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }
    out.push(entry);
  }
  return out;
}

export function manifestMcpProjection(
  manifest: Manifest,
  homeDir?: string,
): DerivedMcp[] {
  const out = manifest.tools.mcp.map(toDerivedMcp);
  // Mirror apply's grounding projection (generate-settings.ts,
  // projectGroundingEnv): apply synthesizes EVIDENCE_LEDGER_DB onto the
  // enabled grounding-mcp entry, so the manifest-side projection must
  // carry the same key — otherwise every adopt after an apply reports
  // phantom "modified" drift on grounding-mcp and, if applied, bakes the
  // machine-specific absolute path into the shared manifest (task
  // 129e1b94 review, MED finding).
  const groundingManifestEntry = manifest.tools.mcp.find(
    (m) => m.name === GROUNDING_MCP_SERVER_NAME,
  );
  const grounding = out.find((m) => m.name === GROUNDING_MCP_SERVER_NAME);
  if (
    grounding !== undefined &&
    groundingManifestEntry?.enabled !== false &&
    !grounding.env?.[EVIDENCE_LEDGER_DB_ENV]
  ) {
    grounding.env = {
      ...(grounding.env ?? {}),
      [EVIDENCE_LEDGER_DB_ENV]: groundingLedgerEnvValue(manifest, homeDir),
    };
  }
  return out;
}

function toDerivedMcp(m: McpServer): DerivedMcp {
  const command = Array.isArray(m.command)
    ? [...m.command]
    : m.command
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
  const out: DerivedMcp = { name: m.name, command };
  if (m.env && Object.keys(m.env).length > 0) out.env = { ...m.env };
  return out;
}

export type McpDriftReason = "new" | "modified";

export interface McpDriftEntry {
  entry: DerivedMcp;
  reason: McpDriftReason;
}

export function computeMcpDrift(
  settingsMcp: DerivedMcp[],
  manifestMcp: DerivedMcp[],
): McpDriftEntry[] {
  const byName = new Map(manifestMcp.map((m) => [m.name, m]));
  const out: McpDriftEntry[] = [];
  for (const s of settingsMcp) {
    const existing = byName.get(s.name);
    if (!existing) {
      out.push({ entry: s, reason: "new" });
      continue;
    }
    if (mcpEqual(existing, s)) continue;
    out.push({ entry: s, reason: "modified" });
  }
  return out;
}

export { mcpEqual };

function mcpEqual(a: DerivedMcp, b: DerivedMcp): boolean {
  if (a.command.length !== b.command.length) return false;
  for (let i = 0; i < a.command.length; i++) {
    if (a.command[i] !== b.command[i]) return false;
  }
  const aEnv = a.env ?? {};
  const bEnv = b.env ?? {};
  const ak = Object.keys(aEnv).sort();
  const bk = Object.keys(bEnv).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const ka = ak[i]!;
    const kb = bk[i]!;
    if (ka !== kb) return false;
    if (aEnv[ka] !== bEnv[kb]) return false;
  }
  return true;
}
