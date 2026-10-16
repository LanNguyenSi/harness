import * as fs from "node:fs";
import { listCodexSnapshots } from "../../../src/cli/gate/codex-snapshot.js";

/** Runs `install` the way an installer that predates the snapshot supersede
 * would: the live Codex gate snapshots beside `dir` are put back exactly as
 * they were afterwards. The gate's own dating of a snapshot by the installer's
 * backup files (the second line of defence) is exercised through this. */
export function asLegacyInstall(dir: string, install: () => void): void {
  const before = new Map(listCodexSnapshots(dir).map((p) => [p, fs.readFileSync(p)] as const));
  install();
  for (const [p, body] of before) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, body);
    fs.rmSync(p.replace(/\.json$/, ".superseded.json"), { force: true });
  }
}
