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

  describe("git switch/checkout branch (task 341e024b)", () => {
    it("parses `git switch <branch> && rest`", () => {
      const r = parseBashPrefix("git switch main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("parses `git checkout <branch> && rest`", () => {
      const r = parseBashPrefix("git checkout main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("parses `git switch <branch>; rest` (semicolon separator)", () => {
      const r = parseBashPrefix("git switch main; rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("supports slashed branch names", () => {
      const r = parseBashPrefix("git switch task/foo && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("task/foo");
    });

    it("skips an optional leading `-C <path>`", () => {
      const r = parseBashPrefix("git -C /some/repo switch main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("does not treat `git checkout -- <path>` (file restore) as a branch signal", () => {
      const r = parseBashPrefix("git checkout -- src/foo.ts && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess a `$VAR` branch name", () => {
      const r = parseBashPrefix("git switch $BRANCH && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess a `${VAR}` branch name", () => {
      const r = parseBashPrefix("git switch ${BRANCH} && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess `git checkout -` (previous branch)", () => {
      const r = parseBashPrefix("git checkout - && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess a branch-creation flag as a branch name", () => {
      expect(parseBashPrefix("git switch -c newbranch && rm").branchTarget).toBe(null);
      expect(parseBashPrefix("git checkout -b newbranch && rm").branchTarget).toBe(null);
    });

    it("returns null when the separator is missing (nothing to gate)", () => {
      const r = parseBashPrefix("git switch main rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not match commands that merely START with 'git' (github, gitk)", () => {
      expect(parseBashPrefix("github switch main && rm").branchTarget).toBe(null);
      expect(parseBashPrefix("gitk switch main && rm").branchTarget).toBe(null);
    });

    it("does not match a bare 'checkout'/'switch' without a leading 'git'", () => {
      expect(parseBashPrefix("switch main && rm").branchTarget).toBe(null);
      expect(parseBashPrefix("checkout main && rm").branchTarget).toBe(null);
    });

    // Fix round 1 (reviewer MEDIUM finding, task 341e024b): a quoted
    // branch name used to be read INCLUDING the quote characters
    // (`branchTarget` = the 6-char string `"main"`), which never matches
    // a `branch_patterns` entry like `main` and silently defeated the
    // gate. The quoted forms must now strip the quotes.
    it("strips double quotes from a quoted branch literal", () => {
      const r = parseBashPrefix('git switch "main" && rm -rf /tmp/x');
      expect(r.branchTarget).toBe("main");
    });

    it("strips single quotes from a quoted branch literal", () => {
      const r = parseBashPrefix("git switch 'main' && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("strips quotes from a quoted branch literal with `git checkout`", () => {
      expect(parseBashPrefix('git checkout "main" && rm -rf /tmp/x').branchTarget).toBe(
        "main",
      );
      expect(parseBashPrefix("git checkout 'main' && rm -rf /tmp/x").branchTarget).toBe(
        "main",
      );
    });

    it("strips quotes from a quoted, slashed branch literal", () => {
      expect(parseBashPrefix('git switch "task/foo" && rm').branchTarget).toBe("task/foo");
      expect(parseBashPrefix("git switch 'task/foo' && rm").branchTarget).toBe("task/foo");
    });

    it("handles a quoted branch literal after a leading `-C <path>`", () => {
      const r = parseBashPrefix('git -C /some/repo switch "main" && rm -rf /tmp/x');
      expect(r.branchTarget).toBe("main");
    });

    it("does not guess a `$VAR` branch name inside double quotes", () => {
      expect(parseBashPrefix('git switch "$BRANCH" && rm').branchTarget).toBe(null);
      expect(parseBashPrefix('git switch "${BRANCH}" && rm').branchTarget).toBe(null);
      expect(parseBashPrefix('git switch "release/$X" && rm').branchTarget).toBe(null);
    });

    it("takes a `$`-containing single-quoted branch literally (single quotes never interpolate)", () => {
      // Deliberately different from the double-quoted case above: real
      // bash never interpolates inside single quotes, so the literal
      // text — however unusual as a branch name — is exactly what git
      // would receive. It simply will not match a normal
      // `branch_patterns` entry.
      expect(parseBashPrefix("git switch '$BRANCH' && rm").branchTarget).toBe("$BRANCH");
    });

    it("bails cleanly on an unterminated quoted branch literal", () => {
      expect(parseBashPrefix("git switch \"main && rm -rf /tmp/x").branchTarget).toBe(null);
      expect(parseBashPrefix("git switch 'main && rm -rf /tmp/x").branchTarget).toBe(null);
    });

    it("does not match an empty quoted branch literal", () => {
      expect(parseBashPrefix('git switch "" && rm').branchTarget).toBe(null);
      expect(parseBashPrefix("git switch '' && rm").branchTarget).toBe(null);
    });

    it("requires the trailing separator for a quoted branch literal too", () => {
      expect(parseBashPrefix('git switch "main" rm -rf /tmp/x').branchTarget).toBe(null);
    });

    it("captures only the first branch target across a chained double switch (first-switch-wins, documented limit)", () => {
      // Deliberately NOT resolving the second switch — see the module
      // doc's "LIMIT" note on `consumeLeadingGitSwitch`. This pins the
      // current (first-wins) behavior so a future change to it is a
      // conscious, reviewed decision rather than an accidental drift.
      const r = parseBashPrefix("git switch dev && git switch main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("dev");
    });
  });

  // Backslash escapes and chained quote runs (task b093911d). Expected values
  // are what real bash produces for the same word (`VAR=<word> printenv VAR`,
  // `cd <word>`), recorded when the cases were written; they are fixed
  // literals here so the suite never spawns a shell.
  describe("backslash escapes and chained quote runs (task b093911d)", () => {
    describe("inline env values", () => {
      it('keeps an escaped quote inside a double-quoted value (VAR="say \\"hi\\"") and still finds the cd that follows', () => {
        const r = parseBashPrefix('VAR="say \\"hi\\"" cd /tmp && echo done');
        expect(r.inlineEnv).toEqual({ VAR: 'say "hi"' });
        expect(r.cdTarget).toBe("/tmp");
      });

      it("keeps a doubled backslash before the closing double quote as ONE backslash", () => {
        // bash: VAR="a\\" -> a\
        const r = parseBashPrefix('VAR="a\\\\" cd /tmp && x');
        expect(r.inlineEnv).toEqual({ VAR: "a\\" });
        expect(r.cdTarget).toBe("/tmp");
      });

      it("decodes \\$ and \\` inside double quotes but keeps a backslash before any other character", () => {
        expect(parseBashPrefix('VAR="a\\$b" cmd').inlineEnv).toEqual({ VAR: "a$b" });
        expect(parseBashPrefix('VAR="a\\`b" cmd').inlineEnv).toEqual({ VAR: "a`b" });
        // bash: VAR="a\qb" -> a\qb
        expect(parseBashPrefix('VAR="a\\qb" cmd').inlineEnv).toEqual({ VAR: "a\\qb" });
      });

      it("takes single quotes literally: a backslash is just a character there", () => {
        expect(parseBashPrefix("VAR='a\\b' cmd").inlineEnv).toEqual({ VAR: "a\\b" });
        // bash: VAR='a\' closes at the second quote -> a\
        const r = parseBashPrefix("VAR='a\\' cd /tmp && x");
        expect(r.inlineEnv).toEqual({ VAR: "a\\" });
        expect(r.cdTarget).toBe("/tmp");
      });

      it("reads the '\\'' idiom as one word (VAR='it'\\''s fine' -> it's fine)", () => {
        const r = parseBashPrefix("VAR='it'\\''s fine' cmd");
        expect(r.inlineEnv).toEqual({ VAR: "it's fine" });
        expect("VAR='it'\\''s fine' cmd".slice(r.remainderStart)).toBe("cmd");
      });

      it("keeps the cd target by-design null for `VAR='it'\\''s fine' cd /tmp` (no separator), but not the value", () => {
        const r = parseBashPrefix("VAR='it'\\''s fine' cd /tmp");
        expect(r.inlineEnv).toEqual({ VAR: "it's fine" });
        expect(r.cdTarget).toBe(null);
      });

      it("treats a backslash before a space as part of the value (VAR=a\\ b -> a b)", () => {
        const cmd = "VAR=a\\ b cmd";
        const r = parseBashPrefix(cmd);
        expect(r.inlineEnv).toEqual({ VAR: "a b" });
        expect(cmd.slice(r.remainderStart)).toBe("cmd");
      });

      it("decodes an escaped quote and an escaped backslash in an unquoted value", () => {
        expect(parseBashPrefix('VAR=a\\"b cmd').inlineEnv).toEqual({ VAR: 'a"b' });
        expect(parseBashPrefix("VAR=a\\\\b cmd").inlineEnv).toEqual({ VAR: "a\\b" });
      });

      it("keeps a trailing backslash as a literal backslash and does not throw", () => {
        // bash -c 'VAR=a\' sets VAR to a\
        expect(() => parseBashPrefix("VAR=a\\")).not.toThrow();
        expect(parseBashPrefix("VAR=a\\").inlineEnv).toEqual({ VAR: "a\\" });
        expect(parseBashPrefix("A=1 VAR=\\").inlineEnv).toEqual({ A: "1", VAR: "\\" });
      });

      it("joins adjacent quote runs into one value (bash: 'a b'\"c d\" -> a bc d)", () => {
        expect(parseBashPrefix("VAR='a b'\"c d\" cmd").inlineEnv).toEqual({ VAR: "a bc d" });
        // bash reads A='x'B=1 as ONE assignment A=xB=1, not two.
        expect(parseBashPrefix("A='x'B=1 cmd").inlineEnv).toEqual({ A: "xB=1" });
      });

      it("falls through on a quote with no closing quote at all, without throwing", () => {
        for (const cmd of ["VAR='abc cmd", 'VAR="abc cmd', "VAR='a'\"b cmd", "VAR=a\\' 'b"]) {
          expect(() => parseBashPrefix(cmd)).not.toThrow();
        }
        expect(parseBashPrefix("VAR='abc cmd")).toEqual({
          inlineEnv: {},
          cdTarget: null,
          branchTarget: null,
          remainderStart: 0,
        });
        expect(parseBashPrefix('VAR="abc cmd').inlineEnv).toEqual({});
      });

      it("keeps the pre-escape-aware reading when the only closing quote is an escaped one (bash rejects the command)", () => {
        // `VAR="abc\" cd /x && y` is an unterminated string for bash. The
        // gate must not LOSE what the old first-quote reading extracted
        // from it, so that reading is the documented fall-back.
        const r = parseBashPrefix('VAR="abc\\" cd /x && y');
        expect(r.inlineEnv).toEqual({ VAR: "abc\\" });
        expect(r.cdTarget).toBe("/x");
      });

      it("does NOT decode ANSI-C $'...' (explicitly not covered): the raw word is kept", () => {
        expect(parseBashPrefix("VAR=$'a\\tb' cmd").inlineEnv).toEqual({ VAR: "$'a\\tb'" });
        expect(parseBashPrefix("VAR=$'it\\'s' cmd").inlineEnv).toEqual({ VAR: "$'it\\'s'" });
      });

      it("does NOT treat ; & | as ending a PLAIN env value (pre-existing reading, unchanged, not covered)", () => {
        expect(parseBashPrefix("A=1;B=2 cmd").inlineEnv).toEqual({ A: "1;B=2" });
        expect(parseBashPrefix("A=x|| cd /t && y").cdTarget).toBe("/t");
      });

      it("ends a value that STARTS with a quote at an unquoted shell operator, so the cd behind || or | is not read as a leading cd", () => {
        // bash: `A='a b' || cd /t` skips the cd (short circuit), `A='a b' | cd /t` runs it in a pipeline subshell.
        for (const op of ["||", "|", ";", "&&", "&"]) {
          for (const head of ["A='a b'", 'A="a b"']) {
            const cmd = `${head}${op} cd /t && y`;
            const r = parseBashPrefix(cmd);
            expect(r.inlineEnv, cmd).toEqual({ A: "a b" });
            expect(r.cdTarget, cmd).toBe(null);
            expect(cmd.slice(r.remainderStart).startsWith(op), cmd).toBe(true);
          }
        }
      });

      it("keeps swallowing a single | or & in an env word that carries an escape but does not start with a quote (old reading, so a later assignment is still found)", () => {
        const r = parseBashPrefix('V=\\"& W=/tmp cmd');
        expect(r.inlineEnv).toEqual({ V: '"&', W: "/tmp" });
        // bash: `V=\"| W=x cmd` runs `cmd` with W=x in the pipeline's right side
        const piped = parseBashPrefix('V=\\"| W=x cmd');
        expect(piped.inlineEnv).toEqual({ V: '"|', W: "x" });
      });

      it("keeps swallowing an unquoted || in an escape-led or mid-quote env word, so a later honest clause bash runs after the short circuit is still reached", () => {
        // bash: the pure assignment on the left of || succeeds, the right side
        // `D='dev'` is skipped, and `git checkout release/1.2` runs after the `;`.
        const r = parseBashPrefix("A=&'&'||D='dev'; git checkout release/1.2 && T");
        expect(r.branchTarget).toBe("release/1.2");
        expect(r.inlineEnv).toEqual({ A: "&&||D=dev;" });
      });

      it("residual, not covered: an escape-led or mid-quote env word swallows ||, so the cd behind it is read as a leading one (phantom, same as the plain A=x|| spelling)", () => {
        // bash skips the cd after a successful pure assignment on the left of ||.
        // The walk-level fix (stop at ||, never read a cd after |) is a separate follow-up.
        const heads: Array<[string, string]> = [
          ["A=a\\ b", "a b||"],
          ['A=x"a b"', "xa b||"],
          ['V=\\"', '"||'],
        ];
        for (const [head, value] of heads) {
          const cmd = `${head}|| cd /t && y`;
          const r = parseBashPrefix(cmd);
          expect(r.cdTarget, cmd).toBe("/t");
          expect(Object.values(r.inlineEnv), cmd).toEqual([value]);
          expect(cmd.slice(r.remainderStart), cmd).toBe("y");
        }
        // the plain twin reads the same phantom cd on the pre-change parser
        expect(parseBashPrefix("A=x|| cd /t && y").cdTarget).toBe("/t");
        // a single | behind an escape-led word is swallowed the same way
        expect(parseBashPrefix("A=a\\ b| cd /t && y").cdTarget).toBe("/t");
      });

      it("residual, not covered: a mid-quote env word swallows an unquoted ;, so a later backgrounded assignment of the same name is read as leading and overrides the value bash keeps", () => {
        // bash: `D=a"b c"; D=dev&T` runs `D=dev` in the background, T sees `ab c`.
        const r = parseBashPrefix('D=postgres://prod-host"/db x"; D=dev&T');
        expect(r.inlineEnv).toEqual({ D: "dev&T" });
        // the plain twin reads the same override on the pre-change parser
        expect(parseBashPrefix("D=/srv/prod; D=dev&T").inlineEnv).toEqual({ D: "dev&T" });
      });

      it("drops a backslash-newline line continuation outside quotes (bash: VAR=pro\\<NL>d -> prod)", () => {
        const cmd = "VAR=pro\\\nd cmd";
        const r = parseBashPrefix(cmd);
        expect(r.inlineEnv).toEqual({ VAR: "prod" });
        expect(cmd.slice(r.remainderStart)).toBe("cmd");
      });

      it("drops a backslash-newline line continuation inside double quotes (bash: VAR=\"pro\\<NL>d\" -> prod)", () => {
        const cmd = 'VAR="pro\\\nd" cmd';
        const r = parseBashPrefix(cmd);
        expect(r.inlineEnv).toEqual({ VAR: "prod" });
        expect(cmd.slice(r.remainderStart)).toBe("cmd");
      });

      it("skips an escaped quote inside ANSI-C $'...' (raw text kept, not decoded) so the cd behind it is still read", () => {
        // bash: D=$'it\'s' -> it's. Not decoded here (not covered): the raw
        // word is kept. The tail carries an escaped apostrophe: a reader that
        // ended the ANSI-C part at the escaped quote would pair the real
        // closing quote with it and swallow the cd into the value.
        const cmd = "D=$'it\\'s' cd /x && echo a\\'b";
        const r = parseBashPrefix(cmd);
        expect(r.inlineEnv).toEqual({ D: "$'it\\'s'" });
        expect(r.cdTarget).toBe("/x");
        expect(cmd.slice(r.remainderStart)).toBe("echo a\\'b");
      });

      it("falls back to the plain word reading on an unterminated ANSI-C $'...' (bash rejects it), without throwing", () => {
        const cmd = "VAR=$'abc cmd";
        expect(() => parseBashPrefix(cmd)).not.toThrow();
        const r = parseBashPrefix(cmd);
        expect(r.inlineEnv).toEqual({ VAR: "$'abc" });
        expect(cmd.slice(r.remainderStart)).toBe("cmd");
      });

      it("keeps `$VAR` inside a double-quoted value as literal text (v1, unchanged)", () => {
        expect(parseBashPrefix('VAR="a\\"$x" cmd').inlineEnv).toEqual({ VAR: 'a"$x' });
      });
    });

    describe("assignments to names that exist on Object.prototype", () => {
      it("keeps `__proto__=/prod` instead of dropping it, and the cd that follows", () => {
        const r = parseBashPrefix("__proto__=/prod cd /x && terraform destroy");
        expect(Object.keys(r.inlineEnv)).toEqual(["__proto__"]);
        expect(Object.getOwnPropertyDescriptor(r.inlineEnv, "__proto__")?.value).toBe("/prod");
        expect(r.cdTarget).toBe("/x");
        // a spread into a plain env object (what the resolver does) keeps it as an own key
        const merged = { ...{ PATH: "/bin" }, ...r.inlineEnv };
        expect(Object.keys(merged).sort()).toEqual(["PATH", "__proto__"]);
      });

      it("still keeps `constructor=` and `toString=` assignments", () => {
        const r = parseBashPrefix("constructor=x toString=y cmd");
        expect(Object.keys(r.inlineEnv).sort()).toEqual(["constructor", "toString"]);
        expect(r.inlineEnv.constructor).toBe("x");
        expect(r.inlineEnv.toString).toBe("y");
      });

      it("does not inherit anything from Object.prototype (a missing name reads as undefined)", () => {
        const r = parseBashPrefix("A=1 cmd");
        expect(Object.getPrototypeOf(r.inlineEnv)).toBe(null);
        expect(r.inlineEnv.constructor).toBeUndefined();
        expect(parseBashPrefix("").inlineEnv.hasOwnProperty).toBeUndefined();
      });
    });

    describe("cd path", () => {
      it("reads an escaped quote inside a double-quoted path", () => {
        expect(parseBashPrefix('cd "/tmp/a\\"b" && x').cdTarget).toBe('/tmp/a"b');
      });

      it("reads the '\\'' idiom in a path", () => {
        expect(parseBashPrefix("cd '/tmp/it'\\''s' && x").cdTarget).toBe("/tmp/it's");
      });

      it("reads a backslash before a space in an unquoted path as part of the path", () => {
        const cmd = "cd /tmp/my\\ dir && x";
        const r = parseBashPrefix(cmd);
        expect(r.cdTarget).toBe("/tmp/my dir");
        expect(cmd.slice(r.remainderStart).trim()).toBe("x");
      });

      it("does not end an unquoted path at an escaped ; or &", () => {
        expect(parseBashPrefix("cd /tmp/a\\;b && x").cdTarget).toBe("/tmp/a;b");
        expect(parseBashPrefix("cd /tmp/a\\&b && x").cdTarget).toBe("/tmp/a&b");
      });

      it("joins adjacent quote runs in a path", () => {
        expect(parseBashPrefix("cd '/tmp/a'\"b c\" && x").cdTarget).toBe("/tmp/ab c");
      });

      it("keeps a trailing backslash on an unterminated command without throwing", () => {
        expect(() => parseBashPrefix("cd /tmp/x\\")).not.toThrow();
        expect(parseBashPrefix("cd /tmp/x\\").cdTarget).toBe(null);
      });

      it("falls through on an unterminated quoted path, and keeps the old reading when only an escaped quote is left", () => {
        expect(parseBashPrefix('cd "/tmp/x && y').cdTarget).toBe(null);
        expect(parseBashPrefix("cd '/tmp/x && y").cdTarget).toBe(null);
        // bash rejects `cd "/tmp/x\" && y`; the first-quote reading is kept so nothing extracted before is lost
        expect(parseBashPrefix('cd "/tmp/x\\" && y').cdTarget).toBe("/tmp/x\\");
      });

      it("keeps reading a PLAIN path up to whitespace, ; or & only (pre-existing, not covered): | < > ( ) stay in it", () => {
        expect(parseBashPrefix("cd /tmp/x|cat && y").cdTarget).toBe("/tmp/x|cat");
        expect(parseBashPrefix("cd /tmp/x>o && y").cdTarget).toBe("/tmp/x>o");
      });

      it("reads a path that carries no quote or escape before its ; as a plain path even when a quote follows the ;", () => {
        // bash runs `cd /tmp/x | y` here (a pipeline); the plain reading
        // (ended at ; or & only) takes `/tmp/x|y` as the target. Unchanged
        // from before, not covered: the quote behind the ; must not turn
        // this into a quote-bearing word that ends at the |.
        const cmd = 'cd /tmp/x|y;"z" && w';
        const r = parseBashPrefix(cmd);
        expect(r.cdTarget).toBe("/tmp/x|y");
        expect(cmd.slice(r.remainderStart)).toBe('"z" && w');
      });

      it("ends a path that carries a quote or an escape at an unquoted | < > ( )", () => {
        expect(parseBashPrefix('cd "/tmp/x"|cat && y').cdTarget).toBe(null);
        expect(parseBashPrefix("cd /tmp/a\\ b|cat && y").cdTarget).toBe(null);
      });

      it("keeps today's cd targets for the plain shapes (no escape involved)", () => {
        expect(parseBashPrefix('cd "/tmp/risk gate" && x').cdTarget).toBe("/tmp/risk gate");
        expect(parseBashPrefix("cd '/tmp/risk gate'; x").cdTarget).toBe("/tmp/risk gate");
        expect(parseBashPrefix("cd /tmp/x&&x").cdTarget).toBe("/tmp/x");
        expect(parseBashPrefix("cd /tmp/x;x").cdTarget).toBe("/tmp/x");
      });
    });

    describe("git switch/checkout branch token", () => {
      it("reads an escaped quote and the '\\'' idiom in a quoted branch", () => {
        expect(parseBashPrefix('git switch "ma\\"in" && x').branchTarget).toBe('ma"in');
        expect(parseBashPrefix("git switch 'it'\\''s' && x").branchTarget).toBe("it's");
      });

      it("treats an escaped $ in a double-quoted branch as a literal dollar, an unescaped one as unresolved", () => {
        expect(parseBashPrefix('git switch "a\\$b" && x').branchTarget).toBe("a$b");
        expect(parseBashPrefix('git switch "a$b" && x').branchTarget).toBe(null);
      });

      it("reads a backslash before a space in an unquoted branch as part of the token", () => {
        expect(parseBashPrefix("git switch feat\\ x && y").branchTarget).toBe("feat x");
      });

      it("keeps the pre-change branch reading when a `$` sits in a double-quoted part of a word that does not start with a quote (release/\"$V\")", () => {
        // bash expands $V here, so the branch is unknown; the old reading
        // kept the raw word, which still matches a `release/*` pattern, and
        // went on to the clauses behind it. Returning null dropped them all.
        const cases: Array<[string, string]> = [
          ['git switch release/"$V" && rm', 'release/"$V"'],
          ['git checkout release/"${VERSION}" && rm', 'release/"${VERSION}"'],
          ['git switch release/v"$V" && rm', 'release/v"$V"'],
          ["git switch release/'x'\"$V\" && rm", "release/'x'\"$V\""],
        ];
        for (const [cmd, branch] of cases) {
          const r = parseBashPrefix(cmd);
          expect(r.branchTarget, cmd).toBe(branch);
          expect(cmd.slice(r.remainderStart), cmd).toBe("rm");
        }
      });

      it("keeps the cd and the kubectl remainder behind a mid-word `$` branch switch", () => {
        const cd = 'git switch feature/"$V" && cd /x && y';
        const r1 = parseBashPrefix(cd);
        expect(r1.branchTarget).toBe('feature/"$V"');
        expect(r1.cdTarget).toBe("/x");
        expect(cd.slice(r1.remainderStart).trim()).toBe("y");

        const kube = 'git switch feature/"$V" && kubectl --context prod-1 delete ns x';
        const r2 = parseBashPrefix(kube);
        expect(kube.slice(r2.remainderStart).trimStart().startsWith("kubectl --context prod-1")).toBe(true);

        // a `;` glued to the word ends it, as before
        const semi = 'git switch release/"$V"; cd /x && y';
        const r3 = parseBashPrefix(semi);
        expect(r3.branchTarget).toBe('release/"$V"');
        expect(r3.cdTarget).toBe("/x");
      });

      it("still leaves a branch word that STARTS with a quote and interpolates unresolved, with no clause consumed", () => {
        for (const cmd of [
          'git switch "$V" && rm',
          'git switch "release/$V" && rm',
          "git switch 'a'\"$V\" && rm",
          // escape-aware reading sees one word with a `$`; the old first-quote reading would end it at the escaped quote
          'git switch "a\\" && rm $V" && x',
        ]) {
          const r = parseBashPrefix(cmd);
          expect(r.branchTarget, cmd).toBe(null);
          expect(r.remainderStart, cmd).toBe(0);
        }
      });

      it("treats the old first-quote reading of a branch word as unresolved when it contains a `$` (quote not closable by the escape-aware read)", () => {
        // `"ab$V\" && rm` has no unescaped closing quote for bash; the first-quote reading closes at the escaped quote and sees the `$`
        const r = parseBashPrefix('git switch "ab$V\\" && rm');
        expect(r.branchTarget).toBe(null);
        expect(r.remainderStart).toBe(0);
      });

      it("residual, not covered: an escaped ; keeps the branch word going, so the words behind it make the switch a no-separator clause (no branch)", () => {
        // bash: `git switch release/1.2\; cd dev && T` passes `release/1.2;`, `cd`, `dev` to git.
        const r = parseBashPrefix("git switch release/1.2\\; cd dev && T");
        expect(r.branchTarget).toBe(null);
        expect(r.remainderStart).toBe(0);
        // the plain twin (a branch word followed by more words) has no branch on the pre-change parser either
        expect(parseBashPrefix("git switch release/1 checkout main && T").branchTarget).toBe(null);
      });

      it("skips an escaped quote inside the `-C <path>` value", () => {
        expect(parseBashPrefix('git -C "/a\\"b" switch main && x').branchTarget).toBe("main");
      });

      it("falls through on an unterminated quoted branch, without throwing", () => {
        expect(() => parseBashPrefix('git switch "main && x')).not.toThrow();
        expect(parseBashPrefix('git switch "main && x').branchTarget).toBe(null);
      });
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

    it("parses a leading cd followed by a git switch (both candidates)", () => {
      const r = parseBashPrefix("cd /tmp/x && git switch main && rm -rf /tmp/x");
      expect(r.cdTarget).toBe("/tmp/x");
      expect(r.branchTarget).toBe("main");
    });
  });

  describe("degenerate input", () => {
    it("returns empty for empty / whitespace-only command", () => {
      expect(parseBashPrefix("")).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        remainderStart: 0,
      });
      expect(parseBashPrefix("   \t  ")).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        // Pure whitespace is fully consumed by the inline-env skip pass
        // even though it finds no VAR=value token, so the remainder starts
        // at the end of the string, not 0.
        remainderStart: 6,
      });
    });

    it("returns empty for non-string input", () => {
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(undefined)).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        remainderStart: 0,
      });
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(null)).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        remainderStart: 0,
      });
    });
  });

  describe("remainderStart (task a7eb1a71)", () => {
    it("is 0 when no prefix clause matches", () => {
      expect(parseBashPrefix("terraform destroy").remainderStart).toBe(0);
    });

    it("points right after a consumed cd prefix", () => {
      const cmd = "cd /tmp && kubectl delete namespace payments";
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after a consumed inline-env prefix", () => {
      const cmd = "KUBECONFIG=/tmp/k kubectl delete namespace payments";
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after both a cd and an inline-env prefix, in either order", () => {
      const a = "cd /tmp && KUBECONFIG=/tmp/k kubectl delete namespace payments";
      const b = "KUBECONFIG=/tmp/k cd /tmp && kubectl delete namespace payments";
      expect(a.slice(parseBashPrefix(a).remainderStart)).toBe("kubectl delete namespace payments");
      expect(b.slice(parseBashPrefix(b).remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after a consumed cd prefix with a quoted path", () => {
      const cmd = 'cd "/tmp/risk gate" && kubectl delete namespace payments';
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after a consumed git switch prefix", () => {
      const cmd = "git switch main && kubectl delete namespace payments";
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });
  });
});
