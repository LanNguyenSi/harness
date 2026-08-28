// `auto_approve` pack-config parsing and shared conventions, split out
// alongside lifecycle.ts (structural sibling of the former monolithic
// understanding-before-execution-runtime.ts, agent-tasks 348a4d42).
// Implements slice 1 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks 74b4b17d): the strict pack-config block that lets an
// operator opt a permission mode into the hook-written signed
// auto-marker path, plus the shared `approvedBy` / ledger-tag
// conventions the hook and doctor consume so there is one authority
// for the string shapes instead of each caller reimplementing them.
//
// This module owns no gate decision and no marker write: it only
// parses the opt-in config (fail-closed: any malformed shape is
// treated as "not opted in", never as a partial default) and builds /
// parses the string conventions the ADR's "Audit and doctor" section
// documents. The PreToolUse hook (auto-path condition checks) and
// `harness doctor` (auto-approval listing) are the consumers; both
// land in later slice-1 tasks and import from here.
//
// Slice 3 (agent-tasks 37ad0b05) adds `report_scan.max_wait`: the bound
// of the child's transcript poll under `claude -p` ("Report capture
// under `-p`" in the ADR). It lives in this block because it tunes the
// same opt-in path, and it is parsed here rather than at the hook so
// the lint-time schema and the runtime hook agree on one parser.

import { InvalidDurationError, parseDurationSeconds } from "../../../policies/index.js";

/**
 * Prefix every auto-minted marker's `approvedBy` carries, distinguishing
 * it from a human `harness approve understanding` marker (which carries
 * the operator's own identity string, never this prefix).
 */
export const AUTO_APPROVED_BY_PREFIX = "auto-mode:";

/** The harness identifier the Claude Code PreToolUse hook mints markers for. */
export const CLAUDE_CODE_HARNESS = "claude-code";

/**
 * The harness identifier the Codex PreToolUse hook mints markers for
 * (slice 2 of the ADR: same auto path, same fail-closed conditions, a
 * distinct `approvedBy` segment so an audit can tell the two runtimes
 * apart). Deliberately NOT re-exported through
 * `understanding-before-execution/index.ts`: its only consumer is
 * `src/cli/pack/hook-codex-pre-tool-use.ts`, and widening the runtime
 * shim's pinned public surface (tests/policy-packs/ube-export-surface.test.ts)
 * is a separate, conscious act.
 */
export const CODEX_HARNESS = "codex";

/**
 * Build the `approvedBy` value the hook writes into a signed auto-marker:
 * `auto-mode:<harness>:<mode>`, for example `auto-mode:claude-code:bypassPermissions`
 * or `auto-mode:codex:bypassPermissions` ("Audit and doctor" in the ADR).
 * Neither `harness` nor `mode` is validated here; callers pass
 * already-known-good values (one of the fixed harness constants above and
 * a `when`-matched mode string).
 */
export function autoApprovedByFor(harness: string, mode: string): string {
  return `${AUTO_APPROVED_BY_PREFIX}${harness}:${mode}`;
}

/** Parsed shape of an `approvedBy` string minted by {@link autoApprovedByFor}. */
export interface ParsedAutoApprovedBy {
  harness: string;
  mode: string;
}

/**
 * Parse an `approvedBy` string back into its harness/mode pair. Returns
 * `null` for anything that is not exactly `auto-mode:<harness>:<mode>`
 * with both segments non-empty, including a human marker's `approvedBy`
 * (which never carries this prefix) and a malformed or truncated auto
 * value. A slice 3 delegation suffix (`;delegated:<parent-sid>`) is
 * tolerated: it is stripped before parsing and otherwise ignored, per
 * the ADR's "Audit and doctor" convention that the delegation binding
 * packs into the same field without changing the harness/mode shape.
 */
