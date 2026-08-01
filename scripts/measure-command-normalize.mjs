#!/usr/bin/env node
// Per-arm-gated regression instrument for `src/runtime/command-normalize.ts`
// (groundwork for task aabbad63, the BOUNDARY_RE bare-`&` fix). Rebuilds a
// FAITHFUL SUPERSET of the 140-form quoted-value regression corpus that
// proved the reverted attempt to add bare `&` to BOUNDARY_RE broke every
// `<wrapper> FOO='a&b' <gated verb>` spelling it sampled — that exact
// corpus lived in an ephemeral scratchpad and is gone; this is NOT a
// byte-exact reconstruction of "the 140", it is a documented factorisation
// covering the same shape.
//
// Mirrors the structure and discipline of `measure-bash-prefix-parse.mjs`
// (task 47297478): a pure, injectable audit core; a per-arm gate that
// refuses to fold an unmeasured arm into a passing zero; a `--self-test`
// that sabotages the audit on purpose and requires the gate to catch it;
// bash as the arbiter via a PATH-restricted shim chain. `resolveBash` and
// `createBashWorkspace` are IMPORTED from that module rather than
// duplicated (this repo's `check:duplication` gate pins a clone count for
// `src/`, and re-implementing that scaffolding is exactly the kind of
// duplication the reuse avoids).
//
// THREE CORPORA, each its own concern:
//
//   ARM A (regression, expected to currently keep every gate): for each of
//   8 wrappers {env, nice, sudo, command, nohup, setsid, timeout, stdbuf} x
//   4 quoted values {'a&b', "a&b", 'x & y', 'a & b & c'} x 4 gated verbs
//   {git push origin master, gh pr merge 1 --squash, npm publish,
//   harness pause}, build `<wrapper> FOO=<qval> <verb>` (128 forms) and
//   measure whether the verb's own gating policy fires via the REAL
//   matching path (`policyMatchesEvent`, raw-OR-normalised) against
//   `docs/examples/full-manifest.yaml`. Each (wrapper, verb) pair also gets
//   a POSITIVE CONTROL, `<wrapper> <verb>` with no assignment at all (32
//   forms) — an arm whose own control never gates cannot evidence
//   anything about its assignment forms and is EXCLUDED from the total,
//   never folded into a zero (the per-arm gate).
//
//   MEASURED, NOT ASSUMED (read before trusting "8 wrappers x 4 verbs =
//   uniformly gated"): two of the eight wrappers fail their OWN positive
//   control today, independent of this task's `&` concern —
//     - `nohup` is not one of `canonicalizeSegment`'s recognised wrapper
//       names at all (see the command-normalize.ts module header's
//       NOT-SUPPORTED list — "nohup git status" is already a pinned,
//       documented bypass). `nohup <verb>` never gates, with or without an
//       assignment.
//     - `timeout` needs a mandatory leading DURATION positional
//       (`peelTimeout` unconditionally treats the token right after
//       `timeout`'s own flags as the duration and skips it, REGARDLESS of
//       whether it looks like one). `timeout <verb>` with no duration at
//       all skips the verb's OWN head token as the phantom duration and
//       never gates; `timeout FOO=<qval> <verb>` happens to reach the verb
//       only for the two SINGLE-TOKEN quoted values ('a&b', "a&b" — no
//       unquoted space, so `FOO='a&b'` is one whitespace-delimited token
//       for `peelTimeout` to skip), and MISSES for the two multi-token
//       values ('x & y', 'a & b & c') because `peelTimeout` never returns
//       control to `canonicalizeSegment`'s outer loop, so the multi-token
//       quote continuation (`consumeAssignment`) never runs for it the way
//       it does for every other wrapper. Both facts were measured against
//       this repo's own build (`docs/examples/full-manifest.yaml` +
//       `policyMatchesEvent`), not assumed from reading the source — see
//       the per-arm gate output below, which reports both arms as PROVING
//       NOTHING rather than silently omitting them or folding them into a
//       misleadingly-clean total.
//
//   ARM B (currently OPEN, descriptive — NOT asserted closed, closing it
//   is aabbad63's job): two bare-`&` shapes BOUNDARY_RE cannot see today
//   because it does not recognise a lone `&` as a boundary at all —
//     - `A=x&<wrapper> -C /tmp <verb>` (no space before the wrapper): the
//       `&` glues onto the FIRST token, so tokenisation swallows
//       `<wrapper>` into the assignment word and the wrapper is never
//       recognised, independent of any quoting concern.
//     - `echo hi & nice <verb>` (a genuine bash background job): the
//       whole string is one un-split segment, so `nice <verb>` never
//       becomes the recognised head.
//   Measured via `policyMatchesEvent` only (no bash-shim arbiter — this
//   arm is descriptive, not a regression claim, so the higher bar arm A
//   carries is not needed to report "still ungated today").
//
//   ARM C (targetDir invariants, true today, NOT gate-matching):
//   `normalizeCommand(...).targetDir` for a handful of shapes a future
//   BOUNDARY_RE edit could disturb — `git -C /x log 2>&1`, `git -C /x
//   status &> out`, `git -C /x push &` (all resolve `/x`), and the `&&`
//   ordering/agreement case `git -C /tmp/repoB status && git -C /tmp/repoB
//   log` (resolves `/tmp/repoB`). Asserted directly, not gate-matched.
//
// THE BASH-SHIM ARBITER, AND WHY ITS WRAPPER SHIMS ARE NOT REAL BINARIES
// (measured, not assumed — see `createVerbWorkspace`): real `nice`,
// `sudo`, `command` (bash's own builtin), `timeout`, `stdbuf`, `setsid`,
// and `nohup` do NOT treat a leading `FOO=value` token as an environment
// assignment the way `env` genuinely does — measured directly against
// this host's real binaries: `nice FOO=bar echo hi` -> "nice: 'FOO=bar':
// Permission denied"; `command FOO=bar echo hi` -> "FOO=bar: command not
// found"; `timeout FOO=bar echo hi` -> "invalid time interval 'FOO=bar'";
// `sudo -n FOO=bar echo hi` -> "a password is required"; `stdbuf FOO=bar
// echo hi` -> "you must specify a buffering mode option"; `setsid`/`nohup
// FOO=bar echo hi` -> "Permission denied" attempting to exec the literal
// string `FOO=bar`. None of the seven would actually invoke the payload
// verb in this shape on a real, un-shimmed system. `command-normalize.ts`
// itself, however, models ALL EIGHT wrappers this permissively —
// `canonicalizeSegment`'s outer loop treats a recognised wrapper name and
// a `VAR=value` token as independently peelable prefixes in ANY order,
// regardless of which wrapper precedes the assignment (only `peelTimeout`
// partially diverges, see above). The shim chain below intentionally
// implements THAT model (consume leading `NAME=value`-shaped argv, then
// exec the rest) so the arbiter proves the load-bearing claim — that
// bash's OWN quoting/tokenisation reaches the verb given the permissive
// model `command-normalize.ts` assumes, i.e. the corpus string is
// well-formed, real, executable bash, not a nonsense fabrication — NOT the
// unrelated (and, per the above, largely false) claim that each real
// system binary would forward the assignment the same way. A caller who
// needs the latter needs a different, out-of-scope instrument.
//
// `command` is a bash BUILTIN, not a PATH-resolved binary, so a PATH shim
// alone can never intercept it; the runner disables the builtin for its
// own throwaway subprocess only (`enable -n command`), letting PATH
// resolution reach the `command` shim like any of the other seven. This
// is scoped to the measurement's own bash subprocess and is not a claim
// about how `command` behaves in a real, non-disabled agent shell.
//
// Usage:
//   node scripts/measure-command-normalize.mjs --self-test
//   node scripts/measure-command-normalize.mjs
//   node scripts/measure-command-normalize.mjs --manifest <path> --dist <dir>
//
// Requires `npm run build` first (imports the compiled
// `dist/runtime/command-normalize.js`, `dist/runtime/index.js`,
// `dist/schema/index.js`). Runs offline; bash is resolved from the ambient
// PATH once and invoked by absolute path, same containment as the
// reference module.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { createBashWorkspace, resolveBash } from "./measure-bash-prefix-parse.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
export const DEFAULT_MANIFEST = join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");
export const DEFAULT_DIST_DIR = "dist";

