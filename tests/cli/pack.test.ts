import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { apply } from "../../src/cli/apply/index.js";
import { init } from "../../src/cli/init/index.js";
import { packAdd, packList, packRemove } from "../../src/cli/pack/index.js";
import { applyPackAdd, applyPackRemove, planPackRemove } from "../../src/cli/pack/mutate.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN as STUB_NPM_BIN_EXEC } from "../_helpers/npm-bin-exec.js";

let tmpHome: string;
let manifestPath: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-"));
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

describe("pack mutate (pure YAML)", () => {
  it("applyPackAdd appends an entry under policy_packs[]", () => {
    const out = applyPackAdd("version: 1\n", {
      name: "understanding-before-execution",
      config: { mode: "grill_me" },
    });
    expect(out).toContain("policy_packs:");
    expect(out).toContain("name: understanding-before-execution");
    expect(out).toContain("mode: grill_me");
  });

  it("applyPackAdd omits unset optional fields from the inserted YAML", () => {
    const out = applyPackAdd("version: 1\n", {
      name: "understanding-before-execution",
    });
    expect(out).not.toMatch(/\bsource:/);
    expect(out).not.toMatch(/\benabled:/);
    expect(out).not.toMatch(/\bconfig:/);
  });

  it("applyPackAdd creates the policy_packs[] sequence when absent", () => {
    const out = applyPackAdd("version: 1\nhooks: []\n", {
      name: "understanding-before-execution",
    });
    expect(out).toMatch(/policy_packs:[\s\n]*-\s*name: understanding-before-execution/);
  });

  it("planPackRemove reports found + available names", () => {
    const yaml = "version: 1\npolicy_packs:\n  - name: understanding-before-execution\n";
    expect(planPackRemove(yaml, "understanding-before-execution").found).toBe(true);
    expect(planPackRemove(yaml, "absent").found).toBe(false);
    expect(planPackRemove(yaml, "absent").availableNames).toEqual([
      "understanding-before-execution",
    ]);
  });

  it("applyPackRemove drops the entry but keeps the empty sequence", () => {
    const yaml = "version: 1\npolicy_packs:\n  - name: understanding-before-execution\n";
    const out = applyPackRemove(yaml, "understanding-before-execution");
    expect(out).toContain("policy_packs:");
    expect(out).not.toContain("understanding-before-execution");
  });
});

