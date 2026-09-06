// Builtin Policy Pack runtime: `solution-acceptance` (consumer half).
//
// The PRODUCER lives in grounding-mcp (`solution_evaluate` / `solution_gate`,
// @lannguyensi/grounding-mcp >= 0.3.2): it runs a real `preflight run --json`
// and records a HEAD-pinned verdict marker outside the agent-writable
// evidence ledger. harness is the CONSUMER: it reimplements the marker read +
// gate decision here so it carries NO grounding-mcp runtime dependency (the
// same precedent as understanding-before-execution reimplementing its
// approval-marker read). Schema parity with the producer is pinned by a
// golden-fixture test against a real 0.3.2 marker; if grounding-mcp changes
// the Verdict shape, that test fails loudly.
//
// grounding-mcp >= 0.5.0 additionally folds orchestrator-workflow (OW)
// process-completeness into the verdict's `ready`, surfacing any failure
// reasons through the EXISTING `blockers[]` (each prefixed
// `orchestrator-workflow: `). It adds NO new Verdict field — the seven keys
// in `Verdict` below are unchanged — so the consumer needs NO gate-logic
// change: `evaluateGate` already denies a not-ready verdict and already joins
// `blockers` into the deny reason, so OW reasons reach the agent for free.
// Markers from older producers (< 0.5.0) stay SHAPE-compatible and remain
// preflight-only (no OW arm); there is no hard incompatibility.
//
// Two enforcement surfaces are built on top of these helpers (see the pack
// definition + the two hook verbs):
//
//   1. completion-gate — denies the task-finishing tools (agent-tasks MCP
//      task_finish / task_submit_pr / task_merge / pull_requests_merge, plus
//      a belt-and-suspenders bash match for `git push` / `gh pr merge`)
//      unless a ready verdict exists at the CURRENT git HEAD.
//
//   2. write-guard — the actual anti-forgery closure. Relocating the verdict
//      dir is NOT sufficient: understanding-gate allows all Bash post-approval
//      (it does no write-target inspection in the allow path), so an approved
//      agent could otherwise hand-write a `ready:true` marker. The write-guard
//      blocks the agent's enumerated write paths into the verdict dir.
//
// Anti-forgery honesty (operator decision, 2026-05-30): v1 closed the
// ENUMERATED-WRITE-PATH residual (the Bash/Edit/Write spellings below), NOT
// arbitrary same-uid forgery. A `0500` chmod on the dir would be incoherent
// here because the producer (grounding-mcp) and the agent share a uid, so it
// would block the producer too.
//
// Content-authenticity (harness/c7c3f606): the verdict now carries an HMAC
// signature, reusing the SAME `signMarker` / `verifyMarkerSignature`
// primitive `src/runtime/approval-signing.ts` shipped for the
// understanding-gate / branch-protection markers (harness/f9485cc7) — same
// crypto, same operator-side key at `<generatedDir>/.approval-signing.key`,
// same fail-closed contract (missing/invalid signature = NOT satisfied,
// distinct `forged` reason, strict no-migration-window back-compat). See
// `verifyVerdictSignature` / `signVerdict` below for the payload mapping.
//
// HONEST RESIDUAL — this is consumer-side only (pattern + exemplar). Unlike
// the understanding-gate marker, harness does not write this one: the
// producer is `@lannguyensi/grounding-mcp`, a SEPARATE package/repo (see
// module doc above). No currently-released producer signs its output, so
// until a matching grounding-mcp release ships (a tracked cross-repo
// follow-up), EVERY verdict this consumer reads is "unsigned" and the
// completion-gate denies it — the SAME strict, no-grace-period POLICY
// f9485cc7 made (no unsigned marker satisfies the gate). The RECOVERY shape
// differs, though: f9485cc7's producer and consumer live in this one repo,
// so an operator hitting that denial has a local fix (`harness approve
// understanding` / `harness approve branch-protection`, one command, this
// release). Here the producer is a separate package on its own release
// cadence, so there is NO operator-side command that resolves the denial —
// re-running `solution_evaluate` today still yields an unsigned verdict.
// Operators running this pack should expect the completion-gate to deny
// universally until the grounding-mcp producer release ships; `harness
// pause` remains the operator override in the interim.
// Glob-every-segment / interpreter-runtime-path-construction spellings of
// the write-guard's residual (see below) are UNCHANGED by this: signing
// verifies content authenticity of whatever bytes land at the marker path,
// it does not additionally restrict which write primitives can reach that
// path (the write-guard already does that, separately, best-effort).

