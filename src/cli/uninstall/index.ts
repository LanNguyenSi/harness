// `harness uninstall` — clean teardown of a harness installation.
//
// Inventories what harness planted in `~/.claude/` (manifest, lock,
// generated tree, hook groups in settings.json, mcpServers entries it
// owns, and any settings.json.pre-harness-<TS> backups left by the
// operator's manual rollback recipe) and, with `--apply`, removes them.
//
// Reversibility (mirrors `gate disable`):
//   - Pre-mutation `settings.json` is backed up to
//     `settings.json.bak.uninstall.<ISO>`.
//   - A snapshot of removed hook groups + mcpServers entries lands at
//     `harness.uninstall.<ISO>.json` next to settings.json.
//   - Settings.json is mutated atomically AFTER backup + snapshot are
//     written, so a crash mid-write leaves the operator with both an
//     intact settings.json and a complete record of what was about to be
//     removed.
//
// `--restore-from <path>` is the escape hatch when the operator has a
// `settings.json.pre-harness-<TS>` backup from when they first installed
// harness: instead of selective key removal, atomically copy that
// backup over the live file. Still writes the standard `.bak.uninstall.*`
// + snapshot so the restore is itself reversible.
//
// Out of scope (v1):
//   - Foreign hook groups (anything whose commands don't start with the
//     harness binary) are left alone — uninstall is conservative.
//   - Project-local `~/.claude.json` is read-only (we surface a warning
//     when `mcpServers.grounding-mcp` is registered there since the user
//     will want to clean it up too, but we don't touch it).
//   - `npm uninstall -g @lannguyensi/harness` is the operator's call —
//     uninstall prints a hint but doesn't shell out.
//
// Ownership heuristics:
//   - Hook group: every inner hook's `command` must begin with
//     `harness ` or be `npx @lannguyensi/harness ...`. Mixed groups (some
//     harness, some foreign) are left in place with a warning so we
//     never split an operator-authored group on a guess.
//   - MCP server: union of the manifest's `tools.mcp[].name` (when the
//     manifest is readable) and the canonical default `grounding-mcp`.
//     This makes uninstall correct on manifests that renamed the server
//     while still cleaning the default install path when the manifest is
//     gone or unreadable.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { GENERATED_DIRNAME } from "../../io/generated-dir.js";
import {
  backupPath,
  type RemovedHookGroup,
  type RemovedMcpServer,
  sha256Hex,
  SNAPSHOT_VERSION,
  snapshotPath,
  type UninstallSnapshot,
} from "./snapshot.js";

const MANIFEST_BASENAME = "harness.yaml";
const LOCK_BASENAME = "harness.lock";
const SETTINGS_BASENAME = "settings.json";
const PRE_HARNESS_BACKUP_PREFIX = "settings.json.pre-harness-";
/**
 * MCP servers harness wires by default across its bundled templates
 * (see `src/cli/init/templates.ts` + `src/cli/init/composer.ts`). Used
 * as the fallback ownership set when the manifest has been deleted
 * out-of-band and we can't enumerate `tools.mcp[].name`. Widening this
 * list catches the same entries the templates planted; narrowing it
 * would leave them stranded after manifest-less uninstall.
 */
const DEFAULT_OWNED_MCP_SERVERS = [
  "agent-tasks",
  "codebase-oracle",
  "grounding-mcp",
] as const;
/**
 * Prefixes a hook command must start with for the group to count as
 * harness-owned. The bundled templates only ever emit `harness ...`
 * plain commands (resolved via PATH); operators who hand-wired hooks
 * with an absolute path to `dist/cli/main.js` or a non-PATH binary
 * will NOT be matched here and must clean those groups themselves.
 */
const HARNESS_COMMAND_PREFIXES = ["harness ", "npx @lannguyensi/harness "] as const;

export class UninstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UninstallError";
  }
}

