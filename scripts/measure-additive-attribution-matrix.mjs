#!/usr/bin/env node
// Confirmatory differential-matrix instrument for task `98ad072f` (per-repo
// gate-scoping redesign, run `2026-08-02-per-repo-gate-scoping-redesign`,
// T-004). Mirrors the structure and discipline of
// `measure-command-normalize.mjs`: pure, injectable audit functions; the
// corpus size is PRINTED, not silently assumed; a `--self-test` mode
// deliberately sabotages a real, measured decision set and requires the
// audit to catch it (the instrument must be able to FAIL, not just report
// green). Unlike `measure-command-normalize.mjs` this needs no bash-shim
// arbiter — `intercept()` works purely from the command STRING via static
// analysis, so no real shell execution is involved.
//
// WHAT THIS CONFIRMS (see `03-decisions.md` D-021 and `06-handoff.md` for
// the full history this instrument backs): four independent review passes
// each measured a live gate bypass in the "own-target REPLACE" design
// (D-011..D-018), one distinct fail-open per pass, across four fix rounds.
// The operator's chosen fix (D-021, UNIVERSAL-ADDITIVE) makes the property
// TRUE BY CONSTRUCTION — the cwd context is demanded unconditionally and
// never dropped, only added to — so this instrument is CONFIRMATORY, not
// exploratory: it is not hunting for a fifth bypass class, it is measuring
// that the structural argument holds across a real corpus, mechanically,
// against the actual shipped 0.43.0 code (not a hand-simulated oracle).
//
// THE PROPERTY MEASURED, PER CELL: for a command built from one of 8 FORMS
// (below) chained via one of 6 SEPARATORS, with a ledger that holds ONLY
// forged/decoy-target evidence (cwd's own evidence is always absent), the
// PATCHED engine's decision for the cwd's own ledger tag (same policy, same
// tag the CONTROL engine itself computed and denied on) must be IDENTICAL
// to the control engine's decision — not just "not weaker" but byte-
// identical outcome/reason, since D-021 never touches the cwd branch of
// `evaluateOnePolicy`. This is deliberately separator/form-agnostic: the
// assertion does not encode "does cd persist for this separator" (that is
// `command-normalize.ts`'s own D-014 precision concern, not this
// instrument's) — additive safety holds identically whether the model
// detects persistence correctly or not, which is the whole point of D-021.
//
// THE 8 FORMS (named in the task prompt as "targeted read -C, bare read,
// push, git -C B read, --work-tree, multiple -C, tilde multiple -C,
// cd-forgery"; this instrument's own names below map 1:1 onto each
// historically-relevant class measured across the four review passes):
//   1. targeted-read-C-then-push — D-011/T-001(b): a -C-targeted read of
//      the decoy chained with a bare push (read names the decoy, push runs
//      in cwd).
//   2. bare-read                — baseline positive control, no target
//      named anywhere ("bare read").
//   3. push                     — baseline positive control, no target
//      named anywhere ("push").
//   4. targeted-C-read-alone    — "git -C B read": the read itself IS the
//      gated verb, own `-C` target, no chaining. This is D-021's accepted
//      COST (a legit `-C` now demands BOTH cwd and the target), not a
//      bypass class — included to confirm the cost is exactly what was
//      accepted, never less.
//   5. work-tree                — D-017: `--work-tree` does not relocate
//      the git-dir; must stay cwd-derived.
//   6. multiple-C                — D-018: more than one repo-relocating
//      option (second `-C` is cwd itself, mirroring the real pass-3 repro)
//      falls back to cwd, never a first-token guess.
//   7. tilde-multiple-C          — D-020 (pass-4, the form that triggered
//      the halt): a tilde-valued second `-C` is invisible to D-018's
//      ambiguity lock; the decoy still becomes `ownTarget`/`effectiveTarget`
//      the OLD way, but D-021 additive now demands cwd alongside it rather
//      than replacing it.
//   8. cd-forgery                — D-011/D-014: a leading `cd` to the decoy
//      chained with a bare push. This is the ONE form whose behaviour
//      genuinely varies BY separator (persists for `&&`/`;`/newline/`||`,
//      does not for `|` or a subshell close) — included specifically so
//      the SEPARATOR axis has a form that exercises it; the other 7 forms
//      produce an IDENTICAL command regardless of separator (MEASURED
//      below, not assumed — see `sensitiveForms` in the report), and are
//      still run once per separator for a literal, complete 6x8
//      cross-product rather than a deduped/padded total.
//
// THE SELF-TEST (`--self-test`, and always run first by default before the
// full report, same convention as `measure-command-normalize.mjs`): for
// every cell where the patched engine actually exercised the additive
// branch (produced more than one decision for some policy — i.e. a real
// foreign context was attributed), the self-test SABOTAGES that cell's own
// real decision set post-hoc, reproducing pre-D-021 REPLACE semantics
// exactly (drop the cwd-tagged decision, keep only the foreign one) using
// the SAME real control decisions as the reference for "which one was the
// cwd tag". The audit MUST then report a violation for every sabotaged
// cell — an audit that cannot be made to fail proves nothing (the same
// "per-arm gate" discipline `measure-command-normalize.mjs` uses via its
// own `sabotageGates`).
//
// Usage:
//   npm run build                      # produces the local dist/ this
//                                       # script imports (a)
//   node scripts/measure-additive-attribution-matrix.mjs --self-test \
//     --control <dir containing dist/runtime/index.js> [--dist dist]
//   node scripts/measure-additive-attribution-matrix.mjs \
//     --control <dir> [--dist dist] [--manifest <path>]
//
// `--control` is REQUIRED and has no default: it must point at an
// installed harness package directory (containing `dist/runtime/index.js`
// and, implicitly, the same `dist/policies/*` this engine's compiled
// output depends on) — i.e. the (b) "shipped 0.43.0 binary" arm the task
// asked for. This is deliberately NOT hardcoded to any session-scratchpad
// path: a scratchpad directory is ephemeral and would make the checked-in
// script silently unusable (or, worse, silently pointing at nothing) once
// the session that installed it is gone. For this run's own confirmatory
// measurement the control build was installed at
// `<scratchpad>/control/node_modules/@lannguyensi/harness` — see
// `04-implementation-summary.md` / this task's own YAML report for the
// exact invocation and its result.
//
// WHY DIST-IMPORT, NOT A CLI SUBPROCESS: `harness policy intercept` (the
// real PreToolUse hook entrypoint) needs a real evidence-ledger backend
// (grounding-mcp) and a `~/.harness/harness.yaml` install to run as a
// subprocess — neither is this instrument's concern, and both would make a
// two-binary differential slower and less hermetic without adding any
// coverage: `intercept()` is the exact pure function both `runInterceptCli`
// wrappers (local and control) call, unchanged by the CLI plumbing around
// it. Importing it directly (mirroring `measure-command-normalize.mjs`'s
// own `loadRealGates`/`loadCommandNormalize`) measures the load-bearing
// logic itself, hermetically and fast (no subprocess, no real ledger). The
// two REAL policy definitions (`preflight-before-investigation`,
// `preflight-before-push`) are read from the actual shipped
// `docs/examples/full-manifest.yaml`, not hand-written, so the corpus is
// measured against real trigger regexes and real `requires:` clauses, not
// a simplified stand-in.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
export const DEFAULT_MANIFEST = join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");
export const DEFAULT_DIST_DIR = "dist";

