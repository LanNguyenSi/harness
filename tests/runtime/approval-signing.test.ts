import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SIGNING_ALG,
  SIGNING_KEY_BASENAME,
  getOrCreateSigningKey,
  rotateSigningKey,
  sha256Hex,
  signMarker,
  signingKeyPathFor,
  verifyMarkerSignature,
} from "../../src/runtime/approval-signing.js";

let tmp: string;
let generatedDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-signing-"));
  generatedDir = path.join(tmp, "harness.generated");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("signingKeyPathFor", () => {
  it("is a sibling of .approvals/ directly under generatedDir", () => {
    expect(signingKeyPathFor(generatedDir)).toBe(
      path.join(generatedDir, SIGNING_KEY_BASENAME),
    );
  });
});

describe("getOrCreateSigningKey", () => {
  it("generates a fresh 32-byte key on first use, mode 0600", () => {
    const { key, filePath, created } = getOrCreateSigningKey(generatedDir);
    expect(created).toBe(true);
    expect(key.length).toBe(32);
    expect(fs.existsSync(filePath)).toBe(true);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the SAME key on a second call (persists across calls)", () => {
    const first = getOrCreateSigningKey(generatedDir);
    const second = getOrCreateSigningKey(generatedDir);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it("regenerates when the key file is truncated/corrupt", () => {
    const first = getOrCreateSigningKey(generatedDir);
    fs.writeFileSync(first.filePath, Buffer.from([1, 2, 3])); // way too short
    const second = getOrCreateSigningKey(generatedDir);
    expect(second.created).toBe(true);
    expect(second.key.length).toBe(32);
    expect(second.key.equals(first.key)).toBe(false);
  });
});

describe("rotateSigningKey", () => {
  it("overwrites the key with a fresh 32-byte value", () => {
    const before = getOrCreateSigningKey(generatedDir);
    const rotated = rotateSigningKey(generatedDir);
    expect(rotated.key.length).toBe(32);
    expect(rotated.key.equals(before.key)).toBe(false);
    const after = getOrCreateSigningKey(generatedDir);
    expect(after.key.equals(rotated.key)).toBe(true);
    expect(after.created).toBe(false);
  });

  it("invalidates every marker signed under the old key (rotation = mass re-approval)", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    rotateSigningKey(generatedDir);
    const verification = verifyMarkerSignature(generatedDir, "sess-1", signed as unknown as Record<string, unknown>);
    expect(verification.ok).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches a known digest", () => {
    // sha256("") — the canonical empty-string vector.
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic and content-sensitive", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hellO"));
  });
});

describe("signMarker / verifyMarkerSignature — round trip", () => {
  it("a freshly signed marker verifies", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
      reportContentHash: "deadbeef",
    });
    expect(signed.alg).toBe(SIGNING_ALG);
    expect(signed.reportContentHash).toBe("deadbeef");
    const verification = verifyMarkerSignature(
      generatedDir,
      "sess-1",
      signed as unknown as Record<string, unknown>,
    );
    expect(verification).toEqual({ ok: true });
  });

  it("defaults reportContentHash to null when omitted", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    expect(signed.reportContentHash).toBeNull();
    expect(
      verifyMarkerSignature(generatedDir, "sess-1", signed as unknown as Record<string, unknown>)
        .ok,
    ).toBe(true);
  });

  it("rejects a signature verified against a DIFFERENT markerId", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    const r = verifyMarkerSignature(
      generatedDir,
      "sess-DIFFERENT",
      signed as unknown as Record<string, unknown>,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects when approvedAt is missing or empty", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    const payload = { ...signed, approvedAt: "" };
    const r = verifyMarkerSignature(generatedDir, "sess-1", payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/approvedAt/);
  });

  it("rejects when approvedBy is missing or empty", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    const payload = { ...signed, approvedBy: "" };
    const r = verifyMarkerSignature(generatedDir, "sess-1", payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/approvedBy/);
  });

  it("rejects when signature is missing (legacy pre-signing marker shape)", () => {
    const r = verifyMarkerSignature(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing signature/);
  });

  it("rejects when alg is wrong or missing", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    const payload = { ...signed, alg: "some-future-alg-v2" };
    const r = verifyMarkerSignature(generatedDir, "sess-1", payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/alg/);
  });

  it("rejects a non-hex signature string", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    // Buffer.from(str, "hex") silently drops invalid trailing chars rather
    // than throwing, so use a value whose decoded length mismatches the
    // expected HMAC-SHA256 digest length instead — this exercises the
    // length-mismatch branch of the constant-time comparison.
    const payload = { ...signed, signature: "00" };
    const r = verifyMarkerSignature(generatedDir, "sess-1", payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature verification failed/);
  });

  it("rejects a tampered signature (one flipped hex char)", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    const flippedChar = signed.signature[0] === "0" ? "1" : "0";
    const tampered = { ...signed, signature: flippedChar + signed.signature.slice(1) };
    const r = verifyMarkerSignature(generatedDir, "sess-1", tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tampered or forged/);
  });

  it("rejects a tampered approvedBy even with the original signature (payload/signature mismatch)", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    const tampered = { ...signed, approvedBy: "attacker" };
    const r = verifyMarkerSignature(generatedDir, "sess-1", tampered);
    expect(r.ok).toBe(false);
  });

  // Review LOW 1 (harness/f9485cc7): a signing-key I/O failure (permission
  // error, disk issue) must be classified DISTINCTLY from an actual
  // tampered/forged signature — it's a fail-closed error, not evidence of
  // an attack. Simulated deterministically by replacing the key file with
  // a directory at the same path: getOrCreateSigningKey's readFileSync
  // then throws EISDIR (not ENOENT), which is NOT swallowed.
  it("classifies a signing-key I/O failure as kind:'key-unavailable', not a forged signature", () => {
    const signed = signMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "op",
    });
    // Confirm it verifies BEFORE breaking the key, so the failure below is
    // attributable to the key becoming unavailable, not some other bug.
    expect(verifyMarkerSignature(generatedDir, "sess-1", signed as unknown as Record<string, unknown>).ok).toBe(true);
    const keyPath = signingKeyPathFor(generatedDir);
    fs.rmSync(keyPath, { force: true });
    fs.mkdirSync(keyPath); // a directory at the key's path: readFileSync throws EISDIR
    const r = verifyMarkerSignature(generatedDir, "sess-1", signed as unknown as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("key-unavailable");
      expect(r.reason).toMatch(/signing key unavailable/);
    }
  });
});
