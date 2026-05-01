import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionId } from "../../src/runtime/session-id.js";

describe("resolveSessionId", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = savedEnv;
    }
  });

  it("returns the explicit argument when given", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveSessionId("explicit-id")).toBe("explicit-id");
  });

  it("falls back to CLAUDE_SESSION_ID when no explicit argument is given", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveSessionId()).toBe("env-id");
  });

  it("returns 'default' when neither explicit nor env is set", () => {
    expect(resolveSessionId()).toBe("default");
    expect(resolveSessionId(undefined)).toBe("default");
  });

  it("treats an empty string explicit argument as not provided", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveSessionId("")).toBe("env-id");
  });

  it("treats an empty CLAUDE_SESSION_ID env as not provided", () => {
    process.env.CLAUDE_SESSION_ID = "";
    expect(resolveSessionId()).toBe("default");
  });

  it("treats an empty explicit + empty env as 'default'", () => {
    process.env.CLAUDE_SESSION_ID = "";
    expect(resolveSessionId("")).toBe("default");
  });
});
