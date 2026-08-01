import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditCorpus,
  buildCorpus,
  evaluateSelfTest,
  parseArgs,
  renderReport,
  resolveBash,
  SABOTAGE_MISSING_SPACE,
  SELF_TEST_BLIND_BASELINE,
  SELF_TEST_IDENTITY_BASELINE,
  SEPARATOR_ARMS,
} from "../../scripts/measure-bash-prefix-parse.mjs";

// The audit core is tested hermetically: bash and the parser builds are
// injected stubs, no process is ever spawned in here. The real-bash
// path is covered by the CLI self-test e2e at the bottom, which spawns
// `node` (INFRA-allowlisted) and lets bash run as its grandchild — the
// hermetic-spawn guard's documented residual scope, used deliberately.

const TARGET = "/measure/target";

type Shape = { arm: string; cmd: string };

function audit(overrides: {
  shapes: Shape[];
  runReal: (cmd: string) => string | null;
  candidateParse: (cmd: string) => string | null;
  baselines: Array<{ name: string; parse: (cmd: string) => string | null }>;
}) {
  return auditCorpus({ targetDir: TARGET, ...overrides });
}

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} unexpectedly missing`);
  return value;
}

describe("buildCorpus", () => {
  it("samples BOTH spellings of every separator (with and without a following space)", () => {
    for (const base of [";", "&&", "&", "||", "|", ">o", "<in", "("]) {
      expect(SEPARATOR_ARMS).toContain(base);
      expect(SEPARATOR_ARMS).toContain(`${base} `);
    }
    expect(SEPARATOR_ARMS).toContain(" ");
  });

  it("renders the separator-less arm with the space that round 3 lost", () => {
    const shapes = buildCorpus({ targetDir: TARGET });
    const spaceArm = shapes.filter((s: Shape) => s.arm === " ");
    expect(spaceArm.length).toBeGreaterThan(0);
    for (const { cmd } of spaceArm) {
      expect(cmd).toMatch(/^A=\S.* cd /);
    }
    expect(spaceArm.map((s: Shape) => s.cmd)).toContain(`A=x cd ${TARGET} && probeshim`);
  });

  it("missing-space sabotage breaks ONLY the separator-less arm, exactly like the round-3 corpus", () => {
    const healthy = buildCorpus({ targetDir: TARGET });
    const sabotaged = buildCorpus({ targetDir: TARGET, sabotage: SABOTAGE_MISSING_SPACE });
    expect(sabotaged.length).toBe(healthy.length);
    const sabSpace = sabotaged.filter((s: Shape) => s.arm === " ").map((s: Shape) => s.cmd);
    expect(sabSpace).toContain(`A=xcd ${TARGET} && probeshim`);
    for (const cmd of sabSpace) {
      expect(cmd).not.toMatch(/^A=\S+ cd /);
    }
    const otherArms = (shapes: Shape[]) => shapes.filter((s) => s.arm !== " ");
    expect(otherArms(sabotaged)).toEqual(otherArms(healthy));
  });
});

describe("auditCorpus counting", () => {
  it("counts a loss against EVERY baseline independently, not once through an else-if chain", () => {
    const result = audit({
      shapes: [{ arm: ";", cmd: "c1" }],
      runReal: () => TARGET,
      candidateParse: () => null,
      baselines: [
        { name: "master", parse: () => TARGET },
        { name: "shipped", parse: () => TARGET },
      ],
    });
    const totals = Object.fromEntries(result.perBaselineTotals.map((t: any) => [t.name, t]));
    expect(totals.master.lost).toBe(1);
    expect(totals.shipped.lost).toBe(1);
  });

  it("never counts a non-null-but-wrong baseline target as a hit, so it cannot satisfy the gate", () => {
    const result = audit({
      shapes: [{ arm: ";", cmd: "c1" }],
      runReal: () => TARGET,
      candidateParse: () => TARGET,
      baselines: [{ name: "master", parse: () => "/somewhere/else" }],
    });
    const arm = must(result.arms.get(";"), "arm ;");
    const bs = must(arm.perBaseline.get("master"), "baseline master");
    expect(bs.hits).toBe(0);
    expect(bs.wrong).toBe(1);
    expect(result.gateReason(arm, bs)).toBe("BASELINE NEVER HIT");
  });

  it("classes a candidate's non-null-but-wrong target as degraded-to-wrong, never as a hit and never as lost", () => {
    const result = audit({
      shapes: [{ arm: ";", cmd: "c1" }],
      runReal: () => TARGET,
      candidateParse: () => "/somewhere/else",
      baselines: [{ name: "master", parse: () => TARGET }],
    });
    const arm = must(result.arms.get(";"), "arm ;");
    const bs = must(arm.perBaseline.get("master"), "baseline master");
    expect(arm.candidateHits).toBe(0);
    expect(arm.candidateWrong).toEqual(["c1"]);
    expect(bs.lost).toEqual([]);
    expect(bs.degradedToWrong).toEqual(["c1"]);
    expect(result.candidateTotals.wrong).toBe(1);
  });

  it("counts phantoms (candidate target bash never entered) and phantom fixes per baseline", () => {
    const result = audit({
      shapes: [
        { arm: "|", cmd: "phantom" },
        { arm: "|", cmd: "fixed" },
      ],
      runReal: () => "/stayed/home",
      candidateParse: (cmd) => (cmd === "phantom" ? TARGET : null),
      baselines: [{ name: "master", parse: () => TARGET }],
    });
    const arm = must(result.arms.get("|"), "arm |");
    expect(arm.phantoms).toEqual(["phantom"]);
    expect(must(arm.perBaseline.get("master"), "baseline master").phantomFixed).toBe(1);
    expect(result.candidateTotals.phantoms).toBe(1);
  });
});

describe("the per-arm gate", () => {
  it("flags an arm whose shapes never ran, never entered, or whose baseline never hit", () => {
    const result = audit({
      shapes: [
        { arm: "never-ran", cmd: "r" },
        { arm: "never-entered", cmd: "e" },
        { arm: "baseline-blind", cmd: "b" },
      ],
      runReal: (cmd) => (cmd === "r" ? null : cmd === "e" ? "/stayed/home" : TARGET),
      candidateParse: () => null,
      baselines: [{ name: "master", parse: () => null }],
    });
    const reason = (armName: string) => {
      const arm = must(result.arms.get(armName), `arm ${armName}`);
      return result.gateReason(arm, must(arm.perBaseline.get("master"), "baseline master"));
    };
    expect(reason("never-ran")).toBe("NO SHAPE RAN");
    expect(reason("never-entered")).toBe("NO ENTERED SHAPES");
    expect(reason("baseline-blind")).toBe("BASELINE NEVER HIT");
  });

  it("gates per baseline: the same arm can be measured against one baseline and blind against another", () => {
    const result = audit({
      shapes: [{ arm: ";", cmd: "c1" }],
      runReal: () => TARGET,
      candidateParse: () => TARGET,
      baselines: [
        { name: "seeing", parse: () => TARGET },
        { name: "blind", parse: () => null },
      ],
    });
    const totals = Object.fromEntries(result.perBaselineTotals.map((t: any) => [t.name, t]));
    expect(totals.seeing.measuredArms).toBe(1);
    expect(totals.seeing.meaningfulZero).toBe(true);
    expect(totals.blind.measuredArms).toBe(0);
    expect(totals.blind.unmeasuredArms).toEqual([{ arm: ";", reason: "BASELINE NEVER HIT" }]);
    expect(totals.blind.meaningfulZero).toBe(false);
  });

  it("refuses to present a zero that contains evidence-free arms as a global zero", () => {
    const result = audit({
      shapes: [
        { arm: "measured", cmd: "m" },
        { arm: "blind", cmd: "b" },
      ],
      runReal: () => TARGET,
      candidateParse: (cmd) => (cmd === "m" ? TARGET : null),
      baselines: [{ name: "master", parse: (cmd) => (cmd === "m" ? TARGET : null) }],
    });
    const totals = must(result.perBaselineTotals[0], "totals");
    expect(totals.lost).toBe(0);
    expect(totals.meaningfulZero).toBe(false);
    const report = renderReport(result);
    expect(report).toContain("NOT a global zero");
    expect(report).toContain('"blind" — BASELINE NEVER HIT');
  });

  it("qualifies the candidate-side totals when arms were never observed at all", () => {
    const result = audit({
      shapes: [
        { arm: "observed", cmd: "o" },
        { arm: "dead", cmd: "d" },
      ],
      runReal: (cmd) => (cmd === "o" ? TARGET : null),
      candidateParse: () => TARGET,
      baselines: [{ name: "master", parse: () => TARGET }],
    });
    expect(result.candidateTotals.armsWithoutObservation).toEqual(["dead"]);
    expect(result.candidateTotals.meaningfulZero).toBe(false);
    const report = renderReport(result);
    expect(report).toContain("phantom/wrong zeros do not cover 1 arm(s) whose shapes never ran");
  });

  it("pins the column sets of both rendered tables", () => {
    const result = audit({
      shapes: [{ arm: ";", cmd: "c1" }],
      runReal: () => TARGET,
      candidateParse: () => TARGET,
      baselines: [{ name: "master", parse: () => TARGET }],
    });
    const report = renderReport(result);
    expect(report).toContain(
      "arm       shapes   ran  entered  baseline-hit  LOST  degraded-to-wrong  baseline-wrong  phantom-fixed  gate",
    );
    expect(report).toContain("arm       shapes   ran  entered  cand-hit  phantoms  wrong-target  gate");
  });

  it("rejects duplicate baseline names instead of silently merging their counters", () => {
    expect(() =>
      audit({
        shapes: [{ arm: ";", cmd: "c1" }],
        runReal: () => TARGET,
        candidateParse: () => TARGET,
        baselines: [
          { name: "master", parse: () => TARGET },
          { name: "master", parse: () => null },
        ],
      }),
    ).toThrow(/duplicate baseline name: master/);
  });

  it("lists lost spellings in the rendered report", () => {
    const result = audit({
      shapes: [{ arm: ";", cmd: "A=x; cd /measure/target && probeshim" }],
      runReal: () => TARGET,
      candidateParse: () => null,
      baselines: [{ name: "master", parse: () => TARGET }],
    });
    const report = renderReport(result);
    expect(report).toContain("LOST spellings vs master:");
    expect(report).toContain("A=x; cd /measure/target && probeshim");
  });
});

// --- evaluateSelfTest -------------------------------------------------
// The assertion set is pure and pinned here so a deleted assertion
// cannot vanish silently — the instrument's ability to fail is itself
// under test (the exact failure class task 47297478 exists to prevent).

function selfTestPair(opts: {
  healthyRunReal?: (cmd: string) => string | null;
  sabotagedRunReal?: (cmd: string) => string | null;
  identityParse?: (cmd: string) => string | null;
  blindParse?: ((cmd: string) => string | null) | "omit";
} = {}) {
  const identityParse = opts.identityParse ?? (() => TARGET);
  const healthyBaselines: Array<{ name: string; parse: (cmd: string) => string | null }> = [
    { name: SELF_TEST_IDENTITY_BASELINE, parse: identityParse },
  ];
  if (opts.blindParse !== "omit") {
    healthyBaselines.push({ name: SELF_TEST_BLIND_BASELINE, parse: opts.blindParse ?? (() => null) });
  }
  const healthy = audit({
    shapes: [
      { arm: " ", cmd: "space" },
      { arm: ">o ", cmd: "redirect" },
    ],
    runReal: opts.healthyRunReal ?? (() => TARGET),
    candidateParse: identityParse,
    baselines: healthyBaselines,
  });
  const sabotaged = audit({
    shapes: [{ arm: " ", cmd: "sab-space" }],
    runReal: opts.sabotagedRunReal ?? (() => null),
    candidateParse: identityParse,
    baselines: [{ name: SELF_TEST_IDENTITY_BASELINE, parse: identityParse }],
  });
  return { healthy, sabotaged };
}

describe("evaluateSelfTest", () => {
  it("passes a well-formed healthy/sabotaged pair with no failures and no warnings", () => {
    const { failures, warnings } = evaluateSelfTest(selfTestPair());
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("fails when the sabotage is inert (the sabotaged arm still enters the target)", () => {
    const { failures } = evaluateSelfTest(selfTestPair({ sabotagedRunReal: () => TARGET }));
    expect(failures.some((f) => f.includes("inert"))).toBe(true);
  });

  it("fails when the gate does not flag the sabotaged arm as evidence-free", () => {
    const pair = selfTestPair();
    const gateless = { ...pair.sabotaged, gateReason: () => null };
    const { failures } = evaluateSelfTest({ healthy: pair.healthy, sabotaged: gateless });
    expect(failures.some((f) => f.includes("NOT flagged as evidence-free"))).toBe(true);
  });

  it("fails when the healthy separator-less arm never enters (broken environment or corpus)", () => {
    const { failures } = evaluateSelfTest(
      selfTestPair({ healthyRunReal: (cmd) => (cmd === "space" ? "/stayed/home" : TARGET) }),
    );
    expect(failures.some((f) => f.includes("environment or corpus broken"))).toBe(true);
  });

  it("fails when no redirect shape ran (the round-3 writable-cwd trap)", () => {
    const { failures } = evaluateSelfTest(
      selfTestPair({ healthyRunReal: (cmd) => (cmd === "redirect" ? null : TARGET) }),
    );
    expect(failures.some((f) => f.includes("round-3 trap"))).toBe(true);
  });

  it("fails when the blind-control baseline is missing", () => {
    const { failures } = evaluateSelfTest(selfTestPair({ blindParse: "omit" }));
    expect(failures.some((f) => f.includes("blind-control baseline is missing"))).toBe(true);
  });

  it("fails when the blind control is not flagged BASELINE NEVER HIT (the round-4 rung)", () => {
    const { failures } = evaluateSelfTest(selfTestPair({ blindParse: () => TARGET }));
    expect(failures.some((f) => f.includes("hits rung"))).toBe(true);
  });

  it("treats a candidate regression on the canonical arm as a warning, never a failure", () => {
    const { failures, warnings } = evaluateSelfTest(selfTestPair({ identityParse: () => null }));
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.includes("no correct target on the healthy separator-less arm"))).toBe(true);
  });
});

describe("parseArgs", () => {
  it("splits name=path baselines and auto-names bare paths", () => {
    const args = parseArgs(["--baseline", "master=/a", "--baseline", "/b"]);
    expect(args.baselines).toEqual([
      { name: "master", path: "/a" },
      { name: "baseline2", path: "/b" },
    ]);
  });

  it("accepts --candidate and --self-test", () => {
    const args = parseArgs(["--self-test", "--candidate", "/c"]);
    expect(args.selfTestOnly).toBe(true);
    expect(args.candidate).toBe("/c");
  });

  it("rejects duplicate baseline names", () => {
    expect(() => parseArgs(["--baseline", "m=/a", "--baseline", "m=/b"])).toThrow(/duplicate baseline name: m/);
  });

  it("rejects a flag without a value", () => {
    expect(() => parseArgs(["--candidate"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--baseline", "--self-test"])).toThrow(/needs a value/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

// --- CLI self-test e2e ------------------------------------------------
// Spawns the tool via `node` (INFRA-allowlisted); real bash runs as a
// grandchild, outside the hermetic guard's scope by its documented
// design. Skipped when bash or the built candidate module is absent
// (CI builds before testing; locally run `npm run build` first).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "measure-bash-prefix-parse.mjs");
const builtCandidate = join(repoRoot, "dist", "runtime", "bash-prefix-parse.js");
// Same resolution the tool itself uses, so the skip condition cannot
// diverge from what the tool will actually find.
const bashOnPath = resolveBash() !== null;

describe.skipIf(!bashOnPath || !existsSync(builtCandidate))("CLI self-test (real bash)", () => {
  it("--self-test passes against the current build", () => {
    const out = execFileSync(process.execPath, [script, "--self-test", "--candidate", builtCandidate], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 120_000,
    });
    expect(out).toContain("self-test ok");
  }, 150_000);

  it("a measurement run refuses to start with fewer than two baselines", () => {
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [script, "--candidate", builtCandidate, "--baseline", `master=${builtCandidate}`],
        { encoding: "utf8", cwd: repoRoot, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error: any) {
      failed = true;
      expect(String(error.stderr)).toContain("at least two --baseline");
    }
    expect(failed).toBe(true);
  }, 150_000);
});
