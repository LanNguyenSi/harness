import fs from "node:fs";

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
 * handling) belongs here and nowhere else.
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
