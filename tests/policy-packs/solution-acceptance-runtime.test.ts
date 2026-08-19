import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signingKeyPathFor } from "../../src/runtime/approval-signing.js";
import {
  bashReferencesVerdictDir,
  DEFAULT_PROTECTED_COMPLETION_TOOLS,
  DEFAULT_PUSH_BASH_RE,
  evaluateGate,
  isInsideDir,
  readVerdict,
  resolveExplicitVerdictId,
  resolveProtectedCompletionTools,
  sanitizeVerdictId,
  signVerdict,
  VERDICT_DIR_ENV,
  VERDICT_DIR_TAIL,
  VERDICT_ID_ENV,
  verdictDir,
  verdictMarkerId,
  verdictPathFor,
  verifyVerdictSignature,
  type Verdict,
} from "../../src/policy-packs/builtin/solution-acceptance-runtime.js";
import type { PolicyPack } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sa-runtime-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const HEAD = "f30767afdc14013a48cd0c024a82213f2f63855a";
const OTHER_HEAD = "0123456789abcdef0123456789abcdef01234567";

// Shared operator-side signing key location for the whole file (mirrors
// approval-signing.test.ts / tests/policy-packs/runtime.test.ts): a fresh
// tmp dir per test, so no signature ever leaks across tests.
let generatedDir: string;
beforeEach(() => {
  generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-signing-"));
  cleanups.push(() => fs.rmSync(generatedDir, { recursive: true, force: true }));
});

/** Builds and SIGNS a verdict (harness/c7c3f606) under the shared `generatedDir`, then writes it. */
function writeMarker(dir: string, id: string, v: Partial<Verdict>): void {
  fs.mkdirSync(dir, { recursive: true });
  const full: Verdict = {
    id,
    head: HEAD,
    ready: true,
    confidence: 0.9,
    blockers: [],
    timestamp: "2026-05-30T00:00:00.000Z",
    source: "preflight",
    ...v,
  };
  const signed = signVerdict(generatedDir, full);
  fs.writeFileSync(verdictPathFor(dir, id), `${JSON.stringify(signed, null, 2)}\n`);
}

/** Writes an UNSIGNED verdict (no `alg`/`signature` — the pre-c7c3f606 / legacy producer shape). */
function writeUnsignedMarker(dir: string, id: string, v: Partial<Verdict>): void {
  fs.mkdirSync(dir, { recursive: true });
  const full: Verdict = {
    id,
    head: HEAD,
    ready: true,
    confidence: 0.9,
    blockers: [],
    timestamp: "2026-05-30T00:00:00.000Z",
    source: "preflight",
    ...v,
  };
  fs.writeFileSync(verdictPathFor(dir, id), `${JSON.stringify(full, null, 2)}\n`);
}

