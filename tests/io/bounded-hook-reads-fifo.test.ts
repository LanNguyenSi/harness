// A by-path read on a hook path must never block on a FIFO, a device or an
// oversized file past the hook's budget, which the runtime treats as an
// allow (task 323bd5b9, the class #639 closed for the gate markers).
//
// Every case runs the BUILT reader in a child process under a SIGKILL
// timeout, so a regression to a blocking read shows up as a killed child
// ("timedOut"), not as a hung test worker. Each FIFO case has a control case
// against a regular file through the same child, so a case cannot pass
// because the module path or export name was wrong.
//
// Needs dist/ (`npm run build` before `vitest`), like the other subprocess
// tests.

import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(REPO_ROOT, "dist");
const BOUND_MS = 10_000;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-hook-reads-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ChildRun {
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  /** The JSON the child printed, or undefined when it printed none. */
  value: unknown;
}

function runChild(script: string, args: string[]): ChildRun {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
    encoding: "utf8",
    timeout: BOUND_MS,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout ?? "";
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    value = undefined;
  }
  return {
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    ms: Date.now() - started,
    stdout,
    stderr: result.stderr ?? "",
    value,
  };
}

// Calls `<module>.<fn>(...JSON args)` in a child and prints
// `{ ok: <result> }` or `{ threw: { name, code } }`.
const CALL_SCRIPT = `
const [, modPath, fn, rawArgs] = process.argv;
const mod = await import(modPath);
const args = JSON.parse(rawArgs);
try {
  const out = await mod[fn](...args);
  process.stdout.write(JSON.stringify({ ok: out === undefined ? null : out }));
} catch (err) {
  process.stdout.write(JSON.stringify({ threw: { name: err && err.name, code: err && err.code } }));
}
`;

function callInChild(modRel: string, fn: string, args: unknown[]): ChildRun {
  return runChild(CALL_SCRIPT, [pathToFileURL(path.join(DIST, modRel)).href, fn, JSON.stringify(args)]);
}

function expectBounded(run: ChildRun): void {
  expect(run.timedOut).toBe(false);
  expect(run.ms).toBeLessThan(BOUND_MS);
}

function mkfifo(p: string): void {
  execFileSync("mkfifo", [p]);
}

describe.skipIf(process.platform === "win32")("manifest loader: a FIFO at a manifest path fails the load within the bound", () => {
  it("control: a regular manifest loads", () => {
    const cfg = path.join(tmp, "harness.yaml");
    fs.writeFileSync(cfg, "version: 1\n");
    const run = callInChild("cli/loader.js", "loadMergedRaw", [{ configPath: cfg, homeDir: path.join(tmp, "home") }]);
    expectBounded(run);
    expect((run.value as { ok: { mergedRaw: unknown } }).ok.mergedRaw).toEqual({ version: 1 });
  });

  it("a FIFO at the base manifest path throws an exit error within the bound", () => {
    const cfg = path.join(tmp, "harness.yaml");
    mkfifo(cfg);
    const run = callInChild("cli/loader.js", "loadMergedRaw", [{ configPath: cfg, homeDir: path.join(tmp, "home") }]);
    expectBounded(run);
    expect((run.value as { threw: { name: string } }).threw.name).toBe("HarnessExitError");
  });

  it("a FIFO at a machine override layer throws within the bound", () => {
    const cfg = path.join(tmp, "harness.yaml");
    fs.writeFileSync(cfg, "version: 1\n");
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, "machines"), { recursive: true });
    // `default` is always among the candidate layer names.
    const candidates = callInChild("overrides/machines.js", "machineOverrideCandidates", [
      callInChild("overrides/machines.js", "resolveMachineDiscriminators", [{}]).value
        ? (callInChild("overrides/machines.js", "resolveMachineDiscriminators", [{}]).value as { ok: unknown }).ok
        : {},
    ]);
    const names = (candidates.value as { ok: string[] }).ok;
    expect(names.length).toBeGreaterThan(0);
    mkfifo(path.join(home, "machines", `${names[0]}.harness.overrides.yaml`));
    const run = callInChild("cli/loader.js", "loadMergedRaw", [{ configPath: cfg, homeDir: home }]);
    expectBounded(run);
    expect((run.value as { threw: { name: string } }).threw.name).toBe("HarnessExitError");
  });
});
