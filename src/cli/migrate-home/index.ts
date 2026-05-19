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
//   - The four items are moved in sequence. A failure midway leaves a
//     partial state in `~/.harness/` and the remaining items in
//     `~/.claude/`. The deprecation warning will fire on the next
//     command (legacy detection sees the remaining state) and the
//     operator can re-run `harness migrate-home --apply` to finish.
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
  const items: MigrateHomeItemResult[] = ITEMS.map((it) => {
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

  if (conflicts.length > 0) {
    for (const c of conflicts) {
      stderr.write(`harness migrate-home: ${c.basename}: ${c.detail}\n`);
    }
    return { legacyPath, newPath, items, outcome: "target-conflict" };
  }

  if (movable.length === 0) {
    stdout.write(
      `harness migrate-home: nothing to migrate (no harness state under ${legacyPath}).\n`,
    );
    return { legacyPath, newPath, items, outcome: "no-op" };
  }

  if (!apply) {
    stdout.write(
      `harness migrate-home: would move ${movable.length} item(s) from ${legacyPath} to ${newPath}:\n`,
    );
    for (const m of movable) {
      stdout.write(`  ${path.join(legacyPath, m.basename)}\n`);
    }
    stdout.write(
      "Re-run with --apply to perform the move. After moving, run `harness apply` to regenerate any embedded paths (e.g. UNDERSTANDING_GATE_REPORT_DIR in settings.json).\n",
    );
    return { legacyPath, newPath, items, outcome: "would-apply" };
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
      moveSync(src, dst);
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
        "If you are looking for harness.yaml, harness.generated/, or .understanding-gate/,",
        `they now live under ${newPath}.`,
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
        markerPath,
      };
    }

    stdout.write(
      "Run `harness apply` to regenerate any embedded paths (e.g. UNDERSTANDING_GATE_REPORT_DIR in settings.json) and re-emit hook command strings against the new home dir.\n",
    );
    return {
      legacyPath,
      newPath,
      items,
      outcome: "applied",
      markerPath,
    };
  }

  // No items actually moved despite plan saying we should — fell into
  // an error on the first item. Surface as partial.
  return { legacyPath, newPath, items, outcome: "partial" };
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