// --- corpus vocabulary -------------------------------------------------

export const WRAPPERS = ["env", "nice", "sudo", "command", "nohup", "setsid", "timeout", "stdbuf"];
export const QVALS = ["'a&b'", '"a&b"', "'x & y'", "'a & b & c'"];
export const VERBS = [
  { verb: "git push origin master", policy: "preflight-before-push", verbHead: "git" },
  { verb: "gh pr merge 1 --squash", policy: "review-before-merge-bash", verbHead: "gh" },
  { verb: "npm publish", policy: "dogfood-before-release", verbHead: "npm" },
  { verb: "harness pause", policy: "deny-kill-switch-bypass", verbHead: "harness" },
];
export const REQUIRED_POLICIES = VERBS.map((v) => v.policy);

// Real, measured today (see module header) — NOT a design assumption.
export const KNOWN_GOOD_WRAPPERS = ["env", "nice", "sudo", "command", "setsid", "stdbuf"];
export const KNOWN_UNSUPPORTED_WRAPPERS = ["nohup", "timeout"];

const POSITIVE_CONTROL_NEVER_FIRED =
  "POSITIVE CONTROL NEVER FIRED (this wrapper's own bare-verb form never gates — proves nothing about its assignment forms)";
const NO_SHAPES_RAN = "NO SHAPES RAN (bash-shim never proved the verb executes for this wrapper)";