// --- separators ----------------------------------------------------------

export const SEPARATORS = [
  { name: "&&", join: (prefix, verb) => `${prefix} && ${verb}` },
  { name: ";", join: (prefix, verb) => `${prefix} ; ${verb}` },
  { name: "newline", join: (prefix, verb) => `${prefix}\n${verb}` },
  { name: "|", join: (prefix, verb) => `${prefix} | ${verb}` },
  { name: "||", join: (prefix, verb) => `${prefix} || ${verb}` },
  // Subshell close — the D-011 CRITICAL pin's own shape
  // (`(cd <forged> ; echo hi) && git push`), simplified to the minimal
  // subshell-wrapped prefix joined by `&&`.
  { name: "subshell", join: (prefix, verb) => `(${prefix}) && ${verb}` },
];

// --- forms -----------------------------------------------------------------
// See the module header for the D-number this form's own historical class
// maps to. `build(sep, ctx)` returns the full command string; a form whose
// command does not depend on `sep` at all (6 of the 8 — measured, not
// assumed, see `sensitiveForms` in `renderReport`) ignores the parameter.

export const FORMS = [
  {
    name: "targeted-read-C-then-push",
    dClass: "D-011/T-001(b)",
    build: (sep, ctx) => sep.join(`git -C ${ctx.decoyRepo} status`, "git push"),
  },
  {
    name: "bare-read",
    dClass: "baseline",
    build: () => "git status",
  },
  {
    name: "push",
    dClass: "baseline",
    build: () => "git push",
  },
  {
    name: "targeted-C-read-alone",
    dClass: "D-021 accepted cost",
    build: (_sep, ctx) => `git -C ${ctx.decoyRepo} status`,
  },
  {
    name: "work-tree",
    dClass: "D-017",
    build: (_sep, ctx) => `git --work-tree=${ctx.decoyRepo} push`,
  },
  {
    name: "multiple-C",
    dClass: "D-018",
    build: (_sep, ctx) => `git -C ${ctx.forgeRepo} -C ${ctx.cwdRepo} push`,
  },
  {
    name: "tilde-multiple-C",
    dClass: "D-020 (pass-4, the halt trigger)",
    build: (_sep, ctx) => `git -C ${ctx.decoyRepo} -C ~/sub push`,
  },
  {
    name: "cd-forgery",
    dClass: "D-011/D-014",
    build: (sep, ctx) => sep.join(`cd ${ctx.decoyRepo}`, "git push"),
  },
];

