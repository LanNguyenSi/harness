// Phase 7 / v0.24.0 — `harness migrate-home` command.
//
// Moves harness operator-state from the legacy `~/.claude/` root to the
// runtime-neutral `~/.harness/` introduced in task e65decef. Default
// behaviour is dry-run (plan + report, no writes); `--apply` performs
// the move. Re-running on already-migrated state is a no-op.
//
// What gets moved:
//   - `~/.claude/harness.yaml`              → `~/.harness/harness.yaml`
//   - `~/.claude/harness.generated/`        → `~/.harness/harness.generated/`
//   - `~/.claude/.understanding-gate/`      → `~/.harness/.understanding-gate/`
//   - `~/.claude/harness.lock`              → `~/.harness/harness.lock`
//   - `~/.claude/machines/<d>.harness.overrides.yaml`
//                                           → `~/.harness/machines/<d>.harness.overrides.yaml`
//   - `~/.claude/projects/<p>/harness.overrides.yaml`
//                                           → `~/.harness/projects/<p>/harness.overrides.yaml`
//
// Override layers move one file at a time, never as a directory:
// `~/.claude/projects/` is also Claude Code's own session-transcript
// directory, so only the harness-owned layer files are picked up and
// everything else beside them stays put. The loader resolves layers under
// the state root, so a layer left behind would silently stop applying.
//
// Symlinks are never moved. A layer file that is a symlink, a
// `projects/<name>` directory that is a symlink, and `machines/` or
// `projects/` being a symlink are reported as `move by hand: <path>
// (symlink to <target>)` and left untouched; nothing inside a link target
// is moved or removed. Such an item stops counting as open once every
// layer it holds exists at its destination under `~/.harness/` (the
// operator recreated it there): the command then prints an `already at`
// line instead.
//
// What is NOT touched (operator-owned, runtime config, not harness state):
//   - `~/.claude/settings.json`             (Claude Code's runtime config)
//   - any other operator-authored content under `~/.claude/`
//
// Atomicity contract:
//   - Each item is moved with `fs.renameSync` first. If that fails with
//     `EXDEV` (cross-filesystem rename), the command falls back to a
//     copy-then-delete sequence so the source side is removed only
//     after the destination side is fully written.
//   - The N items (override layers first, then the four top-level
//     items, `harness.yaml` first among them) are moved in sequence.
//   - A move that fails before `harness.yaml` has moved rolls the run
//     back: every item it moved is moved back and every directory it
//     created under `~/.harness/` (`~/.harness/` itself included) is
//     removed, so nothing is changed and the outcome is `rolled-back`.
//     A rollback step that fails is reported line by line, together with
//     what now sits where, and the outcome is `partial`.
//   - A move that fails after `harness.yaml` has moved is not rolled
//     back: the outcome is `partial`, the command says what is under
//     which root, and the recovery path is an explicit re-run of
//     `harness migrate-home --apply` after fixing the error. Do not rely
//     on the deprecation warning: it only fires while the legacy root
//     still holds harness.yaml or harness.generated/.
//   - Subsequent passes are idempotent: items already missing on the
//     source side are skipped.
//
// On `--apply` that leaves anything moved (`applied`, or `partial` after
// `harness.yaml` moved), a small marker `MOVED_TO_~_DOT_HARNESS.txt` is
// written into `~/.claude/` so an operator who later runs an old command
// from muscle memory has a paper trail pointing at the new location. The
// marker is plain text and does not block any other `~/.claude/` consumer
// (e.g. Claude Code itself).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HARNESS_HOME_DIRNAME,
  LEGACY_HARNESS_HOME_DIRNAME,
} from "../../runtime/home-dir.js";
import { isValidProjectName, sanitizeProjectForDisplay } from "../../io/project-name.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";

export const MIGRATION_MARKER_BASENAME = "MOVED_TO_~_DOT_HARNESS.txt";

interface MigrateHomeItem {
  /** Basename in the legacy root. */
  basename: string;
  /** True for directories that should move via recursive copy on EXDEV. */
  isDir: boolean;
}