import * as os from "node:os";
import * as path from "node:path";
import { readRegularFileRejectingSymlink } from "../../io/read-regular-file.js";
import {
  sha256Hex,
  signMarker,
  verifyMarkerSignature,
  type SignatureVerification,
} from "../../runtime/approval-signing.js";
import {
  DEFAULT_PROTECTED_COMPLETION_TOOLS as ADAPTER_DEFAULT_PROTECTED_COMPLETION_TOOLS,
  resolveProtectedCompletionTools as resolveAdapterProtectedCompletionTools,
} from "../../runtime/task-providers/agent-tasks.js";
import type { PolicyPack } from "../../schema/index.js";

export const PACK_NAME = "solution-acceptance";

/**
 * agent-tasks MCP verbs that mark a completion boundary. The gate fires on
 * these (matched by exact tool name `mcp__agent-tasks__<verb>`). These MCP
 * choke points are reliable: unlike the bash matcher they cannot be evaded
 * by shell indirection.
 */
export const DEFAULT_PROTECTED_COMPLETION_TOOLS = ADAPTER_DEFAULT_PROTECTED_COMPLETION_TOOLS;

/**
 * Belt-and-suspenders bash matcher for `git push` / `gh pr merge`. Regex on
 * the typed command, so an env-var indirection
 * (`B=main && git push origin $B`) evades it — the MCP verbs above are the
 * load-bearing choke points; hardening this is follow-up `7207d8f9`.
 * Tolerates a leading `cd … &&`, inline `VAR=val` assignments, and `git -C
 * <path> push`.
 *
 * Task 76671e5a: bare `&` added to the boundary alternation (`&&` kept to
 * its left only to mirror `src/runtime/command-normalize.ts`'s alternation
 * order for readability — NOT because order is load-bearing here, unlike
 * that module). Same fix as `d834a065` applied to every policy trigger —
 * bash starts a new command after a single `&`, so `A=x&git push` used to
 * slip past this DENY matcher entirely. Broadening is the stricter direction
 * here (this gates completion actions, it is not an allow-list). Measured:
 * swapping to `&|&&` produces a byte-identical match set for this matcher
 * (a `RegExp.test` existential check over every start offset, not a
 * segmenter — the reasoning that makes order matter in
 * `command-normalize.ts`'s `BOUNDARY_RE`/`AMP_BOUNDARY_RE` does not transfer
 * to a plain `.test()` matcher like this one).
 */
