// Shared by the gate tests that only make sense on a volume where
// `Config.toml` and `config.toml` are one name.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Whether the volume under `dir` (the temp dir by default) treats names that differ only in letter case
 * as one. The probe file lives in a directory of its own, created for this call and removed after it, so
 * nothing else running in `dir` can see it or race with it. */
export function foldsCase(dir: string = os.tmpdir()): boolean {
  const probeDir = fs.mkdtempSync(path.join(dir, "harness-case-probe-"));
  try {
    fs.writeFileSync(path.join(probeDir, "probe.tmp"), "");
    return fs.existsSync(path.join(probeDir, "PROBE.TMP"));
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}
