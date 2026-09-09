// Loader-level primitive underneath the `session_start_preflight.setup`
// per-repo scoping story (task 30183330, review round 3; task
// `c88461c1` builds per-repo scoping on top of this contract).
//
// `resolvePaths` resolves a project override layer ONLY when
// `LoaderOptions.project` is explicitly set; it never inspects cwd or
// any other ambient signal on its own. This file pins that low-level
// contract in isolation: without `project`, a project override layer
// that sits on disk is neither resolved nor merged, so its
// `session_start_preflight.setup: false` cannot influence what a caller
// reads. The same layer IS honoured when `project` is passed
// explicitly.
//
// This is no longer the full scope story for the hook path: the
// generated SessionStart hook itself still passes no `--project`
// (pinned by tests/cli/init-preflight-hook-project-scope.test.ts), but
// `harness session-start preflight` (src/cli/session-start/index.ts)
// now derives a project name from its own cwd and feeds it through
// this EXACT `LoaderOptions.project` seam, so a project layer DOES
// scope the key per repository on the hook path today (see
// tests/cli/session-start/preflight.test.ts, "per-repo scoping via
// cwd-derived project name"). What this file pins is the shared
// primitive that derivation depends on, not a claim that the mechanism
// is unreachable from the hook.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import { loadManifest, resolvePaths } from "../../src/cli/loader.js";
import type { GitRepoContext } from "../../src/runtime/git-context.js";
import { isCaseInsensitiveFilesystem } from "../_helpers/case-sensitivity.js";

const PROJECT_NAME = "scoped-repo";

let tmpHome: string;
let priorEnv: string | undefined;

const BASE_MANIFEST = [
  "version: 1",
  "hooks: []",
  "policies: []",
  "tools:",
  "  builtin:",
  "    known: [Read, Edit]",
  "session_start_preflight:",
  "  setup: true",
  "",
].join("\n");

const PROJECT_LAYER = ["session_start_preflight:", "  setup: false", ""].join("\n");

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loader-project-layer-"));
  priorEnv = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  fs.writeFileSync(path.join(tmpHome, "harness.yaml"), BASE_MANIFEST);
  const projectDir = path.join(tmpHome, "projects", PROJECT_NAME);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "harness.overrides.yaml"), PROJECT_LAYER);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (priorEnv === undefined) delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  else process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = priorEnv;
});

describe("resolvePaths: a project layer requires opts.project to be SET (task 30183330); this loader never derives it from cwd itself, a caller does (see the file header)", () => {
  it("resolves NO project layer when opts.project is absent, even though one exists on disk", () => {
    const resolved = resolvePaths({ homeDir: tmpHome });
    expect(resolved.projectLayer).toBeNull();
  });

  it("resolves the project layer when opts.project names it", () => {
    const resolved = resolvePaths({ homeDir: tmpHome, project: PROJECT_NAME });
    expect(resolved.projectLayer).toBe(
      path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"),
    );
  });
});

describe("loadManifest: a project layer cannot scope session_start_preflight.setup without --project", () => {
  it("keeps the base manifest's setup:true when opts.project is absent", () => {
    const { manifest, resolved } = loadManifest({ homeDir: tmpHome });
    expect(resolved.projectLayer).toBeNull();
    // The on-disk project layer says `setup: false`. If it were merged,
    // this would read false, but a project layer only ever narrows the
    // key when a caller derives or passes a `LoaderOptions.project`
    // (`harness session-start preflight`'s cwd-derived name, or an
    // explicit `--project`), pinned separately below and in
    // tests/cli/session-start/preflight.test.ts; a bare `resolvePaths`/
    // `loadManifest` call with no `project` never reaches it.
    expect(manifest.session_start_preflight).toEqual({ setup: true });
  });

  it("applies the project layer's setup:false when opts.project names it", () => {
    const { manifest } = loadManifest({ homeDir: tmpHome, project: PROJECT_NAME });
    expect(manifest.session_start_preflight).toEqual({ setup: false });
  });
});

