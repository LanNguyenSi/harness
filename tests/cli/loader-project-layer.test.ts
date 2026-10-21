// Loader-level primitive underneath the per-repo project override layer
// story (task 30183330, review round 3; task `c88461c1` builds per-repo
// scoping on top of this contract).
//
// `resolvePaths` resolves a project override layer ONLY when
// `LoaderOptions.project` is explicitly set; it never inspects cwd or
// any other ambient signal on its own. This file pins that low-level
// contract in isolation: without `project`, a project override layer
// that sits on disk is neither resolved nor merged, so its override
// cannot influence what a caller reads. The same layer IS honoured when
// `project` is passed explicitly.
//
// The probe value here is `grounding.evidence_ledger.path`, chosen only
// because it is a scalar a project layer can override and whose base
// and project values are easy to tell apart. The contract under test
// belongs to the loader, not to the key: any deep-merged manifest field
// would exercise it identically.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadManifest, loadMergedRaw, resolvePaths } from "../../src/cli/loader.js";
import { run } from "../../src/cli/index.js";
import { EX_NOINPUT, EX_SOFTWARE, HarnessExitError } from "../../src/cli/exit-codes.js";
import { OverrideMergeError, applyLayers } from "../../src/overrides/merge.js";
import { mergeLayersStrippingRemovedPaths } from "../../src/overrides/merge-layers.js";
import { stripRemovedHookFields } from "../../src/schema/index.js";
import { validate } from "../../src/cli/validate/index.js";

const PROJECT_NAME = "scoped-repo";

const BASE_LEDGER_PATH = "~/.evidence-ledger/base.db";
const PROJECT_LEDGER_PATH = "~/.evidence-ledger/project-override.db";

let tmpHome: string;
let priorEnv: string | undefined;

const BASE_MANIFEST = [
  "version: 1",
  "hooks: []",
  "policies: []",
  "tools:",
  "  builtin:",
  "    known: [Read, Edit]",
  "grounding:",
  "  evidence_ledger:",
  `    path: ${BASE_LEDGER_PATH}`,
  "",
].join("\n");

const PROJECT_LAYER = [
  "grounding:",
  "  evidence_ledger:",
  `    path: ${PROJECT_LEDGER_PATH}`,
  "",
].join("\n");

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

describe("loadManifest: a project layer cannot scope its override without --project", () => {
  it("keeps the base manifest's value when opts.project is absent", () => {
    const { manifest, resolved } = loadManifest({ homeDir: tmpHome });
    expect(resolved.projectLayer).toBeNull();
    // The on-disk project layer overrides the path. If it were merged,
    // this would read the override, but a project layer only ever
    // applies when a caller passes a `LoaderOptions.project`; a bare
    // `resolvePaths`/`loadManifest` call with no `project` never reaches
    // it.
    expect(manifest.grounding?.evidence_ledger?.path).toBe(BASE_LEDGER_PATH);
  });

  it("applies the project layer's override when opts.project names it", () => {
    const { manifest } = loadManifest({ homeDir: tmpHome, project: PROJECT_NAME });
    expect(manifest.grounding?.evidence_ledger?.path).toBe(PROJECT_LEDGER_PATH);
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
    expect(manifest.grounding?.evidence_ledger?.path).toBe(BASE_LEDGER_PATH);
  });

  it("still resolves a valid opts.project name, unaffected by the new guard", () => {
    const resolved = resolvePaths({ homeDir: tmpHome, project: PROJECT_NAME });
    expect(resolved.projectLayer).toBe(
      path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"),
    );
  });
});

