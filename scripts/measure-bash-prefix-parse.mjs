#!/usr/bin/env node
// Per-arm-gated measurement corpus for the Risk Gate's Bash prefix
// parser (task 47297478). Measures a CANDIDATE build of
// src/runtime/bash-prefix-parse.ts against real bash (the referee) and
// at least two BASELINE builds (typically master and the shipped
// release), reporting per separator arm: shapes, ran, bash-entered,
// baseline hits, lost honest targets, targets degraded to wrong,
// phantoms.
//
// WHY THE PER-ARM GATE EXISTS (the b093911d run, 2026-07-31): three
// consecutive measurement corpora reported "0 lost cd targets" while
// being structurally INCAPABLE of reporting a loss:
//   - Round 3: the separator-less arm rendered `A=xcd /tmp` (missing
//     space), so the only arm that could produce an honest target never
//     executed, and a non-writable cwd silently killed every redirect
//     shape. The output printed its own positive control as ZERO and
//     the run still reported "0 lost" as evidence.
//   - Round 4: well-formed, but sampled exactly the ONE spelling per
//     separator where the baseline is also null (`&` only unspaced,
//     `>` only in a shape that never ran).
// Countermeasure: for every separator arm and every baseline, count how
// many shapes the BASELINE produced a correct target for. An arm whose
// baseline never hit cannot evidence anything, is reported as NOT
// MEASURED, and is never folded into a total zero. A total that
// excludes such arms says so explicitly instead of printing a bare 0.
//
// Two residual weaknesses of the run-local ancestor
// (.ai/runs/2026-07-31-bash-prefix-parse-escapes/final-audit.mjs) are
// fixed here, both named by that run's reviewer:
//   (a) baselines were folded through an `else if` chain, so a shape
//       lost against BOTH baselines was counted once — every baseline
//       now keeps fully independent counters;
//   (b) a non-null-but-WRONG target was not counted at all — it is now
//       its own failure class and never a hit, for candidate and
//       baselines alike.
//
// Self-test (runs automatically before every measurement, or alone via
// --self-test): rebuilds the round-3 defect on purpose (missing space
// in the separator-less arm) and requires the gate to flag that arm as
// evidence-free instead of printing zeros. It also requires the healthy
// corpus to produce at least one measured arm and at least one executed
// redirect shape, so a broken environment (missing bash, non-writable
// cwd) fails loudly instead of producing silent nulls.
//
// Usage:
//   node scripts/measure-bash-prefix-parse.mjs --self-test
//   node scripts/measure-bash-prefix-parse.mjs \
//     --baseline master=<worktree>/dist/runtime/bash-prefix-parse.js \
//     --baseline shipped=<npm-pack>/dist/runtime/bash-prefix-parse.js \
//     [--candidate dist/runtime/bash-prefix-parse.js]
//
// The candidate defaults to this repo's own build (`npm run build`
// first). Runs offline. Corpus commands only ever execute a PATH shim
// inside a throwaway temp directory, never a real binary.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Every separator in BOTH spellings (with and without a following
// space), plus the separator-less arm " " (an assignment directly
// prefixing `cd` — the arm round 3 rendered broken, and the canonical
// honest-target arm). "(" is included knowingly: its shapes are bash
// syntax errors after an assignment prefix, so the arm reports itself
// as proving nothing instead of being quietly absent.
export const SEPARATOR_ARMS = [
  " ",
  ";", "; ",
  "&&", "&& ",
  "&", "& ",
  "||", "|| ",
  "|", "| ",
  ">o", ">o ",
  "<in", "<in ",
  "(", "( ",
];
export const HEADS = ["x", "prod", "'a b'", '"a b"', "a\\ b"];
export const TAILS = ["&&", ";"];

export const SABOTAGE_MISSING_SPACE = "missing-space";

/**
 * Build the corpus: one shape per (arm, head, tail). `sabotage:
 * "missing-space"` reproduces the round-3 corpus defect — the
 * separator-less arm loses its space and renders `A=xcd <target>` — and
 * changes NOTHING else; the self-test feeds it to the gate and demands
 * the gate notice.
 *
 * @param {{ targetDir: string, sabotage?: string | null }} options
 * @returns {Array<{ arm: string, cmd: string }>}
 */
