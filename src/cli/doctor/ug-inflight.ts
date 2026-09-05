// Doctor visibility for in-flight subagent records (subagent-gate
// slice 1, docs/decisions/2026-08-27-ug-auto-mode-approval.md
// "Invariants", "Threat model", "Delegation marker shape"): "in-flight
// subagent records on disk: <count> (<count> stale)" from
// `<generatedDir>/.inflight/`, distinct from the `.delegations/`
// listing in `ug-delegations.ts` and the `.approvals/` one in
// `ug-auto-approvals.ts`.
//
// Thin wrapper around `listInflightRecords`, which already owns the
// filesystem walk, the staleness computation and the tolerant-of-
// debris posture; this file only shapes that result into the section
// `harness doctor`'s report type expects, mirroring how
// `ug-delegations.ts` sits beside `delegation-markers.ts`'s own reader.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  INFLIGHT_RECORD_DIRNAME,
  listInflightRecords,
} from "../../policy-packs/builtin/understanding-before-execution/index.js";

export interface UgInflightSection {
  /** Whether `<generatedDir>/.inflight/` exists at all. */
  inflightDirPresent: boolean;
  /** Records found and readable, across every session directory. */
  total: number;
  /**
   * Of `total`, how many have an `approvedAt` older than the staleness
   * window, or dated implausibly far in the future (clock skew or
   * tampering — this is an audit listing, not a trust decision, so
   * either counts as stale, mirroring `listInflightRecords`'s own doc).
   */
  stale: number;
  /** Entries gc/doctor could not make sense of (debris, unreadable, missing/bad approvedAt). */
  skipped: number;
}

function emptySection(): UgInflightSection {
  return { inflightDirPresent: false, total: 0, stale: 0, skipped: 0 };
}

/**
 * Build the in-flight-records-on-disk doctor metric. Pure filesystem
 * read, never throws: a missing or empty `.inflight/` resolves to a
 * zero-ish section, mirroring `buildUgDelegations`. `inflightDirPresent`
 * is the only field that tells "missing" and "present but empty" apart,
 * same convention `delegationsDirPresent` follows — doctor's render
 * layer uses it to stay silent when there is truly nothing on disk.
 *
 * lstat, not `existsSync` (which follows a symlink to whatever it
 * points at): a symlinked `.inflight/` reads as absent here, the same
 * way a symlinked record file already reads as absent one level down.
 * Still needed even though `listInflightRecords` now applies the same
 * lstat guard internally: this function's own check is what decides
 * `inflightDirPresent`, a flag `listInflightRecords`'s return shape has
 * no room for, and that doctor's render layer needs to tell "absent"
 * apart from "present but empty".
 */
export function buildUgInflight(generatedDir: string, opts: { now?: Date } = {}): UgInflightSection {
  const dir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return emptySection();
  }
  if (!stat.isDirectory()) {
    return emptySection();
  }
  const result = listInflightRecords(generatedDir, opts.now);
  return {
    inflightDirPresent: true,
    total: result.total,
    stale: result.stale,
    skipped: result.skipped.length,
  };
}
