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
      // bash substitutes and yields `prod`; the value stops at the `(`
      // metacharacter instead. Still not covered, just differently: the
      // point of the pin is that no substitution happens.
      expect(parseBashPrefix("A=$(echo prod) cmd").inlineEnv).toEqual({ A: "$" });
    });

    it("treats an unquoted backslash-newline as a line continuation, like the double-quoted run does", () => {
      // bash drops both characters. `scanDoubleQuoted` already did; the
      // unquoted run did not, which made multi-line commands parse
      // differently depending on whether the value was quoted.
      expect(parseBashPrefix("A=postgres://prod\\\n-host/db cmd").inlineEnv).toEqual({
        A: "postgres://prod-host/db",
      });
      expect(parseBashPrefix('A="postgres://prod\\\n-host/db" cmd').inlineEnv).toEqual({
        A: "postgres://prod-host/db",
      });
      expect(parseBashPrefix("cd /pro\\\nd && terraform destroy").cdTarget).toBe("/prod");
    });

    it("ends a value at an UNQUOTED separator, the way bash does", () => {
      // bash reads `A=x` and then runs `cd /prod && rm`. Before round 3
      // the value swallowed the following `cd` (`{A:"x;cd"}`, master does
      // this too), which is what made a later `cd` look like a prefix.
      const r = parseBashPrefix("A=x;cd /prod && rm");
      expect(r.inlineEnv).toEqual({ A: "x" });
      // bash runs `cd /prod && rm` in the same shell and directory, so
      // the target IS a prefix of the gated command and must be seen.
      // Round 3 lost this (the cursor parked on the `;` and
      // `consumeLeadingCd`'s skipWs does not skip a metacharacter),
      // which turned `A=x; cd PROD && terraform destroy` from block into
      // allow while the command really ran in production.
      expect(r.cdTarget).toBe("/prod");
    });

    it("finds a leading cd after a separator the value stopped on (round-3 regression pin)", () => {
      // Measured at the real hook: each of these blocked on master,
      // blocked before round 3, and was ALLOWED by round 3 while a PATH
      // shim showed the command executing in the production repo.
      for (const cmd of [
        "A=x; cd /prod && rm",
        "A=x&& cd /prod && rm",
        "A=prod; cd /prod ; rm",
        "A='a b'; cd /prod && rm",
      ]) {
        expect(parseBashPrefix(cmd).cdTarget).toBe("/prod");
      }
    });

    it("does NOT step over a separator that changes shell or stream", () => {
      // Load-bearing restriction. `;` and `&&` keep the next command in
      // the same shell and directory; `|`, `&`, `(`, `<`, `>` start a
      // subshell or a redirection, so a `cd` behind them is not a prefix
      // of the gated command. Stepping over these is exactly how the
      // round-2 phantom class arose — bash never enters the directory.
      for (const cmd of [
        "A=x|y cd /prod ; rm",
        "A=x&y cd /prod ; rm",
        "A=x(y cd /prod ; rm",
        "A=x>o cd /prod ; rm",
        "A=x<i cd /prod ; rm",
        "A=x||y cd /prod ; rm",
      ]) {
        expect(parseBashPrefix(cmd).cdTarget).toBe(null);
      }
    });

    it("ends the value at every unquoted metacharacter, not just the separator", () => {
      for (const sep of [";", "&", "|", "(", ")", "<", ">"]) {
        expect(parseBashPrefix(`A=x${sep}y cmd`).inlineEnv).toEqual({ A: "x" });
      }
      // Quoted, the same characters are ordinary text.
      expect(parseBashPrefix("A='x;y|z' cmd").inlineEnv).toEqual({ A: "x;y|z" });
      expect(parseBashPrefix('A="x&y(z" cmd').inlineEnv).toEqual({ A: "x&y(z" });
    });

    it("reports NO cd target where bash never enters the directory (phantom class, closed)", () => {
      // The dangerous half of the cdTarget lever. Because cdTarget
      // REPLACES the resolver's git context, a phantom target
      // declassifies a production action: measured at the real hook,
      // `A='';: cd DECOY ; terraform destroy` used to be allowed while
      // terraform executed in the PRODUCTION repo. bash ends the
      // assignment word at the metacharacter and runs `:` / `y`, never
      // entering the directory, so the honest answer is null.
      //
      // This pin previously asserted the opposite; it moved deliberately
      // in round 3 (operator-authorised, see 03-decisions.md).
      expect(parseBashPrefix("A='';: cd /decoy ; terraform destroy").cdTarget).toBe(null);
      expect(parseBashPrefix("A='a b';y cd /decoy ; terraform destroy").cdTarget).toBe(null);
      expect(parseBashPrefix('A="a b">y cd /decoy ; rm').cdTarget).toBe(null);
      // This spelling was a phantom on MASTER as well, so round 3 closes
      // a pre-existing bypass rather than only the one it introduced.
      expect(parseBashPrefix("A=x||y cd /decoy ; terraform destroy").cdTarget).toBe(null);
    });

    it("pins the cd target that REPLACES the resolver's git context", () => {
      // This is the coupling that made the fix two-directional. A
      // non-null cdTarget does not ADD to the resolver's inputs, it
      // SWAPS the git context (`resolverGit`, src/cli/policy/intercept.ts
      // :515-524), so recovering the target can also point the resolver
      // at a NON-production repo the command genuinely cd's into.
      // Measured: five spellings including this one went from BLOCK on
      // master to allow. Kept because bash really does cd there and three
      // sibling spellings already behaved this way; pinned because the
      // next accuracy gain here widens the same lever (task 98ad072f).
      expect(parseBashPrefix("A=a\\ b cd /prod && terraform destroy").cdTarget).toBe("/prod");
      expect(parseBashPrefix('A="say \\"hi\\"" cd /prod && terraform destroy').cdTarget).toBe(
        "/prod",
      );
      expect(parseBashPrefix("cd /esc\\ aped && terraform destroy").cdTarget).toBe("/esc aped");
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

    it("uses the same null-prototype carrier on the degenerate return path", () => {
      // The early return for empty / non-string input used a plain `{}`,
      // so a lookup's meaning depended on WHICH return the caller got.
      expect(parseBashPrefix("").inlineEnv["toString"]).toBeUndefined();
      expect(parseBashPrefix("   \t  ").inlineEnv["toString"]).toBeUndefined();
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(undefined).inlineEnv["toString"]).toBeUndefined();
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
