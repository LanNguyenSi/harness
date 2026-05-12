// Phase 7 follow-up: `harness smoke`, the built-in headless dogfood verb.
//
// Owns the headless `claude -p` loop that used to live as a hand-rolled
// shell recipe under `dogfood/phase5/run-smoke.sh`. Reuses the apply
// machinery to render a temp settings.json from the manifest, spawns
// claude with the canonical stream-json flags, and runs the operator-
// supplied --expect-* assertions against the captured stream.
//
// Stream + stderr are written to <output-dir>/ on every run, including
// assertion failures and timeouts, so a CI green-or-red signal always
// comes with a forensic trail.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { apply, SETTINGS_BASENAME } from "../apply/index.js";
import { EX_FAIL, EX_UNAVAILABLE, EX_USAGE, HarnessExitError } from "../exit-codes.js";
import {
  evaluateExpectations,
  formatFailures,
  type AssertionFailure,
  type ExpectDecision,
  type SmokeExpectations,
} from "./assertions.js";
import { runClaude, type RunClaudeOptions, type RunClaudeResult } from "./runner.js";
import { parseStreamJsonl, type StreamSummary } from "./stream-parser.js";

export interface SmokeOptions {
  /** harness.yaml path. */
  configPath?: string;
  /** Per-project overrides. */
  project?: string;
  /** Prompt fed to claude -p. */
  prompt: string;
  /** Directory where stream.jsonl + stderr.log + settings.json land. */
  outputDir: string;
  /** Override the spawned session id (default: fresh uuid). */
  sessionId?: string;
  /** Override the claude binary (default: $CLAUDE_BIN, then "claude" on PATH). */
  claudeBin?: string;
  /** Wall-clock budget; default 60 s. */
  timeoutMs?: number;
  /** Expectations. */
  expectations?: SmokeExpectations;
  /** Spawn injection for tests. */
  spawn?: RunClaudeOptions["spawn"];
  /** Test seam for the manifest-apply step. Defaults to the real `apply`. */
  applyImpl?: typeof apply;
  /** Override cwd for the spawned claude. Defaults to `outputDir`. */
  spawnCwd?: string;
  /** Stdout/stderr writers (defaults to process.stdout / stderr). */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface SmokeResult {
  /** EX_OK on green, EX_FAIL on an assertion miss, EX_UNAVAILABLE on missing claude. */
  exitCode: number;
  outputDir: string;
  settingsPath: string;
  streamPath: string;
  stderrPath: string;
  /** Parsed stream summary. */
  summary: StreamSummary;
  /** Spawned claude's exit code (numeric or null). */
  claudeExitCode: number | null;
  claudeTimedOut: boolean;
  /** Wall-clock duration of the spawn. */
  durationMs: number;
  /** Empty when green. */
  failures: AssertionFailure[];
  /** Echoed argv for dogfood README capture. */
  claudeArgv: string[];
}

function resolveClaudeBin(opts: SmokeOptions): string {
  if (opts.claudeBin) return opts.claudeBin;
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  return "claude";
}

function ensureClaudeAvailable(bin: string): void {
  // Inline `which`-style probe. We cannot just trust `spawn()` to error
  // cleanly: ENOENT surfaces async and the operator-facing message in
  // that path is a stack trace from Node, not the EX_UNAVAILABLE this
  // verb is supposed to emit.
  if (path.isAbsolute(bin) || bin.startsWith("./") || bin.startsWith("../")) {
    if (!fs.existsSync(bin)) {
      throw new HarnessExitError(
        `harness smoke: claude binary not found at ${bin}`,
        EX_UNAVAILABLE,
      );
    }
    return;
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathEntries) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return;
  }
  throw new HarnessExitError(
    `harness smoke: ${bin} not found on PATH (set --claude-bin or CLAUDE_BIN env)`,
    EX_UNAVAILABLE,
  );
}

function isExpectDecision(s: string): s is ExpectDecision {
  return s === "allow" || s === "deny" || s === "warn";
}

