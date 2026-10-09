import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIGNING_KEY_BASENAME,
  signingKeyPathFor,
} from "../../src/runtime/approval-signing.js";

describe("signingKeyPathFor", () => {
  it("is a sibling of the other state directly under generatedDir", () => {
    const generatedDir = path.join("/tmp", "harness.generated");
    expect(signingKeyPathFor(generatedDir)).toBe(path.join(generatedDir, SIGNING_KEY_BASENAME));
    expect(SIGNING_KEY_BASENAME).toBe(".approval-signing.key");
  });
});
