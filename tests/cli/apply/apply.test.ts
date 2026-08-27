import * as crypto from "node:crypto";
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
import { signingKeyPathFor } from "../../../src/runtime/approval-signing.js";

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

  it("--overwrite-drift with yes:true skips the prompt and overwrites", async () => {
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

    const mustNotPrompt = async (): Promise<string> => {
      throw new Error("prompt must not be called when yes is set");
    };
    const r = await apply({
      homeDir: tmpHome,
      overwriteDrift: true,
      yes: true,
      prompt: mustNotPrompt,
    });
    expect(r.outcome).toBe("applied");
    expect(r.written).toBe(true);
    expect(fs.readFileSync(settingsPath(), "utf8")).not.toContain("hand_edited");
  });

  it("--overwrite-drift without an injected prompt refuses under non-TTY stdin instead of hanging", async () => {
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

    await expect(
      apply({ homeDir: tmpHome, overwriteDrift: true, stdinIsTTY: false }),
    ).rejects.toThrow(/stdin is not a TTY.*--yes/);
    // The refusal happened before any write phase.
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe('{"hand_edited": true}\n');
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
    // A refused target is genuinely not wired: targetInSync must be false
    // so callers can tell this apart from an idempotent in-sync no-op.
    expect(r.targetInSync).toBe(false);
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

  // T-002 (init-mcp-wiring-claude-code): settings.json's `mcpServers`
  // block is dead weight Claude Code never read at runtime; manifest
  // `tools.mcp[]` servers are registered via the `claude mcp` CLI now
  // (io/claude-mcp.ts's Ensure routine, wired into the init wizard), not
  // via this apply --target --merge path. The two tests below replace the
  // pre-T-002 "operator-added mcpServer survives; disabling a manifest
  // server removes it (task 059b669c)" e2e: (1) pins the new "never
  // re-add" contract, (2) pins that the PRE-EXISTING previously-generated-
  // name provenance path — the actual mechanism task 059b669c relies on —
  // still works unmodified for a settings.json inherited from a pre-T-002
  // harness version.
  it("--target --merge: manifest-declared MCP servers are never added to settings.json (registration moved to the claude CLI)", async () => {
    writeManifest({
      hooks: [basicHook()],
      mcp: [{ name: "a", command: ["node", "/a.js"] }],
    });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(
      target,
      JSON.stringify({ mcpServers: { own: { command: "mine" } } }, null, 2),
    );
    const r = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r.outcome).toBe("applied");
    const merged = JSON.parse(fs.readFileSync(target, "utf8"));
    // No re-add: "a" is declared in the manifest, but the generated
    // settings.json projection no longer emits mcpServers at all. The
    // pre-existing operator hand-add is left untouched.
    expect(merged.mcpServers).toEqual({ own: { command: "mine" } });
  });

  it("--target --merge: legacy .last-apply provenance still drops old harness-written mcpServers; operator hand-adds survive (059b669c regression pin, post-T-002)", async () => {
    writeManifest({
      hooks: [basicHook()],
      mcp: [{ name: "a", command: ["node", "/a.js"] }],
    });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(
      target,
      JSON.stringify({ mcpServers: { own: { command: "mine" } } }, null, 2),
    );
    // Establish a real, consistent .last-apply baseline first.
    await apply({ homeDir: tmpHome, target, merge: true });

    // Simulate upgrading from a pre-T-002 harness version whose
    // settings.json projection still wrote a live mcpServers block. Set
    // BOTH the on-disk harness.generated/settings.json AND its
    // .last-apply record to the SAME legacy content, so the three-state
    // comparator sees no drift (an out-of-band hand-edit would refuse the
    // whole apply instead of letting it proceed).
    const legacyContent = `${JSON.stringify(
      { hooks: {}, mcpServers: { a: { command: "old-a" } } },
      null,
      2,
    )}\n`;
    fs.writeFileSync(settingsPath(), legacyContent);
    const lastApplyFile = path.join(tmpHome, GENERATED_DIRNAME, LAST_APPLY_BASENAME);
    const record = JSON.parse(fs.readFileSync(lastApplyFile, "utf8"));
    record.files["settings.json"] = {
      sha256: crypto.createHash("sha256").update(legacyContent).digest("hex"),
      content: legacyContent,
    };
    fs.writeFileSync(lastApplyFile, JSON.stringify(record, null, 2));

    // Seed the target with the legacy harness-written server alongside an
    // operator hand-add, mirroring the pre-T-002 on-disk state.
    fs.writeFileSync(
      target,
      JSON.stringify({ mcpServers: { a: { command: "old-a" }, own: { command: "mine" } } }, null, 2),
    );

    const r = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r.outcome).toBe("applied");
    const merged = JSON.parse(fs.readFileSync(target, "utf8"));
    // "a" was harness-written under the pre-T-002 scheme and is no longer
    // emitted by the current settings.json projection: dropped. "own"
    // (never harness-written) survives.
    expect(merged.mcpServers).toEqual({ own: { command: "mine" } });
    expect(r.targetMergeSummary).toContain("dropped 1 manifest-removed mcpServer (a)");
    expect(r.targetMergeSummary).toContain("kept 1 operator-added mcpServer (own)");
  });

  it("--target --merge: a tampered .last-apply refuses BEFORE the merge (provenance fail-safe)", async () => {
    // The provenance-undefined fallback in the merge block (corrupt or
    // entry-less .last-apply -> conservative preserve) is unreachable at
    // apply level BY CONSTRUCTION: the three-state comparator sees any
    // tampering with the recorded settings.json as out-of-band drift and
    // refuses before the merge runs. Pin that ordering — it is the
    // stronger guarantee (no merge at all beats a conservative merge).
    // The provenance-less preserve semantics themselves are pinned at
    // the mergeSettings unit level, and the true no-.last-apply first
    // merge is exercised by the survive/drop e2e above (its apply #1).
    writeManifest({
      hooks: [basicHook()],
      mcp: [{ name: "a", command: ["node", "/a.js"] }],
    });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ mcpServers: {} }, null, 2));
    const r1 = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r1.outcome).toBe("applied");

    const lastApplyPath = path.join(tmpHome, "harness.generated", ".last-apply");
    const record = JSON.parse(fs.readFileSync(lastApplyPath, "utf8"));
    delete record.files["settings.json"];
    fs.writeFileSync(lastApplyPath, JSON.stringify(record, null, 2));

    writeManifest({
      hooks: [basicHook()],
      mcp: [{ name: "a", command: ["node", "/a.js"], enabled: false }],
    });
    const before = fs.readFileSync(target, "utf8");
    const r2 = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r2.outcome).toBe("drift-refuse");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
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
    // Nothing was written because the target already holds the merged
    // content: in sync, not "not wired".
    expect(r2.targetInSync).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(after1);
  });

  it("generated-file change with an in-sync target reports applied + targetInSync (700636f4 regression)", async () => {
    // The init wire-now false-negative: when harness.generated/ files
    // change but the --merge into the target is byte-identical to what is
    // already on disk, apply returns `outcome: applied` with
    // `targetWritten: false`. `targetInSync` must still be true — the
    // target IS correctly wired — so callers (init wire-now, the apply
    // Next-steps hint) don't misreport it as a failure and loop the
    // operator through redundant apply commands.
    writeManifest({ hooks: [basicHook()] });
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, JSON.stringify({ env: { FOO: "1" } }, null, 2));
    const r1 = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r1.outcome).toBe("applied");
    expect(r1.targetWritten).toBe(true);
    expect(r1.targetInSync).toBe(true);
    // Drop the generated state so the next apply must re-write
    // harness.generated/ (anyChanged) while the target merge stays a
    // byte-identical no-op (the target already holds the merged content).
    fs.rmSync(path.join(tmpHome, GENERATED_DIRNAME), { recursive: true, force: true });
    fs.rmSync(lockPath(), { force: true });
    const r2 = await apply({ homeDir: tmpHome, target, merge: true });
    expect(r2.outcome).toBe("applied");
    expect(r2.targetWritten).toBe(false);
    expect(r2.targetInSync).toBe(true);
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
    // The Claude UserPromptSubmit injector and Stop capture are the
    // npm-backed bins (@lannguyensi/understanding-gate); both carry an
    // `UNDERSTANDING_GATE_MODE=<resolved>` prefix (harness task 5d73d78d:
    // config.mode used to only drive prose, never the mode the package
    // actually enforced) resolved from config.mode ALONE (never the live
    // env — task 5d73d78d review HIGH-3, see the dedicated test below).
    // Unconfigured here, so it resolves to DEFAULT_MODE (grill_me), which
    // is not the package's own fast_confirm default, so the prefix is
    // present (a fast_confirm-resolved mode omits it instead — task
    // 5d73d78d review MEDIUM-7, covered in tests/policy-packs/expand.test.ts).
    // The UserPromptSubmit command also carries an
    // `UNDERSTANDING_GATE_PAUSE_FILE=<generatedDir>/.harness-paused` prefix
    // (agent-tasks 63fefe3a): the npm-backed bin runs outside harness's own
    // runtime and cannot resolve `generatedDir` itself, so apply bakes in
    // the resolved sentinel path the way it already does for REPORT_DIR on
    // the Stop/PreToolUse hooks below. Mode stays outermost.
    const userPromptSubmitCommand = allCommands.find((c) =>
      c.endsWith("understanding-gate-claude-hook"),
    );
    expect(userPromptSubmitCommand).toBe(
      `UNDERSTANDING_GATE_MODE='grill_me' UNDERSTANDING_GATE_PAUSE_FILE='${path.join(
        tmpHome,
        GENERATED_DIRNAME,
        ".harness-paused",
      )}' understanding-gate-claude-hook`,
    );
    // Phase 6 #4: harness owns the PreToolUse blocker (consults BOTH
    // ledger + persisted report). The package's own bin still works for
    // solo users but the pack now wires harness's stronger blocker.
    // The Stop and PreToolUse hooks ALSO carry an
    // `UNDERSTANDING_GATE_REPORT_DIR=<manifest-anchored>` env prefix so
    // the standalone Stop bin (writer) and harness's blocker (reader)
    // resolve the same persisted-report dir regardless of cwd — the mode
    // prefix stays outermost (see the UserPromptSubmit assertion above).
    const stopCommand = allCommands.find((c) => c.endsWith("understanding-gate-claude-stop"));
    expect(stopCommand).toBeDefined();
    expect(stopCommand).toMatch(
      /^UNDERSTANDING_GATE_MODE='grill_me' UNDERSTANDING_GATE_REPORT_DIR='[^']+\/\.understanding-gate\/reports' understanding-gate-claude-stop$/,
    );
    const preToolUseCommand = allCommands.find((c) => c.endsWith("harness pack hook pre-tool-use"));
    expect(preToolUseCommand).toBeDefined();
    expect(preToolUseCommand).toMatch(
      /^UNDERSTANDING_GATE_REPORT_DIR='[^']+\/\.understanding-gate\/reports' harness pack hook pre-tool-use$/,
    );
    // post-tool-use carries the same env wrap so the marker-expiry hook
    // also flips the persisted report at the correct dir (harness/1ee26e77
    // follow-up). Without the wrap, post-tool-use would fall back to
    // <cwd>/.understanding-gate/reports and miss the file harness approve
    // actually wrote when invoked from a different cwd.
    const postToolUseCommand = allCommands.find((c) => c.endsWith("harness pack hook post-tool-use"));
    expect(postToolUseCommand).toBeDefined();
    expect(postToolUseCommand).toMatch(
      /^UNDERSTANDING_GATE_REPORT_DIR='[^']+\/\.understanding-gate\/reports' harness pack hook post-tool-use$/,
    );
    // v2 (harness/494fd1e5) track-active-claim hook: same PostToolUse
    // event, hardcoded matcher for agent-tasks task_start / task_finish
    // / task_abandon. Maintains the active-claim file so `harness
    // approve understanding` can auto-resolve the task id without --task.
    // Unwrapped — the hook does not read the persisted-report dir.
    const trackActiveClaimCommand = allCommands.find((c) =>
      c.endsWith("harness pack hook track-active-claim"),
    );
    expect(trackActiveClaimCommand).toBe("harness pack hook track-active-claim");
    // v0.18 default-on PostToolUse marker-expiry hook (agent-tasks/d8ee60ca).
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);

    const preToolUseGroup = settings.hooks["PreToolUse"]?.[0];
    expect(preToolUseGroup?.matcher).toBe("Edit|Write|Bash");
  });

  it("UNDERSTANDING_GATE_PAUSE_FILE follows the resolved generatedDir, not a fixed path (AC2) — a --config install anchors it next to the manifest, not ~/.claude", async () => {
    // Regression guard against hardcoding the sentinel path: a
    // --config-only install (no homeDir override) resolves generatedDir
    // next to the manifest (see the "when --config is passed without
    // homeDir" test above), so the PAUSE_FILE prefix must point there
    // too, not at some fixed ~/.claude location.
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-altcfg-pause-"));
    try {
      const altManifest = path.join(altRoot, "harness.yaml");
      fs.writeFileSync(
        altManifest,
        yamlStringify({
          version: 1,
          tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
          memory: { directories: [] },
          hooks: [],
          policies: [],
          policy_packs: [{ name: "understanding-before-execution" }],
        }),
      );
      const r = await apply({ configPath: altManifest });
      expect(r.generatedDir).toBe(path.join(altRoot, GENERATED_DIRNAME));
      const settings = JSON.parse(
        fs.readFileSync(path.join(altRoot, GENERATED_DIRNAME, SETTINGS_BASENAME), "utf8"),
      ) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
      };
      const allCommands: string[] = [];
      for (const groups of Object.values(settings.hooks)) {
        for (const g of groups) for (const h of g.hooks) allCommands.push(h.command);
      }
      const userPromptSubmitCommand = allCommands.find((c) =>
        c.endsWith("understanding-gate-claude-hook"),
      );
      expect(userPromptSubmitCommand).toBe(
        `UNDERSTANDING_GATE_MODE='grill_me' UNDERSTANDING_GATE_PAUSE_FILE='${path.join(
          altRoot,
          GENERATED_DIRNAME,
          ".harness-paused",
        )}' understanding-gate-claude-hook`,
      );
      // Never the tmpHome-anchored path from the sibling test above.
      expect(userPromptSubmitCommand).not.toContain(tmpHome);
    } finally {
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });

  it("apply bakes UNDERSTANDING_GATE_MODE from config.mode alone — an exported env var with a DIFFERENT value has no effect (task 5d73d78d review HIGH-3)", async () => {
    // Repro for the HIGH-3 review finding: before this fix, `harness
    // apply` resolved the pack's mode the SAME env-aware way the live
    // runtime consumers do, so an operator's ambient
    // UNDERSTANDING_GATE_MODE (exported for an unrelated `harness approve
    // understanding` override, or left over from a previous shell
    // session) would silently override `config.mode` in the GENERATED
    // settings.json — an artefact that then persists, frozen, until the
    // next apply, regardless of what the env var says at any later
    // point. This pins: config.mode: grill_me + an exported
    // UNDERSTANDING_GATE_MODE=fast_confirm still bakes the grill_me
    // prefix.
    const saved = process.env["UNDERSTANDING_GATE_MODE"];
    process.env["UNDERSTANDING_GATE_MODE"] = "fast_confirm";
    try {
      writePolicyPackManifest([
        { name: "understanding-before-execution", config: { mode: "grill_me" } },
      ]);
      const r = await apply({ homeDir: tmpHome });
      expect(r.outcome).toBe("applied");
      const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
      };
      const allCommands: string[] = [];
      for (const groups of Object.values(settings.hooks)) {
        for (const g of groups) for (const h of g.hooks) allCommands.push(h.command);
      }
      const userPromptSubmitCommand = allCommands.find((c) =>
        c.endsWith("understanding-gate-claude-hook"),
      );
      // Full command, not just an anchored prefix: the generated line now
      // carries two env assignments (MODE, then PAUSE_FILE), and a shell
      // applies last-assignment-wins per var name. A prefix-anchored
      // /^UNDERSTANDING_GATE_MODE='grill_me' / match only pins the FIRST
      // token — it would still pass if something appended a second,
      // ambient-derived UNDERSTANDING_GATE_MODE assignment after
      // PAUSE_FILE, even though that second assignment is the one the
      // hook process actually sees. Asserting the full string is what
      // catches that.
      expect(userPromptSubmitCommand).toBe(
        `UNDERSTANDING_GATE_MODE='grill_me' UNDERSTANDING_GATE_PAUSE_FILE='${path.join(
          tmpHome,
          GENERATED_DIRNAME,
          ".harness-paused",
        )}' understanding-gate-claude-hook`,
      );
    } finally {
      if (saved === undefined) delete process.env["UNDERSTANDING_GATE_MODE"];
      else process.env["UNDERSTANDING_GATE_MODE"] = saved;
    }
  });

  it("projects an absolute SOLUTION_VERDICT_DIR from grounding-mcp env onto both solution-acceptance hook commands", async () => {
    const manifest = {
      version: 1,
      tools: {
        mcp: [
          {
            name: "grounding-mcp",
            command: ["/usr/bin/true"],
            env: { SOLUTION_VERDICT_DIR: "/abs/verdict/dir" },
          },
        ],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      memory: { directories: [] },
      hooks: [],
      policies: [],
      policy_packs: [{ name: "solution-acceptance" }],
    };
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), yamlStringify(manifest));
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");

    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands: string[] = [];
    for (const groups of Object.values(settings.hooks)) {
      for (const g of groups) for (const h of g.hooks) allCommands.push(h.command);
    }
    const gate = allCommands.find((c) => c.endsWith("harness pack hook solution-acceptance"));
    const writeGuard = allCommands.find((c) =>
      c.endsWith("harness pack hook solution-acceptance-writeguard"),
    );
    expect(gate).toBe(
      "SOLUTION_VERDICT_DIR='/abs/verdict/dir' harness pack hook solution-acceptance",
    );
    expect(writeGuard).toBe(
      "SOLUTION_VERDICT_DIR='/abs/verdict/dir' harness pack hook solution-acceptance-writeguard",
    );
  });

  it("does not prefix solution-acceptance hook commands when grounding-mcp has no SOLUTION_VERDICT_DIR", async () => {
    const manifest = {
      version: 1,
      tools: {
        mcp: [{ name: "grounding-mcp", command: ["/usr/bin/true"] }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      memory: { directories: [] },
      hooks: [],
      policies: [],
      policy_packs: [{ name: "solution-acceptance" }],
    };
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), yamlStringify(manifest));
    await apply({ homeDir: tmpHome });

    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands: string[] = [];
    for (const groups of Object.values(settings.hooks)) {
      for (const g of groups) for (const h of g.hooks) allCommands.push(h.command);
    }
    const gate = allCommands.find((c) => c.endsWith("harness pack hook solution-acceptance"));
    expect(gate).toBe("harness pack hook solution-acceptance");
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

  // Fail-loud follow-up (PR #241 task 33616d49): apply used to skip
  // unrecognised pack sources / unknown builtin names silently. That
  // behaviour masked broken manifests until someone ran `validate` or
  // `doctor`. Both branches now throw HarnessExitError with EX_FAIL
  // before expansion runs, parallel to `harness validate`.
  it("a pack with an unknown source fails apply with a non-zero exit naming the pack", async () => {
    writePolicyPackManifest([
      { name: "understanding-before-execution", source: "path:./somewhere" },
    ]);
    const err = await apply({ homeDir: tmpHome }).then(
      () => null,
      (e: unknown) => e as HarnessExitError,
    );
    expect(err).toBeInstanceOf(HarnessExitError);
    expect(err?.exitCode).toBe(1);
    expect(err?.message).toMatch(/understanding-before-execution/);
    expect(err?.message).toMatch(/only "builtin" resolves/);
    expect(fs.existsSync(instructionsPath("understanding-before-execution"))).toBe(false);
  });

  it("a pack with an unknown builtin name fails apply with a non-zero exit naming the pack", async () => {
    writePolicyPackManifest([{ name: "no-such-pack" }]);
    const err = await apply({ homeDir: tmpHome }).then(
      () => null,
      (e: unknown) => e as HarnessExitError,
    );
    expect(err).toBeInstanceOf(HarnessExitError);
    expect(err?.exitCode).toBe(1);
    expect(err?.message).toMatch(/no-such-pack/);
    expect(err?.message).toMatch(/not a known builtin pack/);
  });

  it("does not flag an enabled:false pack with a bogus source or name", async () => {
    writePolicyPackManifest([
      { name: "no-such-pack", source: "git:https://x.git", enabled: false },
    ]);
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
  });

  it("aggregates multiple pack source issues into one HarnessExitError", async () => {
    writePolicyPackManifest([
      { name: "understanding-before-execution", source: "path:./somewhere" },
      { name: "no-such-pack" },
    ]);
    await expect(apply({ homeDir: tmpHome })).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/2 policy pack issues/),
    });
  });

  it("emits a permissions block when config.permission_profile is set", async () => {
    writePolicyPackManifest([
      {
        name: "understanding-before-execution",
        config: { permission_profile: "safe-start" },
      },
    ]);
    await apply({ homeDir: tmpHome });
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
    };
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions?.allow).toEqual(["Glob", "Grep", "Read"]);
    expect(settings.permissions?.ask).toContain("Edit");
    expect(settings.permissions?.deny).toContain("Bash(git commit*)");
  });

  it("omits the permissions block when no profile is selected", async () => {
    writePolicyPackManifest([{ name: "understanding-before-execution" }]);
    await apply({ homeDir: tmpHome });
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      permissions?: unknown;
    };
    expect(settings.permissions).toBeUndefined();
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

describe("apply: preserves sibling state under harness.generated/ (agent-tasks/bf8e1be8)", () => {
  // Regression guard for the v0.14.0 marker introduction. `harness apply`
  // is allowed to write its own known files into harness.generated/ but
  // MUST NOT wipe sibling state. Two files in particular live there now:
  //
  //   - .approvals/<sessionId>: operator-written canonical gate signal
  //     (agent-tasks/88ca4bb3, PR #132). Wiping it on apply would silently
  //     re-block every live session.
  //   - .pending-approval: staged session id the gate hook writes when
  //     it blocks. Same survival contract; existing behaviour pre-#132,
  //     pinned here for completeness.

  it("approval marker at harness.generated/.approvals/<sid> survives apply unchanged", async () => {
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
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const markerPath = path.join(generatedDir, ".approvals", "sess-live");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const markerBody = `${JSON.stringify(
      { approvedAt: "2026-05-15T19:00:00Z", approvedBy: "test-operator" },
      null,
      2,
    )}\n`;
    fs.writeFileSync(markerPath, markerBody);

    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerBody);
  });

  it("a subsequent (no-op) apply also leaves the marker intact", async () => {
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
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const markerPath = path.join(generatedDir, ".approvals", "sess-live");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const markerBody = `${JSON.stringify(
      { approvedAt: "2026-05-15T19:00:00Z", approvedBy: "test-operator" },
      null,
      2,
    )}\n`;
    fs.writeFileSync(markerPath, markerBody);

    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.outcome).toBe("no-changes");
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerBody);
  });

  it(".pending-approval staging file is also preserved", async () => {
    // Pinned alongside .approvals/ so a future "clean up harness.generated/"
    // refactor cannot regress the staging file without flipping this test.
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
    const stagingPath = path.join(tmpHome, GENERATED_DIRNAME, ".pending-approval");
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, "sess-staged\n");

    await apply({ homeDir: tmpHome });
    expect(fs.readFileSync(stagingPath, "utf8")).toBe("sess-staged\n");
  });

  it("the HMAC approval-signing key (.approval-signing.key) survives apply unchanged (harness/f9485cc7)", async () => {
    // Regression guard for the marker-signing feature: the key is a
    // sibling of .approvals/ directly under harness.generated/, written
    // outside apply's own known-files set. Losing it on a re-apply would
    // silently invalidate every previously-signed marker.
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
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const keyPath = signingKeyPathFor(generatedDir);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const keyBytes = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, keyBytes, { mode: 0o600 });

    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath).equals(keyBytes)).toBe(true);
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("apply — grounding-mcp policy-degradation gate (discovery H3)", () => {
  function writePolicyManifest(withGroundingMcp: boolean): void {
    const manifest = {
      version: 1,
      tools: {
        mcp: withGroundingMcp ? [{ name: "grounding-mcp", command: ["/usr/bin/true"] }] : [],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      memory: { directories: [] },
      hooks: [
        {
          name: "h",
          event: "PreToolUse",
          command: path.join(tmpHome, "hooks", "h.sh"),
          blocking: false,
        },
      ],
      policies: [
        {
          name: "p",
          description: "test",
          trigger: { event: "PreToolUse" },
          requires: { ledger_tag: "review:${SESSION_ID}" },
          hook: "h",
          enforcement: "block",
        },
      ],
    };
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), yamlStringify(manifest));
  }

  it("fails apply when policies are declared but grounding-mcp is not wired", async () => {
    writePolicyManifest(false);
    await expect(apply({ homeDir: tmpHome })).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      // Name the tier-aware degradation (task f1aea826: block-tier
      // hard-denies, no longer silent warn-mode) AND the actionable fix
      // AND point at validate. Pins the message so it cannot drift from
      // the runtime contract again (review 2026-08-08, round 2).
      message: expect.stringMatching(
        /grounding-mcp not wired.*will DENY every matching event \(deny-degraded\).*Wire grounding-mcp under tools\.mcp.*harness validate/s,
      ),
    });
  });

  it("does not write settings.json when the degradation gate fails (fail-closed)", async () => {
    writePolicyManifest(false);
    await apply({ homeDir: tmpHome }).catch(() => undefined);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("succeeds when policies are declared and grounding-mcp is wired", async () => {
    writePolicyManifest(true);
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
  });
});

