import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply, GENERATED_DIRNAME, SETTINGS_BASENAME } from "../../../src/cli/apply/index.js";
import { diffSinceApply } from "../../../src/cli/diff/since-apply.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-diffsa-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

interface ManifestSeed {
  hooks?: unknown[];
  memoryDirs?: { path: string; scope: "project" | "user" }[];
}

function writeManifest(seed: ManifestSeed = {}): string {
  const manifest: Record<string, unknown> = {
    version: 1,
    tools: {
      mcp: [],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: seed.memoryDirs ?? [] },
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

describe("diff --since-apply", () => {
  it("returns no drift after a clean apply", async () => {
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
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.hasDrift).toBe(false);
    expect(r.files).toEqual([]);
    expect(r.assets).toEqual([]);
    expect(r.memories).toEqual([]);
  });

  it("emits unified diff for hand-edited generated/settings.json", async () => {
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
    fs.writeFileSync(settingsPath(), '{"hand": true}\n');
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.hasDrift).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.basename).toBe(SETTINGS_BASENAME);
    expect(r.files[0]?.diff).toContain("hand");
    expect(r.assets).toEqual([]);
  });

  it("flags an externally-edited locked hook script in the assets section", async () => {
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
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.hasDrift).toBe(true);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0]?.path).toBe(hookFile);
    expect(r.assets[0]?.reason).toBe("modified");
  });

  it("reports a missing locked asset (file deleted)", async () => {
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
    fs.rmSync(hookFile);
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0]?.reason).toBe("missing");
  });

  it("with --memory-detail expands per-memory-dir drift to per-file changes", async () => {
    const memDir = path.join(tmpHome, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nbody-v1\n",
    );
    fs.writeFileSync(
      path.join(memDir, "b.md"),
      "---\nname: B\ndescription: b\ntype: user\n---\nbody-b\n",
    );
    writeManifest({
      memoryDirs: [{ path: "~/memory", scope: "user" }],
    });
    await apply({ homeDir: tmpHome });

    // Modify a.md (content change), add c.md, remove b.md
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nbody-v2-changed\n",
    );
    fs.rmSync(path.join(memDir, "b.md"));
    fs.writeFileSync(
      path.join(memDir, "c.md"),
      "---\nname: C\ndescription: c\ntype: user\n---\nbody-c\n",
    );

    const r = diffSinceApply({ homeDir: tmpHome, memoryDetail: true });
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]?.path).toBe(memDir);
    const kinds = r.memories[0]?.files?.map((f) => `${f.kind}:${f.basename}`).sort();
    expect(kinds).toEqual(["added:c.md", "modified:a.md", "removed:b.md"]);
  });

  it("without --memory-detail collapses memory drift to a single dir entry (no files field)", async () => {
    const memDir = path.join(tmpHome, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv1\n",
    );
    writeManifest({
      memoryDirs: [{ path: "~/memory", scope: "user" }],
    });
    await apply({ homeDir: tmpHome });
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv2\n",
    );
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]?.files).toBeUndefined();
  });

  it("throws EX_NOINPUT when no .last-apply exists (apply never run)", () => {
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
    try {
      diffSinceApply({ homeDir: tmpHome });
      expect.fail("expected EX_NOINPUT");
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessExitError);
      expect((err as HarnessExitError).exitCode).toBe(66);
      expect((err as HarnessExitError).message).toMatch(/run `harness apply` first/);
    }
  });

  it("emits a single human-readable report with the three section headers", async () => {
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
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.output).toContain("# Generated files");
    expect(r.output).toContain("# Asset drift");
    expect(r.output).toContain("# Memory directories");
  });

  it("reports memory dir as `missing` when it has been replaced by a regular file", async () => {
    const memDir = path.join(tmpHome, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv1\n",
    );
    writeManifest({
      memoryDirs: [{ path: "~/memory", scope: "user" }],
    });
    await apply({ homeDir: tmpHome });
    fs.rmSync(memDir, { recursive: true });
    fs.writeFileSync(memDir, "now a regular file\n");
    const r = diffSinceApply({ homeDir: tmpHome });
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]?.reason).toBe("missing");
  });

  it("--memory-detail with a baseline .last-apply (no memoryDirs field) emits a warning and skips per-file expansion", async () => {
    const memDir = path.join(tmpHome, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv1\n",
    );
    writeManifest({
      memoryDirs: [{ path: "~/memory", scope: "user" }],
    });
    await apply({ homeDir: tmpHome });
    // Strip the memoryDirs field as if .last-apply were written by Phase 3 #4
    // (before the schema extension).
    const lastApplyPath = path.join(tmpHome, GENERATED_DIRNAME, ".last-apply");
    const record = JSON.parse(fs.readFileSync(lastApplyPath, "utf8")) as {
      memoryDirs?: unknown;
    };
    delete record.memoryDirs;
    fs.writeFileSync(lastApplyPath, `${JSON.stringify(record, null, 2)}\n`);

    fs.writeFileSync(
      path.join(memDir, "a.md"),
      "---\nname: A\ndescription: a\ntype: user\n---\nv2\n",
    );
    const r = diffSinceApply({ homeDir: tmpHome, memoryDetail: true });
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]?.files).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("no per-file index"))).toBe(true);
  });

  it("structured json payload contains the three sections", async () => {
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
    fs.writeFileSync(settingsPath(), '{"hand": true}\n');
    const r = diffSinceApply({ homeDir: tmpHome });
    const json = JSON.parse(JSON.stringify(r.json));
    expect(Object.keys(json).sort()).toEqual(["assets", "files", "memories"]);
    expect(json.files).toHaveLength(1);
  });
});

describe("diff --since-apply (CLI integration)", () => {
  it("--since and --since-apply are mutually exclusive (EX_USAGE)", async () => {
    const { run } = await import("../../../src/cli/index.js");
    let stderrBuf = "";
    const code = await run({
      argv: ["diff", "--since", "main", "--since-apply"],
      stderr: (s) => {
        stderrBuf += s;
      },
      stdout: () => {
        /* swallow */
      },
    });
    expect(code).toBe(64);
    expect(stderrBuf).toMatch(/mutually exclusive/);
  });
});
