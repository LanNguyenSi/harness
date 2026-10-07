// Tests for the understanding-gate reports-directory size warning (task
// 6e001bfc): doctor warns at 75 % of a bound the PreToolUse gate reads, louder
// once the directory is past it, stays silent below, and never walks an
// unbounded directory to count it. The bounds are written out here (8192
// entries, 16384 of any name), not read from the constants, so changing the
// gate's bound fails a test instead of silently moving the thresholds.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { buildUgReportsDir } from "../../src/cli/doctor/ug-reports-dir.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

const BOUND = 8192;
const SCAN_BOUND = 16384;
const WARN_AT = 6144; // 75 % of 8192
const SCAN_WARN_AT = 12288; // 75 % of 16384
const PLANT_TIMEOUT_MS = 60_000;

let cleanups: Array<() => void> = [];
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env["UNDERSTANDING_GATE_REPORT_DIR"];
  delete process.env["UNDERSTANDING_GATE_REPORT_DIR"];
});
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  if (savedEnv === undefined) delete process.env["UNDERSTANDING_GATE_REPORT_DIR"];
  else process.env["UNDERSTANDING_GATE_REPORT_DIR"] = savedEnv;
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-reports-dir-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Plant `count` empty files named `<prefix>-<i><suffix>` under `dir`. */
function plant(dir: string, count: number, suffix: string, prefix = "r"): void {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `${prefix}-${i}${suffix}`), "");
}

describe("buildUgReportsDir: thresholds around 75 % of the entry bound", () => {
  it("a missing directory is not present and stays ok", () => {
    const result = buildUgReportsDir(path.join(tempDir(), "nope"));
    expect(result.present).toBe(false);
    expect(result.state).toBe("ok");
    expect(result.jsonEntries).toBe(0);
  });

  it("an empty directory is present and ok", () => {
    const dir = tempDir();
    const result = buildUgReportsDir(dir);
    expect(result).toMatchObject({ present: true, jsonEntries: 0, state: "ok", bound: BOUND, scanBound: SCAN_BOUND, warnAt: WARN_AT, scanWarnAt: SCAN_WARN_AT });
  });

  it("threshold - 1 *.json entries: ok", () => {
    const dir = tempDir();
    plant(dir, WARN_AT - 1, ".json");
    const result = buildUgReportsDir(dir);
    expect(result.jsonEntries).toBe(WARN_AT - 1);
    expect(result.state).toBe("ok");
  }, PLANT_TIMEOUT_MS);

  it("exactly the threshold: near", () => {
    const dir = tempDir();
    plant(dir, WARN_AT, ".json");
    expect(buildUgReportsDir(dir).state).toBe("near");
  }, PLANT_TIMEOUT_MS);

  it("exactly the bound the gate still reads: near, not over", () => {
    const dir = tempDir();
    plant(dir, BOUND, ".json");
    const result = buildUgReportsDir(dir);
    expect(result.jsonEntries).toBe(BOUND);
    expect(result.state).toBe("near");
  }, PLANT_TIMEOUT_MS);

  it("bound + 1 *.json entries: over, and the count stops there instead of walking the rest", () => {
    const dir = tempDir();
    plant(dir, BOUND + 50, ".json");
    const result = buildUgReportsDir(dir);
    expect(result.state).toBe("over");
    expect(result.jsonEntries).toBe(BOUND + 1);
    expect(result.scannedEntries).toBe(BOUND + 1);
  }, PLANT_TIMEOUT_MS);

  it("non-.json entries do not count toward the *.json threshold", () => {
    const dir = tempDir();
    plant(dir, WARN_AT, ".txt");
    const result = buildUgReportsDir(dir);
    expect(result.jsonEntries).toBe(0);
    expect(result.state).toBe("ok");
  }, PLANT_TIMEOUT_MS);
});

describe("buildUgReportsDir: the any-name scan bound", () => {
  it("any-name threshold - 1: ok", () => {
    const dir = tempDir();
    plant(dir, SCAN_WARN_AT - 1, ".txt");
    expect(buildUgReportsDir(dir).state).toBe("ok");
  }, PLANT_TIMEOUT_MS);

  it("any-name threshold: near", () => {
    const dir = tempDir();
    plant(dir, SCAN_WARN_AT, ".txt");
    const result = buildUgReportsDir(dir);
    expect(result.scannedEntries).toBe(SCAN_WARN_AT);
    expect(result.state).toBe("near");
  }, PLANT_TIMEOUT_MS);

  it("any-name bound + 1: over, and the walk stops there", () => {
    const dir = tempDir();
    plant(dir, SCAN_BOUND + 30, ".txt");
    const result = buildUgReportsDir(dir);
    expect(result.state).toBe("over");
    expect(result.scannedEntries).toBe(SCAN_BOUND + 1);
  }, PLANT_TIMEOUT_MS);
});

const SILENCE_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

const MANIFEST_WITH_PACK = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
`;

const MANIFEST_WITHOUT_PACK = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
`;

