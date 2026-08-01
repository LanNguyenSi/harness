#!/usr/bin/env node
// Per-arm-gated measurement corpus for the Risk Gate's Bash prefix
// parser (task 47297478). Measures a CANDIDATE build of
// src/runtime/bash-prefix-parse.ts against real bash (the referee) and
// at least two BASELINE builds (typically master and the shipped
// release). Scope: this instrument compares exactly ONE extraction,
// `parseBashPrefix(cmd).cdTarget`. It does NOT measure inline-env
// extraction (`inlineEnv`) and it cannot load command-normalize.ts
// builds at all — claims about those dimensions need their own
// instrument.
//
// Per separator arm and per baseline it reports: shapes, ran,
// bash-entered, baseline hits, lost honest targets, targets degraded
// to wrong; plus a baseline-independent per-arm candidate section with
// hits, phantoms, and wrong targets.
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
// The candidate-side totals carry the same qualifier for arms whose
// shapes never ran at all.
//
// Two residual weaknesses of the run-local ancestor (final-audit.mjs in
// the 2026-07-31 run directory — a run artifact, NOT in the repository;
// both weaknesses are restated here so the pointer is not needed) are
// fixed:
//   (a) baselines were folded through an `else if` chain, so a shape
//       lost against BOTH baselines was counted once — every baseline
//       now keeps fully independent counters;
//   (b) a non-null-but-WRONG target was not counted at all — it is now
//       its own failure class and never a hit, for candidate and
//       baselines alike (a wrong-target baseline cannot satisfy the
//       gate either).
//
// A note on the phantom class, because the raw number invites
// over-reading: a phantom is any non-null candidate target on a shape
// bash did not enter ON THIS RUN. That includes a statically present
// `cd` on a branch bash short-circuited at runtime (e.g. the `||` arms,
// where the assignment succeeds and `cd` never runs). For a risk gate,
// extracting the target there is the conservative reading, not by
// itself a parser defect — the per-arm attribution exists precisely so
// a phantom count can be traced to its spelling before it is judged.
//
// Self-test (runs automatically before every measurement, or alone via
// --self-test / `npm run measure:bash-prefix-parse -- --self-test`):
// rebuilds the round-3 defect on purpose (missing space in the
// separator-less arm) and requires the gate to flag that arm as
// evidence-free; carries a deliberately blind baseline as a positive
// control that the BASELINE-NEVER-HIT rung (the round-4 countermeasure)
// can fire; and requires the healthy corpus to produce an entered
// separator-less arm and executed redirect shapes, so a broken
// environment (missing bash, non-writable cwd) fails loudly. The
// assertion set lives in `evaluateSelfTest`, a pure function with its
// own failure-path tests, so a deleted assertion cannot vanish
// silently.
//
// Usage:
//   node scripts/measure-bash-prefix-parse.mjs --self-test
//   node scripts/measure-bash-prefix-parse.mjs \
//     --baseline master=<worktree>/dist/runtime/bash-prefix-parse.js \
//     --baseline shipped=<npm-pack>/dist/runtime/bash-prefix-parse.js \
//     [--candidate dist/runtime/bash-prefix-parse.js]
//
// The candidate defaults to this repo's own build (`npm run build`
// first). Runs offline. bash is resolved from the ambient PATH once and
// invoked by absolute path; the corpus child processes get a PATH
// containing ONLY the shim directory, so no corpus command can resolve
// a real binary — "only the probe shim is executable" is structural.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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
export const SELF_TEST_IDENTITY_BASELINE = "candidate-as-baseline";
export const SELF_TEST_BLIND_BASELINE = "blind-control";

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
 *   - phantom:             candidate reports a target bash never
 *                          entered on this run (see the module-header
 *                          note before judging the number)
 *   - phantom fixed:       baseline reported one and candidate does not
 */
export function auditCorpus({ shapes, targetDir, runReal, candidateParse, baselines }) {
  const seenNames = new Set();
  for (const b of baselines) {
    if (seenNames.has(b.name)) {
      // Two baselines under one name would silently merge into one
      // counter bucket and double-count every class — fail loudly.
      throw new Error(`duplicate baseline name: ${b.name}`);
    }
    seenNames.add(b.name);
  }

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

  // Candidate-side totals get the same honesty treatment: an arm whose
  // shapes never ran was not observed at all, so a phantom/wrong zero
  // cannot speak for it.
  let phantoms = 0;
  let candidateWrong = 0;
  const armsWithoutObservation = [];
  for (const [arm, st] of arms) {
    phantoms += st.phantoms.length;
    candidateWrong += st.candidateWrong.length;
    if (st.ran === 0) armsWithoutObservation.push(arm);
  }

  return {
    arms,
    gateReason,
    perBaselineTotals,
    candidateTotals: {
      phantoms,
      wrong: candidateWrong,
      armsWithoutObservation,
      meaningfulZero: armsWithoutObservation.length === 0,
    },
  };
}

