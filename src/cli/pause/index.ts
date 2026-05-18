// `harness pause` / `harness resume` — temporary hook bypass.
//
// Sentinel-based, all-or-nothing, operator-only. Lives next to the
// existing `harness.generated/` artefacts; the per-hook integration is
// in `src/runtime/pause-sentinel.ts`.
//
// The verbs are intentionally not a debugging convenience: they exist
// for three narrow flows and the guardrails (refuse-when-CLAUDE_SESSION_ID,
// refuse-non-TTY, `--indefinite` requires a verbose accept-flag) push
// back against any other use. See the task description on agent-tasks
// `07850f73-511b-44dc-b5aa-f8564fd15fff` for the design rationale and
// the slippery-slope analysis.

import * as os from "node:os";
import { parseDurationSeconds, InvalidDurationError } from "../../policies/index.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import {
  deleteSentinel,
  readSentinel,
  sentinelPath,
  writeSentinel,
  type PauseSentinel,
} from "../../runtime/pause-sentinel.js";
import { addLedgerFact } from "../../runtime/ledger-add.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";
import { expandHome } from "../../runtime/expand-home.js";

const DEFAULT_PAUSE_SECONDS = 15 * 60;

/** Synthetic grounding session bucket for operator-side pause/resume events. */
export const OPERATOR_LEDGER_SESSION = "default";

