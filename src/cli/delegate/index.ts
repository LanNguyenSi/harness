// `harness delegate`: slice 3 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// ("`claude -p` child processes", "Delegation marker shape", "TTL, cwd,
// and subagents"), acceptance criterion 1.
//
// Issues a signed delegation for a headless `claude -p` child session,
// bound to an already-approved PARENT session. The delegation is a
// PRE-AUTHORIZATION, not an approval (key one of the ADR's two-key
// design): it supplies the trusted signal and the parent linkage; the
// child's own Understanding Report (key two) is still checked, and its
// auto-marker still minted, by the child's own PreToolUse hook: nothing
// here opens a gate.
//
// `issueDelegation` is an in-process function, never calling
// `process.exit`, so the smoke runner (a future consumer, ADR "TTL, cwd,
// and subagents": "The harness smoke runner ... is the natural first
// consumer") and tests can call it directly. The CLI wiring in
// `src/cli/index.ts` is a thin wrapper: flag parsing, one CLI-level
// usage check with the exact ADR-specified message, and printing the
// result in the approve CLI's line style.
//
// PARENT SESSION RESOLUTION mirrors `harness approve understanding`
// exactly (flag > $CLAUDE_CODE_SESSION_ID > $CLAUDE_SESSION_ID >
// $CODEX_SESSION_ID > staged .pending-approval), via the same
// `resolveApprovalSessionId` helper, with NO newest-report fallback
// (delegation has no report of its own to guess a session from).
//
// LEDGER SOURCE: the ledger fact this verb writes uses its own source
// tag `harness-delegate-cli` (ADR "Audit and doctor"), distinct from
// `harness approve understanding`'s `harness-approve-understanding`.
// Reused directly: the approve CLI's `writeLedgerTag` now takes `source`
// as an additive parameter (default unchanged, so `approveUnderstanding`'s
// own call is unaffected) so this verb does not re-implement the same
// findGroundingMcp + addLedgerFact shape `branch-protection.ts` already
// carries its own independent copy of. `--approved-by` overrides the
// ledger source when the operator wants to distinguish which actor/script
// issued a given delegation in the audit trail; omitted, it defaults to
// exactly `harness-delegate-cli`, matching the ADR's fixed tag when the
// flag is not used. There is no signed field for an actor name: the
// delegation's signed `approvedBy` string is the packed
// `delegated:<parent>;cwd=...;task=...;expires=...` tuple
// (delegation-markers.ts), which has no room for one, and the ADR rules
// out adding a new signed field (a `SIGNING_ALG` bump).
//
// REPORT FALLBACK (`--report <path>`): binds the launcher-supplied
// report by BOTH its content (`reportContentHash`) and its path
// (`reportPathHash`, via the same `hashDelegationCwd` the cwd binding
// uses, so both sides of the delegation hash paths the same way).

import { sha256Hex, signingKeyExists, signingKeyPathFor } from "../../runtime/approval-signing.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import { resolveApprovalSessionId } from "../../runtime/session-id.js";
import {
  checkApprovalMarker,
  hashDelegationCwd,
  parseApprovalLifecycle,
  writeDelegationMarker,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  type ModeConfigSource,
  PACK_NAME as UNDERSTANDING_PACK_NAME,
} from "../../policy-packs/builtin/understanding-before-execution.js";
import { readRegularFileRejectingSymlink } from "../../io/read-regular-file.js";
import type { Manifest } from "../../schema/index.js";
import { writeLedgerTag } from "../approve/understanding.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";

/** Default delegation lifetime when neither `--ttl` nor the pack's `approval_lifecycle.max_age` is set (ADR "TTL, cwd, and subagents"). */
export const DEFAULT_DELEGATION_TTL_SECONDS = 3600;

/** Default ledger `source` tag for the audit-only fact this verb writes (ADR "Audit and doctor"). */
export const DEFAULT_DELEGATE_LEDGER_SOURCE = "harness-delegate-cli";

/** Same 8-4-4-4-12 hex shape the session-id helpers already validate a Claude Code session id against (`session-id.ts`'s `SESSION_TRANSCRIPT_RE`), case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact usage message the ADR pins for a delegation with no binding (AC 1). Shared so the CLI's early usage check and this function's own refusal read identically. */
export const NO_BINDING_MESSAGE = "a delegation must bind a cwd or a task";

