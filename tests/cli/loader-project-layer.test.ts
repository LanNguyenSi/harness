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
