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

// baseline 2026-07-02 (82), post parseConfigUx extraction; raised to 86 for
// task 68b9ad9c's new `cli/pack/reseed.ts`, which necessarily clones the
// validate/lock/diff/write shape already repeated (undeduped) across
// `cli/add/index.ts`, `cli/remove/index.ts`, `cli/pack/add.ts`, and
// `cli/pack/remove.ts` — a 5th instance of a pattern the codebase already
// tolerates 6 pairwise clones of rather than extracting a shared base;
// deduping all five is a repo-wide refactor out of scope for this task.
// Raised to 95 for the toolchain-parity SessionStart companion
// (src/cli/session-start/toolchain-parity.ts): its `harness session-start
// toolchain-parity` CLI wiring in cli/index.ts deliberately mirrors the
// `--config`/`--project`/`--session`/`--ledger-timeout` option-parsing
// shape `preflight` / `session-start preflight` / `session-start
// branch-check` already share verbatim (task brief: match the siblings'
// conventions exactly), so it joins that SAME pre-existing pairwise-clone
// cluster rather than introducing a new duplication pattern — one new
// member of an N-member cluster adds combinatorially more REPORTED pairs
// (all 9 new entries jscpd reports are within that cluster, none of them a
// genuinely new kind of copy-paste). Same tolerated category as the
// reseed.ts precedent above; extracting a shared base would mean touching
// the two existing sibling files too, out of this task's scope.
const MAX_CLONES = 95;

// Sets process.exitCode instead of calling process.exit so the caller's
// finally-cleanup runs on every path (process.exit skips stack unwinding).
function main(outDir) {
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
    process.exitCode = 1;
    return;
  }
  const reportPath = path.join(outDir, "jscpd-report.json");
  if (!fs.existsSync(reportPath)) {
    console.error(
      `check-duplication: jscpd produced no report at ${reportPath}` +
        `${result.stderr ? `; stderr: ${result.stderr.slice(0, 500)}` : ""}`,
    );
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const clones = Array.isArray(report.duplicates) ? report.duplicates.length : NaN;
  if (Number.isNaN(clones)) {
    console.error("check-duplication: unexpected report shape (no duplicates[])");
    process.exitCode = 1;
    return;
  }
  if (clones > MAX_CLONES) {
    console.error(
      `check-duplication: FAIL — ${clones} clones in src/, pinned baseline is ${MAX_CLONES}.` +
        ` Extract the new duplication (see the newest entries in the jscpd output),` +
        ` or raise MAX_CLONES in scripts/check-duplication.mjs with a justification.`,
    );
    for (const d of report.duplicates.slice(-3)) {
      console.error(
        `  clone: ${d.firstFile?.name}:${d.firstFile?.start} <-> ${d.secondFile?.name}:${d.secondFile?.start} (${d.lines} lines)`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const slack = MAX_CLONES - clones;
  console.log(
    `check-duplication: OK — ${clones} clones (pin ${MAX_CLONES}${
      slack > 0 ? `; consider lowering the pin by ${slack}` : ""
    })`,
  );
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-jscpd-"));
try {
  main(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
