// harness/f9485cc7 — HMAC signing for Understanding Gate / branch-protection
// approval markers.
//
// BACKGROUND: the marker at `harness.generated/.approvals/<id>` is the
// canonical "operator said go" signal (agent-tasks/88ca4bb3). Its integrity
// has rested entirely on an UNENFORCED invariant: "no configured MCP exposes
// a filesystem-write primitive" (understanding-before-execution.md
// "Approval state"). Edit / Write / Bash are gated by the same PreToolUse
// hook this marker satisfies, so today the agent has no path to WRITE the
// marker file. But nothing technical stops a future MCP tool with local
// file-write from silently reopening that hole: its tool name would not
// match the pack's `Edit|Write|Bash` blocker matcher, so a write through it
// would land un-gated. Before this module, the marker's contract was
// "existence is enough" (see the removed `checkApprovalMarker` comment) —
// exactly the shape a forger only needs a bare filesystem-write for. This
// module makes forging also require the operator-side HMAC key, so a marker
// planted through any write-primitive the blocker does not enumerate still
// fails the gate unless it carries a valid signature.
//
// HONEST TRUST MODEL (read this before assuming more than it delivers):
//
//   - This does NOT create a read boundary. The `understanding-before-
//     execution` PreToolUse blocker matches tool names `Edit|Write|Bash`
//     only — it does not gate `Read`, and no permission profile in this
//     repo scopes `Read` away from any path (see
//     `src/policy-packs/permission-translator.ts`: `read` maps to
//     `["Read", "Glob", "Grep"]` with `allow:true` in every v1 profile).
//     So ANY file on local disk — including the signing key, wherever it
//     lives — is readable by the ordinary, always-available `Read` tool,
//     approved or not. Storing the key outside `harness.generated/` would
//     not change this; the write barrier is per-tool-name, not per-path.
//   - The residual this leaves: an agent (or anything running as the same
//     OS user) that can (a) read arbitrary local files — true today, by
//     design, via `Read` — AND (b) write to `harness.generated/.approvals/`
//     through some primitive NOT covered by the `Edit|Write|Bash` blocker
//     matcher, CAN forge a validly-signed marker: it reads the key with
//     Read, computes the HMAC itself, and writes the result through the
//     uncovered write path. Signing does not close this combined case; it
//     closes the narrower (and, before this, the ONLY defended) case where
//     the forger has a write primitive but no matching ability to also
//     recompute a valid signature for it (e.g. a narrow single-purpose
//     write channel, or a human/script that copies bytes without reading
//     back the operator's key file), and it makes ANY forgery attempt one
//     step more expensive and forensically visible (a key read is a
//     distinguishable event; a bare unsigned-JSON write no longer is).
//   - Given the agent and operator share one OS user account on this
//     machine, this is deliberately pragmatic defense-in-depth, not a hard
//     authorization boundary. It is documented here in full rather than
//     oversold.
//
// KEY STORAGE: `<generatedDir>/.approval-signing.key` — a raw 32-byte
// secret, mode 0600, generated lazily on first use (by `harness approve
// understanding` / `harness approve branch-protection`, or by `harness
// init` — see src/cli/init/index.ts). Colocated with `harness.generated/`
// (not a separate home-dir path) so:
//   - it inherits the SAME test-isolation guarantee every marker/report
//     path already has (every call site here already threads an explicit,
//     test-injectable `generatedDir` — no new parameter, no new way to
//     leak into a real `~/.harness/` during a test run);
//   - it is gitignored by the SAME existing convention as the rest of
//     `harness.generated/` (docs/ARCHITECTURE.md: "harness.generated/ ...
//     is .gitignore'd", unlike `harness.yaml` itself, which operators
//     often check into a dotfiles repo) — a home-dir-anchored path could
//     land inside a version-controlled directory when the operator
//     resolves `harness.yaml` via `--config` into a repo tree; this can't;
//   - `harness apply` never wipes it (apply only ever writes its own known
//     files under `harness.generated/`; unknown siblings survive
//     byte-for-byte — the same guarantee `.approvals/` and
//     `.pending-approval` already rely on).
//   `harness uninstall` DOES remove it (it rm -rf's the whole
//   `generatedDir`) — a deliberate, rare, operator-initiated teardown, so
//   losing the key (and therefore invalidating every marker it signed) is
//   an acceptable side effect, not a silent regression.
//
// ROTATION: delete `<generatedDir>/.approval-signing.key` (or call
// `rotateSigningKey`). The next `writeApprovalMarker` /
// `writeBranchProtectionMarker` / any signature check lazily regenerates
// it. Every marker signed under the OLD key immediately fails verification
// (forged:true) and the gate demands re-approval — this is the intended,
// documented blast radius of a rotation, not a bug.
//
// BACK-COMPAT: strict, no migration window. A marker written before this
// feature shipped (or hand-written without the key) carries no `signature`
// field and is REJECTED (see `verifyMarkerSignature`), exactly like a
// forgery. Operator impact: upgrading harness on a machine with a live,
// previously-approved session invalidates that approval; the operator runs
// `harness approve understanding` (and/or `harness approve
// branch-protection`) once more. Chosen over a grace-period migration
// because a migration window is, by construction, a window where the
// exact vulnerability this task closes (an unsigned marker satisfies the
// gate) still holds.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Versioned algorithm tag, so a future re-key scheme can reject mismatches explicitly rather than guess. */
export const SIGNING_ALG = "hmac-sha256-v1";

