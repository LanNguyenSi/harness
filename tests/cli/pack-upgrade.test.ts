// `harness pack upgrade understanding-before-execution` (task 8f637efd,
// D-004, docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Amendment:
// install default"). Text-level insertion, never a Document-API
// reparse/reserialize (see upgrade.ts's module header for why).
//
// Mutation probe M3: make the insertion run even when `auto_approve:`
// already exists (drop the `autoApprovePresent` short-circuit in
// `applyAutoApproveUpgrade`) and the "byte-identical when already
// present" test below goes red: it now sees a second block appended,
// or a schema error from a duplicate key.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { packUpgrade, applyAutoApproveUpgrade } from "../../src/cli/pack/index.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { configSchema } from "../../src/policy-packs/builtin/understanding-before-execution.js";

let tmpHome: string;
let manifestPath: string;

function writeManifest(contents: string): void {
  fs.writeFileSync(manifestPath, contents, "utf8");
}

function readManifest(): string {
  return fs.readFileSync(manifestPath, "utf8");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-upgrade-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const MANIFEST_NO_BLOCK = `version: 1
tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    source: builtin
    enabled: true
    description: Force agents to expose their task interpretation and wait for explicit human approval before any write-capable tool fires.
    config:
      mode: grill_me
      approval_lifecycle:
        expire_on_bash_match:
          - '^gh pr (merge|close)\\b'
        max_age: 4h
  - name: branch-protection
    source: builtin
    enabled: true
    config:
      protected_branches: [master]
`;

describe("applyAutoApproveUpgrade (pure text mutator)", () => {
  it("inserts the snippet at the end of config:, matching sibling indentation", () => {
    const result = applyAutoApproveUpgrade(MANIFEST_NO_BLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.text).toContain("      auto_approve:\n        when: [bypassPermissions]");
    // Sibling entry (branch-protection) untouched, still present exactly once.
    expect(result.text.match(/name: branch-protection/g)).toHaveLength(1);
    // The inserted block validates against the real zod schema.
    const parsed = parseYaml(result.text) as {
      policy_packs: Array<{ name: string; config?: Record<string, unknown> }>;
    };
    const pack = parsed.policy_packs.find((p) => p.name === "understanding-before-execution")!;
    expect(configSchema.safeParse(pack.config).success).toBe(true);
    expect((pack.config as Record<string, unknown>)["auto_approve"]).toEqual({
      when: ["bypassPermissions"],
      harnesses: ["claude-code"],
      require_report: true,
    });
  });

  it("is idempotent: running it twice produces the same text as running it once", () => {
    const once = applyAutoApproveUpgrade(MANIFEST_NO_BLOCK);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = applyAutoApproveUpgrade(once.text);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("byte-identical no-op when auto_approve already exists (any indentation)", () => {
    const withBlock = `version: 1
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        harnesses: [claude-code]
        require_report: true
`;
    const result = applyAutoApproveUpgrade(withBlock);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.text).toBe(withBlock);
  });

  it("refuses when the pack block is not found", () => {
    const result = applyAutoApproveUpgrade("version: 1\npolicy_packs: []\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/could not find/);
  });

  it("refuses when there are two understanding-before-execution pack blocks (ambiguous)", () => {
    const dup = `version: 1
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
  - name: understanding-before-execution
    config:
      mode: strict
`;
    const result = applyAutoApproveUpgrade(dup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/ambiguous/);
  });

  it("refuses when the pack block has no config: key", () => {
    const noConfig = `version: 1
policy_packs:
  - name: understanding-before-execution
    source: builtin
  - name: branch-protection
    config:
      protected_branches: [master]
`;
    const result = applyAutoApproveUpgrade(noConfig);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/config:/);
  });
});

describe("packUpgrade: CLI-level", () => {
  it("refuses a manifest not found", async () => {
    let caught: unknown;
    try {
      await packUpgrade("understanding-before-execution", { configPath: manifestPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
  });

  it("refuses an unsupported pack name before touching the file", async () => {
    writeManifest(MANIFEST_NO_BLOCK);
    let caught: unknown;
    try {
      await packUpgrade("branch-protection", { configPath: manifestPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    // File untouched.
    expect(readManifest()).toBe(MANIFEST_NO_BLOCK);
  });

  it("--dry-run prints the diff and writes nothing", async () => {
    writeManifest(MANIFEST_NO_BLOCK);
    const result = await packUpgrade("understanding-before-execution", {
      configPath: manifestPath,
      dryRun: true,
    });
    expect(result.applied).toBe(false);
    expect(result.alreadyPresent).toBe(false);
    expect(result.diff).toContain("auto_approve");
    expect(readManifest()).toBe(MANIFEST_NO_BLOCK);
  });

  it("inserts the block, and harness validate (schema) accepts the result", async () => {
    writeManifest(MANIFEST_NO_BLOCK);
    const result = await packUpgrade("understanding-before-execution", { configPath: manifestPath });
    expect(result.applied).toBe(true);
    expect(result.alreadyPresent).toBe(false);
    const on_disk = readManifest();
    expect(on_disk).toContain("auto_approve:");

    const parsed = parseYaml(on_disk) as {
      policy_packs: Array<{ name: string; config?: Record<string, unknown> }>;
    };
    const pack = parsed.policy_packs.find((p) => p.name === "understanding-before-execution")!;
    expect(configSchema.safeParse(pack.config).success).toBe(true);
  });

  it("second run is a byte-identical no-op and reports alreadyPresent", async () => {
    writeManifest(MANIFEST_NO_BLOCK);
    await packUpgrade("understanding-before-execution", { configPath: manifestPath });
    const afterFirst = readManifest();

    const second = await packUpgrade("understanding-before-execution", { configPath: manifestPath });
    expect(second.applied).toBe(false);
    expect(second.alreadyPresent).toBe(true);
    expect(readManifest()).toBe(afterFirst);
  });
});