/** Render the audit as the human-readable report the CLI prints. */
export function renderReport(audit) {
  const lines = [];
  const q = (s) => JSON.stringify(s);
  for (const totals of audit.perBaselineTotals) {
    lines.push(`== baseline: ${totals.name} ==`);
    lines.push("arm       shapes   ran  entered  baseline-hit  LOST  degraded-to-wrong  baseline-wrong  phantom-fixed  gate");
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

  lines.push("== candidate (baseline-independent) ==");
  lines.push("arm       shapes   ran  entered  cand-hit  phantoms  wrong-target  gate");
  for (const [arm, st] of audit.arms) {
    lines.push(
      q(arm).padEnd(10) +
        String(st.shapes).padStart(6) +
        String(st.ran).padStart(6) +
        String(st.entered).padStart(9) +
        String(st.candidateHits).padStart(10) +
        String(st.phantoms.length).padStart(10) +
        String(st.candidateWrong.length).padStart(14) +
        (st.ran === 0 ? "  NO SHAPE RAN" : ""),
    );
  }
  lines.push(
    "(a phantom = candidate target bash did not enter ON THIS RUN — includes a statically present cd on a " +
      "branch bash short-circuited, e.g. the || arms; attribute before judging)",
  );
  lines.push(
    `TOTAL candidate: phantoms = ${audit.candidateTotals.phantoms}, wrong targets = ${audit.candidateTotals.wrong}`,
  );
  if (audit.candidateTotals.armsWithoutObservation.length > 0) {
    lines.push(
      `!! phantom/wrong zeros do not cover ${audit.candidateTotals.armsWithoutObservation.length} arm(s) whose shapes never ran: ` +
        audit.candidateTotals.armsWithoutObservation.map((arm) => q(arm)).join(", "),
    );
  }
  const phantomSpellings = [...audit.arms.values()].flatMap((st) => st.phantoms);
  if (phantomSpellings.length > 0) {
    lines.push("phantom spellings:");
    for (const cmd of phantomSpellings) lines.push(`   ${q(cmd)}`);
  }
  return lines.join("\n");
}

/** Resolve bash from the ambient PATH once; null when absent. */
export function resolveBash(pathEnv = process.env.PATH ?? "") {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length > 0 && existsSync(join(dir, "bash"))) return join(dir, "bash");
  }
  return null;
}

/**
 * Throwaway bash workspace: writable cwd (mkdtemp), the redirect input
 * file `in` pre-created, and a PATH shim `probeshim` that prints the
 * PWD it ran in — every trap the round-3 corpus fell into is closed
 * structurally, not by discipline. bash is invoked by absolute path and
 * the child PATH contains only the shim directory, so a corpus command
 * cannot resolve any real binary.
 */