// --- Arm A: <wrapper> FOO=<qval> <verb> --------------------------------

/**
 * @param {{ wrappers?: string[], qvals?: string[], verbs?: typeof VERBS }} [options]
 */
export function buildCorpusA({ wrappers = WRAPPERS, qvals = QVALS, verbs = VERBS } = {}) {
  const shapes = [];
  const controls = [];
  for (const wrapper of wrappers) {
    for (const v of verbs) {
      controls.push({
        arm: wrapper,
        wrapper,
        verb: v.verb,
        verbHead: v.verbHead,
        policy: v.policy,
        cmd: `${wrapper} ${v.verb}`,
      });
      for (const qval of qvals) {
        shapes.push({
          arm: wrapper,
          wrapper,
          verb: v.verb,
          verbHead: v.verbHead,
          policy: v.policy,
          qval,
          cmd: `${wrapper} FOO=${qval} ${v.verb}`,
        });
      }
    }
  }
  return { shapes, controls };
}

/**
 * Pure audit core: `gates(cmd, policyName)` and `bashRan(cmd, verbHead)`
 * are injected (hermetically stubbed in tests, wired to the real
 * `policyMatchesEvent` / bash-shim workspace for a real measurement run —
 * same discipline as `auditCorpus` in measure-bash-prefix-parse.mjs).
 *
 * THE PER-ARM GATE: an arm (one wrapper) whose assignment shapes never
 * bash-ran at all, or whose OWN positive control never both bash-ran AND
 * gated, proves nothing about its assignment forms and is EXCLUDED from
 * the total — visibly, with a reason — rather than folded into a zero.
 */
