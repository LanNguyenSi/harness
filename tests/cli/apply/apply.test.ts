import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import {
  GENERATED_DIRNAME,
  MEMORY_BASENAME,
  SETTINGS_BASENAME,
  apply,
} from "../../../src/cli/apply/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import {
  LOCK_BASENAME,
  buildLockEntries,
  parseLock,
} from "../../../src/io/harness-lock.js";
import { parseManifest } from "../../../src/schema/index.js";
import { generateSettings } from "../../../src/cli/apply/generate-settings.js";
import { parse as parseYaml } from "yaml";
import {
  LAST_APPLY_BASENAME,
  readLastApply,
} from "../../../src/io/last-apply.js";
import {
  RESTART_HINT_HOOKS,
  RESTART_HINT_MCP,
} from "../../../src/io/restart-hints.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-apply-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

interface ManifestSeed {
  hooks?: unknown[];
  mcp?: unknown[];
  memoryDirs?: { path: string; scope: "project" | "user" }[];
  router?: { command: string[]; enabled?: boolean };
}

function writeManifest(seed: ManifestSeed = {}): string {
  const manifest: Record<string, unknown> = {
    version: 1,
    tools: {
      mcp: seed.mcp ?? [],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: {
      directories: seed.memoryDirs ?? [],
      ...(seed.router ? { router: seed.router } : {}),
    },
    hooks: seed.hooks ?? [],
    policies: [],
  };
  const target = path.join(tmpHome, "harness.yaml");
  fs.writeFileSync(target, yamlStringify(manifest));
  return target;
}

function settingsPath(): string {
  return path.join(tmpHome, GENERATED_DIRNAME, SETTINGS_BASENAME);
}

function memoryPath(): string {
  return path.join(tmpHome, GENERATED_DIRNAME, MEMORY_BASENAME);
}

function lockPath(): string {
  return path.join(tmpHome, LOCK_BASENAME);
}

const okPrompt = async (): Promise<string> => "yes";
const noPrompt = async (): Promise<string> => "n";

describe("apply — fresh install", () => {
  it("writes both generated files and the lock; outcome 'applied'", async () => {
    writeManifest({
      hooks: [
        {
          name: "git-preflight",
          event: "SessionStart",
          command: "/h/git-preflight.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(r.written).toBe(true);
    expect(fs.existsSync(settingsPath())).toBe(true);
    expect(fs.existsSync(memoryPath())).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, GENERATED_DIRNAME, LAST_APPLY_BASENAME))).toBe(true);
  });

  it("subsequent apply is a no-op (idempotent)", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    const settingsBefore = fs.readFileSync(settingsPath(), "utf8");
    const memoryBefore = fs.readFileSync(memoryPath(), "utf8");

    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.outcome).toBe("no-changes");
    expect(r2.written).toBe(false);
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(settingsBefore);
    expect(fs.readFileSync(memoryPath(), "utf8")).toBe(memoryBefore);
  });

  it("when --config is passed without homeDir, generated/ lands next to the manifest (no ~/.claude pollution)", async () => {
    // Spec: passing --config to a manifest in /repo/path should not write
    // generated artefacts into the user's global ~/.claude. Smoke-tested
    // empirically; this is the regression test.
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-altcfg-"));
    try {
      const altManifest = path.join(altRoot, "harness.yaml");
      fs.writeFileSync(altManifest, yamlStringify({
        version: 1,
        tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
        memory: { directories: [] },
        hooks: [{ name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 }],
        policies: [],
      }));
      // Note: no homeDir override — just configPath.
      const r = await apply({ configPath: altManifest });
      expect(r.generatedDir).toBe(path.join(altRoot, GENERATED_DIRNAME));
      expect(fs.existsSync(path.join(altRoot, GENERATED_DIRNAME, SETTINGS_BASENAME))).toBe(true);
    } finally {
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });

  it("settings.json content is exactly generateSettings(manifest) output (locked contract)", async () => {
    const manifestPath = writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    const manifest = parseManifest(parseYaml(fs.readFileSync(manifestPath, "utf8")));
    expect(onDisk).toEqual(generateSettings(manifest));
  });

  it("settings.json is JSON.parse-able and contains the expected hooks event keys", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
        {
          name: "review",
          event: "PreToolUse",
          match: "mcp__agent-tasks__pull_requests_merge",
          command: "/r.sh",
          blocking: "hard",
          budget_ms: 2000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect(Object.keys(parsed.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
  });
});

describe("apply --dry-run", () => {
  it("on an unmodified manifest reports no-changes and writes nothing", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    const r = await apply({ homeDir: tmpHome, dryRun: true });
    expect(r.outcome).toBe("no-changes");
    expect(r.written).toBe(false);
  });

  it("on a fresh install (no last-apply, no on-disk) reports would-apply and writes nothing", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r = await apply({ homeDir: tmpHome, dryRun: true });
    expect(r.outcome).toBe("would-apply");
    expect(r.written).toBe(false);
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});

describe("apply — drift detection", () => {
  it("hand-edit to settings.json refuses with diff and exits via outcome=drift-refuse", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(settingsPath(), '{"hand_edited": true}\n');

    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("drift-refuse");
    expect(r.written).toBe(false);
    const driftFile = r.files.find((f) => f.basename === SETTINGS_BASENAME);
    expect(driftFile?.verdict).toBe("drift-refuse");
    expect(driftFile?.diff).toBeDefined();
    expect(driftFile?.diff).toContain("hand_edited");
  });

  it("--overwrite-drift declined (answer != 'yes') leaves files untouched", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(settingsPath(), '{"hand_edited": true}\n');

    const r = await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: noPrompt });
    expect(r.outcome).toBe("drift-discarded");
    expect(r.written).toBe(false);
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe('{"hand_edited": true}\n');
  });

  it("--overwrite-drift confirmed ('yes') overwrites and writes succeeds", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(settingsPath(), '{"hand_edited": true}\n');

    const r = await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: okPrompt });
    expect(r.outcome).toBe("applied");
    expect(r.written).toBe(true);
    expect(fs.readFileSync(settingsPath(), "utf8")).not.toContain("hand_edited");
  });

  it("--overwrite-drift confirmed in upper case (`YES`) overwrites (case-insensitive)", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(settingsPath(), '{"hand_edited": true}\n');

    const upperPrompt = async (): Promise<string> => "YES";
    const r = await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: upperPrompt });
    expect(r.outcome).toBe("applied");
  });

  it("--overwrite-drift on a fresh install (no drift to discard) writes without prompting", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    let prompted = false;
    const failingPrompt = async (): Promise<string> => {
      prompted = true;
      return "yes";
    };
    const r = await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: failingPrompt });
    expect(r.outcome).toBe("applied");
    expect(prompted).toBe(false);
  });

  it("--overwrite-drift requires literal 'yes' (rejects 'y')", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(settingsPath(), '{"hand_edited": true}\n');

    const yPrompt = async (): Promise<string> => "y";
    const r = await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: yPrompt });
    expect(r.outcome).toBe("drift-discarded");
    expect(r.written).toBe(false);
  });

  it("trims whitespace around the literal 'yes' answer", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(settingsPath(), '{"hand_edited": true}\n');

    const yesWithNewline = async (): Promise<string> => "yes\n";
    const r = await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: yesWithNewline });
    expect(r.outcome).toBe("applied");
  });
});

