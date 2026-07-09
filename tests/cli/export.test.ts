import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { exportManifest, __testables } from "../../src/cli/export.js";
import { parseManifest } from "../../src/schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-export-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("exportManifest — happy path", () => {
  it("emits YAML whose parseManifest round-trip matches the post-merge form", () => {
    const r = exportManifest({ configPath: FULL_MANIFEST });
    expect(r.wroteTo).toBeNull();
    expect(r.sanitized).toBe(false);
    const parsed = parseManifest(parseYaml(r.output));
    expect(parsed).toEqual(r.manifest);
  });

  it("--json emits JSON parseable by JSON.parse", () => {
    const r = exportManifest({ configPath: FULL_MANIFEST, json: true });
    const parsed = JSON.parse(r.output);
    expect(parsed.version).toBe(1);
    expect(parsed.tools.mcp).toBeInstanceOf(Array);
  });
});

describe("exportManifest — --sanitize", () => {
  it("redacts env values whose key looks credential-shaped", () => {
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  mcp:",
        "    - name: x",
        "      command: /usr/bin/true",
        "      env:",
        "        OPENAI_API_KEY: sk-real-secret",
        "        SLACK_TOKEN: xoxb-real",
        "        LOG_LEVEL: debug",
        "      health:",
        "        verb: ok",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.sanitized).toBe(true);
    expect(r.output).toContain("OPENAI_API_KEY: <REDACTED>");
    expect(r.output).toContain("SLACK_TOKEN: <REDACTED>");
    expect(r.output).toContain("LOG_LEVEL: debug");
    expect(r.output).toContain("# sanitised:");
  });

  it("does not redact harmless env keys (LOG_LEVEL, AGENT_TASKS_URL)", () => {
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  mcp:",
        "    - name: tasks",
        "      command: /usr/bin/true",
        "      env:",
        "        AGENT_TASKS_URL: https://example.com",
        "        LOG_LEVEL: info",
        "      health: { verb: ok }",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.output).toContain("AGENT_TASKS_URL: https://example.com");
    expect(r.output).toContain("LOG_LEVEL: info");
    expect(r.output).not.toContain("<REDACTED>");
  });

  it("does not redact env values whose values were never written (sanitiser is key-based)", () => {
    // value of LOG_LEVEL = "secret-looking-but-key-is-clean" stays.
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  mcp:",
        "    - name: x",
        "      command: /usr/bin/true",
        "      env:",
        "        LOG_LEVEL: aws_secret_1234",
        "      health: { verb: ok }",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.output).toContain("LOG_LEVEL: aws_secret_1234");
  });

  it("rewrites /home/<user>/... to ~/...", () => {
    const homeDir = os.homedir();
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  cli:",
        `    - name: foo`,
        `      binary: ${homeDir}/bin/foo`,
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.output).toContain("binary: ~/bin/foo");
    expect(r.output).not.toContain(homeDir);
  });
});

describe("exportManifest — -o <file>", () => {
  it("writes to the file atomically and exits with empty stdout output is ignored when wroteTo is set", () => {
    const target = path.join(tmpDir, "exported.yaml");
    const r = exportManifest({ configPath: FULL_MANIFEST, outputPath: target });
    expect(r.wroteTo).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    const parsed = parseManifest(parseYaml(fs.readFileSync(target, "utf8")));
    expect(parsed.version).toBe(1);
  });

  it("creates the parent directory if missing (atomicWriteFile contract)", () => {
    const target = path.join(tmpDir, "nested/sub/exported.yaml");
    exportManifest({ configPath: FULL_MANIFEST, outputPath: target });
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("sanitize — pure helpers", () => {
  it("isInsideEnvBlock matches only the immediate-parent env case", () => {
    expect(__testables.isInsideEnvBlock(["tools", "mcp", 0, "env"])).toBe(true);
    expect(__testables.isInsideEnvBlock(["tools", "env", "name"])).toBe(false);
    expect(__testables.isInsideEnvBlock([])).toBe(false);
  });

  it("rewriteHomePath is a no-op when homeDir is empty or root", () => {
    expect(__testables.rewriteHomePath("/foo", "")).toBe("/foo");
    expect(__testables.rewriteHomePath("/foo", "/")).toBe("/foo");
  });

  it("rewriteHomePath does not partial-match a longer username (homedir prefix collision)", () => {
    expect(__testables.rewriteHomePath("/home/landscape/project/x.ts", "/home/lan")).toBe(
      "/home/landscape/project/x.ts",
    );
    // exact match and trailing-slash forms still rewrite
    expect(__testables.rewriteHomePath("/home/lan/x", "/home/lan")).toBe("~/x");
    expect(__testables.rewriteHomePath("/home/lan", "/home/lan")).toBe("~");
  });

  it("SECRET_KEY_PATTERN matches the documented suffixes only", () => {
    const re = __testables.SECRET_KEY_PATTERN;
    expect(re.test("OPENAI_API_KEY")).toBe(true);
    expect(re.test("SLACK_TOKEN")).toBe(true);
    expect(re.test("MY_SECRET")).toBe(true);
    expect(re.test("DB_PASSWORD")).toBe(true);
    expect(re.test("KEY")).toBe(true);
    expect(re.test("LOG_LEVEL")).toBe(false);
    expect(re.test("AGENT_TASKS_URL")).toBe(false);
  });
});
