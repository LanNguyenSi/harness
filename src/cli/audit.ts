import {
  parseDurationSeconds,
  queryLedgerByTag,
  type LedgerEntry,
  type LedgerQueryResult,
} from "../policies/index.js";
import {
  decodeLedgerContent,
  type PolicyDecisionPayload,
} from "../runtime/ledger-record.js";
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
  /** Override the ledger fetcher (tests). */
  fetchLedger?: (sessionId: string) => Promise<LedgerQueryResult>;
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
  return async (sessionId: string): Promise<LedgerQueryResult> => {
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
    });
  };
}

function rowsFromEntries(entries: LedgerEntry[]): AuditDecisionRow[] {
  const rows: AuditDecisionRow[] = [];
  for (const entry of entries) {
    const payload = decodeLedgerContent(entry.content);
    if (!payload) continue;
    rows.push({
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
    });
  }
  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return rows;
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

  const sessionId = opts.sessionId ?? "default";
  const fetch = opts.fetchLedger ?? defaultFetcher(opts);
  const result = await fetch(sessionId);
  if (result.kind === "degraded") {
    throw new HarnessExitError(
      `ledger unreachable: ${result.reason}`,
      EX_UNAVAILABLE,
    );
  }

  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - windowSeconds * 1000;

  const all = rowsFromEntries(result.entries);
  let filtered = all.filter((r) => Date.parse(r.timestamp) >= cutoffMs);
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