describe("apply — restart hints", () => {
  it("emits the MCP hint when mcp[].command changes between two applies", async () => {
    writeManifest({
      mcp: [{ name: "oracle", command: ["node", "/x/oracle.js"] }],
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });

    writeManifest({
      mcp: [{ name: "oracle", command: ["node", "/x/oracle-v2.js"] }],
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.restartHints).toContain(RESTART_HINT_MCP);
  });

  it("emits no hints when only a hook description changed", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
          description: "v1",
        },
      ],
    });
    await apply({ homeDir: tmpHome });

    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
          description: "v2 rewritten",
        },
      ],
    });
    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.restartHints).toEqual([]);
    // settings.json is byte-identical (description doesn't survive projection)
    // so the second apply is also a no-op.
    expect(r2.outcome).toBe("no-changes");
  });

  it("emits the hooks hint when a new hook is added", async () => {
    writeManifest({
      hooks: [
        {
          name: "h1",
          event: "SessionStart",
          command: "/h1.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });

    writeManifest({
      hooks: [
        {
          name: "h1",
          event: "SessionStart",
          command: "/h1.sh",
          blocking: false,
          budget_ms: 30000,
        },
        {
          name: "h2",
          event: "Stop",
          command: "/h2.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.restartHints).toContain(RESTART_HINT_HOOKS);
  });
});

describe("apply — harness.lock", () => {
  it("writes harness.lock next to harness.yaml with the expected asset entries", async () => {
    const hookFile = path.join(tmpHome, "git-preflight.sh");
    fs.writeFileSync(hookFile, "#!/bin/sh\necho preflight\n");
    const manifestPath = writeManifest({
      hooks: [
        {
          name: "git-preflight",
          event: "SessionStart",
          command: hookFile,
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    expect(fs.existsSync(lockPath())).toBe(true);
    const entries = parseLock(fs.readFileSync(lockPath(), "utf8"));
    expect(entries.find((e) => e.path === hookFile)).toBeDefined();

    // Lock content matches buildLockEntries exactly. Locks the contract
    // for Phase 3 #6 (asset drift detection) which will diff this output.
    const manifest = parseManifest(parseYaml(fs.readFileSync(manifestPath, "utf8")));
    const expected = buildLockEntries(manifest, { homeDir: tmpHome });
    expect(entries).toEqual(expected);
  });

  it("excludes mcp[].command paths whose entry is enabled: false", async () => {
    const enabledScript = path.join(tmpHome, "enabled-mcp.js");
    const disabledScript = path.join(tmpHome, "disabled-mcp.js");
    fs.writeFileSync(enabledScript, "// on\n");
    fs.writeFileSync(disabledScript, "// off\n");
    writeManifest({
      mcp: [
        { name: "on", command: ["node", enabledScript], enabled: true },
        { name: "off", command: ["node", disabledScript], enabled: false },
      ],
    });
    await apply({ homeDir: tmpHome });
    const entries = parseLock(fs.readFileSync(lockPath(), "utf8"));
    expect(entries.find((e) => e.path === enabledScript)).toBeDefined();
    expect(entries.find((e) => e.path === disabledScript)).toBeUndefined();
  });

  it("skips memory.router when memory.router.enabled is false", async () => {
    const routerScript = path.join(tmpHome, "router-hook.js");
    fs.writeFileSync(routerScript, "// router\n");
    writeManifest({
      router: { command: ["node", routerScript], enabled: false },
    });
    await apply({ homeDir: tmpHome });
    const entries = parseLock(fs.readFileSync(lockPath(), "utf8"));
    expect(entries.find((e) => e.path === routerScript)).toBeUndefined();
  });
});

describe("apply — manifest missing", () => {
  it("throws EX_NOINPUT with init hint when harness.yaml does not exist", async () => {
    await expect(apply({ homeDir: tmpHome })).rejects.toBeInstanceOf(HarnessExitError);
    try {
      await apply({ homeDir: tmpHome });
    } catch (err) {
      expect((err as HarnessExitError).exitCode).toBe(66);
      expect((err as HarnessExitError).message).toMatch(/run `harness init`/);
    }
  });
});

describe("apply — last-apply record", () => {
  it("records both files plus a manifest snapshot in .last-apply", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    const record = readLastApply(path.join(tmpHome, GENERATED_DIRNAME));
    expect(record).not.toBeNull();
    expect(Object.keys(record!.files).sort()).toEqual([MEMORY_BASENAME, SETTINGS_BASENAME].sort());
    expect(record!.manifest).toBeDefined();
    // The manifest snapshot is JSON-serialised; round-trip parses cleanly.
    expect(() => JSON.parse(record!.manifest!.content)).not.toThrow();
  });

  it("the manifest snapshot drives restart-hint comparison; without it, hints are empty on a fresh prior apply", async () => {
    // Simulate a Phase 3 #1 baseline .last-apply: file entries present,
    // but no `manifest` snapshot field. This is the realistic baseline
    // shape (a record produced before the schema extension), not a
    // synthetic empty record.
    writeManifest({
      mcp: [{ name: "oracle", command: ["node", "/x/oracle.js"] }],
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    // Build a baseline record by running apply once, then strip the
    // manifest field as if it had been written by Phase 3 #1.
    await apply({ homeDir: tmpHome });
    const lastApplyPath = path.join(tmpHome, GENERATED_DIRNAME, LAST_APPLY_BASENAME);
    const recordRaw = JSON.parse(fs.readFileSync(lastApplyPath, "utf8")) as {
      files: unknown;
      manifest?: unknown;
    };
    delete recordRaw.manifest;
    fs.writeFileSync(lastApplyPath, `${JSON.stringify(recordRaw, null, 2)}\n`);

    // Now mutate the manifest in a way that WOULD emit hints if a snapshot
    // existed (different hook event → settings.json changes too).
    writeManifest({
      mcp: [{ name: "oracle", command: ["node", "/x/oracle-v2.js"] }],
      hooks: [
        {
          name: "h",
          event: "Stop",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r = await apply({ homeDir: tmpHome });
    // No prior manifest snapshot → no hints, regardless of what changed.
    expect(r.restartHints).toEqual([]);
    expect(r.outcome).toBe("applied");
  });

  it("rejects a tampered manifest snapshot (sha mismatch) and emits no hints", async () => {
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    // Tamper the snapshot content while leaving the sha unchanged: the
    // recorded sha now disagrees with content. Apply must NOT use it.
    const lastApplyPath = path.join(tmpHome, GENERATED_DIRNAME, LAST_APPLY_BASENAME);
    const record = JSON.parse(fs.readFileSync(lastApplyPath, "utf8")) as {
      manifest: { sha256: string; content: string };
    };
    record.manifest.content = '{"version": 1, "tampered": true}';
    fs.writeFileSync(lastApplyPath, `${JSON.stringify(record, null, 2)}\n`);

    writeManifest({
      hooks: [
        {
          name: "h",
          event: "Stop", // would trigger hooks-hint if snapshot were trusted
          command: "/h.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r = await apply({ homeDir: tmpHome });
    expect(r.restartHints).toEqual([]); // tampered snapshot rejected silently
    expect(r.outcome).toBe("applied");
  });
});

describe("apply — memory directory aggregation", () => {
  it("writes the MEMORY.md index from a single configured directory", async () => {
    const memDir = path.join(tmpHome, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, "user.md"),
      "---\nname: User profile\ndescription: about\ntype: user\n---\n",
    );
    writeManifest({
      memoryDirs: [{ path: "~/memory", scope: "user" }],
    });
    await apply({ homeDir: tmpHome });
    const index = fs.readFileSync(memoryPath(), "utf8");
    expect(index).toBe("- [User profile](user.md) — about\n");
  });
});
