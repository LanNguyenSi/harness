// Phase 7 follow-up: claude -p driver for `harness smoke`.
//
// Spawns `claude -p` with the canonical headless-dogfood flags, tees
// stdout to <output-dir>/stream.jsonl and stderr to
// <output-dir>/stderr.log so forensic files exist even when the run
// crashes or hits the timeout. Returns the captured streams + the
// claude exit code so the caller can run assertions.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunClaudeOptions {
  /** Absolute path (or PATH-lookup name) of the claude binary. */
  claudeBin: string;
  /** Prompt fed to `claude -p`. */
  prompt: string;
  /** Settings.json the spawned claude uses (the apply'd manifest output). */
  settingsPath: string;
  /** Session id. */
  sessionId: string;
  /** Working dir for the spawn. Defaults to `cwd` of the parent. */
  cwd?: string;
  /** Forensic capture target. */
  outputDir: string;
  /** Hard wall-clock budget. Hitting it kills claude and resolves the run. */
  timeoutMs: number;
  /**
   * Extra env merged onto process.env. `HARNESS_POLICY_VERBOSE=1` is
   * baked in BEFORE this map, so an operator who explicitly passes
   * `HARNESS_POLICY_VERBOSE=0` in `env` wins. (The verb sets the verbose
   * default because `--expect-decision warn` reads the stderr diagnostic.)
   */
  env?: Record<string, string>;
  /**
   * Test-injectable spawn. Defaults to node:child_process.spawn. The
   * fixture sees the same argv harness would pass to claude in prod.
   */
  spawn?: (
    command: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}

export interface RunClaudeResult {
  /** Numeric exit code of the spawned claude process, or null on signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True if the run was killed by the wall-clock timeout. */
  timedOut: boolean;
  /** Forensic file paths. */
  streamPath: string;
  stderrPath: string;
  /** Captured streams (also persisted to disk; in-memory copy for callers). */
  streamText: string;
  stderrText: string;
  /** argv handed to claude, for debugging + dogfood README capture. */
  argv: string[];
  /** Total wall-clock spent in the spawn. */
  durationMs: number;
}

const CLAUDE_FLAGS = [
  "--output-format",
  "stream-json",
  "--include-hook-events",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
];

export function buildClaudeArgv(opts: {
  prompt: string;
  settingsPath: string;
  sessionId: string;
}): string[] {
  return [
    "-p",
    opts.prompt,
    "--session-id",
    opts.sessionId,
    "--settings",
    opts.settingsPath,
    ...CLAUDE_FLAGS,
  ];
}

export async function runClaude(
  opts: RunClaudeOptions,
): Promise<RunClaudeResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const streamPath = path.join(opts.outputDir, "stream.jsonl");
  const stderrPath = path.join(opts.outputDir, "stderr.log");
  const streamWriter = fs.createWriteStream(streamPath);
  const stderrWriter = fs.createWriteStream(stderrPath);

  const argv = buildClaudeArgv(opts);
  const spawnFn = opts.spawn ?? spawn;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The Phase 5 #3 verbose diagnostic block is how `--expect-decision warn`
    // becomes observable from the stream's hook_response.stderr field.
    HARNESS_POLICY_VERBOSE: "1",
    ...(opts.env ?? {}),
  };

  const child = spawnFn(opts.claudeBin, argv, {
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    env,
  });

  let streamText = "";
  let stderrText = "";
  let timedOut = false;
  const start = Date.now();

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    streamText += text;
    streamWriter.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrText += text;
    stderrWriter.write(chunk);
  });

  // Both timers are captured in scope so the close-listener can clear
  // them when claude exits before the budget. Without that, every fast
  // smoke run leaked an `unref`'d setTimeout pair that fires on a dead
  // PID minutes later, a non-issue at process exit but visible noise in
  // a long-lived parent (e.g. vitest batches).
  let outerTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  const clearTimers = (): void => {
    if (outerTimer) {
      clearTimeout(outerTimer);
      outerTimer = null;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        clearTimers();
        resolve({ code, signal });
      });
      child.once("error", () => {
        clearTimers();
        resolve({ code: null, signal: null });
      });
    },
  );

  const timeoutPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      outerTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        // SIGKILL escalation after a short grace period so a wedged
        // claude does not hang the runner past `timeoutMs + epsilon`.
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 2000);
        killTimer.unref();
        // Hand the resolved value over to the race; the close listener
        // will land its own value first when the child exits cleanly.
        exitPromise.then(resolve);
      }, opts.timeoutMs);
      outerTimer.unref();
    },
  );

  const { code, signal } = await Promise.race([exitPromise, timeoutPromise]);
  clearTimers();

  // Flush writers before returning so a caller that re-reads the files
  // sees the same bytes the in-memory text holds.
  await new Promise<void>((resolve) => streamWriter.end(resolve));
  await new Promise<void>((resolve) => stderrWriter.end(resolve));

  return {
    exitCode: code,
    signal,
    timedOut,
    streamPath,
    stderrPath,
    streamText,
    stderrText,
    argv,
    durationMs: Date.now() - start,
  };
}