export function buildCorpus({ targetDir, sabotage = null }) {
  const shapes = [];
  for (const arm of SEPARATOR_ARMS) {
    const sep = arm === " " && sabotage === SABOTAGE_MISSING_SPACE ? "" : arm;
    for (const head of HEADS) {
      for (const tail of TAILS) {
        shapes.push({ arm, cmd: `A=${head}${sep}cd ${targetDir} ${tail} probeshim` });
      }
    }
  }
  return shapes;
}

function newArmStats(baselines) {
  return {
    shapes: 0,
    ran: 0,
    entered: 0,
    candidateHits: 0,
    candidateWrong: [],
    phantoms: [],
    perBaseline: new Map(
      baselines.map((b) => [b.name, { hits: 0, wrong: 0, lost: [], degradedToWrong: [], phantomFixed: 0 }]),
    ),
  };
}

/**
 * Run the audit. Pure with respect to its collaborators: `runReal` is
 * the bash referee (returns the PWD the probe shim observed, or null
 * when the probe never ran), `candidateParse` / each baseline's `parse`
 * map a command string to its extracted cd target (or null).
 *
 * Classes, per entered shape (real === targetDir):
 *   - baseline hit:        baseline target === real (a WRONG non-null
 *                          baseline target is counted as `wrong`, never
 *                          as a hit — it must not satisfy the gate)
 *   - lost:                baseline hit, candidate null
 *   - degraded to wrong:   baseline hit, candidate non-null but wrong
 *   - candidate wrong:     candidate non-null and !== real
 * Per non-entered shape:
 *   - phantom:             candidate reports a target bash never entered
 *   - phantom fixed:       baseline reported one and candidate does not
 */
export function auditCorpus({ shapes, targetDir, runReal, candidateParse, baselines }) {
  const arms = new Map();
  for (const { arm } of shapes) {
    if (!arms.has(arm)) arms.set(arm, newArmStats(baselines));
  }
  for (const { arm, cmd } of shapes) {
    const st = arms.get(arm);
    st.shapes += 1;
    const real = runReal(cmd);
    if (real === null) continue; // the probe never ran; visible as shapes-vs-ran gap
    st.ran += 1;
    const cand = candidateParse(cmd);
    const entered = real === targetDir;
    if (entered) {
      st.entered += 1;
      if (cand === real) st.candidateHits += 1;
      else if (cand !== null) st.candidateWrong.push(cmd);
      for (const b of baselines) {
        // Independent counters per baseline, deliberately NOT an
        // else-if chain across baselines: a shape lost against both
        // baselines counts against both (reviewer weakness (a)).
        const bs = st.perBaseline.get(b.name);
        const bt = b.parse(cmd);
        if (bt === real) {
          bs.hits += 1;
          if (cand === null) bs.lost.push(cmd);
          else if (cand !== real) bs.degradedToWrong.push(cmd);
        } else if (bt !== null) {
          bs.wrong += 1;
        }
      }
    } else {
      if (cand !== null) st.phantoms.push(cmd);
      for (const b of baselines) {
        const bs = st.perBaseline.get(b.name);
        if (b.parse(cmd) !== null && cand === null) bs.phantomFixed += 1;
      }
    }
  }

  // THE PER-ARM GATE. An arm is measured against a baseline only when
  // at least one of its shapes actually entered the target AND the
  // baseline hit at least once. Everything else proves nothing and is
  // excluded — visibly — from every total.
  const gateReason = (st, bs) =>
    st.ran === 0 ? "NO SHAPE RAN" : st.entered === 0 ? "NO ENTERED SHAPES" : bs.hits === 0 ? "BASELINE NEVER HIT" : null;

  const perBaselineTotals = baselines.map((b) => {
    let lost = 0;
    let degradedToWrong = 0;
    let measuredArms = 0;
    const unmeasuredArms = [];
    for (const [arm, st] of arms) {
      const bs = st.perBaseline.get(b.name);
      const reason = gateReason(st, bs);
      if (reason) {
        unmeasuredArms.push({ arm, reason });
      } else {
        measuredArms += 1;
        lost += bs.lost.length;
        degradedToWrong += bs.degradedToWrong.length;
      }
    }
    return {
      name: b.name,
      lost,
      degradedToWrong,
      measuredArms,
      unmeasuredArms,
      // A zero is only a measurement when NO arm was excluded from it.
      meaningfulZero: unmeasuredArms.length === 0,
    };
  });

  let phantoms = 0;
  let candidateWrong = 0;
  for (const st of arms.values()) {
    phantoms += st.phantoms.length;
    candidateWrong += st.candidateWrong.length;
  }

  return {
    arms,
    gateReason,
    perBaselineTotals,
    candidateTotals: { phantoms, wrong: candidateWrong },
  };
}

