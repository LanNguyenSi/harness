import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIGNING_KEY_BASENAME,
  sha256Hex,
  signingKeyPathFor,
} from "../../src/runtime/approval-signing.js";

describe("signingKeyPathFor", () => {
  it("is a sibling of the other state directly under generatedDir", () => {
    const generatedDir = path.join("/tmp", "harness.generated");
    expect(signingKeyPathFor(generatedDir)).toBe(path.join(generatedDir, SIGNING_KEY_BASENAME));
    expect(SIGNING_KEY_BASENAME).toBe(".approval-signing.key");
  });
});

describe("sha256Hex", () => {
  it("matches a known digest", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("is deterministic and content-sensitive", () => {
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
