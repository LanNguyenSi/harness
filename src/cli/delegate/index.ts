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
// LEDGER SOURCE: the ledger fact this verb writes uses its own fixed
// source tag `harness-delegate-cli` (ADR "Audit and doctor"), distinct
// from `harness approve understanding`'s `harness-approve-understanding`.
// Reused directly: the approve CLI's `writeLedgerTag` now takes `source`
// as an additive parameter (default unchanged, so `approveUnderstanding`'s
// own call is unaffected) so this verb does not re-implement the same
// findGroundingMcp + addLedgerFact shape `branch-protection.ts` already
// carries its own independent copy of. There is no actor field to stamp
// on a delegation and no `--approved-by` flag to override the source:
// the delegation's signed `approvedBy` string is the packed
// `delegated:<parent>;cwd=...;task=...;expires=...` tuple
// (delegation-markers.ts), which has no room for one, and the ADR rules
// out adding a new signed field (a `SIGNING_ALG` bump).
//
// REPORT FALLBACK (`--report <path>`): binds the launcher-supplied
// report by BOTH its content (`reportContentHash`) and its path
// (`reportPathHash`, via the same `hashDelegationCwd` the cwd binding
// uses, so both sides of the delegation hash paths the same way). The
// path bound is NOT the operator's original `--report` argument: this
// verb COPIES the file (mode 0600) to the conventional location
// `delegationReportPathFor` derives from the child session id
// (`harness.generated/.delegation-reports/<child-sid>.md`) and hashes
// THAT path instead. The child's PreToolUse hook has no channel to learn
// an arbitrary operator-chosen path, so binding the original path would
// leave the hook unable to derive it, exactly the gap agent-tasks
// 49d1ee41 closes; the conventional path is the one location both the
// writer here and the hook can compute from nothing but a session id.
// The copy step never silently overwrites a DIFFERENT file already
// staged there (see `report-conflict` below): the conventional location
// is per-child, not per-delegation, so re-delegating the same child with
// a changed report is a caller error to surface loudly, not a quiet
// clobber of whatever the hook may already be mid-verification against.