function fixture(manifest: string): { home: string; reportsDir: string } {
  const home = tempDir();
  fs.writeFileSync(path.join(home, "harness.yaml"), manifest, "utf8");
  return { home, reportsDir: path.join(home, ".understanding-gate", "reports") };
}

async function run(home: string) {
  return doctor({
    configPath: path.join(home, "harness.yaml"),
    homeOverride: home,
    versionProbe: () => null,
    pathEnv: "",
    npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    envOverride: {},
  });
}

describe("doctor: reports directory size (Environment section)", () => {
  it("below the threshold: silent, no warning of its own", async () => {
    const { home, reportsDir } = fixture(MANIFEST_WITH_PACK);
    const empty = await run(home);
    plant(reportsDir, WARN_AT - 1, ".json");
    const report = await run(home);
    expect(report.ugReportsDir?.state).toBe("ok");
    expect(format(report)).not.toContain("reports directory");
    expect(report.warningCount).toBe(empty.warningCount);
  }, PLANT_TIMEOUT_MS);

  it("at the threshold: warns, naming the directory and the cleanup, rolls one warning and no error", async () => {
    const { home, reportsDir } = fixture(MANIFEST_WITH_PACK);
    const empty = await run(home);
    plant(reportsDir, WARN_AT, ".json");
    const report = await run(home);
    expect(report.ugReportsDir?.state).toBe("near");
    const text = format(report);
    expect(text).toContain(`⚠ understanding-gate reports directory ${reportsDir} holds ${WARN_AT} *.json entries (75% of the ${BOUND} the PreToolUse gate reads)`);
    expect(text).toContain("`harness gc --apply`");
    expect(text).toContain("by hand");
    expect(report.warningCount).toBe(empty.warningCount + 1);
    expect(report.errorCount).toBe(empty.errorCount);
  }, PLANT_TIMEOUT_MS);

  it("past the bound: warns louder (denials are happening), still one warning and no error", async () => {
    const { home, reportsDir } = fixture(MANIFEST_WITH_PACK);
    const empty = await run(home);
    plant(reportsDir, BOUND + 1, ".json");
    const report = await run(home);
    expect(report.ugReportsDir?.state).toBe("over");
    const text = format(report);
    expect(text).toContain(`⚠ understanding-gate reports directory ${reportsDir} is past what the PreToolUse gate reads (over ${BOUND} *.json entries`);
    expect(text).toContain("marker-approved calls are being denied");
    expect(text).toContain("`harness gc --apply`");
    expect(report.warningCount).toBe(empty.warningCount + 1);
    expect(report.errorCount).toBe(empty.errorCount);
  }, PLANT_TIMEOUT_MS);

  it("names the directory UNDERSTANDING_GATE_REPORT_DIR points at, the one the hooks read", async () => {
    const { home } = fixture(MANIFEST_WITH_PACK);
    const elsewhere = path.join(tempDir(), "elsewhere");
    plant(elsewhere, WARN_AT, ".json");
    process.env["UNDERSTANDING_GATE_REPORT_DIR"] = elsewhere;
    const report = await run(home);
    expect(report.ugReportsDir?.dir).toBe(elsewhere);
    expect(format(report)).toContain(`reports directory ${elsewhere} holds ${WARN_AT}`);
  }, PLANT_TIMEOUT_MS);

  it("a directory name carrying control characters cannot forge a doctor line: they are flattened to spaces", async () => {
    const { home } = fixture(MANIFEST_WITH_PACK);
    const hostile = path.join(tempDir(), "rep\nforged ✓ all clear\u001b[31mx\u007fy");
    plant(hostile, WARN_AT, ".json");
    process.env["UNDERSTANDING_GATE_REPORT_DIR"] = hostile;
    const report = await run(home);
    expect(report.ugReportsDir?.state).toBe("near");
    const text = format(report);
    const flattened = hostile.replace(/[\x00-\x1f\x7f]/g, " ");
    expect(text).toContain(`⚠ understanding-gate reports directory ${flattened} holds ${WARN_AT} *.json entries`);
    // The raw newline, escape and DEL never reach the output: the injected text stays on the warning's own line.
    expect(text).not.toContain("rep\nforged");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u007f");
    const warningLine = text.split("\n").find((l) => l.includes("reports directory"));
    expect(warningLine).toContain("forged ✓ all clear");
    expect(text.split("\n").filter((l) => l.trimStart().startsWith("forged")).length).toBe(0);
  }, PLANT_TIMEOUT_MS);

  it("is absent when the understanding pack is not declared, even for a full directory", async () => {
    const { home, reportsDir } = fixture(MANIFEST_WITHOUT_PACK);
    plant(reportsDir, WARN_AT, ".json");
    const report = await run(home);
    expect(report.ugReportsDir).toBeUndefined();
    expect(format(report)).not.toContain("reports directory");
  }, PLANT_TIMEOUT_MS);
});
