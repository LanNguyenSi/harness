// Settings-drift half of ADR docs/decisions/2026-08-27-ug-auto-mode-approval.md
// slice 1 (agent-tasks 74b4b17d), threat model (c): "The permission mode
// itself is settings-derived, and settings files are agent-editable
// after approval" and "The same settings write also reaches the hook
// roster, which supplies key two." A post-approval agent can plant
// `permissions.defaultMode: "bypassPermissions"` (key one) and/or a
// `UserPromptSubmit`/`SessionStart` hook entry that mints a report for
// every later session (key two) into a Claude Code settings file, and
// nothing named that plant before this check: `harness diff
// --since-apply` only re-hashes the whole `--target` file as a lock
// entry, so it flags SOME change without naming which key moved.
//
// What this module actually has to compare against, verified against
// the real `apply()` code path (not assumed from the ADR prose):
//
//   - `.last-apply` (`src/io/last-apply.ts`) stores exactly ONE
//     `files["settings.json"]` entry: harness's own GENERATED
//     settings.json content (`buildExpectedFiles` in apply.ts), keyed by
//     basename, not by which `--target` path it was merged into. Harness
//     never writes `permissions.defaultMode` itself
//     (`generate-settings.ts` has no such key), and `--merge` replaces
//     `hooks` WHOLESALE (`src/io/merge-settings.ts`'s module header: "harness
//     owns whichever top-level keys appear in the generated output...
//     hooks stays wholesale-owned"). So this one snapshot is, for every
//     settings file harness has ever targeted, an accurate "what harness
//     itself put there at apply time" baseline: defaultMode absent
//     (harness never owns it) and hooks exactly the generated roster (no
//     operator hand-added hook entry survives a `--merge`).
//   - `harness.lock` (`src/io/harness-lock.ts`) records which absolute
//     path(s) were an actual `--target` write, as a `kind: "target"`
//     entry. This is how a live settings file is told apart from one
//     harness has never touched: matching against this lock entry is
//     the "SAME path" mapping the file was written under.
//
// A file whose absolute path has no `target` lock entry never received
// harness's baseline at all, so it gets the EMPTY baseline (everything
// in it reads as "absent at last apply") rather than the shared
// generated-settings.json baseline.
//
// Warnings only, never a block; this is the compensating control named
// in the ADR, not an enforcement (the enforcing lever is the managed
// setting in operator decision 7).

import * as fs from "node:fs";
import * as path from "node:path";
import { readLastApply } from "../../io/last-apply.js";
import { readLock, type TargetEntry } from "../../io/harness-lock.js";
import { safeJsonParse } from "../../io/safe-json-parse.js";
import { resolveSettingsPath as resolveUserSettingsPath } from "./claude-mcp.js";

export interface SettingsDriftSection {
  /** ℹ lines; never roll into warningCount. */
  notes: string[];
  /** ⚠ lines; each rolls into warningCount. */
  warnings: string[];
}

interface SettingsCandidate {
  absolutePath: string;
  /** How the file is named in a warning/note line — never an absolute machine path. */
  displayLabel: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface HookIdentity {
  event: string;
  /** `""` when the group carries no string matcher (rendered as `*`). */
  matcher: string;
  type: string;
  command: string;
}

function hookIdentityKey(h: HookIdentity): string {
  return JSON.stringify([h.event, h.matcher, h.type, h.command]);
}

/**
 * Enumerate every `hooks[event][].hooks[]` entry in a parsed settings
 * object as an identity tuple. Mirrors the group-parsing convention
 * `collectOwnedHookGroups`/`classifyHookGroup` use in
 * `src/cli/uninstall/index.ts` for the same on-disk shape. Malformed
 * groups/entries are skipped rather than throwing — a live settings.json
 * this check does not own may carry shapes this parser has no opinion
 * about.
 */
function collectHookIdentities(hooksValue: unknown): HookIdentity[] {
  const out: HookIdentity[] = [];
  if (!isRecord(hooksValue)) return out;
  for (const event of Object.keys(hooksValue)) {
    const groups = hooksValue[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group["matcher"] === "string" ? (group["matcher"] as string) : "";
      const inner = group["hooks"];
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (!isRecord(h)) continue;
        const type = typeof h["type"] === "string" ? (h["type"] as string) : "";
        const command = typeof h["command"] === "string" ? (h["command"] as string) : "";
        out.push({ event, matcher, type, command });
      }
    }
  }
  return out;
}

function defaultModeOf(settings: Record<string, unknown>): string | undefined {
  const permissions = settings["permissions"];
  if (!isRecord(permissions)) return undefined;
  const mode = permissions["defaultMode"];
  return typeof mode === "string" ? mode : undefined;
}