export interface UninstallOptions {
  /** Override for `~/.claude/`. Falls back to `os.homedir()/.claude`. */
  homeDir?: string;
  /** Override settings.json path (test injection / non-default install). */
  settingsPath?: string;
  /** Mutate when true; pure listing otherwise. */
  apply?: boolean;
  /**
   * Atomic restore from a specific backup (typically a
   * `settings.json.pre-harness-<TS>` file). Implies `apply`; mutually
   * exclusive with the standard selective-removal flow.
   */
  restoreFrom?: string;
  /** Override "now" for deterministic timestamps in tests. */
  now?: Date;
}

export interface HookGroupRef {
  event: string;
  index: number;
  matcher: string | null;
  /** Short summary of the inner `hooks[].command` list for the listing UI. */
  description: string;
}

export interface UninstallInventory {
  /** Resolved `~/.claude/` (or override). */
  homeDir: string;
  /** Resolved settings.json path (or override). */
  settingsPath: string;
  /** `~/.claude/harness.yaml` when present, else null. */
  manifestPath: string | null;
  /** `~/.claude/harness.lock` when present, else null. */
  lockPath: string | null;
  /** `~/.claude/harness.generated/` when present, else null. */
  generatedDir: string | null;
  /** Harness-owned hook groups currently in settings.json. */
  hookGroups: HookGroupRef[];
  /** Harness-owned mcpServers keys currently in settings.json. */
  mcpServers: string[];
  /** Discovered `settings.json.pre-harness-*` backups in the settings directory. */
  preHarnessBackups: string[];
  /** Soft notices (e.g. project-local `~/.claude.json` registers grounding-mcp). */
  warnings: string[];
}

export type UninstallResult =
  | {
      mode: "list";
      inventory: UninstallInventory;
    }
  | {
      mode: "apply";
      inventory: UninstallInventory;
      /** Backup path (null when settings.json had nothing to remove). */
      backupPath: string | null;
      /** Snapshot path (null when no settings.json mutation was needed). */
      snapshotPath: string | null;
      /** Filesystem entries removed from disk (manifest, lock, generated dir). */
      removedFiles: string[];
    }
  | {
      mode: "restore";
      inventory: UninstallInventory;
      restoredFrom: string;
      backupPath: string;
      snapshotPath: string;
      /** Filesystem entries removed from disk (manifest, lock, generated dir). */
      removedFiles: string[];
    };

function resolveHomeDir(opts: UninstallOptions): string {
  return opts.homeDir ?? path.join(os.homedir(), ".claude");
}

function resolveSettingsPath(opts: UninstallOptions, homeDir: string): string {
  if (typeof opts.settingsPath === "string" && opts.settingsPath.length > 0) {
    return opts.settingsPath;
  }
  return path.join(homeDir, SETTINGS_BASENAME);
}

interface ParsedSettings {
  raw: string;
  obj: Record<string, unknown>;
  hooks: Record<string, unknown[]> | null;
  mcpServers: Record<string, unknown> | null;
}

/**
 * Read + parse settings.json. Refuses to operate on malformed shapes
 * (precedent: `gate/disable.ts`) so a broken file is surfaced rather
 * than silently overwritten with "something cleaner". Returns null when
 * the file simply doesn't exist (nothing to clean up; not an error).
 */
function readSettings(settingsPath: string): ParsedSettings | null {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UninstallError(
      `cannot read ${settingsPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UninstallError(
      `${settingsPath} is not valid JSON (${(err as Error).message}); refusing to operate. ` +
        `Fix the file by hand or restore from a backup before re-running.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UninstallError(`${settingsPath} is not a JSON object; refusing to operate.`);
  }
  const obj = parsed as Record<string, unknown>;

  let hooks: Record<string, unknown[]> | null = null;
  const rawHooks = obj["hooks"];
  if (rawHooks !== undefined) {
    if (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
      throw new UninstallError(
        `${settingsPath} \`hooks\` field is not an object; refusing to operate.`,
      );
    }
    const out: Record<string, unknown[]> = {};
    for (const [event, groups] of Object.entries(rawHooks)) {
      if (!Array.isArray(groups)) {
        throw new UninstallError(
          `${settingsPath} \`hooks.${event}\` is not an array; refusing to operate.`,
        );
      }
      out[event] = groups;
    }
    hooks = out;
  }

  let mcpServers: Record<string, unknown> | null = null;
  const rawMcp = obj["mcpServers"];
  if (rawMcp !== undefined) {
    if (rawMcp === null || typeof rawMcp !== "object" || Array.isArray(rawMcp)) {
      throw new UninstallError(
        `${settingsPath} \`mcpServers\` field is not an object; refusing to operate.`,
      );
    }
    mcpServers = rawMcp as Record<string, unknown>;
  }

  return { raw, obj, hooks, mcpServers };
}

