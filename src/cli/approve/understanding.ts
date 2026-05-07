// Phase 6 #4 — `harness approve understanding [--session <id>]` CLI verb.
//
// Round-trips both approval sources for the
// `understanding-before-execution` pack:
//
//   1. Writes the evidence-ledger tag `understanding-approved:${SESSION_ID}`
//      via `grounding-mcp`'s `ledger_add` (best-effort: degraded ledger
//      surfaces as a warning, not a hard failure).
//   2. Flips `approvalStatus: "approved"` on the latest persisted JSON
//      report under `.understanding-gate/reports/`. Atomic rewrite.
//
// Rationale for writing both: harnessed sessions consult the ledger as
// canonical, but a solo `@lannguyensi/understanding-gate` user without
// `grounding-mcp` wired only sees the persisted JSON. Round-tripping
// both means switching between the two stacks doesn't lose history.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  approvedLedgerTagFor,
  defaultReportsDir,
  findLatestReportForSession,
  listPersistedReports,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { addLedgerFact } from "../../runtime/ledger-add.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

export interface ApproveUnderstandingOptions extends LoaderOptions {
  /** Explicit session id (overrides $CLAUDE_SESSION_ID). */
  session?: string;
  /** Override the reports directory (test injection). */
  reportsDir?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Override the actor recorded in the persisted report. */
  approvedBy?: string;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Override the ledger writer (test). */
  ledgerAdd?: (sessionId: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ApproveUnderstandingResult {
  sessionId: string;
  ledger: { ok: boolean; tag: string; reason?: string };
  persistedReport:
    | { ok: true; filePath: string; previousStatus: string | null; approvedAt: string }
    | { ok: false; reason: string };
}

const DEFAULT_APPROVED_BY = "harness-approve-cli";

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

function expandHomePath(p: string): string {
  if (p === "~") return process.env.HOME ?? os.homedir();
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? os.homedir(), p.slice(2));
  return p;
}

async function writeLedgerTag(
  manifest: Manifest,
  sessionId: string,
  content: string,
  opts: ApproveUnderstandingOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.ledgerAdd) return opts.ledgerAdd(sessionId, content);
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  const command = Array.isArray(server.command)
    ? server.command.map(expandHomePath)
    : server.command.trim().split(/\s+/).map(expandHomePath);
  return addLedgerFact({
    mcpCommand: command,
    ...(server.env && { mcpEnv: server.env }),
    timeoutMs: server.health?.timeout_ms ?? 5_000,
    sessionId,
    content,
    source: "harness-approve-understanding",
  });
}

function rewriteReportApproved(
  filePath: string,
  approvedAt: string,
  approvedBy: string,
): { previousStatus: string | null } {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const previousStatus =
    typeof parsed["approvalStatus"] === "string" ? (parsed["approvalStatus"] as string) : null;
  parsed["approvalStatus"] = "approved";
  parsed["approvedAt"] = approvedAt;
  parsed["approvedBy"] = approvedBy;
  atomicWriteFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { previousStatus };
}

export async function approveUnderstanding(
  opts: ApproveUnderstandingOptions = {},
): Promise<ApproveUnderstandingResult> {
  const sessionId =
    opts.session ?? process.env.CLAUDE_SESSION_ID ?? process.env.HARNESS_SESSION_ID ?? "";
  if (sessionId === "") {
    throw new HarnessExitError(
      "no session id available. Pass --session <id> or set $CLAUDE_SESSION_ID.",
      EX_FAIL,
    );
  }

  // Manifest is required for the ledger write path; if it can't load,
  // we still try to flip the persisted report so a solo user benefits.
  let manifest: Manifest | null = null;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch {
    /* swallow; ledger write becomes a degraded-ok */
  }

  const tag = approvedLedgerTagFor(sessionId);
  const ledgerResult = manifest
    ? await writeLedgerTag(manifest, sessionId, tag, opts)
    : { ok: false as const, reason: "manifest unreadable; skipped ledger write" };

  // Persisted report: flip the latest matching one.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const reports = listPersistedReports(reportsDir);
  const latest = findLatestReportForSession(reports, sessionId);

  let persistedReport: ApproveUnderstandingResult["persistedReport"];
  if (!latest) {
    persistedReport = {
      ok: false,
      reason:
        reports.length === 0
          ? `no reports found at ${reportsDir}`
          : `no report matched session_id=${sessionId} (${reports.length} report(s) for other sessions)`,
    };
  } else {
    const approvedAt = (opts.now ?? new Date()).toISOString();
    const approvedBy = opts.approvedBy ?? DEFAULT_APPROVED_BY;
    try {
      const { previousStatus } = rewriteReportApproved(latest.filePath, approvedAt, approvedBy);
      persistedReport = {
        ok: true,
        filePath: latest.filePath,
        previousStatus,
        approvedAt,
      };
    } catch (err) {
      persistedReport = {
        ok: false,
        reason: `failed to rewrite ${latest.filePath}: ${(err as Error).message}`,
      };
    }
  }

  return {
    sessionId,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
    persistedReport,
  };
}
