// Removed-key posture for the policy, workflow, review-template and doctor
// keys and for `hooks[].bash_match` / `hooks[].path_match` (task 10e2ff0a).
//
// The manifest load is shared by every hook, and the branch-protection hook
// refuses every edit when it fails, so a machine whose manifest still carries
// one of these keys must still load it. Every row here goes through the real
// load (`loadManifest`, `validate`, `doctor`, `apply`, the branch-protection
// hook) from files on disk, in the base manifest and in a project override
// layer, never through the strip helper alone.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { apply } from "../../src/cli/apply/index.js";
import { generateSettings } from "../../src/cli/apply/generate-settings.js";
import { doctor } from "../../src/cli/doctor/index.js";
import { exportManifest } from "../../src/cli/export.js";
import { list } from "../../src/cli/list.js";
import { loadManifest } from "../../src/cli/loader.js";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import { validate } from "../../src/cli/validate/index.js";
import { OverrideMergeError, applyLayers } from "../../src/overrides/merge.js";
import {
  REMOVED_HOOK_FIELDS,
  REMOVED_MANIFEST_PATHS,
  parseManifestWithWarnings,
  stripRemovedHookFields,
  stripRemovedManifestPaths,
} from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const PROJECT = "scoped-repo";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BRANCH_PROTECTION = [{ name: "branch-protection", source: "builtin", enabled: true }];

/** A harness home: the base manifest and, optionally, a project override layer. JSON is valid YAML. */
function makeHome(base: Record<string, unknown>, layer?: Record<string, unknown>): string {
  const home = tmpDir("harness-removed-keys-");
  fs.writeFileSync(path.join(home, "harness.yaml"), JSON.stringify({ version: 1, ...base }), "utf8");
  if (layer !== undefined) {
    const dir = path.join(home, "projects", PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "harness.overrides.yaml"), JSON.stringify(layer), "utf8");
  }
  return home;
}

const NOOP_PROBES = { versionProbe: () => null, builtinRuntimeProbe: () => [] as string[] };

type Where = "base" | "project layer";

/** The manifest on disk for one row: the value sits in the base or in the layer. */
function homeWith(where: Where, content: Record<string, unknown>): { home: string; opts: { homeDir: string; project?: string } } {
  if (where === "base") {
    const home = makeHome(content);
    return { home, opts: { homeDir: home } };
  }
  const home = makeHome({}, content);
  return { home, opts: { homeDir: home, project: PROJECT } };
}

const KEYS = ["policies", "workflows", "review_templates", "doctor"] as const;

// Values that configure nothing. The strip is silent for them.
const EMPTY_VALUES: Array<[string, unknown]> = [
  ["an empty list", []],
  ["an empty map", {}],
  ["null", null],
];

// Values that do configure something, or are not even the right type. The
// strip warns for each, whatever the shape.
const NON_EMPTY_VALUES: Array<[string, unknown]> = [
  ["a list of named maps", [{ name: "a", description: "x" }]],
  ["a list that mixes named and unnamed entries", [{ name: "a" }, "bare", 5]],
  ["a list of scalars", ["a", "b"]],
  ["nested empty containers", [[], {}]],
  ["a map", { a: { deep: [1, { name: "x" }] } }],
  ["a string", "policies please"],
  ["an empty string", ""],
  ["a number", 7],
  ["zero", 0],
  ["true", true],
  ["false", false],
];

describe("the removed-key table", () => {
  it("lists policies, workflows, review_templates and doctor as whole keys that are silent when empty", () => {
    for (const key of KEYS) {
      const entry = REMOVED_MANIFEST_PATHS.find((p) => p.path === key);
      expect(entry, key).toBeDefined();
      expect(entry!.silentWhenEmpty, key).toBe(true);
      expect(entry!.removedIn).toBe("1.0.0");
      expect(entry!.reason.length).toBeGreaterThan(0);
    }
  });

  it("lists exactly bash_match and path_match as removed hook fields", () => {
    expect(REMOVED_HOOK_FIELDS.map((f) => f.field)).toEqual(["bash_match", "path_match"]);
    for (const f of REMOVED_HOOK_FIELDS) {
      expect(f.removedIn).toBe("1.0.0");
      expect(f.reason.length).toBeGreaterThan(0);
    }
  });
});

