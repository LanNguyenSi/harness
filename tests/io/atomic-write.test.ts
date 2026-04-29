import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile, withDocument } from "../../src/io/atomic-write.js";

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