/** Basename of the signing-key file, a sibling of `.approvals/` under `generatedDir`. */
export const SIGNING_KEY_BASENAME = ".approval-signing.key";

const KEY_BYTES = 32;

/** Filesystem path of the signing key for a given `generatedDir`. */
export function signingKeyPathFor(generatedDir: string): string {
  return path.join(generatedDir, SIGNING_KEY_BASENAME);
}

export interface SigningKeyHandle {
  key: Buffer;
  filePath: string;
  /** True when this call generated a fresh key (first use / post-rotation). */
  created: boolean;
}

/**
 * Read the signing key, generating one (0600, `crypto.randomBytes(32)`) on
 * first use. Race-safe-ish: a concurrent create loses the `wx` (exclusive
 * create) race and falls back to reading whatever the winner wrote, rather
 * than throwing or clobbering it. A key file shorter than `KEY_BYTES`
 * (truncated / corrupted) is treated as absent and regenerated, since a
 * short key would only weaken every future signature.
 */
export function getOrCreateSigningKey(generatedDir: string): SigningKeyHandle {
  const filePath = signingKeyPathFor(generatedDir);
  fs.mkdirSync(generatedDir, { recursive: true });
  let fileExisted = false;
  try {
    const existing = fs.readFileSync(filePath);
    fileExisted = true;
    if (existing.length >= KEY_BYTES) {
      return { key: existing, filePath, created: false };
    }
    // Falls through: truncated/corrupt key file, regenerate below. `flag:
    // "w"` (not "wx") is used below precisely BECAUSE the file already
    // exists here — an exclusive create would collide with it and, on
    // EEXIST, re-read the SAME truncated bytes back, silently failing to
    // ever repair a corrupt key.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fresh = crypto.randomBytes(KEY_BYTES);
  if (fileExisted) {
    // Known-corrupt/truncated file: overwrite unconditionally. No
    // meaningful create-race to defend against — the file is already
    // known bad, so unconditionally replacing it can only improve on
    // the previous (unusable) contents.
    fs.writeFileSync(filePath, fresh, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
    return { key: fresh, filePath, created: true };
  }
  try {
    fs.writeFileSync(filePath, fresh, { mode: 0o600, flag: "wx" });
    return { key: fresh, filePath, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the create race to a concurrent caller; use what they wrote.
      return { key: fs.readFileSync(filePath), filePath, created: false };
    }
    throw err;
  }
}

/**
 * Force a fresh key, overwriting any existing one. Every marker signed
 * under the old key stops verifying immediately (see module doc). Not
 * currently wired to a CLI verb (documented as "delete the file" for v1);
 * exported so a future `harness approve rotate-key`-style verb, or a test,
 * can call it directly without re-deriving the path convention.
 */
export function rotateSigningKey(generatedDir: string): SigningKeyHandle {
  const filePath = signingKeyPathFor(generatedDir);
  fs.mkdirSync(generatedDir, { recursive: true });
  const fresh = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(filePath, fresh, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on platforms where chmod is a no-op (e.g. some Windows fs) */
  }
  return { key: fresh, filePath, created: true };
}

/** sha256 hex digest of a string, used to bind a marker to a persisted report's content. */
export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function canonicalPayload(
  markerId: string,
  approvedAt: string,
  approvedBy: string,
  reportContentHash: string | null,
): string {
  // Fixed key order + JSON string-escaping makes this injective: there is
  // no (markerId, approvedAt, approvedBy, reportContentHash) tuple that
  // collides with a different tuple's encoding, unlike naive delimiter
  // concatenation (e.g. "a"+"bc" vs "ab"+"c").
  return JSON.stringify({ markerId, approvedAt, approvedBy, reportContentHash });
}

export interface SignedMarkerFields {
  approvedAt: string;
  approvedBy: string;
  /** sha256 hex of the persisted-report content this approval is bound to; null when no report exists to bind (e.g. branch-protection, or a ledger-only approval). */
  reportContentHash: string | null;
  alg: string;
  signature: string;
}

/**
 * Sign a marker's fields for `markerId` (the marker's lookup key — a raw
 * sessionId for the understanding-gate session marker, `task-<id>` for a
 * task-scoped marker, `branch-protection-<sessionId>` for the
 * branch-protection twin). Binding `markerId` into the signed payload is
 * what stops a validly-signed marker from being copied/renamed onto a
 * DIFFERENT id and still verifying — verification always recomputes the
 * HMAC using the id the caller is checking, not one read back out of the
 * marker body.
 */
export function signMarker(
  generatedDir: string,
  markerId: string,
  marker: { approvedAt: string; approvedBy: string; reportContentHash?: string | null },
): SignedMarkerFields {
  const { key } = getOrCreateSigningKey(generatedDir);
  const reportContentHash = marker.reportContentHash ?? null;
  const signature = crypto
    .createHmac("sha256", key)
    .update(canonicalPayload(markerId, marker.approvedAt, marker.approvedBy, reportContentHash))
    .digest("hex");
  return {
    approvedAt: marker.approvedAt,
    approvedBy: marker.approvedBy,
    reportContentHash,
    alg: SIGNING_ALG,
    signature,
  };
}

export type SignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /**
       * `"key-unavailable"` when verification could not even run because
       * obtaining the signing key itself failed (permission error, disk
       * issue) — a fail-closed I/O problem, not evidence of tampering.
       * Callers (`checkApprovalMarker`) use this to classify the outcome
       * distinctly from an actual forged/invalid signature (review LOW 1,
       * harness/f9485cc7): a broken key file must not read as an active
       * forgery attempt in audit output. Omitted for every other failure
       * (missing field, wrong alg, bad signature).
       */
      kind?: "key-unavailable";
    };

/**
 * Verify a parsed marker JSON body against `markerId`. Never throws: any
 * failure to obtain the signing key (permission error, disk issue) is
 * treated as a verification failure, not an exception — the gate-side
 * caller must fail closed (not approved) rather than crash the hook
 * process, which the surrounding PreToolUse blocker would otherwise turn
 * into an uncontrolled failure mode. That specific failure mode is tagged
 * `kind: "key-unavailable"` so the caller can tell "we couldn't even check"
 * apart from "we checked and it's invalid".
 */
export function verifyMarkerSignature(
  generatedDir: string,
  markerId: string,
  payload: Record<string, unknown>,
): SignatureVerification {
  const approvedAt = payload["approvedAt"];
  const approvedBy = payload["approvedBy"];
  const signature = payload["signature"];
  const alg = payload["alg"];
  if (typeof approvedAt !== "string" || approvedAt.length === 0) {
    return { ok: false, reason: "missing approvedAt" };
  }
  if (typeof approvedBy !== "string" || approvedBy.length === 0) {
    return { ok: false, reason: "missing approvedBy" };
  }
  if (typeof signature !== "string" || signature.length === 0) {
    return {
      ok: false,
      reason: "missing signature (legacy pre-signing marker, or forged file)",
    };
  }
  if (alg !== SIGNING_ALG) {
    return { ok: false, reason: `unrecognized or missing alg (got ${JSON.stringify(alg)})` };
  }
  const reportContentHash =
    typeof payload["reportContentHash"] === "string"
      ? (payload["reportContentHash"] as string)
      : null;
  let key: Buffer;
  try {
    ({ key } = getOrCreateSigningKey(generatedDir));
  } catch (err) {
    return {
      ok: false,
      reason: `signing key unavailable (${err instanceof Error ? err.message : String(err)})`,
      kind: "key-unavailable",
    };
  }
  const expected = crypto
    .createHmac("sha256", key)
    .update(canonicalPayload(markerId, approvedAt, approvedBy, reportContentHash))
    .digest();
  // No try/catch around Buffer.from(signature, "hex"): unlike JSON.parse,
  // Buffer.from with a "hex" encoding never throws on malformed input — it
  // silently stops decoding at the first invalid pair and returns whatever
  // it managed to decode so far (review LOW 3). The length-mismatch check
  // below is what actually rejects a truncated/malformed decode; relying on
  // an exception here would have been dead code.
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "signature verification failed (tampered or forged)" };
  }
  return { ok: true };
}