const ITEMS: MigrateHomeItem[] = [
  { basename: "harness.yaml", isDir: false },
  { basename: "harness.generated", isDir: true },
  { basename: ".understanding-gate", isDir: true },
  { basename: "harness.lock", isDir: false },
];

const MACHINE_LAYER_SUFFIX = ".harness.overrides.yaml";
const PROJECT_LAYER_BASENAME = "harness.overrides.yaml";

/** A layer behind a symlink: reported, never moved. */
interface ManualItem {
  /** The symlink under the legacy root. */
  path: string;
  /** Its link target as stored, or `?` when it cannot be read. */
  target: string;
  /** Where it belongs under the new root. */
  dst: string;
  /** The layer files that must exist under the new root for the item to be done. */
  layers: string[];
}

interface LayerDiscovery {
  /** Regular layer files, moved one by one. */
  items: MigrateHomeItem[];
  /** Symlinked layers the command leaves for the operator. */
  manual: ManualItem[];
}

/** Control characters in a path taken from disk never reach the terminal raw. */
function safe(s: string): string {
  return sanitizeProjectForDisplay(s);
}

/**
 * Override-layer files under the legacy root, as forward-slash relative
 * paths. Only regular files are moved; a project directory or machine
 * file whose name the loader would refuse is skipped. A layer file that
 * is a symlink, a `projects/<name>` directory that is a symlink, and
 * `machines/` or `projects/` being a symlink come back as `manual`
 * items instead.
 */
function discoverOverrideLayers(legacyPath: string, newPath: string): LayerDiscovery {
  const items: MigrateHomeItem[] = [];
  const manual: ManualItem[] = [];
  const lstat = (p: string): fs.Stats | null => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };
  /** A file the loader would read as a layer: a regular file or a symlink. */
  const isLayerFile = (p: string): boolean => {
    const st = lstat(p);
    return st !== null && (st.isFile() || st.isSymbolicLink());
  };
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return [];
    }
  };
  const byHand = (link: string, dst: string, layers: string[]): void => {
    let target = "?";
    try {
      target = fs.readlinkSync(link);
    } catch {
      /* keep "?" */
    }
    manual.push({ path: link, target, dst, layers });
  };
  /** Queue a layer file for the move; a layer file that is a symlink is reported instead. */
  const addFile = (rel: string): void => {
    const src = path.join(legacyPath, rel);
    const dst = path.join(newPath, rel);
    if (lstat(src)?.isSymbolicLink()) {
      byHand(src, dst, [dst]);
      return;
    }
    items.push({ basename: rel, isDir: false });
  };
  const isMachineLayer = (e: fs.Dirent): boolean =>
    e.name.endsWith(MACHINE_LAYER_SUFFIX) &&
    e.name.length > MACHINE_LAYER_SUFFIX.length &&
    safe(e.name) === e.name;

  const machinesDir = path.join(legacyPath, "machines");
  const machineLayers = list(machinesDir).filter(
    (e) => isMachineLayer(e) && isLayerFile(path.join(machinesDir, e.name)),
  );
  if (lstat(machinesDir)?.isSymbolicLink()) {
    if (machineLayers.length > 0) {
      byHand(
        machinesDir,
        path.join(newPath, "machines"),
        machineLayers.map((e) => path.join(newPath, "machines", e.name)),
      );
    }
  } else {
    for (const e of machineLayers) {
      addFile(`machines/${e.name}`);
    }
  }

  const projectsDir = path.join(legacyPath, "projects");
  const projectLayers: Array<{ name: string; dirIsLink: boolean }> = [];
  for (const e of list(projectsDir)) {
    if (!isValidProjectName(e.name)) continue;
    const dir = path.join(projectsDir, e.name);
    const dirStat = lstat(dir);
    const dirIsLink = dirStat?.isSymbolicLink() === true;
    if (dirIsLink ? !pathIsDir(dir) : !dirStat?.isDirectory()) continue;
    if (!isLayerFile(path.join(dir, PROJECT_LAYER_BASENAME))) continue;
    projectLayers.push({ name: e.name, dirIsLink });
  }
  const projectLayerDst = (name: string): string =>
    path.join(newPath, "projects", name, PROJECT_LAYER_BASENAME);
  if (lstat(projectsDir)?.isSymbolicLink()) {
    if (projectLayers.length > 0) {
      byHand(
        projectsDir,
        path.join(newPath, "projects"),
        projectLayers.map((p) => projectLayerDst(p.name)),
      );
    }
  } else {
    for (const e of projectLayers) {
      if (e.dirIsLink) {
        byHand(path.join(projectsDir, e.name), path.join(newPath, "projects", e.name), [
          projectLayerDst(e.name),
        ]);
      } else {
        addFile(`projects/${e.name}/${PROJECT_LAYER_BASENAME}`);
      }
    }
  }
  return { items, manual };
}

function pathIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface MigrateHomeOptions {
  /** If true, perform the move; otherwise dry-run. */
  apply?: boolean;
  /** Test injection for `os.homedir()`. */
  userHome?: string;
  /** Test injection for stdout. */
  stdout?: NodeJS.WritableStream;
  /** Test injection for stderr. */
  stderr?: NodeJS.WritableStream;
  /**
   * Test injection for the single-item move, used both forward and for
   * the rollback. Defaults to a rename with a copy-then-delete fallback
   * across filesystems.
   */
  move?: (src: string, dst: string) => void;
}

export interface MigrateHomeResult {
  legacyPath: string;
  newPath: string;
  /** Per-item plan: what was found, what would be moved, what was moved. */
  items: MigrateHomeItemResult[];
  /**
   * Outcome of the run:
   *   - `no-op`: nothing to migrate (legacy dir empty, or already moved).
   *   - `would-apply`: dry-run; the listed items would move.
   *   - `applied`: items moved this run.
   *   - `rolled-back`: a move failed before `harness.yaml` moved; every
   *     move of this run was undone, nothing was changed.
   *   - `partial`: a move failed after `harness.yaml` moved, or a
   *     rollback could not undo every step; items are split across both
   *     roots and stderr says which is where.
   *   - `target-conflict`: a corresponding item already exists at the
   *     new path; the run refuses to overwrite. Operator must resolve.
   */
  outcome:
    | "no-op"
    | "would-apply"
    | "applied"
    | "rolled-back"
    | "partial"
    | "target-conflict";
  /**
   * Open `move by hand` lines: symlinked layers (a layer file, a
   * `projects/<name>` directory, `machines/` or `projects/` being a link)
   * that are not yet at their destination. A non-empty list means the
   * migration is not complete even when `outcome` is `applied`.
   */
  manual: string[];
  /**
   * `already at` lines: symlinked layers whose destination already
   * exists. Informational; they do not keep the migration open.
   */
  manualDone: string[];
  /** Path of the breadcrumb marker, present when anything stayed moved. */
  markerPath?: string;
}

export interface MigrateHomeItemResult {
  basename: string;
  legacyExists: boolean;
  newExists: boolean;
  /** What the run did (or would do) with this item. */
  action: "skip" | "would-move" | "moved" | "moved-back" | "target-exists";
  /** Error message if `target-exists` or a move failed. */
  detail?: string;
}

