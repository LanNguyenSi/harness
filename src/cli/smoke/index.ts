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
import { issueDelegation } from "../delegate/index.js";
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
  /**
   * Override cwd for the spawned claude. Defaults to the parent
   * process's own cwd: when unset, `runOpts.cwd` is left unset below
   * and `runClaude` leaves `cwd` unset on the spawn options too, so
   * Node inherits this process's cwd exactly like an unset `cwd` always
   * does.
   */
  spawnCwd?: string;
  /** Stdout/stderr writers (defaults to process.stdout / stderr). */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /**
   * Skip the slice-3 pre-spawn delegation (ADR
   * docs/decisions/2026-08-27-ug-auto-mode-approval.md, "TTL, cwd, and
   * subagents": the smoke runner is the delegation's first consumer).
   * Default: false (delegate). Set for launchers that want the
   * pre-slice-3 shape, or when the caller issues its own delegation.
   */
  noDelegate?: boolean;
  /** Test seam for the delegation step. Defaults to the real `issueDelegation`. */
  issueDelegationImpl?: typeof issueDelegation;
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
  const applyResult = await applyImpl(applyOpts);
  // `apply` can return a refusal outcome without throwing. Without this
  // guard a stale generated/ dir or an unresolved --target conflict
  // silently lets smoke run claude against the OLD settings, which then
  // looks green for the wrong reason. Fail loud instead.
  const REFUSAL_OUTCOMES = new Set([
    "drift-refuse",
    "lock-drift-refuse",
    "target-exists-refuse",
  ]);
  if (REFUSAL_OUTCOMES.has(applyResult.outcome)) {
    throw new HarnessExitError(
      `harness smoke: apply refused with outcome="${applyResult.outcome}"; resolve drift before re-running`,
      EX_FAIL,
    );
  }

  const sessionId = opts.sessionId ?? randomUUID();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Slice 3 delegation (ADR docs/decisions/2026-08-27-ug-auto-mode-
  // approval.md, "TTL, cwd, and subagents": "The harness smoke runner
  // ... is the natural first consumer"). Issued for the session id
  // this run already chose, bound to the cwd the child actually spawns
  // into (`opts.spawnCwd`, defaulting to this process's own cwd exactly
  // like `runClaude`'s own unset-cwd default does), no task. Parent
  // resolves through `issueDelegation`'s own precedence chain (flag >
  // env > staged `.pending-approval`), this runner never overrides it,
  // so the delegation is always issued on behalf of whatever session
  // actually invoked `harness smoke`.
  //
  // TTL is the run's own wall-clock budget plus one minute of slack
  // (`Math.ceil(timeoutMs / 1000) + 60`), never `issueDelegation`'s own
  // one-hour default: a 60s smoke run has no business minting a
  // pre-authorization that outlives the run by an hour. If that value
  // exceeds the applied pack's own ceiling, `issueDelegationImpl`
  // refuses with `ttl-above-max-age`, which prints exactly like any
  // other refusal below; nothing here special-cases it.
  //
  // Never blocks the run: every refusal (no parent marker, no signing
  // key, an unresolved parent session id, an over-ceiling TTL) AND
  // every thrown error (e.g. `resolvePaths`'s real-home-dir guard when
  // neither `--config` nor a home dir is set outside the real
  // `harness` binary) prints one line and the run proceeds exactly as
  // it did before this delegation step existed, the same shape
  // `--no-delegate` opts back into explicitly.
  const stdoutWrite = opts.stdout ?? ((s: string) => process.stdout.write(s));
  if (!opts.noDelegate) {
    const issueDelegationImpl = opts.issueDelegationImpl ?? issueDelegation;
    const childCwd = opts.spawnCwd ?? process.cwd();
    const delegationOpts: Parameters<typeof issueDelegation>[0] = {
      childSessionId: sessionId,
      cwd: childCwd,
      ttlSeconds: Math.ceil(timeoutMs / 1000) + 60,
    };
    if (opts.configPath) delegationOpts.configPath = opts.configPath;
    if (opts.project) delegationOpts.project = opts.project;
    try {
      const delegationResult = await issueDelegationImpl(delegationOpts);
      if (delegationResult.ok) {
        stdoutWrite(
          `delegation: ✓ ${delegationResult.filePath} (child ${delegationResult.childSessionId}, parent ${delegationResult.parentSessionId}, expires ${delegationResult.expiresAt})\n`,
        );
      } else {
        stdoutWrite(
          `delegation: skipped (${delegationResult.reason}: ${delegationResult.detail})\n`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stdoutWrite(`delegation: skipped (error: ${message})\n`);
    }
  }

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
  // claude crash as a failure so green-or-red is unambiguous.
  if (failures.length === 0 && runResult.timedOut) {
    failures.push({
      kind: "expect-exit",
      expected: "claude completes before timeout",
      actual: `claude killed after ${timeoutMs}ms`,
      detail: `harness smoke: claude exceeded the ${timeoutMs}ms budget and was SIGTERM'd. Stream may be truncated.`,
    });
  }
  // Claude crashed before emitting a terminal result event AND exited
  // non-zero. Without an --expect-exit assertion this would silently
  // pass; treat it as an implicit miss so the operator never sees
  // green on a broken-pipe / ENOENT-after-spawn / abort-during-init.
  if (
    failures.length === 0 &&
    !runResult.timedOut &&
    runResult.exitCode !== null &&
    runResult.exitCode !== 0 &&
    summary.result === null
  ) {
    failures.push({
      kind: "expect-exit",
      expected: "claude emits a terminal result event",
      actual: `claude exited ${runResult.exitCode} without a terminal result event`,
      detail:
        `harness smoke: claude exited ${runResult.exitCode} and the stream carries ` +
        "no terminal `result` event. Treating as implicit failure; check stderr.log for forensics.",
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
