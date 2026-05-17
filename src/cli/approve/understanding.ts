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
  writeApprovalMarker,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { addLedgerFact } from "../../runtime/ledger-add.js";
import {
  clearPendingApproval,
  readPendingApproval,
  resolveGeneratedDir,
} from "../../runtime/pending-approval.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";

export interface ApproveUnderstandingOptions extends LoaderOptions {
  /** Explicit session id (overrides $CLAUDE_SESSION_ID). */
  session?: string;
  /** Override the reports directory (test injection). */
  reportsDir?: string;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
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
  /**
   * Where `sessionId` came from. Surfaced so the CLI can show the
   * operator when the id was not explicit (`pending-approval` / `env`),
   * which is the moment to sanity-check it against the live session.
   */
  sessionSource: "flag" | "env" | "pending-approval";
  /**
   * Canonical gate-satisfying signal as of agent-tasks/88ca4bb3.
   * `ok: false` means the marker file could not be written (rare:
   * fs permission, missing parent directory) and the gate will still
   * block on the next tool call. The CLI surfaces this as a hard error
   * to the operator so they don't think they approved when they didn't.
   */
  marker: { ok: true; filePath: string; approvedAt: string } | { ok: false; reason: string };
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

interface ParseErrorSummary {
  filePath: string;
  /** One-line human-readable summary suitable for inlining in the CLI reason. */
  summary: string;
}

/**
 * Find the freshest parse-error log under `<dir>` (the
 * `<reports-dir>/../parse-errors/` location the standalone Stop hook
 * writes to when `parseReport` rejects the agent's last message). Used
 * to upgrade `approve understanding`'s "no reports found" diagnostic
 * from a silent dead end to a "hook fired but parse failed because X"
 * pointer. Best-effort: any I/O error is swallowed and we report no
 * parse-error, mirroring the listPersistedReports contract.
 *
 * `sessionId` filter (agent-tasks/b13205b2): each parse-error log's JSON
 * header carries the `sessionId` of the session that produced it. The
 * lookup used to return the directory-newest log regardless of whose
 * session wrote it, so a stale parse-error from a previous session would
 * surface in the current operator's approve output and read like a
 * failure of THEIR session. Logs whose header sessionId does not match
 * `sessionId` are now skipped entirely. Logs missing a `sessionId` field
 * (or whose header is not JSON) are also skipped, since we cannot
 * attribute them.
 */
function findLatestParseError(dir: string, sessionId: string): ParseErrorSummary | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: { filePath: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    candidates.push({ filePath: full, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const cand of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(cand.filePath, "utf8");
    } catch {
      continue;
    }
    // The standalone package writes a JSON header followed by `--- raw ---`
    // and the original assistant text. Read the header for a `message`,
    // `reason`, or `missing` field; fall back to the first line if the
    // schema is unfamiliar so a future format change still surfaces
    // *something* rather than going silent.
    const header = raw.split("\n--- raw ---")[0] ?? raw;
    let summary = (header.split("\n")[0] ?? "").trim();
    let headerSessionId: string | null = null;
    try {
      const parsed = JSON.parse(header) as Record<string, unknown>;
      if (typeof parsed["sessionId"] === "string") {
        headerSessionId = parsed["sessionId"] as string;
      }
      if (typeof parsed["message"] === "string" && parsed["message"].length > 0) {
        summary = parsed["message"] as string;
      } else if (typeof parsed["reason"] === "string") {
        const missing = Array.isArray(parsed["missing"])
          ? ` (missing: ${(parsed["missing"] as unknown[]).filter((m) => typeof m === "string").join(", ")})`
          : "";
        summary = `${parsed["reason"] as string}${missing}`;
      }
    } catch {
      /* keep the first-line fallback; headerSessionId stays null */
    }
    if (headerSessionId !== sessionId) continue;
    return { filePath: cand.filePath, summary };
  }
  return null;
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
  // harness.generated/ holds the `.pending-approval` staging file (the
  // third resolution tier below) and is the directory this command cleans
  // up after consuming a staged id. `resolvePaths` only computes paths —
  // it does not read or parse the manifest — so the lookup still works
  // even when the manifest itself is unparseable.
  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: resolvePaths(opts).base,
    });

  // Session id resolution, in precedence order:
  //   1. explicit --session flag
  //   2. $CLAUDE_SESSION_ID (set inside a live Claude Code session)
  //   3. the `.pending-approval` file the gate hook staged on its last
  //      block — this is what makes an arg-less `harness approve` work
  //      from the operator's `!`-shell, where neither of the above is set.
  let sessionId = "";
  let sessionSource: ApproveUnderstandingResult["sessionSource"] = "flag";
  if (typeof opts.session === "string" && opts.session.length > 0) {
    sessionId = opts.session;
    sessionSource = "flag";
  } else if (
    typeof process.env.CLAUDE_SESSION_ID === "string" &&
    process.env.CLAUDE_SESSION_ID.length > 0
  ) {
    sessionId = process.env.CLAUDE_SESSION_ID;
    sessionSource = "env";
  } else {
    const staged = readPendingApproval(generatedDir);
    if (staged !== null) {
      sessionId = staged;
      sessionSource = "pending-approval";
    }
  }

  if (sessionId === "") {
    // Reaching here means no flag, no $CLAUDE_SESSION_ID, AND no staged
    // `.pending-approval` — the gate either never blocked this session or
    // the staging file was already consumed. Spell out the retrieval
    // paths so the operator does not have to dig through docs.
    throw new HarnessExitError(
      [
        "no session id available. Pass --session <id> or set $CLAUDE_SESSION_ID.",
        "",
        "Normally the understanding-gate hook stages the session id in",
        `  ${generatedDir}/.pending-approval`,
        "the moment it blocks a tool, and `harness approve` reads it with no",
        "arguments. An empty result here means the gate has not blocked this",
        "session yet (nothing to approve), or the file was already consumed.",
        "",
        "To find the id by hand:",
        "  • From inside Claude: ask the agent to print $CLAUDE_SESSION_ID.",
        "  • From a second shell, take the basename of the newest project",
        "    transcript:",
        "      ls -t ~/.claude/projects/*/[0-9a-f]*.jsonl | head -1 \\",
        "        | xargs -n1 basename | sed 's/\\.jsonl$//'",
        "",
        "If approve writes the tag but the gate still blocks, the running",
        "Claude session is using a different session id than the transcript",
        "filename. In that case ask the agent to read its own session id",
        "and pass that exact value to --session.",
      ].join("\n"),
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

  // Write the canonical approval marker first. The gate consults this
  // file (not the ledger) since agent-tasks/88ca4bb3 closed the self-
  // approval backdoor: the agent has direct MCP access to the ledger,
  // but no path to write a file under harness.generated/.
  const approvedAtMarker = (opts.now ?? new Date()).toISOString();
  const approvedByMarker = opts.approvedBy ?? DEFAULT_APPROVED_BY;
  let markerResult: ApproveUnderstandingResult["marker"];
  try {
    const filePath = writeApprovalMarker(generatedDir, sessionId, {
      approvedAt: approvedAtMarker,
      approvedBy: approvedByMarker,
    });
    markerResult = { ok: true, filePath, approvedAt: approvedAtMarker };
  } catch (err) {
    markerResult = {
      ok: false,
      reason: `failed to write approval marker: ${(err as Error).message}`,
    };
  }

  const tag = approvedLedgerTagFor(sessionId);
  const ledgerResult = manifest
    ? await writeLedgerTag(manifest, sessionId, tag, opts)
    : { ok: false as const, reason: "manifest unreadable; skipped ledger write" };

  // Persisted report: flip the latest matching one. Resolution mirrors
  // what `harness apply` bakes into the pack's hook commands so all three
  // actors (Stop hook, PreToolUse blocker, this verb) agree regardless
  // of cwd:
  //   1. explicit opts.reportsDir (test injection).
  //   2. UNDERSTANDING_GATE_REPORT_DIR env (honored by defaultReportsDir,
  //      and what apply prefixes onto the hook command strings).
  //   3. manifest-anchored fallback: <dir-of-manifest>/.understanding-gate/reports.
  const manifestAnchoredCwd = path.dirname(resolvePaths(opts).base);
  const reportsDir = opts.reportsDir ?? defaultReportsDir(manifestAnchoredCwd);
  const reports = listPersistedReports(reportsDir);
  const latest = findLatestReportForSession(reports, sessionId);

  let persistedReport: ApproveUnderstandingResult["persistedReport"];
  if (!latest) {
    // When no matching report exists, look at the sibling parse-errors
    // directory (`<dir-of-reports>/../parse-errors/`, the path the
    // standalone @lannguyensi/understanding-gate Stop hook writes to
    // when its parser rejects the agent's last message). Surface the
    // newest entry's reason so "no reports found" becomes "the hook
    // fired but the parser rejected the report — here is why", rather
    // than a silent dead end.
    const parseErrorsDir = path.join(path.dirname(reportsDir), "parse-errors");
    const latestParseError = findLatestParseError(parseErrorsDir, sessionId);
    let reason: string;
    if (reports.length === 0) {
      reason = `no reports found at ${reportsDir}`;
      if (latestParseError) {
        reason += `; latest parse-error at ${latestParseError.filePath}: ${latestParseError.summary}`;
      }
    } else {
      reason = `no report matched session_id=${sessionId} (${reports.length} report(s) for other sessions)`;
    }
    persistedReport = { ok: false, reason };
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

  // Drop the staging file once we have consumed it AND the canonical
  // (marker) write landed, so a later arg-less `harness approve` cannot
  // revive this id. A failed marker write keeps the file so the operator
  // can retry; an id supplied by flag/env was never "ours" to clean up.
  if (sessionSource === "pending-approval" && markerResult.ok) {
    clearPendingApproval(generatedDir);
  }

  return {
    sessionId,
    sessionSource,
    marker: markerResult,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
    persistedReport,
  };
}
