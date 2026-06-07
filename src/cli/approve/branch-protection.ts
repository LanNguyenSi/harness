// `harness approve branch-protection [--session <id>]` CLI verb.
//
// The operator's deliberate blessing of a protected-branch edit (version
// bumps, CI workflow patches, hotfixes) for one session. Audit finding
// #39: the old override was a `branch-protection-ack:` ledger tag, but the
// agent has direct `mcp__agent-grounding__ledger_add` access and could
// self-write that tag to bless its own edit. This verb instead writes the
// canonical operator-only approval MARKER under
// `harness.generated/.approvals/branch-protection-<sessionId>` (the same
// trust boundary the understanding gate uses: Edit / Write / Bash are all
// gated from writing there, and no configured MCP server exposes a
// filesystem write). The branch-protection blocker consults that marker.
//
// The `branch-protection-ack:<reason>` ledger row is still written, as a
// best-effort AUDIT echo only, so `harness audit` / forensics keep a trail
// of WHY the override fired. A degraded / absent grounding-mcp surfaces as
// a warning, never a hard failure: the marker is what unblocks the gate.

import {
  ACK_TAG_PREFIX,
  writeBranchProtectionMarker,
} from "../../policy-packs/builtin/branch-protection-runtime.js";
import { addLedgerFact } from "../../runtime/ledger-add.js";
import {
  readPendingApproval,
  resolveGeneratedDir,
} from "../../runtime/pending-approval.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";

export interface ApproveBranchProtectionOptions extends LoaderOptions {
  /** Explicit session id (overrides $CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID / $CODEX_SESSION_ID). */
  session?: string;
  /**
   * Free-form note recorded in the audit ledger tag
   * (`branch-protection-ack:<reason>`) so a later `harness audit` can read
   * WHY the override fired. Optional; defaults to a generic note.
   */
  reason?: string;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Override the actor recorded in the marker (default: harness-approve-cli). */
  approvedBy?: string;
  /** Inject a manifest (test); bypasses `loadManifest`. */
  manifest?: Manifest;
  /** Override the ledger writer (test). */
  ledgerAdd?: (
    sessionId: string,
    content: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ApproveBranchProtectionResult {
  sessionId: string;
  /** Where `sessionId` came from — surfaced so the operator can sanity-check it. */
  sessionSource:
    | "flag"
    | "env-claude-code"
    | "env-claude"
    | "env-codex"
    | "pending-approval";
  /**
   * Canonical gate-satisfying signal. `ok: false` means the marker file
   * could not be written (rare: fs permission, missing parent dir) and the
   * gate will still block on the next tool call. The CLI surfaces this as a
   * hard error so the operator does not think they approved when they didn't.
   */
  marker: { ok: true; filePath: string; approvedAt: string } | { ok: false; reason: string };
  /** Best-effort audit echo. Never affects the gate decision. */
  ledger: { ok: boolean; tag: string; reason?: string };
}

const DEFAULT_APPROVED_BY = "harness-approve-cli";
const DEFAULT_REASON = "operator branch-protection override";

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

/** The audit ledger tag content this verb records (best-effort only). */
export function branchProtectionAckTag(reason: string): string {
  return `${ACK_TAG_PREFIX}:${reason}`;
}

async function writeLedgerTag(
  manifest: Manifest,
  sessionId: string,
  content: string,
  opts: ApproveBranchProtectionOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.ledgerAdd) return opts.ledgerAdd(sessionId, content);
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  // No `~` expansion: `addLedgerFact` expands leading `~/` in every command
  // token itself, so a second pass would be dead work.
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  return addLedgerFact({
    mcpCommand: command,
    ...(server.env && { mcpEnv: server.env }),
    timeoutMs: server.health?.timeout_ms ?? 5_000,
    sessionId,
    content,
    source: "harness-approve-branch-protection",
  });
}

/**
 * Resolve the target session id, write its canonical override marker, and
 * record a best-effort audit ledger tag. Session id precedence mirrors
 * `harness approve risk` tiers 1-5: explicit `--session`, then
 * `$CLAUDE_CODE_SESSION_ID`, then `$CLAUDE_SESSION_ID` (legacy), then
 * `$CODEX_SESSION_ID`, then the `.pending-approval` file the gate hook
 * staged on its last block. There is no persisted-report tier: the
 * branch-protection gate produces no persisted reports.
 *
 * Throws `HarnessExitError(EX_FAIL)` when no session id can be resolved. A
 * marker write failure is surfaced in the result (not thrown) so the
 * operator still learns the resolved id; a degraded ledger is likewise
 * surfaced, never thrown.
 */
export async function approveBranchProtection(
  opts: ApproveBranchProtectionOptions = {},
): Promise<ApproveBranchProtectionResult> {
  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: resolvePaths(opts).base,
    });

  let sessionId = "";
  let sessionSource: ApproveBranchProtectionResult["sessionSource"] = "flag";
  if (typeof opts.session === "string" && opts.session.length > 0) {
    sessionId = opts.session;
    sessionSource = "flag";
  } else if (
    typeof process.env.CLAUDE_CODE_SESSION_ID === "string" &&
    process.env.CLAUDE_CODE_SESSION_ID.length > 0
  ) {
    sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    sessionSource = "env-claude-code";
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
        "no session id available. Pass --session <id>, or set one of",
        "$CLAUDE_CODE_SESSION_ID (Claude Code) / $CLAUDE_SESSION_ID (legacy) /",
        "$CODEX_SESSION_ID (Codex).",
        "",
        "The branch-protection PreToolUse hook and `harness preflight` both stage the",
        `session id in ${generatedDir}/.pending-approval, so an arg-less`,
        "`harness approve branch-protection` works after either has fired. An empty result",
        "means neither has run for the current session yet.",
        "",
        "From inside the running agent you can also read the id directly:",
        "Claude Code exposes $CLAUDE_CODE_SESSION_ID; Codex exposes $CODEX_SESSION_ID.",
      ].join("\n"),
      EX_FAIL,
    );
  }

  // Write the canonical marker first — it is what unblocks the gate.
  const approvedAt = (opts.now ?? new Date()).toISOString();
  const approvedBy = opts.approvedBy ?? DEFAULT_APPROVED_BY;
  let markerResult: ApproveBranchProtectionResult["marker"];
  try {
    const filePath = writeBranchProtectionMarker(generatedDir, sessionId, {
      approvedAt,
      approvedBy,
    });
    markerResult = { ok: true, filePath, approvedAt };
  } catch (err) {
    markerResult = {
      ok: false,
      reason: `failed to write approval marker: ${(err as Error).message}`,
    };
  }

  // Best-effort audit ledger echo. Loaded lazily so a missing / unparseable
  // manifest degrades the audit row to a warning rather than aborting the
  // marker-based approval.
  let manifest: Manifest | null = null;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch {
    /* swallow; ledger write becomes a degraded-ok */
  }
  const reason = opts.reason && opts.reason.trim().length > 0 ? opts.reason.trim() : DEFAULT_REASON;
  const tag = branchProtectionAckTag(reason);
  const ledgerResult = manifest
    ? await writeLedgerTag(manifest, sessionId, tag, opts)
    : { ok: false as const, reason: "manifest unreadable; skipped ledger write" };

  return {
    sessionId,
    sessionSource,
    marker: markerResult,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
  };
}
