import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

async function exec(argv: string[]): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, code };
}

describe("CLI program — describe command", () => {
  it("returns 0 and writes YAML on success", async () => {
    const r = await exec(["describe", "--config", FULL_MANIFEST]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^version: 1\n/);
  });

  it("emits JSON when --json is set", async () => {
    const r = await exec(["describe", "--config", FULL_MANIFEST, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.version).toBe(1);
  });

  it("rejects an unknown --pillar value with EX_USAGE", async () => {
    const r = await exec(["describe", "--config", FULL_MANIFEST, "--pillar", "nope"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown pillar/i);
  });

  it("returns EX_NOINPUT when the manifest file is missing", async () => {
    const r = await exec(["describe", "--config", "/nonexistent/harness.yaml"]);
    expect(r.code).toBe(66);
    expect(r.stderr).toMatch(/not found/);
  });

  it("supports filtering to one pillar", async () => {
    const r = await exec([
      "describe",
      "--config",
      FULL_MANIFEST,
      "--pillar",
      "hooks",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\nhooks:\n/);
    expect(r.stdout).not.toMatch(/\ntools:\n/);
  });
});
