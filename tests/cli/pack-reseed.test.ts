// `harness pack reseed <name>` (task 68b9ad9c): pull the shipped
// builtin template's config.ux (and config.producers) into an
// already-installed manifest, explicit-only (never invoked by `apply`),
// preserving every other manifest key.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { init } from "../../src/cli/init/index.js";
import { packAdd, packReseed } from "../../src/cli/pack/index.js";
import { applyPackReseedUx } from "../../src/cli/pack/mutate.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  defaultProducers,
  defaultUx,
} from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN as STUB_NPM_BIN_EXEC } from "../_helpers/npm-bin-exec.js";

let tmpHome: string;
let manifestPath: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-reseed-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
  await init({ homeDir: tmpHome, npmBinExec: STUB_NPM_BIN_EXEC });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readManifest(): { policy_packs?: Array<Record<string, unknown>> } {
  return parseYaml(fs.readFileSync(manifestPath, "utf8")) as {
    policy_packs?: Array<Record<string, unknown>>;
  };
}

describe("applyPackReseedUx (pure YAML mutator)", () => {
  it("overwrites config.ux while leaving sibling config keys untouched", () => {
    const yaml = `version: 1
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: grill_me
      ux:
        cannot: old
        required:
          - old req
        run:
          - old run
      approval_lifecycle:
        max_age: 4h
`;
    const out = applyPackReseedUx(yaml, "understanding-before-execution", {
      ux: { cannot: "new", required: ["new req"], run: ["new run"] },
    });
    expect(out).toContain("mode: grill_me");
    expect(out).toContain("max_age: 4h");
    expect(out).toContain("cannot: new");
    expect(out).not.toContain("old req");
  });

  it("creates config.ux when the entry has no config block yet", () => {
    const yaml = `version: 1
policy_packs:
  - name: branch-protection
    source: builtin
`;
    const out = applyPackReseedUx(yaml, "branch-protection", {
      ux: { cannot: "new", required: ["req"], run: ["run"] },
    });
    expect(out).toMatch(/config:\s*\n\s*ux:/);
  });

  it("throws when the named entry is not present", () => {
    const yaml = "version: 1\npolicy_packs: []\n";
    expect(() =>
      applyPackReseedUx(yaml, "ghost", { ux: { cannot: "x", required: ["x"], run: ["x"] } }),
    ).toThrow(/not found/);
  });
});

describe("packReseed", () => {
  it("updates a stale ux.run to the shipped template, preserving mode + approval_lifecycle", async () => {
    await packAdd(
      {
        name: "understanding-before-execution",
        config: {
          mode: "grill_me",
          ux: {
            cannot: "You cannot use write-capable tools yet.",
            required: ["an approved Understanding Report for this session"],
            run: [
              "Run `harness approve understanding` once you have produced and confirmed an Understanding Report.",
            ],
          },
          approval_lifecycle: { max_age: "4h" },
        },
      },
      { configPath: manifestPath },
    );
    const r = await packReseed("understanding-before-execution", { configPath: manifestPath });
    expect(r.applied).toBe(true);
    expect(r.fieldsChanged).toEqual(["ux", "producers"]);
    const m = readManifest();
    const cfg = m.policy_packs?.[0]?.["config"] as Record<string, unknown>;
    expect(cfg["mode"]).toBe("grill_me");
    expect(cfg["approval_lifecycle"]).toEqual({ max_age: "4h" });
    expect(cfg["ux"]).toEqual(defaultUx("grill_me"));
    expect(cfg["producers"]).toEqual(defaultProducers());
  });

  it("is a no-op when config.ux / config.producers already match the shipped template", async () => {
    await packAdd(
      {
        name: "understanding-before-execution",
        config: {
          mode: "grill_me",
          ux: defaultUx("grill_me"),
          producers: defaultProducers(),
        },
      },
      { configPath: manifestPath },
    );
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await packReseed("understanding-before-execution", { configPath: manifestPath });
    expect(r.applied).toBe(false);
    expect(r.fieldsChanged).toEqual([]);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("reseeds against the pack's OWN configured mode, not a hardcoded one", async () => {
    await packAdd(
      { name: "understanding-before-execution", config: { mode: "strict" } },
      { configPath: manifestPath },
    );
    const r = await packReseed("understanding-before-execution", { configPath: manifestPath });
    expect(r.applied).toBe(true);
    const m = readManifest();
    const cfg = m.policy_packs?.[0]?.["config"] as Record<string, unknown>;
    expect(cfg["ux"]).toEqual(defaultUx("strict"));
  });

  it("seeds config.ux when the pack declared none at all (explicit operator action, not auto-apply)", async () => {
    await packAdd({ name: "branch-protection" }, { configPath: manifestPath });
    const r = await packReseed("branch-protection", { configPath: manifestPath });
    expect(r.applied).toBe(true);
    expect(r.fieldsChanged).toEqual(["ux"]);
    const m = readManifest();
    const cfg = m.policy_packs?.[0]?.["config"] as Record<string, unknown>;
    expect(cfg["ux"]).toBeDefined();
  });

  it("never touches config.producers for a pack with no canonical producers (branch-protection)", async () => {
    await packAdd(
      {
        name: "branch-protection",
        config: {
          ux: { cannot: "stale", required: ["stale"], run: ["stale"] },
          producers: [{ kind: "ask", command: "custom", description: "operator custom" }],
        },
      },
      { configPath: manifestPath },
    );
    const r = await packReseed("branch-protection", { configPath: manifestPath });
    expect(r.fieldsChanged).toEqual(["ux"]);
    const m = readManifest();
    const cfg = m.policy_packs?.[0]?.["config"] as Record<string, unknown>;
    expect(cfg["producers"]).toEqual([
      { kind: "ask", command: "custom", description: "operator custom" },
    ]);
  });

  it("dry-run prints the diff and does not mutate the file", async () => {
    await packAdd(
      {
        name: "understanding-before-execution",
        config: { mode: "grill_me", ux: { cannot: "stale", required: ["stale"], run: ["stale"] } },
      },
      { configPath: manifestPath },
    );
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await packReseed("understanding-before-execution", {
      configPath: manifestPath,
      dryRun: true,
    });
    expect(r.applied).toBe(false);
    expect(r.fieldsChanged.length).toBeGreaterThan(0);
    expect(r.diff).toContain("cannot");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("errors clearly when the entry is not present", async () => {
    let caught: unknown;
    try {
      await packReseed("ghost-pack", { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/"ghost-pack" not found/);
  });

  it("errors clearly for a pack with no registered shipped default (solution-acceptance)", async () => {
    await packAdd(
      { name: "solution-acceptance", enabled: false },
      { configPath: manifestPath },
    );
    let caught: unknown;
    try {
      await packReseed("solution-acceptance", { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/nothing to reseed/);
  });

  it("errors clearly when the manifest itself fails schema validation", async () => {
    // Duplicate pack names trip PolicyPacksSchema's superRefine, so
    // `parseManifest` throws before reseed ever gets to the pack lookup.
    fs.writeFileSync(
      manifestPath,
      "version: 1\npolicy_packs:\n  - name: understanding-before-execution\n  - name: understanding-before-execution\n",
      "utf8",
    );
    let caught: unknown;
    try {
      await packReseed("understanding-before-execution", { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/fails schema validation/);
  });
});
