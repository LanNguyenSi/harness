// Duplication fitness function (task 19e293c6). Runs jscpd over src/ and
// fails when the clone count exceeds the pinned baseline — the guard that
// would have caught the 4th parseConfigUx copy (the CHANGELOG had flagged
// the 3rd copy for extraction; the 4th landed unnoticed because nothing
// scanned for duplication).
//
// Why a COUNT pin instead of jscpd's percentage threshold: the repo's
// pre-existing duplication baseline is ~3% of lines across 82 clones, so a
// new ~16-line copy moves the percentage by hundredths — far inside any
// sane threshold's noise band. The absolute clone count moves by >= 1 per
// new copy, which is exactly the signal we want.
//
// Maintaining the pin:
//   - Added a genuine new duplicate? Extract it instead (or, if the
//     duplication is deliberate, raise MAX_CLONES in the same PR with a
//     one-line justification — that raise is the conscious act this gate
//     exists to force).
//   - Removed duplication? Lower MAX_CLONES to the new count so the
//     headroom does not silently accumulate (the script prints the current
//     count on every run).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_CLONES = 82; // baseline 2026-07-02, post parseConfigUx extraction

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-jscpd-"));
try {
  const result = spawnSync(
    "npx",
    [
      "jscpd",
      "src",
      "--min-tokens",
      "50",
      "--min-lines",
      "8",
      "--ignore",
      "**/*.test.ts",
      "--reporters",
      "json",
      "--output",
      outDir,
      "--silent",
    ],
    { encoding: "utf8" },
  );
  if (result.error) {
    console.error(`check-duplication: jscpd failed to spawn: ${result.error.message}`);
    process.exit(1);
  }
  const reportPath = path.join(outDir, "jscpd-report.json");
  if (!fs.existsSync(reportPath)) {
    console.error(
      `check-duplication: jscpd produced no report at ${reportPath}` +
        `${result.stderr ? `; stderr: ${result.stderr.slice(0, 500)}` : ""}`,
    );
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const clones = Array.isArray(report.duplicates) ? report.duplicates.length : NaN;
  if (Number.isNaN(clones)) {
    console.error("check-duplication: unexpected report shape (no duplicates[])");
    process.exit(1);
  }
  if (clones > MAX_CLONES) {
    console.error(
      `check-duplication: FAIL — ${clones} clones in src/, pinned baseline is ${MAX_CLONES}.` +
        ` Extract the new duplication (see the newest entries in the jscpd output),` +
        ` or raise MAX_CLONES in scripts/check-duplication.mjs with a justification.`,
    );
    const newest = report.duplicates.slice(-3);
    for (const d of newest) {
      console.error(
        `  clone: ${d.firstFile?.name}:${d.firstFile?.start} <-> ${d.secondFile?.name}:${d.secondFile?.start} (${d.lines} lines)`,
      );
    }
    process.exit(1);
  }
  const slack = MAX_CLONES - clones;
  console.log(
    `check-duplication: OK — ${clones} clones (pin ${MAX_CLONES}${
      slack > 0 ? `; consider lowering the pin by ${slack}` : ""
    })`,
  );
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