/**
 * Parse a comma-separated CLI value or a single token into a string list.
 * commander's `--expect-hook <name>` accepts one value per flag, but a
 * single comma-separated string is more ergonomic for the common case.
 */
export function splitCommaList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new HarnessExitError("harness smoke: --prompt is required", EX_USAGE);
  }
  if (!opts.outputDir) {
    throw new HarnessExitError(
      "harness smoke: --output-dir is required",
      EX_USAGE,
    );
  }

  if (opts.expectations?.expectDecision !== undefined) {
    if (!isExpectDecision(opts.expectations.expectDecision)) {
      throw new HarnessExitError(
        `harness smoke: --expect-decision must be one of allow|deny|warn`,
        EX_USAGE,
      );
    }
  }

  const claudeBin = resolveClaudeBin(opts);
  ensureClaudeAvailable(claudeBin);

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const settingsPath = path.join(opts.outputDir, SETTINGS_BASENAME);

  const applyImpl = opts.applyImpl ?? apply;
  const applyOpts: Parameters<typeof apply>[0] = {
    target: settingsPath,
    force: true,
  };
  if (opts.configPath) applyOpts.configPath = opts.configPath;
  if (opts.project) applyOpts.project = opts.project;
  await applyImpl(applyOpts);

  const sessionId = opts.sessionId ?? randomUUID();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const runOpts: RunClaudeOptions = {
    claudeBin,
    prompt: opts.prompt,
    settingsPath,
    sessionId,
    outputDir: opts.outputDir,
    timeoutMs,
  };
  if (opts.spawn) runOpts.spawn = opts.spawn;
  if (opts.spawnCwd !== undefined) runOpts.cwd = opts.spawnCwd;

  let runResult: RunClaudeResult;
  try {
    runResult = await runClaude(runOpts);
  } catch (err) {
    throw new HarnessExitError(
      `harness smoke: claude spawn failed: ${(err as Error).message}`,
      EX_UNAVAILABLE,
    );
  }

  const summary = parseStreamJsonl(runResult.streamText);
  const failures = evaluateExpectations(summary, opts.expectations ?? {});

  // Even if the user passed no expectations, surface a timeout or a
  // non-zero claude exit as a failure so green-or-red is unambiguous.
  if (failures.length === 0 && runResult.timedOut) {
    failures.push({
      kind: "expect-exit",
      expected: "claude completes before timeout",
      actual: `claude killed after ${timeoutMs}ms`,
      detail: `harness smoke: claude exceeded the ${timeoutMs}ms budget and was SIGTERM'd. Stream may be truncated.`,
    });
  }

  const exitCode = failures.length === 0 ? 0 : EX_FAIL;
  return {
    exitCode,
    outputDir: opts.outputDir,
    settingsPath,
    streamPath: runResult.streamPath,
    stderrPath: runResult.stderrPath,
    summary,
    claudeExitCode: runResult.exitCode,
    claudeTimedOut: runResult.timedOut,
    durationMs: runResult.durationMs,
    failures,
    claudeArgv: runResult.argv,
  };
}

export function formatSmokeReport(result: SmokeResult): string {
  const lines: string[] = [];
  lines.push(`harness smoke: ${result.failures.length === 0 ? "PASS" : "FAIL"} (${result.durationMs}ms)`);
  lines.push(`  output-dir:   ${result.outputDir}`);
  lines.push(`  stream:       ${result.streamPath}`);
  lines.push(`  stderr:       ${result.stderrPath}`);
  lines.push(`  session_id:   ${result.summary.init?.session_id ?? "(no init event)"}`);
  lines.push(`  hooks fired:  ${result.summary.hooks.length}`);
  lines.push(`  result.is_error: ${result.summary.result?.is_error ?? "(no result event)"}`);
  if (result.claudeTimedOut) {
    lines.push(`  TIMED OUT after ${result.durationMs}ms`);
  }
  if (result.failures.length > 0) {
    lines.push("");
    lines.push(formatFailures(result.failures).trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

export { type SmokeExpectations, type ExpectDecision } from "./assertions.js";
