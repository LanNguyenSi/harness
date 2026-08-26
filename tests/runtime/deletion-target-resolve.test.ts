// Task d03af8f6 — static deletion-target resolver unit tests.

import { describe, expect, it } from "vitest";
import { resolveDeletionTarget } from "../../src/runtime/deletion-target-resolve.js";

const ROOTS = ["/tmp", "/private/tmp"];

describe("resolveDeletionTarget — recognition", () => {
  it("returns null for a non-deletion command", () => {
    expect(resolveDeletionTarget("ls -la /tmp", ROOTS)).toBeNull();
    expect(resolveDeletionTarget("git status", ROOTS)).toBeNull();
    expect(resolveDeletionTarget("echo rm -rf /", ROOTS)).toBeNull();
  });

  it("returns null for a bare rm with neither -r nor -f", () => {
    expect(resolveDeletionTarget("rm /tmp/scratch/foo", ROOTS)).toBeNull();
  });

  it("returns null for rm -rf with no target operand", () => {
    expect(resolveDeletionTarget("rm -rf", ROOTS)).toBeNull();
  });

  it("returns null for git clean without a force flag (git itself refuses)", () => {
    expect(resolveDeletionTarget("git clean -n", ROOTS)).toBeNull();
    expect(resolveDeletionTarget("git clean", ROOTS)).toBeNull();
  });

  it("returns null for find without -delete", () => {
    expect(resolveDeletionTarget("find /tmp/scratch -name '*.log'", ROOTS)).toBeNull();
  });

  it("recognizes rm -rf, rm -fr, and separated -r -f", () => {
    for (const cmd of ["rm -rf /tmp/x", "rm -fr /tmp/x", "rm -r -f /tmp/x"]) {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.verb).toBe("rm");
    }
  });

  it("recognizes rm with only -r or only -f", () => {
    expect(resolveDeletionTarget("rm -r /tmp/x", ROOTS)?.verb).toBe("rm");
    expect(resolveDeletionTarget("rm -f /tmp/x", ROOTS)?.verb).toBe("rm");
  });

  it("recognizes find ... -delete", () => {
    const v = resolveDeletionTarget("find /tmp/scratch -delete", ROOTS);
    expect(v?.verb).toBe("find");
  });

  it("recognizes git clean -f and combined short flags", () => {
    expect(resolveDeletionTarget("git clean -f", ROOTS)?.verb).toBe("git-clean");
    expect(resolveDeletionTarget("git clean -fdx", ROOTS)?.verb).toBe("git-clean");
    expect(resolveDeletionTarget("git clean --force", ROOTS)?.verb).toBe("git-clean");
  });

  it("recognizes a deletion verb even when it is NOT the first chained segment (review round 2, HIGH 1)", () => {
    // Round-1 scope claimed "a dangerous tail after && is covered by the
    // existing dangerous-shell classifier" — measured WRONG in dev
    // context: that classifier only feeds the production-scoped
    // gate-prod-destructive* policies, so on a task branch this ran
    // ungated. Every shell segment is now inspected.
    const v = resolveDeletionTarget("echo hi && rm -rf /home/x", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });
});

describe("resolveDeletionTarget — AC1: absolute path outside the allowlist", () => {
  it("classifies rm -rf against a path outside every safe root as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf /home/user/project/some-dir", ROOTS);
    expect(v).not.toBeNull();
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["/home/user/project/some-dir"]);
  });
});