describe("verdictDir — resolution order mirrors the producer", () => {
  it("honors SOLUTION_VERDICT_DIR first", () => {
    expect(verdictDir({ [VERDICT_DIR_ENV]: "/x/y" } as NodeJS.ProcessEnv, () => "/home/u")).toBe(
      "/x/y",
    );
  });
  it("falls back to XDG_STATE_HOME, then ~/.local/state", () => {
    expect(verdictDir({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv, () => "/home/u")).toBe(
      path.join("/state", "agent-grounding", "solution-verdicts"),
    );
    expect(verdictDir({} as NodeJS.ProcessEnv, () => "/home/u")).toBe(
      path.join("/home/u", ".local", "state", "agent-grounding", "solution-verdicts"),
    );
  });
  it("the stable tail is the default-location anchor", () => {
    expect(verdictDir({} as NodeJS.ProcessEnv, () => "/home/u").endsWith(VERDICT_DIR_TAIL)).toBe(true);
  });
});

describe("sanitizeVerdictId — path-traversal guard (mirror of producer)", () => {
  it("collapses unsafe chars so traversal cannot escape the dir", () => {
    // Slashes collapse to `_` BEFORE basename, so the whole id becomes one
    // safe segment — traversal is neutralized, not just trimmed.
    const out = sanitizeVerdictId("task/../../etc/passwd");
    expect(out).toBe("task_.._.._etc_passwd");
    expect(out).not.toContain("/");
    expect(sanitizeVerdictId("a b@c")).toBe("a_b_c");
  });
  it("rejects empty / dot-only ids", () => {
    expect(() => sanitizeVerdictId("")).toThrow();
    expect(() => sanitizeVerdictId("..")).toThrow();
  });
});

describe("resolveExplicitVerdictId — solo / non-agent-tasks fallback source", () => {
  it("returns the trimmed value when SOLUTION_VERDICT_ID is a safe id", () => {
    expect(resolveExplicitVerdictId({ [VERDICT_ID_ENV]: "solo-verdict" })).toBe("solo-verdict");
    expect(resolveExplicitVerdictId({ [VERDICT_ID_ENV]: "  solo-verdict  " })).toBe("solo-verdict");
  });
  it("returns null when unset or blank", () => {
    expect(resolveExplicitVerdictId({})).toBeNull();
    expect(resolveExplicitVerdictId({ [VERDICT_ID_ENV]: "" })).toBeNull();
    expect(resolveExplicitVerdictId({ [VERDICT_ID_ENV]: "   " })).toBeNull();
  });
  it("fails closed (null) on a dot-only / traversal-only id that sanitize rejects", () => {
    expect(resolveExplicitVerdictId({ [VERDICT_ID_ENV]: ".." })).toBeNull();
    expect(resolveExplicitVerdictId({ [VERDICT_ID_ENV]: "." })).toBeNull();
  });
});

describe("readVerdict", () => {
  it("parses a well-formed marker", () => {
    const dir = tmpDir();
    writeMarker(dir, "t1", {});
    const v = readVerdict(dir, "t1");
    expect(v).not.toBeNull();
    expect(v?.head).toBe(HEAD);
    expect(v?.ready).toBe(true);
  });
  it("returns null on absent / malformed / missing-required-field", () => {
    const dir = tmpDir();
    expect(readVerdict(dir, "missing")).toBeNull();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(verdictPathFor(dir, "bad"), "{ not json");
    expect(readVerdict(dir, "bad")).toBeNull();
    fs.writeFileSync(verdictPathFor(dir, "partial"), JSON.stringify({ id: "x", ready: true }));
    expect(readVerdict(dir, "partial")).toBeNull(); // no head
  });
  it("refuses a symlink at the marker path (anti-forgery defense-in-depth)", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "evil.json");
    fs.writeFileSync(target, JSON.stringify({ id: "t", head: HEAD, ready: true }));
    fs.symlinkSync(target, verdictPathFor(dir, "linked"));
    expect(readVerdict(dir, "linked")).toBeNull();
  });
});

describe("evaluateGate — mirror of grounding-mcp solution_gate", () => {
  it("allows only a ready, VALIDLY-SIGNED verdict at the current HEAD", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true });
    expect(evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir).allowed).toBe(true);
  });
  it("blocks: no verdict", () => {
    const r = evaluateGate(null, HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/no solution-acceptance verdict/);
  });
  it("blocks: not ready, surfacing blockers", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { ready: false, blockers: ["lint failed", "1 test failing"] });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/not ready: lint failed; 1 test failing/);
  });
  it("blocks: an orchestrator-workflow process blocker reaches the agent via the existing blockers path", () => {
    // grounding-mcp >= 0.5.0 folds orchestrator-workflow (OW) process-
    // completeness into `ready` and surfaces the reason through the EXISTING
    // blockers[] (each prefixed `orchestrator-workflow: `). No new Verdict
    // field is added, so the consumer needs no gate-logic change. Pin head to
    // the CURRENT HEAD so this is the not-ready arm (not a stale-verdict
    // denial): a ready:false verdict at HEAD must still deny, and the OW
    // reason must flow through into the deny message unchanged.
    const dir = tmpDir();
    const owBlocker = "orchestrator-workflow: handoff final-status is 'blocked'";
    writeMarker(dir, "t", { head: HEAD, ready: false, blockers: [owBlocker] });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain(owBlocker);
  });
  it("blocks: HEAD drift (stale verdict)", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: OTHER_HEAD, ready: true });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/stale solution-acceptance verdict/);
  });
  it("blocks: unresolvable current HEAD", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { ready: true });
    expect(evaluateGate(readVerdict(dir, "t"), null, "t", generatedDir).allowed).toBe(false);
  });
  it("ignores confidence: ready:true confidence:0 at HEAD still ALLOWS (parity with producer)", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { ready: true, confidence: 0, head: HEAD });
    expect(evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir).allowed).toBe(true);
  });
});

