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
// Scan scope is bounded by design — the literal `~` directory only ever
// appears one level deep under wherever grounding-mcp was spawned. The
// well-known spawn-cwd locations are: $HOME (when claude-code spawns from
// the user's home), $HOME/git/<repo> (the per-repo working tree), and
// $PWD (whatever directory the operator invoked harness from). No
// recursion past one level: we are not a generic disk-cleanup tool.

import * as fs from "node:fs";
import * as path from "node:path";

export interface RogueLedgerDb {
  /** Absolute path to the rogue ledger.db file. */
  path: string;
  /** Absolute path to the rogue `~` directory (the cleanup target). */
  rogueDir: string;
}

export interface RogueLedgerScanOptions {
  homeDir: string;
  cwd: string;
  /** Test injection: override the fs interface. */
  fsInterface?: Pick<typeof fs, "existsSync" | "statSync" | "readdirSync">;
}

const ROGUE_DIRNAME = "~";
const LEDGER_RELPATH = path.join(".evidence-ledger", "ledger.db");

function hasRogueLedgerUnder(
  parent: string,
  fsInterface: NonNullable<RogueLedgerScanOptions["fsInterface"]>,
): RogueLedgerDb | null {
  const rogueDir = path.join(parent, ROGUE_DIRNAME);
  const candidate = path.join(rogueDir, LEDGER_RELPATH);
  if (!fsInterface.existsSync(candidate)) return null;
  try {
    if (!fsInterface.statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return { path: candidate, rogueDir };
}

/**
 * Walk a small set of well-known parent directories for a literal `~`
 * subdirectory that contains `.evidence-ledger/ledger.db`. Best-effort:
 * unreadable directories are silently skipped. Returns deduplicated
 * results sorted by path for stable rendering.
 */
export function scanForRogueLedgers(opts: RogueLedgerScanOptions): RogueLedgerDb[] {
  const fsi = opts.fsInterface ?? fs;
  const seen = new Set<string>();
  const out: RogueLedgerDb[] = [];

  const consider = (parent: string): void => {
    const hit = hasRogueLedgerUnder(parent, fsi);
    if (!hit) return;
    if (seen.has(hit.path)) return;
    seen.add(hit.path);
    out.push(hit);
  };

  consider(opts.homeDir);
  consider(opts.cwd);

  const gitParent = path.join(opts.homeDir, "git");
  if (fsi.existsSync(gitParent)) {
    let entries: fs.Dirent[] | string[] = [];
    try {
      entries = fsi.readdirSync(gitParent, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const name = typeof e === "string" ? e : e.name;
      const isDir =
        typeof e === "string"
          ? (() => {
              try {
                return fsi.statSync(path.join(gitParent, name)).isDirectory();
              } catch {
                return false;
              }
            })()
          : e.isDirectory();
      if (!isDir) continue;
      consider(path.join(gitParent, name));
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