/** Build the full 6x8 cross-product corpus (48 cells). */
export function buildCorpus({ separators = SEPARATORS, forms = FORMS } = {}) {
  const cells = [];
  for (const sep of separators) {
    for (const form of forms) {
      cells.push({ sepName: sep.name, formName: form.name, dClass: form.dClass, command: form.build(sep, PATH_PLACEHOLDER) });
    }
  }
  return cells;
}

// Placeholder used only by `buildCorpus`'s own size/shape bookkeeping
// (`sensitiveForms` below) — never fed to a real intercept() call, which
// always rebuilds cells against real fixture paths via `buildCorpusForCtx`.
const PATH_PLACEHOLDER = { decoyRepo: "<decoy>", forgeRepo: "<forge>", cwdRepo: "<cwd>" };

/** Same corpus, built against REAL fixture paths for an actual measurement run. */
export function buildCorpusForCtx(ctx, { separators = SEPARATORS, forms = FORMS } = {}) {
  const cells = [];
  for (const sep of separators) {
    for (const form of forms) {
      cells.push({ sepName: sep.name, formName: form.name, dClass: form.dClass, command: form.build(sep, ctx) });
    }
  }
  return cells;
}

/**
 * MEASURED (not assumed): which forms actually produce a DIFFERENT command
 * per separator. Used only for the report's honesty note — the corpus
 * above still runs the full literal 6x8 cross product regardless.
 */
export function sensitiveForms({ separators = SEPARATORS, forms = FORMS } = {}) {
  const sensitive = [];
  for (const form of forms) {
    const commands = new Set(separators.map((sep) => form.build(sep, PATH_PLACEHOLDER)));
    if (commands.size > 1) sensitive.push(form.name);
  }
  return sensitive;
}

// --- fixtures --------------------------------------------------------------

const CWD_SHA = "1".repeat(40);
const DECOY_SHA = "2".repeat(40);
const FORGE_SHA = "3".repeat(40);

function makeRepoFixture(root, name, branch, sha) {
  const repo = join(root, name);
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(repo, ".git", "refs", "heads", branch), `${sha}\n`);
  return repo;
}

