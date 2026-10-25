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
//     items) are moved in sequence, so a failing layer stops the run
//     before harness.yaml moves. A failure midway leaves a partial
//     state in `~/.harness/` and the remaining items in `~/.claude/`.
//     There is no rollback; the recovery path is an explicit re-run of
//     `harness migrate-home --apply` after fixing the error (the CLI
//     exits non-zero on `partial` and says so). Do not rely on the
//     deprecation warning: it only fires while the legacy root still
//     holds harness.yaml or harness.generated/.
//   - Override layers behind a symlink (machines/, projects/ or
//     projects/<name> being a link, or a layer link that would dangle
//     once moved) are never moved or removed; `manual` lists them and
//     the CLI exits non-zero.
//   - Subsequent passes are idempotent: items already missing on the
//     source side are skipped.
//
// On successful `--apply`, a small marker `MOVED_TO_~_DOT_HARNESS.txt`
// is written into `~/.claude/` so an operator who later runs an old
// command from muscle memory has a paper trail pointing at the new
// location. The marker is plain text and does not block any other
// `~/.claude/` consumer (e.g. Claude Code itself).

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

interface LayerDiscovery {
  /** Layer files that can be moved one by one. */
  items: MigrateHomeItem[];
  /** Layers the command will not move itself: lines telling the operator what to move by hand. */
  manual: string[];
}

/**
 * Would the symlink at `src` still resolve once it sits at `dst`? An
 * absolute target is unaffected by the move. A relative target is
 * resolved against the destination directory; it also counts when it
 * lands on one of the top-level items this same run moves there.
 */
function symlinkSurvivesMove(src: string, dst: string, legacyPath: string, newPath: string): boolean {
  let link: string;
  try {
    link = fs.readlinkSync(src);
  } catch {
    return false;
  }
  if (path.isAbsolute(link)) return true;
  const resolved = path.resolve(path.dirname(dst), link);
  if (pathResolves(resolved)) return true;
  if (resolved.startsWith(newPath + path.sep)) {
    const rel = resolved.slice(newPath.length + 1);
    const top = rel.split(path.sep)[0];
    return ITEMS.some((it) => it.basename === top) && pathResolves(path.join(legacyPath, rel));
  }
  return false;
}

