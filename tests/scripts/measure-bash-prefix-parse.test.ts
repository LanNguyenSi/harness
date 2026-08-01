import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditCorpus,
  buildCorpus,
  renderReport,
  SABOTAGE_MISSING_SPACE,
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

// --- CLI self-test e2e ------------------------------------------------
// Spawns the tool via `node` (INFRA-allowlisted); real bash runs as a
// grandchild, outside the hermetic guard's scope by its documented
// design. Skipped when bash or the built candidate module is absent
// (CI builds before testing; locally run `npm run build` first).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "measure-bash-prefix-parse.mjs");
const builtCandidate = join(repoRoot, "dist", "runtime", "bash-prefix-parse.js");
const bashOnPath = (process.env.PATH ?? "")
  .split(delimiter)
  .some((dir) => dir.length > 0 && existsSync(join(dir, "bash")));

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