/** Ledger holding ONLY the decoy's own evidence — cwd's own tag is NEVER present, by construction. */
function ledgerWithDecoyOnlyEvidence() {
  const entries = [
    { id: "e0", content: "preflight:decoy-repo — evidence for the decoy target only", createdAt: new Date().toISOString() },
    { id: "e1", content: `preflight:decoy-branch head:${DECOY_SHA} — evidence for the decoy target only`, createdAt: new Date().toISOString() },
  ];
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

// --- dist loading ------------------------------------------------------------

async function importDist(baseDir, relPath, label) {
  const full = resolve(baseDir, relPath);
  try {
    return await import(pathToFileURL(full).href);
  } catch (cause) {
    throw new Error(`${label} module could not be loaded from ${full} (${cause.message})`);
  }
}

/**
 * Load both engines' `intercept()` plus the two real per-repo-builtins
 * policies (`preflight-before-investigation`, `preflight-before-push`)
 * straight out of the shipped `docs/examples/full-manifest.yaml`, parsed
 * ONCE via the LOCAL schema module (git-context.js / the schema shape are
 * unchanged by this run — see `03-decisions.md` D-021's own "resolverGit
 * byte-identical" claim — so the resulting plain `Policy` objects are
 * valid input to EITHER engine's `intercept()`, which only ever reads
 * plain properties off them, never anything version-specific).
 */
export async function loadEngines({ distDir = DEFAULT_DIST_DIR, controlDir, manifestPath = DEFAULT_MANIFEST } = {}) {
  if (!controlDir) {
    throw new Error(
      "loadEngines: controlDir is required — pass --control <dir containing dist/runtime/index.js> " +
        "(an installed 0.43.0 harness package directory; see this script's own header comment for why there " +
        "is no hardcoded default)",
    );
  }
  const localRuntime = await importDist(distDir, join("runtime", "index.js"), "local runtime");
  const controlRuntime = await importDist(controlDir, join("dist", "runtime", "index.js"), "control runtime");
  const schemaMod = await importDist(distDir, join("schema", "index.js"), "local schema");

  const raw = parseYaml(readFileSync(manifestPath, "utf8"));
  const manifest = schemaMod.parseManifest(raw);
  const byName = new Map(manifest.policies.map((p) => [p.name, p]));
  for (const name of ["preflight-before-investigation", "preflight-before-push"]) {
    if (!byName.has(name)) throw new Error(`manifest ${manifestPath} is missing required policy: ${name}`);
  }
  const corpusManifest = {
    policies: [byName.get("preflight-before-investigation"), byName.get("preflight-before-push")],
  };

  return { local: localRuntime, control: controlRuntime, manifest: corpusManifest, resolveGitContext: localRuntime.resolveGitContext };
}

// --- per-cell measurement ---------------------------------------------------

function builtinsFor(resolveGitContext, cwdRepo) {
  const gitCtx = resolveGitContext(cwdRepo);
  return {
    builtins: { SESSION_ID: "sess", REPO: gitCtx.repo, BRANCH: gitCtx.branch, TOOL_NAME: "Bash", CWD: cwdRepo },
    currentHeadSha: gitCtx.sha.length > 0 ? gitCtx.sha : undefined,
  };
}

/** Run one cell through both engines. Pure I/O aside from the (already-built) fixture filesystem. */
export async function runCell({ local, control, manifest, cwdRepo, resolveGitContext }, cell, cellId) {
  const { builtins, currentHeadSha } = builtinsFor(resolveGitContext, cwdRepo);
  const event = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: cell.command },
    session_id: `sess-${cellId}`,
    cwd: cwdRepo,
  };
  const ledgerForControl = ledgerWithDecoyOnlyEvidence();
  const ledgerForLocal = ledgerWithDecoyOnlyEvidence();
  const controlResult = await control.intercept({ manifest, event, ledger: ledgerForControl, builtins, currentHeadSha });
  const localResult = await local.intercept({ manifest, event, ledger: ledgerForLocal, builtins, currentHeadSha });
  return {
    ...cell,
    controlDecisions: controlResult.decisions,
    localDecisions: localResult.decisions,
    controlBlocked: controlResult.blockJson !== null,
    localBlocked: localResult.blockJson !== null,
  };
}

// --- audit -------------------------------------------------------------------

/**
 * Per-cell "never weaker than shipped" audit. For every policy the CONTROL
 * engine produced a decision for, the PATCHED engine must carry a decision
 * for the SAME policy with the SAME (control-computed) cwd ledger tag, and
 * that decision's outcome must be IDENTICAL. `additiveHits` names which
 * policies produced MORE THAN ONE local decision (i.e. genuinely exercised
 * the additive foreign-context branch) — consumed by the self-test to know
 * which cells are worth sabotaging.
 */