describe.each<Where>(["base", "project layer"])("a removed key in the %s", (where) => {
  describe.each(KEYS)("%s", (key) => {
    it.each(EMPTY_VALUES)("%s is stripped silently: the manifest loads, nothing warns, validate --strict passes", (_label, value) => {
      const { opts } = homeWith(where, { [key]: value });
      const loaded = loadManifest(opts);
      expect(loaded.manifest).not.toHaveProperty(key);
      expect(loaded.warnings).toEqual([]);
      const lenient = validate({ ...opts, ...NOOP_PROBES });
      expect(lenient.manifest).not.toBeNull();
      expect(lenient.diagnostics.filter((d) => d.path === key)).toEqual([]);
      const strict = validate({ ...opts, strict: true, ...NOOP_PROBES });
      expect(strict.diagnostics.filter((d) => d.path === key)).toEqual([]);
      expect(strict.errorCount).toBe(0);
    });

    it.each(NON_EMPTY_VALUES)("%s warns once: the manifest loads, validate warns, validate --strict fails", (_label, value) => {
      const { opts } = homeWith(where, { [key]: value });
      const loaded = loadManifest(opts);
      expect(loaded.manifest).not.toHaveProperty(key);
      const warned = loaded.warnings.filter((w) => w.path === key);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.message).toContain("removed in 1.0.0 and ignored");
      expect(warned[0]!.message.includes("found in the project override layer")).toBe(where === "project layer");
      const lenient = validate({ ...opts, ...NOOP_PROBES });
      expect(lenient.manifest).not.toBeNull();
      expect(lenient.diagnostics.filter((d) => d.path === key).map((d) => d.severity)).toEqual(["warning"]);
      expect(lenient.errorCount).toBe(0);
      const strict = validate({ ...opts, strict: true, ...NOOP_PROBES });
      expect(strict.diagnostics.filter((d) => d.path === key).map((d) => d.severity)).toEqual(["error"]);
      expect(strict.errorCount).toBe(1);
    });
  });
});

// YAML-typed values have no own enumerable keys, like `{}`, but they configure
// something, so they warn. Written as YAML text so the tags survive.
describe("a YAML-typed value of a removed key warns", () => {
  it.each<[string, string]>([
    ["a !!set", "policies: !!set {a, b}"],
    ["an !!omap", "workflows: !!omap [ {a: 1} ]"],
    ["a !!timestamp", "doctor: !!timestamp 2001-12-14"],
  ])("%s", (_label, line) => {
    const home = tmpDir("harness-removed-keys-");
    fs.writeFileSync(path.join(home, "harness.yaml"), `version: 1\n${line}\n`, "utf8");
    const key = line.slice(0, line.indexOf(":"));
    expect(loadManifest({ homeDir: home }).warnings.map((w) => w.path)).toEqual([key]);
  });
});

describe("an empty map without a prototype stays silent", () => {
  it("Object.create(null) counts as {}", () => {
    expect(stripRemovedManifestPaths({ version: 1, doctor: Object.create(null) }).warnings).toEqual([]);
  });
});

describe("the notes on the non-empty policies and workflows keys", () => {
  const warningFor = (key: string, value: unknown): string => {
    const { opts } = homeWith("base", { [key]: value });
    return loadManifest(opts).warnings.find((w) => w.path === key)!.message;
  };

  it("policies counts the policies that are no longer evaluated and names them", () => {
    expect(warningFor("policies", [{ name: "gate-a" }])).toContain('1 policy is no longer evaluated ("gate-a")');
    expect(warningFor("policies", [{ name: "gate-a" }, { name: "gate-b" }, { description: "unnamed" }])).toContain(
      '3 policies are no longer evaluated ("gate-a", "gate-b")',
    );
  });

  it("policies caps the names it lists", () => {
    const policies = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name }));
    expect(warningFor("policies", policies)).toContain(
      '7 policies are no longer evaluated ("a", "b", "c", "d", "e", and 2 more)',
    );
  });

  it("policies without names counts them and lists no names", () => {
    const message = warningFor("policies", ["a", "b"]);
    expect(message).toMatch(/ 2 policies are no longer evaluated$/);
  });

  it("policies that is not a list still says it is no longer evaluated", () => {
    expect(warningFor("policies", "oops")).toContain("manifest policies are no longer evaluated");
  });

  it("workflows says the workflow-derived review gates are not enforced", () => {
    expect(warningFor("workflows", [{ name: "ship", steps: [] }])).toContain(
      "workflow-derived review gates are no longer enforced",
    );
  });

  it("review_templates and doctor carry the reason and no extra sentence", () => {
    expect(warningFor("review_templates", { t1: "x" })).toMatch(/delete it from the manifest$/);
    expect(warningFor("doctor", { ignore_template_drift: ["x"] })).toMatch(/delete it from the manifest$/);
  });
});

