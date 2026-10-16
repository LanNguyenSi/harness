import * as fs from "node:fs";
import * as path from "node:path";
import { gateDisable } from "../../src/cli/gate/disable.js";

/**
 * Rewrites a snapshot the way a release before merging wrote it: version 1,
 * no `step` on the removed groups, no `merges`.
 */
export function downgradeToVersion1(snapPath: string): void {
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8")) as Record<string, unknown>;
  snap["version"] = 1;
  delete snap["merges"];
  snap["removed"] = (snap["removed"] as Array<Record<string, unknown>>).map((r) => {
    const { step: _step, ...rest } = r;
    return rest;
  });
  fs.writeFileSync(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
}

/**
 * Builds what two disables left behind before they merged: one version 1
 * snapshot per disable, both live. The first snapshot is parked while the
 * second disable runs, so the second starts fresh and its pre-disable state
 * is the first one's post-disable state. Returns the snapshot paths, oldest
 * first.
 */
export function writeLegacyChain(
  settingsPath: string,
  first: { matcher: string; now: Date },
  second: { matcher: string; now: Date },
): [string, string] {
  const a = gateDisable({ settingsPath, matcher: first.matcher, now: first.now });
  if (a.mode !== "remove") throw new Error("expected remove");
  const parked = `${a.snapshotPath}.parked`;
  fs.renameSync(a.snapshotPath, parked);
  const b = gateDisable({ settingsPath, matcher: second.matcher, now: second.now });
  if (b.mode !== "remove") throw new Error("expected remove");
  fs.renameSync(parked, a.snapshotPath);
  downgradeToVersion1(a.snapshotPath);
  downgradeToVersion1(b.snapshotPath);
  return [a.snapshotPath, b.snapshotPath];
}

/** The live snapshot files beside a settings file, by name. */
export function liveSnapshotNames(settingsPath: string): string[] {
  return fs
    .readdirSync(path.dirname(settingsPath))
    .filter((n) => n.startsWith("harness.gate-disable.") && !n.endsWith(".restored.json") && n.endsWith(".json"))
    .sort();
}

/** The retired snapshot files beside a settings file, by name. */
export function retiredSnapshotNames(settingsPath: string): string[] {
  return fs
    .readdirSync(path.dirname(settingsPath))
    .filter((n) => n.startsWith("harness.gate-disable.") && n.endsWith(".restored.json"))
    .sort();
}
