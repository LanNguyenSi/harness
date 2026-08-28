import {
  parseDurationSeconds,
  parseLedgerTimestamp,
  queryLedgerByTag,
  type LedgerEntry,
  type LedgerQueryResult,
} from "../policies/index.js";
import {
  decisionSortKey,
  decodeLedgerContent,
  type PolicyDecisionPayload,
} from "../io/ledger-record.js";
import { POLICY_DECISION_TYPE } from "../io/ledger-record.js";
import {
  approvedLedgerTagFor,
  autoApprovedLedgerTagFor,
} from "../policy-packs/builtin/understanding-before-execution/index.js";
import {
  resolveReadSessionId,
  type ResolveReadSessionOptions,
} from "../runtime/session-id.js";
import { EX_UNAVAILABLE, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

const DEFAULT_SINCE = "24h";

export type AuditOutcome = PolicyDecisionPayload["outcome"];

export interface AuditOptions extends LoaderOptions {
  json?: boolean;
  since?: string;
  policy?: string;
  outcome?: AuditOutcome;
  sessionId?: string;
  /**
   * Read-path session resolution overrides (tests). When `sessionId` is
   * not given, `resolveReadSessionId` discovers the live session from
   * the newest Claude Code transcript; this seam lets tests stub that
   * scan so they stay hermetic.
   */
  sessionDiscovery?: ResolveReadSessionOptions;
  /**
   * Override the ledger fetcher (tests). The optional `filters` arg
   * carries the Phase 5 #5 server-side narrowing hints (sinceIso,
   * contentPrefix); test fakes can ignore it without consequence.
   */
  fetchLedger?: (
    sessionId: string,
    filters?: { sinceIso?: string; contentPrefix?: string },
  ) => Promise<LedgerQueryResult>;
  /** Override "now" (tests). */
  now?: Date;
  /**
   * Sink for the audit-only "approvals unavailable" notice (M4: a degraded
   * second fetch degrades softly rather than discarding the already-fetched
   * decisions table). Defaults to `process.stderr.write`, matching the
   * one-stderr-line posture `src/cli/pack/auto-approve-path.ts` uses for its
   * own audit-only ledger writes.
   */
  stderr?: (s: string) => void;
}

export interface AuditDecisionRow {
  timestamp: string;
  name: string;
  outcome: AuditOutcome;
  enforcement: PolicyDecisionPayload["enforcement"];
  reason: string;
  ledgerTag: string;
  extractValues: Record<string, string>;
  /**
   * True when the policy's `when:` matched only via the fail-closed
   * unclassified rule (M7). Absent when the action was classified or the
   * policy had no `when:` block, or on rows recorded before M7.
   * Appears in JSON output and annotates the reason column in table output.
   */
  whenUnclassifiedFallback?: boolean;
}

/**
 * One raw understanding-gate ledger fact in the audit window: a
 * `understanding-approved:<sid>` (human approval, plain or
 * `:forced:<field>`-suffixed) or `understanding-auto-approved:<sid>`
 * (auto-mode) row, exactly as the two writers stamp it
 * (`src/cli/approve/understanding.ts`, `src/cli/pack/auto-approve-path.ts`).
 * Read-only reporting: this section carries no gate authority, mirroring
 * the ledger's audit-only status for both tag families.
 */
export interface AuditApprovalRow {
  timestamp: string;
  tag: string;
  source: string;
}

export interface AuditResult {
  output: string;
  decisions: AuditDecisionRow[];
  approvals: AuditApprovalRow[];
  /**
   * M4: set when the approvals fetch (only) came back degraded. The
   * decisions table still renders; this carries the reason so `--json`
   * consumers can tell "no approval facts" apart from "couldn't check".
   */
  approvalsUnavailable?: string;
}

const VALID_OUTCOMES: AuditOutcome[] = [
  "allow",
  "warn",
  "require_approval",
  "deny",
  "warn-degraded",
  "deny-degraded",
];

function isValidOutcome(v: string): v is AuditOutcome {
  return (VALID_OUTCOMES as string[]).includes(v);
}

function defaultFetcher(opts: AuditOptions) {
  return async (
    sessionId: string,
    filters?: { sinceIso?: string; contentPrefix?: string },
  ): Promise<LedgerQueryResult> => {
    const { manifest } = loadManifest(opts);
    const server = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
    if (!server) {
      return { kind: "degraded", reason: "grounding-mcp not declared in manifest" };
    }
    const command = Array.isArray(server.command)
      ? server.command
      : server.command.trim().split(/\s+/);
    return queryLedgerByTag({
      mcpCommand: command,
      ...(server.env && { mcpEnv: server.env }),
      sessionId,
      timeoutMs: server.health?.timeout_ms ?? 5_000,
      ...(filters?.sinceIso !== undefined && { sinceIso: filters.sinceIso }),
      ...(filters?.contentPrefix !== undefined && { contentPrefix: filters.contentPrefix }),
    });
  };
}

function rowsFromEntries(entries: LedgerEntry[]): AuditDecisionRow[] {
  // Decode + retain the entry/payload pair so we can sort by Phase 5 #9's
  // ms-precision `evaluatedAt` before flattening to the display row. The
  // displayed `timestamp` field stays the ledger's `createdAt` (which is
  // what users see in the table); only the sort key changes.
  const decoded: { entry: LedgerEntry; payload: PolicyDecisionPayload }[] = [];
  for (const entry of entries) {
    const payload = decodeLedgerContent(entry.content);
    if (!payload) continue;
    decoded.push({ entry, payload });
  }
  decoded.sort(
    (a, b) => decisionSortKey(a.entry, a.payload) - decisionSortKey(b.entry, b.payload),
  );
  return decoded.map(({ entry, payload }) => ({
    timestamp:
      typeof entry.createdAt === "string"
        ? entry.createdAt
        : entry.createdAt.toISOString(),
    name: payload.name,
    outcome: payload.outcome,
    enforcement: payload.enforcement,
    reason: payload.reason,
    ledgerTag: payload.ledgerTag,
    extractValues: payload.extractValues,
    // M7: carry the fail-closed flag through to the row so both the JSON
    // and table surfaces can surface it (field in JSON, annotation in table).
    ...(payload.whenUnclassifiedFallback === true && {
      whenUnclassifiedFallback: true,
    }),
  }));
}

/**
 * agent-tasks 5ad63b01: build the raw understanding-gate approval-fact
 * rows for the audit window. Reuses the two writers' own tag builders
 * (`approvedLedgerTagFor` / `autoApprovedLedgerTagFor`, keyed on the
 * SAME resolved `sessionId` the ledger fetch itself is scoped to)
 * instead of re-deriving the tag shape with a parser, so a change to
 * either prefix or to the `:forced:<field>` suffix convention cannot
 * drift out of sync with this read path. Matching is exact-or-forced-
 * prefix, never substring, so `review:42:approved` (or any future tag
 * that merely CONTAINS one of these strings) cannot slip in, the same
 * substring-pollution concern `isPolicyDecisionRow` guards on the
 * gate-check side (`ledger.ts`).
 */
function rowsFromApprovalEntries(
  entries: LedgerEntry[],
  sessionId: string,
): AuditApprovalRow[] {
  const humanTag = approvedLedgerTagFor(sessionId);
  const humanForcedPrefix = `${humanTag}:forced:`;
  const autoTag = autoApprovedLedgerTagFor(sessionId);
  const rows: AuditApprovalRow[] = [];
  for (const entry of entries) {
    const content = entry.content;
    if (content !== humanTag && content !== autoTag && !content.startsWith(humanForcedPrefix)) {
      continue;
    }
    rows.push({
      timestamp:
        typeof entry.createdAt === "string"
          ? entry.createdAt
          : entry.createdAt.toISOString(),
      tag: content,
      source: entry.source ?? "",
    });
  }
  rows.sort((a, b) => parseLedgerTimestamp(a.timestamp) - parseLedgerTimestamp(b.timestamp));
  return rows;
}

function renderTable(header: string[], data: string[][]): string {
  if (data.length === 0) return "";
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const lines: string[] = [];
  lines.push(fmt(header));
  lines.push(widths.map((w) => "-".repeat(w)).join("  ").trimEnd());
  for (const row of data) lines.push(fmt(row));
  return `${lines.join("\n")}\n`;
}

// Single-line-ify a cell so a newline buried in untrusted content (a policy
// reason, or a ledger `tag`/`source` value the approvals section reads
// verbatim) can't split one logical row into two rendered table rows.
const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();

// M3: cap after flattening so a very long tag/source can't blow out the
// table width; the ellipsis marker makes the truncation visible rather than
// silently swallowing content.
const MAX_CELL_LEN = 200;
const flattenAndCap = (s: string): string => {
  const flat = flatten(s);
  return flat.length > MAX_CELL_LEN ? `${flat.slice(0, MAX_CELL_LEN)}…` : flat;
};

function formatTable(rows: AuditDecisionRow[]): string {
  if (rows.length === 0) return "";
  const header = ["timestamp", "policy", "outcome", "reason"];
  // Reasons are normally single-line; flatten just in case so the column
  // alignment doesn't break on a newline buried in a future policy's reason.
  // M7: annotate with [unclassified-fallback] when the fail-closed flag is
  // set, so the human table reflects the same information the JSON field does.
  const data = rows.map((r) => {
    const reasonCell =
      flatten(r.reason) + (r.whenUnclassifiedFallback ? " [unclassified-fallback]" : "");
    return [r.timestamp, r.name, r.outcome, reasonCell];
  });
  return renderTable(header, data);
}

/**
 * Table rendering for the approvals section. Empty is `""` (never a
 * header-only table), so the caller can decide whether to omit the whole
 * section without inspecting row counts twice.
 *
 * M3: `tag` and `source` are untrusted ledger content (a forged or
 * malformed entry could carry a newline), so both cells are flattened and
 * length-capped the same way `formatTable` treats `reason`, otherwise an
 * embedded newline renders as an extra table row that looks like a second,
 * forged approval fact.
 */
function formatApprovals(rows: AuditApprovalRow[]): string {
  if (rows.length === 0) return "";
  const header = ["timestamp", "tag", "source"];
  const data = rows.map((r) => [r.timestamp, flattenAndCap(r.tag), flattenAndCap(r.source)]);
  return renderTable(header, data);
}

export async function audit(opts: AuditOptions = {}): Promise<AuditResult> {
  const since = opts.since ?? DEFAULT_SINCE;
  let windowSeconds: number;
  try {
    windowSeconds = parseDurationSeconds(since);
  } catch (err) {
    throw new HarnessExitError(
      `--since: ${(err as Error).message}`,
      EX_USAGE,
    );
  }
  if (opts.outcome !== undefined && !isValidOutcome(opts.outcome)) {
    throw new HarnessExitError(
      `--outcome: must be one of ${VALID_OUTCOMES.join(", ")} (got "${opts.outcome}")`,
      EX_USAGE,
    );
  }

  const sessionId = resolveReadSessionId(opts.sessionId, opts.sessionDiscovery);
  const fetch = opts.fetchLedger ?? defaultFetcher(opts);
  // Phase 5 #5 — push filters server-side when the connected
  // grounding-mcp supports them (capability-detected by
  // queryLedgerByTag via tools/list). The audit's own client-side
  // filter math at line ~165 is preserved verbatim, so an old server
  // ignoring these args still produces the correct table.
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - windowSeconds * 1000;
  const sinceIso = new Date(cutoffMs).toISOString();
  const result = await fetch(sessionId, {
    sinceIso,
    contentPrefix: `${POLICY_DECISION_TYPE}:`,
  });
  if (result.kind === "degraded") {
    throw new HarnessExitError(
      `ledger unreachable: ${result.reason}`,
      EX_UNAVAILABLE,
    );
  }

  const all = rowsFromEntries(result.entries);
  let filtered = all.filter((r) => parseLedgerTimestamp(r.timestamp) >= cutoffMs);
  if (opts.policy) {
    filtered = filtered.filter((r) => r.name === opts.policy);
  }
  if (opts.outcome) {
    filtered = filtered.filter((r) => r.outcome === opts.outcome);
  }

  // Second, independent ledger fetch for the raw understanding-gate
  // approval facts (docs/decisions/2026-08-27-ug-auto-mode-approval.md,
  // "Audit and doctor"). Same server-side-narrowing / client-side-filter-
  // stays-correct contract as the policy_decision fetch above:
  // `contentPrefix: "understanding-"` is pushed server-side when
  // supported, and rowsFromApprovalEntries + the `--since` filter below
  // are applied regardless, so an old server that ignores the hint and
  // returns the whole session still renders correctly. Filtered by
  // `--since` and `--session` only (never `--policy` / `--outcome`,
  // which are policy-decision-only filters); the `--session` filtering
  // falls out of `rowsFromApprovalEntries` matching tags built from this
  // SAME resolved `sessionId`.
  const approvalResult = await fetch(sessionId, {
    sinceIso,
    contentPrefix: "understanding-",
  });
  const stderrSink = opts.stderr ?? ((s: string) => process.stderr.write(s));
  let approvals: AuditApprovalRow[] = [];
  let approvalsUnavailable: string | undefined;
  if (approvalResult.kind === "degraded") {
    // M4: a degraded approvals fetch degrades softly, it must not discard
    // the decisions table that already fetched successfully. Exit code is
    // unchanged (tied to the policy-decision fetch only, above); the
    // audit-only posture gets one stderr line, matching
    // `src/cli/pack/auto-approve-path.ts`'s own audit-only-write failures.
    approvalsUnavailable = approvalResult.reason;
    stderrSink(`approvals unavailable: ${approvalResult.reason}\n`);
  } else {
    approvals = rowsFromApprovalEntries(approvalResult.entries, sessionId).filter(
      (r) => parseLedgerTimestamp(r.timestamp) >= cutoffMs,
    );
  }

  const decisionsText =
    filtered.length === 0 ? `no policy decisions in the last ${since}\n` : formatTable(filtered);
  // Omitted entirely when empty and available (acceptance criterion 1), so
  // the documented empty-window message above stays byte-identical when
  // there is also nothing to approve.
  const approvalsText =
    approvalsUnavailable !== undefined
      ? `\napprovals unavailable: ${approvalsUnavailable}\n`
      : approvals.length === 0
        ? ""
        : `\napprovals\n${formatApprovals(approvals)}`;

  const output = opts.json
    ? `${JSON.stringify(
        {
          sessionId,
          decisions: filtered,
          approvals,
          ...(approvalsUnavailable !== undefined && { approvalsUnavailable }),
        },
        null,
        2,
      )}\n`
    : `${decisionsText}${approvalsText}`;
  return {
    output,
    decisions: filtered,
    approvals,
    ...(approvalsUnavailable !== undefined && { approvalsUnavailable }),
  };
}