function pathResolves(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Control characters in a path taken from disk never reach the terminal raw. */
function safe(s: string): string {
  return sanitizeProjectForDisplay(s);
}

/**
 * Override-layer files under the legacy root, as forward-slash relative
 * paths. Only regular files and symlinks qualify; a project directory
 * or machine file whose name the loader would refuse is skipped.
 * `machines/` or `projects/` being a symlink, a `projects/<name>`
 * directory being a symlink, and a layer symlink that would dangle
 * after the move are never moved: they come back as `manual` lines.
 */
function discoverOverrideLayers(legacyPath: string, newPath: string): LayerDiscovery {
  const items: MigrateHomeItem[] = [];
  const manual: string[] = [];
  const lstat = (p: string): fs.Stats | null => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };
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
  const target = (p: string): string => {
    try {
      return safe(fs.readlinkSync(p));
    } catch {
      return "?";
    }
  };
  const addFile = (rel: string): void => {
    const src = path.join(legacyPath, rel);
    const dst = path.join(newPath, rel);
    const st = lstat(src);
    if (st?.isSymbolicLink() && !symlinkSurvivesMove(src, dst, legacyPath, newPath)) {
      manual.push(
        `move by hand: ${safe(src)} (symlink to ${target(src)} would no longer resolve from ${safe(dst)})`,
      );
      return;
    }
    items.push({ basename: rel, isDir: false });
  };

  const machinesDir = path.join(legacyPath, "machines");
  const machinesStat = lstat(machinesDir);
  if (machinesStat?.isSymbolicLink()) {
    if (list(machinesDir).some((e) => e.name.endsWith(MACHINE_LAYER_SUFFIX))) {
      manual.push(
        `move by hand: ${safe(machinesDir)} (machines/ is a symlink to ${target(machinesDir)}; nothing inside it is moved or removed)`,
      );
    }
  } else {
    for (const e of list(machinesDir)) {
      if (
        e.name.endsWith(MACHINE_LAYER_SUFFIX) &&
        e.name.length > MACHINE_LAYER_SUFFIX.length &&
        safe(e.name) === e.name &&
        isLayerFile(path.join(machinesDir, e.name))
      ) {
        addFile(`machines/${e.name}`);
      }
    }
  }

  const projectsDir = path.join(legacyPath, "projects");
  const projectsStat = lstat(projectsDir);
  const projectsLinked = projectsStat?.isSymbolicLink() === true;
  for (const e of list(projectsDir)) {
    if (!isValidProjectName(e.name)) continue;
    const dir = path.join(projectsDir, e.name);
    const dirStat = lstat(dir);
    const dirIsLink = dirStat?.isSymbolicLink() === true;
    if (dirIsLink ? !pathIsDir(dir) : !dirStat?.isDirectory()) continue;
    if (!isLayerFile(path.join(dir, PROJECT_LAYER_BASENAME))) continue;
    if (projectsLinked) {
      manual.push(
        `move by hand: ${safe(path.join(dir, PROJECT_LAYER_BASENAME))} (projects/ is a symlink to ${target(projectsDir)}; nothing inside it is moved or removed)`,
      );
    } else if (dirIsLink) {
      manual.push(
        `move by hand: ${safe(path.join(dir, PROJECT_LAYER_BASENAME))} (projects/${e.name} is a symlink to ${target(dir)}; nothing inside it is moved or removed)`,
      );
    } else {
      addFile(`projects/${e.name}/${PROJECT_LAYER_BASENAME}`);
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
   *   - `partial`: some items moved before an error stopped the run.
   *   - `target-conflict`: a corresponding item already exists at the
   *     new path; the run refuses to overwrite. Operator must resolve.
   */
  outcome:
    | "no-op"
    | "would-apply"
    | "applied"
    | "partial"
    | "target-conflict";
  /**
   * Layers the command refuses to move itself (symlinked `machines/`,
   * `projects/` or `projects/<name>`, a layer symlink that would dangle),
   * one "move by hand" line each. A non-empty list means the migration is
   * not complete even when `outcome` is `applied`.
   */
  manual: string[];
  /** Path of the breadcrumb marker, present on `applied`. */
  markerPath?: string;
}

export interface MigrateHomeItemResult {
  basename: string;
  legacyExists: boolean;
  newExists: boolean;
  /** What the run did (or would do) with this item. */
  action: "skip" | "would-move" | "moved" | "target-exists";
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

  // Plan phase: classify each item by (legacy exists, new exists).
  const layers = discoverOverrideLayers(legacyPath, newPath);
  const manual = layers.manual;
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

  for (const line of manual) stderr.write(`harness migrate-home: ${line}\n`);

  if (conflicts.length > 0) {
    for (const c of conflicts) {
      stderr.write(`harness migrate-home: ${c.basename}: ${c.detail}\n`);
    }
    return { legacyPath, newPath, items, outcome: "target-conflict", manual };
  }

  if (movable.length === 0) {
    stdout.write(
      `harness migrate-home: nothing to migrate (no movable harness state under ${legacyPath}).\n`,
    );
    return { legacyPath, newPath, items, outcome: "no-op", manual };
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
    return { legacyPath, newPath, items, outcome: "would-apply", manual };
  }

  // Apply phase: move each item. Create the destination root first.
  try {
    fs.mkdirSync(newPath, { recursive: true });
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
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      moveSync(src, dst);
      removeEmptyParents(src, legacyPath);
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

  const moved = items.filter((i) => i.action === "moved");
  if (moved.length > 0) {
    // Breadcrumb: drop a small text file so an operator who later
    // recalls the old path knows where to look.
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
      return {
        legacyPath,
        newPath,
        items,
        outcome: "partial",
        manual,
        markerPath,
      };
    }

    if (manual.length > 0) {
      stderr.write(
        "harness migrate-home: the moves above are done, but the `move by hand` items remain under the legacy root; move them, then run `harness apply`.\n",
      );
    }
    stdout.write(
      "Run `harness apply` to regenerate any embedded paths and re-emit hook command strings against the new home dir; a leftover UNDERSTANDING_GATE_REPORT_DIR entry in settings.json is unused and can be deleted.\n",
    );
    return {
      legacyPath,
      newPath,
      items,
      outcome: "applied",
      manual,
      markerPath,
    };
  }

  // No items actually moved despite plan saying we should — fell into
  // an error on the first item. Surface as partial.
  return { legacyPath, newPath, items, outcome: "partial", manual };
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
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(src, { recursive: true, force: true });
}