// Review round 3 (99f47307 Slice 1): the `.last-apply` manifest snapshot
// serialised the DERIVED view (hand-authored plus workflows[]-derived
// policies). It now stores the hand-authored view and the restart-hint
// reader re-derives, so the comparison is derived-vs-derived by the same
// code and a snapshot written before the derivation existed cannot emit
// a one-time phantom "hooks changed" hint.
describe("apply — workflows[]-derived policies and the .last-apply snapshot (review round 3)", () => {
  function writeWorkflowManifest(): void {
    fs.writeFileSync(
      path.join(tmpHome, "harness.yaml"),
      `version: 1
tools:
  mcp:
    - name: grounding-mcp
      command: [node, /x/grounding.js]
  cli: []
  skills: {enabled: [], source_dirs: []}
  builtin: {known: []}
memory:
  directories: []
review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
policies: []
`,
      "utf8",
    );
  }

  it("stores only hand-authored policies in the snapshot, and a second apply emits no restart hint", async () => {
    writeWorkflowManifest();
    const r1 = await apply({ homeDir: tmpHome });
    expect(r1.outcome).toBe("applied");
    const record = readLastApply(path.join(tmpHome, GENERATED_DIRNAME));
    const snapshot = JSON.parse(record!.manifest!.content) as { policies: { name: string }[] };
    expect(snapshot.policies).toEqual([]);

    const r2 = await apply({ homeDir: tmpHome });
    expect(r2.restartHints).toEqual([]);
  });

  it("a snapshot without the derived pair (pre-derivation release shape) yields no phantom hooks hint", async () => {
    writeWorkflowManifest();
    await apply({ homeDir: tmpHome });
    // The stored snapshot already lacks the derived pair; make the
    // pre-derivation shape explicit by asserting it, then re-apply.
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const record = readLastApply(generatedDir)!;
    expect(record.manifest!.content).not.toContain("workflow:ship:");
    const r = await apply({ homeDir: tmpHome });
    expect(r.restartHints).not.toContain(RESTART_HINT_HOOKS);
  });
});