export interface IssueDelegationOptions extends LoaderOptions {
  /** Session id of the `claude -p` child this delegation authorizes. Must be a UUID (case-insensitive). */
  childSessionId: string;
  /** Bind the delegation to this working directory. At least one of `cwd` / `taskId` is required. */
  cwd?: string;
  /** Bind the delegation to this agent-tasks task id. At least one of `cwd` / `taskId` is required. */
  taskId?: string;
  /** Delegation lifetime in seconds (already parsed, e.g. via `parseDurationSeconds`). Default: the applied pack's `approval_lifecycle.max_age` when set, else {@link DEFAULT_DELEGATION_TTL_SECONDS}. */
  ttlSeconds?: number;
  /** Fallback shape: path to the launcher-supplied Understanding Report file, bound by content AND path hash. */
  reportPath?: string;
  /** Explicit parent session id. Resolved exactly like `harness approve understanding` (flag > env > `.pending-approval`; no newest-report fallback) when omitted. */
  parentSessionId?: string;
  /** Override `harness.generated/` (test injection). */
  generatedDir?: string;
  /** Ledger `source` tag override (default {@link DEFAULT_DELEGATE_LEDGER_SOURCE}). */
  approvedBy?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Override the ledger writer (test). */
  ledgerAdd?: (
    sessionId: string,
    content: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type IssueDelegationRefusalReason =
  | "invalid-child-session"
  | "no-binding"
  | "parent-session-unresolved"
  | "parent-marker-missing"
  | "parent-marker-forged"
  | "parent-marker-expired"
  | "signing-key-absent"
  | "report-unreadable"
  | "write-failed";

export type IssueDelegationResult =
  | {
      ok: true;
      filePath: string;
      parentSessionId: string;
      childSessionId: string;
      expiresAt: string;
      /** `written: false` is audit-only degradation (ADR: "failure to write the fact is one stderr line, never a refusal"); the delegation itself is still minted. */
      ledgerFact: { written: boolean; reason?: string };
    }
  | { ok: false; reason: IssueDelegationRefusalReason; detail: string };

/** The `understanding-delegated:<child-sid>:<parent-sid>` ledger fact content (ADR "Audit and doctor"). */
export function delegationLedgerFactFor(childSessionId: string, parentSessionId: string): string {
  return `understanding-delegated:${childSessionId}:${parentSessionId}`;
}

/**
 * Issue a signed delegation marker for a `claude -p` child session. Never
 * calls `process.exit`; every failure mode is a `{ ok: false }` result
 * with a distinct `reason` (ADR slice plan format rule: every refusal is
 * a block with a distinct diagnostic, never a fall-through to allow).
 */
export async function issueDelegation(
  opts: IssueDelegationOptions,
): Promise<IssueDelegationResult> {
  if (!UUID_RE.test(opts.childSessionId)) {
    return {
      ok: false,
      reason: "invalid-child-session",
      detail: `--child-session must be a UUID (8-4-4-4-12 hex, case-insensitive): got ${JSON.stringify(
        opts.childSessionId,
      )}`,
    };
  }

  if (opts.cwd === undefined && opts.taskId === undefined) {
    return { ok: false, reason: "no-binding", detail: NO_BINDING_MESSAGE };
  }

  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: resolvePaths(opts).base,
    });

  // Signing-key precheck FIRST, before resolving or checking the parent
  // marker at all. `checkApprovalMarker`'s own read path (via
  // `verifyMarkerSignature` -> `getOrCreateSigningKey`) self-heals a
  // missing key by CREATING one as a side effect of verification, that
  // is correct for the gate's read side (delegation-markers.ts's own
  // doc comment on `verifyDelegation` explains why), but it would mean
  // this precheck could never observe a genuinely absent key if it ran
  // after the parent-marker check: by the time that check returns, a
  // key would already exist again. Checking here, before either
  // resolveApprovalSessionId or checkApprovalMarker touches the
  // filesystem, is what keeps "no operator signing key" a real,
  // independently reachable refusal rather than one only writeDelegationMarker's
  // own (necessarily later) precheck could ever see.
  if (!signingKeyExists(generatedDir)) {
    return {
      ok: false,
      reason: "signing-key-absent",
      detail: `no operator signing key at ${signingKeyPathFor(
        generatedDir,
      )}; refusing to delegate (key creation is an operator-side act, never a side effect of delegating)`,
    };
  }

  // Parent session resolution: exactly the `harness approve
  // understanding` precedence chain (flag > $CLAUDE_CODE_SESSION_ID >
  // $CLAUDE_SESSION_ID > $CODEX_SESSION_ID > staged .pending-approval),
  // with NO 6th-tier newest-report fallback: a delegation has no report
  // of its own to guess a parent session from, and guessing the PARENT
  // wrong here would mint a pre-authorization under the wrong identity.
  const resolvedParent = resolveApprovalSessionId({
    session: opts.parentSessionId,
    generatedDir,
  });
  const parentSessionId = resolvedParent.sessionId;
  if (parentSessionId === "") {
    return {
      ok: false,
      reason: "parent-session-unresolved",
      detail:
        "no parent session id available. Pass --session-id <id>, or set one of " +
        "$CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID / $CODEX_SESSION_ID, or run " +
        "`harness preflight` (or trip the gate once) so harness.generated/.pending-approval is staged.",
    };
  }

