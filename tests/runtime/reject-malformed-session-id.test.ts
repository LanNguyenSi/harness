import { describe, it, expect } from "vitest";
import { rejectMalformedSessionId } from "../../src/runtime/reject-malformed-session-id.js";

describe("rejectMalformedSessionId", () => {
  it("throws on empty or blank strings", () => {
    expect(() => rejectMalformedSessionId("")).toThrow("sessionId is empty or blank");
    expect(() => rejectMalformedSessionId("   ")).toThrow("sessionId is empty or blank");
  });

  it("throws on path-separator or traversal characters", () => {
    expect(() => rejectMalformedSessionId("a/b")).toThrow();
    expect(() => rejectMalformedSessionId("a\\b")).toThrow();
    expect(() => rejectMalformedSessionId("..")).toThrow();
    expect(() => rejectMalformedSessionId("../x")).toThrow();
    expect(() => rejectMalformedSessionId("x/..")).toThrow();
  });

  it("does not throw on valid session ids", () => {
    expect(() => rejectMalformedSessionId("0f8e1c2a-1111-2222-3333-444455556666")).not.toThrow();
    expect(() => rejectMalformedSessionId("abc123")).not.toThrow();
  });
});
