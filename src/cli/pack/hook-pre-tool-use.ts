// Phase 6 #4 — `harness pack hook pre-tool-use [--pack <name>]` runtime verb.
//
// PreToolUse blocker for pack-driven gates. Wired by the
// understanding-before-execution pack's hook contribution; receives the
// Claude Code event JSON on stdin, consults the two approval sources
// (evidence ledger via grounding-mcp, persisted JSON report under
// `.understanding-gate/reports/`), emits a `{decision: "block"}` JSON to
// stdout when neither source has approved.
//
// Why a new CLI verb (vs reusing `harness policy intercept`): the
// existing intercept layer evaluates `policies[]` against `requires`,
// which is purely ledger-based. The Understanding Gate has a second
// source-of-truth (the persisted JSON report), and bolting a fallback
// into the requires evaluator would leak pack-specific semantics into
// the generic policy layer. This verb lives next to the pack instead.
//
// Failure mode: any error in load / parse / ledger / report scan
// resolves to ALLOW (exit 0, silent). The Understanding Gate is opt-in;
// turning a bug in this code into a session-wide tool block would be
// hostile. The npm package's own standalone blocker still runs as a
// secondary safety net for solo users, and `harness explain --trace`
// (Phase 4 #6) surfaces the runtime audit trail when configured.

import {
  queryLedgerByTag,
  type LedgerEntry,
} from "../../policies/index.js";
import {
  checkPersistedReport,
  defaultReportsDir,
  matchLedgerEntries,
  type ApprovalCheckResult,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookPreToolUseOptions extends LoaderOptions {
  /** Pack name to evaluate. Defaults to understanding-before-execution. */
  pack?: string;
  /** Override report directory (test injection). */
  reportsDir?: string;
  /** Override timeout per ledger call. */
  ledgerTimeoutMs?: number;
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Inject an alternate manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger query (test). */
  ledgerQuery?: (sessionId: string) => Promise<LedgerEntry[] | { degraded: string }>;
}

export interface PackHookPreToolUseResult {
  exitCode: number;
  blocked: boolean;
  approvalCheck: ApprovalCheckResult;
  /** Diagnostic line emitted to stderr (always; even on allow). */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
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

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

function blockJson(toolName: string, reason: string): string {
  return JSON.stringify({
    decision: "block",
    reason: `Understanding Gate: ${reason}. Tool: ${toolName}. Run \`harness approve understanding\` once you have produced and confirmed an Understanding Report.`,
  });
}

async function checkLedger(
  manifest: Manifest,
  sessionId: string,
  opts: PackHookPreToolUseOptions,
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

export async function runPackHookPreToolUseCli(
  opts: PackHookPreToolUseOptions = {},
): Promise<PackHookPreToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  // Read stdin defensively. Bad JSON falls through to allow (matches
  // policy intercept's failure mode).
  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    /* allow on malformed input */
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";

  // Load manifest (or use injection). Bail to allow on any failure so a
  // missing harness install never bricks the session.
  let manifest: Manifest;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch (err) {
    const diagnostic = `harness pack hook: manifest load failed (${
      (err as Error).message
    }), allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Confirm the pack is enabled. A pack that isn't even declared in the
  // manifest means the operator wired this hook directly into
  // settings.json without `harness apply` — odd but harmless; allow.
  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    const diagnostic = `harness pack hook: pack "${packName}" not declared in manifest, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }
  if (!declared.enabled) {
    const diagnostic = `harness pack hook: pack "${packName}" is enabled:false, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  if (sessionId === "") {
    const diagnostic =
      'harness pack hook: no session_id resolvable from input or $CLAUDE_SESSION_ID, allowing.';
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Source 1: ledger.
  const ledger = await checkLedger(manifest, sessionId, opts);
  if (ledger.matched) {
    const diagnostic = `harness pack hook: ${ledger.detail}, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "ledger", detail: ledger.detail },
      diagnostic,
    };
  }

  // Source 2: persisted report.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const report = checkPersistedReport(reportsDir, sessionId);
  if (report.approved) {
    const diagnostic = `harness pack hook: ${report.detail}, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "persisted-report", detail: report.detail },
      diagnostic,
    };
  }

  // Neither source approved.
  const reason = `${ledger.detail}; ${report.detail}`;
  const diagnostic = `harness pack hook: BLOCK — ${reason}`;
  stderr.write(`${diagnostic}\n`);
  stdout.write(`${blockJson(toolName, "no approved Understanding Report for this session")}\n`);
  return {
    exitCode: 0,
    blocked: true,
    approvalCheck: { approved: false, source: "none", detail: reason },
    diagnostic,
  };
}