export function parseAutoApprovedBy(approvedBy: unknown): ParsedAutoApprovedBy | null {
  if (typeof approvedBy !== "string") return null;
  if (!approvedBy.startsWith(AUTO_APPROVED_BY_PREFIX)) return null;
  const withoutPrefix = approvedBy.slice(AUTO_APPROVED_BY_PREFIX.length);
  const [withoutDelegation] = withoutPrefix.split(";delegated:");
  const segments = (withoutDelegation ?? "").split(":");
  if (segments.length !== 2) return null;
  const [harness, mode] = segments;
  if (!harness || !mode) return null;
  return { harness, mode };
}

/**
 * Build the audit-only ledger fact the ADR's "Audit and doctor" section
 * names: `understanding-auto-approved:<sid>`, distinct from the human
 * `understanding-approved:<sid>` tag (`ledger.ts`), following the same
 * `...:forced:<field>` suffix precedent the ADR cites. Ledger only, never
 * consulted for the gate decision itself.
 */
export function autoApprovedLedgerTagFor(sessionId: string): string {
  return `understanding-auto-approved:${sessionId}`;
}

/**
 * The harness identifiers `auto_approve.harnesses` accepts, in the order
 * the schema and every diagnostic list them. Shared with the pack's zod
 * `configSchema` (`../understanding-before-execution.ts`) so the lint-time
 * enum and this runtime parser cannot drift apart.
 */
export const AUTO_APPROVE_HARNESS_VALUES = [CLAUDE_CODE_HARNESS, CODEX_HARNESS] as const;

/**
 * What `auto_approve.harnesses` resolves to when the key is ABSENT.
 * Claude Code only, deliberately: slice 1 shipped `auto_approve` as a
 * Claude-only opt-in, so a repo that opted in before slice 2 must keep
 * exactly the meaning it had — adding the Codex hook to the shared body
 * must not silently extend an existing opt-in to a second runtime
 * (reviewer round-1 finding on slice 2). Opting Codex in is an explicit,
 * visible config edit.
 */
export const DEFAULT_AUTO_APPROVE_HARNESSES: readonly string[] = [CLAUDE_CODE_HARNESS];

/**
 * What `auto_approve.report_scan.max_wait` resolves to when the key is
 * ABSENT: the bound the child's PreToolUse hook waits for its own
 * Understanding Report to reach the session transcript before it blocks
 * (ADR "Report capture under `-p`", slice 3 acceptance criterion 3).
 *
 * The value is measured, not guessed: under `claude -p` the report is
 * absent from the transcript at the instant PreToolUse fires and lands
 * some time later, on a lag that scales with report length, so the
 * bound is set from the real end-to-end runs (a full-length grill_me
 * report), not only the shorter probe reports that first-guessed 500ms.
 * The measurement and the retuning derivation are both in
 * `docs/okf/understanding-gate-auto-mode-signals.md` ("Chosen
 * `report_scan.max_wait` default" section), from
 * `dogfood/ug-auto-mode-signals/`.
 *
 * ONE named constant on purpose: the hook, the schema default and every
 * test read this symbol, so re-tuning the bound against a new
 * measurement is a one-line change with no literal to hunt down.
 */
export const DEFAULT_REPORT_SCAN_MAX_WAIT_MS = 2_000;

/**
 * Hard ceiling for `auto_approve.report_scan.max_wait`. A larger value
 * is a `harness validate` schema error AND a runtime parse failure (which
 * fails the whole `auto_approve` block closed), so no configuration can
 * make a PreToolUse hook sit on a session for an arbitrary time. 5 s is
 * an order of magnitude above the measured worst-case flush, which is
 * generous for a bound whose only job is to cover a transcript write
 * already in flight.
 */
export const REPORT_SCAN_MAX_WAIT_CEILING_MS = 5_000;