export function auditArmA({ shapes, controls, gates, bashRan }) {
  const arms = new Map();
  const ensure = (arm) => {
    if (!arms.has(arm)) {
      arms.set(arm, { shapes: 0, bashRan: 0, gated: 0, ranAndGated: 0, notGated: [], controls: [] });
    }
    return arms.get(arm);
  };

  for (const c of controls) {
    const st = ensure(c.arm);
    st.controls.push({
      verb: c.verb,
      cmd: c.cmd,
      bashRan: bashRan(c.cmd, c.verbHead),
      gated: gates(c.cmd, c.policy),
    });
  }
  for (const s of shapes) {
    const st = ensure(s.arm);
    st.shapes += 1;
    const ran = bashRan(s.cmd, s.verbHead);
    const gated = gates(s.cmd, s.policy);
    if (ran) st.bashRan += 1;
    if (gated) st.gated += 1;
    if (ran && gated) st.ranAndGated += 1;
    if (ran && !gated) st.notGated.push(s.cmd);
  }

  const gateReason = (st) => {
    const anyRan = st.bashRan > 0 || st.controls.some((c) => c.bashRan);
    if (!anyRan) return NO_SHAPES_RAN;
    const positiveControlFired = st.controls.some((c) => c.bashRan && c.gated);
    if (!positiveControlFired) return POSITIVE_CONTROL_NEVER_FIRED;
    return null;
  };

  let keptGate = 0;
  let regressed = 0;
  const unmeasuredArms = [];
  for (const [arm, st] of arms) {
    const reason = gateReason(st);
    if (reason) {
      unmeasuredArms.push({ arm, reason });
    } else {
      // keptGate counts only shapes that BOTH bash-ran AND gated, so a shape
      // that gates without running can never inflate the "kept gate" total.
      // Every bash-ran shape is either gated or in notGated, so this
      // identity must hold for a measured arm; a future corpus change that
      // breaks it (e.g. a shape gating without running) fails loudly here
      // rather than silently padding keptGate.
      if (st.ranAndGated + st.notGated.length !== st.bashRan) {
        throw new Error(
          `per-arm invariant violated for arm "${arm}": ranAndGated (${st.ranAndGated}) + ` +
            `notGated (${st.notGated.length}) !== bashRan (${st.bashRan})`,
        );
      }
      keptGate += st.ranAndGated;
      regressed += st.notGated.length;
    }
  }

  return {
    arms,
    gateReason,
    totals: {
      keptGate,
      regressed,
      totalArms: arms.size,
      measuredArms: arms.size - unmeasuredArms.length,
      unmeasuredArms,
      meaningfulZero: unmeasuredArms.length === 0,
    },
  };
}

export function renderReportA(audit) {
  const lines = [];
  lines.push(
    "== Arm A: <wrapper> FOO=<qval> <verb> (regression corpus — faithful superset of the reverted-fix " +
      "incident's shape, NOT the byte-exact lost 140) ==",
  );
  lines.push("wrapper     shapes  bash-ran  gated  regressed  gate");
  for (const [arm, st] of audit.arms) {
    const reason = audit.gateReason(st);
    lines.push(
      arm.padEnd(11) +
        String(st.shapes).padStart(7) +
        String(st.bashRan).padStart(10) +
        String(st.gated).padStart(7) +
        String(st.notGated.length).padStart(11) +
        (reason ? `  ${reason}` : ""),
    );
  }
  lines.push(
    `TOTAL vs manifest (measured arms only): ${audit.totals.keptGate} kept gate, ${audit.totals.regressed} lost, ` +
      `across ${audit.totals.measuredArms} of ${audit.totals.totalArms} arms`,
  );
  if (!audit.totals.meaningfulZero) {
    lines.push("ARMS THAT PROVE NOTHING (excluded from every total, by construction):");
    for (const { arm, reason } of audit.totals.unmeasuredArms) lines.push(`   ${arm} — ${reason}`);
    lines.push(
      `!! NOT a global ${audit.totals.totalArms}-wrapper result: ${audit.totals.unmeasuredArms.length} of ` +
        `${audit.totals.totalArms} arms prove nothing.`,
    );
  }
  // Conditional on purpose (not a permanent column label): the self-test's
  // rung 5 pins that a genuine regression's marker actually renders, which
  // is only a meaningful check if the marker's absence is possible.
  if (audit.totals.regressed > 0) {
    lines.push(`!! REGRESSED: ${audit.totals.regressed} form(s) bash-proved the verb runs but no gating policy fired:`);
    for (const [, st] of audit.arms) {
      for (const cmd of st.notGated) lines.push(`   ${JSON.stringify(cmd)}`);
    }
  }
  return lines.join("\n");
}