// Hooks that carry the removed per-hook filters in every combination. The
// hook stays; only the keys go.
const HOOKS = [
  { name: "only-bash", event: "PreToolUse", match: "Bash", bash_match: "^git push", command: "/usr/bin/true", blocking: "hard" },
  { name: "only-path", event: "PreToolUse", match: "Edit", path_match: "**/*.env", command: "/usr/bin/true", blocking: "soft" },
  { name: "both", event: "PostToolUse", bash_match: ["not", "a", "string"], path_match: null, command: "/usr/bin/true", blocking: false },
  { name: "neither", event: "Stop", command: "/usr/bin/true", blocking: false },
  { name: "empty-string", event: "SessionStart", bash_match: "", command: "/usr/bin/true", blocking: false },
];
const HOOKS_WITHOUT_FIELDS = HOOKS.map(({ bash_match: _b, path_match: _p, ...rest }) => rest);

describe("hooks[].bash_match and hooks[].path_match", () => {
  it("are stripped per hook: every hook stays, one warning per hook that carried a key, naming its index and name", () => {
    const { opts } = homeWith("base", { hooks: HOOKS });
    const loaded = loadManifest(opts);
    expect(loaded.manifest.hooks.map((h) => h.name)).toEqual(HOOKS.map((h) => h.name));
    for (const h of loaded.manifest.hooks) {
      expect(h).not.toHaveProperty("bash_match");
      expect(h).not.toHaveProperty("path_match");
    }
    const warned = loaded.warnings.filter((w) => w.path.startsWith("hooks["));
    expect(warned.map((w) => w.path)).toEqual(["hooks[0]", "hooks[1]", "hooks[2]", "hooks[4]"]);
    expect(warned[0]!.message).toContain('hook "only-bash" carries bash_match');
    expect(warned[1]!.message).toContain('hook "only-path" carries path_match');
    expect(warned[2]!.message).toContain('hook "both" carries bash_match and path_match');
    expect(warned[3]!.message).toContain('hook "empty-string" carries bash_match');
    for (const w of warned) expect(w.message).toContain("the field is ignored");
  });

  it("do not change what the hooks are projected into: settings.json is identical with and without them", () => {
    const withFields = loadManifest(homeWith("base", { hooks: HOOKS }).opts).manifest;
    const without = loadManifest(homeWith("base", { hooks: HOOKS_WITHOUT_FIELDS }).opts).manifest;
    expect(generateSettings(withFields)).toEqual(generateSettings(without));
    expect(withFields.hooks).toEqual(without.hooks);
  });

  it("in a project override layer: a key added to a base hook, and a layer-only hook, are stripped and warn", () => {
    const { opts } = homeWith("base", {});
    fs.writeFileSync(
      path.join(opts.homeDir, "harness.yaml"),
      JSON.stringify({
        version: 1,
        hooks: [{ name: "base-hook", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
      }),
    );
    const dir = path.join(opts.homeDir, "projects", PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "harness.overrides.yaml"),
      JSON.stringify({
        hooks: [
          { name: "base-hook", bash_match: "^npm publish" },
          { name: "layer-hook", event: "Stop", command: "/usr/bin/true", blocking: false, path_match: "src/**" },
        ],
      }),
    );
    const loaded = loadManifest({ ...opts, project: PROJECT });
    expect(loaded.manifest.hooks.map((h) => h.name)).toEqual(["base-hook", "layer-hook"]);
    expect(loaded.warnings.map((w) => w.path)).toEqual(["hooks[0]", "hooks[1]"]);
    expect(loaded.warnings[0]!.message).toContain('hook "base-hook" carries bash_match');
    expect(loaded.warnings[1]!.message).toContain('hook "layer-hook" carries path_match');
  });

  it("validate warns per hook and --strict fails exactly on those", () => {
    const { opts } = homeWith("base", { hooks: HOOKS });
    const lenient = validate({ ...opts, ...NOOP_PROBES });
    expect(lenient.diagnostics.filter((d) => /^hooks\[\d+\]$/.test(d.path)).map((d) => [d.path, d.severity])).toEqual([
      ["hooks[0]", "warning"],
      ["hooks[1]", "warning"],
      ["hooks[2]", "warning"],
      ["hooks[4]", "warning"],
    ]);
    const strict = validate({ ...opts, strict: true, ...NOOP_PROBES });
    expect(strict.diagnostics.filter((d) => /^hooks\[\d+\]$/.test(d.path)).map((d) => d.severity)).toEqual([
      "error",
      "error",
      "error",
      "error",
    ]);
    const clean = homeWith("base", { hooks: HOOKS_WITHOUT_FIELDS });
    expect(validate({ ...clean.opts, strict: true, ...NOOP_PROBES }).diagnostics.filter((d) => d.path.startsWith("hooks["))).toEqual([]);
  });

  it("parse a hook that carries the key like a hook without it (a hook that was never valid still fails)", () => {
    expect(() => parseManifestWithWarnings({ version: 1, hooks: [{ name: "h", event: "Stop", command: "x", blocking: false, bash_matchh: "y" }] })).toThrow();
    expect(() => parseManifestWithWarnings({ version: 1, hooks: [{ name: "h", event: "Stop", command: "x", blocking: false, bash_match: "y" }] })).not.toThrow();
  });

  it("a hooks value that is not a list, and entries that are not maps, are left for the strict parse", () => {
    expect(() => parseManifestWithWarnings({ version: 1, hooks: "no" })).toThrow();
    expect(() => parseManifestWithWarnings({ version: 1, hooks: ["no"] })).toThrow();
  });
});

// The loader path strips the hook fields twice: before the merge
// (`stripRemovedHookFields`, used by `mergeLayersStrippingRemovedPaths`, so a
// list that collides across sources cannot throw), and after it
// (`stripRemovedManifestEntries`, the safety net for callers that parse a
// single file without merging). The pre-merge strip leaves the post-merge one
// nothing: a field warns once per source that carries it, never twice.
describe("hooks[].bash_match through the loader: one warning per source, never twice", () => {
  const hookWith = (bashMatch: unknown) => ({
    name: "h",
    event: "Stop",
    command: "x",
    blocking: false,
    bash_match: bashMatch,
  });

  it("in the base only: exactly one bash_match warning from merge plus parse, unlabelled", () => {
    const { opts } = homeWith("base", { hooks: [hookWith("^git push")] });
    const loaded = loadManifest(opts);
    const warned = loaded.warnings.filter((w) => w.path === "hooks[0]");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('hook "h" carries bash_match');
    expect(warned[0]!.message).not.toContain("found in the");
    expect(loaded.manifest.hooks.map((h) => h.name)).toEqual(["h"]);
    expect(loaded.manifest.hooks[0]).not.toHaveProperty("bash_match");
  });

  it("in the base and in a project layer with colliding list shapes: one warning per source (base unlabelled, layer labelled), and the load does not fail", () => {
    const home = makeHome({ hooks: [hookWith([{ name: "a", pattern: "x" }])] }, { hooks: [hookWith(["git push"])] });
    const loaded = loadManifest({ homeDir: home, project: PROJECT });
    const warned = loaded.warnings.filter((w) => w.path === "hooks[0]");
    expect(warned).toHaveLength(2);
    expect(warned.filter((w) => !w.message.includes("found in the"))).toHaveLength(1);
    expect(warned.filter((w) => w.message.includes("found in the project override layer"))).toHaveLength(1);
    expect(loaded.manifest.hooks.map((h) => h.name)).toEqual(["h"]);
    expect(loaded.manifest.hooks[0]).not.toHaveProperty("bash_match");
  });

  // The warning text, pinned. It says the FIELD is ignored and never claims
  // the hook survives: the strip runs per source before the merge, and a
  // later layer can still delete the hook (`_delete`, `hooks: null`), so no
  // wording about the hook would be true in every case.
  const CARRIED = 'carries bash_match, removed in 1.0.0 (it was never projected into settings.json or the Codex config, so the hook runs on the same events with or without it); the field is ignored, delete the key from it';

  it("a valid string bash_match in the base only: the hook survives, warning text pinned", () => {
    const { opts } = homeWith("base", { hooks: [HOOKS[0]] });
    const loaded = loadManifest(opts);
    expect(loaded.manifest.hooks.map((h) => h.name)).toEqual(["only-bash"]);
    expect(loaded.manifest.hooks[0]).not.toHaveProperty("bash_match");
    const warned = loaded.warnings.filter((w) => w.path === "hooks[0]");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toBe(`hook "only-bash" ${CARRIED}`);
  });

  it("in the base hook, deleted by a later layer: the same pinned warning, and the hook is gone", () => {
    const home = makeHome({ hooks: [hookWith("^git push")] }, { hooks: [{ name: "h", _delete: true }] });
    const loaded = loadManifest({ homeDir: home, project: PROJECT });
    expect(loaded.manifest.hooks).toEqual([]);
    const warned = loaded.warnings.filter((w) => w.path === "hooks[0]");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toBe(`hook "h" ${CARRIED}`);
    expect(warned[0]!.message).not.toContain("found in the");
  });
});

describe("stripRemovedHookFields (the pre-merge strip of one raw source)", () => {
  it("strips the removed fields from the hooks, warns one per hook, keeps the rest, and does not mutate its input", () => {
    const src = { version: 1, hooks: [{ name: "a", bash_match: "x" }, { name: "b", path_match: ["y"] }], policies: [] };
    const before = JSON.stringify(src);
    const { raw, warnings } = stripRemovedHookFields(src);
    expect(raw).toEqual({ version: 1, hooks: [{ name: "a" }, { name: "b" }], policies: [] });
    expect(warnings.map((w) => w.path)).toEqual(["hooks[0]", "hooks[1]"]);
    expect(warnings[0]!.message).toContain('hook "a" carries bash_match');
    expect(warnings[1]!.message).toContain('hook "b" carries path_match');
    expect(JSON.stringify(src)).toBe(before);
  });
});

describe("a layer shape the override merge cannot reconcile", () => {
  // The merge walks name-keyed lists and throws on a mixed or mismatched shape.
  // The plain merge of these pairs throws; the load must not.
  const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["policies mixing named and unnamed entries", { policies: [{ name: "a" }] }, { policies: [{ name: "b" }, "bare"] }],
    ["policies, a plain list over a named one", { policies: [{ name: "a" }] }, { policies: ["plain"] }],
    ["workflows mixing named and unnamed entries", { workflows: [{ name: "a" }] }, { workflows: [{ name: "b" }, 3] }],
    ["policies with a nested producers list that mixes shapes", { policies: [{ name: "a", producers: [{ name: "p" }] }] }, { policies: [{ name: "a", producers: [{ name: "p" }, "bare"] }] }],
  ];

  it.each(CASES)("%s: applyLayers throws, loadManifest loads and warns", (_label, base, layer) => {
    expect(() => applyLayers({ version: 1, ...base }, layer)).toThrow(OverrideMergeError);
    const home = makeHome(base, layer);
    const loaded = loadManifest({ homeDir: home, project: PROJECT });
    const key = Object.keys(layer)[0]!;
    expect(loaded.manifest).not.toHaveProperty(key);
    expect(loaded.warnings.filter((w) => w.path === key).length).toBe(2);
  });
});

