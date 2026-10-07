// harness b56d95d3: `harness approve understanding` with something at the
// active-claim path that cannot be read as a claim (a FIFO, a directory).
// The approval still writes the session marker, but bound to no task, so the
// result carries `activeClaimRefused` and the CLI prints a `claim:` warning
// telling the operator to repair the entry. Both are pinned here: the result
// field in-process, the printed lines through the built CLI.
//
// Needs dist/ (`npm run build` before `vitest`).

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { activeClaimPathFor } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest } from "../../src/schema/index.js";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/cli/main.js");
const SESSION = "sess-claim-refused-cli";
const BOUND_MS = 30_000;

let root: string;
let config: string;
let reports: string;
let generatedDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-approve-claim-refused-"));
  config = path.join(root, "harness.yaml");
  reports = path.join(root, ".understanding-gate", "reports");
  // `--config <root>/harness.yaml` resolves the generated dir next to it.
  generatedDir = path.join(root, "harness.generated");
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(config, "version: 1\n");
  fs.writeFileSync(
    path.join(reports, "report.json"),
    JSON.stringify({ sessionId: SESSION, mode: "fast_confirm", approvalStatus: "pending", createdAt: new Date().toISOString() }),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PLANTS: Array<[string, (claimPath: string) => void]> = [
  ["a FIFO", (claimPath) => execFileSync("mkfifo", [claimPath])],
  ["a directory", (claimPath) => fs.mkdirSync(claimPath)],
];

function runApprove(): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_HOME: path.join(root, "home"),
    UNDERSTANDING_GATE_REPORT_DIR: reports,
  };
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID"]) delete env[key];
  const child = spawnSync(process.execPath, [MAIN, "approve", "understanding", "--config", config, "--session", SESSION], {
    env,
    input: "",
    encoding: "utf8",
    timeout: BOUND_MS,
    killSignal: "SIGKILL",
  });
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    timedOut: (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

describe.skipIf(process.platform === "win32")("approve understanding: a refused active-claim path", () => {
  it.each(PLANTS)("with %s at the claim path, the result carries activeClaimRefused and no task marker", async (_name, plant) => {
    plant(activeClaimPathFor(generatedDir));
    const result = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir: reports,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect(typeof result.activeClaimRefused).toBe("string");
    expect(result.activeClaimRefused).not.toBe("");
    expect(result.taskMarkers).toEqual([]);
  });

  it("control: with no claim file, activeClaimRefused is absent", async () => {
    const result = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir: reports,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect(result.activeClaimRefused).toBeUndefined();
  });

  it.each(PLANTS)("the built CLI prints the claim: warning lines with %s at the claim path", (_name, plant) => {
    plant(activeClaimPathFor(generatedDir));
    const run = runApprove();
    expect(run.timedOut).toBe(false);
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n");
    const claimAt = lines.findIndex((line) => line.startsWith("claim:   ⚠ "));
    expect(claimAt, run.stdout).toBeGreaterThanOrEqual(0);
    expect(lines[claimAt]!.length).toBeGreaterThan("claim:   ⚠ ".length);
    expect(lines[claimAt + 1]).toBe(
      "  the session marker is bound to no task and will not satisfy the task-bound gate; repair or remove",
    );
    expect(lines[claimAt + 2]).toBe("  the active-claim entry, then approve again.");
    expect(run.stdout).toMatch(/^marker: {2}✓ /m);
  });

  it("control: the built CLI prints no claim: line when there is no claim file", () => {
    const run = runApprove();
    expect(run.timedOut).toBe(false);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^marker: {2}✓ /m);
    expect(run.stdout).not.toMatch(/^claim:/m);
  });
});