// Residual of task c88461c1's review round 3 (T-004 of the follow-up
// batch, tracker 1c4eb3ea): `isValidProjectName` (`src/runtime/
// git-context.ts`) already guards every `deriveProjectName` exit, but
// `resolvePaths`' own `path.join` sink had no equivalent check of its
// own, defense in depth for an `opts.project` reaching this function
// from anywhere else. `".."` is the shape a crafted/un-normalized
// `commondir` used to produce before `deriveProjectName`'s own fix
// (`tests/runtime/git-context.test.ts`); here it is passed straight to
// `resolvePaths` as if a caller had bypassed derivation entirely.
describe("resolvePaths: rejects an unsafe opts.project at its own path.join sink (task c88461c1, review round 3 residual, tracker 1c4eb3ea)", () => {
  it("resolves NO project layer for opts.project: '..', even though a matching directory exists one level up", () => {
    // `path.join(home, "projects", "..", "harness.overrides.yaml")`
    // resolves to `<home>/harness.overrides.yaml`; write a file there
    // so an un-guarded sink would find something to point at.
    fs.writeFileSync(path.join(tmpHome, "harness.overrides.yaml"), PROJECT_LAYER);
    const resolved = resolvePaths({ homeDir: tmpHome, project: ".." });
    expect(resolved.projectLayer).toBeNull();
  });

  it("keeps loadManifest on the base manifest's value for opts.project: '..'", () => {
    fs.writeFileSync(path.join(tmpHome, "harness.overrides.yaml"), PROJECT_LAYER);
    const { manifest } = loadManifest({ homeDir: tmpHome, project: ".." });
    expect(manifest.session_start_preflight).toEqual({ setup: true });
  });

  it("still resolves a valid opts.project name, unaffected by the new guard", () => {
    const resolved = resolvePaths({ homeDir: tmpHome, project: PROJECT_NAME });
    expect(resolved.projectLayer).toBe(
      path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"),
    );
  });
});

