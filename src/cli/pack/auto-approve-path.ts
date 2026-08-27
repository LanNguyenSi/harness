// Step 9 of the understanding-gate PreToolUse decision order: the
// operator-opt-in auto-approval attempt (agent-tasks/74b4b17d, slice 1 of
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Option A").
//
// WHERE THIS RUNS, AND WHY IT MATTERS. `hook-pre-tool-use.ts` calls
// `attemptAutoApproval` on a call that EVERY branch above it has already
// declined: the signed-marker check (step 3), the read-only Bash
// exemption (step 6), the recovery-commit exemption (step 7) and the
// escape `ask` (step 8). So the auto path only ever acts on a call that
// would otherwise reach the final block. Three consequences the ADR's
// decision-order table spells out: the session's first `ls` or `git
// status` mints nothing, `max_age` starts counting from the call that
// actually needed an approval, and a bare `harness approve understanding`
// keeps whatever the interactive prompt resolves it to. The negative
// controls in tests/cli/pack-hook-pre-tool-use-auto-approve.test.ts pin
// that ordering; moving this call site up is a mutation those tests
// catch.
//
// WHAT IT IS NOT. This function never returns an allow of its own. On
// success it consumes the report, writes the signed SESSION marker
// through the same `writeApprovalMarker` path `harness approve
// understanding` uses, records an audit-only ledger fact, and then
// re-runs `checkOperatorApprovalMarkers` — that re-check, and nothing
// else, is what produces the allow. The gate's decision input stays
// exactly one signed marker (invariant 1). Every failure returns
// `approved: false` and the caller falls through to the existing final
// block with step 3's `markerExpired` / `markerForged` intact.
//
// FAIL CLOSED ON EVERY MISSING INPUT. Absent opt-in, unlisted
// `permission_mode`, a forged marker already detected at step 3, a
// payload/environment session-id disagreement, a missing signing key, a
// missing / already-consumed / foreign / invalid report: each one
// declines with one stderr line and no write.