export const DEFAULT_PUSH_BASH_RE =
  /(?:^|\n|;|\||&&|&|\()\s*(?:\w+=\S+\s+)*(?:git(?:\s+-C\s+\S+)?\s+push|gh\s+pr\s+merge)\b/;

/**
 * Resolve the completion verbs the gate fires on: the pack's
 * `config.protected_completion_tools` override, else the default set.
 * Always non-empty. Lives here (not in the pack module) so the
 * completion-gate hook can share it without importing the pack's zod
 * surface (mirrors `resolveProtectedBranches` in branch-protection-runtime).
 */
export function resolveProtectedCompletionTools(pack: PolicyPack): string[] {
  return resolveAdapterProtectedCompletionTools(
    (pack.config as Record<string, unknown>)["protected_completion_tools"],
  );
}

// ── Verdict marker contract (mirror of grounding-mcp solution-verdict.ts) ──

/**
 * The verdict marker the producer writes. Keep field-for-field with
 * grounding-mcp for the first 7 keys (golden-fixture-pinned below).
 *
 * `alg` / `signature` (harness/c7c3f606) are ADDITIVE and OPTIONAL: a
 * legacy / not-yet-updated producer omits them entirely (parsed as
 * `undefined`, never `null` — mirrors how `ApprovalMarker.reportContentHash`
 * distinguishes "absent" from an explicit empty value), and such a verdict
 * is REJECTED by `evaluateGate` (missing signature = forged/unsigned, fail
 * closed) rather than silently accepted. See the module doc for the
 * consumer-only / cross-repo-follow-up honesty.
 */
export interface Verdict {
  id: string;
  head: string;
  ready: boolean;
  confidence: number;
  blockers: string[];
  timestamp: string;
  source: string;
  /** Signature algorithm tag; only `SIGNING_ALG` (`src/runtime/approval-signing.ts`) verifies. */
  alg?: string;
  /** HMAC-SHA256 hex signature over the canonical identifying tuple (see `verifyVerdictSignature`). */
  signature?: string;
}

/**
 * Marker-id namespace the verdict's HMAC signature is bound to (mirrors
 * `BRANCH_PROTECTION_MARKER_PREFIX` in branch-protection-runtime.ts): a
 * validly-signed verdict for one id can never be replayed as a validly-
 * signed verdict — or a validly-signed understanding-gate / branch-
 * protection marker — for a different id, because `markerId` is bound into
 * the signed payload (`approval-signing.ts` `canonicalPayload`) and this
 * prefix keeps the three id spaces disjoint even where the raw ids
 * (task ids, session ids) could otherwise collide.
 */
export const VERDICT_MARKER_ID_PREFIX = "solution-verdict-";

/** The HMAC markerId for verdict `id` (NOT a filesystem path — see `verdictPathFor` for that). */
export function verdictMarkerId(id: string): string {
  return `${VERDICT_MARKER_ID_PREFIX}${id}`;
}

/**
 * Canonical JSON of the verdict fields the signature must bind BEYOND
 * `(markerId, timestamp, source)` — i.e. the fields `signMarker`'s fixed
 * `{approvedAt, approvedBy, reportContentHash}` shape has no dedicated slot
 * for. Reusing that slot for this hash (rather than forking the primitive
 * to add more parameters, per task scope) means `head` / `ready` /
 * `confidence` / `blockers` are ALL covered by the signature: mutating any
 * one of them after signing changes this hash and invalidates the
 * signature. Fixed key order makes this injective (same argument as
 * `canonicalPayload` in approval-signing.ts).
 */
function verdictContentHash(v: Pick<Verdict, "head" | "ready" | "confidence" | "blockers">): string {
  return sha256Hex(
    JSON.stringify({ head: v.head, ready: v.ready, confidence: v.confidence, blockers: v.blockers }),
  );
}

/**
 * Sign `verdict`, reusing `signMarker` (`src/runtime/approval-signing.ts`)
 * unmodified — same crypto as the understanding-gate / branch-protection
 * markers (harness/f9485cc7). Payload mapping mirrors the approval
 * marker's shape (`approvedAt`/`approvedBy`/`reportContentHash`) onto the
 * verdict's own fields:
 *   - `approvedAt` <- `verdict.timestamp` (when the attestation was made)
 *   - `approvedBy` <- `verdict.source` (what attests it, e.g. "preflight")
 *   - `reportContentHash` <- `verdictContentHash(verdict)` (binds
 *     head/ready/confidence/blockers, the fields signMarker's fixed shape
 *     has no dedicated slot for)
 *
 * NOT wired to any production write path in harness (harness is a pure
 * CONSUMER of this marker, see module doc) — exported as the pattern +
 * exemplar a grounding-mcp-side producer change reuses, and used directly
 * by this module's own tests to construct validly-signed fixtures.
 *
 * Load-bearing on the producer side: `signMarker` is called with
 * `verdictMarkerId(verdict.id)`, while the consumer (`verifyVerdictSignature`
 * below) verifies with `verdictMarkerId(id)` where `id` is the CALLER's id,
 * not `verdict.id`. Those two only agree when a mirroring producer sets
 * `verdict.id` to the EXACT id string the consumer looks the marker up by —
 * byte-identical, no trimming or case normalization on either side — and the
 * consumer additionally rejects outright when `verdict.id !== id` even if
 * the signature itself still verifies (belt-and-braces, see `evaluateGate`).
 */
export function signVerdict(generatedDir: string, verdict: Verdict): Verdict {
  const signed = signMarker(generatedDir, verdictMarkerId(verdict.id), {
    approvedAt: verdict.timestamp,
    approvedBy: verdict.source,
    reportContentHash: verdictContentHash(verdict),
  });
  return { ...verdict, alg: signed.alg, signature: signed.signature };
}

/**
 * Verify `verdict`'s signature, reusing `verifyMarkerSignature` unmodified.
 * Recomputes `verdictContentHash` from the (possibly tampered) verdict
 * being checked — the SAME name-mapping `signVerdict` uses — so any
 * post-signing edit to `head` / `ready` / `confidence` / `blockers` /
 * `timestamp` / `source` fails verification, not just an edit to
 * `signature` itself.
 *
 * `id` is the CALLER's id — the one `evaluateGate` is actually checking
 * (`readVerdict`'s lookup key) — NOT `verdict.id` (a field read back out of
 * the marker BODY, which is exactly the bytes an attacker controls when
 * copying a validly-signed marker verbatim onto a different id's path).
 * This mirrors the load-bearing invariant `approval-signing.ts`'s
 * `signMarker` doc states explicitly: "verification always recomputes the
 * HMAC using the id the caller is checking, NOT one read back out of the
 * marker body." Trusting `verdict.id` here would let a byte-for-byte copy
 * of one id's signed verdict pass verification under a DIFFERENT id's
 * request, because the copy's `signature` and its own (also-copied)
 * `verdict.id` field would always agree with each other regardless of which
 * id actually asked.
 */
export function verifyVerdictSignature(
  generatedDir: string,
  id: string,
  verdict: Verdict,
): SignatureVerification {
  return verifyMarkerSignature(generatedDir, verdictMarkerId(id), {
    approvedAt: verdict.timestamp,
    approvedBy: verdict.source,
    reportContentHash: verdictContentHash(verdict),
    alg: verdict.alg,
    signature: verdict.signature,
  });
}

/** Env knob that overrides the verdict directory (mirrors the producer). */
export const VERDICT_DIR_ENV = "SOLUTION_VERDICT_DIR";

/**
 * Env knob that supplies the verdict id for SOLO / non-agent-tasks sessions.
 * The completion-gate consults it ONLY when no agent-tasks `active-claim` is
 * recorded (resolution order: active-claim first, then this env, then
 * fail-closed), so a claimed session's id stays authoritative and cannot be
 * redirected by an env var. A sessionId fallback is intentionally still NOT a
 * source (the wrong-scope bug class understanding-gate closed).
 */
export const VERDICT_ID_ENV = "SOLUTION_VERDICT_ID";

/**
 * Stable tail of the default verdict dir. The write-guard's reference
 * detection matches on this so ANY spelling of the home prefix is caught
 * (`~/.local/state/...`, `$HOME/...`, `$XDG_STATE_HOME/...`, the literal
 * absolute path).
 */
export const VERDICT_DIR_TAIL = path.join("agent-grounding", "solution-verdicts");

/**
 * Resolve the verdict directory. Resolution order MUST match grounding-mcp's
 * `verdictDir()` so the consumer reads exactly where the producer writes
 * (operator decision B: both sides use the producer default; no apply-time
 * env threading, no divergence risk):
 *   1. SOLUTION_VERDICT_DIR
 *   2. $XDG_STATE_HOME/agent-grounding/solution-verdicts
 *   3. ~/.local/state/agent-grounding/solution-verdicts
 */
export function verdictDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env[VERDICT_DIR_ENV];
  if (override && override.trim().length > 0) return override;
  const xdg = env["XDG_STATE_HOME"];
  const base =
    xdg && xdg.trim().length > 0 ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "agent-grounding", "solution-verdicts");
}

