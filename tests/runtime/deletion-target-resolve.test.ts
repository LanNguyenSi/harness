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

  it("only recognizes the deletion verb as the FIRST chained segment", () => {
    // Documented narrow scope — a dangerous tail after `&&` is not this
    // module's job (the existing dangerous-shell classifier covers it
    // for the production-scoped policies).
    expect(resolveDeletionTarget("echo hi && rm -rf /home/x", ROOTS)).toBeNull();
  });
});

describe("resolveDeletionTarget — AC1: absolute path outside the allowlist", () => {
  it("classifies rm -rf against a path outside every safe root as unresolvable", () => {
    const v = resolveDeletionTarget("rm -rf /home/lan/git/pandora/some-dir", ROOTS);
    expect(v).not.toBeNull();
    expect(v?.unresolvable).toBe(true);
    expect(v?.unresolvedTargets).toEqual(["/home/lan/git/pandora/some-dir"]);
  });
});

describe("resolveDeletionTarget — AC2: absolute path inside a declared safe root", () => {
  it("classifies rm -rf against a path inside /tmp as resolved (allow)", () => {
    const v = resolveDeletionTarget("rm -rf /tmp/scratch/foo", ROOTS);
    expect(v).not.toBeNull();
    expect(v?.unresolvable).toBe(false);
    expect(v?.unresolvedTargets).toEqual([]);
  });

  it("classifies rm -rf against the root itself as resolved", () => {
    expect(resolveDeletionTarget("rm -rf /tmp", ROOTS)?.unresolvable).toBe(false);
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