describe("the install and read commands on a manifest that carries every removed key", () => {
  const EVERYTHING = {
    hooks: HOOKS,
    policies: [{ name: "p", description: "d", trigger: { event: "PreToolUse" }, hook: "only-bash", enforcement: "block", operator_only: true, when: { x: 1 } }],
    workflows: [{ name: "ship", steps: [{ kind: "merge" }] }],
    review_templates: { t: "x" },
    doctor: { ignore_template_drift: ["a"] },
    policy_packs: BRANCH_PROTECTION,
  };

  it("doctor lists the posture warnings and still reports the hooks", async () => {
    const home = makeHome(EVERYTHING);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.manifest.warnings.map((w) => w.split(":")[0])).toEqual([
      "policies",
      "workflows",
      "review_templates",
      "doctor",
      "hooks[0]",
      "hooks[1]",
      "hooks[2]",
      "hooks[4]",
    ]);
    expect(report.hooks.map((h) => h.name)).toEqual(HOOKS.map((h) => h.name));
    expect(report).not.toHaveProperty("policies");
  });

  it("apply applies the manifest and prints the same warnings", async () => {
    const home = makeHome(EVERYTHING);
    const result = await apply({ configPath: path.join(home, "harness.yaml"), homeDir: home });
    expect(result.outcome).toBe("applied");
    expect(result.warnings.filter((w) => /^(policies|workflows|review_templates|doctor|hooks\[\d+\]):/.test(w)).length).toBe(8);
  });

  it("export emits the manifest without the removed keys, and the warnings beside it", () => {
    const home = makeHome(EVERYTHING);
    const r = exportManifest({ configPath: path.join(home, "harness.yaml"), json: true });
    const parsed = JSON.parse(r.output) as Record<string, unknown>;
    for (const key of KEYS) expect(parsed).not.toHaveProperty(key);
    expect(r.warnings).toHaveLength(8);
  });

  it("list still lists the hooks, with no bash_match column", () => {
    const home = makeHome(EVERYTHING);
    const r = list("hooks", { configPath: path.join(home, "harness.yaml") });
    expect(r.rows.map((row) => row.name)).toEqual(HOOKS.map((h) => h.name));
    for (const row of r.rows) expect(row).not.toHaveProperty("bash_match");
  });
});

