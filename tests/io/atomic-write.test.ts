import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATOMIC_WRITE_TEMP_FLAGS,
  atomicWriteFile,
  randomTempSuffix,
  withDocument,
} from "../../src/io/atomic-write.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILT_HELPER = path.join(REPO_ROOT, "dist", "io", "atomic-write.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-aw-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("writes new content to a fresh path", () => {
    const target = path.join(tmpDir, "harness.yaml");
    atomicWriteFile(target, "version: 1\n");
    expect(fs.readFileSync(target, "utf8")).toBe("version: 1\n");
  });

  it("overwrites existing content atomically (the file is either old or new, never partial)", () => {
    const target = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(target, "old\n");
    atomicWriteFile(target, "new\n");
    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
  });

  it("does not leave the .tmp file behind on the success path", () => {
    const target = path.join(tmpDir, "harness.yaml");
    atomicWriteFile(target, "version: 1\n");
    const stragglers = fs.readdirSync(tmpDir).filter((n) => n.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  it("creates the parent directory if missing", () => {
    const target = path.join(tmpDir, "nested/dir/harness.yaml");
    atomicWriteFile(target, "version: 1\n");
    expect(fs.readFileSync(target, "utf8")).toBe("version: 1\n");
  });

  it("preserves the original file when the write step throws (no partial state)", () => {
    const target = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(target, "intact\n");
    // Force a write failure by passing an obviously invalid mode.
    expect(() =>
      atomicWriteFile(target, "should-not-land", { mode: -1 }),
    ).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("intact\n");
  });
});

describe("atomicWriteFile: the temp file is created by this call or the write fails", () => {
  const tmpName = (base: string, suffix: string): string => `.${base}.${process.pid}.${suffix}.tmp`;

  it("opens the temp file with O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW", () => {
    const c = fs.constants;
    expect(ATOMIC_WRITE_TEMP_FLAGS & c.O_WRONLY).toBe(c.O_WRONLY);
    expect(ATOMIC_WRITE_TEMP_FLAGS & c.O_CREAT).toBe(c.O_CREAT);
    expect(ATOMIC_WRITE_TEMP_FLAGS & c.O_EXCL).toBe(c.O_EXCL);
    // O_NOFOLLOW is undefined on Windows; every platform CI runs on has it.
    if (typeof c.O_NOFOLLOW === "number") {
      expect(ATOMIC_WRITE_TEMP_FLAGS & c.O_NOFOLLOW).toBe(c.O_NOFOLLOW);
    }
    expect(ATOMIC_WRITE_TEMP_FLAGS & c.O_TRUNC).toBe(0);
  });

  it("draws an unpredictable suffix: 16 hex chars, different on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = randomTempSuffix();
      expect(s).toMatch(/^[0-9a-f]{16}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(50);
  });

  it("does not use the old pid.millisecond name: files planted at every such name do not stop a default write", () => {
    const target = path.join(tmpDir, "h.yaml");
    const now = Date.now();
    for (let ms = now - 20; ms < now + 400; ms++) {
      fs.writeFileSync(path.join(tmpDir, tmpName("h.yaml", String(ms))), "planted");
    }
    atomicWriteFile(target, "ok\n");
    expect(fs.readFileSync(target, "utf8")).toBe("ok\n");
  });

  it("a regular file already at the temp name fails the write, is left untouched, and the target stays as it was", () => {
    const target = path.join(tmpDir, "h.yaml");
    fs.writeFileSync(target, "intact\n");
    const planted = path.join(tmpDir, tmpName("h.yaml", "fixed"));
    fs.writeFileSync(planted, "planted\n");
    expect(() => atomicWriteFile(target, "new\n", {}, () => "fixed")).toThrow(/EEXIST/);
    expect(fs.readFileSync(planted, "utf8")).toBe("planted\n");
    expect(fs.readFileSync(target, "utf8")).toBe("intact\n");
  });

  it("a symlink to a file outside the directory at the temp name fails the write and writes nothing through the link", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-aw-out-"));
    try {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "victim\n");
      const target = path.join(tmpDir, "h.yaml");
      const link = path.join(tmpDir, tmpName("h.yaml", "fixed"));
      fs.symlinkSync(victim, link);
      expect(() => atomicWriteFile(target, "new\n", {}, () => "fixed")).toThrow(/EEXIST|ELOOP/);
      expect(fs.readFileSync(victim, "utf8")).toBe("victim\n");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a dangling symlink at the temp name does not get its target created", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-aw-out-"));
    try {
      const missing = path.join(outside, "not-yet.txt");
      const target = path.join(tmpDir, "h.yaml");
      fs.symlinkSync(missing, path.join(tmpDir, tmpName("h.yaml", "fixed")));
      expect(() => atomicWriteFile(target, "new\n", {}, () => "fixed")).toThrow(/EEXIST|ELOOP/);
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A FIFO with no reader blocks a plain O_WRONLY open forever, and the open
  // is synchronous, so the check runs in a child killed at a bound: a
  // regression fails the test instead of hanging the suite. It uses the built
  // helper (the same dist the CLI tests run), which `npm run build` produces.
  it("a FIFO with no reader at the temp name fails the write at once instead of blocking", () => {
    const target = path.join(tmpDir, "h.yaml");
    // The temp name carries the writer's pid, so the child plants the FIFO itself.
    const script = [
      `import { execFileSync } from "node:child_process";`,
      `import { atomicWriteFile } from ${JSON.stringify(pathToFileURL(BUILT_HELPER).href)};`,
      `execFileSync("mkfifo", [${JSON.stringify(tmpDir)} + "/.h.yaml." + process.pid + ".fixed.tmp"]);`,
      `try { atomicWriteFile(${JSON.stringify(target)}, "new\\n", {}, () => "fixed"); console.log("WROTE"); }`,
      `catch (e) { console.log("FAILED " + e.code); }`,
    ].join("\n");
    const bound = 10_000;
    const started = Date.now();
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: bound,
      killSignal: "SIGKILL",
    });
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe("ETIMEDOUT");
    expect(Date.now() - started).toBeLessThan(bound);
    expect(result.stdout.trim()).toBe("FAILED EEXIST");
    expect(fs.existsSync(target)).toBe(false);
  }, 30_000);

  it("removes the temp file again when the rename fails after it was created", () => {
    // The target is a directory, so renaming the temp file over it fails.
    const target = path.join(tmpDir, "a-directory");
    fs.mkdirSync(target);
    expect(() => atomicWriteFile(target, "new\n")).toThrow();
    expect(fs.readdirSync(tmpDir)).toEqual(["a-directory"]);
  });

  it("keeps the requested mode on a successful write", () => {
    const target = path.join(tmpDir, "secret.json");
    atomicWriteFile(target, "{}\n", { mode: 0o600 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("withDocument — comment preservation", () => {
  it("round-trips a manifest with comments byte-equivalent on no-op", () => {
    const yaml = [
      "# user manifest",
      "version: 1",
      "# tools section",
      "tools:",
      "  mcp:",
      "    - name: codebase-oracle # primary semantic search",
      "      command: [npx, tsx, ./oracle.ts]",
      "",
    ].join("\n");
    const out = withDocument(yaml, () => {});
    expect(out).toBe(yaml);
  });

  it("does not reflow long flow sequences to block style on round-trip (lineWidth:0)", () => {
    // 103-character flow sequence — would fold to multi-line block style at the
    // yaml package's default lineWidth of 80. This is the docs/examples/full-manifest.yaml
    // memory-router command shape verbatim.
    const yaml = [
      "memory:",
      "  router:",
      "    command: [node, ~/git/pandora/agent-memory/packages/memory-router/dist/hooks/user-prompt-submit.js]",
      "    enabled: true",
      "",
    ].join("\n");
    const out = withDocument(yaml, () => {});
    expect(out).toBe(yaml);
  });

  it("preserves leading/trailing comments when the AST is mutated", () => {
    const yaml = [
      "# top comment",
      "version: 1",
      "tools:",
      "  cli:",
      "    - name: gh # github cli",
      "      binary: gh",
      "# trailing",
      "",
    ].join("\n");
    const out = withDocument(yaml, (doc) => {
      const tools = doc.get("tools") as { get(k: string): unknown };
      const cli = tools.get("cli") as { add(v: unknown): void };
      cli.add({ name: "git-batch", binary: "git-batch" });
    });
    expect(out).toContain("# top comment");
    expect(out).toContain("# github cli");
    expect(out).toContain("# trailing");
    expect(out).toContain("git-batch");
  });
});
