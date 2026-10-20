// Snapshot file format and shared path handling for `harness gate disable
// --runtime codex` / `harness gate enable --runtime codex`.
//
// `gate disable --runtime codex` does not delete a hook unit: it neutralises
// it in place, replacing the unit's `hooks = [...]` line with `hooks = []`.
// Codex keys a user hook's trust and enabled state by its position in the
// event's array, and an empty group takes its position without registering
// a handler, so every other hook keeps its trust. A Codex snapshot records
// the neutralised units: per unit its identity and the verbatim original
// `hooks = [...]` line, plus the sha256 of the config before the first
// disable and after the latest one, and the generation marker of the block it
// was taken from, which dates it against a later install. At most one
// snapshot per config is live: a later disable merges its units into it. It
// lives beside the Codex config under its own file prefix and carries
// `version: 3` and `target: "codex"`,
// so a Claude settings snapshot (version 1 or 2, no target) can never be restored
// into TOML and a Codex snapshot can never be read as a settings.json one
// (`readSnapshot` rejects version 3). Once `gate enable` has applied a
// snapshot, or found it applied or superseded, it renames the file to
// `*.restored.json` or `*.superseded.json`, and so does a `gate disable` that
// finds the live snapshot spent: the file stays for audit,
// `listCodexSnapshots` never offers it again.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CodexInstallRefusalError,
  type CodexManagedHookUnit,
  defaultCodexConfigPath,
  latestCodexInstallBackup,
  resolveConfigSymlink,
} from "../apply/install-codex-config.js";
import { kernelEntry, linkChain } from "./link-chain.js";
import { shellQuote } from "../shell-quote.js";
import { listSnapshots, namesSameEntry, SNAPSHOT_BASENAME_SUFFIX, snapshotFieldProblem } from "./snapshot.js";

export const CODEX_SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable-codex.";
/** Why `gate enable --runtime codex` retired a snapshot: it was applied or
 * found already applied (`restored`), or its units were brought back by
 * something else since it was taken, such as a re-install (`superseded`). */
export type CodexSnapshotRetirement = "restored" | "superseded";
const RETIRED_SUFFIXES: readonly string[] = [".restored", ".superseded"].map((s) => `${s}${SNAPSHOT_BASENAME_SUFFIX}`);
export const CODEX_SNAPSHOT_VERSION = 3 as const;
export const CODEX_SNAPSHOT_TARGET = "codex" as const;
/** The value a neutralised unit's `hooks` line carries. */
export const CODEX_NEUTRALISED_HOOKS = "hooks = []";

export interface CodexDisabledUnit {
  event: string;
  /** Position of the unit among the units of its event in the block. */
  eventIndex: number;
  /** Position of the unit among all units of the block. */
  ordinal: number;
  id: string;
  matcher: string | null;
  /** The unit's original `hooks = [...]` line, verbatim, without its line terminator. */
  hooksText: string;
}

/** One later `gate disable` merged into a live snapshot, kept for audit. */
export interface CodexSnapshotMerge {
  createdAt: string;
  matcher: string;
  /** The pre-merge copy of the config that disable wrote. */
  configBackupPath: string;
}

export interface CodexGateSnapshot {
  version: typeof CODEX_SNAPSHOT_VERSION;
  target: typeof CODEX_SNAPSHOT_TARGET;
  createdAt: string;
  /** Absolute path as requested (the symlink when the config is one). */
  configPath: string;
  /** Absolute path the pre-mutation copy was written to. */
  configBackupPath: string;
  /** The config before the first disable this snapshot covers. */
  configBeforeSha256: string;
  /** The config after the latest disable merged into this snapshot. */
  configAfterSha256: string;
  filter: { matcher?: string };
  /** The neutralised units in block order, merged over every disable since the snapshot was created. */
  neutralised: CodexDisabledUnit[];
  /** Later disables merged into this snapshot, oldest first (absent when there were none). */
  merges?: CodexSnapshotMerge[];
  /** The generation marker of the block the snapshot was taken from
   * (`CODEX_BLOCK_GENERATION_PREFIX`); absent when that block carried none,
   * and in a snapshot written before the marker existed. */
  blockGeneration?: string;
}

