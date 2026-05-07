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
  computeDrift,
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

describe("apply — asset-content drift detection (Phase 3 #6)", () => {
  it("emits drift entry for an externally-edited locked hook script", async () => {
    const hookFile = path.join(tmpHome, "git-preflight.sh");
    fs.writeFileSync(hookFile, "v1\n");
    writeManifest({
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
    fs.writeFileSync(hookFile, "v2-edited\n");

    const r = await apply({ homeDir: tmpHome });
    expect(r.lockDrift).toHaveLength(1);
    expect(r.lockDrift[0]?.entry.path).toBe(hookFile);
    expect(r.lockDrift[0]?.reason).toBe("modified");
  });

  it("emits exactly one drift entry per memory directory whose content changed (not per file)", async () => {
    const memDir = path.join(tmpHome, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv1\n",
    );
    fs.writeFileSync(
      path.join(memDir, "b.md"),
      "---\nname: B\ndescription: b\ntype: user\n---\nv1\n",
    );
    writeManifest({
      memoryDirs: [{ path: "~/memory", scope: "user" }],
    });
    await apply({ homeDir: tmpHome });

    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv2\n",
    );

    const r = await apply({ homeDir: tmpHome });
    expect(r.lockDrift).toHaveLength(1);
    expect(r.lockDrift[0]?.entry.path).toBe(memDir);
  });

  it("emits no drift when nothing changed since the lock was written", async () => {
    const hookFile = path.join(tmpHome, "h.sh");
    fs.writeFileSync(hookFile, "stable\n");
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: hookFile,
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    const r = await apply({ homeDir: tmpHome });
    expect(r.lockDrift).toEqual([]);
  });

  it("on a fresh first apply (no harness.lock present), reports no drift", async () => {
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
    const r = await apply({ homeDir: tmpHome });
    expect(r.lockDrift).toEqual([]);
  });

  it("flags a missing locked asset (deleted between applies)", async () => {
    const hookFile = path.join(tmpHome, "h.sh");
    fs.writeFileSync(hookFile, "v1\n");
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: hookFile,
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.rmSync(hookFile);
    const r = await apply({ homeDir: tmpHome });
    expect(r.lockDrift).toHaveLength(1);
    expect(r.lockDrift[0]?.reason).toBe("missing");
  });

  it("emits the canonical ROADMAP-spec stderr line on the CLI rendering path", async () => {
    const hookFile = path.join(tmpHome, "git-preflight.sh");
    fs.writeFileSync(hookFile, "v1\n");
    writeManifest({
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
    fs.writeFileSync(hookFile, "v2\n");

    const { run } = await import("../../../src/cli/index.js");
    let stderrBuf = "";
    const code = await run({
      argv: ["apply", "--config", path.join(tmpHome, "harness.yaml")],
      stderr: (s) => {
        stderrBuf += s;
      },
      stdout: () => {
        /* swallow */
      },
    });
    expect(code).toBe(0);
    expect(stderrBuf).toContain(`asset drift detected: ${hookFile} changed since last apply`);
  });

  it("rewrites the lock on the no-changes path when drift is reported, so drift is not sticky", async () => {
    const hookFile = path.join(tmpHome, "h.sh");
    fs.writeFileSync(hookFile, "v1\n");
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: hookFile,
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(hookFile, "v2\n");

    const r1 = await apply({ homeDir: tmpHome });
    expect(r1.outcome).toBe("no-changes");
    expect(r1.lockDrift).toHaveLength(1);

    // Without a sticky-fix, the next apply would re-report the same
    // drift forever. With it, the lock has been refreshed.
    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.outcome).toBe("no-changes");
    expect(r2.lockDrift).toEqual([]);
  });

  it("an empty harness.lock (zero entries) reports no drift", async () => {
    // Manifest with no hooks/mcp/skills/memory → buildLockEntries emits []
    // → harness.lock gets written as an empty file. Subsequent apply
    // reads it, computeDrift on [] is [], lockDrift is empty.
    writeManifest({});
    await apply({ homeDir: tmpHome });
    const r = await apply({ homeDir: tmpHome });
    expect(r.lockDrift).toEqual([]);
  });

  it("apply still proceeds with drift detected (warn-only); lock is rewritten with current SHAs", async () => {
    const hookFile = path.join(tmpHome, "h.sh");
    fs.writeFileSync(hookFile, "v1\n");
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: hookFile,
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    await apply({ homeDir: tmpHome });

    // Simulate an unrelated manifest change so apply is not a no-op.
    writeManifest({
      hooks: [
        {
          name: "h",
          event: "SessionStart",
          command: hookFile,
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
    fs.writeFileSync(hookFile, "v2\n");

    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(r.lockDrift).toHaveLength(1);
    // The lock was rewritten: a third apply with no further edits is clean.
    const r3 = await apply({ homeDir: tmpHome });
    expect(r3.lockDrift).toEqual([]);
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

describe("apply: --strict-lock", () => {
  function setupHookWithLock(): { hookFile: string; lockBefore: string } {
    const hookFile = path.join(tmpHome, "git-preflight.sh");
    fs.writeFileSync(hookFile, "v1\n");
    writeManifest({
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
    return { hookFile, lockBefore: "" };
  }

  it("on a clean apply (no drift), --strict-lock proceeds normally", async () => {
    setupHookWithLock();
    await apply({ homeDir: tmpHome });
    // No external edit between applies; second apply with strict-lock
    // sees zero drift and falls through to the regular write path.
    const r = await apply({ homeDir: tmpHome, strictLock: true });
    expect(r.outcome === "applied" || r.outcome === "no-changes").toBe(true);
    expect(r.lockDrift).toEqual([]);
  });

  it("after an external hook edit, --strict-lock refuses with outcome=lock-drift-refuse", async () => {
    const { hookFile } = setupHookWithLock();
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(hookFile, "v2-tampered\n");
    const r = await apply({ homeDir: tmpHome, strictLock: true });
    expect(r.outcome).toBe("lock-drift-refuse");
    expect(r.written).toBe(false);
    expect(r.lockDrift).toHaveLength(1);
    expect(r.lockDrift[0]?.entry.path).toBe(hookFile);
    expect(r.lockDrift[0]?.reason).toBe("modified");
  });

  it("after an external hook edit, plain apply (no flag) proceeds and rewrites the lock", async () => {
    const { hookFile } = setupHookWithLock();
    await apply({ homeDir: tmpHome });
    const lockSha1Before = fs.readFileSync(lockPath(), "utf8");
    fs.writeFileSync(hookFile, "v2-tampered\n");
    const r = await apply({ homeDir: tmpHome });
    // Default warn-only path: drift surfaced in lockDrift but apply
    // still proceeds; the lock is rewritten with the current SHAs.
    expect(r.outcome === "applied" || r.outcome === "no-changes").toBe(true);
    const lockAfter = fs.readFileSync(lockPath(), "utf8");
    expect(lockAfter).not.toBe(lockSha1Before);
    expect(r.lockDrift).toHaveLength(1);
  });

  it("--strict-lock --dry-run reports drift but exits 0 (dry-run wins)", async () => {
    const { hookFile } = setupHookWithLock();
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(hookFile, "v2-tampered\n");
    const r = await apply({ homeDir: tmpHome, strictLock: true, dryRun: true });
    // Dry-run path takes precedence; outcome should be the regular
    // dry-run verdict (would-apply / no-changes), not lock-drift-refuse.
    expect(r.outcome === "would-apply" || r.outcome === "no-changes").toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.written).toBe(false);
    expect(r.lockDrift).toHaveLength(1);
  });

  it("--strict-lock leaves the lock file unchanged when refusing", async () => {
    const { hookFile } = setupHookWithLock();
    await apply({ homeDir: tmpHome });
    const lockBefore = fs.readFileSync(lockPath(), "utf8");
    fs.writeFileSync(hookFile, "v2-tampered\n");
    await apply({ homeDir: tmpHome, strictLock: true });
    const lockAfter = fs.readFileSync(lockPath(), "utf8");
    expect(lockAfter).toBe(lockBefore);
  });
});

describe("apply --target / --merge", () => {
  function basicHook(): unknown {
    return {
      name: "h",
      event: "SessionStart",
      command: "/h.sh",
      blocking: false,
      budget_ms: 30000,
    };
  }

  it("--target with non-existent path writes generated settings as-is", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "subdir", "settings.local.json");
    const r = await apply({ homeDir: tmpHome, target });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(true);
    expect(r.targetPath).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    const onTarget = JSON.parse(fs.readFileSync(target, "utf8"));
    const onGenerated = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect(onTarget).toEqual(onGenerated);
  });

  it("--target on existing file without --merge or --force refuses", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    const r = await apply({ homeDir: tmpHome, target });
    expect(r.outcome).toBe("target-exists-refuse");
    expect(r.targetWritten).toBe(false);
    // Target untouched.
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ env: { FOO: "1" } });
  });

  it("--target --merge replaces owned keys and preserves the rest", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          env: { FOO: "1" },
          permissions: { allow: ["Bash(ls:*)"] },
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/old.sh" }] }] },
          enabledPlugins: { foo: true },
        },
        null,
        2,
      ),
    );
    const r = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(true);
    expect(r.targetMergeSummary).toBeDefined();
    const merged = JSON.parse(fs.readFileSync(target, "utf8"));
    // Owned: replaced.
    expect(merged.hooks.SessionStart[0].hooks[0].command).toBe("/h.sh");
    // Non-owned: preserved.
    expect(merged.env).toEqual({ FOO: "1" });
    expect(merged.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(merged.enabledPlugins).toEqual({ foo: true });
  });

  it("--target --merge when target lacks owned keys creates them", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    const r = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(true);
    const merged = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(merged.env).toEqual({ FOO: "1" });
    expect(merged.hooks).toBeDefined();
    expect(merged.hooks.SessionStart).toBeDefined();
  });

  it("--target --force overwrites an existing target with generated content", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    const r = await apply({ homeDir: tmpHome, target, force: true });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(true);
    const onTarget = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(onTarget.env).toBeUndefined();
    expect(onTarget.hooks).toBeDefined();
  });

  it("--merge and --force together raises a usage error", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, "{}");
    await expect(
      apply({ homeDir: tmpHome, target, merge: true, force: true }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });

  it("re-applying with --target --merge is idempotent", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    await apply({ homeDir: tmpHome, target, merge: true });
    const after1 = fs.readFileSync(target, "utf8");
    const r2 = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r2.outcome).toBe("no-changes");
    expect(r2.targetWritten).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(after1);
  });

  it("malformed JSON in target with --merge fails clearly", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, "{ this is not json ");
    await expect(
      apply({ homeDir: tmpHome, target, merge: true }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });

  it("harness.lock records the target path + sha; validate --check-lock detects out-of-band edits", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    await apply({ homeDir: tmpHome, target, merge: true });

    const entries = parseLock(fs.readFileSync(lockPath(), "utf8"));
    const targetEntry = entries.find((e) => e.kind === "target");
    expect(targetEntry).toBeDefined();
    expect(targetEntry?.path).toBe(target);

    // Hand-edit the target after the lock was written.
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "tampered" } }, null, 2));

    // computeDrift treats target like asset.
    const drift = computeDrift(entries);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.some((d) => d.entry.kind === "target" && d.entry.path === target)).toBe(true);
  });

  it("plain apply after a --target apply preserves the target lock entry", async () => {
    // Regression for the realistic workflow: user wires --target once, then
    // re-applies without --target after editing the manifest. The target
    // entry must persist in harness.lock so validate --check-lock keeps
    // working.
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    await apply({ homeDir: tmpHome, target, merge: true });

    // Edit manifest to force a non-target apply that has work to do.
    writeManifest({
      hooks: [
        basicHook(),
        {
          name: "h2",
          event: "PreToolUse",
          command: "/h2.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");

    const entries = parseLock(fs.readFileSync(lockPath(), "utf8"));
    const targetEntry = entries.find((e) => e.kind === "target");
    expect(targetEntry).toBeDefined();
    expect(targetEntry?.path).toBe(target);
  });

  it("validate --check-lock surfaces target drift after an out-of-band edit", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    await apply({ homeDir: tmpHome, target, merge: true });
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "tampered" } }, null, 2));

    const { validate } = await import("../../../src/cli/validate/index.js");
    const r = validate({ configPath: path.join(tmpHome, "harness.yaml"), checkLock: true });
    expect(r.diagnostics.some((d) => d.path === target)).toBe(true);
  });

  it("--merge without --target raises a usage error", async () => {
    writeManifest({ hooks: [basicHook()] });
    await expect(
      apply({ homeDir: tmpHome, merge: true }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });

  it("--force without --target raises a usage error", async () => {
    writeManifest({ hooks: [basicHook()] });
    await expect(
      apply({ homeDir: tmpHome, force: true }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });

  it("--target pointing at an existing directory raises a clear error", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "iam-a-dir");
    fs.mkdirSync(target);
    await expect(
      apply({ homeDir: tmpHome, target }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("--target --merge --dry-run: reports would-apply, target file untouched", async () => {
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    const before = JSON.stringify({ env: { FOO: "1" } }, null, 2);
    fs.writeFileSync(target, before);
    const r = await apply({ homeDir: tmpHome, target, merge: true, dryRun: true });
    expect(r.outcome).toBe("would-apply");
    expect(r.targetWritten).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("--target on an unchanged generated tree still writes the target if it diverges", async () => {
    writeManifest({ hooks: [basicHook()] });
    // First apply, no --target: populates harness.generated/.
    await apply({ homeDir: tmpHome });
    // Second apply WITH --target on a fresh path.
    const target = path.join(tmpHome, "settings.local.json");
    const r = await apply({ homeDir: tmpHome, target });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("expands ~ in --target relative to homeDir", async () => {
    writeManifest({ hooks: [basicHook()] });
    const r = await apply({ homeDir: tmpHome, target: "~/settings.local.json" });
    expect(r.outcome).toBe("applied");
    expect(r.targetPath).toBe(path.join(tmpHome, "settings.local.json"));
    expect(fs.existsSync(r.targetPath ?? "")).toBe(true);
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

describe("apply — policy_packs expansion (Phase 6 #2)", () => {
  function writePolicyPackManifest(packs: unknown[]): string {
    const manifest = {
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [],
      policies: [],
      policy_packs: packs,
    };
    const target = path.join(tmpHome, "harness.yaml");
    fs.writeFileSync(target, yamlStringify(manifest));
    return target;
  }

  function instructionsPath(packName: string): string {
    return path.join(
      tmpHome,
      GENERATED_DIRNAME,
      "policy-packs",
      packName,
      "instructions.md",
    );
  }

  it("writes pack instructions and merges pack hooks into settings.json", async () => {
    writePolicyPackManifest([{ name: "understanding-before-execution" }]);
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(fs.existsSync(instructionsPath("understanding-before-execution"))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const allCommands: string[] = [];
    for (const groups of Object.values(settings.hooks)) {
      for (const g of groups) for (const h of g.hooks) allCommands.push(h.command);
    }
    expect(allCommands).toContain("understanding-gate-claude-hook");
    expect(allCommands).toContain("understanding-gate-claude-stop");
    expect(allCommands).toContain("understanding-gate-claude-pre-tool-use");
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);

    const preToolUseGroup = settings.hooks["PreToolUse"]?.[0];
    expect(preToolUseGroup?.matcher).toBe("Edit|Write|Bash");
  });

  it("threads explicit mode into the operator audit copy", async () => {
    writePolicyPackManifest([
      { name: "understanding-before-execution", config: { mode: "strict" } },
    ]);
    await apply({ homeDir: tmpHome });
    const md = fs.readFileSync(instructionsPath("understanding-before-execution"), "utf8");
    expect(md).toMatch(/## Mode\s*\n\s*strict/);
  });

  it("is idempotent: a second apply returns no-changes and keeps the file byte-stable", async () => {
    writePolicyPackManifest([{ name: "understanding-before-execution" }]);
    await apply({ homeDir: tmpHome });
    const before = fs.readFileSync(instructionsPath("understanding-before-execution"), "utf8");
    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.outcome).toBe("no-changes");
    expect(r2.written).toBe(false);
    const after = fs.readFileSync(instructionsPath("understanding-before-execution"), "utf8");
    expect(after).toBe(before);
  });

  it("detects drift on the pack instructions file via three-state compare", async () => {
    writePolicyPackManifest([{ name: "understanding-before-execution" }]);
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(
      instructionsPath("understanding-before-execution"),
      "manually edited\n",
      "utf8",
    );
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("drift-refuse");
    const driftFile = r.files.find(
      (f) => f.basename === "policy-packs/understanding-before-execution/instructions.md",
    );
    expect(driftFile?.verdict).toBe("drift-refuse");
    expect(driftFile?.diff).toContain("manually edited");
  });

  it("skips an enabled:false pack: no instructions file, no pack hooks", async () => {
    writePolicyPackManifest([{ name: "understanding-before-execution", enabled: false }]);
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(fs.existsSync(instructionsPath("understanding-before-execution"))).toBe(false);
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(settings.hooks)).toEqual([]);
  });

  it("a pack with an unknown source skips with a warning, not an apply failure", async () => {
    writePolicyPackManifest([
      { name: "understanding-before-execution", source: "path:./somewhere" },
    ]);
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(fs.existsSync(instructionsPath("understanding-before-execution"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("not recognised"))).toBe(true);
  });

  it("re-enabling a previously-disabled pack triggers a fresh apply", async () => {
    writePolicyPackManifest([{ name: "understanding-before-execution", enabled: false }]);
    await apply({ homeDir: tmpHome });
    expect(fs.existsSync(instructionsPath("understanding-before-execution"))).toBe(false);

    writePolicyPackManifest([{ name: "understanding-before-execution", enabled: true }]);
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(fs.existsSync(instructionsPath("understanding-before-execution"))).toBe(true);
  });
});