// --- Arm B: the bare-& bypass family (descriptive, fail-open today) ---

/** @param {{ wrappers?: string[], verbs?: typeof VERBS }} [options] */
export function buildCorpusB({ wrappers = WRAPPERS, verbs = VERBS } = {}) {
  const shapes = [];
  for (const wrapper of wrappers) {
    for (const v of verbs) {
      shapes.push({
        family: "glued-ampersand",
        wrapper,
        verb: v.verb,
        policy: v.policy,
        cmd: `A=x&${wrapper} -C /tmp ${v.verb}`,
      });
    }
  }
  for (const v of verbs) {
    shapes.push({
      family: "background-job",
      wrapper: "nice",
      verb: v.verb,
      policy: v.policy,
      cmd: `echo hi & nice ${v.verb}`,
    });
  }
  return shapes;
}

/**
 * Descriptive only: reports how many of these bare-`&` shapes gate today.
 * NEVER assert this arm closed — it is expected (and, today, measured) to
 * be mostly fail-open; closing it is task aabbad63's job, not this one's.
 */
export function auditArmB({ shapes, gates }) {
  let ungated = 0;
  const ungatedCmds = [];
  const byFamily = new Map();
  for (const s of shapes) {
    const gated = gates(s.cmd, s.policy);
    if (!byFamily.has(s.family)) byFamily.set(s.family, { total: 0, ungated: 0 });
    const fam = byFamily.get(s.family);
    fam.total += 1;
    if (!gated) {
      ungated += 1;
      fam.ungated += 1;
      ungatedCmds.push(s.cmd);
    }
  }
  return { total: shapes.length, gated: shapes.length - ungated, ungated, ungatedCmds, byFamily };
}

export function renderReportB(audit) {
  const lines = [];
  lines.push(
    "== Arm B: bare-& bypass family (DESCRIPTIVE, NOT a gate assertion — closing this is aabbad63's job) ==",
  );
  for (const [family, fam] of audit.byFamily) {
    lines.push(`  ${family}: ${fam.ungated}/${fam.total} ungated (fail-open)`);
  }
  lines.push(`TOTAL: ${audit.ungated}/${audit.total} forms ungated today, ${audit.gated}/${audit.total} gate.`);
  if (audit.ungated > 0) {
    lines.push("Ungated spellings (measured, NOT asserted closed):");
    for (const cmd of audit.ungatedCmds) lines.push(`   ${JSON.stringify(cmd)}`);
  }
  return lines.join("\n");
}

// --- Arm C: targetDir invariants (true today, not gate-matching) ------

export function buildCorpusC() {
  return [
    { label: "git -C /x log 2>&1", cmd: "git -C /x log 2>&1", expected: "/x" },
    { label: "git -C /x status &> out", cmd: "git -C /x status &> out", expected: "/x" },
    { label: "git -C /x push &", cmd: "git -C /x push &", expected: "/x" },
    {
      label: "git -C /tmp/repoB status && git -C /tmp/repoB log (&& ordering/agreement)",
      cmd: "git -C /tmp/repoB status && git -C /tmp/repoB log",
      expected: "/tmp/repoB",
    },
  ];
}

/** @param {{ cases: ReturnType<typeof buildCorpusC>, normalize: (cmd: string) => { targetDir: string | null } }} options */
export function auditArmC({ cases, normalize }) {
  const results = cases.map((c) => {
    const actual = normalize(c.cmd).targetDir;
    return { ...c, actual, pass: actual === c.expected };
  });
  const failed = results.filter((r) => !r.pass);
  return { results, failed, allPass: failed.length === 0 };
}