describe("evaluateGate — signature verification (harness/c7c3f606, fail-closed)", () => {
  it("rejects an UNSIGNED verdict with a distinct forged reason, separate from no-marker", () => {
    const dir = tmpDir();
    writeUnsignedMarker(dir, "t", { head: HEAD, ready: true });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
    expect(r.reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    // Distinct from the "no verdict recorded" wording used when the file is absent.
    expect(r.reason).not.toMatch(/no solution-acceptance verdict recorded/);
  });

  // Regression (AC #3): a marker hand-written WITHOUT the signing key —
  // simulating a forge via a write primitive the write-guard does not
  // enumerate — must NOT satisfy the gate, even with perfectly well-formed
  // ready/head/blockers fields. Mirrors
  // tests/policy-packs/runtime.test.ts's approval-marker forgery regression.
  it("a hand-written marker without a signature does NOT satisfy the gate (forgery regression)", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      verdictPathFor(dir, "attacker-task"),
      `${JSON.stringify({
        id: "attacker-task",
        head: HEAD,
        ready: true,
        confidence: 1,
        blockers: [],
        timestamp: new Date().toISOString(),
        source: "attacker",
      })}\n`,
    );
    const r = evaluateGate(readVerdict(dir, "attacker-task"), HEAD, "attacker-task", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
    expect(r.reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    expect(r.reason).toMatch(/missing signature/);
  });

  // Mutation-verification (mirrors approval-signing's tamper regression):
  // flip ONE byte of an otherwise-valid signature and confirm the gate
  // blocks with the forged reason, not silently accepting it.
  it("a validly-signed verdict with one tampered signature byte is REJECTED", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true });
    // Confirm the untampered verdict verifies first, so the assertion below
    // is attributable to the tamper, not to some other break.
    expect(evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir).allowed).toBe(true);
    const markerPath = verdictPathFor(dir, "t");
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { signature: string };
    const original = raw.signature;
    const flippedChar = original[0] === "0" ? "1" : "0";
    raw.signature = flippedChar + original.slice(1);
    fs.writeFileSync(markerPath, `${JSON.stringify(raw, null, 2)}\n`);
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
    expect(r.reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    expect(r.reason).toMatch(/signature verification failed/);
  });

  // Tampering ANY signed field (not just `signature` itself) must also fail
  // verification — the content hash binds head/ready/confidence/blockers,
  // not just the literal bytes signMarker hashed.
  it("tampering `ready` after signing (without touching signature) is REJECTED", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: false, blockers: ["lint failed"] });
    const markerPath = verdictPathFor(dir, "t");
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Verdict;
    raw.ready = true; // flip a forger would want: turn a real "not ready" into "ready"
    raw.blockers = [];
    fs.writeFileSync(markerPath, `${JSON.stringify(raw, null, 2)}\n`);
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });

  it("fails closed (NOT forged) when generatedDir cannot be resolved", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", undefined);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/cannot resolve harness\.generated\//);
  });

  // Review parity with approval-signing.ts: a broken signing-key file (I/O
  // error) must NOT read as an active forgery attempt. Distinct from `forged`.
  it("a signing-key I/O failure is fail-closed but NOT classified as forged", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true });
    expect(evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir).allowed).toBe(true);
    const keyPath = signingKeyPathFor(generatedDir);
    fs.rmSync(keyPath, { force: true });
    fs.mkdirSync(keyPath); // directory at the key's path: readFileSync throws EISDIR
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/could not be verified/);
  });

  // Review LOW (fix-round-2), rescoped by review R2 MED (fix-round-2b): a
  // verdict with NO signature/alg fields at all, whose `timestamp` /
  // `source` (mapped onto `verifyMarkerSignature`'s `approvedAt` /
  // `approvedBy`) also reads blank, is a LEGITIMATELY MALFORMED, never-
  // signed marker — e.g. a producer bug that left the field blank — not
  // evidence of an active forgery attempt. Both stay fail-closed
  // (`allowed: false`), but must NOT be classified `forged: true`, mirroring
  // the existing key-unavailable carve-out. Uses `writeUnsignedMarker`
  // (NOT `writeMarker`) so this genuinely exercises the "no signature at
  // all" case the carve-out is now scoped to — see the SIGNED-and-blanked
  // regressions just below for the case that must NOT get this carve-out.
  it("an UNSIGNED verdict with an empty timestamp is fail-closed but NOT classified as forged (missing approvedAt carve-out)", () => {
    const dir = tmpDir();
    writeUnsignedMarker(dir, "t", { head: HEAD, ready: true, timestamp: "" });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/missing approvedAt/);
  });

  it("an UNSIGNED verdict with an empty source is fail-closed but NOT classified as forged (missing approvedBy carve-out)", () => {
    const dir = tmpDir();
    writeUnsignedMarker(dir, "t", { head: HEAD, ready: true, source: "" });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/missing approvedBy/);
  });

  // Regression (harness/c7c3f606 review R2 MED, fix-round-2b / audit
  // finding A8): the carve-out above must NOT extend to a verdict that
  // DOES carry a signature. Before this fix, `writeMarker` (which always
  // signs) with a blanked `timestamp` hit the SAME "missing approvedAt"
  // verification reason as the genuinely-unsigned case above — because
  // `verifyMarkerSignature` checks `approvedAt` for blankness BEFORE ever
  // comparing the signature — so a forger who took a REAL signed verdict
  // and blanked its `timestamp` post-signing suppressed `forged: true` even
  // though the marker plainly carries `alg`/`signature` fields. `allowed`
  // stayed `false` throughout (never a bypass), but the audit tag lied.
  // This is now classified `forged: true`.
  it("a SIGNED verdict with a blanked timestamp IS classified as forged, unlike its unsigned counterpart (A8)", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true, timestamp: "" });
    const v = readVerdict(dir, "t");
    expect(v?.signature).toBeDefined(); // sanity: this really is a signed marker
    expect(v?.alg).toBeDefined();
    const r = evaluateGate(v, HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
    expect(r.reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
  });

  it("a SIGNED verdict with a blanked source IS classified as forged, unlike its unsigned counterpart (A8)", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true, source: "" });
    const v = readVerdict(dir, "t");
    expect(v?.signature).toBeDefined();
    expect(v?.alg).toBeDefined();
    const r = evaluateGate(v, HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
    expect(r.reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
  });

  // Negative control (audit finding A7, review R2): the MINIMAL
  // hand-written marker the finding named — `{id, head, ready:true}`, no
  // `timestamp`/`source`/`confidence`/`blockers`/signature keys at all —
  // still reads as the defensible "unsigned legacy marker" case after this
  // fix, i.e. the tightened carve-out does not spuriously flip A7 to
  // forged:true. `allowed` is false either way (fail-closed, never a
  // bypass); only the audit classification is at stake here, and this one
  // stays `forged: false` on purpose, unlike its SIGNED counterpart (A8)
  // above.
  it("the minimal hand-written marker with no signature and no timestamp/source (A7) stays forged:false", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      verdictPathFor(dir, "t"),
      JSON.stringify({ id: "t", head: HEAD, ready: true }),
    );
    const v = readVerdict(dir, "t");
    expect(v?.signature).toBeUndefined();
    expect(v?.alg).toBeUndefined();
    const r = evaluateGate(v, HEAD, "t", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    expect(r.reason).toMatch(/missing approvedAt/);
  });

  // A verdict signed for one id must not verify under a different id — the
  // markerId is bound into the signature (mirrors the approval marker's
  // copy-to-a-different-session-id regression). This relabels the body's
  // `id` to match the NEW path, so it exercises "a stale signature computed
  // for a different id fails" — see the VERBATIM-copy test below for the
  // sharper cross-id-replay regression, where the body is left untouched.
  it("a validly-signed verdict's signature does not transfer to a different id (relabeled body)", () => {
    const dir = tmpDir();
    writeMarker(dir, "task-a", { head: HEAD, ready: true });
    const originalPath = verdictPathFor(dir, "task-a");
    const raw = JSON.parse(fs.readFileSync(originalPath, "utf8")) as Verdict;
    raw.id = "task-b"; // relabel, same signature
    const copiedPath = verdictPathFor(dir, "task-b");
    fs.writeFileSync(copiedPath, `${JSON.stringify(raw, null, 2)}\n`);
    const r = evaluateGate(readVerdict(dir, "task-b"), HEAD, "task-b", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });

  // Regression (review R1 HIGH, harness/c7c3f606 fix-round-2): a
  // VERBATIM byte-for-byte copy of a validly-signed verdict onto a SECOND
  // id's marker path — the body's `id` field is left untouched at "task-a"
  // — must NOT satisfy that second id's gate. Before this fix,
  // `verifyVerdictSignature` derived the HMAC markerId from `verdict.id`
  // (the marker BODY, attacker-writable via a plain file copy) instead of
  // from the id the caller is actually checking, so this exact copy
  // verified successfully and the gate ALLOWED "task-b" to complete on
  // "task-a"'s verdict. This is the scenario the relabeled-body test above
  // does NOT cover (that test mutates `id` to match the new path, which
  // breaks the signature for an unrelated reason and passes even under the
  // pre-fix code).
  it("a VERBATIM file copy of a signed verdict onto a second id's path is rejected (cross-id replay)", () => {
    const dir = tmpDir();
    writeMarker(dir, "task-a", { head: HEAD, ready: true });
    const bytes = fs.readFileSync(verdictPathFor(dir, "task-a"));
    // Byte-for-byte copy: the body still says id:"task-a".
    fs.writeFileSync(verdictPathFor(dir, "task-b"), bytes);
    const copied = readVerdict(dir, "task-b");
    expect(copied?.id).toBe("task-a"); // confirms this is a TRUE verbatim copy, not a relabel
    const r = evaluateGate(copied, HEAD, "task-b", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });

  // Isolated pin for the belt-and-braces `verdict.id !== id` check
  // (evaluateGate), independent of the markerId-derivation fix above. The
  // HMAC payload signMarker/verifyMarkerSignature compute does NOT include
  // `id` itself (only timestamp/source/content-hash), so a verdict's `id`
  // field can be edited post-signing WITHOUT invalidating the signature —
  // the markerId-derivation fix alone does not catch this, because
  // `verifyVerdictSignature` never reads `verdict.id` at all once it is
  // given the caller's id directly. This constructs exactly that: a
  // verdict validly signed for CALLER id "solo-x", with `id` mutated to
  // "someone-else" afterward (signature untouched, so verification still
  // passes), placed at "solo-x"'s own path so the caller's id and the file
  // path agree. Without the dedicated `verdict.id !== id` check, this would
  // ALLOW (ready:true, head matches); with it, it is rejected.
  it("verdict.id disagreeing with the requested id is rejected even when the signature still verifies", () => {
    const dir = tmpDir();
    const id = "solo-x";
    fs.mkdirSync(dir, { recursive: true });
    const full: Verdict = {
      id,
      head: HEAD,
      ready: true,
      confidence: 0.9,
      blockers: [],
      timestamp: "2026-05-30T00:00:00.000Z",
      source: "preflight",
    };
    const signed = signVerdict(generatedDir, full);
    // Mutate ONLY `id` after signing — `id` is not part of the signed
    // payload, so this leaves `signed.signature` valid for CALLER id "solo-x".
    const tampered: Verdict = { ...signed, id: "someone-else" };
    fs.writeFileSync(verdictPathFor(dir, id), `${JSON.stringify(tampered, null, 2)}\n`);
    const read = readVerdict(dir, id);
    expect(read?.id).toBe("someone-else");
    // Sanity: the signature genuinely still verifies for the caller's id —
    // proves the rejection below comes from the `verdict.id !== id` check,
    // not from a signature failure.
    expect(verifyVerdictSignature(generatedDir, id, read as Verdict)).toEqual({ ok: true });
    const r = evaluateGate(read, HEAD, id, generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });

  // Regression: two DIFFERENT raw task ids that collapse to the SAME
  // sanitized file path (sanitizeVerdictId turns ":" into "_", so "a:b" and
  // "a_b" both resolve to "a_b.json") must not let one task's verdict
  // satisfy the other's gate. Before this fix, the HMAC markerId was
  // derived from `verdict.id` (the file's own content), so the collision
  // alone was enough: the second, unrelated task's gate check would find
  // the first task's byte-identical file, compute the SAME body-derived
  // markerId, and allow. Deriving the markerId from the CALLER's raw id
  // instead (this fix) makes the two ids sign/verify under DIFFERENT
  // markerIds despite the path collision, so the mismatch is caught.
  it("colliding sanitized ids (\"a:b\" vs \"a_b\") do not let one task's verdict satisfy the other's gate", () => {
    const dir = tmpDir();
    expect(verdictPathFor(dir, "a:b")).toBe(verdictPathFor(dir, "a_b")); // same path, confirmed
    // Producer writes for raw id "a:b" (its own gate would use this raw id).
    writeMarker(dir, "a:b", { head: HEAD, ready: true });
    // A DIFFERENT task, raw id "a_b", resolves to the SAME file via the
    // sanitize collision and asks its own gate to check it.
    const collided = readVerdict(dir, "a_b");
    expect(collided?.id).toBe("a:b"); // it really did read the other task's file
    const r = evaluateGate(collided, HEAD, "a_b", generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });
});

describe("verdictMarkerId / signVerdict / verifyVerdictSignature", () => {
  it("verdictMarkerId namespaces the id so it cannot collide with an approval/branch-protection marker id", () => {
    expect(verdictMarkerId("task-42")).toBe("solution-verdict-task-42");
  });

  it("signVerdict + verifyVerdictSignature round-trip ok on an untampered verdict", () => {
    const verdict: Verdict = {
      id: "t",
      head: HEAD,
      ready: true,
      confidence: 0.5,
      blockers: [],
      timestamp: "2026-05-30T00:00:00.000Z",
      source: "preflight",
    };
    const signed = signVerdict(generatedDir, verdict);
    expect(signed.alg).toBeDefined();
    expect(signed.signature).toBeDefined();
    expect(verifyVerdictSignature(generatedDir, "t", signed)).toEqual({ ok: true });
  });

  // Direct, dedicated pin of the markerId-derivation fix (harness/c7c3f606
  // fix-round-2), at the `verifyVerdictSignature` unit level — deliberately
  // NOT going through `evaluateGate`, so this is independent of that
  // function's separate `verdict.id !== id` belt-and-braces check (which
  // would otherwise also reject a verbatim-copy scenario and mask whether
  // THIS function alone derives the markerId correctly). A verdict signed
  // for "task-a" must verify under "task-a" and must NOT verify under
  // "task-b", even though the verdict's own body still says `id: "task-a"`
  // in both calls — the caller's id, not the body, drives the check.
  it("verifyVerdictSignature derives the markerId from the CALLER's id, not verdict.id", () => {
    const verdict: Verdict = {
      id: "task-a",
      head: HEAD,
      ready: true,
      confidence: 1,
      blockers: [],
      timestamp: "2026-05-30T00:00:00.000Z",
      source: "preflight",
    };
    const signed = signVerdict(generatedDir, verdict);
    expect(verifyVerdictSignature(generatedDir, "task-a", signed)).toEqual({ ok: true });
    expect(verifyVerdictSignature(generatedDir, "task-b", signed).ok).toBe(false);
  });

  it("verifyVerdictSignature rejects a verdict with no signature at all", () => {
    const verdict: Verdict = {
      id: "t",
      head: HEAD,
      ready: true,
      confidence: 0.5,
      blockers: [],
      timestamp: "2026-05-30T00:00:00.000Z",
      source: "preflight",
    };
    const v = verifyVerdictSignature(generatedDir, "t", verdict);
    expect(v.ok).toBe(false);
  });
});

describe("isInsideDir — write-guard path arm", () => {
  const dir = "/home/u/.local/state/agent-grounding/solution-verdicts";
  it("true for a file inside the dir", () => {
    expect(isInsideDir(`${dir}/task-1.json`, dir)).toBe(true);
  });
  it("true for a relative target under a cwd that is the dir", () => {
    expect(isInsideDir("task-1.json", dir, dir)).toBe(true);
  });
  it("false for a sibling / outside path", () => {
    expect(isInsideDir("/home/u/.local/state/agent-grounding/solution-verdicts-notes", dir)).toBe(
      false,
    );
    expect(isInsideDir("/etc/passwd", dir)).toBe(false);
  });
});

describe("bashReferencesVerdictDir — write-guard reference detection", () => {
  const dir = "/home/u/.local/state/agent-grounding/solution-verdicts";
  it("catches the literal abs path, the env token, and the stable tail", () => {
    expect(bashReferencesVerdictDir(`echo x > ${dir}/t.json`, dir)).toBe(true);
    expect(bashReferencesVerdictDir(`echo x > "$${VERDICT_DIR_ENV}/t.json"`, dir)).toBe(true);
    expect(bashReferencesVerdictDir("tee ~/.local/state/agent-grounding/solution-verdicts/t.json", dir)).toBe(
      true,
    );
  });
  it("catches glob-obscured leaf spellings (overwrite forge)", () => {
    expect(bashReferencesVerdictDir(`echo x > ${dir.replace("solution-verdicts", "solution-ver*")}/t.json`, dir)).toBe(
      true,
    );
    expect(bashReferencesVerdictDir(`cp /tmp/f ${dir.replace("solution-verdicts", "solu*verdicts")}/t.json`, dir)).toBe(
      true,
    );
    expect(bashReferencesVerdictDir("cd /home/u/.local/state/agent-grounding && echo x > solution-v?rdicts/t.json", dir)).toBe(
      true,
    );
  });
  it("does not match unrelated commands (incl. globbed ones)", () => {
    expect(bashReferencesVerdictDir("echo hi > /tmp/x", dir)).toBe(false);
    expect(bashReferencesVerdictDir("cp src/*.ts dist/", dir)).toBe(false);
    expect(bashReferencesVerdictDir("rm /tmp/agent-relay/*.log", dir)).toBe(false);
  });
});

describe("DEFAULT_PUSH_BASH_RE — completion bash matcher", () => {
  it("matches the literal push / merge spellings", () => {
    expect(DEFAULT_PUSH_BASH_RE.test("git push origin feat/x")).toBe(true);
    expect(DEFAULT_PUSH_BASH_RE.test("git -C /repo push")).toBe(true);
    expect(DEFAULT_PUSH_BASH_RE.test("gh pr merge 12 --squash")).toBe(true);
    expect(DEFAULT_PUSH_BASH_RE.test("cd /repo && git push")).toBe(true);
  });
  it("does not match unrelated git commands", () => {
    expect(DEFAULT_PUSH_BASH_RE.test("git status")).toBe(false);
    expect(DEFAULT_PUSH_BASH_RE.test("git pushup")).toBe(false);
  });

  // Task 76671e5a: bash starts a new command after a single `&`, so
  // `A=x&git push` used to slip past this DENY matcher entirely (the
  // boundary alternation only listed `&&`). Same fix `d834a065` applied to
  // every policy trigger. `&&` cases pin subsumption (nothing dropped).
  it.each(["A=x&git push", "sleep 0 & git push", "A=x&gh pr merge"])(
    "matches the bare-`&`-separated form %s (task 76671e5a)",
    (cmd) => {
      expect(DEFAULT_PUSH_BASH_RE.test(cmd)).toBe(true);
    },
  );
  it.each(["A=x&&git push", "echo x && git push"])(
    "still matches the `&&`-separated form %s (subsumed, not dropped)",
    (cmd) => {
      expect(DEFAULT_PUSH_BASH_RE.test(cmd)).toBe(true);
    },
  );
});

describe("resolveProtectedCompletionTools", () => {
  function packWith(config: Record<string, unknown>): PolicyPack {
    return { name: "solution-acceptance", source: "builtin", enabled: true, config } as PolicyPack;
  }
  it("defaults to the canonical completion verb set", () => {
    expect(resolveProtectedCompletionTools(packWith({}))).toEqual([
      ...DEFAULT_PROTECTED_COMPLETION_TOOLS,
    ]);
  });
  it("honors a config override", () => {
    expect(resolveProtectedCompletionTools(packWith({ protected_completion_tools: ["task_finish"] }))).toEqual(
      ["task_finish"],
    );
  });
});

describe("golden fixture — drift guard against the real producer", () => {
  // Captured from @lannguyensi/grounding-mcp@0.3.2 solution_evaluate (a real
  // `preflight run --json`). If grounding-mcp changes the Verdict shape,
  // regenerate via `solution_evaluate({ id })` and copy the marker from
  // ~/.local/state/agent-grounding/solution-verdicts/<id>.json, then update
  // PRODUCER_KEYS below. This is the tripwire that the consumer stays
  // field-for-field with the producer.
  const PRODUCER_KEYS = ["id", "head", "ready", "confidence", "blockers", "timestamp", "source"];
  const fixturePath = path.join(
    __dirname,
    "..",
    "fixtures",
    "solution-acceptance",
    "golden-verdict-0.3.2.json",
  );

  it("the real 0.3.2 marker carries exactly the fields the consumer reads", () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    expect(Object.keys(raw).sort()).toEqual([...PRODUCER_KEYS].sort());
  });

  // harness/c7c3f606: the REAL 0.3.2 producer output carries no `signature`
  // field (no currently-released grounding-mcp version signs). Under the
  // new fail-closed contract this is correctly REJECTED as unsigned — the
  // exact same strict, no-migration-window trade-off f9485cc7 made for the
  // understanding-gate marker, just landing here because the producer is a
  // separate package/repo (see solution-acceptance-runtime.ts module doc,
  // "HONEST RESIDUAL"). This replaces the pre-c7c3f606 assertion that this
  // exact unsigned marker ALLOWED at its own head.
  it("the real UNSIGNED 0.3.2 marker is rejected as forged/unsigned, even at its own HEAD", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Verdict;
    fs.writeFileSync(verdictPathFor(dir, raw.id), JSON.stringify(raw));
    const v = readVerdict(dir, raw.id);
    expect(v).not.toBeNull();
    const r = evaluateGate(v, raw.head, raw.id, generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });

  // Once the SAME 7-key content is signed (as a future signing producer
  // would do), the pre-existing ready/HEAD-match gate logic behaves exactly
  // as before: allow at the marker's own head, deny at a drifted head. This
  // preserves the original test's coverage of that decision.
  it("the consumer gates a SIGNED copy of the real marker's content correctly", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Verdict;
    const signed = signVerdict(generatedDir, raw);
    fs.writeFileSync(verdictPathFor(dir, raw.id), JSON.stringify(signed));
    const v = readVerdict(dir, raw.id);
    expect(v).not.toBeNull();
    // allow at the marker's own head, deny at a drifted head.
    expect(evaluateGate(v, raw.head, raw.id, generatedDir).allowed).toBe(true);
    expect(evaluateGate(v, OTHER_HEAD, raw.id, generatedDir).allowed).toBe(false);
  });
});