function isHarnessOwnedCommand(command: string): boolean {
  const trimmed = command.trim();
  return HARNESS_COMMAND_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * A hook group is harness-owned iff every inner hook's command is a
 * harness invocation. Mixed groups are left in place with a warning —
 * splitting a group on a guess risks corrupting an operator-authored
 * composite hook.
 */
function classifyHookGroup(group: unknown): "owned" | "foreign" | "mixed" | "malformed" {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return "malformed";
  const inner = (group as Record<string, unknown>)["hooks"];
  if (!Array.isArray(inner) || inner.length === 0) return "foreign";
  let ownedCount = 0;
  let foreignCount = 0;
  for (const h of inner) {
    if (h === null || typeof h !== "object" || Array.isArray(h)) return "malformed";
    const cmd = (h as Record<string, unknown>)["command"];
    if (typeof cmd !== "string") return "malformed";
    if (isHarnessOwnedCommand(cmd)) ownedCount++;
    else foreignCount++;
  }
  if (ownedCount > 0 && foreignCount === 0) return "owned";
  if (ownedCount === 0) return "foreign";
  return "mixed";
}

function groupMatcher(group: unknown): string | null {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return null;
  const m = (group as Record<string, unknown>)["matcher"];
  return typeof m === "string" ? m : null;
}

function summarizeGroup(group: unknown): string {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return "<malformed>";
  const inner = Array.isArray((group as Record<string, unknown>)["hooks"])
    ? ((group as Record<string, unknown>)["hooks"] as unknown[])
    : [];
  const cmds: string[] = [];
  for (const h of inner) {
    if (h !== null && typeof h === "object" && !Array.isArray(h)) {
      const cmd = (h as Record<string, unknown>)["command"];
      if (typeof cmd === "string") cmds.push(cmd);
    }
  }
  if (cmds.length === 0) return "<no commands>";
  return cmds.map((c) => (c.length > 80 ? `${c.slice(0, 77)}...` : c)).join("; ");
}

/**
 * Best-effort read of the manifest's `tools.mcp[].name` list. The
 * manifest may be absent (user deleted it), malformed, or just missing
 * the mcp section — all return an empty list. We never throw from this:
 * uninstall's job is to clean up, and a broken manifest is not a reason
 * to refuse to remove the entries we already know about.
 */
function manifestMcpNames(manifestPath: string | null): string[] {
  if (manifestPath === null) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const tools = (parsed as Record<string, unknown>)["tools"];
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return [];
  const mcp = (tools as Record<string, unknown>)["mcp"];
  if (!Array.isArray(mcp)) return [];
  const names: string[] = [];
  for (const entry of mcp) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const name = (entry as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
}

function listPreHarnessBackups(settingsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(settingsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(PRE_HARNESS_BACKUP_PREFIX)) {
      out.push(path.join(settingsDir, n));
    }
  }
  return out.sort();
}

/**
 * Collect harness-owned hook group refs, plus warnings for mixed groups
 * (groups we won't touch but whose presence the operator should know
 * about so they can split them by hand if desired).
 */
function collectOwnedHookGroups(
  hooks: Record<string, unknown[]> | null,
  warnings: string[],
): HookGroupRef[] {
  if (hooks === null) return [];
  const out: HookGroupRef[] = [];
  for (const event of Object.keys(hooks).sort()) {
    const groups = hooks[event] ?? [];
    groups.forEach((group, index) => {
      const verdict = classifyHookGroup(group);
      if (verdict === "owned") {
        out.push({
          event,
          index,
          matcher: groupMatcher(group),
          description: summarizeGroup(group),
        });
        return;
      }
      if (verdict === "mixed") {
        warnings.push(
          `hooks.${event}[${index}] is a mixed group (harness + foreign commands); leaving in place. ` +
            `Split it manually if you want the harness commands removed.`,
        );
      }
    });
  }
  return out;
}

function ownedMcpServerNames(
  mcp: Record<string, unknown> | null,
  manifestPath: string | null,
): string[] {
  if (mcp === null) return [];
  const owned = new Set<string>(DEFAULT_OWNED_MCP_SERVERS);
  for (const n of manifestMcpNames(manifestPath)) owned.add(n);
  const present: string[] = [];
  for (const name of Object.keys(mcp).sort()) {
    if (owned.has(name)) present.push(name);
  }
  return present;
}

function existsOrNull(p: string): string | null {
  try {
    fs.accessSync(p);
    return p;
  } catch {
    return null;
  }
}

function probeProjectLocalClaudeJson(warnings: string[], homeDir: string): void {
  // The user's `~/.claude.json` (note: NOT under `~/.claude/`) is where
  // Claude Code records project-level config — including mcpServers
  // registered with `claude mcp add`. Harness never writes there, but
  // if the user followed an earlier walkthrough that wired
  // `grounding-mcp` project-level, it sits silently after uninstall and
  // keeps the binary on the spawn list. We surface a hint but never
  // touch the file: it's user-owned territory.
  const projectLocal = path.join(path.dirname(homeDir), ".claude.json");
  let raw: string;
  try {
    raw = fs.readFileSync(projectLocal, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const obj = node as Record<string, unknown>;
    const mcp = obj["mcpServers"];
    if (mcp !== null && typeof mcp === "object" && !Array.isArray(mcp)) {
      for (const name of Object.keys(mcp as Record<string, unknown>)) {
        if (
          (DEFAULT_OWNED_MCP_SERVERS as readonly string[]).includes(name) ||
          name === "agent-grounding"
        ) {
          warnings.push(
            `~/.claude.json registers mcpServers.${name} project-level; uninstall does not touch ` +
              `that file. Run \`claude mcp remove ${name}\` to clean it up if you no longer need ` +
              `the binary on the spawn list.`,
          );
        }
      }
    }
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === "object") stack.push(v);
    }
  }
}

