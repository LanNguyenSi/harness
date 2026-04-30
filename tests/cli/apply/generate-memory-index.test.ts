import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMemoryIndex } from "../../../src/cli/apply/generate-memory-index.js";
import { parseManifest, type Manifest } from "../../../src/schema/index.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mem-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function manifestWithDir(dirPath: string): Manifest {
  return parseManifest({
    version: 1,
    tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
    memory: { directories: [{ path: dirPath, scope: "project" }] },
    hooks: [],
    policies: [],
  });
}

function writeMemory(dir: string, basename: string, name: string, description?: string): void {
  const desc = description !== undefined ? `\ndescription: ${description}` : "";
  const content = `---\nname: ${name}${desc}\ntype: user\n---\n\n# ${name}\n`;
  fs.writeFileSync(path.join(dir, basename), content);
}

describe("generateMemoryIndex", () => {
  it("emits 3 bullet lines, sorted by name, for a directory with 3 valid memories", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    writeMemory(dir, "z.md", "Zebra", "z hook");
    writeMemory(dir, "a.md", "Alpha", "a hook");
    writeMemory(dir, "m.md", "Mike", "m hook");

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.warnings).toEqual([]);
    expect(result.content).toBe(
      [
        "- [Alpha](a.md) — a hook",
        "- [Mike](m.md) — m hook",
        "- [Zebra](z.md) — z hook",
        "",
      ].join("\n"),
    );
    expect(result.entries).toHaveLength(3);
  });

  it("returns an empty content string for an empty memory directory", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.content).toBe("");
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("skips files lacking valid frontmatter; surfaces a warning per file", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    writeMemory(dir, "good.md", "Good", "ok");
    fs.writeFileSync(path.join(dir, "no-fm.md"), "# just a body, no frontmatter\n");
    fs.writeFileSync(
      path.join(dir, "no-name.md"),
      "---\ndescription: missing name\ntype: user\n---\nbody\n",
    );

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("Good");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.find((w) => w.includes("no-fm.md"))).toMatch(/no frontmatter/);
    expect(result.warnings.find((w) => w.includes("no-name.md"))).toMatch(/missing required `name`/);
  });

  it("warns but keeps entries whose description is empty (uses no-hook line shape)", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    writeMemory(dir, "no-desc.md", "NoDesc"); // no description field

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toHaveLength(1);
    expect(result.content).toBe("- [NoDesc](no-desc.md)\n");
    expect(result.warnings.find((w) => w.includes("missing `description`"))).toBeDefined();
  });

  it("output is deterministic across two runs", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    writeMemory(dir, "b.md", "Beta", "b");
    writeMemory(dir, "a.md", "Alpha", "a");

    const m = manifestWithDir("~/memory");
    const r1 = generateMemoryIndex(m, { homeDir: tmpHome });
    const r2 = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(r1.content).toBe(r2.content);
  });

  it("substitutes {project} placeholder using opts.projectName", () => {
    const dir = path.join(tmpHome, "projects/pandora/memory");
    fs.mkdirSync(dir, { recursive: true });
    writeMemory(dir, "p.md", "ProjectMemo", "p hook");

    const m = manifestWithDir("~/projects/{project}/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome, projectName: "pandora" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.directory).toBe(dir);
  });

  it("skips directories with {project} placeholder when projectName is not provided", () => {
    const m = manifestWithDir("~/projects/{project}/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toEqual([]);
    // skipped silently — placeholders without context are not warnings
    expect(result.warnings).toEqual([]);
  });

  it("warns when a configured directory does not exist on disk", () => {
    const m = manifestWithDir("~/missing-memdir");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toEqual([]);
    expect(result.warnings.some((w) => w.includes("not readable"))).toBe(true);
  });

  it("aggregates entries across multiple memory directories", () => {
    const d1 = path.join(tmpHome, "user-mem");
    const d2 = path.join(tmpHome, "proj-mem");
    fs.mkdirSync(d1, { recursive: true });
    fs.mkdirSync(d2, { recursive: true });
    writeMemory(d1, "u.md", "User-A", "user hook");
    writeMemory(d2, "p.md", "Project-A", "project hook");

    const m = parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: {
        directories: [
          { path: "~/user-mem", scope: "user" },
          { path: "~/proj-mem", scope: "project" },
        ],
      },
      hooks: [],
      policies: [],
    });
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries.map((e) => e.name).sort()).toEqual(["Project-A", "User-A"]);
  });

  it("excludes a top-level MEMORY.md file from the index (avoids self-reference, no spurious warning)", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    // Curated MEMORY.md has no frontmatter in the canonical layout. The
    // generator must skip it BEFORE attempting frontmatter parsing so no
    // "no frontmatter" warning fires on it.
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [Foo](foo.md)\n");
    writeMemory(dir, "real.md", "Real", "a real memory");

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries.map((e) => e.basename)).toEqual(["real.md"]);
    expect(result.warnings.find((w) => w.includes("MEMORY.md"))).toBeUndefined();
  });

  it("rejects frontmatter missing the `type` field (matches canonical loader's strict requirement)", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    // Hand-rolled: name present, type absent.
    fs.writeFileSync(
      path.join(dir, "no-type.md"),
      "---\nname: NoType\ndescription: missing type\n---\nbody\n",
    );
    writeMemory(dir, "ok.md", "OK", "fine");

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries.map((e) => e.name)).toEqual(["OK"]);
    expect(result.warnings.find((w) => w.includes("no-type.md"))).toMatch(/missing required `type`/);
  });

  it("parses CRLF-encoded frontmatter (Windows / editor-normalised files)", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    // Explicit CRLF line endings inside and around the frontmatter delimiter.
    fs.writeFileSync(
      path.join(dir, "crlf.md"),
      "---\r\nname: CRLF\r\ndescription: works\r\ntype: user\r\n---\r\nbody\r\n",
    );

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries.map((e) => e.name)).toEqual(["CRLF"]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an explicit empty `name: \"\"` string with the same warning as missing name", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "empty-name.md"),
      "---\nname: \"\"\ndescription: explicit empty\ntype: user\n---\nbody\n",
    );
    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toMatch(/missing required `name`/);
  });

  it("warns on basename collision across memory directories", () => {
    const d1 = path.join(tmpHome, "user-mem");
    const d2 = path.join(tmpHome, "proj-mem");
    fs.mkdirSync(d1, { recursive: true });
    fs.mkdirSync(d2, { recursive: true });
    writeMemory(d1, "notes.md", "User-notes", "u");
    writeMemory(d2, "notes.md", "Project-notes", "p");
    const m = parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: {
        directories: [
          { path: "~/user-mem", scope: "user" },
          { path: "~/proj-mem", scope: "project" },
        ],
      },
      hooks: [],
      policies: [],
    });
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toHaveLength(2);
    expect(result.warnings.some((w) => /basename collision.*notes\.md/.test(w))).toBe(true);
  });

  it("skips files with malformed YAML frontmatter (warning, not throw)", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "broken.md"),
      "---\nname: [unbalanced\ndescription: x\n---\nbody\n",
    );

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/broken\.md/);
  });

  it("skips frontmatter that parses to an array or scalar (not an object)", () => {
    const dir = path.join(tmpHome, "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "arr.md"), "---\n- a\n- b\n---\nbody\n");
    fs.writeFileSync(path.join(dir, "scalar.md"), "---\njust a string\n---\nbody\n");

    const m = manifestWithDir("~/memory");
    const result = generateMemoryIndex(m, { homeDir: tmpHome });
    expect(result.entries).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });
});