export function renderReportC(audit) {
  const lines = [];
  lines.push("== Arm C: targetDir invariants (asserted directly, true today) ==");
  for (const r of audit.results) {
    lines.push(`  [${r.pass ? "PASS" : "FAIL"}] ${r.label} -> ${JSON.stringify(r.actual)} (expected ${JSON.stringify(r.expected)})`);
  }
  return lines.join("\n");
}

export function renderReport({ armA, armB, armC }) {
  return [renderReportA(armA), "", renderReportB(armB), "", renderReportC(armC)].join("\n");
}

// --- self-test ----------------------------------------------------------

/**
 * The self-test's assertion set, pure and unit-tested on its own so a
 * deleted assertion cannot vanish silently. `healthy` uses the REAL gate
 * (`policyMatchesEvent` against the shipped manifest); `sabotaged` uses a
 * gate that forces every quoted-`&`-value assignment form to report
 * ungated regardless of the real result, reproducing the reverted fix's
 * regression shape. Both share the SAME bash-shim `bashRan` results, so a
 * broken referee (shim chain died) cannot be confused with a genuine gate
 * regression.
 */
export function evaluateSelfTest({ healthy, sabotaged }) {
  const failures = [];
  const warnings = [];

  for (const wrapper of KNOWN_GOOD_WRAPPERS) {
    const st = healthy.arms.get(wrapper);
    if (!st || st.bashRan === 0) {
      failures.push(
        `healthy corpus: wrapper "${wrapper}" never bash-ran any assignment shape — environment or shim chain broken`,
      );
    }
  }

  // The "positive control never fired" rung must be proven to fire on
  // REAL, measured data (not merely exist as dead code): nohup/timeout
  // are real wrappers whose own bare-verb form never gates today,
  // independent of any sabotage (see the module header).
  for (const wrapper of KNOWN_UNSUPPORTED_WRAPPERS) {
    const st = healthy.arms.get(wrapper);
    if (!st) {
      failures.push(`healthy corpus is missing the "${wrapper}" arm entirely — the gate rung cannot be proven`);
      continue;
    }
    const reason = healthy.gateReason(st);
    if (reason !== POSITIVE_CONTROL_NEVER_FIRED) {
      failures.push(
        `healthy corpus: wrapper "${wrapper}" was NOT flagged POSITIVE CONTROL NEVER FIRED — the rung is not ` +
          `doing its job (got: ${reason ?? "measured"})`,
      );
    }
  }

  // A regression already present on real, un-sabotaged current code is a
  // warning, not an instrument failure — see the reference module's
  // counterpart rung for the rationale (detecting a genuine regression is
  // the tool's whole point, not a defect in the tool).
  if (healthy.totals.regressed > 0) {
    warnings.push(
      `healthy corpus already shows ${healthy.totals.regressed} regressed form(s) against current code — see ` +
        "the REGRESSED spellings list",
    );
  }

  // Sabotage must be genuine and total (the historical incident was
  // 140/140, a complete loss, not a partial one) while leaving bash
  // execution untouched, so a dead referee cannot masquerade as a caught
  // regression.
  for (const wrapper of KNOWN_GOOD_WRAPPERS) {
    const healthySt = healthy.arms.get(wrapper);
    const sabotagedSt = sabotaged.arms.get(wrapper);
    if (!healthySt || !sabotagedSt) {
      failures.push(`sabotaged corpus is missing the "${wrapper}" arm entirely`);
      continue;
    }
    if (sabotagedSt.bashRan !== healthySt.bashRan) {
      failures.push(
        `sabotaged corpus: wrapper "${wrapper}" bash-ran count changed (${healthySt.bashRan} -> ` +
          `${sabotagedSt.bashRan}) — the referee itself broke, this proves nothing about the gate`,
      );
      continue;
    }
    if (sabotagedSt.notGated.length !== sabotagedSt.shapes) {
      failures.push(
        `sabotaged corpus: wrapper "${wrapper}" did not lose ALL ${sabotagedSt.shapes} assignment shapes ` +
          `(only ${sabotagedSt.notGated.length}) — the sabotage is too weak/inert to exercise the ` +
          "regression-detection path",
      );
    }
  }

  if (!renderReportA(sabotaged).includes("REGRESSED")) {
    failures.push("sabotaged corpus: rendered report does not carry a REGRESSED marker");
  }

  return { failures, warnings };
}

