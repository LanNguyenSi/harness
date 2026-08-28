// Doctor visibility for slice 3 delegations (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Audit and
// doctor", agent-tasks 37ad0b05 T-004): "delegations on disk: <count>
// (<count> expired)" from `<generatedDir>/.delegations/`, distinct from
// the `.approvals/` auto-approval listing in `ug-auto-approvals.ts`.
//
// SEPARATE DIRECTORY, DELIBERATELY: a delegation never lands in
// `.approvals/` (delegation-markers.ts's module header), so this scan
// reads `DELEGATION_MARKER_DIRNAME` (".delegations") only and never
// touches the approvals directory `ug-auto-approvals.ts` owns. Mirrors
// that module's read-only-audit shape (no signature verification here
// either; a forged delegation still gets rejected by the dedicated
// verifier at gate time, `delegation-markers.ts`'s `verifyDelegation`)
// but does not share its code: the two scans read different
// directories, filter differently (no task-marker / branch-protection
// prefix skip here), and count differently (an approval count vs. an
// expiry count), so a shared helper would mostly be parameters threading
// through an otherwise-empty shell. `npm run check:duplication` is the
// backstop if that stops being true.

import * as fs from "node:fs";
import * as path from "node:path";
import { readRegularFileRejectingSymlink } from "../../io/read-regular-file.js";
import { safeJsonParse } from "../../io/safe-json-parse.js";
import {
  DELEGATION_MARKER_DIRNAME,
  parseDelegationApprovedBy,
} from "../../policy-packs/builtin/understanding-before-execution/index.js";

export interface UgDelegationsSection {
  /** Whether `<generatedDir>/.delegations/` exists at all. */
  delegationsDirPresent: boolean;
  /** Delegation files found in `.delegations/`, readable or not. */
  total: number;
  /** Of `total`, how many parsed with an `expires` segment in the past. */
  expired: number;
  /** Of `total`, how many were not valid JSON, or failed `parseDelegationApprovedBy`. */
  unreadable: number;
}

function emptySection(): UgDelegationsSection {
  return { delegationsDirPresent: false, total: 0, expired: 0, unreadable: 0 };
}

/**
 * A delegation filename is always a session id: a UUID handed out by
 * Claude Code or Codex, or (in this repo's own test fixtures) a short
 * alnum/hyphen placeholder. Neither ever contains a literal `.` or
 * starts with one. Filtering on that BEFORE the read is what keeps
 * filesystem debris that happens to sit next to `.delegations/` files
 * (macOS's `.DS_Store`, a stray `foo.txt`) from counting toward `total`
 * at all: without it, such a file reads as valid-but-not-JSON and rolls
 * into `unreadable`, which flips this metric's doctor line from
 * informational (ℹ) straight to a WARNING (⚠) for debris that was never
 * a delegation to begin with. Mirrors the same non-empty/no-traversal
 * shape family `rejectMalformedSessionId` pins for a delegation's own
 * filename on the write side (`delegationMarkerPathFor`), tightened to
 * additionally exclude a dot, which is the part that actually
 * discriminates a stray dotfile from a real session id.
 */
const SESSION_ID_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Build the delegations-on-disk doctor metric. Pure filesystem read;
 * never throws for "nothing to see" states (missing `.delegations/`,
 * empty directory, every file unreadable), those all resolve to a
 * zero-ish section, mirroring `buildUgAutoApprovals`. `total`/`expired`/
 * `unreadable` read `0` for both an EMPTY and a MISSING directory; only
 * `delegationsDirPresent` tells them apart, the same way
 * `approvalsDirPresent` does for `buildUgAutoApprovals`, doctor's
 * render layer uses it to stay silent when there is truly nothing on
 * disk (`format.ts`'s own "no line for a check that found nothing"
 * convention) while still rendering the zero-count line for a
 * `harness delegate`-touched, now-empty directory.
 */
export function buildUgDelegations(
  generatedDir: string,
  opts: { now?: Date } = {},
): UgDelegationsSection {
  const now = opts.now ?? new Date();
  const dir = path.join(generatedDir, DELEGATION_MARKER_DIRNAME);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return emptySection();
  }

  let total = 0;
  let expired = 0;
  let unreadable = 0;

  for (const d of dirents) {
    // Not a session-id-shaped basename: never a delegation file (a
    // stray dotfile, an extensioned file, ...), skip before even
    // reading it. The `adopted/` subdirectory's own name IS shaped like
    // a session id and passes this filter, but its dirent is a
    // directory, so it falls through to the `not-regular` skip below,
    // same as any other directory would.
    if (!SESSION_ID_BASENAME_RE.test(d.name)) continue;

    const full = path.join(dir, d.name);
    const read = readRegularFileRejectingSymlink(full);
    // A symlink / non-regular / raced-away entry is not a delegation
    // file this metric owns an opinion about; skip silently, same
    // reasoning as `buildUgAutoApprovals`.
    if (read.kind === "symlink" || read.kind === "not-regular" || read.kind === "missing") {
      continue;
    }
    total++;
    if (read.kind === "unreadable") {
      unreadable++;
      continue;
    }
    const parsed = safeJsonParse(read.content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      unreadable++;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const segments = parseDelegationApprovedBy(obj["approvedBy"]);
    if (!segments.ok) {
      unreadable++;
      continue;
    }
    if (Date.parse(segments.value.expiresAt) <= now.getTime()) {
      expired++;
    }
  }

  return { delegationsDirPresent: true, total, expired, unreadable };
}
