import { describe, expect, it } from "vitest";
import { expandHome, expandHomeInEnv } from "../../src/io/expand-home.js";

const FAKE_HOME = "/home/test-user";

describe("expandHome", () => {
  it("returns bare `~` as the home dir", () => {
    expect(expandHome("~", FAKE_HOME)).toBe(FAKE_HOME);
  });

  it("expands a leading `~/`", () => {
    expect(expandHome("~/.evidence-ledger/ledger.db", FAKE_HOME)).toBe(
      "/home/test-user/.evidence-ledger/ledger.db",
    );
  });

  it("leaves an absolute path untouched", () => {
    expect(expandHome("/var/log/foo", FAKE_HOME)).toBe("/var/log/foo");
  });

  it("leaves an empty string untouched", () => {
    expect(expandHome("", FAKE_HOME)).toBe("");
  });

  it("does NOT expand a `~/` that is not at the start", () => {
    // Real-world false positives are vanishingly rare, but the contract
    // is leading-only; an embedded sequence stays literal.
    expect(expandHome("git@host:user/repo~/tag", FAKE_HOME)).toBe(
      "git@host:user/repo~/tag",
    );
  });

  it("does NOT expand `~user` (bare ~ followed by non-slash is literal)", () => {
    // POSIX `~user` is a different lookup (user's home, not current
    // operator's). This helper intentionally only handles the
    // current-operator case to avoid silently inventing semantics.
    expect(expandHome("~root/foo", FAKE_HOME)).toBe("~root/foo");
  });

  it("does NOT expand `${HOME}` shell-style interpolation", () => {
    // Out of scope by design; see expand-home.ts header comment.
    expect(expandHome("${HOME}/foo", FAKE_HOME)).toBe("${HOME}/foo");
  });

  it("defaults home to os.homedir() when no second arg is passed", () => {
    // Smoke against the real homedir: leading-`~/` must change shape.
    const out = expandHome("~/foo");
    expect(out).not.toBe("~/foo");
    expect(out.endsWith("/foo")).toBe(true);
  });
});

describe("expandHomeInEnv", () => {
  it("returns undefined when input is undefined", () => {
    expect(expandHomeInEnv(undefined, FAKE_HOME)).toBeUndefined();
  });

  it("returns an empty object when input is empty", () => {
    expect(expandHomeInEnv({}, FAKE_HOME)).toEqual({});
  });

  it("expands `~/` in every value while leaving keys untouched", () => {
    expect(
      expandHomeInEnv(
        {
          EVIDENCE_LEDGER_DB: "~/.evidence-ledger/ledger.db",
          ORACLE_SCAN_ROOT: "~/git",
          OTHER: "/already/absolute",
          API_KEY: "sk-no-tilde-here",
        },
        FAKE_HOME,
      ),
    ).toEqual({
      EVIDENCE_LEDGER_DB: "/home/test-user/.evidence-ledger/ledger.db",
      ORACLE_SCAN_ROOT: "/home/test-user/git",
      OTHER: "/already/absolute",
      API_KEY: "sk-no-tilde-here",
    });
  });

  it("does not mutate the input object", () => {
    const input = { FOO: "~/foo" };
    const out = expandHomeInEnv(input, FAKE_HOME);
    expect(input.FOO).toBe("~/foo"); // unchanged
    expect(out).not.toBe(input); // new object
  });
});