function buildInventory(opts: UninstallOptions): {
  inventory: UninstallInventory;
  parsed: ParsedSettings | null;
} {
  const homeDir = resolveHomeDir(opts);
  const settingsPath = resolveSettingsPath(opts, homeDir);

  const manifestPath = existsOrNull(path.join(homeDir, MANIFEST_BASENAME));
  const lockPath = existsOrNull(path.join(homeDir, LOCK_BASENAME));
  const generatedDir = existsOrNull(path.join(homeDir, GENERATED_DIRNAME));

  const parsed = readSettings(settingsPath);
  const warnings: string[] = [];
  const hookGroups = collectOwnedHookGroups(parsed?.hooks ?? null, warnings);
  const mcpServers = ownedMcpServerNames(parsed?.mcpServers ?? null, manifestPath);
  const preHarnessBackups = listPreHarnessBackups(path.dirname(settingsPath));

  probeProjectLocalClaudeJson(warnings, homeDir);

  return {
    inventory: {
      homeDir,
      settingsPath,
      manifestPath,
      lockPath,
      generatedDir,
      hookGroups,
      mcpServers,
      preHarnessBackups,
      warnings,
    },
    parsed,
  };
}

function removeFilesystemArtefacts(inventory: UninstallInventory): string[] {
  const removed: string[] = [];
  for (const p of [inventory.manifestPath, inventory.lockPath]) {
    if (p === null) continue;
    try {
      fs.unlinkSync(p);
      removed.push(p);
    } catch (err) {
      throw new UninstallError(`failed to remove ${p}: ${(err as Error).message}`);
    }
  }
  if (inventory.generatedDir !== null) {
    try {
      fs.rmSync(inventory.generatedDir, { recursive: true, force: true });
      removed.push(inventory.generatedDir);
    } catch (err) {
      throw new UninstallError(
        `failed to remove ${inventory.generatedDir}: ${(err as Error).message}`,
      );
    }
  }
  return removed;
}