  // Manifest: best-effort, exactly like the approve CLI. A load failure
  // here degrades the TTL default (falls back to the hardcoded default
  // below) and the ledger write (audit-only, never a refusal) but never
  // blocks issuing the delegation itself.
  let manifest: Manifest | null = null;
  let manifestLoadError: string | null = null;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch (err) {
    manifestLoadError = err instanceof Error ? err.message : String(err);
  }

  const declaredPack: ModeConfigSource = manifest?.policy_packs.find(
    (p) => p.name === UNDERSTANDING_PACK_NAME && p.enabled !== false,
  ) ?? { name: UNDERSTANDING_PACK_NAME, config: {} };
  const lifecycle = parseApprovalLifecycle(
    (declaredPack.config as Record<string, unknown>)["approval_lifecycle"],
  );

  // Key one of the ADR's two-key design: the parent must already carry a
  // valid, unexpired, signed approval marker. Same check the gate itself
  // runs (`checkApprovalMarker`), same `max_age` bound.
  const parentCheck = checkApprovalMarker(generatedDir, parentSessionId, {
    ...(lifecycle.maxAgeMs !== undefined ? { maxAgeMs: lifecycle.maxAgeMs } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (!parentCheck.matched) {
    const reason: IssueDelegationRefusalReason = parentCheck.forged
      ? "parent-marker-forged"
      : parentCheck.expired
        ? "parent-marker-expired"
        : "parent-marker-missing";
    return { ok: false, reason, detail: parentCheck.detail };
  }

  const now = opts.now ?? new Date();
  const ttlSeconds =
    opts.ttlSeconds ??
    (lifecycle.maxAgeMs !== undefined
      ? Math.round(lifecycle.maxAgeMs / 1_000)
      : DEFAULT_DELEGATION_TTL_SECONDS);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();

  // Fallback shape: bind the launcher-supplied report by BOTH its
  // content and its path (delegation-markers.ts, "Delegation marker
  // shape" table: half a binding is worse than none).
  let reportPathHash: string | undefined;
  let reportContentHash: string | undefined;
  if (opts.reportPath !== undefined) {
    const read = readRegularFileRejectingSymlink(opts.reportPath);
    if (read.kind !== "ok") {
      return {
        ok: false,
        reason: "report-unreadable",
        detail: `--report ${opts.reportPath} could not be read (${read.kind})`,
      };
    }
    reportContentHash = sha256Hex(read.content);
    reportPathHash = hashDelegationCwd(opts.reportPath);
  }

  const cwdHash = opts.cwd !== undefined ? hashDelegationCwd(opts.cwd) : null;
  const taskId = opts.taskId !== undefined ? opts.taskId : null;

  const writeResult = writeDelegationMarker({
    generatedDir,
    childSessionId: opts.childSessionId,
    parentSessionId,
    cwdHash,
    taskId,
    expiresAt,
    ...(reportPathHash !== undefined ? { reportPathHash } : {}),
    ...(reportContentHash !== undefined ? { reportContentHash } : {}),
    now,
  });
  if (!writeResult.ok) {
    if (writeResult.reason === "signing-key-absent") {
      return { ok: false, reason: "signing-key-absent", detail: writeResult.detail };
    }
    // "invalid-input" is not expected to be reachable here: every input
    // writeDelegationMarker validates (parentSessionId non-empty, cwdHash
    // a sha256, taskId not the reserved "-" literal, expiresAt ISO) is
    // already well-formed by construction above. Mapped to the closest
    // fitting refusal reason rather than left uncovered, so a future
    // regression there still fails closed with a diagnostic instead of
    // an uncaught type mismatch.
    return { ok: false, reason: "write-failed", detail: writeResult.detail };
  }

  const ledgerContent = delegationLedgerFactFor(opts.childSessionId, parentSessionId);
  const ledgerSource = opts.approvedBy ?? DEFAULT_DELEGATE_LEDGER_SOURCE;
  let ledgerResult: { ok: true } | { ok: false; reason: string };
  if (opts.ledgerAdd) {
    ledgerResult = await opts.ledgerAdd(opts.childSessionId, ledgerContent);
  } else if (manifest) {
    ledgerResult = await writeLedgerTag(
      manifest,
      opts.childSessionId,
      ledgerContent,
      {},
      ledgerSource,
    );
  } else {
    ledgerResult = {
      ok: false,
      reason: manifestLoadError
        ? `manifest unreadable (${manifestLoadError}); skipped ledger write`
        : "manifest unreadable; skipped ledger write",
    };
  }

  return {
    ok: true,
    filePath: writeResult.filePath,
    parentSessionId,
    childSessionId: opts.childSessionId,
    expiresAt,
    ledgerFact: ledgerResult.ok
      ? { written: true }
      : { written: false, reason: ledgerResult.reason },
  };
}