export function auditCell(cell) {
  const violations = [];
  const additiveHits = [];
  for (const cDec of cell.controlDecisions) {
    const matches = cell.localDecisions.filter((d) => d.policyName === cDec.policyName);
    const cwdMatch = matches.find((d) => d.ledgerTag === cDec.ledgerTag);
    if (!cwdMatch) {
      violations.push(
        `${cell.formName}/${cell.sepName}: policy ${cDec.policyName} — no local decision carries ` +
          `control's own cwd ledgerTag ${JSON.stringify(cDec.ledgerTag)} at all`,
      );
      continue;
    }
    if (cwdMatch.outcome !== cDec.outcome) {
      violations.push(
        `${cell.formName}/${cell.sepName}: policy ${cDec.policyName} — cwd decision outcome diverges: ` +
          `control=${cDec.outcome} local=${cwdMatch.outcome}`,
      );
    }
    if (matches.length > 1) additiveHits.push(cDec.policyName);
  }
  if (cell.controlBlocked && !cell.localBlocked) {
    violations.push(`${cell.formName}/${cell.sepName}: control blocked the whole event, local did NOT`);
  }
  return { cell, violations, additiveHits };
}

/**
 * Reproduce pre-D-021 REPLACE semantics post-hoc on a cell's REAL decision
 * set: for every policy whose local decisions include the additive branch
 * (more than one decision), drop the one carrying the cwd tag (identified
 * via the REAL control decision for that policy — not guessed), keeping
 * only the foreign one(s). A cell with no additive hits is returned
 * unchanged (nothing to sabotage — same "proves nothing" exclusion
 * `measure-command-normalize.mjs`'s per-arm gate uses).
 */
export function sabotageReplace(cell) {
  const cwdTagByPolicy = new Map(cell.controlDecisions.map((d) => [d.policyName, d.ledgerTag]));
  const byPolicy = new Map();
  for (const d of cell.localDecisions) {
    if (!byPolicy.has(d.policyName)) byPolicy.set(d.policyName, []);
    byPolicy.get(d.policyName).push(d);
  }
  const sabotagedDecisions = [];
  const sabotagedPolicies = [];
  for (const [policyName, group] of byPolicy) {
    if (group.length <= 1) {
      sabotagedDecisions.push(...group);
      continue;
    }
    const cwdTag = cwdTagByPolicy.get(policyName);
    const kept = group.filter((d) => d.ledgerTag !== cwdTag);
    sabotagedDecisions.push(...(kept.length > 0 ? kept : group));
    if (kept.length > 0 && kept.length < group.length) sabotagedPolicies.push(policyName);
  }
  const localBlocked = sabotagedDecisions.some((d) => d.outcome === "deny" || d.outcome === "require_approval");
  return { ...cell, localDecisions: sabotagedDecisions, localBlocked, sabotagedPolicies };
}

// --- self-test -----------------------------------------------------------

/**
 * Runs the full healthy matrix, then sabotages every additive-hit cell and
 * re-audits. Fails (not just warns) when: (a) the healthy matrix itself
 * shows any violation (the property this task exists to confirm does NOT
 * hold), (b) NO cell ever exercised the additive branch (the corpus proves
 * nothing about REPLACE-immunity — same "positive control never fired"
 * discipline as `measure-command-normalize.mjs`), or (c) any sabotaged
 * additive-hit cell FAILED to produce a violation (a dead referee — the
 * instrument cannot detect the exact regression class this whole run
 * fixed).
 */