function writeSettingsWithRemovals(
  parsed: ParsedSettings,
  inventory: UninstallInventory,
  now: Date,
): {
  backupPath: string;
  snapshotPath: string;
  removedHookGroups: RemovedHookGroup[];
  removedMcpServers: RemovedMcpServer[];
} {
  const removedHookGroups: RemovedHookGroup[] = [];
  const keptHooks: Record<string, unknown[]> = {};

  const ownedRefs = new Set(
    inventory.hookGroups.map((g) => `${g.event} ${g.index}`),
  );

  if (parsed.hooks !== null) {
    for (const event of Object.keys(parsed.hooks).sort()) {
      const groups = parsed.hooks[event] ?? [];
      const kept: unknown[] = [];
      groups.forEach((group, index) => {
        if (ownedRefs.has(`${event} ${index}`)) {
          removedHookGroups.push({ event, index, group });
        } else {
          kept.push(group);
        }
      });
      if (kept.length > 0) keptHooks[event] = kept;
    }
  }

  const removedMcpServers: RemovedMcpServer[] = [];
  const keptMcpServers: Record<string, unknown> = {};
  if (parsed.mcpServers !== null) {
    const ownedMcp = new Set(inventory.mcpServers);
    for (const name of Object.keys(parsed.mcpServers)) {
      if (ownedMcp.has(name)) {
        removedMcpServers.push({ name, spec: parsed.mcpServers[name] });
      } else {
        keptMcpServers[name] = parsed.mcpServers[name];
      }
    }
  }

  const beforeSha = sha256Hex(parsed.raw);
  const backup = backupPath(inventory.settingsPath, now);
  const snapPath = snapshotPath(inventory.settingsPath, now);

  // Backup BEFORE we touch the live file. A failure here aborts cleanly.
  atomicWriteFile(backup, parsed.raw);

  const newObj: Record<string, unknown> = { ...parsed.obj };
  if (Object.keys(keptHooks).length === 0) {
    delete newObj["hooks"];
  } else {
    newObj["hooks"] = keptHooks;
  }
  if (Object.keys(keptMcpServers).length === 0) {
    delete newObj["mcpServers"];
  } else {
    newObj["mcpServers"] = keptMcpServers;
  }
  const newSettings = `${JSON.stringify(newObj, null, 2)}\n`;
  const afterSha = sha256Hex(newSettings);

  const snapshot: UninstallSnapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: now.toISOString(),
    settingsPath: inventory.settingsPath,
    settingsBackupPath: backup,
    settingsBeforeSha256: beforeSha,
    settingsAfterSha256: afterSha,
    removedHookGroups,
    removedMcpServers,
  };

  // Snapshot lands BEFORE the live rewrite (same ordering rationale as
  // `gate disable`: snapshot is the reversibility insurance).
  atomicWriteFile(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  atomicWriteFile(inventory.settingsPath, newSettings);

  return { backupPath: backup, snapshotPath: snapPath, removedHookGroups, removedMcpServers };
}

