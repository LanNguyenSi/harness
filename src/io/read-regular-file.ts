import * as fs from "node:fs";

/**
 * Result of a symlink-rejecting regular-file read. The kinds are deliberately
 * fine-grained because the gate readers need to keep their distinct deny
 * details (missing vs symlink vs not-regular) and one caller treats
 * exists-but-unreadable as "existence already satisfied the gate".
 */
export type RegularFileRead =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "not-regular" }
  | { kind: "unreadable" };

/**
 * Result of a stat-only existence probe (see `probeRegularFilePresence`). No
 * `content`: this never reads the file, only classifies what lstat sees at
 * the path. `present` covers a symlink, a directory, or any other non-regular
 * node the caller wants to treat as "something is there" without yet reading
 * it or deciding whether it is a valid regular file.
 */
export type RegularFilePresence = { kind: "missing" } | { kind: "present" };

/**
 * Read a marker/verdict file as utf8, refusing symlinks and non-regular
 * files. lstat (NOT stat): defense-in-depth against a symlink at the marker
 * path pointing at an arbitrary target the agent controls. In today's threat
 * model the agent has no Edit / Write / Bash path to plant such a symlink
 * (the same PreToolUse hook gates all three), but the gate contract is to
 * assume the agent is hostile, so the lstat reject is cheap insurance
 * (agent-tasks/d39f160e).
 *
 * This is THE shared implementation for every gate-marker read; a future
 * defensive fix (e.g. closing the lstat/read race with O_NOFOLLOW, ENOTDIR
 * handling) belongs here and nowhere else. Its lighter-weight sibling
 * `probeRegularFilePresence`, below, shares this file for the same reason:
 * both stand on the same single `fs.lstatSync` call, and a caller that only
 * needs to know "is anything there" before deciding whether to pay for the
 * full read (e.g. `verifyDelegation`'s existence-before-path-hash check in
 * `src/policy-packs/builtin/understanding-before-execution/delegation-markers.ts`)
 * gets that from here instead of hand-rolling its own `lstatSync` try/catch.
 */
export function readRegularFileRejectingSymlink(filePath: string): RegularFileRead {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { kind: "missing" };
  }
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "not-regular" };
  try {
    return { kind: "ok", content: fs.readFileSync(filePath, "utf8") };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Stat-only existence probe: "is anything there", nothing more. Uses the
 * same `lstatSync` (not `stat`) as `readRegularFileRejectingSymlink` so a
 * symlink or a directory answers `present`, not `missing` — this probe
 * cannot and does not classify WHAT is there (regular file, symlink,
 * directory), only whether lstat can see anything at all. A path lstat
 * cannot reach for any reason (absent, or unreachable: `EACCES`, `ENOTDIR`,
 * ...) comes back `missing`; lstat cannot distinguish those cases, so
 * neither does this probe. Callers that need the file-type distinction
 * (symlink vs directory vs regular) read the file instead, through
 * `readRegularFileRejectingSymlink`.
 */
export function probeRegularFilePresence(filePath: string): RegularFilePresence {
  try {
    fs.lstatSync(filePath);
    return { kind: "present" };
  } catch {
    return { kind: "missing" };
  }
}