export interface ResolvedCodexConfig {
  /** The requested path, absolute. Snapshots and backups sit beside it. */
  requestedPath: string;
  /** The regular file read and written (the symlink's target when linked). */
  configPath: string;
  /** `requestedPath` when the call named a config (`--config`), else null: a
   * command a message prints repeats the flag only when the call had it. */
  namedPath: string | null;
}

/** ` <flag> <path>` with the path shell-quoted when the call named a config, else "". */
export function codexConfigFlag(namedPath: string | null, flag = "--config"): string {
  return namedPath === null ? "" : ` ${flag} ${shellQuote(namedPath)}`;
}

/** The install command the installer's refusal texts and hints print. */
export const CODEX_INSTALL_COMMAND = "harness apply --runtime codex --install";

/** `message` with every bare install command followed by the call's
 * `--codex-config <path>` (shell-quoted) when the call named a config, so a
 * pasted command acts on the config the call acted on and not on the default
 * `~/.codex/config.toml`. A call without a named config prints it unchanged.
 * Apply once, at the boundary that knows the call's path. */
export function nameInstallConfig(message: string, namedPath: string | null): string {
  if (namedPath === null) return message;
  return message
    .split(CODEX_INSTALL_COMMAND)
    .join(`${CODEX_INSTALL_COMMAND}${codexConfigFlag(namedPath, "--codex-config")}`);
}

/** Installer refusal texts are worded for `harness apply --install`. Reached
 * through the gate they would tell the operator about an install that never
 * ran, so each known phrase is mapped to the gate's own wording. */
const GATE_WORDING: ReadonlyArray<readonly [string, string]> = [
  [
    "refusing to install, because without parsing it harness cannot confirm that every table outside the harness-managed hook block would survive the install",
    "refusing to edit, because without parsing it harness cannot confirm that every table outside the harness-managed hook block would survive the edit",
  ],
  ["installing would change", "the gate edit would change"],
  ["refusing to install rather than risk", "refusing to edit rather than risk"],
  ["refusing to install, nothing was written", "refusing to edit, nothing was written"],
  ["The Codex config harness would write to", "The Codex config the gate would write to"],
  [
    "restore it from the most recent .harness-backup-* file (if one exists)",
    "restore it from the backup the gate wrote beside it (<config>.bak.<timestamp>, if one exists)",
  ],
];

/** The message of an installer refusal in the gate's wording. */
export function gateWording(message: string): string {
  let out = message;
  for (const [from, to] of GATE_WORDING) out = out.split(from).join(to);
  return out;
}

/** An installer refusal becomes the gate verb's own error type (same text in
 * the gate's wording, its install commands naming the config the call named,
 * `namedPath`); anything else is rethrown unchanged by the caller. */
export function toGateError(
  err: unknown,
  makeError: (message: string) => Error,
  namedPath: string | null = null,
): unknown {
  return err instanceof CodexInstallRefusalError
    ? makeError(nameInstallConfig(gateWording(err.message), namedPath))
    : err;
}

/** The absolute spelling of a config path. One with a `..` segment is taken
 * through the directory the kernel reaches (`kernelEntry`), not folded
 * lexically: `via/..` is the parent of where the directory link `via` leads,
 * and the snapshot and the backup sit beside the config as the kernel finds it. */
function absoluteEntry(spelled: string): string {
  if (!spelled.split(path.sep).includes("..")) return path.resolve(spelled);
  const entry = kernelEntry(spelled);
  // A directory that cannot be resolved stays as written (nothing can be read
  // or written through it), made absolute without a fold.
  return path.isAbsolute(entry) ? entry : `${process.cwd()}${path.sep}${entry}`;
}

/** Resolves `--config` (or the default `~/.codex/config.toml`) the way the
 * installer does: a symlinked config is edited at its resolved target. The
 * symlink refusals (dangling, not a regular file) surface as `makeError`. */
