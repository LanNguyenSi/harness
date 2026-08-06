import { describe, expect, it } from "vitest";
import {
  GIT_GLOBAL_BOOLEAN_FLAGS,
  GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES,
  GIT_GLOBAL_VALUE_FLAGS,
  GIT_TOKEN_RE,
} from "../../src/runtime/git-global-options.js";

// Task 5b5d1022, review round 2, Rule 6 (LOW): these four exports are
// consumed by TWO different modules (`command-normalize.ts`'s
// canonicalization peeling, `read-only-bash.ts`'s read-only DECISION,
// including its Rules 1-3b forfeiture/strict-subset checks) that no longer
// import from each other. A silent name removal or typo here (e.g.
// dropping `--namespace` from `GIT_GLOBAL_VALUE_FLAGS`) would silently
// narrow BOTH consumers' behaviour at once with no compiler error (a
// `ReadonlySet<string>` doesn't change shape) and no other test would
// necessarily catch it, since each consumer's own tests exercise specific
// commands, not this module's exact membership. Pin exact SIZE and CONTENT
// per exported set so a silent removal fails loud, here, at the source.
describe("git-global-options: exported set/regex content pins (task 5b5d1022, review round 2, Rule 6)", () => {
  it("GIT_GLOBAL_VALUE_FLAGS: exact size and membership", () => {
    expect(GIT_GLOBAL_VALUE_FLAGS.size).toBe(5);
    expect([...GIT_GLOBAL_VALUE_FLAGS].sort()).toEqual(
      ["-C", "-c", "--git-dir", "--namespace", "--work-tree"].sort(),
    );
  });

  it("GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES: exact size and membership", () => {
    expect(GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES.size).toBe(4);
    expect([...GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES].sort()).toEqual(
      ["--exec-path", "--git-dir", "--namespace", "--work-tree"].sort(),
    );
  });

  it("GIT_GLOBAL_BOOLEAN_FLAGS: exact size and membership", () => {
    expect(GIT_GLOBAL_BOOLEAN_FLAGS.size).toBe(6);
    expect([...GIT_GLOBAL_BOOLEAN_FLAGS].sort()).toEqual(
      ["--exec-path", "--literal-pathspecs", "--no-pager", "--no-replace-objects", "--paginate", "-p"].sort(),
    );
  });

  it("GIT_TOKEN_RE: exact source, and its documented match/no-match shape", () => {
    // Pins the exact pattern text, not just behaviour on a few samples —
    // a source change here silently re-derives every behavioural sample
    // below too, so the source pin is the one that actually catches a
    // rewrite that happens to preserve today's sampled cases.
    expect(GIT_TOKEN_RE.source).toBe("^(?:\\S*\\/)?git$");
    // Deliberately BROAD (unlike read-only-bash.ts's own narrower binary
    // regex): matches bare `git` and ANY path-qualified spelling,
    // relative or absolute — this is command-normalize.ts's
    // canonicalization regex, untouched by task 5b5d1022's review round 2.
    for (const bin of ["git", "/usr/bin/git", "./git", "bin/git", "../git"]) {
      expect(GIT_TOKEN_RE.test(bin)).toBe(true);
    }
    for (const bin of ["mygit", "git-foo", "gitk"]) {
      expect(GIT_TOKEN_RE.test(bin)).toBe(false);
    }
  });
});
