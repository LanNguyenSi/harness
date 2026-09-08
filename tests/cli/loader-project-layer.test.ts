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
import { loadManifest, resolvePaths } from "../../src/cli/loader.js";

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