describe("resolveDeletionTarget — AC2: absolute path inside a declared safe root", () => {
  it("classifies rm -rf against a path inside /tmp as resolved (allow)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/scratch/foo", ROOTS);
    expect(v).not.toBeNull();
    expect(v?.unresolvable).toBe(false);
    expect(v?.unresolvedTargets).toEqual([]);
  });

  it("classifies rm -rf against the root itself, a trailing-slash root, and a bare-glob root as UNRESOLVABLE (review round 2, MEDIUM root-itself fix)", () => {
    // Round 1 wrongly treated the root path ITSELF as resolved — a
    // target must now be STRICTLY deeper than a declared root.
    expect(resolveDeletionTarget("rm -rf /tmp", ROOTS)?.unresolvable).toBe(true);
    expect(resolveDeletionTarget("rm -rf /tmp/", ROOTS)?.unresolvable).toBe(true);
    expect(resolveDeletionTarget("rm -rf /tmp/*", ROOTS)?.unresolvable).toBe(true);
    expect(resolveDeletionTarget("rm -rf /tmp/**", ROOTS)?.unresolvable).toBe(true);
  });

  it("does not treat a sibling directory sharing the root's prefix as inside it", () => {
    // /tmpfoo must not match root /tmp via a naive substring/startsWith
    // check without the trailing "/" boundary.
    const v = resolveDeletionTarget("rm -rf /tmpfoo/bar", ROOTS);
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — AC3: unresolvable-target fixtures", () => {
  it("classifies an unexpanded shell variable target as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf $X/foo", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["$X/foo"]);
  });

  it("classifies a braced shell variable target as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf ${SCRATCH_DIR}/cache", ROOTS);
    expect(v?.unresolvable).toBe(true);
  });

  it("classifies a relative path target as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf scratch-files", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["scratch-files"]);
  });

  it("classifies a traversal that normalizes outside every root as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/scratch/../../home/lan/x", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["/tmp/scratch/../../home/lan/x"]);
  });

  it("does not gate a traversal that normalizes back inside a root (no over-blocking)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/a/../b", ROOTS);
    expect(v?.unresolvable).toBe(false);
  });

  it("classifies a shell variable target NESTED INSIDE a safe root as unresolvable — the only discriminating case for the $ guard (review round 2, MEDIUM surviving-mutant fix)", () => {
    // Without this fixture, deleting the `token.includes("$")` guard
    // entirely is invisible to the suite: /tmp/$X's parent /tmp is
    // itself inside the allowlist, so a mutant that resolves purely by
    // prefix match (ignoring the unexpanded variable) would still pass
    // every OTHER test in this file.
    const v = resolveDeletionTarget("rm -rf /tmp/$X", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["/tmp/$X"]);
  });

  it("classifies a ~-relative target as unresolvable (covered by the relative-path check, no separate ~ branch)", () => {
    const v = resolveDeletionTarget("rm -rf ~/x", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["~/x"]);
  });

  it("classifies a -- -delimited, flag-shaped relative target as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf -- -weird-dir", ROOTS);
    expect(v?.targets).toEqual(["-weird-dir"]);
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — find and git clean target extraction", () => {
  it("defaults find's implicit target to cwd (relative) when no path operand is given", () => {
    const v = resolveDeletionTarget("find -delete", ROOTS);
    expect(v?.targets).toEqual(["."]);
    expect(v?.unresolvable).toBe(true);
  });

  it("resolves find's explicit path operand against the allowlist", () => {
    expect(resolveDeletionTarget("find /tmp/scratch -delete", ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("find /home/x -delete", ROOTS)?.unresolvable).toBe(true);
  });

  it("defaults git clean's implicit target to cwd (relative) when no pathspec is given", () => {
    const v = resolveDeletionTarget("git clean -f", ROOTS);
    expect(v?.targets).toEqual(["."]);
    expect(v?.unresolvable).toBe(true);
  });

  it("resolves git clean's explicit pathspec against the allowlist", () => {
    expect(resolveDeletionTarget("git clean -f /tmp/scratch", ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("git clean -f /home/x", ROOTS)?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — cd/env prefix composition (a7eb1a71 style)", () => {
  it("recognizes rm after a leading cd prefix, target resolved against the allowlist", () => {
    const v = resolveDeletionTarget("cd /tmp/scratch && rm -rf ./stale", ROOTS);
    // "./stale" is relative and therefore unresolvable regardless of cd.
    expect(v?.unresolvable).toBe(true);
  });

  it("recognizes rm after a leading inline-env prefix", () => {
    const v = resolveDeletionTarget("FOO=bar rm -rf /home/x", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — multiple targets", () => {
  it("flags unresolvable when only some targets are outside the allowlist", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/a /home/b", ROOTS);
    expect(v?.targets).toEqual(["/tmp/a", "/home/b"]);
    expect(v?.unresolvedTargets).toEqual(["/home/b"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("does not flag when every target is inside the allowlist", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/a /private/tmp/b", ROOTS);
    expect(v?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — edge inputs", () => {
  it("never throws on empty or non-string input", () => {
    expect(resolveDeletionTarget("", ROOTS)).toBeNull();
  });

  it("respects an operator-overridden, non-default allowlist", () => {
    const v = resolveDeletionTarget("rm -rf /var/scratch/x", ["/var/scratch"]);
    expect(v?.unresolvable).toBe(false);
  });

  it("gates every absolute target when the allowlist is empty", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x", []);
    expect(v?.unresolvable).toBe(true);
  });

  it("strips a trailing /** glob-sugar suffix from a root before matching", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x", ["/tmp/**"]);
    expect(v?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — multi-segment recognition (review round 2, HIGH 1)", () => {
  it("recognizes a deletion verb behind a newline-separated statement", () => {
    const v = resolveDeletionTarget("S=/tmp/x\nrm -rf $S/dogfood", ROOTS);
    expect(v?.verb).toBe("rm");
    // $S/dogfood is unresolvable regardless (unexpanded variable) — the
    // point of this fixture is that the segment is recognized AT ALL.
    expect(v?.unresolvable).toBe(true);
  });

  it("recognizes a deletion verb in the middle of a &&-chained statement, and the target set covers every recognized segment", () => {
    const v = resolveDeletionTarget("T=/tmp/a && rm -rf $T && mkdir -p $T", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    // Only the rm segment is a recognized deletion verb — "T=/tmp/a" and
    // "mkdir -p $T" are not.
    expect(v?.targets).toEqual(["$T"]);
  });

  it("still gates a deletion verb even when it is not the first chained segment", () => {
    const v = resolveDeletionTarget("echo hi && rm -rf /home/x", ROOTS);
    expect(v?.unresolvable).toBe(true);
  });

  it("combines multiple recognized deletion segments: unresolvable if ANY is, resolved only if ALL are", () => {
    const bothSafe = resolveDeletionTarget("rm -rf /tmp/a && rm -rf /tmp/b", ROOTS);
    expect(bothSafe?.unresolvable).toBe(false);
    expect(bothSafe?.targets).toEqual(["/tmp/a", "/tmp/b"]);

    const oneUnsafe = resolveDeletionTarget("rm -rf /tmp/a && rm -rf /home/b", ROOTS);
    expect(oneUnsafe?.unresolvable).toBe(true);
    expect(oneUnsafe?.targets).toEqual(["/tmp/a", "/home/b"]);
    expect(oneUnsafe?.unresolvedTargets).toEqual(["/home/b"]);
  });

  it("does not misrecognize a plain read-only chained command", () => {
    expect(resolveDeletionTarget("echo hi && ls -la /tmp", ROOTS)).toBeNull();
  });
});

describe("resolveDeletionTarget — wrapper-head peeling (review round 2, MEDIUM wrapper-heads fix)", () => {
  it.each([
    ["sudo rm -rf /home/x", "sudo"],
    ["doas rm -rf /home/x", "doas"],
    ["command rm -rf /home/x", "command"],
    ["time rm -rf /home/x", "time"],
    ["nice rm -rf /home/x", "nice"],
    ["env X=1 rm -rf /home/x", "env with an inline assignment"],
    ["timeout 5 rm -rf /home/x", "timeout with a duration arg"],
    ["sudo env X=1 timeout 5 rm -rf /home/x", "a composed wrapper chain"],
  ])("peels %s (%s) and still recognizes the wrapped rm", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });

  it("accepts a path-qualified rm head", () => {
    const v = resolveDeletionTarget("/bin/rm -rf /home/x", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });

  it("canonicalizes git -C <path> clean -f* to the git-clean head via segmentViewOf", () => {
    const v = resolveDeletionTarget("git -C /repo clean -fdx", ROOTS);
    expect(v?.verb).toBe("git-clean");
    expect(v?.unresolvable).toBe(true); // implicit "." target, relative
  });

  it("does not peel xargs into a false rm recognition when xargs wraps a non-deletion command", () => {
    expect(resolveDeletionTarget("xargs echo hi", ROOTS)).toBeNull();
  });
});

describe("resolveDeletionTarget — xargs-wrapped deletion (review round 2, MEDIUM wrapper-heads fix)", () => {
  it("gates `xargs rm -rf` (no explicit operand — the real target comes from stdin, never statically knowable)", () => {
    const v = resolveDeletionTarget("xargs rm -rf", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });

  it("still resolves an EXPLICIT operand normally when one is given after xargs rm -rf", () => {
    const safe = resolveDeletionTarget("xargs rm -rf /tmp/known", ROOTS);
    expect(safe?.unresolvable).toBe(false);
    const unsafe = resolveDeletionTarget("xargs rm -rf /home/x", ROOTS);
    expect(unsafe?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — decodeShellWord, obfuscated flags (review round 2, LOW (b))", () => {
  it("recognizes find ... -delete hidden behind an ANSI-C escape", () => {
    const v = resolveDeletionTarget("find /home/x $'\\x2ddelete'", ROOTS);
    expect(v?.verb).toBe("find");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });

  it("recognizes git clean -f hidden behind an ANSI-C escape", () => {
    const v = resolveDeletionTarget("git clean $'\\x2df'", ROOTS);
    expect(v?.verb).toBe("git-clean");
    expect(v?.unresolvable).toBe(true); // implicit "." target
  });
});

// Task d03af8f6, review round 3: the recognition surface was rebuilt on
// top of command-normalize.ts's shared, flag-aware peelers and both of
// its segmentation arms (BOUNDARY_RE + AMP_BOUNDARY_RE). Every shape
// named in the orchestrator's pin list below was measured as a live
// false negative under the round-2 module before this rewrite.
describe("resolveDeletionTarget — review round 3: flag-aware wrapper peeling (reused from command-normalize.ts)", () => {
  it.each([
    ["sudo -u root rm -rf /home/x", "/home/x"],
    ["sudo -E rm -rf /x", "/x"],
    ["sudo --preserve-env rm -rf /home/x", "/home/x"],
    ["nice -n 10 rm -rf /x", "/x"],
    ["nice -10 rm -rf /home/x", "/home/x"],
    ["env -i rm -rf /x", "/x"],
    ["env -u FOO rm -rf /home/x", "/home/x"],
    ["timeout -k 5 10 rm -rf /home/x", "/home/x"],
    ["timeout --signal=KILL 5 rm -rf /x", "/x"],
    ["exec rm -rf /home/x", "/home/x"],
  ])("recognizes %s (round-2 peeler stopped at the wrapper's flag)", (cmd, target) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toContain(target);
  });

  it("recognizes nohup rm -rf ... & (trailing background marker never becomes a spurious target)", () => {
    const v = resolveDeletionTarget("nohup rm -rf /home/x &", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets.every((t) => t === "/home/x")).toBe(true);
    expect(v?.targets.length).toBeGreaterThan(0);
  });
});

describe("resolveDeletionTarget — review round 3: bare-& background jobs via the amp-aware segmentation arm", () => {
  it("recognizes a deletion verb after a bare & (background job, not a chain BOUNDARY_RE splits on)", () => {
    const v = resolveDeletionTarget("echo hi & rm -rf /home/x", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });
});

describe("resolveDeletionTarget — review round 3: brace group", () => {
  it("recognizes a deletion verb inside a { ...; } brace group", () => {
    const v = resolveDeletionTarget("{ rm -rf /home/x; }", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });
});

describe("resolveDeletionTarget — review round 3: subshell trailing )", () => {
  it("recognizes a deletion verb inside a (...) subshell, stripping the trailing paren from the target", () => {
    const v = resolveDeletionTarget("(rm -rf /home/x)", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });
});

describe("resolveDeletionTarget — review round 3: xargs flag peeling (round 2 peeled only the bare xargs token)", () => {
  it("peels xargs's own short flag and recognizes the wrapped rm with a redirected stdin operand stripped", () => {
    const v = resolveDeletionTarget("xargs -0 rm -rf < list", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });

  it("peels xargs -n1 and recognizes the wrapped rm with no explicit operand", () => {
    const v = resolveDeletionTarget("xargs -n1 rm -rf", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });

  it("recognizes a piped find | xargs -0 rm -rf, the find segment itself unrecognized (no -delete)", () => {
    const v = resolveDeletionTarget("find /home -print0 | xargs -0 rm -rf", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — review round 3: find -exec/-execdir rm recognition (MEDIUM C1)", () => {
  it("recognizes find <path> -exec rm -rf {} + as a deletion, targeting find's own search path (not {})", () => {
    const v = resolveDeletionTarget("find /home -exec rm -rf {} +", ROOTS);
    expect(v?.verb).toBe("find");
    expect(v?.targets).toEqual(["/home"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("recognizes find <path> -execdir rm {} \\; the same way", () => {
    const v = resolveDeletionTarget("find /home -execdir rm {} \\;", ROOTS);
    expect(v?.verb).toBe("find");
    expect(v?.targets).toEqual(["/home"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("still returns null for find -exec of a non-deletion command", () => {
    expect(resolveDeletionTarget("find /home -exec echo {} +", ROOTS)).toBeNull();
  });

  it("resolves find -exec rm when the search path is inside the allowlist", () => {
    const v = resolveDeletionTarget("find /tmp/scratch -exec rm -rf {} +", ROOTS);
    expect(v?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — review round 3: redirection operands are never targets (MEDIUM C2)", () => {
  it("does not treat /dev/null (and the merged fd) as targets — rm -rf /tmp/x >/dev/null 2>&1 is ALLOWED", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x >/dev/null 2>&1", ROOTS);
    expect(v?.unresolvable).toBe(false);
    expect(v?.targets).not.toContain("/dev/null");
  });

  it("gates rm -rf /home/x >/dev/null with targets == [\"/home/x\"] only", () => {
    const v = resolveDeletionTarget("rm -rf /home/x >/dev/null", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });

  it("drops a whitespace-separated redirection target too (bare operator form)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x > /dev/null", ROOTS);
    expect(v?.unresolvable).toBe(false);
    expect(v?.targets).not.toContain("/dev/null");
  });
});

describe("resolveDeletionTarget — review round 3: find search-root equality resolves, rm keeps strictly-deeper (MEDIUM C3)", () => {
  it("resolves find /tmp -name '*.log' -delete (root operand EQUALS the declared root) as ALLOWED", () => {
    const v = resolveDeletionTarget("find /tmp -name '*.log' -delete", ROOTS);
    expect(v?.unresolvable).toBe(false);
  });

  it("gates find / -delete (root operand is the filesystem root, not a declared safe root)", () => {
    const v = resolveDeletionTarget("find / -delete", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/"]);
  });

  it("still gates rm -rf /tmp (rm keeps the strictly-deeper rule — equality does not resolve for rm)", () => {
    expect(resolveDeletionTarget("rm -rf /tmp", ROOTS)?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — review round 3: NOT COVERED residuals (pinned ceiling, not a regression if still null)", () => {
  it.each([
    ["bash -c 'rm -rf /home/x'"],
    ["sh -c 'rm -rf /home/x'"],
    ['eval "rm -rf /home/x"'],
    ["sh script.sh"],
    ["bash script.sh"],
    ["shred /home/x"],
    ["rmdir /home/x"],
    ["unlink /home/x"],
    ["npm run clean"],
  ])("%s is NOT recognized (documented ceiling)", (cmd) => {
    expect(resolveDeletionTarget(cmd, ROOTS)).toBeNull();
  });
});
