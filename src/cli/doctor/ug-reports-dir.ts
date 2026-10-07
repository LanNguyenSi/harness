// Doctor visibility for the understanding-gate reports directory
// (`.understanding-gate/reports/`): a warning as the directory approaches
// the size the PreToolUse gate is willing to read, and a louder one once it
// is past it. Past the bound the gate reads nothing and denies every
// marker-approved call fail closed (see MAX_HOOK_LISTING_ENTRIES), and
// `harness approve understanding` cannot fix that, so the operator wants to
// hear about it before the lockout, not from the deny text.
//
// The count is bounded: the directory is agent-writable, so this walks it
// one entry at a time through `fs.opendirSync` and stops as soon as either
// gate bound is crossed, instead of listing a directory of any size. No entry
// is opened or stat'ed, so the byte budget the gate also enforces (32 MiB of
// report data) is NOT measured here; it needs one stat per entry and a
// directory that holds that much data in under the entry bound is unusual
// (real reports are a few kilobytes).

import * as fs from "node:fs";
import {
  HOOK_LISTING_SCAN_FACTOR,
  MAX_HOOK_LISTING_ENTRIES,
} from "../../policy-packs/builtin/understanding-before-execution/persisted-reports.js";

/** Share of a gate bound (entries, or entries of any name) at which doctor starts to warn. */
export const REPORTS_DIR_WARN_RATIO = 0.75;

export type UgReportsDirState = "ok" | "near" | "over";

export interface UgReportsDirSection {
  /** The reports directory checked. */
  dir: string;
  /** Whether it exists and could be opened. */
  present: boolean;
  /** `*.json` entries counted; at most `bound + 1` (counting stops once the bound is crossed). */
  jsonEntries: number;
  /** Entries of any name iterated; at most `scanBound + 1`. */
  scannedEntries: number;
  /** The gate's `*.json` entry bound (MAX_HOOK_LISTING_ENTRIES). */
  bound: number;
  /** The gate's any-name scan bound. */
  scanBound: number;
  /** `*.json` count at which doctor starts to warn (75 % of `bound`). */
  warnAt: number;
  /** Any-name count at which doctor starts to warn (75 % of `scanBound`). */
  scanWarnAt: number;
  /** `over`: the gate already refuses this directory. `near`: at or past the warn thresholds. */
  state: UgReportsDirState;
}

/**
 * Measure `dir` against the gate's listing bounds. Pure read, never throws:
 * a missing or unreadable directory is `present: false`, `state: "ok"`.
 */
export function buildUgReportsDir(dir: string): UgReportsDirSection {
  const bound = MAX_HOOK_LISTING_ENTRIES;
  const scanBound = bound * HOOK_LISTING_SCAN_FACTOR;
  const warnAt = Math.ceil(bound * REPORTS_DIR_WARN_RATIO);
  const scanWarnAt = Math.ceil(scanBound * REPORTS_DIR_WARN_RATIO);
  const section: UgReportsDirSection = {
    dir,
    present: false,
    jsonEntries: 0,
    scannedEntries: 0,
    bound,
    scanBound,
    warnAt,
    scanWarnAt,
    state: "ok",
  };
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return section;
  }
  section.present = true;
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      section.scannedEntries += 1;
      if (entry.name.endsWith(".json")) section.jsonEntries += 1;
      if (section.scannedEntries > scanBound || section.jsonEntries > bound) break;
    }
  } catch {
    // A read error mid-walk leaves the partial count; it only under-reports.
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Already gone; nothing left to release.
    }
  }
  if (section.jsonEntries > bound || section.scannedEntries > scanBound) {
    section.state = "over";
  } else if (section.jsonEntries >= warnAt || section.scannedEntries >= scanWarnAt) {
    section.state = "near";
  }
  return section;
}
