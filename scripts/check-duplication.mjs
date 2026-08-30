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
// Raised to 102 for the `post-merge-gate` builtin policy pack (agent-tasks
// d368e30d): its two new CLI hook verbs (`cli/pack/hook-post-merge-gate.ts`
// / `hook-post-merge-gate-record.ts`) and their `cli/index.ts` command
// registration deliberately mirror the SAME pre-existing patterns the two
// prior raises above already tolerate — the `--config`/`--project`/
// `--ledger-timeout`/`--cwd` option-parsing + action-body shape shared by
// `branch-protection` / `solution-acceptance` / `codex-pre-tool-use`'s CLI
// wiring in `cli/index.ts`, and the `findGroundingMcp` + ledger-probe
// boilerplate `hook-branch-protection.ts` / `hook-solution-acceptance.ts`
// already duplicate against each other. Checked first (per the review
// brief) whether the two new files duplicate EACH OTHER — they do not:
// every one of the 8 newly-reported clone pairs is against a DIFFERENT
// pre-existing sibling-pack file, so no shared helper between just the two
// new verbs would remove any of them. Deduping any of them means touching
// an existing sibling pack's file, out of this task's scope (same
// rationale as the reseed.ts / toolchain-parity precedents above).
// Raised to 103 for the risk-gate read-only floor (agent-tasks fb67b402),
// and this one is NOT new copy-paste — verified rather than assumed. That
// task adds a `cd`-target pre-check plus a quote-stripping helper near the
// top of `cli/pack/hook-solution-acceptance-writeguard.ts`. Diffing the
// full jscpd clone set against master shows 3 pairs appearing and 2
// disappearing, net +1, and all 3 new pairs are that file's PRE-EXISTING
// sibling-hook boilerplate — `pathToolTarget` / `bashCommandOf` / the CLI
// runner body — matched against `hook-branch-protection.ts` and
// `hook-post-merge-gate-record.ts`. None of them covers a line this task
// wrote. The added lines shifted the file's contents, which moved jscpd's
// windows and re-partitioned the same duplicated boilerplate into a
// different set of reported pairs. So there is nothing here to extract
// that was not already there: the underlying duplication is the same
// sibling-pack hook cluster the three raises above already tolerate, and
// deduping it means touching an existing sibling pack's file, out of this
// task's scope.
// Raised to 111 for the stale-base-check SessionStart companion (task
// ce3903b0, incident ea8becf5; `src/cli/session-start/stale-base-check.ts`
// + its `cli/index.ts` wiring) — the SAME toolchain-parity-precedent
// cluster above, a 4th instance now instead of a 3rd. Verified (not
// assumed) by diffing the full jscpd `duplicates[]` set against master as
// a MULTISET keyed on `(firstFile, secondFile, lines)` (ignoring exact
// line offsets, since inserting the new file/CLI block shifts every later
// line number in `cli/index.ts` without changing its content — same
// window-shift effect the 103 raise above documents): master has 103
// entries, this branch has 111, net +8, which decomposes as:
//   +9  `cli/session-start/stale-base-check.ts` paired against
//       `branch-check.ts` / `toolchain-parity.ts` / `policy/intercept.ts`
//       — the exact SessionStart-producer + `execGit`/spawn-wrapper
//       boilerplate shape those three already duplicate against each
//       other.
//   +2  a 4th `cli/index.ts`-internal repeat of the `--config`/
//       `--project`/`--session`/`--cwd`/`--ledger-timeout` option-parsing
//       block the toolchain-parity raise above already tolerates 3
//       copies of.
//   -3  PRE-EXISTING `branch-check.ts` <-> `toolchain-parity.ts` /
//       `policy/intercept.ts` <-> `toolchain-parity.ts` pairs that
//       shrank, merged into a longer window, or disappeared in the same
//       diff — jscpd re-partitioning its match windows now that a third
//       near-identical file exists, not new duplication (same
//       re-windowing effect the 103 raise above documents).
// (+9 +2 -3 = +8.) Zero net-new entries fall outside the tolerated
// cluster. Extracting a shared base would mean touching three existing
// sibling files, out of this task's scope (same rationale as every raise
// above).
// 111 -> 110 after the slice-4 io/ relocation: the -1 is a jscpd scan-order
// re-pairing in the ledger-add/ledger-client/ledger-record cluster (io/ sorts
// before policies/), not removed duplication.
// 110 -> 109 after the master-baseline fixture deletion, task 62fa0542.
// 109 -> 110 -> 109 (task d03af8f6, review round 2): round 1 raised this
// to 110 for a `deletion-target-resolve.ts` <-> `kubectl-target-parse.ts`
// clone pair (a duplicated `firstSegment`/`tokenize` tokenizer). Round 2
// closed that pair instead of tolerating it: `kubectl-target-parse.ts`'s
// `firstSegment` is now exported (a pure visibility change, no logic
// touched) and imported by `deletion-target-resolve.ts`, and that
// module's own tokenizer was rewritten around `decodeShellWord` (a
// genuinely different implementation, not a copy) for the LOW (b)
// obfuscated-flag fix. Verified (not assumed) by re-running this script:
// 109 clones, back at the pre-d03af8f6 baseline.
// Raised to 111 for the F8 reference check in `cli/remove/index.ts`
// (99f47307 Slice 1, review round 2): a hook referenced only by a
// workflows[]-derived merge gate now gets the same "refuse without
// --force" pre-check hand-authored `policies:` references already get,
// which meant adding a new import block plus a `derivedGate
// ReferencingWorkflows` helper near the top of the file. Verified (not
// assumed) by diffing the full jscpd `duplicates[]` set against this
// branch's pre-review-round-2 commit as a MULTISET keyed on
// `(firstFile, secondFile, lines)` (ignoring exact line offsets, same
// window-shift effect the 103/111 raises above document): 109 entries
// before, 111 after, net +2, which decomposes as:
//   +2 `cli/pack/reseed.ts` <-> `cli/remove/index.ts` (11 and 13 lines) —
//      a NEW pairing. `reseed.ts` is the SAME file the task 68b9ad9c raise
//      above already named as sharing the add/remove/pack-add/pack-remove
//      `--config`/`--project`/validate-lock-diff-write import + CLI-body
//      shape; `remove/index.ts`'s new import block and deny-block body
//      happen to fall into that same tolerated shape, so this is a 5th
//      member of an already-tolerated cluster, not a new KIND of
//      duplication.
//   +0 net from `cli/add/index.ts` <-> `cli/remove/index.ts` (3 pairs
//      before, 3 after; one pair's line count shifted 12 -> 13 as the
//      new lines moved jscpd's match window, the other two are
//      unchanged) — re-windowing, not new duplication.
// (+2 +0 = +2.) Zero net-new entries fall outside the tolerated
// add/remove/pack-add/pack-remove/reseed cluster. Extracting a shared
// base would mean touching `cli/add/index.ts` and `cli/pack/reseed.ts`,
// out of this task's scope (allowed_changes restricts this slice to
// `cli/remove/**`); same rationale as every raise above.
// Raised to 113 for `cli/pack/upgrade.ts` (task 8f637efd, review round 2
// fix F1): the new verb's `resolveTargetPath`/`DEFAULT_BASENAME`/
// `LOCK_BASENAME` setup and its schema-gate-before-write block are the
// SAME `resolveTargetPath`/validate-lock-diff-write shape the
// 68b9ad9c/99f47307 raises above already tolerate across
// `cli/add/index.ts`, `cli/remove/index.ts`, `cli/pack/add.ts`, and
// `cli/pack/reseed.ts` without extraction; `upgrade.ts` is a 6th member
// of that pre-existing cluster, not a new kind of duplication. Verified
// (not assumed) by diffing the full jscpd `duplicates[]` set against
// this same commit with only the F1(a) `readJsonDirEntriesRejectingSymlinks`
// extraction applied (114 -> 113 clones, the one pair this task's own
// `permission-mode-observations.ts` <-> `ug-auto-approvals.ts` readdir
// loop closed): the remaining two new pairs are `cli/add/index.ts:37`
// <-> `cli/pack/upgrade.ts:68` (9 lines) and `cli/pack/remove.ts:148`
// <-> `cli/pack/upgrade.ts:220` (16 lines), both inside the tolerated
// cluster shape, none of them a genuinely new copy. Extracting a shared
// base would mean touching `cli/add/index.ts`, `cli/pack/remove.ts`,
// `cli/pack/add.ts`, and `cli/pack/reseed.ts`, out of this task's scope
// (same rationale as every raise above).
// Review round 3 of task 8f637efd then closed one more pair (the observation
// reader's sanitisation split), measured 112, so the pin follows.
const MAX_CLONES = 112;

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
