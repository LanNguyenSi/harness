import { describe, expect, it } from "vitest";
import { parseBashPrefix } from "../../src/runtime/bash-prefix-parse.js";

describe("parseBashPrefix", () => {
  describe("inline env", () => {
    it("parses a single VAR=value prefix", () => {
      const r = parseBashPrefix("DATABASE_URL=postgres://prod terraform destroy");
      expect(r.inlineEnv).toEqual({ DATABASE_URL: "postgres://prod" });
      expect(r.cdTarget).toBe(null);
    });

    it("parses multiple chained assignments", () => {
      const r = parseBashPrefix("A=1 B=2 C=3 ./run");
      expect(r.inlineEnv).toEqual({ A: "1", B: "2", C: "3" });
    });

    it("supports single-quoted values verbatim", () => {
      const r = parseBashPrefix("URL='postgres://prod-host/db?x=y' cmd");
      expect(r.inlineEnv).toEqual({ URL: "postgres://prod-host/db?x=y" });
    });

    it("supports double-quoted values without $ interpolation", () => {
      const r = parseBashPrefix('URL="postgres://prod-host/$x" cmd');
      expect(r.inlineEnv).toEqual({ URL: "postgres://prod-host/$x" });
    });

    it("returns empty when the command does not start with VAR=", () => {
      const r = parseBashPrefix("terraform destroy");
      expect(r.inlineEnv).toEqual({});
    });

    it("bails cleanly on an unterminated quoted value", () => {
      const r = parseBashPrefix("URL='unterminated terraform destroy");
      expect(r.inlineEnv).toEqual({});
    });

    it("accepts tab-separated assignments and empty values", () => {
      const r = parseBashPrefix("A=\tB= C=v\tcmd");
      expect(r.inlineEnv).toEqual({ A: "", B: "", C: "v" });
    });
  });

  describe("cd prefix", () => {
    it("parses cd <abs-path> && rest", () => {
      const r = parseBashPrefix("cd /tmp/risk-gate-test && terraform destroy");
      expect(r.cdTarget).toBe("/tmp/risk-gate-test");
    });

    it("parses cd <path>; rest", () => {
      const r = parseBashPrefix("cd /tmp/x; terraform destroy");
      expect(r.cdTarget).toBe("/tmp/x");
    });

    it("supports quoted paths with spaces", () => {
      const r = parseBashPrefix('cd "/tmp/risk gate" && terraform destroy');
      expect(r.cdTarget).toBe("/tmp/risk gate");
    });

    it("returns null when cd is missing the separator", () => {
      const r = parseBashPrefix("cd /tmp/risk-gate-test terraform destroy");
      expect(r.cdTarget).toBe(null);
    });

    it("does not match commands that merely START with 'cd' (cdex, cd&&)", () => {
      expect(parseBashPrefix("cdex /tmp && rm").cdTarget).toBe(null);
      expect(parseBashPrefix("cd&& rm").cdTarget).toBe(null);
    });

    it("does not match pushd (out of scope in v1)", () => {
      expect(parseBashPrefix("pushd /tmp/x && rm").cdTarget).toBe(null);
    });
  });

  describe("combined prefixes", () => {
    it("parses inline-env then cd in either order", () => {
      const a = parseBashPrefix("A=1 cd /tmp/x && terraform destroy");
      expect(a.inlineEnv).toEqual({ A: "1" });
      expect(a.cdTarget).toBe("/tmp/x");

      const b = parseBashPrefix("cd /tmp/x && A=1 terraform destroy");
      expect(b.inlineEnv).toEqual({ A: "1" });
      expect(b.cdTarget).toBe("/tmp/x");
    });

    it("captures inline-env even when a later cd does not parse", () => {
      const r = parseBashPrefix("A=1 cd /tmp/x terraform");
      expect(r.inlineEnv).toEqual({ A: "1" });
      expect(r.cdTarget).toBe(null);
    });

    it("captures only the first cd target", () => {
      const r = parseBashPrefix("cd /tmp/x && cd /tmp/y && rm");
      expect(r.cdTarget).toBe("/tmp/x");
    });
  });

  // Task b093911d. Every case below was measured against the built
  // master parser first (all wrong there, see the run log) and against
  // real bash for the expected value. The point of the class is that
  // these are ordinary operator spellings, not adversarial input: each
  // one used to hand the risk-gate resolver a truncated value, a lost
  // `cd` target, or both — which is the fail-open direction, since the
  // resolver SEARCHES for production indicators.
  describe("quoting and backslash escapes (b093911d)", () => {
    it("keeps an escaped double quote inside a double-quoted value, and the cd target with it", () => {
      const r = parseBashPrefix('A="say \\"hi\\"" cd /prod && terraform destroy');
      expect(r.inlineEnv).toEqual({ A: 'say "hi"' });
      expect(r.cdTarget).toBe("/prod");
    });

    it("handles the '\\'' apostrophe idiom as three runs, not as an escape", () => {
      const r = parseBashPrefix("A='it'\\''s fine' cd /prod && terraform destroy");
      expect(r.inlineEnv).toEqual({ A: "it's fine" });
      expect(r.cdTarget).toBe("/prod");
    });

    it("joins chained quoted and unquoted runs into one word", () => {
      const r = parseBashPrefix("A='a b'\"c d\"e cd /prod && rm");
      expect(r.inlineEnv).toEqual({ A: "a bc de" });
      expect(r.cdTarget).toBe("/prod");
    });

    it("treats a backslash-escaped space in an unquoted value as part of the value", () => {
      const r = parseBashPrefix("A=a\\ b cd /prod && terraform destroy");
      expect(r.inlineEnv).toEqual({ A: "a b" });
      expect(r.cdTarget).toBe("/prod");
    });

    it("unescapes a doubled backslash inside double quotes", () => {
      const r = parseBashPrefix('A="prod\\\\" cd /x && rm');
      expect(r.inlineEnv).toEqual({ A: "prod\\" });
      expect(r.cdTarget).toBe("/x");
    });

    it("strips a backslash only before the characters bash strips it for", () => {
      // `\b` is not escapable inside double quotes, so both characters stay.
      const r = parseBashPrefix('A="a\\b$x" cmd');
      expect(r.inlineEnv).toEqual({ A: "a\\b$x" });
    });

    it("finds a cd target whose path carries an escaped space", () => {
      expect(parseBashPrefix("cd /pro\\ d && terraform destroy").cdTarget).toBe("/pro d");
    });

    it("finds a cd target whose quoted path carries an escaped quote", () => {
      expect(parseBashPrefix('cd "/tmp/a\\"b" && rm').cdTarget).toBe('/tmp/a"b');
    });

    it("does not let a separator inside a quoted cd path end the path", () => {
      expect(parseBashPrefix('cd "/tmp/a;b" && rm').cdTarget).toBe("/tmp/a;b");
      expect(parseBashPrefix("cd '/tmp/a&b' && rm").cdTarget).toBe("/tmp/a&b");
    });

    it("closes an ANSI-C $'...' run at the unescaped quote", () => {
      const r = parseBashPrefix("A=$'don\\'t' cd /prod && terraform destroy");
      expect(r.inlineEnv).toEqual({ A: "don't" });
      expect(r.cdTarget).toBe("/prod");
    });

    it("treats $\"...\" like a double-quoted run", () => {
      const r = parseBashPrefix('A=$"prod" cd /x && rm');
      expect(r.inlineEnv).toEqual({ A: "prod" });
      expect(r.cdTarget).toBe("/x");
    });

    it("keeps falling through on input with no determinable word boundary", () => {
      // Unterminated quote of each kind, plus a dangling backslash. The
      // resolver's process-env / hook-cwd fallback is the intended state
      // here; there is no boundary to be right about.
      expect(parseBashPrefix('A="unterminated cd /prod && rm')).toEqual({
        inlineEnv: {},
        cdTarget: null,
      });
      expect(parseBashPrefix("A=$'unterminated cd /prod && rm")).toEqual({
        inlineEnv: {},
        cdTarget: null,
      });
      expect(parseBashPrefix("A=x\\")).toEqual({ inlineEnv: {}, cdTarget: null });
      expect(parseBashPrefix("cd '/unterminated && rm")).toEqual({
        inlineEnv: {},
        cdTarget: null,
      });
    });

    it("keeps an earlier well-formed assignment when a later one is unparsable", () => {
      const r = parseBashPrefix("A=1 B='unterminated cd /prod && rm");
      expect(r.inlineEnv).toEqual({ A: "1" });
      expect(r.cdTarget).toBe(null);
    });

    // Named non-coverage. These are documented limits, not defects; the
    // pins exist so a future change notices when it moves one of them.
    it("does NOT decode ANSI-C escapes beyond the ones that move the boundary", () => {
      // bash would yield a real newline here, and `prod` for \x70rod.
      expect(parseBashPrefix("A=$'a\\nb' cmd").inlineEnv).toEqual({ A: "a\\nb" });
      expect(parseBashPrefix("A=$'\\x70rod' cmd").inlineEnv).toEqual({ A: "\\x70rod" });
    });

    it("does NOT interpolate parameters or command substitutions", () => {
      expect(parseBashPrefix('A="$HOME/prod" cmd').inlineEnv).toEqual({ A: "$HOME/prod" });
      expect(parseBashPrefix("A=$(echo prod) cmd").inlineEnv).toEqual({ A: "$(echo" });
    });

    it("does NOT treat an UNQUOTED separator as ending the value (pre-existing, unchanged)", () => {
      // bash would read `A=x` and then run `cd /prod && rm`. Both before and
      // after this task the value swallows the following `cd`, so the cd
      // target is lost. Measured identical on master — not caused by this
      // change and not closed by it. Pinned so the gap is a known quantity
      // rather than a surprise, and so a future fix has to move this line.
      // Structurally the same family as task cf3dff51 (a boundary character
      // that the scanner does not treat as a boundary), one module over.
      const r = parseBashPrefix("A=x;cd /prod && rm");
      expect(r.inlineEnv).toEqual({ A: "x;cd" });
      expect(r.cdTarget).toBe(null);
    });
  });

  describe("__proto__ as a variable name (b093911d)", () => {
    it("keeps a __proto__ assignment as an own property instead of dropping it", () => {
      const r = parseBashPrefix("__proto__=/prod cd /x && terraform destroy");
      expect(Object.keys(r.inlineEnv)).toEqual(["__proto__"]);
      expect(r.inlineEnv["__proto__"]).toBe("/prod");
    });

    it("survives the spread the risk-gate resolver input is built with", () => {
      // Mirrors `resolverEnv` in src/cli/policy/intercept.ts: the parsed
      // assignments are spread over the ambient env, and the resolver then
      // does `inputs.env[name]` + `value.includes(pattern)`. A prototype
      // hit there is not a string, so the signal would be skipped.
      const { inlineEnv } = parseBashPrefix("__proto__=postgres://prod cmd");
      const ambient: Record<string, string> = { PATH: "/usr/bin" };
      const resolverEnv: Record<string, string> = { ...ambient, ...inlineEnv };
      expect(typeof resolverEnv["__proto__"]).toBe("string");
      expect(resolverEnv["__proto__"]).toContain("prod");
    });

    it("still resolves other reserved-looking names as before", () => {
      const r = parseBashPrefix("constructor=/prod cd /x && rm");
      expect(r.inlineEnv["constructor"]).toBe("/prod");
      expect(r.cdTarget).toBe("/x");
    });

    it("does not report inherited Object.prototype members as parsed variables", () => {
      const r = parseBashPrefix("terraform destroy");
      expect(r.inlineEnv["toString"]).toBeUndefined();
      expect(r.inlineEnv["hasOwnProperty"]).toBeUndefined();
    });
  });

  describe("degenerate input", () => {
    it("returns empty for empty / whitespace-only command", () => {
      expect(parseBashPrefix("")).toEqual({ inlineEnv: {}, cdTarget: null });
      expect(parseBashPrefix("   \t  ")).toEqual({ inlineEnv: {}, cdTarget: null });
    });

    it("returns empty for non-string input", () => {
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(undefined)).toEqual({ inlineEnv: {}, cdTarget: null });
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(null)).toEqual({ inlineEnv: {}, cdTarget: null });
    });
  });
});
