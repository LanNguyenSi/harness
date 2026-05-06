import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseLedgerTimestamp,
  queryLedgerByTag,
  type LedgerEntry,
  type LedgerQueryResult,
} from "../../policies/index.js";
import { resolveSessionId } from "../../runtime/session-id.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "../exit-codes.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import { redactString, resolveRedactionRules } from "./redact.js";
import {
  locateTranscript,
  readTranscript,
  type TranscriptEvent,
  type TranscriptParseResult,
} from "./transcript.js";

export type ExportFormat = "json" | "jsonl";

export interface SessionExportOptions extends LoaderOptions {
  sessionId?: string;
  format?: ExportFormat;
  outFile?: string;
  homeDir?: string;
  projectsRoot?: string;
  fetchLedger?: (sessionId: string) => Promise<LedgerQueryResult>;
  /** Override transcript locator (tests). */
  locateTranscript?: (sessionId: string) => string | null;
  /** Read a transcript file (tests). */
  readTranscript?: (file: string) => TranscriptParseResult;
  /** Override env for env_var redaction (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface SessionExportEvent {
  source: "transcript" | "ledger";
  kind: string;
  timestamp: string | null;
  /** Stable per-source ordering tiebreaker. */
  seq: number;
  data: Record<string, unknown>;
}

export interface SessionExportHeader {
  id: string;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  transcriptPath: string | null;
  transcriptEvents: number;
  ledgerEntries: number;
  ledgerStatus: "ok" | "degraded" | "missing";
  ledgerNote: string | null;
  redactionRules: number;
}

export interface SessionExportResult {
  output: string;
  header: SessionExportHeader;
  events: SessionExportEvent[];
}

export async function sessionExport(
  opts: SessionExportOptions,
): Promise<SessionExportResult> {
  const format: ExportFormat = opts.format ?? "json";
  if (format !== "json" && format !== "jsonl") {
    throw new HarnessExitError(
      `unknown --format "${format}"; expected json or jsonl`,
      EX_USAGE,
    );
  }

  const sessionId = resolveSessionId(opts.sessionId);
  const { manifest } = loadManifest(opts);
  const rules = resolveRedactionRules(manifest.audit.redact, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });

  const transcriptResult = await loadTranscript(sessionId, opts);
  const ledgerOutcome = await loadLedger(sessionId, manifest, opts);

  if (
    !transcriptResult.path &&
    transcriptResult.events.length === 0 &&
    ledgerOutcome.entries.length === 0 &&
    ledgerOutcome.status === "ok"
  ) {
    throw new HarnessExitError(
      `no transcript or ledger entries for session "${sessionId}"`,
      EX_FAIL,
    );
  }

  const events = mergeEvents(transcriptResult.events, ledgerOutcome.entries);
  const header: SessionExportHeader = {
    id: sessionId,
    cwd: transcriptResult.cwd,
    startedAt: transcriptResult.startedAt,
    endedAt: transcriptResult.endedAt,
    transcriptPath: transcriptResult.path,
    transcriptEvents: transcriptResult.events.length,
    ledgerEntries: ledgerOutcome.entries.length,
    ledgerStatus: ledgerOutcome.status,
    ledgerNote: ledgerOutcome.note,
    redactionRules: rules.length,
  };

  const rawOutput =
    format === "json"
      ? `${JSON.stringify({ session: header, events }, null, 2)}\n`
      : `${[
          JSON.stringify({ kind: "session", ...header }),
          ...events.map((e) => JSON.stringify(e)),
        ].join("\n")}\n`;
  const output = redactString(rawOutput, rules);

  if (opts.outFile) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outFile)), { recursive: true });
    fs.writeFileSync(opts.outFile, output, "utf8");
  }

  return { output, header, events };
}

interface TranscriptOutcome {
  events: TranscriptEvent[];
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  path: string | null;
}

