import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Task f1eb1c5c, round 2 divergence pin (below), relocated to its own
// file (task 2dadec9d, batch-46 follow-up): `existsSync` is wrapped in
// a `vi.fn` that calls straight through to the real implementation, so
// production code and every OTHER test file behave identically; only
// the tests in THIS file, which spy on `fs.existsSync`'s call history,
// are affected. A plain `vi.spyOn(fs, "existsSync")` fails under ESM
// ("Module namespace is not configurable"), hence the `vi.mock` here
// instead. `vi.mock` is hoisted and file-scoped in vitest, so it
// cannot be cleared per-test with `afterEach`; giving the pin its own
// file is what actually scopes the mock, rather than leaking it across
// every case in the shared
// doctor-session-start-preflight-setup-version.test.ts file (task
// 2dadec9d's own finding).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = vi.fn(actual.existsSync);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { deriveProjectName, findGitEntry } from "../../src/runtime/git-context.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-divergence-file-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

function buildManifest(setupLine: string): string {
  return `version: 1
${setupLine}
policies: []
tools:
  builtin:
    known: []
`;
}

function makeRepoFixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-divergence-repo-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  return repo;
}

function writeProjectLayer(home: string, projectName: string, setup: boolean): void {
  const projectDir = path.join(home, "projects", projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "harness.overrides.yaml"),
    ["session_start_preflight:", `  setup: ${setup}`, ""].join("\n"),
  );
}

// task f1eb1c5c, round 2 review, MEDIUM (tests): nothing pinned this
// surface's OWN `fallback: null` argument to `resolveScopedProjectName`
// (src/runtime/git-context.ts) as opposed to the producer's `fallback:
// repo`; a fixture where `deriveProjectName` returns null exercises
// that divergence. A linked-worktree-shaped checkout whose main
// checkout is named "evil\\name" (a backslash makes that basename fail
// `isValidProjectName`, see git-context.ts) makes `deriveProjectName(cwd)`
// return null even though the checkout directory's OWN basename
// ("doctor-divergence-checkout") stays a valid project name a layer
// could legitimately be written under. Doctor's `fallback: null` means
// no name is ever attempted here, so a matching
// `<home>/projects/doctor-divergence-checkout/...` layer must NOT be
// read: observable via `projectName: null` on the finding (D-021b's
// carried identity) and the absence of format.ts's `(project: X)`
// suffix, same observables the sibling "negative control" test in
// doctor-session-start-preflight-setup-version.test.ts already asserts
// for a genuinely absent layer.
describe("doctor: does NOT resolve a project layer when the cwd's derived name is invalidated (task f1eb1c5c divergence pin, relocated by task 2dadec9d)", () => {
  it("does NOT resolve a project layer when the cwd's derived name is invalidated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-divergence-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const mainRepoName = "evil\\name";
    const mainWorktreeDir = path.join(root, mainRepoName, ".git", "worktrees", "wt1");
    fs.mkdirSync(mainWorktreeDir, { recursive: true });
    fs.writeFileSync(path.join(mainWorktreeDir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainWorktreeDir, "commondir"), "../..\n");
    const checkoutBasename = "doctor-divergence-checkout";
    const repo = path.join(root, checkoutBasename);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${mainWorktreeDir}\n`);

    // Task 2dadec9d, criterion 2: assert the fixture's own preconditions
    // explicitly, rather than relying on the shape of the directory
    // layout alone, so a fixture that stops exercising the divergence
    // (e.g. a future git-context.ts change that makes "evil\\name" a
    // valid basename again) fails loudly here instead of the pin below
    // silently passing for the wrong reason.
    expect(
      findGitEntry(repo),
      "fixture precondition: repo must be inside a git work tree",
    ).not.toBeNull();
    expect(
      deriveProjectName(repo),
      "fixture precondition: the cwd-derived project name must be null " +
        "(the invalidated main-checkout basename must propagate)",
    ).toBeNull();

    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    // A layer DOES exist under the checkout's own (valid) basename;
    // doctor's fallback:null must never attempt that name at all.
    writeProjectLayer(home, checkoutBasename, false);

    // Report-shaped observable: no project layer decided the result.
    // On its own this is NOT sufficient to kill every fallback drift
    // (a drifted fallback with no MATCHING on-disk layer would produce
    // the identical `projectName: null` report, since doctor only
    // names a project when `resolvePaths` actually resolved a layer
    // FILE for the attempted name); the `existsSync` spy below is the
    // discriminator that does not depend on guessing the drifted
    // string. `resolvePaths` (src/cli/loader.ts) calls
    // `fs.existsSync(<home>/projects/<name>/harness.overrides.yaml)`
    // for ANY truthy `opts.project`, so ANY fallback change from
    // `null` to a non-null value shows up here as an extra call under
    // `<home>/projects/`, regardless of which string it is.
    const existsSyncMock = fs.existsSync as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };
    existsSyncMock.mockClear();
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    const projectsDirCalls = existsSyncMock.mock.calls.filter(([p]) =>
      String(p).includes(path.join(home, "projects") + path.sep),
    );
    expect(
      projectsDirCalls,
      "task f1eb1c5c: doctor's fallback:null must never cause resolvePaths to probe " +
        "ANY path under <home>/projects/ for this cwd; a fallback drifted to a non-null " +
        "value (e.g. the round-2 review's own \"drifted-fallback\" example) makes this " +
        "list non-empty even when no on-disk layer matches the drifted name",
    ).toEqual([]);
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
      projectName: null,
    });
    const text = format(report);
    expect(text).not.toContain("(project:");
  });

  // Task 2dadec9d, criterion 3: negative control. When the cwd DOES
  // derive a valid project name, doctor's `resolvePaths` call DOES
  // probe `fs.existsSync` under `<home>/projects/<name>/...` for that
  // name; this is the mirror image of the divergence pin above and
  // shows the projectsDirCalls assertion genuinely discriminates a
  // probing doctor from a non-probing one, rather than the mock
  // recording zero calls regardless of what doctor does.
  it("DOES probe under <home>/projects/ for a valid derived name (negative control)", async () => {
    const repoName = "doctor-divergence-valid-repo";
    const repo = makeRepoFixture(repoName);

    expect(
      findGitEntry(repo),
      "fixture precondition: repo must be inside a git work tree",
    ).not.toBeNull();
    expect(
      deriveProjectName(repo),
      "fixture precondition: the cwd-derived project name must be valid and equal repoName",
    ).toBe(repoName);

    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    writeProjectLayer(home, repoName, false);

    const existsSyncMock = fs.existsSync as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };
    existsSyncMock.mockClear();
    await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    const projectsDirCalls = existsSyncMock.mock.calls.filter(([p]) =>
      String(p).includes(path.join(home, "projects") + path.sep),
    );
    expect(
      projectsDirCalls.length,
      "a valid cwd-derived project name must cause resolvePaths to probe " +
        "existsSync under <home>/projects/ at least once",
    ).toBeGreaterThan(0);
  });
});