describe("pack add", () => {
  it("appends a known builtin and round-trips through the schema", async () => {
    const r = await packAdd(
      { name: "understanding-before-execution", config: { mode: "grill_me" } },
      { configPath: manifestPath },
    );
    expect(r.applied).toBe(true);
    const m = readManifest();
    expect(m.policy_packs).toHaveLength(1);
    expect(m.policy_packs?.[0]).toMatchObject({
      name: "understanding-before-execution",
      config: { mode: "grill_me" },
    });
  });

  it("rejects an unknown builtin name BEFORE the schema gate", async () => {
    let caught: unknown;
    try {
      await packAdd({ name: "no-such-pack" }, { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/not a known builtin pack/);
  });

  it("rejects an unknown source", async () => {
    let caught: unknown;
    try {
      await packAdd(
        { name: "understanding-before-execution", source: "path:./somewhere" },
        { configPath: manifestPath },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/only "builtin" resolves/);
  });

  it("rejects a duplicate pack name via the schema's superRefine", async () => {
    await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    let caught: unknown;
    try {
      await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/duplicate policy_pack name/i);
  });

  it("dry-run emits a diff and does not mutate the file", async () => {
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await packAdd(
      { name: "understanding-before-execution" },
      { configPath: manifestPath, dryRun: true },
    );
    expect(r.applied).toBe(false);
    expect(r.diff).toContain("understanding-before-execution");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("pack remove", () => {
  it("removes an entry that has not been applied yet", async () => {
    await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    const r = await packRemove("understanding-before-execution", { configPath: manifestPath });
    expect(r.applied).toBe(true);
    expect(r.cleanedFiles).toEqual([]);
    const m = readManifest();
    expect(m.policy_packs).toEqual([]);
  });

  it("errors clearly when the entry is not present", async () => {
    let caught: unknown;
    try {
      await packRemove("ghost-pack", { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/"ghost-pack" not found/);
  });

  it("refuses without --force when applied state is recorded in .last-apply", async () => {
    await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    await apply({ homeDir: tmpHome });
    let caught: unknown;
    try {
      await packRemove("understanding-before-execution", { configPath: manifestPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/applied state present/);
    expect(msg).toMatch(/policy-packs\/understanding-before-execution\/instructions\.md/);
    expect(msg).toMatch(/Pass --force/);
  });

  it("--force removes the manifest entry, deletes pack files, and prunes .last-apply", async () => {
    await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    await apply({ homeDir: tmpHome });

    const packDir = path.join(
      tmpHome,
      "harness.generated",
      "policy-packs",
      "understanding-before-execution",
    );
    expect(fs.existsSync(packDir)).toBe(true);

    const r = await packRemove("understanding-before-execution", {
      configPath: manifestPath,
      force: true,
    });
    expect(r.applied).toBe(true);
    expect(r.cleanedFiles).toContain(
      "policy-packs/understanding-before-execution/instructions.md",
    );
    expect(fs.existsSync(packDir)).toBe(false);

    // .last-apply should no longer mention the pack files.
    const lastApplyText = fs.readFileSync(
      path.join(tmpHome, "harness.generated", ".last-apply"),
      "utf8",
    );
    expect(lastApplyText).not.toContain("policy-packs/understanding-before-execution/");

    // A subsequent apply doesn't resurrect the pack files, but it DOES
    // need to rewrite settings.json without the pack hooks (the manifest
    // changed, on-disk hooks don't match the new expected). The cleanup
    // intentionally only touches pack-owned state; settings.json stays
    // owned by the apply pipeline.
    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.outcome).toBe("applied");
    expect(fs.existsSync(packDir)).toBe(false);
    // ... and a third apply IS a no-op (everything reconverged).
    const r3 = await apply({ homeDir: tmpHome });
    expect(r3.outcome).toBe("no-changes");
  });

  it("schema rejects a manifest with a path-traversal pack name (defense in depth)", async () => {
    // Manually write a manifest that side-steps `pack add` and tries to
    // smuggle a path-traversal name into policy_packs[]. The schema
    // regex rejects it at load time, so neither `apply` nor `pack
    // remove` can act on it.
    fs.writeFileSync(
      manifestPath,
      "version: 1\npolicy_packs:\n  - name: ../../../etc/escape\n",
      "utf8",
    );
    let caught: unknown;
    try {
      await packRemove("../../../etc/escape", {
        configPath: manifestPath,
        force: true,
      });
    } catch (e) {
      caught = e;
    }
    // The schema rejects the manifest first (read by planPackRemove via
    // parse-then-find or by validateBeforeWrite at write time). Either
    // way, we never reach the fs.rmSync call site with an unsafe name.
    expect(caught).toBeDefined();
    // The escape target must not exist on disk after the failed call.
    expect(fs.existsSync(path.join(tmpHome, "../../../etc/escape"))).toBe(false);
  });

  it("dry-run --force surfaces the would-clean file list without writing", async () => {
    await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    await apply({ homeDir: tmpHome });
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await packRemove("understanding-before-execution", {
      configPath: manifestPath,
      force: true,
      dryRun: true,
    });
    expect(r.applied).toBe(false);
    expect(r.cleanedFiles).toContain(
      "policy-packs/understanding-before-execution/instructions.md",
    );
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
    expect(
      fs.existsSync(
        path.join(
          tmpHome,
          "harness.generated",
          "policy-packs",
          "understanding-before-execution",
        ),
      ),
    ).toBe(true);
  });
});

describe("pack list", () => {
  it("returns an empty table when no packs are declared", () => {
    const r = packList({ configPath: manifestPath });
    expect(r.rows).toEqual([]);
    expect(r.output).toBe("(no entries)\n");
  });

  it("emits a flat row per pack with name + source + enabled + mode + description", async () => {
    await packAdd(
      {
        name: "understanding-before-execution",
        description: "test",
        config: { mode: "strict" },
      },
      { configPath: manifestPath },
    );
    const r = packList({ configPath: manifestPath });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      name: "understanding-before-execution",
      source: "builtin",
      enabled: true,
      mode: "strict",
      description: "test",
    });
    expect(r.output).toContain("understanding-before-execution");
    expect(r.output).toContain("strict");
  });

  it("--enabled-only filters out enabled: false entries", async () => {
    await packAdd(
      { name: "understanding-before-execution", enabled: false },
      { configPath: manifestPath },
    );
    const all = packList({ configPath: manifestPath });
    expect(all.rows).toHaveLength(1);
    const filtered = packList({ configPath: manifestPath, enabledOnly: true });
    expect(filtered.rows).toEqual([]);
  });

  it("--json emits a parsable JSON array", async () => {
    await packAdd({ name: "understanding-before-execution" }, { configPath: manifestPath });
    const r = packList({ configPath: manifestPath, json: true });
    const parsed = JSON.parse(r.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("understanding-before-execution");
  });
});