import * as fs from "node:fs";
import {
  autoApprovedByFor,
  autoApprovedLedgerTagFor,
  CLAUDE_CODE_HARNESS,
  checkOperatorApprovalMarkers,
  listPersistedReports,
  parseAutoApprove,
  permissionModeAllowed,
  selectNewestStrictSessionReport,
  writeApprovalMarker,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { sha256Hex, signingKeyExists } from "../../runtime/approval-signing.js";
import {
  clearPendingApproval,
  readPendingApproval,
} from "../../runtime/pending-approval.js";
import type { LedgerWriteFn } from "../../runtime/ledger-writer.js";
import { rewriteReportApproved, validatePersistedReport } from "../approve/understanding.js";

/** Source string recorded on the audit-only ledger fact. */
export const AUTO_APPROVE_LEDGER_SOURCE = "harness-pack-hook-pre-tool-use";

export interface AutoApproveAttemptArgs {
  /** `harness.generated/`; `undefined` when it could not be resolved (injected-manifest test path). */
  generatedDir: string | undefined;
  /** The hook's resolved session id (equals `payloadSessionId` on every path that can succeed). */
  sessionId: string;
  /** RAW `session_id` from the event payload — NOT the env fallback (hardening item 1). */
  payloadSessionId: unknown;
  /** RAW `permission_mode` from the event payload. */
  permissionMode: unknown;
  /** The pack's `config` block, unparsed. */
  packConfig: unknown;
  /** Persisted-report directory. */
  reportsDir: string;
  /** Step 3's verdict: a marker FILE existed and failed signature verification. */
  markerForged: boolean;
  stderr: { write(s: string): void };
  /**
   * Audit-only ledger writer, resolved LAZILY: called only after the
   * opt-in (`auto_approve` parses) and the `when` allowlist have both
   * passed, i.e. only on a call that could actually reach the ledger
   * write later in this function. Every earlier decline (opt-in absent,
   * mode not allowlisted, forged marker, session mismatch, key absent,
   * report not eligible) never invokes this thunk, so an unconfigured or
   * expensive ledger resolution costs nothing on the overwhelming
   * majority of gated calls that never opted in. `write: null` means
   * the ledger is unreachable (no `grounding-mcp` in the manifest, or
   * the caller chose not to resolve one); the auto path then logs one
   * line and continues. The ledger is never a gate input.
   */
  resolveLedger: () => { write: LedgerWriteFn | null; reason?: string };
}

export type AutoApproveAttempt =
  | {
      approved: true;
      /** `checkOperatorApprovalMarkers` detail for the freshly written marker. */
      detail: string;
      /** `auto-mode:claude-code:<mode>` as written into the signed marker. */
      approvedBy: string;
      markerPath: string;
      reportPath: string;
      reportContentHash: string;
    }
  | { approved: false; reason: string };

function decline(reason: string): AutoApproveAttempt {
  return { approved: false, reason };
}

/**
 * Attempt the operator-opted-in auto-approval for this PreToolUse call.
 * See the module header for placement and the fail-closed contract; the
 * numbered steps below are conditions 1-6 of the ADR's Option A.
 */
export async function attemptAutoApproval(
  args: AutoApproveAttemptArgs,
): Promise<AutoApproveAttempt> {
  const { stderr } = args;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook: ${msg}\n`);
  };

  // (1) Opt-in. Absent is the ordinary case and stays SILENT; a
  // malformed block already wrote its own single line inside
  // `parseAutoApprove` (fail-closed: malformed means "not opted in",
  // never a partial default).
  const packConfigObj =
    args.packConfig !== null && typeof args.packConfig === "object" && !Array.isArray(args.packConfig)
      ? (args.packConfig as Record<string, unknown>)
      : {};
  const cfg = parseAutoApprove(packConfigObj["auto_approve"], stderr);
  if (cfg === null) return decline("auto_approve not configured");

  // (2) `when` allowlist, exact string equality against the payload
  // literal (hardening item 2). Absent / empty / unlisted is the normal
  // case for an opted-in repo whose session simply runs in a prompting
  // mode, and it fires on EVERY such call once the opt-in is present, so
  // this stays SILENT (no stderr line): a per-call note here would echo
  // the configured `auto_approve.when` allowlist to stderr on every
  // ordinary prompting-mode call (reviewer round-1 finding).
  const mode = args.permissionMode;
  if (!permissionModeAllowed(cfg, mode)) {
    return decline("permission_mode not in auto_approve.when");
  }
  const modeStr = mode as string;

  // Resolve the audit-only ledger writer NOW, not earlier: this is the
  // first point past both the opt-in check (1) and the `when` allowlist
  // check (2), so `args.resolveLedger` runs only on a call that has an
  // actual chance of reaching the ledger write below, never on the
  // overwhelming majority of gated calls that are not opted in or run in
  // an unlisted permission mode.
  const ledger = args.resolveLedger();

  // (3) A forgery detected at step 3 is never laundered into an
  // approval (ADR condition 6). Declining also leaves the forged FILE and
  // its distinct `forged/unsigned marker rejected` diagnostic on disk —
  // `writeApprovalMarker` would atomically overwrite that exact path.
  if (args.markerForged) {
    note("auto-approval declined: forged/unsigned marker present");
    return decline("forged marker present");
  }

  // (4) Session consistency (hardening item 1): the PAYLOAD's own
  // `session_id` must be present and must equal the hook process's
  // `$CLAUDE_CODE_SESSION_ID`. Compared against the payload field
  // specifically, never the hook's env-fallback-resolved id, or the
  // check would compare the environment with itself.
  const payloadSid =
    typeof args.payloadSessionId === "string" && args.payloadSessionId.length > 0
      ? args.payloadSessionId
      : null;
  if (payloadSid === null) {
    note("auto-approval declined: event payload carries no session_id");
    return decline("no payload session_id");
  }
  const envSid = process.env.CLAUDE_CODE_SESSION_ID;
  if (typeof envSid !== "string" || envSid.length === 0) {
    note("auto-approval declined: $CLAUDE_CODE_SESSION_ID is not set in the hook environment");
    return decline("no CLAUDE_CODE_SESSION_ID");
  }
  if (envSid !== payloadSid) {
    note(
      "auto-approval declined: payload session_id does not match $CLAUDE_CODE_SESSION_ID in the hook environment",
    );
    return decline("session id mismatch");
  }

  // (5) Key precheck BEFORE any write (hardening item 5). The shared
  // write path would otherwise mint the key it is supposed to require:
  // `writeApprovalMarker` -> `signMarker` -> `getOrCreateSigningKey`
  // generates one on ENOENT. Key creation stays an operator-side act.
  if (args.generatedDir === undefined) {
    note("auto-approval declined: harness.generated/ could not be resolved");
    return decline("generatedDir unresolvable");
  }
  const generatedDir = args.generatedDir;
  if (!signingKeyExists(generatedDir)) {
    note("auto-approval declined: signing key absent (never created by the hook)");
    return decline("signing key absent");
  }

  // (6) The report precondition: the NEWEST strict-session report, and
  // only that one, must be exactly `pending`, parse, and pass the
  // approve CLI's own content validation.
  const newest = selectNewestStrictSessionReport(
    listPersistedReports(args.reportsDir),
    args.sessionId,
  );
  if (newest === null) {
    note(`auto-approval declined: no persisted report bound to session ${args.sessionId}`);
    return decline("no report for session");
  }
  if (newest.approvalStatus !== "pending") {
    note(
      `auto-approval declined: newest report for session ${args.sessionId} is approvalStatus=${
        newest.approvalStatus ?? "<missing>"
      }, not pending`,
    );
    return decline("newest report not pending");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(newest.filePath, "utf8");
  } catch (err) {
    note(`auto-approval declined: report unreadable (${(err as Error).message})`);
    return decline("report unreadable");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    note(`auto-approval declined: report invalid (unparseable JSON: ${(err as Error).message})`);
    return decline("report unparseable");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    note("auto-approval declined: report invalid (body is not a JSON object)");
    return decline("report not an object");
  }
  const validation = validatePersistedReport(parsed);
  if (!validation.ok) {
    note(`auto-approval declined: report invalid (${validation.field}: ${validation.reason})`);
    return decline(`report invalid: ${validation.field}`);
  }

  // Success sequence. `reportContentHash` binds the bytes as they were
  // BEFORE the approval rewrite, exactly as the approve CLI computes it.
  const reportContentHash = sha256Hex(raw);
  const approvedAt = new Date().toISOString();
  const approvedBy = autoApprovedByFor(CLAUDE_CODE_HARNESS, modeStr);

  // CONSUME FIRST, then sign. If the marker write fails after this, the
  // report is spent and no marker exists: the call blocks and the same
  // report can never mint again. The reverse order would leave a
  // still-`pending` report behind a failed write, i.e. a report that is
  // mintable on the very next call — the direction this design refuses.
  try {
    rewriteReportApproved(newest.filePath, approvedAt, approvedBy, args.sessionId);
  } catch (err) {
    note(`auto-approval declined: could not consume the report (${(err as Error).message})`);
    return decline("report consumption failed");
  }

  let markerPath: string;
  try {
    markerPath = writeApprovalMarker(generatedDir, args.sessionId, {
      approvedAt,
      approvedBy,
      reportContentHash,
    });
  } catch (err) {
    note(
      `auto-approval declined: failed to write the approval marker (${(err as Error).message}); the report was consumed, so this session needs a fresh report`,
    );
    return decline("marker write failed");
  }

  // Audit-only ledger fact. Never a gate input, so every failure here is
  // one stderr line and nothing more.
  const tag = autoApprovedLedgerTagFor(args.sessionId);
  if (ledger.write === null) {
    note(
      `auto-approval ledger fact ${tag} not recorded (${
        ledger.reason ?? "ledger writer unavailable"
      }); audit only, continuing`,
    );
  } else {
    try {
      const result = await ledger.write({
        sessionId: args.sessionId,
        content: tag,
        source: AUTO_APPROVE_LEDGER_SOURCE,
      });
      if (!result.ok) {
        note(
          `auto-approval ledger fact ${tag} not recorded (${result.reason ?? "unknown error"}); audit only, continuing`,
        );
      }
    } catch (err) {
      note(
        `auto-approval ledger fact ${tag} not recorded (${(err as Error).message}); audit only, continuing`,
      );
    }
  }

  // Drop this session's `.pending-approval` staging entry (decision-order
  // table, step 9). It is tier 5 of the approve verbs' session
  // resolution and is otherwise cleared only by `harness approve
  // understanding`, which auto mode never runs — so leaving it would let
  // a later env-less operator `harness approve ...` resolve to this
  // already-auto-approved id. Only ever clears OUR OWN id.
  try {
    if (readPendingApproval(generatedDir) === args.sessionId) {
      clearPendingApproval(generatedDir);
    }
  } catch {
    /* best-effort; staging is not a gate input */
  }

  // The verdict comes from the same marker check every other approval
  // goes through — the auto path itself never allows.
  const recheck = checkOperatorApprovalMarkers(
    generatedDir,
    args.sessionId,
    args.packConfig,
    stderr,
  );
  if (!recheck.matched) {
    note(
      `auto-approval wrote a marker but the re-check did not match (${recheck.detail}); falling through to the block`,
    );
    return decline("post-write marker re-check did not match");
  }
  note(`auto-approved via session marker by ${approvedBy}`);
  return {
    approved: true,
    detail: recheck.detail,
    approvedBy,
    markerPath,
    reportPath: newest.filePath,
    reportContentHash,
  };
}
