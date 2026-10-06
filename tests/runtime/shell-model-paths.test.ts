import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PathPossibility, PathStep } from "../../src/runtime/shell-command-model.js";
import { MAX_MODEL_PATH_WORK, ModelPathResolver } from "../../src/runtime/shell-model-paths.js";

// Task 7d4abf84: the filesystem side of the shell command model. Logical
// steps resolve like the shell's `$PWD`, physical ones through the real
// directory they start from; every possibility is resolved once per
// resolver, and the work is bounded by a per-event budget.

let root = "";

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-model-paths-")));
  fs.mkdirSync(path.join(root, "cwd", "sub", "deeper"), { recursive: true });
  fs.mkdirSync(path.join(root, "target", "inner"), { recursive: true });
  fs.symlinkSync(path.join(root, "target", "inner"), path.join(root, "cwd", "link"));
  fs.writeFileSync(path.join(root, "cwd", "file"), "x");
});

afterAll(() => {
  if (root.length > 0) fs.rmSync(root, { recursive: true, force: true });
});

const L = (value: string): PathStep => ({ value, mode: "logical" });
const P = (value: string): PathStep => ({ value, mode: "physical" });
const at = (...steps: PathStep[]): PathPossibility => ({ kind: "path", steps });

describe("ModelPathResolver.resolve", () => {
  it("a logical step is joined lexically, a physical one through the real directory", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"));
    // link/.. lexically is the working directory itself.
    expect(r.resolve(at(L("link/..")))).toBe(path.join(root, "cwd"));
    // Physically it is the parent of the link's target.
    expect(r.resolve(at(P("link/..")))).toBe(path.join(root, "target"));
    // A physical step after a logical one starts from the real directory.
    expect(r.resolve(at(L("link"), P("..")))).toBe(path.join(root, "target"));
    // The final directory is realpath'd.
    expect(r.resolve(at(L("link")))).toBe(path.join(root, "target", "inner"));
    expect(r.resolve(at())).toBe(path.join(root, "cwd"));
  });

  it("a logical step starts from the working directory as given, not from its real path", () => {
    // The working directory is the link itself: `..` is its lexical parent.
    const r = new ModelPathResolver(path.join(root, "cwd", "link"));
    expect(r.resolve(at(L("../sub")))).toBe(path.join(root, "cwd", "sub"));
    expect(r.resolve(at(P("..")))).toBe(path.join(root, "target"));
  });

  it("a component that names no directory is joined lexically onto the real directory before it", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"));
    expect(r.resolve(at(P("link/missing")))).toBe(path.join(root, "target", "inner", "missing"));
    expect(r.resolve(at(L("missing/x")))).toBe(path.join(root, "cwd", "missing", "x"));
    expect(r.resolve(at(P("/abs/missing")))).toBe("/abs/missing");
  });

  it("resolves each possibility once: a second request spends nothing", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"), 6);
    const d = at(P("sub/deeper"), L(".."));
    expect(r.resolve(d)).toBe(path.join(root, "cwd", "sub"));
    // physical: 1 + 2 components, logical: 1, final realpath: 1 = 5 units.
    expect(r.resolve(at(P("sub/deeper"), L("..")))).toBe(path.join(root, "cwd", "sub"));
    expect(r.overBudget).toBe(false);
    // A sixth unit is left; this needs three.
    expect(r.resolve(at(L("sub"), L("deeper")))).toBeNull();
    expect(r.overBudget).toBe(true);
  });

  it("past the budget every request that needs work is refused, and the refusal sticks", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"), 3);
    expect(r.resolve(at(L("a"), P("b")))).toBeNull();
    expect(r.overBudget).toBe(true);
    expect(r.resolve(at(L("sub")))).toBeNull();
    expect(r.chargeRepositoryLookup(path.join(root, "cwd"))).toBe(false);
  });

  it("the default budget covers one path at the model's composed-length limit, not two", () => {
    // 2048 alternating steps, 4096 characters: the longest path the model
    // composes. One costs 3 units per pair plus the final realpath.
    const long = (name: string): PathPossibility => {
      const steps: PathStep[] = [];
      for (let i = 0; i < 1024; i++) steps.push(P(name), L("b"));
      return at(...steps);
    };
    const r = new ModelPathResolver(path.join(root, "cwd"));
    expect(r.resolve(long("a"))).not.toBeNull();
    expect(r.overBudget).toBe(false);
    expect(r.resolve(long("c"))).toBeNull();
    expect(r.overBudget).toBe(true);
    expect(MAX_MODEL_PATH_WORK).toBeLessThan(2 * (3 * 1024 + 1));
  });
});

