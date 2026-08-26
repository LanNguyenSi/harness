// Task d03af8f6 — static deletion-target resolver unit tests.

import { describe, expect, it } from "vitest";
import { MAX_NORMALIZE_LENGTH } from "../../src/runtime/command-normalize.js";
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

  it("gates a traversal even when it lexically normalizes back inside a root (review round 6: `..` is physical, not lexical, through a symlinked component)", () => {
    // Round 1 resolved `/tmp/a/../b` as safe by lexical collapse. That
    // assumes `/tmp/a` is a real directory: if it is a symlink to
    // `/home/u/proj`, the kernel resolves `/tmp/a/..` as `/home/u`, and
    // the deletion lands OUTSIDE the root. A `..` component can never be
    // proven safe statically, so it is unresolvable for every verb.
    const v = resolveDeletionTarget("rm -rf /tmp/a/../b", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["/tmp/a/../b"]);
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

  it("gates an EXPLICIT operand after xargs rm -rf too (review round 6, D-023: xargs APPENDS stdin operands, so /tmp/known is not the only target)", () => {
    // Round 2 pinned `xargs rm -rf /tmp/known` as resolved. Measured
    // wrong in round 5: `echo /home/x | xargs rm -rf /tmp/known` runs
    // `rm -rf /tmp/known /home/x`. Any xargs-wrapped deletion is now
    // unresolvable without parsing xargs at all.
    const safeLooking = resolveDeletionTarget("xargs rm -rf /tmp/known", ROOTS);
    expect(safeLooking?.unresolvable).toBe(true);
    expect(safeLooking?.targets).toEqual(["(xargs-supplied target, not statically known)", "/tmp/known"]);
    expect(safeLooking?.unresolvedTargets).toEqual(safeLooking?.targets);
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

describe("resolveDeletionTarget — review round 5: find root-equality exception removed, every verb requires strictly-deeper (HIGH)", () => {
  it("gates find /tmp -name '*.log' -delete (root operand EQUALS the declared root — find has no exception any more)", () => {
    const v = resolveDeletionTarget("find /tmp -name '*.log' -delete", ROOTS);
    expect(v?.unresolvable).toBe(true);
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
    ["`rm -rf /home/x`"],
    // Review round 6 additions — each named in the module header's
    // NOT-COVERED list and docs/risk-gate.md "Known ceilings":
    ["env -S 'rm -rf /home/x'"],
    ["find /tmp/x -exec sh -c 'rm -rf /home/y' \\;"],
    ["find /home '(' -name a ')' -delete"],
    ['find /home "(" -name a ")" -delete'],
    ["case x in *) rm -rf /home/x;; esac"],
    ["parallel rm -rf"],
    ["ionice -c3 rm -rf /home/x"],
    ["flock /tmp/l rm -rf /home/x"],
    ["ssh h rm -rf /home/x"],
    ["docker exec c rm -rf /x"],
    ["chroot /x rm -rf /home"],
  ])("%s is NOT recognized (documented ceiling)", (cmd) => {
    expect(resolveDeletionTarget(cmd, ROOTS)).toBeNull();
  });

  it("names the out-of-band symlink and git-config ceilings as RESOLVED shapes it cannot see through (documented, not a regression)", () => {
    // A symlink `/tmp/link -> /home/u` named WITHOUT a trailing slash:
    // `/tmp/link/y` is lexically inside the root; only the filesystem
    // knows better. Same for a `clean.requireForce=false` set in the
    // repository config rather than on the command line.
    expect(resolveDeletionTarget("rm -rf /tmp/link/y", ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("git clean -d", ROOTS)).toBeNull();
  });
});

// Task d03af8f6, review round 4: fixes to the round-3 findings above.
describe("resolveDeletionTarget — review round 4: xargs separated-value flags (HIGH)", () => {
  it.each([
    ["xargs -I {} rm -rf {}", "/home/x"],
    ["xargs -n 1 rm -rf /home/x", "/home/x"],
    ["xargs -P 4 rm -rf /home/x", "/home/x"],
    ["xargs -a list rm -rf /home/x", "/home/x"],
    ["xargs -d '\\n' rm -rf /home/x", "/home/x"],
  ])("gates %s (round-3 peeler stranded the flag's separated value where the verb was expected)", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });

  it("gates find . -name '*.log' | xargs -I {} rm -rf {} on both segments", () => {
    const v = resolveDeletionTarget("find . -name '*.log' | xargs -I {} rm -rf {}", ROOTS);
    expect(v?.unresolvable).toBe(true);
    // The find segment itself is not recognized (no -delete/-exec), only
    // the xargs-wrapped rm segment is — but that segment alone must gate.
    expect(v?.verb).toBe("rm");
  });
});

describe("resolveDeletionTarget — review round 5: find root-equality exception removed (HIGH)", () => {
  it.each([
    "find /tmp -delete",
    "find /tmp -name '*.log' -delete",
    "find /tmp -maxdepth 1 -delete",
    "find /tmp -empty -delete",
    "find /tmp -type d -delete",
    "find /tmp -name x -o -delete",
    "find /tmp -maxdepth 1 -exec rm -rf {} +",
    "find /tmp -mindepth 1 -delete",
  ])("gates %s (target equals the declared root itself — no exception for find, same as rm)", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.unresolvable).toBe(true);
  });

  it.each(["find /tmp/scratch -name '*.log' -delete", "find /private/tmp/claude-501/s/x -delete"])(
    "allows %s (target strictly deeper than the declared root)",
    (cmd) => {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.unresolvable).toBe(false);
    },
  );
});

describe("resolveDeletionTarget — review round 4: stripRedirections is not inert (MEDIUM)", () => {
  it("allows find /tmp/scratch >out -name '*.log' -delete (redirection token stripped, not collected as a target)", () => {
    const v = resolveDeletionTarget("find /tmp/scratch >out -name '*.log' -delete", ROOTS);
    expect(v?.unresolvable).toBe(false);
    expect(v?.targets).not.toContain("out");
    expect(v?.targets).not.toContain(">out");
  });

  it("allows git clean -fd /tmp/x >/dev/null (redirection token stripped, not collected as a target)", () => {
    const v = resolveDeletionTarget("git clean -fd /tmp/x >/dev/null", ROOTS);
    expect(v?.unresolvable).toBe(false);
    expect(v?.targets).not.toContain("/dev/null");
  });
});

describe("resolveDeletionTarget — review round 4: &>/>& redirection forms (MEDIUM)", () => {
  it("allows rm -rf /tmp/x &>/dev/null (glued combined-redirect form)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x &>/dev/null", ROOTS);
    expect(v?.unresolvable).toBe(false);
    expect(v?.targets).not.toContain("&>/dev/null");
  });

  it("allows rm -rf /tmp/x >& out (bare combined-redirect form, whitespace-separated filename dropped too)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x >& out", ROOTS);
    expect(v?.unresolvable).toBe(false);
    expect(v?.targets).not.toContain("out");
  });
});