export interface PauseOptions extends LoaderOptions {
  /** Duration string ("5m", "1h", "PT30S"); ignored when `indefinite=true`. */
  forDuration?: string;
  /**
   * Skip the auto-expiry. The CLI requires `acceptNoAutoResume=true`
   * alongside or it refuses with usage help — the verbose flag itself
   * is the friction against routine indefinite-pausing.
   */
  indefinite?: boolean;
  /** Acknowledges the no-auto-resume contract of `--indefinite`. */
  acceptNoAutoResume?: boolean;
  /** Free-form reason recorded in the sentinel + announced on each hook fire. */
  reason?: string;
  /**
   * Acknowledges the non-TTY stdin escape hatch. Without this, a
   * scripted invocation (no controlling terminal) is refused.
   */
  iAmTheOperator?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /**
   * Override the inherited `$CLAUDE_SESSION_ID` (test injection). When
   * set to a non-empty string, the verb refuses to run.
   */
  claudeSessionIdEnv?: string;
  /** Override stdin TTY detection (test injection). */
  stdinIsTTY?: boolean;
  /** Override the recorded `pausedBy` identity (test injection). */
  pausedBy?: string;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger writer (test). */
  ledgerAdd?: (sessionId: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface PauseResult {
  sentinelPath: string;
  sentinel: PauseSentinel;
  alreadyPaused: boolean;
  ledger: { ok: boolean; tag: string; reason?: string };
}

export interface ResumeOptions extends LoaderOptions {
  /** Override "now" for tests. */
  now?: Date;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Override the inherited `$CLAUDE_SESSION_ID` (test injection). */
  claudeSessionIdEnv?: string;
  /** Override stdin TTY detection (test injection). */
  stdinIsTTY?: boolean;
  /** Acknowledges the non-TTY stdin escape hatch (mirror of pause). */
  iAmTheOperator?: boolean;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger writer (test). */
  ledgerAdd?: (sessionId: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ResumeResult {
  sentinelPath: string;
  wasPaused: boolean;
  /** Last known sentinel state, or null when none existed. */
  previousSentinel: PauseSentinel | null;
  ledger: { ok: boolean; tag: string; reason?: string };
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

async function writeLedgerTag(
  manifest: Manifest | null,
  content: string,
  source: string,
  injected: PauseOptions["ledgerAdd"],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (injected) return injected(OPERATOR_LEDGER_SESSION, content);
  if (!manifest) {
    return { ok: false, reason: "manifest unreadable; skipped ledger write" };
  }
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  const command = Array.isArray(server.command)
    ? server.command.map((p) => expandHome(p))
    : server.command.trim().split(/\s+/).map((p) => expandHome(p));
  return addLedgerFact({
    mcpCommand: command,
    ...(server.env && { mcpEnv: server.env }),
    timeoutMs: server.health?.timeout_ms ?? 5_000,
    sessionId: OPERATOR_LEDGER_SESSION,
    content,
    source,
  });
}

function resolveGeneratedDirForVerb(opts: PauseOptions | ResumeOptions): string {
  if (opts.generatedDir !== undefined) return opts.generatedDir;
  return resolveGeneratedDir({
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    manifestPath: resolvePaths(opts).base,
  });
}

function refuseIfAgentShell(opts: { claudeSessionIdEnv?: string }): void {
  const env =
    opts.claudeSessionIdEnv !== undefined
      ? opts.claudeSessionIdEnv
      : process.env.CLAUDE_SESSION_ID;
  if (typeof env === "string" && env.length > 0) {
    throw new HarnessExitError(
      [
        "harness pause/resume refuses to run inside an agent shell ($CLAUDE_SESSION_ID is set).",
        "",
        "This is the load-bearing guardrail against `harness pause` becoming an",
        "agent-driven bypass of the gates harness exists to enforce. Run the verb",
        "from your own operator shell (in Claude Code: prefix the command with `! `).",
      ].join("\n"),
      EX_USAGE,
    );
  }
}

function refuseIfNonTTY(opts: { stdinIsTTY?: boolean; iAmTheOperator?: boolean }): void {
  const tty = opts.stdinIsTTY !== undefined ? opts.stdinIsTTY : process.stdin.isTTY === true;
  if (tty) return;
  if (opts.iAmTheOperator === true) return;
  throw new HarnessExitError(
    [
      "harness pause/resume refuses to run with non-TTY stdin (looks scripted).",
      "",
      "If you really mean this (e.g. invoking from a one-off recovery script that",
      "you reviewed yourself), pass --i-am-the-operator to acknowledge.",
    ].join("\n"),
    EX_USAGE,
  );
}

function loadManifestBestEffort(opts: PauseOptions | ResumeOptions): Manifest | null {
  if (opts.manifest) return opts.manifest;
  try {
    return loadManifest(opts).manifest;
  } catch {
    return null;
  }
}

function defaultPausedBy(): string {
  const user = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  let host = "unknown";
  try {
    host = os.hostname();
  } catch {
    /* keep "unknown" */
  }
  return `${user}@${host}`;
}

export async function pause(opts: PauseOptions = {}): Promise<PauseResult> {
  refuseIfAgentShell(opts);
  refuseIfNonTTY(opts);

  if (opts.indefinite === true && opts.acceptNoAutoResume !== true) {
    throw new HarnessExitError(
      [
        "--indefinite refuses to run without --i-am-the-operator-and-accept-no-auto-resume.",
        "",
        "The verbose flag is the friction. An indefinite pause leaves harness",
        "dormant until you remember to `harness resume`. Prefer `--for <duration>`",
        "(e.g. --for 1h, --for 30m) — it auto-resumes so a forgotten pause cannot",
        "silently disable your gates across sessions.",
      ].join("\n"),
      EX_USAGE,
    );
  }

  const now = opts.now ?? new Date();
  let expiresAt: string | null;
  if (opts.indefinite === true) {
    expiresAt = null;
  } else {
    let seconds: number;
    if (typeof opts.forDuration === "string" && opts.forDuration.length > 0) {
      try {
        seconds = parseDurationSeconds(opts.forDuration);
      } catch (err) {
        if (err instanceof InvalidDurationError) {
          throw new HarnessExitError(err.message, EX_USAGE);
        }
        throw err;
      }
    } else {
      seconds = DEFAULT_PAUSE_SECONDS;
    }
    if (seconds <= 0) {
      throw new HarnessExitError(
        `--for must be a positive duration (got "${opts.forDuration ?? ""}")`,
        EX_USAGE,
      );
    }
    expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  }

  const generatedDir = resolveGeneratedDirForVerb(opts);
  const file = sentinelPath(generatedDir);

  // Surface an existing pause without overwriting silently. Operators
  // who re-run `harness pause` usually want to extend; we detect it and
  // overwrite, but flag it via `alreadyPaused: true` in the result so the
  // CLI can mention it in the human-readable output.
  const prior = readSentinel(generatedDir, now);
  const alreadyPaused = prior.kind === "active";

  const sentinel: PauseSentinel = {
    pausedAt: now.toISOString(),
    expiresAt,
    reason: typeof opts.reason === "string" && opts.reason.length > 0 ? opts.reason : null,
    pausedBy: opts.pausedBy ?? defaultPausedBy(),
  };
  try {
    writeSentinel(generatedDir, sentinel);
  } catch (err) {
    throw new HarnessExitError(
      `failed to write sentinel at ${file}: ${(err as Error).message}`,
      EX_FAIL,
    );
  }

  const manifest = loadManifestBestEffort(opts);
  const tag = `harness-paused:${sentinel.pausedAt}`;
  const ledgerResult = await writeLedgerTag(
    manifest,
    tag,
    "harness-pause-cli",
    opts.ledgerAdd,
  );

  return {
    sentinelPath: file,
    sentinel,
    alreadyPaused,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
  };
}

export async function resume(opts: ResumeOptions = {}): Promise<ResumeResult> {
  refuseIfAgentShell(opts);
  refuseIfNonTTY(opts);

  const now = opts.now ?? new Date();
  const generatedDir = resolveGeneratedDirForVerb(opts);
  const file = sentinelPath(generatedDir);

  const prior = readSentinel(generatedDir, now);
  const previousSentinel =
    prior.kind === "active" || prior.kind === "expired" ? prior.sentinel : null;

  // Idempotent: missing sentinel is exit-0 with a notice. No-op ledger
  // write either — the audit log only carries actual resume events, not
  // the case where the operator typed `harness resume` against an
  // already-clean install.
  if (prior.kind === "absent") {
    return {
      sentinelPath: file,
      wasPaused: false,
      previousSentinel: null,
      ledger: { ok: false, tag: "", reason: "no active pause; ledger write skipped" },
    };
  }

  deleteSentinel(generatedDir);

  const manifest = loadManifestBestEffort(opts);
  const tag = `harness-resumed:${previousSentinel?.pausedAt ?? now.toISOString()}`;
  const ledgerResult = await writeLedgerTag(
    manifest,
    tag,
    "harness-resume-cli",
    opts.ledgerAdd,
  );

  return {
    sentinelPath: file,
    wasPaused: true,
    previousSentinel,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
  };
}