/** Parsed, validated `auto_approve` pack-config block. */
export interface AutoApproveConfig {
  /** Allowlist of `permission_mode` payload literals eligible for auto-approval. */
  when: string[];
  /**
   * Allowlist of HARNESSES whose PreToolUse hook may take the auto path
   * at all. Always non-empty: an absent key resolves to
   * {@link DEFAULT_AUTO_APPROVE_HARNESSES}, and every malformed shape
   * fails the whole block closed rather than defaulting.
   */
  harnesses: string[];
  /**
   * The transcript-poll bound for the slice 3 delegation path. Always
   * present: an absent `report_scan` block resolves to
   * {@link DEFAULT_REPORT_SCAN_MAX_WAIT_MS}, and every malformed shape
   * fails the whole `auto_approve` block closed, like every other key
   * here.
   */
  reportScan: { maxWaitMs: number };
}

const KNOWN_AUTO_APPROVE_KEYS = new Set([
  "when",
  "harnesses",
  "require_report",
  "report_scan",
]);

/** The only key `auto_approve.report_scan` accepts. */
const KNOWN_REPORT_SCAN_KEYS = new Set(["max_wait"]);

/** Sub-second shorthand the shared duration parser does not model. */
const MILLISECOND_SHORTHAND = /^(\d+)ms$/;

export type ReportScanMaxWaitParse =
  | { ok: true; maxWaitMs: number }
  | { ok: false; reason: string };

/**
 * Parse `auto_approve.report_scan.max_wait` into milliseconds.
 *
 * Duration grammar: the pack's SHARED parser
 * ({@link parseDurationSeconds}, the same one `approval_lifecycle.max_age`
 * uses), plus an `<n>ms` shorthand it does not model. The extension is
 * not cosmetic: this bound is a transcript-flush allowance measured in
 * tens of milliseconds, so a second-granularity grammar could not express
 * the values the measurement actually argues for, and widening
 * `parseDurationSeconds` itself would change the grammar of every
 * `within:` / `max_age:` / `--since` value in the repo for one key's sake.
 *
 * Both bounds are errors, never clamps: zero or negative (a bound that
 * would disable the poll while the block still claimed to have one) and
 * anything above {@link REPORT_SCAN_MAX_WAIT_CEILING_MS} (a bound that
 * could park a PreToolUse hook). Returning a RESULT rather than throwing
 * keeps the two consumers symmetric: the zod schema turns it into a
 * `harness validate` diagnostic, the runtime parser into one stderr line
 * and a fail-closed `null`.
 */
export function parseReportScanMaxWait(raw: unknown): ReportScanMaxWaitParse {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      reason: `expected a duration string like "500ms", "1500ms" or "2s", got ${
        typeof raw === "string" ? "an empty string" : typeof raw
      }`,
    };
  }
  const trimmed = raw.trim();
  let maxWaitMs: number;
  const ms = MILLISECOND_SHORTHAND.exec(trimmed);
  if (ms) {
    maxWaitMs = Number.parseInt(ms[1]!, 10);
  } else {
    try {
      maxWaitMs = parseDurationSeconds(trimmed) * 1_000;
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof InvalidDurationError ? err.message : String(err),
      };
    }
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
    return {
      ok: false,
      reason: `must be greater than zero, got ${JSON.stringify(trimmed)}`,
    };
  }
  if (maxWaitMs > REPORT_SCAN_MAX_WAIT_CEILING_MS) {
    return {
      ok: false,
      reason: `must not exceed the ${REPORT_SCAN_MAX_WAIT_CEILING_MS}ms hard ceiling (a PreToolUse hook must never park a session), got ${JSON.stringify(
        trimmed,
      )}`,
    };
  }
  return { ok: true, maxWaitMs };
}