async function loadTranscript(
  sessionId: string,
  opts: SessionExportOptions,
): Promise<TranscriptOutcome> {
  const locator = opts.locateTranscript ?? ((id) => {
    const args: Parameters<typeof locateTranscript>[1] = {};
    if (opts.homeDir !== undefined) args.homeDir = opts.homeDir;
    if (opts.projectsRoot !== undefined) args.projectsRoot = opts.projectsRoot;
    return locateTranscript(id, args);
  });
  const reader = opts.readTranscript ?? readTranscript;
  const file = locator(sessionId);
  if (file === null) {
    return { events: [], startedAt: null, endedAt: null, cwd: null, path: null };
  }
  const r = reader(file);
  return {
    events: r.events,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    cwd: r.cwd,
    path: file,
  };
}

interface LedgerOutcome {
  entries: LedgerEntry[];
  status: "ok" | "degraded" | "missing";
  note: string | null;
}

async function loadLedger(
  sessionId: string,
  manifest: ReturnType<typeof loadManifest>["manifest"] extends infer M ? M : never,
  opts: SessionExportOptions,
): Promise<LedgerOutcome> {
  const fetcher = opts.fetchLedger ?? defaultLedgerFetcher(manifest);
  if (fetcher === null) {
    return {
      entries: [],
      status: "missing",
      note: "grounding-mcp not declared in manifest; ledger join skipped",
    };
  }
  const result = await fetcher(sessionId);
  if (result.kind === "ok") {
    return { entries: result.entries, status: "ok", note: null };
  }
  return { entries: [], status: "degraded", note: result.reason };
}

type Manifest = ReturnType<typeof loadManifest>["manifest"];

function defaultLedgerFetcher(
  manifest: Manifest,
): ((sid: string) => Promise<LedgerQueryResult>) | null {
  const server = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
  if (!server) return null;
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  return async (sid) =>
    queryLedgerByTag({
      mcpCommand: command,
      ...(server.env && { mcpEnv: server.env }),
      sessionId: sid,
      timeoutMs: server.health?.timeout_ms ?? 5_000,
    });
}

function mergeEvents(
  transcript: TranscriptEvent[],
  ledger: LedgerEntry[],
): SessionExportEvent[] {
  const out: SessionExportEvent[] = [];
  transcript.forEach((e, i) => {
    const data: Record<string, unknown> = { ...e.data };
    if (e.uuid !== undefined) data.uuid = e.uuid;
    if (e.parentUuid !== undefined) data.parentUuid = e.parentUuid;
    if (e.cwd !== undefined) data.cwd = e.cwd;
    out.push({
      source: "transcript",
      kind: e.kind,
      timestamp: e.timestamp,
      seq: i,
      data,
    });
  });
  ledger.forEach((entry, i) => {
    const ts = ledgerEntryIso(entry);
    const data: Record<string, unknown> = {
      id: entry.id,
      content: entry.content,
    };
    if (entry.type !== undefined) data.type = entry.type;
    if (entry.source !== undefined) data.tagSource = entry.source;
    out.push({
      source: "ledger",
      kind: entry.type ?? "ledger_entry",
      timestamp: ts,
      seq: i,
      data,
    });
  });
  out.sort((a, b) => {
    const at = a.timestamp ?? "";
    const bt = b.timestamp ?? "";
    if (at === bt) {
      if (a.source !== b.source) return a.source === "transcript" ? -1 : 1;
      return a.seq - b.seq;
    }
    if (at === "") return 1;
    if (bt === "") return -1;
    return at < bt ? -1 : 1;
  });
  return out;
}

function ledgerEntryIso(entry: LedgerEntry): string | null {
  if (entry.createdAt instanceof Date) return entry.createdAt.toISOString();
  if (typeof entry.createdAt === "string") {
    const parsed = parseLedgerTimestamp(entry.createdAt);
    if (parsed === null) return null;
    return new Date(parsed * 1000).toISOString();
  }
  return null;
}

export { mergeEvents as mergeEventsForTesting };