export async function runSelfTest(engines, ctx) {
  const cells = buildCorpusForCtx(ctx);
  const results = [];
  for (let i = 0; i < cells.length; i++) {
    results.push(await runCell(engines, cells[i], `self-${i}`));
  }
  const healthyAudits = results.map(auditCell);
  const healthyViolations = healthyAudits.flatMap((a) => a.violations);

  const additiveCells = results.filter((_, i) => healthyAudits[i].additiveHits.length > 0);
  const sabotagedAudits = additiveCells.map((c) => auditCell(sabotageReplace(c)));
  const undetected = sabotagedAudits.filter((a) => a.violations.length === 0);

  const failures = [];
  if (healthyViolations.length > 0) {
    failures.push(`healthy matrix has ${healthyViolations.length} violation(s) — see the list below`);
  }
  if (additiveCells.length === 0) {
    failures.push("no cell ever exercised the additive branch — the corpus proves nothing about REPLACE-immunity");
  }
  if (undetected.length > 0) {
    failures.push(
      `${undetected.length}/${additiveCells.length} additive-hit cell(s), sabotaged to REPLACE semantics, ` +
        "did NOT produce a violation — the audit cannot detect this regression class",
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    healthyViolations,
    totalCells: results.length,
    additiveHitCount: additiveCells.length,
    sabotageDetectedCount: additiveCells.length - undetected.length,
  };
}

// --- report ----------------------------------------------------------------

export function renderReport({ audits, selfTest }) {
  const lines = [];
  const sensitive = sensitiveForms();
  lines.push(
    `measure-additive-attribution-matrix: corpus = ${SEPARATORS.length} separators x ${FORMS.length} forms = ` +
      `${audits.length} cells (${sensitive.length}/${FORMS.length} forms are separator-sensitive: ` +
      `${sensitive.join(", ")}; the remaining ${FORMS.length - sensitive.length} forms produce an IDENTICAL ` +
      "command regardless of separator — measured, still run once per separator for a literal cross product)",
  );
  const totalViolations = audits.reduce((n, a) => n + a.violations.length, 0);
  const failingCellCount = audits.filter((a) => a.violations.length > 0).length;
  const additiveCellCount = audits.filter((a) => a.additiveHits.length > 0).length;
  lines.push(
    `healthy matrix: ${audits.length - failingCellCount}/${audits.length} cells pass, ${totalViolations} ` +
      `violation(s) across ${failingCellCount} cell(s), ${additiveCellCount}/${audits.length} cells exercised ` +
      "the additive branch (>1 local decision for some policy)",
  );
  if (totalViolations > 0) {
    lines.push("VIOLATIONS (weaker than 0.43.0 — this must be empty for the task's criterion 4 to hold):");
    for (const a of audits) for (const v of a.violations) lines.push(`  ${v}`);
  }
  lines.push(
    `self-test: ${selfTest.ok ? "OK" : "FAILED"} — ${selfTest.additiveHitCount}/${selfTest.totalCells} additive-hit ` +
      `cells, sabotage caught ${selfTest.sabotageDetectedCount}/${selfTest.additiveHitCount}`,
  );
  for (const f of selfTest.failures) lines.push(`  SELF-TEST FAILURE: ${f}`);
  return lines.join("\n");
}

// --- CLI ---------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { selfTestOnly: false, manifest: DEFAULT_MANIFEST, distDir: DEFAULT_DIST_DIR, controlDir: undefined };
  const valueOf = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") args.selfTestOnly = true;
    else if (arg === "--manifest") args.manifest = valueOf(arg, (i += 1));
    else if (arg === "--dist") args.distDir = valueOf(arg, (i += 1));
    else if (arg === "--control") args.controlDir = valueOf(arg, (i += 1));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function makeFixtureCtx() {
  const root = mkdtempSync(join(tmpdir(), "harness-98ad072f-matrix-"));
  const cwdRepo = makeRepoFixture(root, "cwd-repo", "cwd-branch", CWD_SHA);
  const decoyRepo = makeRepoFixture(root, "decoy-repo", "decoy-branch", DECOY_SHA);
  const forgeRepo = makeRepoFixture(root, "forge-repo", "forge-branch", FORGE_SHA);
  return { ctx: { cwdRepo, decoyRepo, forgeRepo }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.controlDir) {
    console.error(
      "measure-additive-attribution-matrix: --control <dir containing dist/runtime/index.js> is required — " +
        "see this script's own header comment for why there is no hardcoded default.",
    );
    process.exitCode = 1;
    return;
  }

  const engines = await loadEngines({ distDir: args.distDir, controlDir: args.controlDir, manifestPath: args.manifest });
  const { ctx, dispose } = makeFixtureCtx();
  try {
    const selfTest = await runSelfTest(engines, ctx);
    if (!selfTest.ok) {
      console.error("measure-additive-attribution-matrix: SELF-TEST FAILED — no measurement below can be trusted:");
      for (const f of selfTest.failures) console.error(`  - ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "measure-additive-attribution-matrix: self-test ok (sabotaging a real cell to pre-D-021 REPLACE " +
        "semantics is caught by the audit)",
    );
    if (args.selfTestOnly) return;

    const cells = buildCorpusForCtx(ctx);
    const results = [];
    for (let i = 0; i < cells.length; i++) {
      results.push(await runCell(engines, cells[i], `main-${i}`));
    }
    const audits = results.map(auditCell);
    console.log(renderReport({ audits, selfTest }));
    if (audits.some((a) => a.violations.length > 0)) process.exitCode = 1;
  } finally {
    dispose();
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`measure-additive-attribution-matrix: ${error.message}`);
    process.exitCode = 1;
  });
}