import { sha256Hex, signingKeyExists, signingKeyPathFor } from "../../runtime/approval-signing.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import { resolveApprovalSessionId } from "../../runtime/session-id.js";
import {
  checkApprovalMarker,
  delegationReportPathFor,
  hashDelegationCwd,
  parseApprovalLifecycle,
  writeDelegationMarker,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { readRegularFileRejectingSymlink } from "../../io/read-regular-file.js";
import type { Manifest } from "../../schema/index.js";
import { loadDeclaredUnderstandingPack, writeLedgerTag } from "../approve/understanding.js";
import { resolvePaths, type LoaderOptions } from "../loader.js";

/** Default delegation lifetime when neither `--ttl` nor the pack's `approval_lifecycle.max_age` is set (ADR "TTL, cwd, and subagents"). */
export const DEFAULT_DELEGATION_TTL_SECONDS = 3600;

/** Default ledger `source` tag for the audit-only fact this verb writes (ADR "Audit and doctor"). */
export const DEFAULT_DELEGATE_LEDGER_SOURCE = "harness-delegate-cli";

/** Ceiling for an explicit `--ttl` when the applied pack sets no `approval_lifecycle.max_age` (L4 fix, agent-tasks 37ad0b05: an unbounded `--ttl` would otherwise let a caller mint a delegation that outlives any lifetime the pack's own policy intends). */
export const MAX_DELEGATION_TTL_SECONDS = 24 * 60 * 60;

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
  /** Fallback shape: path to the launcher-supplied Understanding Report file. Copied to the conventional `harness.generated/.delegation-reports/<child-sid>.md` location (mode 0600) and bound by content AND that conventional path's hash; the child's PreToolUse hook reads it back from there. */
  reportPath?: string;
  /** Explicit parent session id. Resolved exactly like `harness approve understanding` (flag > env > `.pending-approval`; no newest-report fallback) when omitted. */
  parentSessionId?: string;
  /** Override `harness.generated/` (test injection). */
  generatedDir?: string;
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
  | "invalid-cwd"
  | "invalid-task"
  | "invalid-ttl"
  | "ttl-above-max-age"
  | "parent-session-unresolved"
  | "parent-marker-missing"
  | "parent-marker-forged"
  | "parent-marker-expired"
  | "signing-key-absent"
  | "report-unreadable"
  | "report-conflict"
  | "invalid-input"
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

/** Control characters rejected from a raw `--task` value, mirroring the `CONTROL_CHARS` check `delegation-markers.ts` already runs on `parentSessionId` (not exported, so mirrored rather than imported). */
const TASK_ID_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate a raw `--task` value before it ever reaches
 * `writeDelegationMarker` (L1 fix, agent-tasks 37ad0b05: an unvalidated
 * `--task` used to surface downstream as an opaque `write-failed`, or
 * silently rebind, depending on the value). Mirrors
 * `delegation-markers.ts`'s own (unexported) `rejectUnsafeSegmentValue`:
 * empty, or carrying a `;`/`=` segment delimiter, both corrupt the
 * packed `approvedBy` encoding, plus the reserved unbound literal
 * `"-"` (would silently round-trip as "no task bound") and a control
 * character. Returns a detail string on a rejected value, `null` on a
 * safe one.
 */
function validateTaskId(taskId: string): string | null {
  if (taskId.length === 0) {
    return "--task must not be empty";
  }
  if (taskId === "-") {
    return '--task must not be the reserved unbound literal "-"';
  }
  if (taskId.includes(";") || taskId.includes("=")) {
    return `--task must not contain a delegation-segment delimiter (";" or "="): ${JSON.stringify(taskId)}`;
  }
  if (TASK_ID_CONTROL_CHARS.test(taskId)) {
    return `--task must not contain a control character: ${JSON.stringify(taskId)}`;
  }
  return null;
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

  // L3 fix (agent-tasks 37ad0b05): an empty `--cwd` used to fall through
  // uncaught, and `hashDelegationCwd("")` -> `path.resolve("")` silently
  // rebinds it to the issuer's OWN cwd rather than refusing. Caught here,
  // alongside the no-binding check, before either value reaches a hash.
  if (opts.cwd !== undefined && opts.cwd.length === 0) {
    return {
      ok: false,
      reason: "invalid-cwd",
      detail:
        "--cwd must not be empty (an empty value would silently rebind to the issuer's own cwd via path.resolve)",
    };
  }
  if (opts.taskId !== undefined) {
    const taskError = validateTaskId(opts.taskId);
    if (taskError !== null) {
      return { ok: false, reason: "invalid-task", detail: taskError };
    }
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

  // Manifest: best-effort, exactly like the approve CLI (shared via
  // `loadDeclaredUnderstandingPack`, agent-tasks 37ad0b05). A load
  // failure here degrades the TTL default (falls back to the hardcoded
  // default below) and the ledger write (audit-only, never a refusal)
  // but never blocks issuing the delegation itself.
  const { manifest, manifestLoadError, declaredPack } = loadDeclaredUnderstandingPack(opts);
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
  // L2/L4 fix (agent-tasks 37ad0b05): an explicit `--ttl` is validated
  // and clamped BEFORE it can reach `expiresAt`. `ttlSeconds <= 0` (or
  // non-finite) used to mint a delegation that is already expired
  // (L2); an unbounded `--ttl` used to let a caller mint one that
  // outlives the applied pack's own `approval_lifecycle.max_age` (L4,
  // or the 24h default ceiling when the pack sets none). Only an
  // EXPLICIT `--ttl` is checked here: the computed default below (from
  // `max_age` or the hardcoded default) is by construction already
  // within whichever ceiling would apply to it.
  let ttlSeconds: number;
  if (opts.ttlSeconds !== undefined) {
    if (!Number.isFinite(opts.ttlSeconds) || opts.ttlSeconds <= 0) {
      return {
        ok: false,
        reason: "invalid-ttl",
        detail: `--ttl must resolve to a positive, finite number of seconds; got ${opts.ttlSeconds}`,
      };
    }
    const ceilingSeconds =
      lifecycle.maxAgeMs !== undefined
        ? Math.round(lifecycle.maxAgeMs / 1_000)
        : MAX_DELEGATION_TTL_SECONDS;
    if (opts.ttlSeconds > ceilingSeconds) {
      return {
        ok: false,
        reason: "ttl-above-max-age",
        detail:
          lifecycle.maxAgeMs !== undefined
            ? `--ttl (${opts.ttlSeconds}s) exceeds the applied pack's approval_lifecycle.max_age (${ceilingSeconds}s)`
            : `--ttl (${opts.ttlSeconds}s) exceeds the default ${ceilingSeconds}s (24h) ceiling; set approval_lifecycle.max_age to raise it`,
      };
    }
    ttlSeconds = opts.ttlSeconds;
  } else {
    ttlSeconds =
      lifecycle.maxAgeMs !== undefined
        ? Math.round(lifecycle.maxAgeMs / 1_000)
        : DEFAULT_DELEGATION_TTL_SECONDS;
  }
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();

  // Fallback shape: bind the launcher-supplied report by BOTH its
  // content and its path (delegation-markers.ts, "Delegation marker
  // shape" table: half a binding is worse than none). The path bound is
  // the CONVENTIONAL copy this verb writes, not the operator's original
  // `--report` argument (module header, "REPORT FALLBACK").
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

    // Stage the conventional copy the child's hook will read back from.
    // Never a silent overwrite: a DIFFERENT file already staged there
    // (a stale copy from an earlier `--report` targeting the same
    // child session id, or anything else) is a refusal, not a clobber.
    // An IDENTICAL file already staged there is left as-is (idempotent
    // re-delegation of the same child with the same report).
    const conventionalPath = delegationReportPathFor(generatedDir, opts.childSessionId);
    const existingAtConventional = readRegularFileRejectingSymlink(conventionalPath);
    if (existingAtConventional.kind === "symlink" || existingAtConventional.kind === "not-regular") {
      return {
        ok: false,
        reason: "report-conflict",
        detail: `${conventionalPath} exists and is not a plain file; refusing to write the launcher-supplied report through it`,
      };
    }
    if (existingAtConventional.kind === "unreadable") {
      return {
        ok: false,
        reason: "report-conflict",
        detail: `${conventionalPath} exists but could not be read (I/O error); refusing to overwrite it without first confirming its content matches`,
      };
    }
    if (existingAtConventional.kind === "ok" && existingAtConventional.content !== read.content) {
      return {
        ok: false,
        reason: "report-conflict",
        detail: `a different report is already staged at ${conventionalPath} for child session ${opts.childSessionId}; refusing to overwrite it (no silent overwrite). Remove it first if the new --report content is intentional.`,
      };
    }
    if (existingAtConventional.kind === "missing") {
      try {
        atomicWriteFile(conventionalPath, read.content, { mode: 0o600 });
      } catch (err) {
        return {
          ok: false,
          reason: "write-failed",
          detail: `could not stage the launcher-supplied report at ${conventionalPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
    // `existingAtConventional.kind === "ok"` with matching content:
    // already staged, nothing to write.

    reportPathHash = hashDelegationCwd(conventionalPath);
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
    if (writeResult.reason === "invalid-input") {
      // Reachable: a malformed raw parent session id (`--session-id`, or
      // a value read from $CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID /
      // $CODEX_SESSION_ID / a staged .pending-approval) still reaches
      // `buildDelegationApprovedBy`'s `rejectMalformedSessionId` /
      // `rejectUnsafeSegmentValue` checks on `parentSessionId`
      // unvalidated by this function. `--task` no longer reaches this
      // branch: its own value is now validated (the `invalid-task`
      // refusal above) before `writeDelegationMarker` is ever called.
      // Mapped to its own reason rather than folded into "write-failed",
      // so a malformed parent session id fails closed with a diagnostic
      // distinct from a genuine I/O write failure.
      return { ok: false, reason: "invalid-input", detail: writeResult.detail };
    }
    return { ok: false, reason: "write-failed", detail: writeResult.detail };
  }

  const ledgerContent = delegationLedgerFactFor(opts.childSessionId, parentSessionId);
  let ledgerResult: { ok: true } | { ok: false; reason: string };
  if (opts.ledgerAdd) {
    ledgerResult = await opts.ledgerAdd(opts.childSessionId, ledgerContent);
  } else if (manifest) {
    ledgerResult = await writeLedgerTag(
      manifest,
      opts.childSessionId,
      ledgerContent,
      {},
      DEFAULT_DELEGATE_LEDGER_SOURCE,
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
