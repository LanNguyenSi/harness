// Detect leftover rogue evidence-ledger DBs from the literal-tilde
// `EVIDENCE_LEDGER_DB` env leak (root cause + fix: agent-tasks/42d224a6,
// harness PR #101). The env block expanded `~/.evidence-ledger/ledger.db`
// as a literal directory name relative to the grounding-mcp cwd, so
// every spawn cwd grew a sibling `~/.evidence-ledger/ledger.db` tree.
//
// The fix removed the env block, so no new rogue DBs appear. The existing
// ones on disk are harmless orphans, but they take up space and confuse
// forensics ("why do I have three identical-shape ledger DBs?"). This
// scan flags them so the operator can `rm -rf` at their convenience.
//
// Scan scope is bounded by design: the literal `~` directory only ever
// appears one level deep under wherever grounding-mcp was spawned. The
// well-known spawn-cwd locations are: $HOME (when claude-code spawns from
// the user's home), $HOME/git/<repo> (the per-repo working tree), and
// $PWD (whatever directory the operator invoked harness from). No
// recursion past one level: we are not a generic disk-cleanup tool.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";

export interface RogueLedgerDb {
  /** Absolute path to the rogue ledger.db file. */
  path: string;
  /** Absolute path to the rogue `~` directory (the cleanup target). */
  rogueDir: string;
}

export interface RogueLedgerScanOptions {
  homeDir: string;
  cwd: string;
  /**
   * Test injection: override fs operations. realpathSync is included so
   * fixtures can simulate symlinks-with-same-target without actually
   * creating cross-tmpdir symlinks (which surface differently on macOS
   * and Linux because of /tmp -> /private/tmp resolution).
   */
  fsInterface?: Pick<typeof fs, "existsSync" | "statSync" | "lstatSync" | "readdirSync" | "realpathSync">;
}

const ROGUE_DIRNAME = "~";
const LEDGER_RELPATH = path.join(".evidence-ledger", "ledger.db");

function hasRogueLedgerUnder(
  parent: string,
  fsi: NonNullable<RogueLedgerScanOptions["fsInterface"]>,
): RogueLedgerDb | null {
  // lstat (not stat) the `~` dir: a symlink at <parent>/~ pointing at
  // /etc or at the real ~/.evidence-ledger would otherwise yield a
  // false-positive flag (read-only, no security impact, but the
  // operator gets nudged to rm -rf an arbitrary target). The orphan
  // pattern we care about is a *real* literal-tilde directory.
  const rogueDir = path.join(parent, ROGUE_DIRNAME);
  if (!fsi.existsSync(rogueDir)) return null;
  try {
    if (fsi.lstatSync(rogueDir).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const candidate = path.join(rogueDir, LEDGER_RELPATH);
  if (!fsi.existsSync(candidate)) return null;
  try {
    if (!fsi.statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return { path: candidate, rogueDir };
}

/**
 * Dedup key for a hit: prefer the realpath of the ledger.db file so two
 * parent dirs that symlink to the same physical location collapse into a
 * single hit. Falls back to the joined path when realpath is unavailable
 * (EACCES on a strict-mode mount, ENOENT during a race with deletion).
 * The fallback preserves the v1 dedup behavior so existing fixtures
 * stay stable.
 */
function dedupKey(
  hit: RogueLedgerDb,
  fsi: NonNullable<RogueLedgerScanOptions["fsInterface"]>,
): string {
  try {
    return fsi.realpathSync(hit.path);
  } catch {
    return hit.path;
  }
}

/**
 * Walk a small set of well-known parent directories for a literal `~`
 * subdirectory that contains `.evidence-ledger/ledger.db`. Best-effort:
 * unreadable directories are silently skipped. Returns deduplicated
 * results (by realpath) sorted by path for stable rendering.
 */
export function scanForRogueLedgers(opts: RogueLedgerScanOptions): RogueLedgerDb[] {
  const fsi = opts.fsInterface ?? fs;
  const seen = new Set<string>();
  const out: RogueLedgerDb[] = [];

  const consider = (parent: string): void => {
    const hit = hasRogueLedgerUnder(parent, fsi);
    if (!hit) return;
    const key = dedupKey(hit, fsi);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(hit);
  };

  consider(opts.homeDir);
  consider(opts.cwd);

  const gitParent = path.join(opts.homeDir, "git");
  if (fsi.existsSync(gitParent)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fsi.readdirSync(gitParent, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      consider(path.join(gitParent, e.name));
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup: deleteRogueLedgers
// ---------------------------------------------------------------------------

export interface DeleteRogueLedgersOptions {
  /**
   * When true, skip per-hit confirmation prompts and delete immediately.
   * Maps to `harness doctor --rm-rogue-ledgers --yes`.
   */
  yes?: boolean;
  /**
   * Test injection: called per hit with the rogueDir path; returns true to
   * confirm deletion, false to skip. When omitted and `yes` is false,
   * production code prompts via readline on stdin.
   * Same knob pattern as `mcpProbe` / `fsInterface` elsewhere in doctor.
   */
  promptFn?: (rogueDir: string) => Promise<boolean>;
}

export interface DeleteRogueLedgersResult {
  /** Hits that were confirmed and whose rogueDir was removed. */
  deleted: RogueLedgerDb[];
  /** Hits that were skipped (operator declined or safety check failed). */
  skipped: RogueLedgerDb[];
}

/**
 * Delete confirmed rogue ledger directories.
 *
 * Safety invariant: only deletes `hit.rogueDir` (the literal-tilde `~`
 * directory), never its parent. Any hit whose rogueDir basename is not
 * exactly `~` is silently skipped as a belt-and-suspenders guard.
 */
export async function deleteRogueLedgers(
  hits: RogueLedgerDb[],
  opts: DeleteRogueLedgersOptions = {},
): Promise<DeleteRogueLedgersResult> {
  const deleted: RogueLedgerDb[] = [];
  const skipped: RogueLedgerDb[] = [];

  for (const hit of hits) {
    // Safety: only ever remove a directory whose basename is the literal `~`.
    if (path.basename(hit.rogueDir) !== "~") {
      skipped.push(hit);
      continue;
    }

    let confirmed: boolean;
    if (opts.yes) {
      confirmed = true;
    } else if (opts.promptFn) {
      confirmed = await opts.promptFn(hit.rogueDir);
    } else {
      confirmed = await defaultDeletePrompt(hit.rogueDir);
    }

    if (confirmed) {
      fs.rmSync(hit.rogueDir, { recursive: true });
      deleted.push(hit);
    } else {
      skipped.push(hit);
    }
  }

  return { deleted, skipped };
}

async function defaultDeletePrompt(rogueDir: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Delete rogue directory ${rogueDir}? (y/N) `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