/** Reproduces the reverted-fix regression: force ungated for exactly the
 * shape class it broke (a quoted assignment value containing `&`),
 * regardless of what the real gate says. */
function sabotageGates(realGates) {
  const QUOTED_AMPERSAND_VALUE = /=(['"])[^'"]*&[^'"]*\1/;
  return (cmd, policyName) => {
    if (QUOTED_AMPERSAND_VALUE.test(cmd)) return false;
    return realGates(cmd, policyName);
  };
}

// --- bash-shim workspace -------------------------------------------------

export const VERB_HEADS = VERBS.map((v) => v.verbHead);

/**
 * Throwaway bash workspace proving the corpus's VERB actually executes.
 * Reuses `resolveBash`/`createBashWorkspace` from measure-bash-prefix-
 * parse.mjs for bash resolution and the throwaway-dir scaffolding; its
 * OWN `runReal`/`targetDir` (built for cd-target extraction) are unused
 * here — command-normalize's arms need a different shim set (the corpus's
 * wrapper + verb vocabulary, not `cd`). See the module header for why the
 * wrapper shims are a deliberate permissive stand-in, not real binaries.
 */
export function createVerbWorkspace() {
  const bash = resolveBash();
  if (bash === null) {
    throw new Error("bash not found on PATH — the corpus needs real bash as its referee");
  }
  const ws = createBashWorkspace();
  const shimsDir = join(ws.dir, "cn-shims");
  mkdirSync(shimsDir);

  for (const verbHead of VERB_HEADS) {
    writeFileSync(join(shimsDir, verbHead), `#!${bash}\nprintf 'CN_VERB_RAN:${verbHead} %s\\0' "$*"\n`);
    chmodSync(join(shimsDir, verbHead), 0o755);
  }
  const wrapperScript =
    `#!${bash}\n` +
    'while [ $# -gt 0 ]; do\n' +
    '  case "$1" in\n' +
    "    [A-Za-z_]*=*) shift ;;\n" +
    "    *) break ;;\n" +
    "  esac\n" +
    "done\n" +
    'exec "$@"\n';
  for (const wrapper of WRAPPERS) {
    writeFileSync(join(shimsDir, wrapper), wrapperScript);
    chmodSync(join(shimsDir, wrapper), 0o755);
  }

  /** @param {string} cmd @param {string} verbHead */
  const bashRan = (cmd, verbHead) => {
    try {
      const out = execFileSync(bash, ["-c", `enable -n command 2>/dev/null; ${cmd}`], {
        cwd: ws.dir,
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: shimsDir, HOME: ws.dir },
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.includes(`CN_VERB_RAN:${verbHead} `);
    } catch {
      return false;
    }
  };

  if (!bashRan("git status", "git")) {
    ws.dispose();
    throw new Error("the verb shim chain did not execute a plain 'git status' — check the bash interpreter paths above");
  }

  return { bashRan, dispose: ws.dispose };
}

// --- manifest / real-gate wiring ----------------------------------------

async function importDist(distDir, relPath, label) {
  const full = resolve(REPO_ROOT, distDir, relPath);
  try {
    return await import(pathToFileURL(full).href);
  } catch (cause) {
    throw new Error(
      `${label} module could not be loaded from ${full} — run \`npm run build\` first (${cause.message})`,
    );
  }
}

/** Loads the manifest + `policyMatchesEvent` once and returns a pure `gates(cmd, policyName)` function. */
export async function loadRealGates({ manifestPath = DEFAULT_MANIFEST, distDir = DEFAULT_DIST_DIR } = {}) {
  const raw = parseYaml(readFileSync(manifestPath, "utf8"));
  const schemaMod = await importDist(distDir, join("schema", "index.js"), "schema");
  const manifest = schemaMod.parseManifest(raw);
  const runtimeMod = await importDist(distDir, join("runtime", "index.js"), "runtime");

  const policyByName = new Map(manifest.policies.map((p) => [p.name, p]));
  for (const name of REQUIRED_POLICIES) {
    if (!policyByName.has(name)) {
      throw new Error(`manifest ${manifestPath} is missing required gating policy: ${name}`);
    }
  }
  return (cmd, policyName) => {
    const policy = policyByName.get(policyName);
    if (!policy) throw new Error(`unknown policy name: ${policyName}`);
    const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd } };
    return runtimeMod.policyMatchesEvent(policy, event);
  };
}