/**
 * Reduce a verdict id to a single safe path segment. Mirrors the producer's
 * `sanitizeVerdictId`: non-portable chars collapse to `_`, `path.basename`
 * strips any residual separator (path-traversal guard), empty / dot-only ids
 * are rejected.
 */
export function sanitizeVerdictId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const base = path.basename(cleaned);
  if (base === "" || base === "." || base === "..") {
    throw new Error(`invalid verdict id: ${JSON.stringify(id)}`);
  }
  return base;
}

export function verdictPathFor(dir: string, id: string): string {
  return path.join(dir, `${sanitizeVerdictId(id)}.json`);
}

/**
 * Resolve the explicit verdict id from `SOLUTION_VERDICT_ID`, or null when it
 * is unset, blank, or not a safe single path segment. Validated through
 * `sanitizeVerdictId` so a traversal-y or empty value fails closed here
 * (returns null -> the gate denies) rather than reaching the marker read. This
 * is the solo / non-agent-tasks fallback the completion-gate uses only when no
 * active-claim is present.
 */
export function resolveExplicitVerdictId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[VERDICT_ID_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    sanitizeVerdictId(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * Read + validate the verdict marker for `id`, or null when it is absent,
 * unparseable, a symlink, or not a regular file. The symlink-rejecting read
 * is the shared `src/io/read-regular-file.ts` helper (same defense-in-depth
 * as `checkApprovalMarker` against a symlink planted at the marker path
 * pointing at agent-controlled content).
 */
export function readVerdict(dir: string, id: string): Verdict | null {
  let p: string;
  try {
    p = verdictPathFor(dir, id);
  } catch {
    return null; // invalid id
  }
  // Shared symlink-rejecting read (src/io/read-regular-file.ts); every
  // non-ok kind (missing / symlink / not-regular / unreadable) closes the
  // gate via null, matching the pre-extraction behavior.
  const read = readRegularFileRejectingSymlink(p);
  if (read.kind !== "ok") return null;
  try {
    const parsed = JSON.parse(read.content) as Partial<Verdict>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.head !== "string" ||
      typeof parsed.ready !== "boolean"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      head: parsed.head,
      ready: parsed.ready,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      source: typeof parsed.source === "string" ? parsed.source : "",
      // Optional (harness/c7c3f606): absent on a legacy/unsigned producer
      // marker. `evaluateGate` treats that absence as forged/unsigned, not
      // as a parse failure — the 7 fields above are still ALL a marker
      // needs to parse successfully; signing is a separate, later gate.
      alg: typeof parsed.alg === "string" ? parsed.alg : undefined,
      signature: typeof parsed.signature === "string" ? parsed.signature : undefined,
    };
  } catch {
    return null;
  }
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  verdict: Verdict | null;
  /**
   * True when `allowed` is false SPECIFICALLY because a verdict file
   * existed and parsed (the 7 producer keys), but carried a missing or
   * invalid HMAC signature (harness/c7c3f606), or a body that identifies a
   * different id than the one being checked (cross-id replay, see the
   * `verdict.id !== id` check below) — a legacy/not-yet-signing producer, a
   * marker planted through some write primitive the write-guard doesn't
   * enumerate, or content tampered/copied post-signing. Distinct from
   * `verdict === null` (no marker at all, `forged: false`), from a
   * signing-key I/O failure (fail-closed but NOT classified as forged,
   * mirroring `SignatureVerification`'s `kind: "key-unavailable"` — a
   * broken key file must not read as an active forgery attempt in audit
   * output), and from a verdict with NO `alg`/`signature` fields at all
   * whose `timestamp` / `source` also reads blank (fail-closed but NOT
   * classified as forged either — a legitimately malformed, never-signed
   * marker, not evidence of an attack; see the `MISSING_*_REASON` carve-out
   * below). That last carve-out is scoped tightly: a verdict that DOES carry
   * `alg`/`signature` but still hits the same blank-field reason IS
   * classified `forged: true` — a signed field reading blank only happens
   * via post-signing tampering, so it does not get the "legitimately
   * malformed" benefit of the doubt (review R2, closes an audit-fidelity
   * gap where a forger could blank a real signed verdict's `timestamp` to
   * suppress this tag while the block itself still held). `allowed` is
   * always false when `forged` is true.
   */
  forged: boolean;
}

// `verifyMarkerSignature` (`src/runtime/approval-signing.ts`, NOT modified by
// this module) returns these exact literal reason strings when `verdict`'s
// `timestamp` / `source` map onto an empty `approvedAt` / `approvedBy`. That
// check runs FIRST, before `verifyMarkerSignature` ever looks at `signature`
// itself — so it fires identically whether the verdict carries NO signature
// at all (a genuinely legacy/unsigned marker) OR carries a well-formed
// `alg`/`signature` pair that no longer matches because the blank field was
// introduced AFTER signing (a forger tampering a real signed verdict to
// suppress the forged tag: blank `timestamp`, and the "missing approvedAt"
// short-circuit means the tampered signature is never even compared).
// `evaluateGate` below carves out ONLY the first case (no signature/alg
// present at all — the same carve-out shape as `SignatureVerification`'s
// `kind: "key-unavailable"`); a verdict that carries a signature/alg but
// still hits this reason falls through to the generic `forged: true`
// bucket, because "signed, yet a signed field reads blank" is post-signing
// tampering by construction (harness/c7c3f606 review R2). Matched by exact
// string since `verifyMarkerSignature` has no `kind` tag for this case; if
// its wording ever changes, these two constants must move with it.
const MISSING_APPROVED_AT_REASON = "missing approvedAt";
const MISSING_APPROVED_BY_REASON = "missing approvedBy";

/**
 * Evaluate the gate for `id` at `currentHead`. First verifies the verdict's
 * HMAC signature (harness/c7c3f606, fail-closed — see `verifyVerdictSignature`);
 * a verdict that fails this is REJECTED before its `ready` / `head` fields
 * are ever trusted, with a distinct forged/unsigned reason so an
 * operator/auditor can tell that apart from the routine "not ready yet" or
 * "no verdict" cases. Signature verification needs `generatedDir` (the
 * harness `.generated/` dir holding the shared signing key, NOT the verdict
 * dir) — `undefined` when it could not be resolved, which fails closed with
 * its own distinct (non-forged) reason.
 *
 * `verifyVerdictSignature` is called with `id` — the CALLER's id, i.e. the
 * one this function is asked to check — not `verdict.id`. A SECOND,
 * belt-and-braces check below independently rejects `verdict.id !== id`:
 * even though the signature check alone already closes the cross-id-replay
 * hole (a byte-for-byte copy of a validly-signed verdict onto a different
 * id's path fails signature verification, because the markerId the
 * signature is bound to no longer matches `id`), the verdict body's `id`
 * field itself is NOT part of the signed payload (only `timestamp` /
 * `source` / the head-ready-confidence-blockers content hash are), so it
 * can drift from the id that was actually verified without invalidating an
 * otherwise-valid signature. This check makes that drift fail loudly too,
 * rather than silently ignoring an inconsistency in the body of a verdict
 * that otherwise passed.
 *
 * Once signed and identity-checked, mirrors grounding-mcp `evaluateGate`:
 * allow iff `verdict.ready === true` AND `verdict.head === currentHead`.
 * `confidence` is INFORMATIONAL ONLY and never gates — a `ready:true
 * confidence:0` verdict at HEAD passes — so the harness consumer stays
 * byte-parity with the producer's `solution_gate` for THAT decision.
 * Signature verification itself is NOT (yet) mirrored on the producer side
 * — see module doc, "HONEST RESIDUAL": grounding-mcp's own `solution_gate`
 * does not enforce this signature, only this harness consumer does, until a
 * matching producer release ships.
 */
export function evaluateGate(
  verdict: Verdict | null,
  currentHead: string | null,
  id: string,
  generatedDir: string | undefined,
): GateResult {
  if (!verdict) {
    return {
      allowed: false,
      reason: `no solution-acceptance verdict recorded for "${id}" (run mcp__grounding-mcp__solution_evaluate first)`,
      verdict: null,
      forged: false,
    };
  }
  if (generatedDir === undefined) {
    return {
      allowed: false,
      reason: `cannot resolve harness.generated/ to verify the solution-acceptance verdict signature for "${id}"; treating as unapproved`,
      verdict,
      forged: false,
    };
  }
  const verification = verifyVerdictSignature(generatedDir, id, verdict);
  if (!verification.ok) {
    if (verification.kind === "key-unavailable") {
      return {
        allowed: false,
        reason: `solution-acceptance verdict for "${id}" could not be verified: ${verification.reason}; treating as unapproved`,
        verdict,
        forged: false,
      };
    }
    if (
      (verification.reason === MISSING_APPROVED_AT_REASON ||
        verification.reason === MISSING_APPROVED_BY_REASON) &&
      verdict.signature === undefined &&
      verdict.alg === undefined
    ) {
      // Scoped (harness/c7c3f606 review R2 MED): the carve-out applies ONLY
      // to a verdict that carries NO signature/alg fields at all. A verdict
      // that DOES carry them but still hits this reason is not "legitimately
      // malformed" — it is a signature computed over content that now reads
      // blank, which only happens via post-signing tampering (the blank
      // field falls through to the generic forged:true branch below instead).
      return {
        allowed: false,
        reason:
          `solution-acceptance verdict for "${id}" is missing a required field (${verification.reason}); ` +
          `treating as unsigned, not forged (a legitimately malformed marker, re-run solution_evaluate)`,
        verdict,
        forged: false,
      };
    }
    return {
      allowed: false,
      reason:
        `forged/unsigned solution-acceptance verdict rejected for "${id}": ${verification.reason} ` +
        `(a producer that does not yet sign verdicts, or a marker written through an unguarded path)`,
      verdict,
      forged: true,
    };
  }
  if (verdict.id !== id) {
    return {
      allowed: false,
      reason:
        `forged/unsigned solution-acceptance verdict rejected for "${id}": verdict body identifies itself ` +
        `as "${verdict.id}" (cross-id replay of a validly-signed verdict, or a corrupted marker)`,
      verdict,
      forged: true,
    };
  }
  if (!verdict.ready) {
    const why = verdict.blockers.length > 0 ? `: ${verdict.blockers.join("; ")}` : "";
    return {
      allowed: false,
      reason: `solution-acceptance verdict for "${id}" is not ready${why} (fix, then re-run solution_evaluate)`,
      verdict,
      forged: false,
    };
  }
  if (!currentHead) {
    return {
      allowed: false,
      reason: `cannot resolve the current git HEAD to confirm the verdict for "${id}" is at HEAD`,
      verdict,
      forged: false,
    };
  }
  if (verdict.head !== currentHead) {
    return {
      allowed: false,
      reason: `stale solution-acceptance verdict for "${id}": recorded at ${verdict.head.slice(0, 7)}, current HEAD ${currentHead.slice(0, 7)} (re-run solution_evaluate after the rework)`,
      verdict,
      forged: false,
    };
  }
  return {
    allowed: true,
    reason: `solution-acceptance verdict for "${id}" is ready at HEAD ${currentHead.slice(0, 7)} (confidence ${Math.round(verdict.confidence * 100)}%)`,
    verdict,
    forged: false,
  };
}

// ── Write-guard target detection ──

/**
 * Is `target` inside `dir` after resolution? Used for the path-tool arm
 * (Write/Edit/MultiEdit/NotebookEdit `file_path`) and for a Bash shell whose
 * cwd is the protected dir. A relative `target` resolves against `cwd`
 * (falling back to process.cwd()).
 */
export function isInsideDir(target: string, dir: string, cwd?: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  const absDir = path.resolve(dir);
  const absTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(cwd ?? process.cwd(), target);
  const rel = path.relative(absDir, absTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Does a Bash command TEXTUALLY reference the verdict dir? Catches the
 * enumerated spellings without shell-evaluating (same contract as
 * read-only-bash):
 *   - the literal absolute dir,
 *   - the `$SOLUTION_VERDICT_DIR` env token,
 *   - the stable tail `agent-grounding/solution-verdicts` (covers `~/...`,
 *     `$HOME/...`, `$XDG_STATE_HOME/...`, and absolute spellings), and
 *   - the dir's LEAF segment (`solution-verdicts` for the default).
 *
 * The leaf segment closes the `cd <parent> && write <relative-into-dir>`
 * descent (where the parent path and the child redirect never form the
 * contiguous tail): ANY relative write into the dir from a cwd that is not
 * the dir itself must name the leaf somewhere in the command, and a
 * `cd <…/leaf>` to first make cwd==dir would itself contain the leaf. The
 * write-guard's cwd-inside check covers the only remaining case (cwd already
 * inside the dir). The leaf needle is length-guarded so a short custom
 * basename does not over-block; the default leaf is distinctive, and a
 * non-default dir already warns at validate time.
 *
 * `chmod`/`chattr` that target the dir are caught the same way, so the
 * FS-perm-loosening attack is covered.
 *
 * Honest residual: a path constructed at runtime inside an interpreter with
 * no textual reference (e.g. base64-decoded inside `python3 -c`) is NOT
 * caught. That is what marker signing (follow-up) closes.
 */
export function bashReferencesVerdictDir(command: string, dir: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  const leaf = path.basename(dir);
  // Direct literal references + the distinctive leaf segment.
  if (
    command.includes(dir) ||
    command.includes(VERDICT_DIR_ENV) ||
    command.includes(VERDICT_DIR_TAIL) ||
    (leaf.length >= 6 && command.includes(leaf))
  ) {
    return true;
  }
  // Glob- and brace-obscured references. bash expands `*?[` against EXISTING
  // paths at runtime, so a glob like `solution-ver*/<id>.json` reaches the
  // dir without the literal leaf ever appearing in the command text, and a
  // matching glob can OVERWRITE an existing marker (flipping ready:false ->
  // true). `{...,...}` brace expansion is unconditional (no filesystem
  // lookup needed) and can split the leaf the same way: `solution-verdict{s,}`
  // expands to `solution-verdicts` / `solution-verdict`, neither of which
  // contains the literal leaf as a contiguous substring, so the direct check
  // above misses it. We cannot safely expand either (that is the shell-eval
  // surface read-only-bash refuses), so when a glob OR brace metacharacter is
  // present we match the leaf's distinctive sub-words: a single glob or
  // brace can split the hyphenated leaf but not erase every >=6-char word of
  // it (`solution-ver*` and `solution-verdict{s,}` both keep "solution";
  // `solu*verdicts` keeps "verdicts"). The leaf words, not the parent
  // segment, are used on purpose: the parent here is `agent-grounding`,
  // which is also a repo name and would over-block legitimate work. A
  // command that globs/braces EVERY path segment is the residual the
  // marker-signing follow-up closes.
  //
  // ACCEPTED COST of including `{` here: any brace now enters this
  // leaf-word fallback, so a command carrying a brace AND one of the
  // generic words above trips it even when it never reaches the dir.
  // Measured examples that block today and did not before: `cd
  // /repo/{solution,notes}`, `cd /repo/{a,b}/solution-docs`, and any
  // non-read-only command containing a brace plus "solution"/"verdicts".
  // "solution" is a common word, so this is not rare. It is deliberate:
  // it fails safe, and the tighter alternative (dropping `{`) reopens
  // the `solution-verdict{s,}` split-leaf hole, which fails open.
  if (/[*?[{]/.test(command)) {
    const leafWords = leaf.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 6);
    if (leafWords.some((w) => command.includes(w))) return true;
  }
  return false;
}