/** Render the audit as the human-readable report the CLI prints. */
export function renderReport(audit) {
  const lines = [];
  const q = (s) => JSON.stringify(s);
  for (const totals of audit.perBaselineTotals) {
    lines.push(`== baseline: ${totals.name} ==`);
    lines.push(
      "arm       shapes   ran  entered  baseline-hit  LOST  degraded-to-wrong  baseline-wrong  phantom-fixed  gate",
    );
    for (const [arm, st] of audit.arms) {
      const bs = st.perBaseline.get(totals.name);
      const reason = audit.gateReason(st, bs);
      lines.push(
        q(arm).padEnd(10) +
          String(st.shapes).padStart(6) +
          String(st.ran).padStart(6) +
          String(st.entered).padStart(9) +
          String(bs.hits).padStart(14) +
          String(bs.lost.length).padStart(6) +
          String(bs.degradedToWrong.length).padStart(19) +
          String(bs.wrong).padStart(16) +
          String(bs.phantomFixed).padStart(15) +
          (reason ? `  ${reason}` : ""),
      );
    }
    lines.push(
      `TOTAL vs ${totals.name} (measured arms only): LOST honest targets = ${totals.lost}, ` +
        `degraded to wrong = ${totals.degradedToWrong}`,
    );
    if (totals.unmeasuredArms.length > 0) {
      lines.push(`ARMS THAT PROVE NOTHING vs ${totals.name} (excluded from every total, by construction):`);
      for (const { arm, reason } of totals.unmeasuredArms) {
        lines.push(`   ${q(arm)} — ${reason}`);
      }
      lines.push(
        `!! NOT a global zero: ${totals.unmeasuredArms.length} of ${audit.arms.size} arms prove nothing vs ${totals.name}.`,
      );
    }
    const lostAll = [...audit.arms.values()].flatMap((st) => st.perBaseline.get(totals.name).lost);
    if (lostAll.length > 0) {
      lines.push(`LOST spellings vs ${totals.name}:`);
      for (const cmd of lostAll) lines.push(`   ${q(cmd)}`);
    }
    lines.push("");
  }
  lines.push(
    `candidate (baseline-independent): phantoms = ${audit.candidateTotals.phantoms}, ` +
      `wrong targets = ${audit.candidateTotals.wrong}`,
  );
  return lines.join("\n");
}

/**
 * Throwaway bash workspace: writable cwd (mkdtemp), the redirect input
 * file `in` pre-created, and a PATH shim `probeshim` that prints the
 * PWD it ran in — every trap the round-3 corpus fell into is closed
 * structurally, not by discipline.
 */