describe("ModelPathResolver.certainDirectory (the model's directory oracle)", () => {
  it("true only for an existing directory that can be entered", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"));
    expect(r.certainDirectory(at(), L("sub"), at(L("sub")))).toBe(true);
    expect(r.certainDirectory(at(), L("link"), at(L("link")))).toBe(true);
    expect(r.certainDirectory(at(L("sub")), L(".."), at())).toBe(true);
    expect(r.certainDirectory(at(), L("missing"), at(L("missing")))).toBe(false);
    expect(r.certainDirectory(at(), L("file"), at(L("file")))).toBe(false);
  });

  it("a directory that cannot be entered is not certain", () => {
    const locked = path.join(root, "cwd", "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o600);
    try {
      const r = new ModelPathResolver(path.join(root, "cwd"));
      // Root can enter any directory; the check is meaningful for other users only.
      const expected = process.getuid?.() === 0;
      expect(r.certainDirectory(at(), L("locked"), at(L("locked")))).toBe(expected);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it("a physical .. that leaves a directory without search permission is not certain", () => {
    const locked = path.join(root, "cwd", "locked-dotdot");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o600);
    try {
      const r = new ModelPathResolver(path.join(root, "cwd"));
      // bash and zsh refuse `cd -P locked-dotdot/../sub` (Permission denied); root can enter it.
      const expected = process.getuid?.() === 0;
      expect(r.certainDirectory(at(), P("locked-dotdot/../sub"), at(P("locked-dotdot/../sub")))).toBe(expected);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it("resolves the target from its base, so a chain of cd costs one step per cd", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"), 4);
    // sub: 1 step + 1 check; sub/deeper from sub: 1 step + 1 check.
    expect(r.certainDirectory(at(), L("sub"), at(L("sub")))).toBe(true);
    expect(r.certainDirectory(at(L("sub")), L("deeper"), at(L("sub/deeper")))).toBe(true);
    expect(r.overBudget).toBe(false);
    // Asked again: answered from the memo, no work.
    expect(r.certainDirectory(at(L("sub")), L("deeper"), at(L("sub/deeper")))).toBe(true);
    // Over budget: no longer certain (the model keeps the failure branch).
    expect(r.certainDirectory(at(), L("link"), at(L("link")))).toBe(false);
    expect(r.overBudget).toBe(true);
  });
});

describe("ModelPathResolver.certainDirectory: a step the shell can fail on is never certain", () => {
  it("a logical .. after a name, even when the lexical result exists and is memoised", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"));
    expect(r.certainDirectory(at(), L("missing/../sub"), at(L("sub")))).toBe(false);
    expect(r.certainDirectory(at(), L("file/../sub"), at(L("sub")))).toBe(false);
    // A leading `..` leaves a directory the shell is in: certain.
    expect(r.certainDirectory(at(L("sub")), L("../sub/deeper"), at(L("sub/deeper")))).toBe(true);
    // `sub` itself is certain; the memo for it does not answer for a step
    // that names it through a missing directory.
    expect(r.certainDirectory(at(), L("sub"), at(L("sub")))).toBe(true);
    expect(r.certainDirectory(at(), L("missing/../sub"), at(L("sub")))).toBe(false);
  });

  it("a physical .. that leaves a missing directory or a file, though the lexical result exists", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"));
    expect(r.certainDirectory(at(), P("missing/../sub"), at(P("missing/../sub")))).toBe(false);
    expect(r.certainDirectory(at(), P("file/../sub"), at(P("file/../sub")))).toBe(false);
    expect(r.certainDirectory(at(), P("file/sub"), at(P("file/sub")))).toBe(false);
    // Through real directories a physical step keeps its rule: certain.
    expect(r.certainDirectory(at(), P("sub/../sub"), at(P("sub/../sub")))).toBe(true);
    expect(r.certainDirectory(at(), P("link/.."), at(P("link/..")))).toBe(true);
    // The resolution is unchanged: the lexical result.
    expect(r.resolve(at(P("missing/../sub")))).toBe(path.join(root, "cwd", "sub"));
    expect(r.resolve(at(P("file/../sub")))).toBe(path.join(root, "cwd", "sub"));
    expect(r.resolve(at(P("link/..")))).toBe(path.join(root, "target"));
  });

  it("the mark survives a target walked before it was asked about, and a base the shell cannot reach", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"));
    // resolve() walks the target first; the question is answered from that walk.
    expect(r.resolve(at(P("missing/../sub")))).toBe(path.join(root, "cwd", "sub"));
    expect(r.certainDirectory(at(), P("missing/../sub"), at(P("missing/../sub")))).toBe(false);
    // A clean step from a base the shell cannot reach is not certain either.
    expect(r.certainDirectory(at(P("missing/..")), L("sub"), at(P("missing/.."), L("sub")))).toBe(false);
    expect(r.certainDirectory(at(P("sub/..")), L("sub"), at(P("sub/.."), L("sub")))).toBe(true);
  });

  it("an executable regular file is not a directory", () => {
    const tool = path.join(root, "cwd", "tool");
    fs.writeFileSync(tool, "#!/bin/sh\n");
    fs.chmodSync(tool, 0o755);
    const r = new ModelPathResolver(path.join(root, "cwd"));
    expect(r.certainDirectory(at(), L("tool"), at(L("tool")))).toBe(false);
    expect(r.certainDirectory(at(), P("tool/../sub"), at(P("tool/../sub")))).toBe(false);
  });
});

describe("ModelPathResolver.certainDirectory past the work budget", () => {
  it("a base not walked yet that needs more than the budget is not certain", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"), 0);
    expect(r.certainDirectory(at(L("sub")), L("deeper"), at(L("sub/deeper")))).toBe(false);
    expect(r.overBudget).toBe(true);
  });

  it("a walked target whose directory check is past the budget is not certain", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"), 2);
    // One step and one realpath: the budget is spent.
    expect(r.resolve(at(L("sub")))).toBe(path.join(root, "cwd", "sub"));
    expect(r.overBudget).toBe(false);
    expect(r.certainDirectory(at(), L("sub"), at(L("sub")))).toBe(false);
    expect(r.overBudget).toBe(true);
  });

  it("a step the oracle walks itself, with the check past the budget, is not certain", () => {
    const r = new ModelPathResolver(path.join(root, "cwd"), 1);
    expect(r.certainDirectory(at(), L("sub"), at(L("sub")))).toBe(false);
    expect(r.overBudget).toBe(true);
  });
});