export function resolveCodexConfig(
  opts: { configPath?: string | undefined; homeDir?: string | undefined },
  makeError: (message: string) => Error,
): ResolvedCodexConfig {
  const named = typeof opts.configPath === "string" && opts.configPath.length > 0;
  const requestedPath = absoluteEntry(named ? opts.configPath! : defaultCodexConfigPath(opts.homeDir));
  try {
    return { requestedPath, configPath: resolveConfigSymlink(requestedPath), namedPath: named ? requestedPath : null };
  } catch (err) {
    throw toGateError(err, makeError, named ? requestedPath : null);
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/:/g, "-");
}

export function codexSnapshotPath(requestedPath: string, now: Date): string {
  return path.join(
    path.dirname(requestedPath),
    `${CODEX_SNAPSHOT_BASENAME_PREFIX}${stamp(now)}${SNAPSHOT_BASENAME_SUFFIX}`,
  );
}

/** The name a snapshot is renamed to once retired. The file stays for audit;
 * `listCodexSnapshots` never offers it again. */
export function retiredCodexSnapshotPath(snapPath: string, why: CodexSnapshotRetirement): string {
  return `${snapPath.slice(0, snapPath.length - SNAPSHOT_BASENAME_SUFFIX.length)}.${why}${SNAPSHOT_BASENAME_SUFFIX}`;
}

/** The snapshot a call retired: `from` was renamed to `to`. */
export interface CodexRetiredSnapshot {
  from: string;
  to: string;
  why: CodexSnapshotRetirement;
  /** For an install-superseded snapshot: the installer backup that dates the install. */
  installBackup?: string;
  /** For a snapshot superseded because the block carries another generation
   * marker than the one it recorded: both markers. */
  generation?: { snapshot: string; block: string };
}

/** Renames a live snapshot to its retired name and returns that name; the
 * file stays for audit. A failed rename surfaces as `makeError`: `context`
 * (what the call has done so far) and the move-aside step. */
export function retireCodexSnapshot(
  snapPath: string,
  why: CodexSnapshotRetirement,
  makeError: (message: string) => Error,
  context = "",
): string {
  const to = retiredCodexSnapshotPath(snapPath, why);
  try {
    fs.renameSync(snapPath, to);
  } catch (err) {
    throw makeError(
      `${context}cannot retire the snapshot ${snapPath} (${(err as Error).message}); move it out of this ` +
        "directory by hand so it is never applied again, then run the command again.",
    );
  }
  return to;
}

/** The ways out of a live snapshot that no gate command can apply. */
export function codexSnapshotExits(live: LoadedCodexSnapshot, namedPath: string | null = null): string {
  return (
    `Ways out: run \`harness apply --runtime codex --install${codexConfigFlag(namedPath, "--codex-config")}\`, which ` +
    `re-renders the block and supersedes the snapshot, or restore the config from ${live.snapshot.configBackupPath} ` +
    `(its state before the snapshot's first disable); either way the next ` +
    `\`harness gate enable --runtime codex${codexConfigFlag(namedPath)}\` (or disable) retires the ` +
    `snapshot. Or move ${live.path} out of this directory and put back by hand any unit it names that is ` +
    "still disabled."
  );
}

export type CodexRestorePlan =
  | { ok: true; text: string; restored: CodexDisabledUnit[]; skipped: string[] }
  | { ok: false; reason: string };

/** The config with each still-neutralised unit of the snapshot given its
 * original `hooks` line back, found by id in the block as it is now. A unit
 * that is present once and not neutralised is back already, whatever its
 * event or matcher now: it is skipped and named in `skipped`, and its current
 * line is never overwritten. A unit that is missing, listed twice, or still
 * neutralised under another event or matcher cannot be restored by any gate
 * command, so the plan fails and its reason names the ways out. `units` is
 * null when the config has no managed block. */
