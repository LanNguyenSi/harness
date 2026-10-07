// Shared child-process runner for the FIFO tests: a regression to a blocking
// by-path open shows up as a SIGKILLed child ("timedOut"), not as a hung test
// worker. The child imports the BUILT module (`npm run build` before
// `vitest`, like the other subprocess tests).

import { spawnSync, execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIST = path.join(REPO_ROOT, "dist");
export const BOUND_MS = 10_000;

export interface ChildRun {
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  /** The JSON the child printed, or undefined when it printed none. */
  value: unknown;
}

export function runChild(script: string, args: string[]): ChildRun {
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

/** Fails the test when the child had to be killed: the call blocked. */
export function expectBounded(run: ChildRun): void {
  expect(run.timedOut, `child was killed after ${BOUND_MS} ms (a blocking open?)\n${run.stderr}`).toBe(false);
  expect(run.ms).toBeLessThan(BOUND_MS);
}

export function distUrl(modRel: string): string {
  return pathToFileURL(path.join(DIST, modRel)).href;
}

export function mkfifo(p: string): void {
  execFileSync("mkfifo", [p]);
}
