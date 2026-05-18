// harness pause/resume sentinel — temporary hook bypass for operator-only
// recovery, debug, and incident-mode flows.
//
// The whole feature is one JSON file at `<generatedDir>/.harness-paused`.
// While it exists and has not expired, every PreToolUse / PostToolUse hook
// emits a one-line stderr notice and short-circuits to allow instead of
// evaluating its normal gate logic. On the first hook fire AFTER expiry,
// the sentinel is silently deleted (auto-resume) and evaluation resumes.
//
// Source-of-truth split:
//   - Hook enforcement reads the sentinel file. Stat() on a known path —
//     no per-call grounding-mcp roundtrip.
//   - Audit trail goes to the evidence ledger via `harness pause` and
//     `harness resume`. The ledger is queryable history; the sentinel is
//     ephemeral state.
//
// Operator-only design: the `harness pause` verb refuses to run inside an
// agent shell (where `$CLAUDE_SESSION_ID` is set) and refuses non-TTY
// stdin without an explicit `--i-am-the-operator` acknowledgement. This
// is the load-bearing guardrail against pause becoming an agent bypass.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../io/atomic-write.js";

export const SENTINEL_BASENAME = ".harness-paused";

export interface PauseSentinel {
  /** ISO-8601 of when `harness pause` ran. */
  pausedAt: string;
  /** ISO-8601 expiry, or null for `--indefinite`. */
  expiresAt: string | null;
  /** Operator-supplied reason, or null when none was passed. */
  reason: string | null;
  /** Caller identity recorded by the CLI (host/user). */
  pausedBy: string | null;
}

export function sentinelPath(generatedDir: string): string {
  return path.join(generatedDir, SENTINEL_BASENAME);
}

export type ReadSentinelResult =
  | { kind: "absent" }
  | { kind: "active"; sentinel: PauseSentinel }
  | { kind: "expired"; sentinel: PauseSentinel };

export function readSentinel(generatedDir: string, now: Date = new Date()): ReadSentinelResult {
  let raw: string;
  try {
    raw = fs.readFileSync(sentinelPath(generatedDir), "utf8");
  } catch {
    return { kind: "absent" };
  }
  let sentinel: PauseSentinel;
  try {
    sentinel = normalizeSentinel(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    // A malformed sentinel file is treated as absent: a broken state file
    // must never escalate into a session-wide block. The `harness pause`
    // verb only ever writes well-formed JSON, so this branch is reserved
    // for operator-corrupted files.
    return { kind: "absent" };
  }
  if (sentinel.expiresAt === null) return { kind: "active", sentinel };
  const expires = Date.parse(sentinel.expiresAt);
  if (!Number.isFinite(expires)) return { kind: "active", sentinel };
  if (expires <= now.getTime()) return { kind: "expired", sentinel };
  return { kind: "active", sentinel };
}

function normalizeSentinel(raw: Record<string, unknown>): PauseSentinel {
  const pausedAt = typeof raw["pausedAt"] === "string" ? raw["pausedAt"] : "";
  if (pausedAt === "") throw new Error("missing pausedAt");
  const expiresAtRaw = raw["expiresAt"];
  const expiresAt =
    typeof expiresAtRaw === "string" && expiresAtRaw.length > 0 ? expiresAtRaw : null;
  const reason = typeof raw["reason"] === "string" ? raw["reason"] : null;
  const pausedBy = typeof raw["pausedBy"] === "string" ? raw["pausedBy"] : null;
  return { pausedAt, expiresAt, reason, pausedBy };
}

export function writeSentinel(generatedDir: string, sentinel: PauseSentinel): void {
  atomicWriteFile(sentinelPath(generatedDir), `${JSON.stringify(sentinel, null, 2)}\n`);
}

/** Returns true when a sentinel existed and was removed. */
export function deleteSentinel(generatedDir: string): boolean {
  try {
    fs.rmSync(sentinelPath(generatedDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a short human-readable relative offset between `from` (the past
 * anchor for "since X ago") or `to` (the future anchor for "in X") and
 * `now`. Always rounds toward 1 so a near-boundary value never reads "0s".
 */
export function formatRelative(targetIso: string, now: Date): string {
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return "?";
  const abs = Math.max(1, Math.round(Math.abs(target - now.getTime()) / 1000));
  if (abs < 90) return `${abs}s`;
  const mins = Math.round(abs / 60);
  if (mins < 90) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return `${days}d`;
}

export interface AnnouncePauseOptions {
  /** Already-resolved generatedDir. Required: hooks resolve this themselves. */
  generatedDir: string;
  /** Override "now" for tests. */
  now?: Date;
  /** Where to write the notice line. Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /**
   * Hook label inserted into the notice line so an operator scanning a
   * busy stderr can tell which hook fire emitted it. Defaults to a
   * generic "hook" tag.
   */
  hookLabel?: string;
}

/**
 * Hook integration helper. One call from each PreToolUse / PostToolUse
 * hook covers:
 *   - active sentinel  → emit one stderr line; caller exits 0 (allow).
 *   - expired sentinel → silently delete (auto-resume); caller proceeds.
 *   - absent sentinel  → no-op; caller proceeds.
 *
 * The boolean `paused` return tells the caller whether to short-circuit.
 * Any I/O error in the sentinel read degrades to `paused: false` rather
 * than blocking: a broken state file is a debug nuisance, not a reason
 * to silently freeze the whole session.
 */
export function maybeAnnouncePause(opts: AnnouncePauseOptions): { paused: boolean } {
  const now = opts.now ?? new Date();
  const stderr = opts.stderr ?? process.stderr;
  const hookLabel = opts.hookLabel ?? "hook";
  const result = readSentinel(opts.generatedDir, now);
  if (result.kind === "absent") return { paused: false };
  if (result.kind === "expired") {
    deleteSentinel(opts.generatedDir);
    return { paused: false };
  }
  const reason = result.sentinel.reason ?? "(no reason given)";
  const since = formatRelative(result.sentinel.pausedAt, now);
  const remaining =
    result.sentinel.expiresAt === null
      ? "indefinite (no auto-resume)"
      : `auto-resumes in ${formatRelative(result.sentinel.expiresAt, now)}`;
  stderr.write(
    `harness ${hookLabel}: PAUSED since ${since} ago (reason: ${reason}); ${remaining}. Run \`harness resume\` to re-enable.\n`,
  );
  return { paused: true };
}
