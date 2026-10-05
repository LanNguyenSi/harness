#!/usr/bin/env node
// Differential measurement for the solution-acceptance write-guard's read-only
// `|` pipeline arm (tracker task 95a3712d). It replays the fixture table
// `tests/_helpers/writeguard-pipeline-matrix.ts` against TWO copies of the
// guard: a baseline extracted with `git archive <ref>` into a scratch
// directory (never a checkout, so the working tree is untouched) and the
// current working tree. It then checks, for every row:
//
//   1. the recorded `onMaster` verdict equals what the baseline decides,
//   2. the recorded `now` verdict equals what the working tree decides,
//   3. monotonicity: no `write` row that the baseline blocks is allowed now.
//
// Exit 0 only when all three hold for every row. The row count is printed,
// not assumed.
//
// Usage (needs the repo's own devDependencies, `tsx` loads the TypeScript):
//   npx tsx scripts/measure-writeguard-baseline.mjs [--base origin/master]
//
// The extracted baseline reuses this checkout's node_modules through a
// symlink; nothing is installed and nothing outside the scratch dir and this
// checkout is touched.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const baseRef = baseIdx >= 0 && args[baseIdx + 1] ? args[baseIdx + 1] : "origin/master";

const scratch = mkdtempSync(path.join(tmpdir(), "writeguard-baseline-"));
try {
  const archive = execFileSync("git", ["archive", baseRef, "src", "package.json"], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", scratch], { input: archive });
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(scratch, "node_modules"));

  const guardRel = "src/cli/pack/hook-solution-acceptance-writeguard.ts";
  const baseline = await import(pathToFileURL(path.join(scratch, guardRel)).href);
  const head = await import(pathToFileURL(path.join(repoRoot, guardRel)).href);
  const matrix = await import(
    pathToFileURL(path.join(repoRoot, "tests/_helpers/writeguard-pipeline-matrix.ts")).href
  );

  const verdict = (mod, command) =>
    mod.evaluateWriteGuard("Bash", { command }, matrix.MATRIX_DIR, matrix.MATRIX_CWD).blocked
      ? "blocked"
      : "allowed";

  let bad = 0;
  const flips = [];
  for (const row of matrix.PIPELINE_MATRIX) {
    const onBase = verdict(baseline, row.command);
    const onHead = verdict(head, row.command);
    const problems = [];
    if (onBase !== row.onMaster) problems.push(`recorded onMaster=${row.onMaster}, baseline=${onBase}`);
    if (onHead !== row.now) problems.push(`recorded now=${row.now}, head=${onHead}`);
    if (row.kind === "write" && onBase === "blocked" && onHead !== "blocked") {
      problems.push("MONOTONICITY: a write blocked on the baseline is allowed now");
    }
    if (onBase !== onHead) flips.push(`${onBase} -> ${onHead}  [${row.kind}] ${row.command}`);
    if (problems.length > 0) {
      bad += 1;
      console.error(`FAIL ${JSON.stringify(row.command)}: ${problems.join("; ")}`);
    }
  }
  console.log(`baseline ${baseRef}: ${matrix.PIPELINE_MATRIX.length} rows, ${bad} problem(s)`);
  console.log(`rows whose verdict differs between baseline and working tree (${flips.length}):`);
  for (const f of flips) console.log(`  ${f}`);
  process.exitCode = bad === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
