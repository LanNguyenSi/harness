import type { Manifest } from "../../schema/index.js";

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
}

export interface SettingsHookGroup {
  matcher?: string;
  hooks: { type?: string; command: string }[];
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
        out.push({
          event,
          command: h.command,
          ...(matcher !== undefined ? { match: matcher } : {}),
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