// Removed manifest keys in an override layer (task 10e2ff0a). The layer merge
// walks name-keyed lists and throws OverrideMergeError on a shape it cannot
// reconcile; every hook loads the manifest, so a stale layer whose removed
// `policies:` / `workflows:` list has such a shape must not fail the load.
describe("a removed manifest key in an override layer", () => {
  const NAMED = [{ name: "a", description: "x" }];
  // Each pair makes `applyLayers` throw: a list that mixes named and unnamed
  // entries, and a plain list laid over a named one.
  const HOSTILE: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["policies: mixed named and unnamed entries in the layer", { policies: NAMED }, { policies: [{ name: "b" }, "not-an-entry"] }],
    ["policies: a plain list over a named one", { policies: NAMED }, { policies: ["plain"] }],
    ["workflows: mixed named and unnamed entries in the layer", { workflows: NAMED }, { workflows: [{ name: "b" }, 5] }],
    ["workflows: a plain list over a named one", { workflows: NAMED }, { workflows: [1, 2] }],
    [
      "policies: a nested producers list that mixes shapes",
      { policies: [{ name: "a", producers: [{ name: "p" }] }] },
      { policies: [{ name: "a", producers: [{ name: "p" }, "bare"] }] },
    ],
  ];

  it.each(HOSTILE)("%s: the plain merge throws, the posture merge does not", (_label, base, layer) => {
    expect(() => applyLayers({ version: 1, ...base }, layer)).toThrow(OverrideMergeError);
    const { merged } = mergeLayersStrippingRemovedPaths({ version: 1, ...base }, [{ raw: layer, label: "L" }]);
    expect(merged).toEqual({ version: 1 });
  });

  it.each(HOSTILE)("%s: loadManifest loads the manifest and warns, naming the layer", (_label, base, layer) => {
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), JSON.stringify({ version: 1, ...base }));
    fs.writeFileSync(path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"), JSON.stringify(layer));
    const loaded = loadManifest({ homeDir: tmpHome, project: PROJECT_NAME });
    const key = Object.keys(layer)[0]!;
    expect(loaded.manifest).not.toHaveProperty(key);
    const fromLayer = loaded.warnings.filter((w) => w.path === key && w.message.includes("found in the project override layer"));
    expect(fromLayer).toHaveLength(1);
    // The base warns on its own, without a layer name.
    expect(loaded.warnings.filter((w) => w.path === key && !w.message.includes("found in the"))).toHaveLength(1);
  });

  it("loadMergedRaw (validate, the library) strips the keys too, so validate --strict fails on a non-empty layer value", () => {
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), JSON.stringify({ version: 1, policies: NAMED }));
    fs.writeFileSync(
      path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"),
      JSON.stringify({ policies: [{ name: "b" }, "not-an-entry"] }),
    );
    expect(loadMergedRaw({ homeDir: tmpHome, project: PROJECT_NAME }).mergedRaw).toEqual({ version: 1 });
    const lenient = validate({ homeDir: tmpHome, project: PROJECT_NAME, versionProbe: () => null, builtinRuntimeProbe: () => [] });
    expect(lenient.manifest).not.toBeNull();
    expect(lenient.diagnostics.filter((d) => d.path === "policies").map((d) => d.severity)).toEqual(["warning", "warning"]);
    const strict = validate({ homeDir: tmpHome, project: PROJECT_NAME, strict: true, versionProbe: () => null, builtinRuntimeProbe: () => [] });
    expect(strict.diagnostics.filter((d) => d.path === "policies").map((d) => d.severity)).toEqual(["error", "error"]);
  });

  it("a null in the layer does not hide the base's key: the base value still warns", () => {
    const { merged, warnings } = mergeLayersStrippingRemovedPaths({ version: 1, policies: NAMED }, [
      { raw: { policies: null }, label: "L" },
    ]);
    expect(merged).toEqual({ version: 1 });
    expect(warnings.map((w) => w.path)).toEqual(["policies"]);
    expect(warnings[0]!.message).not.toContain("found in");
  });

  it("an empty removed key in the layer stays silent, and the layers still merge as before", () => {
    const { merged, warnings } = mergeLayersStrippingRemovedPaths({ version: 1, grounding: { session: { auto_start: true } } }, [
      { raw: { policies: [], workflows: [], review_templates: {}, doctor: {}, grounding: { session: { auto_start: false } } }, label: "L" },
      { raw: undefined, label: "skipped" },
    ]);
    expect(warnings).toEqual([]);
    expect(merged).toEqual({ version: 1, grounding: { session: { auto_start: false } } });
  });

  it("merges the layers exactly like applyLayers when no removed key is present", () => {
    const base = { version: 1, tools: { mcp: [{ name: "m", command: "x" }] } };
    const l1 = { tools: { mcp: [{ name: "m", enabled: false }] } };
    const l2 = { tools: { mcp: [{ name: "n", command: "y" }] } };
    const { merged, warnings } = mergeLayersStrippingRemovedPaths(base, [
      { raw: l1, label: "L1" },
      { raw: undefined, label: "skipped" },
      { raw: l2, label: "L2" },
    ]);
    expect(merged).toEqual(applyLayers(base, l1, undefined, l2));
    expect(warnings).toEqual([]);
  });

  it("labels each layer's warning with that layer, and the base's with none", () => {
    const { warnings } = mergeLayersStrippingRemovedPaths({ version: 1, doctor: { ignore_template_drift: ["x"] } }, [
      { raw: { workflows: NAMED }, label: "machine override layer 1 (/m.yaml)" },
      { raw: { policies: NAMED }, label: "project override layer (/p.yaml)" },
    ]);
    expect(warnings.map((w) => w.path)).toEqual(["doctor", "workflows", "policies"]);
    expect(warnings[0]!.message).not.toContain("found in");
    expect(warnings[1]!.message).toContain("found in the machine override layer 1 (/m.yaml)");
    expect(warnings[2]!.message).toContain("found in the project override layer (/p.yaml)");
  });
});

