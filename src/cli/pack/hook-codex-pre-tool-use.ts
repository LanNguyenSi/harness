// Phase 6 #6 — `harness pack hook codex-pre-tool-use` runtime verb.
//
// Codex variant of the Claude Code blocker (`hook-pre-tool-use.ts`).
// Same approval logic (ledger + persisted-report, either approves), but
// a different I/O contract:
//
//   stdin  : JSON envelope shaped as `{ session_id, tool_name,
//            raw_input, event }` — harness's published wire format that
//            the Codex CLI integration is wrapped to emit. The
//            integration is documented in
//            `docs/policy-packs/understanding-before-execution.md`
//            "Adapter notes / Codex".
//   stdout : block reason on stderr; allow path is silent on stdout.
//   exit   : 0 on allow, 2 on block. Codex's blocking convention is
//            non-zero exit (the JSON-decision shape Claude Code reads
//            is not part of Codex's hook contract today).
//
// Failure mode mirrors the Claude blocker: any error in load / parse /
// ledger / report scan resolves to ALLOW (exit 0, silent diagnostic on
// stderr). The package's optional standalone blocker remains a safety
// net for solo users; the harness blocker is strictly more powerful.

import { queryLedgerByTag, type LedgerEntry } from "../../policies/index.js";
import {
  checkPersistedReport,
  defaultReportsDir,
  matchLedgerEntries,
  type ApprovalCheckResult,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const PACK_NAME = "understanding-before-execution";
const EXIT_BLOCK = 2;

export interface PackHookCodexPreToolUseOptions extends LoaderOptions {
  /** Pack name to evaluate. Defaults to understanding-before-execution. */
  pack?: string;
  /** Override report directory (test injection). */
  reportsDir?: string;
  /** Override timeout per ledger call. */
  ledgerTimeoutMs?: number;
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Inject an alternate manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger query (test). */
  ledgerQuery?: (sessionId: string) => Promise<LedgerEntry[] | { degraded: string }>;
}

export interface PackHookCodexPreToolUseResult {
  exitCode: number;
  blocked: boolean;
  approvalCheck: ApprovalCheckResult;
  /** Diagnostic line emitted to stderr (always; even on allow). */
  diagnostic: string;
}

interface CodexEventEnvelope {
  session_id?: unknown;
  tool_name?: unknown;
  // One Codex-native synonym tolerated: some integrations pass
  // `tool` instead of `tool_name`. We deliberately do NOT alias
  // `event.id` to session_id — `id` in most event-bus shapes is the
  // event/message id, not the session id, and silently resolving to
  // the wrong identifier would only show up as a misleading
  // diagnostic on a fail-block path.
  tool?: unknown;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", (err) => reject(err));
  });
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

async function checkLedger(
  manifest: Manifest,
  sessionId: string,
  opts: PackHookCodexPreToolUseOptions,
): Promise<{ matched: boolean; detail: string }> {
  if (opts.ledgerQuery) {
    const result = await opts.ledgerQuery(sessionId);
    if ("degraded" in result) {
      return { matched: false, detail: `ledger degraded (${result.degraded})` };
    }
    return matchLedgerEntries(result, sessionId);
  }
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { matched: false, detail: "grounding-mcp not declared in manifest" };
  }
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  const env = server.env ?? undefined;
  const timeoutMs = opts.ledgerTimeoutMs ?? server.health?.timeout_ms ?? 5_000;
  const result = await queryLedgerByTag({
    mcpCommand: command,
    ...(env && { mcpEnv: env }),
    sessionId,
    timeoutMs,
  });
  if (result.kind === "degraded") {
    return { matched: false, detail: `ledger degraded (${result.reason})` };
  }
  return matchLedgerEntries(result.entries, sessionId);
}

function allowResult(
  detail: string,
  source: ApprovalCheckResult["source"],
  stderr: NodeJS.WritableStream,
): PackHookCodexPreToolUseResult {
  const diagnostic = `harness pack hook codex: ${detail}, allowing.`;
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    blocked: false,
    approvalCheck: { approved: true, source, detail },
    diagnostic,
  };
}

export async function runPackHookCodexPreToolUseCli(
  opts: PackHookCodexPreToolUseOptions = {},
): Promise<PackHookCodexPreToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  // Read stdin defensively. Bad JSON falls through to allow (matches
  // Claude blocker's failure mode).
  const raw = await readStdin(stdin);
  let event: CodexEventEnvelope = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as CodexEventEnvelope;
  } catch {
    /* allow on malformed input */
  }

  const sessionId =
    pickString(event.session_id) ??
    process.env["CODEX_SESSION_ID"] ??
    process.env["CLAUDE_SESSION_ID"] ??
    "";
  const toolName = pickString(event.tool_name, event.tool) ?? "(unknown)";

  // Load manifest (or use injection). Bail to allow on any failure so a
  // missing harness install never bricks the session.
  let manifest: Manifest;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch (err) {
    return allowResult(
      `manifest load failed (${(err as Error).message})`,
      "none",
      stderr,
    );
  }

  // Confirm the pack is enabled.
  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return allowResult(`pack "${packName}" not declared in manifest`, "none", stderr);
  }
  if (!declared.enabled) {
    return allowResult(`pack "${packName}" is enabled:false`, "none", stderr);
  }

  if (sessionId === "") {
    return allowResult(
      "no session_id resolvable from input or $CODEX_SESSION_ID/$CLAUDE_SESSION_ID",
      "none",
      stderr,
    );
  }

  // Source 1: ledger.
  const ledger = await checkLedger(manifest, sessionId, opts);
  if (ledger.matched) {
    return allowResult(ledger.detail, "ledger", stderr);
  }

  // Source 2: persisted report.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const report = checkPersistedReport(reportsDir, sessionId);
  if (report.approved) {
    return allowResult(report.detail, "persisted-report", stderr);
  }

  // Neither source approved. Codex blocks via non-zero exit + stderr
  // reason; there is no JSON-decision wire to write to stdout.
  const reason = `${ledger.detail}; ${report.detail}`;
  const diagnostic =
    `harness pack hook codex: BLOCK: ${reason}. Tool: ${toolName}. ` +
    "Run `harness approve understanding` once you have produced and confirmed an Understanding Report.";
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: EXIT_BLOCK,
    blocked: true,
    approvalCheck: { approved: false, source: "none", detail: reason },
    diagnostic,
  };
}