export function createBashWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "measure-bash-prefix-"));
  const targetDir = join(dir, "target");
  const shims = join(dir, "shims");
  mkdirSync(targetDir);
  mkdirSync(shims);
  writeFileSync(join(dir, "in"), "");
  writeFileSync(join(shims, "probeshim"), '#!/bin/bash\nprintf "PWD=%s\\0" "$PWD"\n');
  chmodSync(join(shims, "probeshim"), 0o755);
  const runReal = (cmd) => {
    try {
      const out = execFileSync("bash", ["-c", cmd], {
        cwd: dir,
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: `${shims}:/usr/bin:/bin`, HOME: dir },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const probe = out.split("\0").find((part) => part.startsWith("PWD="));
      return probe ? probe.slice(4) : null;
    } catch {
      return null;
    }
  };
  return {
    dir,
    targetDir,
    runReal,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function loadParser(modulePath, label) {
  let mod;
  try {
    mod = await import(pathToFileURL(resolve(modulePath)).href);
  } catch (cause) {
    throw new Error(
      `${label} module could not be loaded from ${modulePath} — for this repo's own build, run \`npm run build\` first (${cause.message})`,
    );
  }
  if (typeof mod.parseBashPrefix !== "function") {
    throw new Error(`${label} module ${modulePath} does not export parseBashPrefix`);
  }
  return (cmd) => mod.parseBashPrefix(cmd).cdTarget;
}

/**
 * The instrument's own positive control. Proves the harness CAN fail
 * before any of its numbers are believed:
 *   1. healthy corpus: the separator-less arm must be measured (it is
 *      the canonical honest-target arm) and at least one redirect shape
 *      must have run (writable-cwd control);
 *   2. sabotaged corpus (round-3 defect rebuilt on purpose): the gate
 *      must flag the separator-less arm as evidence-free, and the
 *      report must refuse to present its zeros as a global zero.
 */
export async function runSelfTest({ candidatePath }) {
  const parse = await loadParser(candidatePath, "candidate");
  const failures = [];
  const ws = createBashWorkspace();
  try {
    const identity = [{ name: "self", parse }];
    const audit = (sabotage) =>
      auditCorpus({
        shapes: buildCorpus({ targetDir: ws.targetDir, sabotage }),
        targetDir: ws.targetDir,
        runReal: ws.runReal,
        candidateParse: parse,
        baselines: identity,
      });

    const healthy = audit(null);
    const spaceArm = healthy.arms.get(" ");
    const spaceArmBs = spaceArm.perBaseline.get("self");
    if (healthy.gateReason(spaceArm, spaceArmBs) !== null) {
      failures.push(
        `healthy corpus: the separator-less arm is not measurable (ran=${spaceArm.ran}, entered=${spaceArm.entered}, hits=${spaceArmBs.hits}) — environment or corpus broken`,
      );
    }
    const redirectRan = [">o", ">o ", "<in", "<in "].reduce((n, arm) => n + healthy.arms.get(arm).ran, 0);
    if (redirectRan === 0) {
      failures.push("healthy corpus: no redirect shape ran at all — cwd not writable or `in` missing (the round-3 trap)");
    }

    const sabotaged = audit(SABOTAGE_MISSING_SPACE);
    const sabArm = sabotaged.arms.get(" ");
    const sabReason = sabotaged.gateReason(sabArm, sabArm.perBaseline.get("self"));
    if (sabReason === null) {
      failures.push(
        "sabotaged corpus (missing space in the separator-less arm) was NOT flagged as evidence-free — the per-arm gate is not doing its job",
      );
    }
    const sabTotals = sabotaged.perBaselineTotals.find((t) => t.name === "self");
    if (sabTotals.meaningfulZero) {
      failures.push("sabotaged corpus: totals still claim a meaningful global zero");
    }
    if (!renderReport(sabotaged).includes("NOT a global zero")) {
      failures.push("sabotaged corpus: rendered report does not carry the NOT-a-global-zero marker");
    }
  } finally {
    ws.dispose();
  }
  return { ok: failures.length === 0, failures };
}

function parseArgs(argv) {
  const args = { candidate: "dist/runtime/bash-prefix-parse.js", baselines: [], selfTestOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") {
      args.selfTestOnly = true;
    } else if (arg === "--candidate") {
      args.candidate = argv[(i += 1)];
    } else if (arg === "--baseline") {
      const value = argv[(i += 1)];
      const eq = value?.indexOf("=") ?? -1;
      args.baselines.push(
        eq > 0 ? { name: value.slice(0, eq), path: value.slice(eq + 1) } : { name: `baseline${args.baselines.length + 1}`, path: value },
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const selfTest = await runSelfTest({ candidatePath: args.candidate });
  if (!selfTest.ok) {
    console.error("measure-bash-prefix-parse: SELF-TEST FAILED — no measurement below can be trusted:");
    for (const failure of selfTest.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("measure-bash-prefix-parse: self-test ok (per-arm gate flags a sabotaged corpus as evidence-free)");
  if (args.selfTestOnly) return;

  if (args.baselines.length < 2) {
    console.error(
      "measure-bash-prefix-parse: a measurement run needs at least two --baseline name=path builds " +
        "(typically master and the shipped release) — a single reference point is how the round-4 corpus " +
        "sampled itself blind. Use --self-test to run the instrument check alone.",
    );
    process.exitCode = 1;
    return;
  }

  const candidateParse = await loadParser(args.candidate, "candidate");
  const baselines = [];
  for (const b of args.baselines) {
    baselines.push({ name: b.name, parse: await loadParser(b.path, `baseline ${b.name}`) });
  }

  const ws = createBashWorkspace();
  try {
    const audit = auditCorpus({
      shapes: buildCorpus({ targetDir: ws.targetDir }),
      targetDir: ws.targetDir,
      runReal: ws.runReal,
      candidateParse,
      baselines,
    });
    console.log(renderReport(audit));
  } finally {
    ws.dispose();
  }
}

// Only auto-run when invoked directly (not when imported by tests) —
// same guard as scripts/check-no-only.mjs.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`measure-bash-prefix-parse: ${error.message}`);
    process.exitCode = 1;
  });
}
