import { describe, expect, it } from "vitest";
import {
  redactString,
  resolveRedactionRules,
} from "../../../src/cli/session-export/redact.js";

describe("default regex denylist", () => {
  it("redacts the four obvious key/secret patterns", () => {
    const rules = resolveRedactionRules([], { env: {} });
    expect(redactString("AGENT_TASKS_TOKEN: at_abc123def", rules)).toContain("<REDACTED>");
    expect(redactString("password=hunter2", rules)).toContain("<REDACTED>");
    expect(redactString("SECRET: shhh", rules)).toContain("<REDACTED>");
    expect(redactString("api_key=sk-xyz", rules)).toContain("<REDACTED>");
    expect(redactString("api-key=sk-xyz", rules)).toContain("<REDACTED>");
  });

  it("does not redact unrelated text", () => {
    const rules = resolveRedactionRules([], { env: {} });
    expect(redactString("hello world", rules)).toBe("hello world");
    expect(redactString("a normal commit message", rules)).toBe("a normal commit message");
  });

  it("preserves the key prefix when redacting a value", () => {
    const rules = resolveRedactionRules([], { env: {} });
    expect(redactString("api_key=sk-xyz", rules)).toMatch(/api_key=<REDACTED>/);
  });
});

describe("manifest regex rules extend the default", () => {
  it("applies a custom regex on top of defaults", () => {
    const rules = resolveRedactionRules(
      [{ regex: "INTERNAL-[A-Z0-9]+", replacement: "<INT>" }],
      { env: {} },
    );
    expect(redactString("INTERNAL-ABC123 leak", rules)).toContain("<INT>");
    // default still applies in same string
    expect(redactString("token=foo INTERNAL-ABC", rules)).toContain("<REDACTED>");
  });
});

describe("env_var redaction", () => {
  it("string-replaces the actual env value at export time", () => {
    const rules = resolveRedactionRules([{ env_var: "AT_TOKEN", replacement: "<AT>" }], {
      env: { AT_TOKEN: "at_super_secret_xyz" },
    });
    expect(redactString("Authorization: Bearer at_super_secret_xyz", rules)).toContain("<AT>");
    expect(redactString("Authorization: Bearer at_super_secret_xyz", rules)).not.toContain(
      "at_super_secret_xyz",
    );
  });

  it("is a no-op when the env var is unset (no spurious redactions)", () => {
    const rules = resolveRedactionRules([{ env_var: "MISSING", replacement: "<X>" }], {
      env: {},
    });
    expect(redactString("nothing to see here", rules)).toBe("nothing to see here");
  });

  it("escapes regex metacharacters in env values", () => {
    const rules = resolveRedactionRules([{ env_var: "WEIRD", replacement: "<W>" }], {
      env: { WEIRD: "a.b*c+d?" },
    });
    expect(redactString("see a.b*c+d? leak", rules)).toContain("<W>");
    expect(redactString("see ABCD leak", rules)).toBe("see ABCD leak");
  });
});

describe("redactString on serialized JSON", () => {
  it("catches secrets inside nested object encodings", () => {
    const rules = resolveRedactionRules([], { env: {} });
    const json = JSON.stringify({
      args: [{ command: "ls" }, { token: "sk-secret-xyz" }],
      header: { Authorization: "password=hunter2" },
    });
    const out = redactString(json, rules);
    expect(out).not.toContain("sk-secret-xyz");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("<REDACTED>");
  });

  it("returns the input unchanged when no rules apply (no env, no manifest)", () => {
    const noRules: ReturnType<typeof resolveRedactionRules> = [];
    expect(redactString("hello world", noRules)).toBe("hello world");
  });
});