export function planCodexRestore(
  current: string,
  units: readonly CodexManagedHookUnit[] | null,
  configPath: string,
  live: LoadedCodexSnapshot,
  namedPath: string | null = null,
): CodexRestorePlan {
  if (units === null) {
    return {
      ok: false,
      reason:
        `${configPath} has no harness-managed Codex hook block any more; the snapshot ${live.path} cannot ` +
        `restore units into it. The config is untouched. ${codexSnapshotExits(live, namedPath)}`,
    };
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const restored: CodexDisabledUnit[] = [];
  const skipped: string[] = [];
  for (const wanted of live.snapshot.neutralised) {
    const found = units.filter((u) => u.id === wanted.id);
    const unit = found.length === 1 ? found[0]! : undefined;
    if (unit !== undefined && !unit.disabled) {
      skipped.push(wanted.id);
      continue;
    }
    if (unit === undefined || unit.event !== wanted.event || unit.matcher !== wanted.matcher) {
      return {
        ok: false,
        reason:
          `the hook unit ${JSON.stringify(wanted.id)} of the snapshot ${live.path} is not in the block of ` +
          `${configPath} as it was (missing, listed twice, or changed event or matcher while still disabled), ` +
          `so no gate command can restore it. The config is untouched. ${codexSnapshotExits(live, namedPath)}`,
      };
    }
    edits.push({ start: unit.hooksStart, end: unit.hooksEnd, text: wanted.hooksText });
    restored.push(wanted);
  }
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += current.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { ok: true, text: out + current.slice(cursor), restored, skipped };
}

/** The installer's newest write of the config, read from its backups beside
 * the requested path, beside every further hop of its link chain and beside
 * the resolved target (an install leaves them beside the path it was run
 * through, which may be any of these). An install through a link outside this
 * chain leaves its backups where this cannot look. */
export function latestInstall(requestedPath: string, configPath: string): { ms: number; path: string } | null {
  const found = [...new Set([...linkChain(requestedPath), configPath])]
    .map(latestCodexInstallBackup)
    .filter((t) => t !== null);
  return found.reduce<{ ms: number; path: string } | null>((a, b) => (a === null || b.ms > a.ms ? b : a), null);
}

/** Whether a live snapshot is spent, i.e. `gate enable` would only retire it
 * without writing: an install re-rendered the block after it was taken (its
 * hooks lines may be outdated), the config already matches its pre-disable
 * sha, or none of its units is disabled any more. The last case counts only
 * when every unit it names is still in the block: a unit deleted by hand is
 * neither enabled nor restorable, so the snapshot stays live and `missing`
 * names it. `units` is null when the config has no managed block.
 *
 * An install is dated two ways: by the installer's backup files (`install`,
 * newer than the snapshot), and by the block's generation marker
 * (`blockGeneration`, null when the block carries none): a snapshot that
 * recorded a marker and finds the block carrying another one was taken from a
 * block an install has re-rendered since, which no link spelling and no
 * deleted backup file hides. A snapshot without a recorded marker, or a block
 * without one, is dated by the backup files alone. */
export function spentCodexSnapshot(
  snapshot: CodexGateSnapshot,
  currentSha: string,
  units: ReadonlyArray<{ id: string; disabled: boolean }> | null,
  install: { ms: number; path: string } | null,
  blockGeneration: string | null,
): {
  retire: Pick<CodexRetiredSnapshot, "why" | "installBackup" | "generation"> | null;
  missing: string[];
} {
  if (install !== null && install.ms > Date.parse(snapshot.createdAt)) {
    return { retire: { why: "superseded", installBackup: install.path }, missing: [] };
  }
  const recorded = snapshot.blockGeneration;
  if (recorded !== undefined && blockGeneration !== null && recorded !== blockGeneration) {
    return {
      retire: { why: "superseded", generation: { snapshot: recorded, block: blockGeneration } },
      missing: [],
    };
  }
  if (currentSha === snapshot.configBeforeSha256) return { retire: { why: "restored" }, missing: [] };
  const ids = snapshot.neutralised.map((u) => u.id);
  if (units !== null && !units.some((u) => u.disabled && ids.includes(u.id))) {
    const missing = ids.filter((id) => !units.some((u) => u.id === id));
    return { retire: missing.length === 0 ? { why: "superseded" } : null, missing };
  }
  return { retire: null, missing: [] };
}

/** The Codex snapshots beside a config that are still live (not retired). */
export function listCodexSnapshots(dir: string): string[] {
  return listSnapshots(dir, CODEX_SNAPSHOT_BASENAME_PREFIX).filter(
    (p) => !RETIRED_SUFFIXES.some((suffix) => p.endsWith(suffix)),
  );
}

export interface LoadedCodexSnapshot {
  path: string;
  snapshot: CodexGateSnapshot;
}

/** A live snapshot beside a config that was taken for another config. */
export interface ForeignCodexSnapshot {
  /** The snapshot file. */
  path: string;
  /** The config it was taken for: its recorded basename in the snapshot's directory. */
  configPath: string;
  /** Whether a file (or link) is at `configPath` now. */
  configExists: boolean;
  /** The backup its first disable wrote: the pre-disable copy of that config. */
  configBackupPath: string;
}

/** The way out of a snapshot taken for another config: the gate command that
 * restores the config the snapshot was taken for (with the extra steps when
 * no file is at that name any more). */
export function foreignCodexExit(f: ForeignCodexSnapshot): string {
  return (
    `run \`harness gate enable --runtime codex --config ${shellQuote(f.configPath)}\`` +
    (f.configExists
      ? ""
      : ` (no file is at that name now: if the config was renamed after the disable, rename it back first; ` +
        `if it is gone, restore it from ${f.configBackupPath}, which is the file before that disable, then run ` +
        "that command, which retires the snapshot; or move the snapshot out of the directory by hand once its " +
        "units are back)")
  );
}

/** The live snapshots beside a config, split into those taken for it, newest
 * first by their recorded `createdAt` (equal times by file name, newest name
 * first; never by file mtime, which a directory copy reorders), and those
 * taken for another config. Snapshots sit beside their config and record its
 * path, so only the basename counts, never how the directory was spelled; a
 * snapshot is the config's own when the requested path names the directory
 * entry that basename names (`namesSameEntry`, the Claude gate's rule): the
 * same spelling, or another spelling of the one entry on a filesystem that
 * folds letter case or normalization. A hard link or a symlink to the config
 * under another name is another entry, so a snapshot recorded for either is
 * foreign to the other. An unreadable snapshot refuses via `makeError`. */
export function readLiveCodexSnapshots(
  requestedPath: string,
  makeError: (message: string) => Error,
  namedPath: string | null = null,
): { own: LoadedCodexSnapshot[]; foreign: ForeignCodexSnapshot[] } {
  const own: LoadedCodexSnapshot[] = [];
  const foreign: ForeignCodexSnapshot[] = [];
  const dir = path.dirname(requestedPath);
  const targetName = path.basename(requestedPath);
  for (const snapPath of listCodexSnapshots(dir)) {
    const read = readCodexSnapshot(snapPath, namedPath);
    if (!read.ok) {
      throw makeError(
        `${read.reason.replace(/\.$/, "")}. A live Codex snapshot beside ${requestedPath} that harness cannot read blocks the gate: ` +
          `move ${snapPath} aside (rename it out of this directory) and run the command again.`,
      );
    }
    const recordedName = path.basename(read.snapshot.configPath);
    if (namesSameEntry(dir, recordedName, targetName, { symlinks: true })) {
      own.push({ path: snapPath, snapshot: read.snapshot });
    } else {
      const configPath = path.join(dir, recordedName);
      foreign.push({
        path: snapPath,
        configPath,
        configExists: pathExists(configPath),
        configBackupPath: read.snapshot.configBackupPath,
      });
    }
  }
  const time = (l: LoadedCodexSnapshot): number => Date.parse(l.snapshot.createdAt);
  own.sort((a, b) => time(b) - time(a) || (a.path < b.path ? 1 : -1));
  return { own, foreign };
}

/** Whether anything, a dangling symlink included, is at `p`. */
function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface CodexSnapshotReadOk {
  ok: true;
  snapshot: CodexGateSnapshot;
}

export interface CodexSnapshotReadErr {
  ok: false;
  reason: string;
}

/** A block generation marker as the installer writes it: a sha256 in lowercase hex. */
const GENERATION_RE = /^[0-9a-f]{64}$/;

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMerge(value: unknown): value is CodexSnapshotMerge {
  if (!isRecord(value)) return false;
  const m = value;
  return typeof m["createdAt"] === "string" && typeof m["matcher"] === "string" && typeof m["configBackupPath"] === "string";
}

function isDisabledUnit(value: unknown): value is CodexDisabledUnit {
  if (!isRecord(value)) return false;
  const u = value;
  return (
    typeof u["event"] === "string" &&
    typeof u["id"] === "string" &&
    (u["matcher"] === null || typeof u["matcher"] === "string") &&
    isNonNegativeInteger(u["eventIndex"]) &&
    isNonNegativeInteger(u["ordinal"]) &&
    typeof u["hooksText"] === "string" &&
    u["hooksText"].startsWith("hooks = [") &&
    !/[\r\n]/.test(u["hooksText"])
  );
}

/** Parses a Codex snapshot. Anything that is not a version-3 snapshot with
 * `target: "codex"` is refused, so a Claude snapshot renamed into place is
 * never restored into a TOML file. */
export function readCodexSnapshot(filePath: string, namedPath: string | null = null): CodexSnapshotReadOk | CodexSnapshotReadErr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `cannot read snapshot ${filePath}: ${(err as Error).message}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: `snapshot ${filePath} is not a JSON object` };
  }
  const obj = parsed;
  if (obj["target"] === CODEX_SNAPSHOT_TARGET && obj["version"] === 2) {
    return {
      ok: false,
      reason:
        `snapshot ${filePath} is a version 2 Codex gate snapshot, written by an earlier build that ` +
        "deleted the hook unit instead of neutralising it; it cannot be restored. Re-run " +
        `\`${CODEX_INSTALL_COMMAND}${codexConfigFlag(namedPath, "--codex-config")}\` to rewrite the block, or restore the config ` +
        "from the backup beside it, then remove this snapshot.",
    };
  }
  if (obj["version"] !== CODEX_SNAPSHOT_VERSION || obj["target"] !== CODEX_SNAPSHOT_TARGET) {
    return {
      ok: false,
      reason:
        `snapshot ${filePath} is not a Codex gate snapshot (expected version ${CODEX_SNAPSHOT_VERSION} ` +
        `with target ${JSON.stringify(CODEX_SNAPSHOT_TARGET)}, got version ${JSON.stringify(obj["version"])} ` +
        `with target ${JSON.stringify(obj["target"] ?? null)})`,
    };
  }
  const problem = snapshotFieldProblem(filePath, obj, [
    "createdAt",
    "configPath",
    "configBackupPath",
    "configBeforeSha256",
    "configAfterSha256",
  ]);
  if (problem !== null) return { ok: false, reason: problem };
  // Ownership is decided by the recorded file name, so a path with none (empty, `.`, `..`, `/`) is unreadable.
  const recordedName = path.basename(obj["configPath"] as string);
  if (recordedName === "" || recordedName === "." || recordedName === "..") {
    return { ok: false, reason: `snapshot ${filePath} has a "configPath" that names no file` };
  }
  // Several live snapshots (an earlier build kept one per disable) are ordered by this time, never by file mtime.
  if (Number.isNaN(Date.parse(obj["createdAt"] as string))) {
    return { ok: false, reason: `snapshot ${filePath} has a "createdAt" that is not a timestamp` };
  }
  const units = obj["neutralised"];
  if (!Array.isArray(units) || units.length === 0 || !units.every(isDisabledUnit)) {
    return { ok: false, reason: `snapshot ${filePath} has a malformed "neutralised" list` };
  }
  const ids = new Set(units.map((u: CodexDisabledUnit) => u.id));
  const ordinals = new Set(units.map((u: CodexDisabledUnit) => u.ordinal));
  if (ids.size !== units.length || ordinals.size !== units.length) {
    return {
      ok: false,
      reason: `snapshot ${filePath} lists the same hook unit id or block position twice in "neutralised"`,
    };
  }
  const merges = obj["merges"];
  if (merges !== undefined && !(Array.isArray(merges) && merges.every(isMerge))) {
    return { ok: false, reason: `snapshot ${filePath} has a malformed "merges" list` };
  }
  // The marker decides whether the snapshot is applied at all, so a value that is not one is not guessed at.
  const generation = obj["blockGeneration"];
  if (generation !== undefined && !(typeof generation === "string" && GENERATION_RE.test(generation))) {
    return { ok: false, reason: `snapshot ${filePath} has a "blockGeneration" that is not a block generation marker` };
  }
  return { ok: true, snapshot: obj as unknown as CodexGateSnapshot };
}