// A removed per-hook field whose value is a list collides across sources the
// same way a removed top-level key does: `hooks[].bash_match` as a list of
// named objects in one source and a plain list in the other (same hook name)
// makes the name-keyed list merge throw, and every hook loads the manifest,
// so the load would lock the machine out. `stripRemovedHookFields`
// (src/schema/removed-keys.ts) strips the field from the base and from each
// layer before `applyLayers` runs; the hook is kept, and each source warns
// once for its own copy of the field (the layer's warning naming its label).
describe("a removed hooks[].bash_match list in base and layer", () => {
  const NAMED = [{ name: "a", pattern: "x" }];
  const PLAIN = ["git push"];
  const hookWith = (bashMatch: unknown) => ({
    name: "h",
    event: "Stop",
    command: "x",
    blocking: false,
    bash_match: bashMatch,
  });
  const COLLIDING: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["a named list in the base, a plain list in the layer", { version: 1, hooks: [hookWith(NAMED)] }, { hooks: [hookWith(PLAIN)] }],
    ["a plain list in the base, a named list in the layer", { version: 1, hooks: [hookWith(PLAIN)] }, { hooks: [hookWith(NAMED)] }],
  ];

  it.each(COLLIDING)("%s: the plain merge throws, the posture merge strips the field first and keeps the hook", (_label, base, layer) => {
    expect(() => applyLayers(base, layer)).toThrow(OverrideMergeError);
    const { merged, warnings } = mergeLayersStrippingRemovedPaths(base, [{ raw: layer, label: "L" }]);
    expect(merged).toEqual({ version: 1, hooks: [{ name: "h", event: "Stop", command: "x", blocking: false }] });
    expect(warnings.map((w) => w.path)).toEqual(["hooks[0]", "hooks[0]"]);
    expect(warnings[0]!.message).toContain('hook "h" carries bash_match');
    expect(warnings[0]!.message).not.toContain("found in the");
    expect(warnings[1]!.message).toContain('hook "h" carries bash_match');
    expect(warnings[1]!.message).toContain("found in the L");
  });

  it("does not mutate the base or the layer it merges", () => {
    const base = { version: 1, hooks: [hookWith(NAMED)] };
    const layer = { hooks: [hookWith(PLAIN)] };
    const baseBefore = JSON.stringify(base);
    const layerBefore = JSON.stringify(layer);
    mergeLayersStrippingRemovedPaths(base, [{ raw: layer, label: "L" }]);
    expect(JSON.stringify(base)).toBe(baseBefore);
    expect(JSON.stringify(layer)).toBe(layerBefore);
  });

  it("stripRemovedHookFields leaves a source without the fields untouched, returning the same object", () => {
    const clean = { version: 1, hooks: [{ name: "h", event: "Stop", command: "x", blocking: false }] };
    const stripped = stripRemovedHookFields(clean);
    expect(stripped.raw).toBe(clean);
    expect(stripped.warnings).toEqual([]);
    const noHooks = { version: 1 };
    expect(stripRemovedHookFields(noHooks).raw).toBe(noHooks);
  });
});

