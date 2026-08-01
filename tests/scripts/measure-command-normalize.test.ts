import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditArmA,
  auditArmB,
  auditArmC,
  buildCorpusA,
  buildCorpusB,
  buildCorpusC,
  evaluateSelfTest,
  KNOWN_GOOD_WRAPPERS,
  KNOWN_UNSUPPORTED_WRAPPERS,
  parseArgs,
  QVALS,
  renderReportA,
  renderReportB,
  renderReportC,
  VERBS,
  WRAPPERS,
} from "../../scripts/measure-command-normalize.mjs";
import { resolveBash } from "../../scripts/measure-bash-prefix-parse.mjs";

// Derive the audit type from the imported value rather than importing the
// named type: a `type` import from a `.mjs` only resolves via the colocated
// `.d.mts` under tsconfig.test.json, but an editor's default resolver flags
// it (TS2305). `ReturnType<typeof auditArmA>` needs only the value import,
// which every config resolves, and matches the sibling test's value-only
// import convention.
type ArmAAudit = ReturnType<typeof auditArmA>;

// The audit core is tested hermetically: `gates`/`bashRan`/`normalize` are
// injected stubs, no manifest is parsed and no bash process is ever
// spawned in here. The real-bash + real-manifest path is covered by the
// CLI self-test e2e at the bottom (spawns `node`, INFRA-allowlisted; real
// bash runs as its grandchild). Types come from the colocated
// measure-command-normalize.d.mts (see that file's header for why a
// sibling .d.mts, not an inline declaration, is required here).

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} unexpectedly missing`);
  return value;
}

describe("buildCorpusA", () => {
  it("factorises 8 wrappers x 4 qvals x 4 verbs = 128 assignment shapes, plus 32 positive controls", () => {
    const { shapes, controls } = buildCorpusA();
    expect(WRAPPERS.length).toBe(8);
    expect(QVALS.length).toBe(4);
    expect(VERBS.length).toBe(4);
    expect(shapes.length).toBe(128);
    expect(controls.length).toBe(32);
  });

  it("renders the assignment form as <wrapper> FOO=<qval> <verb> and the control with no assignment at all", () => {
    const { shapes, controls } = buildCorpusA({ wrappers: ["env"], qvals: ["'a&b'"], verbs: [VERBS[0]!] });
    expect(shapes).toEqual([
      {
        arm: "env",
        wrapper: "env",
        verb: "git push origin master",
        verbHead: "git",
        policy: "preflight-before-push",
        qval: "'a&b'",
        cmd: "env FOO='a&b' git push origin master",
      },
    ]);
    expect(controls).toEqual([
      {
        arm: "env",
        wrapper: "env",
        verb: "git push origin master",
        verbHead: "git",
        policy: "preflight-before-push",
        cmd: "env git push origin master",
      },
    ]);
  });

  it("every qval contains a literal & so the corpus actually exercises the reverted-fix regression shape", () => {
    for (const qval of QVALS) expect(qval).toContain("&");
  });
});

describe("auditArmA", () => {
  function stubAudit(overrides: {
    gates: (cmd: string, policy: string) => boolean;
    bashRan: (cmd: string, verbHead: string) => boolean;
  }): ArmAAudit {
    const built = buildCorpusA({ wrappers: ["env"], qvals: ["'a&b'", '"a&b"'], verbs: [VERBS[0]!] });
    return auditArmA({ shapes: built.shapes, controls: built.controls, ...overrides });
  }

  it("a fully-measured arm reports kept-gate count with no exclusions", () => {
    const audit = stubAudit({ gates: () => true, bashRan: () => true });
    const st = must(audit.arms.get("env"), "env arm");
    expect(audit.gateReason(st)).toBe(null);
    expect(audit.totals.keptGate).toBe(2);
    expect(audit.totals.regressed).toBe(0);
    expect(audit.totals.meaningfulZero).toBe(true);
    expect(audit.totals.unmeasuredArms).toEqual([]);
  });

  it("flags NO SHAPES RAN when bash never proves the verb executes at all", () => {
    const audit = stubAudit({ gates: () => true, bashRan: () => false });
    const st = must(audit.arms.get("env"), "env arm");
    expect(audit.gateReason(st)).toMatch(/^NO SHAPES RAN/);
    expect(audit.totals.unmeasuredArms).toEqual([{ arm: "env", reason: audit.gateReason(st) }]);
    expect(audit.totals.meaningfulZero).toBe(false);
  });

  it("flags POSITIVE CONTROL NEVER FIRED when the bare-verb control never gates, even though bash proves it runs", () => {
    const audit = stubAudit({
      gates: (cmd) => cmd.includes("FOO="), // assignment forms "gate", the bare control never does
      bashRan: () => true,
    });
    const st = must(audit.arms.get("env"), "env arm");
    expect(audit.gateReason(st)).toMatch(/^POSITIVE CONTROL NEVER FIRED/);
  });

  it("the per-arm gate rule: an unmeasured arm's numbers are NEVER folded into the total, and the total says so", () => {
    const built = buildCorpusA({ wrappers: ["env", "nice"], qvals: ["'a&b'"], verbs: [VERBS[0]!] });
    // "env" bash-runs; "nice" never does (proves nothing) — discriminate
    // by wrapper name so the two arms are NOT symmetric.
    const discriminating = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: () => true,
      bashRan: (cmd) => cmd.startsWith("env"),
    });
    const envSt = must(discriminating.arms.get("env"), "env arm");
    const niceSt = must(discriminating.arms.get("nice"), "nice arm");
    expect(discriminating.gateReason(envSt)).toBe(null);
    expect(discriminating.gateReason(niceSt)).toMatch(/^NO SHAPES RAN/);
    // "nice" gated everything too (gates always true) — if its numbers
    // were folded in, keptGate would count nice's shape too. It must not.
    expect(discriminating.totals.keptGate).toBe(1); // only env's single shape
    expect(discriminating.totals.measuredArms).toBe(1);
    expect(discriminating.totals.unmeasuredArms).toEqual([
      { arm: "nice", reason: discriminating.gateReason(niceSt) },
    ]);
    expect(discriminating.totals.meaningfulZero).toBe(false);
  });

  it("a shape that gates WITHOUT bash-running never inflates keptGate (keptGate counts ran-and-gated only)", () => {
    const built = buildCorpusA({ wrappers: ["env"], qvals: ["'a&b'", '"a&b"'], verbs: [VERBS[0]!] });
    // Everything "gates"; everything bash-runs EXCEPT the double-quoted
    // shape. The positive control (`env <verb>`, no FOO=) still runs and
    // gates, so the arm is measured — but the one shape that gates without
    // running must not be counted as a kept gate.
    const audit = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: () => true,
      bashRan: (cmd) => !cmd.includes('"a&b"'),
    });
    const st = must(audit.arms.get("env"), "env arm");
    expect(audit.gateReason(st)).toBe(null); // measured
    expect(st.gated).toBe(2); // raw gate count includes the non-running shape
    expect(st.ranAndGated).toBe(1); // but only one shape both ran AND gated
    expect(st.bashRan).toBe(1);
    expect(audit.totals.keptGate).toBe(1); // keptGate follows ranAndGated, not raw gated
    expect(audit.totals.regressed).toBe(0);
  });

  it("counts a bash-proven, ungated assignment shape as regressed, only for a measured arm", () => {
    const built = buildCorpusA({ wrappers: ["env"], qvals: ["'a&b'", '"a&b"'], verbs: [VERBS[0]!] });
    const audit = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      // control gates (positive control fires); one of the two assignment
      // shapes does not.
      gates: (cmd) => !cmd.includes(`FOO='a&b'`),
      bashRan: () => true,
    });
    const st = must(audit.arms.get("env"), "env arm");
    expect(audit.gateReason(st)).toBe(null);
    expect(st.notGated).toEqual(["env FOO='a&b' git push origin master"]);
    expect(audit.totals.regressed).toBe(1);
    expect(audit.totals.keptGate).toBe(1);
  });
});

describe("renderReportA", () => {
  it("pins the column header and the per-arm gate column", () => {
    const built = buildCorpusA({ wrappers: ["env"], qvals: ["'a&b'"], verbs: [VERBS[0]!] });
    const audit = auditArmA({ ...built, gates: () => true, bashRan: () => true });
    const report = renderReportA(audit);
    expect(report).toContain("wrapper     shapes  bash-ran  gated  regressed  gate");
  });

  it("renders the NOT-a-global marker and lists the excluded arm + reason when one exists", () => {
    const built = buildCorpusA({ wrappers: ["env", "nice"], qvals: ["'a&b'"], verbs: [VERBS[0]!] });
    const audit = auditArmA({ ...built, gates: () => true, bashRan: (cmd) => cmd.startsWith("env") });
    const report = renderReportA(audit);
    expect(report).toContain("NOT a global");
    expect(report).toContain("nice — NO SHAPES RAN");
  });

  it("renders the REGRESSED marker only when a regression actually occurred", () => {
    const built = buildCorpusA({ wrappers: ["env"], qvals: ["'a&b'"], verbs: [VERBS[0]!] });
    const clean = auditArmA({ ...built, gates: () => true, bashRan: () => true });
    expect(renderReportA(clean)).not.toContain("REGRESSED");

    const regressed = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: (cmd) => !cmd.includes("FOO="),
      bashRan: () => true,
    });
    const report = renderReportA(regressed);
    expect(report).toContain("REGRESSED");
    expect(report).toContain(JSON.stringify("env FOO='a&b' git push origin master"));
  });
});

describe("buildCorpusB", () => {
  it("builds the glued-ampersand family (8 wrappers x 4 verbs) plus the background-job family (4 verbs)", () => {
    const shapes = buildCorpusB();
    expect(shapes.filter((s) => s.family === "glued-ampersand").length).toBe(32);
    expect(shapes.filter((s) => s.family === "background-job").length).toBe(4);
    expect(shapes.length).toBe(36);
  });

  it("the glued-ampersand shape has no space between the assignment and the wrapper", () => {
    const [shape] = buildCorpusB({ wrappers: ["env"], verbs: [VERBS[0]!] });
    expect(shape!.cmd).toBe("A=x&env -C /tmp git push origin master");
  });

  it("the background-job shape is a genuine bash background job (spaced &)", () => {
    const shapes = buildCorpusB({ verbs: [VERBS[0]!] });
    const bg = shapes.find((s) => s.family === "background-job");
    expect(bg!.cmd).toBe("echo hi & nice git push origin master");
  });
});

describe("auditArmB", () => {
  it("is purely descriptive: an all-ungated stub reports every form ungated, no closure claim", () => {
    const shapes = buildCorpusB({ wrappers: ["env"], verbs: [VERBS[0]!, VERBS[1]!] });
    const audit = auditArmB({ shapes, gates: () => false });
    // 1 wrapper x 2 verbs (glued-ampersand) + 2 verbs (background-job, always "nice") = 4
    expect(audit.total).toBe(4);
    expect(audit.ungated).toBe(4);
    expect(audit.gated).toBe(0);
  });

  it("counts ungated vs gated per family", () => {
    const shapes = buildCorpusB({ wrappers: ["env", "nice"], verbs: [VERBS[0]!] });
    // 2 glued-ampersand + 1 background-job (background-job always uses "nice")
    expect(shapes.length).toBe(3);
    const audit = auditArmB({ shapes, gates: (cmd) => cmd.includes("nice") && cmd.startsWith("A=") });
    // Only the glued-ampersand "nice" form gates under this stub.
    expect(audit.gated).toBe(1);
    expect(audit.ungated).toBe(2);
    expect(audit.byFamily.get("glued-ampersand")?.ungated).toBe(1);
    expect(audit.byFamily.get("background-job")?.ungated).toBe(1);
  });
});

describe("renderReportB", () => {
  it("labels the arm descriptive and names aabbad63 as the closing task, never claiming closure", () => {
    const shapes = buildCorpusB({ wrappers: ["env"], verbs: [VERBS[0]!] });
    const audit = auditArmB({ shapes, gates: () => false });
    const report = renderReportB(audit);
    expect(report).toContain("DESCRIPTIVE");
    expect(report).toContain("aabbad63");
    expect(report).not.toMatch(/\bis closed\b/i);
    expect(report).toContain("NOT asserted closed");
  });
});

describe("buildCorpusC / auditArmC", () => {
  it("builds the four targetDir invariant cases", () => {
    const cases = buildCorpusC();
    expect(cases.map((c) => c.expected)).toEqual(["/x", "/x", "/x", "/tmp/repoB"]);
  });

  it("passes when the injected normalize function agrees with every expectation", () => {
    const cases = buildCorpusC();
    const audit = auditArmC({
      cases,
      normalize: (cmd) => ({ targetDir: cmd.includes("repoB") ? "/tmp/repoB" : "/x" }),
    });
    expect(audit.allPass).toBe(true);
    expect(audit.failed).toEqual([]);
  });

  it("fails a specific case when the injected normalize function disagrees (proves the assertion can fail)", () => {
    const cases = buildCorpusC();
    const audit = auditArmC({ cases, normalize: () => ({ targetDir: "/wrong" }) });
    expect(audit.allPass).toBe(false);
    expect(audit.failed.length).toBe(4);
    expect(audit.failed[0]!.actual).toBe("/wrong");
  });
});

describe("renderReportC", () => {
  it("renders PASS/FAIL per case", () => {
    const cases = buildCorpusC();
    const audit = auditArmC({ cases, normalize: () => ({ targetDir: "/wrong" }) });
    const report = renderReportC(audit);
    expect(report).toContain("[FAIL]");
  });
});

// --- evaluateSelfTest -------------------------------------------------
// Pure and pinned here so a deleted assertion cannot vanish silently.

function healthyAuditFor(wrappers: string[]): ArmAAudit {
  const positiveControlWrappers = new Set<string>(KNOWN_GOOD_WRAPPERS);
  const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
  return auditArmA({
    shapes: built.shapes,
    controls: built.controls,
    // known-good wrappers gate everything (assignment + control); known-
    // unsupported wrappers never gate their control (mirrors the real,
    // measured nohup/timeout behaviour) but the audit still bash-runs them.
    gates: (cmd) => positiveControlWrappers.has(cmd.split(" ")[0]!),
    bashRan: () => true,
  });
}

function sabotagedAuditFor(wrappers: string[]): ArmAAudit {
  const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
  return auditArmA({
    shapes: built.shapes,
    controls: built.controls,
    gates: (cmd) => !cmd.includes("FOO="), // controls still gate, assignment forms never do
    bashRan: () => true,
  });
}

function selfTestPair(
  overrides: { wrappers?: string[]; healthy?: ArmAAudit; sabotaged?: ArmAAudit } = {},
): { healthy: ArmAAudit; sabotaged: ArmAAudit } {
  const wrappers = overrides.wrappers ?? [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
  return {
    healthy: overrides.healthy ?? healthyAuditFor(wrappers),
    sabotaged: overrides.sabotaged ?? sabotagedAuditFor(wrappers),
  };
}

describe("evaluateSelfTest", () => {
  it("passes a well-formed healthy/sabotaged pair with no failures", () => {
    const { failures } = evaluateSelfTest(selfTestPair());
    expect(failures).toEqual([]);
  });

  it("fails when a known-good wrapper never bash-ran on the healthy corpus (environment/shim chain broken)", () => {
    const wrappers = [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
    const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
    const broken = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: () => true,
      bashRan: (cmd) => !cmd.startsWith("env"), // "env" never runs
    });
    const { failures } = evaluateSelfTest({ healthy: broken, sabotaged: sabotagedAuditFor(wrappers) });
    expect(failures.some((f) => f.includes('wrapper "env" never bash-ran'))).toBe(true);
  });

  it("fails when a known-good wrapper's arm is missing entirely from the healthy corpus", () => {
    const { sabotaged } = selfTestPair();
    const healthy = healthyAuditFor(KNOWN_UNSUPPORTED_WRAPPERS); // "env" etc. missing
    const { failures } = evaluateSelfTest({ healthy, sabotaged });
    expect(failures.some((f) => f.includes('wrapper "env" never bash-ran'))).toBe(true);
  });

  it("fails when a known-unsupported wrapper's arm is missing entirely from the healthy corpus", () => {
    const { sabotaged } = selfTestPair();
    const healthy = healthyAuditFor(KNOWN_GOOD_WRAPPERS); // nohup/timeout missing
    const { failures } = evaluateSelfTest({ healthy, sabotaged });
    expect(failures.some((f) => f.includes('missing the "nohup" arm entirely'))).toBe(true);
  });

  it("fails when the positive-control-never-fired rung does not fire on a known-unsupported wrapper", () => {
    const wrappers = [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
    const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
    const healthy = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: () => true, // everything gates, including nohup/timeout controls
      bashRan: () => true,
    });
    const { failures } = evaluateSelfTest({ healthy, sabotaged: sabotagedAuditFor(wrappers) });
    expect(
      failures.some((f) => f.includes('wrapper "nohup" was NOT flagged POSITIVE CONTROL NEVER FIRED')),
    ).toBe(true);
  });

  it("treats a regression already present on the healthy corpus as a warning, never a failure", () => {
    const wrappers = [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
    const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
    const goodSet = new Set<string>(KNOWN_GOOD_WRAPPERS);
    const healthyWithRegression = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: (cmd) => {
        const wrapper = cmd.split(" ")[0]!;
        if (!goodSet.has(wrapper)) return false;
        // "env"'s FOO='a&b' shape specifically fails to gate — a genuine
        // regression on otherwise-healthy code.
        if (wrapper === "env" && cmd.includes("FOO='a&b'")) return false;
        return true;
      },
      bashRan: () => true,
    });
    const { failures, warnings } = evaluateSelfTest({
      healthy: healthyWithRegression,
      sabotaged: sabotagedAuditFor(wrappers),
    });
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.includes("regressed form(s)"))).toBe(true);
  });

  it("fails when the sabotage does not change the bash-ran count (referee itself broke, proves nothing)", () => {
    const { healthy } = selfTestPair();
    const wrappers = [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
    const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
    const deadReferee = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      gates: (cmd) => !cmd.includes("FOO="),
      bashRan: () => false, // referee died between the two audits
    });
    const { failures } = evaluateSelfTest({ healthy, sabotaged: deadReferee });
    expect(failures.some((f) => f.includes("the referee itself broke"))).toBe(true);
  });

  it("fails when the sabotage is only partial (does not lose ALL assignment shapes for a known-good wrapper)", () => {
    const { healthy } = selfTestPair();
    const wrappers = [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
    const built = buildCorpusA({ wrappers, qvals: QVALS, verbs: VERBS });
    const weakSabotage = auditArmA({
      shapes: built.shapes,
      controls: built.controls,
      // Only ONE qval is sabotaged instead of all four.
      gates: (cmd) => !cmd.includes(`FOO='a&b'`),
      bashRan: () => true,
    });
    const { failures } = evaluateSelfTest({ healthy, sabotaged: weakSabotage });
    expect(failures.some((f) => f.includes("too weak/inert"))).toBe(true);
  });

  it("fails when the sabotaged corpus is missing a known-good wrapper's arm entirely", () => {
    const { healthy } = selfTestPair();
    const sabotaged = sabotagedAuditFor(KNOWN_UNSUPPORTED_WRAPPERS); // "env" etc. missing
    const { failures } = evaluateSelfTest({ healthy, sabotaged });
    expect(failures.some((f) => f.includes('sabotaged corpus is missing the "env" arm entirely'))).toBe(true);
  });

  it("fails when the sabotaged report loses the REGRESSED marker while the per-arm data still shows the loss", () => {
    const { healthy, sabotaged } = selfTestPair();
    const markerless: ArmAAudit = { ...sabotaged, totals: { ...sabotaged.totals, regressed: 0 } };
    const { failures } = evaluateSelfTest({ healthy, sabotaged: markerless });
    expect(failures.some((f) => f.includes("REGRESSED marker"))).toBe(true);
  });
});

describe("the per-arm gate never folds an unmeasured arm into a zero (property, real corpus)", () => {
  it("nohup and timeout are excluded from Arm A's real total, not silently counted as zero regressions", () => {
    // This mirrors what the real measurement run reports (see the CLI
    // e2e below): with real gates, nohup/timeout's positive control never
    // fires, so they must never contribute a false "0 regressed" to the
    // total — they must be named as excluded instead.
    const wrappers = [...KNOWN_GOOD_WRAPPERS, ...KNOWN_UNSUPPORTED_WRAPPERS];
    const audit = healthyAuditFor(wrappers);
    expect(audit.totals.meaningfulZero).toBe(false);
    expect(audit.totals.unmeasuredArms.map((u) => u.arm).sort()).toEqual([...KNOWN_UNSUPPORTED_WRAPPERS].sort());
  });
});

describe("parseArgs", () => {
  it("defaults to a full run against the shipped manifest/dist", () => {
    const args = parseArgs([]);
    expect(args.selfTestOnly).toBe(false);
    expect(args.manifest).toMatch(/full-manifest\.yaml$/);
    expect(args.distDir).toBe("dist");
  });

  it("accepts --self-test, --manifest, and --dist", () => {
    const args = parseArgs(["--self-test", "--manifest", "/m.yaml", "--dist", "/d"]);
    expect(args.selfTestOnly).toBe(true);
    expect(args.manifest).toBe("/m.yaml");
    expect(args.distDir).toBe("/d");
  });

  it("rejects a flag without a value", () => {
    expect(() => parseArgs(["--manifest"])).toThrow(/needs a value/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

// --- CLI self-test e2e --------------------------------------------------
// Spawns the tool via `node` (INFRA-allowlisted); real bash runs as a
// grandchild. Skipped when bash is absent or the build hasn't run
// (CI builds before testing; locally run `npm run build` first).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "measure-command-normalize.mjs");
const builtCommandNormalize = join(repoRoot, "dist", "runtime", "command-normalize.js");
const bashOnPath = resolveBash() !== null;

if (!bashOnPath || !existsSync(builtCommandNormalize)) {
  // Do not let a missing build or a bash-less environment read as a pass:
  // the CLI e2e below carries the load-bearing real-path assertions, and a
  // silent skip would hide that they never ran (run `npm run build` first).
  console.warn(
    `[measure-command-normalize.test] skipping real-bash CLI e2e: ` +
      `bashOnPath=${bashOnPath}, built=${existsSync(builtCommandNormalize)}`,
  );
}

describe.skipIf(!bashOnPath || !existsSync(builtCommandNormalize))("CLI self-test (real bash + real manifest)", () => {
  it("--self-test passes against the current build and shipped manifest", () => {
    const out = execFileSync(process.execPath, [script, "--self-test"], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 120_000,
    });
    expect(out).toContain("self-test ok");
  }, 150_000);

  it("a full run reports arm A all-keep-gate for the 6 measured wrappers and arm B fail-open", () => {
    const out = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 120_000,
    });
    expect(out).toContain("96 kept gate, 0 lost");
    expect(out).toContain("NOT a global 8-wrapper result: 2 of 8 arms prove nothing");
    expect(out).toContain("36/36 forms ungated today");
  }, 150_000);
});