export function createBashWorkspace() {
  const bash = resolveBash();
  if (bash === null) {
    throw new Error("bash not found on PATH — the corpus needs real bash as its referee");
  }
  const dir = mkdtempSync(join(tmpdir(), "measure-bash-prefix-"));
  const targetDir = join(dir, "target");
  const shims = join(dir, "shims");
  mkdirSync(targetDir);
  mkdirSync(shims);
  writeFileSync(join(dir, "in"), "");
  writeFileSync(join(shims, "probeshim"), `#!${bash}\nprintf "PWD=%s\\0" "$PWD"\n`);
  chmodSync(join(shims, "probeshim"), 0o755);
  const runReal = (cmd) => {
    try {
      const out = execFileSync(bash, ["-c", cmd], {
        cwd: dir,
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: shims, HOME: dir },
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
 * The self-test's assertion set, pure and separately unit-tested so a
 * deleted assertion cannot vanish silently (the instrument's ability to
 * fail is itself pinned). `healthy` must carry the identity baseline
 * AND the deliberately blind control baseline; `sabotaged` carries the
 * identity baseline.
 *
 * Failures abort a measurement. Warnings do not: a candidate that
 * genuinely regressed on the canonical arm is exactly what the
 * measurement against real baselines exists to show, so the instrument
 * check must not block it (and must not misreport it as a broken
 * environment).
 */
export function evaluateSelfTest({ healthy, sabotaged }) {
  const failures = [];
  const warnings = [];
  const healthySpace = healthy.arms.get(" ");
  const sabotagedSpace = sabotaged.arms.get(" ");
  if (!healthySpace || !sabotagedSpace) {
    failures.push("self-test audits are missing the separator-less arm entirely");
    return { failures, warnings };
  }

  // 1. Environment / corpus control, entered-based so it is independent
  //    of any parser: the canonical honest-target arm must actually
  //    reach the target directory on the healthy corpus.
  if (healthySpace.ran === 0 || healthySpace.entered === 0) {
    failures.push(
      `healthy corpus: the separator-less arm never ${healthySpace.ran === 0 ? "ran" : "entered the target"} ` +
        `(ran=${healthySpace.ran}, entered=${healthySpace.entered}) — environment or corpus broken`,
    );
  }

  // 2. Writable-cwd control (the round-3 trap): at least one redirect
  //    shape must have executed.
  const redirectRan = [">o", ">o ", "<in", "<in "].reduce(
    (n, arm) => n + (healthy.arms.get(arm)?.ran ?? 0),
    0,
  );
  if (redirectRan === 0) {
    failures.push("healthy corpus: no redirect shape ran at all — cwd not writable or `in` missing (the round-3 trap)");
  }

  // 3. Round-4 rung control: the deliberately blind baseline must trip
  //    BASELINE NEVER HIT on the entered separator-less arm — the only
  //    in-tool proof that the hits-based gate rung can fire at all.
  const blind = healthySpace.perBaseline.get(SELF_TEST_BLIND_BASELINE);
  if (healthySpace.entered > 0) {
    if (!blind) {
      failures.push("the blind-control baseline is missing from the healthy audit");
    } else if (healthy.gateReason(healthySpace, blind) !== "BASELINE NEVER HIT") {
      failures.push(
        "the blind-control baseline was not flagged BASELINE NEVER HIT — the hits rung of the per-arm gate is not doing its job",
      );
    }
  }

  // 4. A candidate with no correct target on the canonical arm is a
  //    warning, not an instrument failure — see the function doc.
  const identity = healthySpace.perBaseline.get(SELF_TEST_IDENTITY_BASELINE);
  if (healthySpace.entered > 0 && identity !== undefined && identity.hits === 0) {
    warnings.push(
      "candidate produced no correct target on the healthy separator-less arm — not an instrument failure, " +
        "but expect the measurement below to show losses",
    );
  }

  // 5. Sabotage detection, entered-based delta so parser state cannot
  //    satisfy it: the sabotaged separator-less arm must fail the gate
  //    for a CORPUS reason (its shapes cannot enter), while the healthy
  //    one entered (asserted in 1).
  if (sabotagedSpace.entered > 0) {
    failures.push(
      "sabotaged corpus (missing space in the separator-less arm) still ENTERED the target — the sabotage is inert " +
        "and this self-test is not testing anything",
    );
  } else {
    const sabIdentity = sabotagedSpace.perBaseline.get(SELF_TEST_IDENTITY_BASELINE);
    const reason = sabIdentity === undefined ? null : sabotaged.gateReason(sabotagedSpace, sabIdentity);
    if (reason === null) {
      failures.push(
        "sabotaged corpus (missing space in the separator-less arm) was NOT flagged as evidence-free — " +
          "the per-arm gate is not doing its job",
      );
    }
  }

  // 6. The refusal marker must actually render — guards against the
  //    NOT-a-global-zero path being deleted from the report.
  if (!renderReport(sabotaged).includes("NOT a global zero")) {
    failures.push("sabotaged corpus: rendered report does not carry the NOT-a-global-zero marker");
  }

  return { failures, warnings };
}

/**
 * Run the instrument's positive control against real bash: healthy
 * corpus (with identity + blind-control baselines) and sabotaged corpus
 * (round-3 defect rebuilt on purpose), evaluated by
 * `evaluateSelfTest`.
 */
export async function runSelfTest({ candidatePath }) {
  const parse = await loadParser(candidatePath, "candidate");
  const ws = createBashWorkspace();
  try {
    const audit = (sabotage, baselines) =>
      auditCorpus({
        shapes: buildCorpus({ targetDir: ws.targetDir, sabotage }),
        targetDir: ws.targetDir,
        runReal: ws.runReal,
        candidateParse: parse,
        baselines,
      });
    const healthy = audit(null, [
      { name: SELF_TEST_IDENTITY_BASELINE, parse },
      { name: SELF_TEST_BLIND_BASELINE, parse: () => null },
    ]);
    const sabotaged = audit(SABOTAGE_MISSING_SPACE, [{ name: SELF_TEST_IDENTITY_BASELINE, parse }]);
    const { failures, warnings } = evaluateSelfTest({ healthy, sabotaged });
    return { ok: failures.length === 0, failures, warnings };
  } finally {
    ws.dispose();
  }
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { candidate: "dist/runtime/bash-prefix-parse.js", baselines: [], selfTestOnly: false };
  const valueOf = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") {
      args.selfTestOnly = true;
    } else if (arg === "--candidate") {
      args.candidate = valueOf(arg, (i += 1));
    } else if (arg === "--baseline") {
      const value = valueOf(arg, (i += 1));
      const eq = value.indexOf("=");
      const entry =
        eq > 0
          ? { name: value.slice(0, eq), path: value.slice(eq + 1) }
          : { name: `baseline${args.baselines.length + 1}`, path: value };
      if (args.baselines.some((b) => b.name === entry.name)) {
        throw new Error(`duplicate baseline name: ${entry.name} — name each --baseline uniquely (name=path)`);
      }
      args.baselines.push(entry);
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
  for (const warning of selfTest.warnings) {
    console.warn(`measure-bash-prefix-parse: warning: ${warning}`);
  }
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