function checkOneFile(
  file: SettingsCandidate,
  baseline: Record<string, unknown>,
  targetAbsPaths: ReadonlySet<string>,
  warnings: string[],
): void {
  // Plain read, no readRegularFileRejectingSymlink: this is a live
  // Claude Code settings file (project or user scope), not one of
  // harness's own generated artefacts, and doctor's existing reader for
  // this exact file class (`findDeadSettingsMcpNames` in claude-mcp.ts)
  // already reads it the same way — a missing file resolves to "nothing
  // to report" here too, not a symlink-defense case.
  let raw: string;
  try {
    raw = fs.readFileSync(file.absolutePath, "utf8");
  } catch {
    return;
  }
  const parsed = safeJsonParse(raw);
  if (!isRecord(parsed)) {
    warnings.push(`${file.displayLabel}: unreadable settings JSON`);
    return;
  }
  const live = parsed;

  const hasSnapshot = targetAbsPaths.has(path.resolve(file.absolutePath));
  const effectiveBaseline = hasSnapshot ? baseline : {};
  const suffix = hasSnapshot ? "" : " (no apply snapshot for this file)";

  const liveMode = defaultModeOf(live);
  const baselineMode = defaultModeOf(effectiveBaseline);
  if (liveMode !== undefined && liveMode !== baselineMode) {
    if (baselineMode === undefined) {
      warnings.push(
        `permissions.defaultMode set in ${file.displayLabel} but absent at last apply: ${liveMode}${suffix}`,
      );
    } else {
      warnings.push(
        `permissions.defaultMode set in ${file.displayLabel} changed from ${baselineMode} to ${liveMode}${suffix}`,
      );
    }
  }

  const liveHooks = collectHookIdentities(live["hooks"]);
  const baselineHookKeys = new Set(collectHookIdentities(effectiveBaseline["hooks"]).map(hookIdentityKey));
  for (const h of liveHooks) {
    if (baselineHookKeys.has(hookIdentityKey(h))) continue;
    warnings.push(
      `hook entries in ${file.displayLabel} absent at last apply: ${h.event}/${h.matcher || "*"}${suffix}`,
    );
  }
}

/** `~`-relativize `absPath` under `home` for display; never leak the raw absolute path. */
function tildeize(absPath: string, home: string): string {
  const resolvedHome = path.resolve(home);
  const resolvedPath = path.resolve(absPath);
  if (resolvedPath === resolvedHome) return "~";
  const withSep = resolvedHome.endsWith(path.sep) ? resolvedHome : `${resolvedHome}${path.sep}`;
  if (resolvedPath.startsWith(withSep)) {
    return path.join("~", resolvedPath.slice(withSep.length));
  }
  return absPath;
}

export interface BuildSettingsDriftOptions {
  /** `harness.generated/` for the manifest in use; `.last-apply` lives here. */
  generatedDir: string;
  /** `harness.lock` path for the manifest in use. */
  lockPath: string;
  /** Resolves the two project-scoped candidate files (`.claude/settings.json`, `.claude/settings.local.json`). */
  cwd: string;
  /** Operator home; resolves the user-scope candidate file and its display label. */
  home: string;
  /** Env for `CLAUDE_CONFIG_DIR` resolution of the user-scope file. */
  env: NodeJS.ProcessEnv;
}

export function buildSettingsDrift(opts: BuildSettingsDriftOptions): SettingsDriftSection {
  const notes: string[] = [];
  const warnings: string[] = [];

  const lastApply = readLastApply(opts.generatedDir);
  if (lastApply === null) {
    notes.push("no apply snapshot; settings drift not checked");
    return { notes, warnings };
  }

  const baselineRaw = lastApply.files["settings.json"]?.content;
  let baseline: Record<string, unknown> = {};
  if (baselineRaw !== undefined) {
    const parsed = safeJsonParse(baselineRaw);
    if (isRecord(parsed)) baseline = parsed;
  }

  const lockEntries = readLock(opts.lockPath) ?? [];
  const targetAbsPaths = new Set(
    lockEntries
      .filter((e): e is TargetEntry => e.kind === "target")
      .map((e) => path.resolve(e.path)),
  );

  const userSettingsPath = resolveUserSettingsPath(opts.home, opts.env);
  const candidates: SettingsCandidate[] = [
    {
      absolutePath: path.resolve(opts.cwd, ".claude", "settings.json"),
      displayLabel: ".claude/settings.json",
    },
    {
      absolutePath: path.resolve(opts.cwd, ".claude", "settings.local.json"),
      displayLabel: ".claude/settings.local.json",
    },
    {
      absolutePath: path.resolve(userSettingsPath),
      displayLabel: tildeize(userSettingsPath, opts.home),
    },
  ];

  for (const c of candidates) {
    checkOneFile(c, baseline, targetAbsPaths, warnings);
  }

  return { notes, warnings };
}