export async function loadCommandNormalize(distDir = DEFAULT_DIST_DIR) {
  const mod = await importDist(distDir, join("runtime", "command-normalize.js"), "command-normalize");
  return { normalizeCommand: mod.normalizeCommand };
}

/** Runs the instrument's own positive control: real bash + real gate vs a sabotaged gate. */
export async function runSelfTest({ manifestPath = DEFAULT_MANIFEST, distDir = DEFAULT_DIST_DIR } = {}) {
  const realGates = await loadRealGates({ manifestPath, distDir });
  const ws = createVerbWorkspace();
  try {
    const { shapes, controls } = buildCorpusA();
    const bashRan = (cmd, verbHead) => ws.bashRan(cmd, verbHead);
    const healthy = auditArmA({ shapes, controls, gates: realGates, bashRan });
    const sabotaged = auditArmA({ shapes, controls, gates: sabotageGates(realGates), bashRan });
    const { failures, warnings } = evaluateSelfTest({ healthy, sabotaged });
    return { ok: failures.length === 0, failures, warnings };
  } finally {
    ws.dispose();
  }
}

// --- CLI ------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { selfTestOnly: false, manifest: DEFAULT_MANIFEST, distDir: DEFAULT_DIST_DIR };
  const valueOf = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") {
      args.selfTestOnly = true;
    } else if (arg === "--manifest") {
      args.manifest = valueOf(arg, (i += 1));
    } else if (arg === "--dist") {
      args.distDir = valueOf(arg, (i += 1));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const selfTest = await runSelfTest({ manifestPath: args.manifest, distDir: args.distDir });
  if (!selfTest.ok) {
    console.error("measure-command-normalize: SELF-TEST FAILED — no measurement below can be trusted:");
    for (const failure of selfTest.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "measure-command-normalize: self-test ok (the per-arm gate distinguishes a genuine regression from an " +
      "unmeasured arm)",
  );
  for (const warning of selfTest.warnings) console.warn(`measure-command-normalize: warning: ${warning}`);
  if (args.selfTestOnly) return;

  const gates = await loadRealGates({ manifestPath: args.manifest, distDir: args.distDir });
  const { normalizeCommand } = await loadCommandNormalize(args.distDir);
  const ws = createVerbWorkspace();
  try {
    const { shapes, controls } = buildCorpusA();
    const armA = auditArmA({ shapes, controls, gates, bashRan: ws.bashRan });
    const armB = auditArmB({ shapes: buildCorpusB(), gates });
    const armC = auditArmC({ cases: buildCorpusC(), normalize: normalizeCommand });
    console.log(renderReport({ armA, armB, armC }));
  } finally {
    ws.dispose();
  }
}

// Only auto-run when invoked directly (not when imported by tests) — same
// guard as scripts/check-no-only.mjs and measure-bash-prefix-parse.mjs.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`measure-command-normalize: ${error.message}`);
    process.exitCode = 1;
  });
}