// Shared fixture helpers for the SYMLINK and CASING describe blocks
// below (task 6c8c1bae: these two blocks used to carry ~90 lines of
// near-duplicate fixture builders). Parameterised by
// policy name/description and layer setup value so both blocks reuse
// them; only `makeSymlinkedRepo`/`makeCasingRepo` stay separate below,
// since a symlinked checkout and a plain one are genuinely different
// shapes.
function writeFixtureHomeManifest(
  home: string,
  policyName: string,
  description: string,
  baseSetup: boolean,
): void {
  // JSON is valid YAML; this keeps the fixture self-contained without
  // pulling in the `yaml` stringify helper this file does not
  // otherwise import.
  const manifestInput = {
    version: 1,
    hooks: [{ name: "risk-gate", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
    policies: [
      {
        name: policyName,
        description,
        trigger: { event: "PreToolUse", match: "Bash" },
        requires: { ledger_tag: "preflight:${REPO}" },
        hook: "risk-gate",
        enforcement: "block",
      },
    ],
  };
  fs.writeFileSync(
    path.join(home, "harness.yaml"),
    JSON.stringify({ ...manifestInput, session_start_preflight: { setup: baseSetup } }),
  );
}

function writeFixtureProjectLayer(home: string, projectDirName: string, setup: boolean): void {
  const dir = path.join(home, "projects", projectDirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "harness.overrides.yaml"),
    ["session_start_preflight:", `  setup: ${setup}`, ""].join("\n"),
  );
}

function writeFixtureEvent(dir: string): string {
  const file = path.join(dir, "event.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    }),
  );
  return file;
}

const FIXTURE_SEAMS = {
  now: new Date("2026-09-09T00:00:00.000Z"),
  host: "h",
  user: "u",
  resolveGit: (): GitRepoContext => ({ repo: "r", branch: "main", sha: "" }),
  cwdFallback: "/fallback",
  env: {},
  kubeContext: "",
  kubeNamespace: "",
};

// Loader-level pin for the PR #522 migration note's SYMLINK rule (task
// 6c8c1bae): a project layer keyed on a checkout SYMLINK's own name
// never resolves, because `deriveProjectName` (src/runtime/
// git-context.ts) realpaths the repository's common dir before taking
// its basename; a layer keyed on the REAL directory's basename resolves
// instead, even from a cwd that is still the symlink path. This drives
// the loader end to end through `explainPolicy`'s own exported
// projection (its `session_start_preflight.source` field, the same
// field the executed migration-note matrix in CHANGELOG.md/docs/CLI.md
// reads via `harness explain-policy ... --json`), not a rendered name
// explain-policy never prints, since only `explainPolicy` derives a
// project name from `opts.cwd` the way `harness session-start
// preflight` and `harness doctor` do (the describe blocks above pin the
// lower-level "opts.project must be explicit" contract this derivation
// feeds into).
describe("resolvePaths/loadManifest via explainPolicy's cwd-derivation seam: a symlinked checkout resolves the REAL basename's project layer, never the symlink's own name (task 6c8c1bae, PR #522 SYMLINK rule)", () => {
  let symlinkScratchRoot: string;
  let symlinkHome: string;

  function makeSymlinkedRepo(root: string): { realDir: string; linkPath: string } {
    const realDir = path.join(root, "real-name");
    fs.mkdirSync(path.join(realDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(realDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const linkPath = path.join(root, "link-name");
    fs.symlinkSync(realDir, linkPath, "dir");
    return { realDir, linkPath };
  }

  beforeEach(() => {
    symlinkScratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-symlink-fixture-"));
    symlinkHome = path.join(symlinkScratchRoot, "home");
    fs.mkdirSync(symlinkHome, { recursive: true });
    writeFixtureHomeManifest(
      symlinkHome,
      "preflight-before-symlink-fixture",
      "loader-level symlink/real-basename fixture (task 6c8c1bae)",
      false,
    );
  });

  afterEach(() => {
    fs.rmSync(symlinkScratchRoot, { recursive: true, force: true });
  });

  it("does not resolve a layer keyed on the symlink's own name: source stays base even though cwd IS the symlink path", () => {
    const { linkPath } = makeSymlinkedRepo(symlinkScratchRoot);
    writeFixtureProjectLayer(symlinkHome, "link-name", true);
    const eventFile = writeFixtureEvent(symlinkScratchRoot);
    const { projection } = explainPolicy("preflight-before-symlink-fixture", {
      ...FIXTURE_SEAMS,
      eventPath: eventFile,
      homeDir: symlinkHome,
      cwd: linkPath,
    });
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "base" });
  });

  it("resolves the layer keyed on the real directory's basename, reached THROUGH the symlink cwd", () => {
    const { realDir, linkPath } = makeSymlinkedRepo(symlinkScratchRoot);
    writeFixtureProjectLayer(symlinkHome, path.basename(realDir), true);
    const eventFile = writeFixtureEvent(symlinkScratchRoot);
    const { projection } = explainPolicy("preflight-before-symlink-fixture", {
      ...FIXTURE_SEAMS,
      eventPath: eventFile,
      homeDir: symlinkHome,
      cwd: linkPath,
    });
    expect(projection.session_start_preflight).toEqual({ setup: true, source: "project" });
  });
});

// Loader-level pin for the PR #522 migration note's CASING rule, LAYER
// DIRECTORY half (task 6c8c1bae, PR #522 CASING rule): docs/CLI.md's
// PER-REPO SCOPING bullet, MIGRATION note, says "A DIFFERENTLY-CASED
// layer directory resolves or not according to the filesystem
// HARNESS_HOME itself lives on"; this is about the PROJECT LAYER
// DIRECTORY's own on-disk name differing in case from the derived
// project name, a shape the producer-level fixture in
// tests/cli/session-start/preflight.test.ts does not exercise (that
// fixture pins linked-worktree derivation and raw-cwd passthrough, not
// casing). Here the cwd is a plain, non-symlinked checkout with no
// casing games of its own, so `deriveProjectName` returns the on-disk
// basename verbatim; only the LAYER DIRECTORY on disk is spelled
// differently. `resolvePaths`' own lookup (`fs.existsSync`,
// src/cli/loader.ts) is exactly as case-insensitive as the filesystem
// HARNESS_HOME lives on.
//
// task 6c8c1bae: both halves of the MIGRATION note's CASING sentence
// have an assertion, run unconditionally.
// The fixture's own HARNESS_HOME location is measured with the shared
// `isCaseInsensitiveFilesystem` probe (tests/_helpers/
// case-sensitivity.ts, also used by tests/runtime/git-context.test.ts's
// own inline copy) and the expectation branches on the result: a
// case-insensitive home resolves the layer (`source: "project"`), a
// case-sensitive one does not (`source: "base"`, the layer directory
// simply not found). Previously this test self-skipped entirely on a
// case-sensitive HARNESS_HOME (CI's ext4), so neither branch of the
// note was ever asserted there.
describe("resolvePaths/loadManifest via explainPolicy's cwd-derivation seam: a differently-cased project layer DIRECTORY (task 6c8c1bae, PR #522 CASING rule, docs/CLI.md PER-REPO SCOPING MIGRATION note)", () => {
  let casingScratchRoot: string;
  let casingHome: string;

  function makeCasingRepo(root: string, name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    return dir;
  }

  beforeEach(() => {
    casingScratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-casing-fixture-"));
    casingHome = path.join(casingScratchRoot, "home");
    fs.mkdirSync(casingHome, { recursive: true });
    writeFixtureHomeManifest(
      casingHome,
      "preflight-before-casing-fixture",
      "loader-level layer-directory-casing fixture (task 6c8c1bae)",
      false,
    );
  });

  afterEach(() => {
    fs.rmSync(casingScratchRoot, { recursive: true, force: true });
  });

  it("resolves a project layer directory whose on-disk name differs in case from the derived project name, only when HARNESS_HOME is case-insensitive", () => {
    const repoDir = makeCasingRepo(casingScratchRoot, "casing-layer-repo");
    // Layer directory deliberately spelled in a DIFFERENT case than the
    // derived project name ("casing-layer-repo", the repo's own,
    // unvaried basename).
    writeFixtureProjectLayer(casingHome, "CASING-LAYER-REPO", true);
    const eventFile = writeFixtureEvent(casingScratchRoot);
    const { projection } = explainPolicy("preflight-before-casing-fixture", {
      ...FIXTURE_SEAMS,
      eventPath: eventFile,
      homeDir: casingHome,
      cwd: repoDir,
    });
    if (isCaseInsensitiveFilesystem(casingHome)) {
      expect(projection.session_start_preflight).toEqual({ setup: true, source: "project" });
    } else {
      expect(projection.session_start_preflight).toEqual({ setup: false, source: "base" });
    }
  });
});