// Five layer contents parse to a value of `null` to merge: an empty file and
// a comment-only file parse to no YAML document at all, and an explicit
// `null`, `~`, or a bare `---` is a document whose value is null. Merged,
// that null was a root tombstone: the whole manifest disappeared, the strict
// parse failed with `<root>: Required`, and every hook (the branch-protection
// hook first, which fails closed on any load error) refused every Write/Edit.
// Such a layer is now skipped with one warning naming the file, and the
// manifest loads as if the layer were absent. A layer whose root is a scalar
// or a list is not an absent layer but a broken one, and fails the load with
// an error naming the file.
describe("an override layer that is empty, comment-only, or not a mapping", () => {
  type LayerCase = [
    name: string,
    file: () => string,
    opts: () => { homeDir: string; project?: string },
    label: () => string,
  ];

  const MACHINE_FILE = (): string => path.join(tmpHome, "machines", "default.harness.overrides.yaml");
  const PROJECT_FILE = (): string => path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml");

  const LAYERS: LayerCase[] = [
    ["machine layer", MACHINE_FILE, () => ({ homeDir: tmpHome }), () => `machine override layer 1 (${MACHINE_FILE()})`],
    ["project layer", PROJECT_FILE, () => ({ homeDir: tmpHome, project: PROJECT_NAME }), () => `project override layer (${PROJECT_FILE()})`],
  ];

  function writeLayer(file: () => string, content: string): void {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const EMPTY_LAYER_WARNING =
    "this override layer has no value to merge (an empty or comment-only file has no YAML document in it; " +
    "`null`, `~`, and a bare `---` are documents whose value is null); it is skipped and the manifest loads " +
    "as if it were absent";

  const NO_DOCUMENT: Array<[string, string]> = [
    ["an empty file", ""],
    ["a comment-only file", "# only a comment\n"],
    ["a document whose value is an explicit null", "null\n"],
    ["a document whose value is a tilde", "~\n"],
    ["a bare --- document", "---\n"],
  ];

  it.each(LAYERS)("%s: a layer with no value to merge loads as if it were absent, with one warning naming it", (_name, file, opts) => {
    // The manifest with no such layer on disk is the expected result.
    fs.rmSync(file(), { force: true });
    const without = loadManifest(opts());
    expect(without.warnings).toEqual([]);
    for (const [label, content] of NO_DOCUMENT) {
      writeLayer(file, content);
      const loaded = loadManifest(opts());
      expect(loaded.manifest, `${_name}: ${label}`).toEqual(without.manifest);
      expect(loaded.warnings, `${_name}: ${label}`).toHaveLength(1);
      expect(loaded.warnings[0]!.path, `${_name}: ${label}`).toBe("<root>");
      expect(loaded.warnings[0]!.message, `${_name}: ${label}`).toContain(EMPTY_LAYER_WARNING);
      expect(loaded.warnings[0]!.message, `${_name}: ${label}`).toContain(file());
    }
  });

  it.each(LAYERS)("%s: a scalar or list root fails the load with an error naming the file", (_name, file, opts, layerLabel) => {
    const NON_MAPPING: Array<[string, string, string]> = [
      ["a number", "42\n", "a number"],
      ["a string", "nope\n", "a string"],
      ["a list", "- a\n- b\n", "a list"],
    ];
    for (const [label, content, shape] of NON_MAPPING) {
      writeLayer(file, content);
      let caught: unknown;
      try {
        loadManifest(opts());
      } catch (err) {
        caught = err;
      }
      expect(caught, label).toBeInstanceOf(HarnessExitError);
      const err = caught as HarnessExitError;
      expect(err.exitCode, label).toBe(EX_NOINPUT);
      // The WHOLE message, anchored: the layer-root error surfaces verbatim
      // (no `override merge failed at` prefix), so a prefix added back to
      // the message fails here.
      expect(err.message, label).toBe(
        `an override layer must be a mapping of manifest keys to their overrides, but the ${layerLabel()} is ${shape}`,
      );
    }
  });

  it("warns exactly once per skipped layer, naming that layer's own file", () => {
    writeLayer(MACHINE_FILE, "");
    writeLayer(PROJECT_FILE, "# nothing\n");
    const loaded = loadManifest({ homeDir: tmpHome, project: PROJECT_NAME });
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings.map((w) => w.path)).toEqual(["<root>", "<root>"]);
    expect(loaded.warnings[0]!.message).toContain(MACHINE_FILE());
    expect(loaded.warnings[0]!.message).not.toContain(PROJECT_FILE());
    expect(loaded.warnings[1]!.message).toContain(PROJECT_FILE());
  });

  it("keeps merging the other layers around a skipped one", () => {
    writeLayer(MACHINE_FILE, "");
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), JSON.stringify({ version: 1 }));
    const loaded = loadManifest({ homeDir: tmpHome, project: PROJECT_NAME });
    // The project layer (PROJECT_LAYER, written by beforeEach) still applies.
    expect(loaded.manifest.grounding?.evidence_ledger?.path).toBe(PROJECT_LEDGER_PATH);
  });
});