// A real repository on `branch`, with git isolated from the host's config.
function makeRepo(branch: string): string {
  const repo = path.join(tmpDir("harness-removed-keys-repo-"), "repo");
  fs.mkdirSync(repo);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  execFileSync("git", ["-c", `init.defaultBranch=${branch}`, "init", "-q"], { cwd: repo, env });
  return repo;
}

async function decide(
  configOpts: { homeDir: string; project?: string },
  repo: string,
  runtime: "claude-code" | "codex" = "claude-code",
): Promise<{ blocked: boolean; exitCode: number }> {
  const stdin = new PassThrough();
  stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s",
      tool_name: "Write",
      cwd: repo,
      tool_input: { file_path: path.join(repo, "x.ts"), content: "x" },
    }),
  );
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const r = await runPackHookBranchProtectionCli({
    stdin,
    stdout: sink,
    stderr: sink,
    configPath: path.join(configOpts.homeDir, "harness.yaml"),
    ...configOpts,
    runtime,
  });
  return { blocked: r.blocked, exitCode: r.exitCode };
}

describe.skipIf(!GIT_AVAILABLE)("branch-protection still decides on a manifest that carries every removed key in every shape", () => {
  // Each shape of each key, in the base and in the project override layer, at
  // once. The mixed lists are shapes the layer merge cannot reconcile.
  const everyShape = (): Record<string, unknown> => ({
    policies: [{ name: "a", when: { x: 1 } }, "bare", 5, null],
    workflows: [{ name: "a" }, "bare"],
    review_templates: ["not", "a", "map"],
    doctor: "not a map",
  });
  const emptyShapes = (): Record<string, unknown> => ({ policies: [], workflows: [], review_templates: {}, doctor: null });

  it.each<[string, () => Record<string, unknown>]>([
    ["every key with a value", everyShape],
    ["every key empty", emptyShapes],
  ])("%s, base and project layer: refuses on a protected branch, allows a feature branch", async (_label, shapes) => {
    const base = { policy_packs: BRANCH_PROTECTION, hooks: HOOKS, ...shapes() };
    const layer = { ...shapes(), hooks: [{ name: "only-bash", bash_match: "^layer", path_match: "layer/**" }] };
    const home = makeHome(base, layer);
    const loaded = loadManifest({ homeDir: home, project: PROJECT });
    expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
    for (const key of KEYS) expect(loaded.manifest).not.toHaveProperty(key);

    for (const project of [undefined, PROJECT]) {
      const opts = { homeDir: home, ...(project !== undefined ? { project } : {}) };
      const protectedRepo = makeRepo("master");
      expect(await decide(opts, protectedRepo)).toEqual({ blocked: true, exitCode: 0 });
      const featureRepo = makeRepo("feat/x");
      expect(await decide(opts, featureRepo)).toEqual({ blocked: false, exitCode: 0 });
    }
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection with a removed key in a machine override layer, on both runtimes", () => {
  // The generated hook reads the machine layers (machines/default|<os>|<host>)
  // without --project. A merge-hostile removed key that only the machine layer
  // carries must not fail the load on either runtime.
  it("refuses on a protected branch and allows a feature branch", async () => {
    // The base carries named lists, so the layer's mixed lists collide with
    // them: without the pre-merge strip the layer merge would throw.
    const home = makeHome({ policy_packs: BRANCH_PROTECTION, policies: [{ name: "x" }], workflows: [{ name: "y" }] });
    const machines = path.join(home, "machines");
    fs.mkdirSync(machines, { recursive: true });
    fs.writeFileSync(
      path.join(machines, "default.harness.overrides.yaml"),
      JSON.stringify({ policies: [{ name: "a" }, "bare", 5], workflows: [{ name: "w" }, "bare"] }),
      "utf8",
    );
    const loaded = loadManifest({ homeDir: home });
    expect(loaded.warnings.map((w) => w.path).sort()).toEqual(["policies", "policies", "workflows", "workflows"]);
    expect(loaded.warnings.filter((w) => /found in the /.test(w.message))).toHaveLength(2);
    expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
    const protectedRepo = makeRepo("master");
    const featureRepo = makeRepo("feat/x");
    expect(await decide({ homeDir: home }, protectedRepo)).toEqual({ blocked: true, exitCode: 0 });
    expect(await decide({ homeDir: home }, featureRepo)).toEqual({ blocked: false, exitCode: 0 });
    expect(await decide({ homeDir: home }, protectedRepo, "codex")).toMatchObject({ blocked: true, exitCode: 2 });
    expect(await decide({ homeDir: home }, featureRepo, "codex")).toEqual({ blocked: false, exitCode: 0 });
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection on a machine with an empty override layer", () => {
  // A layer whose parsed value is null (an empty or comment-only file, or a
  // document of `null`, `~` or a bare `---`) merged as a root tombstone erased
  // the whole manifest and failed the strict parse, so the hook (fail-closed
  // on any load error) refused every edit. It is now skipped with a warning,
  // and the hook keeps deciding.
  it("refuses on a protected branch and allows a feature branch with the layer holding no value, and with it absent", async () => {
    const home = makeHome({ policy_packs: BRANCH_PROTECTION });
    const machines = path.join(home, "machines");
    fs.mkdirSync(machines, { recursive: true });
    const layer = path.join(machines, "default.harness.overrides.yaml");
    const protectedRepo = makeRepo("master");
    const featureRepo = makeRepo("feat/x");
    for (const content of ["", "# a comment only\n", "null\n", "~\n", "---\n"]) {
      fs.writeFileSync(layer, content, "utf8");
      const loaded = loadManifest({ homeDir: home });
      expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
      expect(loaded.warnings.filter((w) => w.path === "<root>")).toHaveLength(1);
      expect(loaded.warnings.some((w) => w.message.includes("has no value to merge"))).toBe(true);
      expect(await decide({ homeDir: home }, protectedRepo)).toEqual({ blocked: true, exitCode: 0 });
      expect(await decide({ homeDir: home }, featureRepo)).toEqual({ blocked: false, exitCode: 0 });
    }
    // And absent: no machine override file at all (the normal state on a
    // machine that never wrote one). There is nothing to skip, so no <root>
    // warning is emitted, but the hook must still decide on both branches.
    fs.rmSync(layer, { force: true });
    const absent = loadManifest({ homeDir: home });
    expect(absent.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
    expect(absent.warnings.filter((w) => w.path === "<root>")).toHaveLength(0);
    expect(await decide({ homeDir: home }, protectedRepo)).toEqual({ blocked: true, exitCode: 0 });
    expect(await decide({ homeDir: home }, featureRepo)).toEqual({ blocked: false, exitCode: 0 });
  });
});

describe("a key that was never valid still fails the load", () => {
  it.each([["policy"], ["workflow"], ["review_template"], ["doctors"]])("%s", (key) => {
    const home = makeHome({ [key]: [] });
    expect(() => loadManifest({ homeDir: home })).toThrow(/Unrecognized key/i);
  });
});