/**
 * Parse the optional `auto_approve` pack-config block
 * (docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Option A").
 *
 * FAIL CLOSED, unlike {@link parseApprovalLifecycle}'s best-effort
 * fallback: this block is an opt-IN to a hook-side signing path
 * (hardening item 3 in the ADR's threat model (b) — `require_report:
 * false` must be a schema error, not a silently-ignored key), so any
 * malformed shape here means "not opted in" (`null`), never a partial
 * or default-filled config that could still enable the auto path. The
 * `configSchema` zod block in `../understanding-before-execution.ts` is
 * the first line of defence (`harness validate` / `harness doctor`
 * reject a malformed manifest at lint time); this parser is the second,
 * defensive line for the runtime hook, which must not trust that every
 * config it sees on disk passed the schema.
 *
 * `undefined` / `null` (the block is simply absent) returns `null`
 * silently — that is the ordinary "not opted in" case, not a warning.
 * Every other malformed shape writes exactly one stderr line and
 * returns `null`.
 *
 * `label` is the stderr prefix of the calling hook, so a Codex-side
 * warning reads `harness pack hook codex: ...` like every other line
 * that hook writes. The default reproduces the Claude Code hook's
 * wording byte-for-byte.
 */
export function parseAutoApprove(
  raw: unknown,
  stderr?: { write(s: string): void } | null,
  label = "harness pack hook",
): AutoApproveConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    stderr?.write(
      `${label}: config.auto_approve ignored (expected object, got ${typeof raw})\n`,
    );
    return null;
  }
  const obj = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter((k) => !KNOWN_AUTO_APPROVE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    stderr?.write(
      `${label}: config.auto_approve ignored (unknown key(s): ${unknownKeys.join(", ")})\n`,
    );
    return null;
  }

  const whenRaw = obj["when"];
  if (!Array.isArray(whenRaw) || whenRaw.length === 0) {
    stderr?.write(
      `${label}: config.auto_approve.when ignored (expected a non-empty string[], got ${
        Array.isArray(whenRaw) ? "empty array" : typeof whenRaw
      })\n`,
    );
    return null;
  }
  const when: string[] = [];
  for (const v of whenRaw) {
    if (typeof v !== "string" || v.length === 0) {
      stderr?.write(
        `${label}: config.auto_approve.when ignored (every entry must be a non-empty string, got ${typeof v})\n`,
      );
      return null;
    }
    when.push(v);
  }

  // `harnesses`: absent means the slice-1 default (Claude Code only).
  // Present means an exact, non-empty, duplicate-free list of the known
  // harness identifiers — anything else fails the whole block closed,
  // like every other malformed shape here, so a typo'd entry can never
  // widen the opt-in to a runtime the operator did not name.
  const harnessesRaw = obj["harnesses"];
  let harnesses: string[] = [...DEFAULT_AUTO_APPROVE_HARNESSES];
  if (harnessesRaw !== undefined) {
    if (!Array.isArray(harnessesRaw) || harnessesRaw.length === 0) {
      stderr?.write(
        `${label}: config.auto_approve.harnesses ignored (expected a non-empty array of ${AUTO_APPROVE_HARNESS_VALUES.join(
          " | ",
        )}, got ${Array.isArray(harnessesRaw) ? "empty array" : typeof harnessesRaw})\n`,
      );
      return null;
    }
    const seen: string[] = [];
    for (const v of harnessesRaw) {
      if (typeof v !== "string" || !AUTO_APPROVE_HARNESS_VALUES.includes(v as never)) {
        stderr?.write(
          `${label}: config.auto_approve.harnesses ignored (every entry must be one of ${AUTO_APPROVE_HARNESS_VALUES.join(
            ", ",
          )}, got ${typeof v === "string" ? `"${v}"` : typeof v})\n`,
        );
        return null;
      }
      if (seen.includes(v)) {
        stderr?.write(
          `${label}: config.auto_approve.harnesses ignored (duplicate entry "${v}")\n`,
        );
        return null;
      }
      seen.push(v);
    }
    harnesses = seen;
  }

  // `report_scan`: absent means the measured default
  // ({@link DEFAULT_REPORT_SCAN_MAX_WAIT_MS}). Present means an object
  // carrying exactly `max_wait` and nothing else, parsed and
  // range-checked by `parseReportScanMaxWait`. Anything else fails the
  // WHOLE block closed, like every other malformed shape here, so a
  // typo'd bound can never silently fall back to the default while the
  // operator believes they tuned it.
  const reportScanRaw = obj["report_scan"];
  let reportScanMaxWaitMs = DEFAULT_REPORT_SCAN_MAX_WAIT_MS;
  if (reportScanRaw !== undefined) {
    if (reportScanRaw === null || typeof reportScanRaw !== "object" || Array.isArray(reportScanRaw)) {
      stderr?.write(
        `${label}: config.auto_approve.report_scan ignored (expected object, got ${
          reportScanRaw === null ? "null" : Array.isArray(reportScanRaw) ? "array" : typeof reportScanRaw
        })\n`,
      );
      return null;
    }
    const reportScanObj = reportScanRaw as Record<string, unknown>;
    const unknownScanKeys = Object.keys(reportScanObj).filter(
      (k) => !KNOWN_REPORT_SCAN_KEYS.has(k),
    );
    if (unknownScanKeys.length > 0) {
      stderr?.write(
        `${label}: config.auto_approve.report_scan ignored (unknown key(s): ${unknownScanKeys.join(
          ", ",
        )})\n`,
      );
      return null;
    }
    const maxWait = parseReportScanMaxWait(reportScanObj["max_wait"]);
    if (!maxWait.ok) {
      stderr?.write(
        `${label}: config.auto_approve.report_scan.max_wait ignored (${maxWait.reason})\n`,
      );
      return null;
    }
    reportScanMaxWaitMs = maxWait.maxWaitMs;
  }

  const requireReport = obj["require_report"];
  if (requireReport !== true) {
    stderr?.write(
      `${label}: config.auto_approve ignored (require_report must be true, got ${
        requireReport === false ? "false" : typeof requireReport
      })\n`,
    );
    return null;
  }

  return { when, harnesses, reportScan: { maxWaitMs: reportScanMaxWaitMs } };
}