// The CLI-side split the loader keeps: a layer root that is not
// a mapping is a bad input and exits EX_NOINPUT, while a shape conflict at a
// path (any other OverrideMergeError) is not an input problem and reaches
// run()'s generic failure path (exit 70) with the merge error's own message,
// exactly as it did before the layer-root error moved into the overrides
// library. Pinned through run() with $HARNESS_HOME at the fixture home (the
// binary's own env opt-in, set by src/cli/main.ts, so resolvePaths accepts
// the no-configPath resolution; nothing outside tmpHome is read).
describe("run(): a layer-root failure exits 66, a merge shape conflict exits 70", () => {
  let savedHomeEnv: string | undefined;
  let savedGenEnv: string | undefined;

  beforeEach(() => {
    savedHomeEnv = process.env["HARNESS_HOME"];
    savedGenEnv = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
    process.env["HARNESS_HOME"] = tmpHome;
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) delete process.env["HARNESS_HOME"];
    else process.env["HARNESS_HOME"] = savedHomeEnv;
    if (savedGenEnv === undefined) delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
    else process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = savedGenEnv;
  });

  it("a project-layer shape conflict (plain list over a named one) exits 70 with the merge message", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "harness.yaml"),
      JSON.stringify({ version: 1, hooks: [{ name: "h", event: "Stop", command: "x" }] }),
    );
    fs.writeFileSync(
      path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"),
      JSON.stringify({ hooks: ["plain"] }),
    );
    let stderr = "";
    const code = await run({
      argv: ["validate", "--project", PROJECT_NAME],
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(EX_SOFTWARE);
    expect(stderr).toBe(
      "override merge failed at hooks: cannot merge override plain-list onto base named-list; " +
        "declare the override as the same shape or omit it\n",
    );
  });

  it("a project layer whose root is a list exits 66 with the layer-naming message", async () => {
    fs.writeFileSync(
      path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml"),
      "- a\n- b\n",
    );
    let stderr = "";
    const code = await run({
      argv: ["validate", "--project", PROJECT_NAME],
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(EX_NOINPUT);
    expect(stderr).toBe(
      "an override layer must be a mapping of manifest keys to their overrides, but the " +
        `project override layer (${path.join(tmpHome, "projects", PROJECT_NAME, "harness.overrides.yaml")}) is a list\n`,
    );
  });
});