describe("resolveDeletionTarget — review round 4: verdict de-duplication (LOW (b))", () => {
  it("names /home/x once for nohup rm -rf /home/x &", () => {
    const v = resolveDeletionTarget("nohup rm -rf /home/x &", ROOTS);
    expect(v?.targets).toEqual(["/home/x"]);
  });

  it("names /tmp/x once for rm -rf /tmp/x 2>&1 | tee log", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x 2>&1 | tee log", ROOTS);
    expect(v?.targets).toEqual(["/tmp/x"]);
  });

  it("does not list rm as a target for rm -rf /home/x & rm -rf /home/y, and names each real target once", () => {
    const v = resolveDeletionTarget("rm -rf /home/x & rm -rf /home/y", ROOTS);
    expect(v?.targets).not.toContain("rm");
    expect(v?.targets).toEqual(["/home/x", "/home/y"]);
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — review round 5: xargs replace-string aliasing (MEDIUM, security)", () => {
  it.each(["xargs -I{} rm -rf /tmp/{}", "xargs -I% rm -rf /tmp/%", "find / -name x | xargs -I{} rm -rf /tmp/{}"])(
    "gates %s (the replace-string's runtime value is never statically known, even though the literal token starts with a safe root)",
    (cmd) => {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.unresolvable).toBe(true);
    },
  );

  it("cat list | xargs -I% rm -rf /tmp/% also gates", () => {
    const v = resolveDeletionTarget("cat list | xargs -I% rm -rf /tmp/%", ROOTS);
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — review round 5: findPathOperands stops at ! (LOW; `(` is a segment boundary and never reaches it)", () => {
  it("gates find /tmp ! -name x -delete with targets == [\"/tmp\"] (! is never collected as a target)", () => {
    const v = resolveDeletionTarget("find /tmp ! -name x -delete", ROOTS);
    expect(v?.targets).toEqual(["/tmp"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("allows find /tmp/scratch ! -name x -delete (target strictly deeper than the declared root)", () => {
    const v = resolveDeletionTarget("find /tmp/scratch ! -name x -delete", ROOTS);
    expect(v?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — review round 5: glued trailing & is stripped once (LOW)", () => {
  it("gates rm -rf /home/x& with targets == [\"/home/x\"] (not duplicated by the two segmentation arms)", () => {
    const v = resolveDeletionTarget("rm -rf /home/x&", ROOTS);
    expect(v?.targets).toEqual(["/home/x"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("allows rm -rf /tmp/x& (target strictly deeper than the declared root, once trailing & is stripped)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x&", ROOTS);
    expect(v?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — review round 6: oversized-command fallback still gates a deletion in the FIRST segment (the R5 pin alone was inert)", () => {
  it("gates rm -rf /home/x && echo <padding> past MAX_NORMALIZE_LENGTH, and allows the /tmp variant", () => {
    const padding = "a".repeat(MAX_NORMALIZE_LENGTH + 10);
    const unsafe = resolveDeletionTarget(`rm -rf /home/x && echo ${padding}`, ROOTS);
    expect(unsafe?.verb).toBe("rm");
    expect(unsafe?.unresolvable).toBe(true);
    expect(unsafe?.targets).toEqual(["/home/x"]);
    const safe = resolveDeletionTarget(`rm -rf /tmp/x && echo ${padding}`, ROOTS);
    expect(safe?.unresolvable).toBe(false);
  });

  it("still recognizes a path-qualified git head in the fallback, where command-normalize.ts's canonicalization never ran", () => {
    // In the normal path `/usr/bin/git clean` reaches this module already
    // canonicalized to `git clean`; only the oversized fallback hands it
    // the raw text, so only this fixture exercises GIT_HEAD_RE's
    // path-qualified alternative.
    const padding = "a".repeat(MAX_NORMALIZE_LENGTH + 10);
    const v = resolveDeletionTarget(`/usr/bin/git clean -fdx /home/y && echo ${padding}`, ROOTS);
    expect(v?.verb).toBe("git-clean");
    expect(v?.targets).toEqual(["/home/y"]);
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — review round 5: oversized-command single-first-segment fallback (LOW)", () => {
  it("falls back to inspecting only the FIRST shell segment past MAX_NORMALIZE_LENGTH, missing a deletion verb in a later segment", () => {
    const padding = "a".repeat(MAX_NORMALIZE_LENGTH + 10);
    const cmd = `echo ${padding} && rm -rf /home/x`;
    expect(cmd.length).toBeGreaterThan(MAX_NORMALIZE_LENGTH);
    // Both segmentation arms decline on a command this long, so
    // resolveDeletionTarget falls back to the pre-multi-segment,
    // single-first-segment contract: only "echo <padding>" (the first
    // segment) is inspected. It is not a recognized deletion verb, so
    // the later `rm -rf /home/x` segment goes entirely unrecognized and
    // the verdict is null (not gated).
    expect(resolveDeletionTarget(cmd, ROOTS)).toBeNull();
  });
});

// Task d03af8f6, review round 6: D-023 (any xargs-wrapped deletion is
// unresolvable), the round-5 inert-test fixes, and the class rules the
// round-6 adversarial audit added. Each block names the CLASS it pins.
describe("resolveDeletionTarget — review round 6: ANY xargs-wrapped deletion is unresolvable (D-023)", () => {
  it.each([
    "xargs rm -rf /tmp/known",
    "echo /home/x | xargs rm -rf /tmp/known",
    "xargs -i rm -rf /tmp/{}",
    "xargs -0I% rm -rf /tmp/%",
    "xargs -tI% rm -rf /tmp/%",
    "xargs --replace=% rm -rf /tmp/%",
    "xargs --replace % rm -rf /tmp/%",
    "xargs rm -rf /tmp/{}",
    "xargs -I{} rm -rf {}",
    "find /tmp/scratch -print0 | xargs -0 rm -rf",
    "xargs -I{} find {} -delete",
    "xargs -I{} git clean -fdx {}",
    "xargs -n 1 rm -rf",
    "xargs -P 4 rm -rf",
    "xargs -a list rm -rf",
    "xargs -d '\\n' rm -rf",
    "find /home -print0 | /usr/bin/xargs -0 rm -rf",
    "cat list | sudo xargs rm -rf",
    "xargs sudo rm -rf /tmp/known",
  ])("gates %s without parsing xargs's option vocabulary", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets[0]).toBe("(xargs-supplied target, not statically known)");
    expect(v?.unresolvedTargets).toEqual(v?.targets);
  });

  it("names the verb of the wrapped invocation and reports an explicit operand without resolving it", () => {
    expect(resolveDeletionTarget("xargs -I{} find {} -delete", ROOTS)?.verb).toBe("find");
    expect(resolveDeletionTarget("xargs -I{} git clean -fdx {}", ROOTS)?.verb).toBe("git-clean");
    const v = resolveDeletionTarget("xargs -I{} git clean -fdx {}", ROOTS);
    expect(v?.targets).toEqual(["(xargs-supplied target, not statically known)", "{}"]);
  });

  it.each(["xargs ls", "xargs echo", "xargs -I{} mv {} /trash", "xargs rm /tmp/known"])(
    "keeps %s unrecognized (no deletion-verb head after xargs, or rm without -r/-f)",
    (cmd) => {
      expect(resolveDeletionTarget(cmd, ROOTS)).toBeNull();
    },
  );

  it("gates xargs echo rm -rf /home/x (forward scan crosses a non-verb word — documented, accepted over-gate)", () => {
    const v = resolveDeletionTarget("xargs echo rm -rf /home/x", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
  });
});

describe("resolveDeletionTarget — review round 6: bare subshell parens are syntax, never operands", () => {
  it("reports targets == [\"/home/x\"] for ( rm -rf /home/x ) (the lone `)` token is dropped)", () => {
    const v = resolveDeletionTarget("( rm -rf /home/x )", ROOTS);
    expect(v?.targets).toEqual(["/home/x"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("allows ( rm -rf /tmp/x ) and ( git clean -fdx /tmp/x ) — the lone `)` no longer gates a safe subshell", () => {
    expect(resolveDeletionTarget("( rm -rf /tmp/x )", ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("( git clean -fdx /tmp/x )", ROOTS)?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — review round 6: tokenizer follows bash for backslash-space and comments", () => {
  it("treats /tmp/x\\ y as ONE operand (allowed), like bash does", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/x\\ y", ROOTS);
    expect(v?.targets).toEqual(["/tmp/x y"]);
    expect(v?.unresolvable).toBe(false);
  });

  it("drops a trailing # comment so rm -rf /tmp/x # cleanup is allowed, but a quoted or escaped # is still an operand", () => {
    const commented = resolveDeletionTarget("rm -rf /tmp/x # cleanup", ROOTS);
    expect(commented?.targets).toEqual(["/tmp/x"]);
    expect(commented?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("rm -rf /tmp/x '#' /home/y", ROOTS)?.unresolvable).toBe(true);
    expect(resolveDeletionTarget("rm -rf /tmp/x \\#/home/y", ROOTS)?.unresolvable).toBe(true);
    // A glued `#` is not a comment start.
    expect(resolveDeletionTarget("rm -rf /tmp/x#/home/y", ROOTS)?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — review round 6: leading shell keywords and group markers are stripped", () => {
  it.each([
    "if true; then rm -rf /home/x; fi",
    "for f in a; do rm -rf /home/x; done",
    "! rm -rf /home/x",
    "while rm -rf /home/x; do :; done",
    "until rm -rf /home/x; do :; done",
    "elif rm -rf /home/x; then :; fi",
    "if [ -d /home/x ]; then rm -rf /home/x; fi",
    "f() { rm -rf /home/x; }; f",
    "f(){ rm -rf /home/x; }; f",
  ])("gates %s", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toEqual(["/home/x"]);
  });
});

describe("resolveDeletionTarget — review round 6: locally-peeled wrappers", () => {
  it("gates exec -a <name> rm -rf /home/x (the shared peeler would leave <name> as the head)", () => {
    const v = resolveDeletionTarget("exec -a foo rm -rf /home/x", ROOTS);
    expect(v?.verb).toBe("rm");
    expect(v?.targets).toEqual(["/home/x"]);
  });

  it.each(["busybox rm -rf /home/x", "toybox rm -rf /home/x"])("gates the multi-call binary form %s", (cmd) => {
    expect(resolveDeletionTarget(cmd, ROOTS)?.targets).toEqual(["/home/x"]);
  });
});

describe("resolveDeletionTarget — review round 6: target class rules (each a closed CLASS, measured on bash 3.2)", () => {
  it.each([
    ["rm -rf /tmp/x/", "trailing slash follows a symlinked directory into its target"],
    ["rm -rf /tmp/x/.", "trailing /. follows a symlinked directory into its target"],
    ["find /tmp/x/ -delete", "trailing slash (find)"],
    ["rm -rf /tmp/x/../y", ".. through a possibly-symlinked component"],
    ["rm -rf /tmp/.*", ".* expands to /tmp/.."],
    ["rm -rf /tmp/x/.*", ".* expands to /tmp/x/.."],
    ["rm -rf /tmp/..*", "..* expands to /tmp/.."],
    ["rm -rf /tmp/.?/x", ".? expands to .."],
    ["rm -rf /tmp/.*/foo", "an intermediate .* expands to .."],
    ["rm -rf /tmp/.[.]/x", ".[.] expands to .."],
    ["rm -rf /tmp/.[!x]/y", ".[!x] expands to .."],
    ["find /tmp/.* -delete", ".* (find)"],
    ["rm -rf /tmp/{..,x}", "brace expansion yields /tmp/.."],
    ["rm -rf /tmp/x{,.bak}", "brace expansion (any) is never statically expanded"],
    ["rm -rf /tmp/`cat<f`", "backtick command substitution inside one token"],
    ["rm -rf /tmp/@(..)/x", "extglob opener: the ( cut leaves the pattern head"],
    ["rm -rf /tmp/!(x)", "extglob opener !("],
    ["rm -rf /tmp/*/../../home", "glob then .."],
    ["rm -rf /tmp/x/**", "bare ** final component"],
  ])("gates %s (%s)", (cmd) => {
    expect(resolveDeletionTarget(cmd, ROOTS)?.unresolvable).toBe(true);
  });

  it.each([
    "rm -rf /tmp/x/*.log",
    "rm -rf /tmp/x/build-*",
    "rm -rf /tmp/x/.[!.]*",
    "rm -rf /tmp/x/.??*",
    "rm -rf /tmp/x/?",
    "rm -rf /tmp/[.][.]/x",
    "rm -rf //tmp/x",
    "rm -rf /tmp/./x",
    "rm -rf $'/tmp/x'",
  ])("allows %s (a glob that cannot expand to .. stays resolvable; bash never matches .. without an explicit leading dot)", (cmd) => {
    expect(resolveDeletionTarget(cmd, ROOTS)?.unresolvable).toBe(false);
  });
});

describe("resolveDeletionTarget — review round 6: find", () => {
  it.each([
    ["find /tmp/x -exec rm -rf /home/y \\;", ["/tmp/x", "/home/y"]],
    ["find /tmp/x -delete -exec rm -rf /home/y \\;", ["/tmp/x", "/home/y"]],
    ["find /tmp/x -exec rm -rf {}/../../../home \\;", ["/tmp/x", "{}/../../../home"]],
    ["find /tmp/x -execdir rm -rf ../../home \\;", ["/tmp/x", "../../home"]],
    ["find /tmp/x -exec rm -rf {} \\; -exec rm -rf /home/y \\;", ["/tmp/x", "/tmp/x", "/home/y"]],
  ])("gates %s — an -exec payload's explicit operands are targets too", (cmd, targets) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("find");
    expect(v?.targets).toEqual(targets);
    expect(v?.unresolvable).toBe(true);
  });

  it.each([
    "find /tmp/x -execdir rm -rf {} +",
    "find /tmp/x -type f -exec rm -f {} +",
    "find /tmp/x -exec /bin/rm -rf {} +",
    "find /tmp/x -exec rm -rf -- {} +",
    "find /tmp/x -exec rm -rf {} ';'",
    'find /tmp/x -exec rm -rf {} ";"',
    "find /tmp/x -ok rm -rf {} \\;",
    "find /tmp/x -exec echo {} \\; -exec rm -rf {} \\;",
    "find /tmp/x -exec echo {} \\; -delete",
  ])("allows %s (only the {} placeholder, or the orphaned terminator escape, follows rm)", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("find");
    expect(v?.unresolvable).toBe(false);
  });

  it("carries the search root into a continuation segment cut at \\; — find /home/x -exec echo {} \\; -exec rm -rf {} \\; gates on /home/x", () => {
    const v = resolveDeletionTarget("find /home/x -exec echo {} \\; -exec rm -rf {} \\;", ROOTS);
    expect(v?.verb).toBe("find");
    expect(v?.targets).toEqual(["/home/x"]);
    expect(v?.unresolvable).toBe(true);
  });

  it("resets the carry once another command intervenes (a -delete after `echo;` is not a find continuation)", () => {
    expect(resolveDeletionTarget("find /home/x -exec echo {} \\; echo; -delete", ROOTS)).toBeNull();
  });

  it("covers the ESCAPED grouped expression via the same carry: find /home \\( -name a -o -name b \\) -delete gates, the /tmp/x variant allows", () => {
    const unsafe = resolveDeletionTarget("find /home \\( -name a -o -name b \\) -delete", ROOTS);
    expect(unsafe?.targets).toEqual(["/home"]);
    expect(unsafe?.unresolvable).toBe(true);
    expect(resolveDeletionTarget("find /tmp/x \\( -name a -o -name b \\) -delete", ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("find /home \\( -name a \\) -exec rm -rf {} \\;", ROOTS)?.unresolvable).toBe(true);
  });

  it.each(["find -L /tmp/x -delete", "find -H /tmp/x -delete", "find /tmp/x -follow -delete"])(
    "gates %s (find follows symlinks, so a root-internal target may resolve outside)",
    (cmd) => {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.unresolvable).toBe(true);
      expect(v?.targets).toEqual(["/tmp/x"]);
      expect(v?.reason).toContain("follows symlinks");
    },
  );

  it.each(["find -P /tmp/x -delete", "find -O3 /tmp/x -delete", "find -f /tmp/x -delete", "find -D search /tmp/x -delete"])(
    "allows %s (a leading option that does not change the search root is skipped)",
    (cmd) => {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.targets).toEqual(["/tmp/x"]);
      expect(v?.unresolvable).toBe(false);
    },
  );
});

describe("resolveDeletionTarget — review round 6: git clean", () => {
  it.each([
    "git -c clean.requireForce=false clean -d",
    "git -c clean.requireforce=0 clean",
    "GIT_CONFIG_PARAMETERS='clean.requireForce=false' git clean -d",
    "git config clean.requireForce false && git clean -d",
  ])("gates %s (a clean.requireForce override anywhere in the command counts as -f; canonicalization erases -c)", (cmd) => {
    const v = resolveDeletionTarget(cmd, ROOTS);
    expect(v?.verb).toBe("git-clean");
    expect(v?.unresolvable).toBe(true);
  });

  it.each(["git --no-optional-locks clean -fdx /home/y", "git --literal-pathspecs -c a=b clean -f /home/y"])(
    "gates %s (an un-canonicalized global option cannot hide the subcommand)",
    (cmd) => {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.verb).toBe("git-clean");
      expect(v?.targets).toEqual(["/home/y"]);
    },
  );

  it("treats -e/--exclude as value-taking: git clean -f -e /tmp/x cleans cwd, not /tmp/x", () => {
    for (const cmd of ["git clean -f -e /tmp/x", "git clean -f --exclude /tmp/x", "git clean -f $'\\x2de' /tmp/x"]) {
      const v = resolveDeletionTarget(cmd, ROOTS);
      expect(v?.targets).toEqual(["."]);
      expect(v?.unresolvable).toBe(true);
    }
    expect(resolveDeletionTarget("git clean -f -e /tmp/x /tmp/y", ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("git clean -f --exclude=/home/y /tmp/x", ROOTS)?.unresolvable).toBe(false);
  });

  it("keeps a dry run and an unforced clean unrecognized, and a quoted pathspec intact", () => {
    expect(resolveDeletionTarget("git clean -n", ROOTS)).toBeNull();
    expect(resolveDeletionTarget("git clean --dry-run", ROOTS)).toBeNull();
    expect(resolveDeletionTarget("git clean -i", ROOTS)).toBeNull();
    expect(resolveDeletionTarget('git clean -fdx "/tmp/x y"', ROOTS)?.unresolvable).toBe(false);
    expect(resolveDeletionTarget("git clean -fdx -- /home/y", ROOTS)?.targets).toEqual(["/home/y"]);
  });
});

describe("resolveDeletionTarget — review round 6: quote-unaware amp arm on a quoted literal & (reporting-only ceiling, fail-closed)", () => {
  it("gates rm -rf '/tmp/a&b' and lists the amp arm's cut-off spelling next to the real operand", () => {
    const v = resolveDeletionTarget("rm -rf '/tmp/a&b'", ROOTS);
    expect(v?.unresolvable).toBe(true);
    expect(v?.targets).toContain("/tmp/a&b");
  });
});