describe("golden fixture 0.5.0 — pins the orchestrator-workflow blocker contract", () => {
  // Captured VERBATIM from @lannguyensi/grounding-mcp@0.5.0 `evaluateSolution`
  // (the 0.5.0 producer that folds the OW process arm into ready + blockers).
  // It was produced by the REAL built producer against a scratch repo whose
  // active OW run carries a blocked handoff, with preflight stubbed green via
  // SOLUTION_PREFLIGHT_BIN — so the not-ready arm here comes from the OW
  // process check, not from a technical preflight failure. This pins TWO things
  // the 0.3.2 fixture cannot: that the 0.5.0 producer still emits exactly the
  // 7-key shape (drift guard), and that an OW blocker really arrives prefixed
  // `orchestrator-workflow: `. If grounding-mcp changes the Verdict shape or the
  // blocker prefix, regenerate from the 0.5.0 producer and update this fixture.
  const PRODUCER_KEYS = ["id", "head", "ready", "confidence", "blockers", "timestamp", "source"];
  const fixturePath = path.join(
    __dirname,
    "..",
    "fixtures",
    "solution-acceptance",
    "golden-verdict-0.5.0.json",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Verdict;

  it("the real 0.5.0 marker carries exactly the 7 producer keys (drift guard)", () => {
    expect(Object.keys(fixture).sort()).toEqual([...PRODUCER_KEYS].sort());
  });

  it("at least one blocker carries the orchestrator-workflow: prefix", () => {
    expect(fixture.blockers.some((b) => /^orchestrator-workflow: /.test(b))).toBe(true);
  });

  // harness/c7c3f606: the raw fixture is unsigned (no released producer
  // signs yet), so it is now rejected as forged/unsigned BEFORE the OW
  // blocker logic ever runs — proving the signature check is evaluated
  // first, fail-closed, regardless of what `ready`/`blockers` claim.
  it("the raw UNSIGNED 0.5.0 marker is rejected as forged/unsigned before the not-ready logic runs", () => {
    const r = evaluateGate(fixture, fixture.head, fixture.id, generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(true);
  });

  // Signing the SAME captured content (as a future signing producer would)
  // exercises the pre-existing not-ready + OW-blocker-surfacing behavior
  // this test originally pinned, unchanged.
  it("a SIGNED copy of the 0.5.0 marker still denies the not-ready OW verdict and surfaces the OW blocker", () => {
    const signed = signVerdict(generatedDir, fixture);
    const r = evaluateGate(signed, signed.head, signed.id, generatedDir);
    expect(r.allowed).toBe(false);
    expect(r.forged).toBe(false);
    const owBlocker = fixture.blockers.find((b) => /^orchestrator-workflow: /.test(b));
    expect(owBlocker).toBeDefined();
    expect(r.reason).toContain(owBlocker as string);
  });
});
