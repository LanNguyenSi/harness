// Phase 7 #6 — `harness approve risk [--session <id>]` CLI verb.
//
// The operator's grant for a Risk Gate `require_approval` decision.
// When `harness policy intercept` blocks a risky action with outcome
// `require_approval`, the policy's `requires:` names a `risk-approved:
// ${SESSION_ID}` ledger tag; this verb writes that tag so the next
// evaluation of the same policy passes and the outcome becomes `allow`.
//
// Deliberately simpler than `harness approve understanding`: the Risk
// Gate's requires-evaluator reads the evidence ledger (it is the same
// Phase 4 evaluator), so an ordinary `ledger_add` entry IS the approval.
// There is no persisted-report flip and no filesystem marker — the
// ledger tag is the single source of truth, exactly as Phase 7's design
// (docs/risk-gate.md "Decision model") specifies. `agent-grounding`
// needs no change: it already stores arbitrary tags through `ledger_add`.

import { addLedgerFact } from "../../runtime/ledger-add.js";
import {
  readPendingApproval,
  resolveGeneratedDir,
} from "../../runtime/pending-approval.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";

export interface ApproveRiskOptions extends LoaderOptions {
  /** Explicit session id (overrides $CLAUDE_SESSION_ID / $CODEX_SESSION_ID). */
  session?: string;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Inject a manifest (test); bypasses `loadManifest`. */
  manifest?: Manifest;
  /** Override the ledger writer (test). */
  ledgerAdd?: (
    sessionId: string,
    content: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ApproveRiskResult {
  sessionId: string;
  /** Where `sessionId` came from — surfaced so the operator can sanity-check it. */
  sessionSource: "flag" | "env-claude" | "env-codex" | "pending-approval";
  ledger: { ok: boolean; tag: string; reason?: string };
}

const RISK_APPROVED_PREFIX = "risk-approved";

/** The evidence-ledger tag a Risk Gate `require_approval` policy consults. */
export function riskApprovedTagFor(sessionId: string): string {
  return `${RISK_APPROVED_PREFIX}:${sessionId}`;
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

async function writeLedgerTag(
  manifest: Manifest,
  sessionId: string,
  content: string,
  opts: ApproveRiskOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.ledgerAdd) return opts.ledgerAdd(sessionId, content);
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  // No `~` expansion here: `addLedgerFact` expands leading `~/` in every
  // command token itself, so a second pass would be dead work.
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  return addLedgerFact({
    mcpCommand: command,
    ...(server.env && { mcpEnv: server.env }),
    timeoutMs: server.health?.timeout_ms ?? 5_000,
    sessionId,
    content,
    source: "harness-approve-risk",
  });
}

/**
 * Resolve the target session id and write its `risk-approved:` ledger
 * tag. Session id precedence mirrors `harness approve understanding`
 * tiers 1-4: explicit `--session`, then `$CLAUDE_SESSION_ID`, then
 * `$CODEX_SESSION_ID`, then the `.pending-approval` file the gate hook
 * staged on its last block. There is no persisted-report tier-5 guess:
 * the Risk Gate produces no persisted reports.
 *
 * Throws `HarnessExitError(EX_FAIL)` when no session id can be resolved.
 * A degraded ledger (grounding-mcp absent / unreachable) is surfaced in
 * the result, not thrown — same best-effort contract as `approve
 * understanding`'s ledger write.
 */
export async function approveRisk(
  opts: ApproveRiskOptions = {},
): Promise<ApproveRiskResult> {
  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: resolvePaths(opts).base,
    });

  let sessionId = "";
  let sessionSource: ApproveRiskResult["sessionSource"] = "flag";
  if (typeof opts.session === "string" && opts.session.length > 0) {
    sessionId = opts.session;
    sessionSource = "flag";
  } else if (
    typeof process.env.CLAUDE_SESSION_ID === "string" &&
    process.env.CLAUDE_SESSION_ID.length > 0
  ) {
    sessionId = process.env.CLAUDE_SESSION_ID;
    sessionSource = "env-claude";
  } else if (
    typeof process.env.CODEX_SESSION_ID === "string" &&
    process.env.CODEX_SESSION_ID.length > 0
  ) {
    sessionId = process.env.CODEX_SESSION_ID;
    sessionSource = "env-codex";
  } else {
    const staged = readPendingApproval(generatedDir);
    if (staged !== null) {
      sessionId = staged;
      sessionSource = "pending-approval";
    }
  }

  if (sessionId === "") {
    throw new HarnessExitError(
      [
        "no session id available. Pass --session <id>, or set $CLAUDE_SESSION_ID / $CODEX_SESSION_ID.",
        "",
        "The understanding-gate PreToolUse hook and `harness preflight` both stage the",
        `session id in ${generatedDir}/.pending-approval, so an arg-less`,
        "`harness approve risk` works after either has fired. An empty result means",
        "neither has run for the current session yet.",
        "",
        "From inside the running agent you can also read the id directly:",
        "Claude Code exposes $CLAUDE_SESSION_ID; Codex exposes $CODEX_SESSION_ID.",
      ].join("\n"),
      EX_FAIL,
    );
  }

  // The manifest is needed only for the grounding-mcp command. If it
  // cannot load, the ledger write degrades to a surfaced warning rather
  // than aborting — the operator still learns the resolved session id.
  let manifest: Manifest | null = null;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch {
    /* swallow; ledger write becomes a degraded-ok */
  }

  const tag = riskApprovedTagFor(sessionId);
  const ledgerResult = manifest
    ? await writeLedgerTag(manifest, sessionId, tag, opts)
    : { ok: false as const, reason: "manifest unreadable; skipped ledger write" };

  return {
    sessionId,
    sessionSource,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
  };
}