function writeRestoreSnapshot(
  parsed: ParsedSettings,
  inventory: UninstallInventory,
  restoreSource: string,
  restoredContent: string,
  now: Date,
): { backupPath: string; snapshotPath: string } {
  const beforeSha = sha256Hex(parsed.raw);
  const afterSha = sha256Hex(restoredContent);
  const backup = backupPath(inventory.settingsPath, now);
  const snapPath = snapshotPath(inventory.settingsPath, now);

  atomicWriteFile(backup, parsed.raw);

  // Inventory the would-be removals so the snapshot still records what
  // was overwritten, even though the restore is wholesale.
  const removedHookGroups: RemovedHookGroup[] = [];
  if (parsed.hooks !== null) {
    for (const event of Object.keys(parsed.hooks).sort()) {
      const groups = parsed.hooks[event] ?? [];
      groups.forEach((group, index) => {
        if (classifyHookGroup(group) === "owned") {
          removedHookGroups.push({ event, index, group });
        }
      });
    }
  }
  const removedMcpServers: RemovedMcpServer[] = [];
  if (parsed.mcpServers !== null) {
    const ownedMcp = new Set(inventory.mcpServers);
    for (const name of Object.keys(parsed.mcpServers).sort()) {
      if (ownedMcp.has(name)) {
        removedMcpServers.push({ name, spec: parsed.mcpServers[name] });
      }
    }
  }

  const snapshot: UninstallSnapshot & { restoredFrom: string } = {
    version: SNAPSHOT_VERSION,
    createdAt: now.toISOString(),
    settingsPath: inventory.settingsPath,
    settingsBackupPath: backup,
    settingsBeforeSha256: beforeSha,
    settingsAfterSha256: afterSha,
    removedHookGroups,
    removedMcpServers,
    restoredFrom: restoreSource,
  };

  atomicWriteFile(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  atomicWriteFile(inventory.settingsPath, restoredContent);

  return { backupPath: backup, snapshotPath: snapPath };
}

export function uninstall(opts: UninstallOptions = {}): UninstallResult {
  const { inventory, parsed } = buildInventory(opts);
  const apply = opts.apply === true || typeof opts.restoreFrom === "string";

  if (!apply) {
    return { mode: "list", inventory };
  }

  const now = opts.now ?? new Date();

  if (typeof opts.restoreFrom === "string" && opts.restoreFrom.length > 0) {
    let restored: string;
    try {
      restored = fs.readFileSync(opts.restoreFrom, "utf8");
    } catch (err) {
      throw new UninstallError(
        `cannot read restore source ${opts.restoreFrom}: ${(err as Error).message}`,
      );
    }
    // Validate restore source: must be a JSON object. Avoids silently
    // overwriting settings.json with a corrupt file the operator picked
    // off disk.
    try {
      const parsedRestore: unknown = JSON.parse(restored);
      if (
        parsedRestore === null ||
        typeof parsedRestore !== "object" ||
        Array.isArray(parsedRestore)
      ) {
        throw new UninstallError(
          `restore source ${opts.restoreFrom} is not a JSON object; refusing.`,
        );
      }
    } catch (err) {
      if (err instanceof UninstallError) throw err;
      throw new UninstallError(
        `restore source ${opts.restoreFrom} is not valid JSON (${(err as Error).message}); refusing.`,
      );
    }
    if (parsed === null) {
      throw new UninstallError(
        `${inventory.settingsPath} does not exist; nothing to restore over. ` +
          `Copy ${opts.restoreFrom} into place by hand if that's what you want.`,
      );
    }
    const { backupPath: bp, snapshotPath: sp } = writeRestoreSnapshot(
      parsed,
      inventory,
      opts.restoreFrom,
      restored,
      now,
    );
    const removedFiles = removeFilesystemArtefacts(inventory);
    return {
      mode: "restore",
      inventory,
      restoredFrom: opts.restoreFrom,
      backupPath: bp,
      snapshotPath: sp,
      removedFiles,
    };
  }

  const needsSettingsRewrite =
    inventory.hookGroups.length > 0 || inventory.mcpServers.length > 0;

  let backup: string | null = null;
  let snap: string | null = null;
  if (parsed !== null && needsSettingsRewrite) {
    const written = writeSettingsWithRemovals(parsed, inventory, now);
    backup = written.backupPath;
    snap = written.snapshotPath;
  }

  const removedFiles = removeFilesystemArtefacts(inventory);
  return {
    mode: "apply",
    inventory,
    backupPath: backup,
    snapshotPath: snap,
    removedFiles,
  };
}
