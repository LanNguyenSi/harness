import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { explain } from "../../src/cli/explain.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

describe("explain — happy path", () => {
  it("prints a structured definition for a known policy", () => {
    const r = explain("review-before-merge", { configPath: FULL_MANIFEST });
    expect(r.output).toContain("name: review-before-merge");
    expect(r.output).toContain("trigger:");
    expect(r.output).toContain("requires:");
    expect(r.output).toContain("hook: require-review-evidence");
    expect(r.output).toContain("enforcement: block");
    expect(r.output).toContain("schema valid; last-evaluated tracking ships in Phase 4");
  });

  it("emits parseable JSON when --json is passed", () => {
    const r = explain("dogfood-before-release", { configPath: FULL_MANIFEST, json: true });
    const parsed = JSON.parse(r.output);
    expect(parsed.name).toBe("dogfood-before-release");
    expect(parsed.requires.within).toBe("24h");
    expect(parsed.note).toContain("Phase 4");
  });
});

describe("explain — error handling", () => {
  it("throws HarnessExitError 64 when the named policy does not exist", () => {
    let caught: unknown;
    try {
      explain("does-not-exist", { configPath: FULL_MANIFEST });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
    expect(err.message).toMatch(/does-not-exist/);
    expect(err.message).toMatch(/review-before-merge/);
    expect(err.message).toMatch(/dogfood-before-release/);
  });

  it("reports `(none)` when a manifest has no policies declared", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-empty-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1\nhooks: []\npolicies: []\n`,
      "utf8",
    );
    let caught: unknown;
    try {
      explain("any-name", {
        homeDir: home,
        configPath: path.join(home, "harness.yaml"),
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
    expect(err.message).toMatch(/any-name/);
    expect(err.message).toMatch(/available: \(none\)/);
  });
});

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
