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
import { LOCK_BASENAME, parseLock } from "../../../src/io/harness-lock.js";
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
    expect(fs.existsSync(lockPath())).toBe(true);
    const entries = parseLock(fs.readFileSync(lockPath(), "utf8"));
    expect(entries.find((e) => e.path === hookFile)).toBeDefined();
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
    // Simulate a Phase 3 #1 baseline .last-apply (no manifest field) by
    // writing the directory layout directly.
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
    const generated = path.join(tmpHome, GENERATED_DIRNAME);
    fs.mkdirSync(generated);
    fs.writeFileSync(
      path.join(generated, LAST_APPLY_BASENAME),
      JSON.stringify({ files: {} }, null, 2),
    );
    const r = await apply({ homeDir: tmpHome });
    // No prior manifest snapshot → no hints, regardless of what changed.
    expect(r.restartHints).toEqual([]);
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
