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
} from "../runtime/ledger-record.js";
import { POLICY_DECISION_TYPE } from "../runtime/ledger-record.js";
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
}

export interface AuditDecisionRow {
  timestamp: string;
  name: string;
  outcome: AuditOutcome;
  enforcement: PolicyDecisionPayload["enforcement"];
  reason: string;
  ledgerTag: string;
  extractValues: Record<string, string>;
}

export interface AuditResult {
  output: string;
  decisions: AuditDecisionRow[];
}

const VALID_OUTCOMES: AuditOutcome[] = ["allow", "deny", "warn-degraded"];

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
  }));
}

function formatTable(rows: AuditDecisionRow[]): string {
  if (rows.length === 0) return "";
  const header = ["timestamp", "policy", "outcome", "reason"];
  // Reasons are normally single-line; flatten just in case so the column
  // alignment doesn't break on a newline buried in a future policy's reason.
  const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();
  const data = rows.map((r) => [r.timestamp, r.name, r.outcome, flatten(r.reason)]);
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
      `--outcome: must be one of allow, deny, warn-degraded (got "${opts.outcome}")`,
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

  if (filtered.length === 0) {
    const output = opts.json
      ? `${JSON.stringify({ decisions: [] }, null, 2)}\n`
      : `no policy decisions in the last ${since}\n`;
    return { output, decisions: [] };
  }

  const output = opts.json
    ? `${JSON.stringify({ decisions: filtered }, null, 2)}\n`
    : formatTable(filtered);
  return { output, decisions: filtered };
}