export function migrateHome(opts: MigrateHomeOptions = {}): MigrateHomeResult {
  const userHome = opts.userHome ?? os.homedir();
  const legacyPath = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);
  const newPath = path.join(userHome, HARNESS_HOME_DIRNAME);
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const apply = opts.apply === true;
  const move = opts.move ?? moveSync;

  // Plan phase: classify each item by (legacy exists, new exists).
  const layers = discoverOverrideLayers(legacyPath, newPath);
  const manual: string[] = [];
  const manualDone: string[] = [];
  for (const m of layers.manual) {
    if (m.layers.every((p) => pathExists(p))) {
      manualDone.push(
        `already at ${safe(m.dst)}; remove the legacy ${safe(m.path)} when you no longer need it`,
      );
    } else {
      manual.push(`move by hand: ${safe(m.path)} (symlink to ${safe(m.target)})`);
    }
  }
  // Layers first: a layer failure must stop the run before harness.yaml
  // moves, so a failed run never leaves the manifest at the new root with
  // its layers stranded at the old one.
  const items: MigrateHomeItemResult[] = [...layers.items, ...ITEMS].map((it) => {
    const legacyItem = path.join(legacyPath, it.basename);
    const newItem = path.join(newPath, it.basename);
    const legacyExists = pathExists(legacyItem);
    const newExists = pathExists(newItem);
    if (!legacyExists) {
      return { basename: it.basename, legacyExists, newExists, action: "skip" };
    }
    if (newExists) {
      return {
        basename: it.basename,
        legacyExists,
        newExists,
        action: "target-exists",
        detail: `${newItem} already present; refuse to overwrite. Inspect, then remove one side and re-run.`,
      };
    }
    return {
      basename: it.basename,
      legacyExists,
      newExists,
      action: "would-move",
    };
  });

  const movable = items.filter((i) => i.action === "would-move");
  const conflicts = items.filter((i) => i.action === "target-exists");
  const base = { legacyPath, newPath, items, manual, manualDone };

  for (const line of manual) stderr.write(`harness migrate-home: ${line}\n`);
  if (manual.length > 0) {
    stderr.write(
      `harness migrate-home: symlinked layers are never moved; recreate each \`move by hand\` item under ${newPath} (copy the file, or a new link to the same target), then re-run \`harness migrate-home --apply\`.\n`,
    );
  }
  for (const line of manualDone) stdout.write(`harness migrate-home: ${line}\n`);

  if (conflicts.length > 0) {
    for (const c of conflicts) {
      stderr.write(`harness migrate-home: ${c.basename}: ${c.detail}\n`);
    }
    return { ...base, outcome: "target-conflict" };
  }

  if (movable.length === 0) {
    stdout.write(
      `harness migrate-home: nothing to migrate (no movable harness state under ${legacyPath}).\n`,
    );
    return { ...base, outcome: "no-op" };
  }

  if (!apply) {
    stdout.write(
      `harness migrate-home: would move ${movable.length} item(s) from ${legacyPath} to ${newPath}:\n`,
    );
    for (const m of movable) {
      stdout.write(`  ${path.join(legacyPath, m.basename)}\n`);
    }
    stdout.write(
      "Re-run with --apply to perform the move. After moving, run `harness apply` to regenerate any embedded paths; a leftover UNDERSTANDING_GATE_REPORT_DIR entry in settings.json is unused and can be deleted.\n",
    );
    return { ...base, outcome: "would-apply" };
  }

  // Apply phase. Every directory this run creates under the new root is
  // recorded, shallowest first, so a rollback can remove exactly those.
  const createdDirs: string[] = [];
  const trackMkdir = (dir: string): void => {
    const first = fs.mkdirSync(dir, { recursive: true });
    if (first === undefined) return;
    const below: string[] = [];
    for (let d = dir; d !== first && d.startsWith(first + path.sep); d = path.dirname(d)) {
      below.unshift(d);
    }
    createdDirs.push(first, ...below);
  };
  try {
    trackMkdir(newPath);
  } catch (err) {
    throw new HarnessExitError(
      `failed to create ${newPath}: ${(err as Error).message}`,
      EX_FAIL,
    );
  }

  let anyError: string | null = null;
  for (const m of movable) {
    const src = path.join(legacyPath, m.basename);
    const dst = path.join(newPath, m.basename);
    try {
      trackMkdir(path.dirname(dst));
      move(src, dst);
      m.action = "moved";
      stdout.write(`moved ${src} to ${dst}\n`);
    } catch (err) {
      const msg = (err as Error).message;
      m.detail = msg;
      anyError = msg;
      stderr.write(`harness migrate-home: failed to move ${m.basename}: ${msg}\n`);
      break;
    }
  }

  const manifestMoved = items.some((i) => i.basename === "harness.yaml" && i.action === "moved");
  if (anyError !== null && !manifestMoved) {
    // The manifest is still at the legacy root: undo this run so the
    // operator is back where they started instead of half-migrated.
    const failures: string[] = [];
    for (const m of [...items].reverse()) {
      if (m.action !== "moved") continue;
      const src = path.join(legacyPath, m.basename);
      const dst = path.join(newPath, m.basename);
      try {
        move(dst, src);
        m.action = "moved-back";
      } catch (err) {
        failures.push(`could not move ${dst} back to ${src}: ${(err as Error).message}`);
      }
    }
    for (const dir of [...createdDirs].reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch (err) {
        failures.push(`could not remove ${dir}, which this run created: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      stderr.write(
        `harness migrate-home: undid every move of this run; nothing was changed under ${legacyPath} or ${newPath}.\n`,
      );
      return { ...base, outcome: "rolled-back" };
    }
    for (const f of failures) stderr.write(`harness migrate-home: ROLLBACK FAILED: ${f}\n`);
    reportWhere(stderr, items, legacyPath, newPath);
    return { ...base, outcome: "partial" };
  }

  // Prune legacy layer directories the moves emptied. Deferred until no
  // rollback can follow, so a rollback finds every legacy directory.
  const moved = items.filter((i) => i.action === "moved");
  for (const m of moved) {
    const src = path.join(legacyPath, m.basename);
    removeEmptyParents(src, legacyPath);
  }

  // Breadcrumb: drop a small text file so an operator who later recalls
  // the old path knows where to look.
  const markerPath = path.join(legacyPath, MIGRATION_MARKER_BASENAME);
  try {
    const body = [
      `harness state was migrated to ${newPath} on ${new Date().toISOString()}.`,
      "",
      "If you are looking for harness.yaml, harness.generated/, .understanding-gate/,",
      `or the override layers (machines/, projects/), they now live under ${newPath}.`,
      "",
      "Files moved this run:",
      ...moved.map((m) => `  - ${m.basename}`),
      "",
      "Note: this marker is harness-owned. Your Claude Code settings.json and any",
      "other ~/.claude/ contents were not touched.",
      "",
    ].join("\n");
    fs.writeFileSync(markerPath, body);
  } catch {
    /* best-effort breadcrumb; failure to write the marker does not unwind the move */
  }

  if (anyError !== null) {
    reportWhere(stderr, items, legacyPath, newPath);
    return { ...base, outcome: "partial", markerPath };
  }

  stdout.write(
    "Run `harness apply` to regenerate any embedded paths and re-emit hook command strings against the new home dir; a leftover UNDERSTANDING_GATE_REPORT_DIR entry in settings.json is unused and can be deleted.\n",
  );
  return { ...base, outcome: "applied", markerPath };
}

/** After a partial run: which items sit under which root. */
function reportWhere(
  stderr: NodeJS.WritableStream,
  items: MigrateHomeItemResult[],
  legacyPath: string,
  newPath: string,
): void {
  const atNew = items.filter((i) => i.action === "moved").map((i) => i.basename);
  const atLegacy = items
    .filter((i) => i.action === "would-move" || i.action === "moved-back")
    .map((i) => i.basename);
  if (atNew.length > 0) {
    stderr.write(`harness migrate-home: now under ${newPath}: ${atNew.join(", ")}\n`);
  }
  if (atLegacy.length > 0) {
    stderr.write(`harness migrate-home: still under ${legacyPath}: ${atLegacy.join(", ")}\n`);
  }
}

/** Remove now-empty directories above a moved layer file, stopping at the legacy root. */
function removeEmptyParents(movedSrc: string, legacyPath: string): void {
  let dir = path.dirname(movedSrc);
  while (dir !== legacyPath && dir.startsWith(legacyPath + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return; // not empty (e.g. Claude Code's own files): leave it
    }
    dir = path.dirname(dir);
  }
}

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function moveSync(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EXDEV") throw err;
  }
  // Cross-filesystem fallback: recursive copy then delete. fs.cpSync
  // is in Node 16.7+; harness requires Node 18+ per package.json.
  fs.cpSync(src, dst, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
}