/**
 * ADR "Additional hardening to specify" item 2: `when` is an allowlist
 * of payload literals, membership by exact string equality, no case
 * folding, no substring, no wildcards. `mode` absent, empty, or not a
 * string means no auto-approval, and `cfg === null` (block absent or
 * malformed) means no auto-approval regardless of `mode`.
 *
 * Takes only the `when` slice of the config rather than the whole block:
 * this predicate reads exactly one field, and saying so in the signature
 * keeps it honest as the block grows further keys (`harnesses`,
 * `report_scan`) that have nothing to do with mode membership.
 */
export function permissionModeAllowed(
  cfg: Pick<AutoApproveConfig, "when"> | null,
  mode: unknown,
): boolean {
  if (cfg === null) return false;
  if (typeof mode !== "string" || mode.length === 0) return false;
  return cfg.when.includes(mode);
}

/**
 * Per-harness opt-in membership, the same exact-string-equality
 * discipline {@link permissionModeAllowed} applies to `when`. `cfg ===
 * null` (block absent or malformed) means no auto-approval regardless of
 * the harness, and an unlisted harness means no auto-approval regardless
 * of `when` — the two allowlists are independent AND conditions, not
 * alternatives.
 *
 * Re-exported through `understanding-before-execution/index.ts` (round-2
 * review finding on slice 2): its call site (`src/cli/pack/auto-approve-path.ts`)
 * imports every sibling symbol it needs (`parseAutoApprove`,
 * `permissionModeAllowed`, ...) through the runtime shim already, so this
 * one was pulled onto the pinned shim surface
 * (tests/policy-packs/ube-export-surface.test.ts) to match, unlike
 * {@link CODEX_HARNESS} which still has exactly one consumer and stays a
 * direct import.
 */
export function harnessAllowed(
  cfg: Pick<AutoApproveConfig, "harnesses"> | null,
  harness: unknown,
): boolean {
  if (cfg === null) return false;
  if (typeof harness !== "string" || harness.length === 0) return false;
  return cfg.harnesses.includes(harness);
}
