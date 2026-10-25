import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives the built CLI against a scratch HOME so the exit-code mapping of
// `harness migrate-home` is pinned end to end. Needs `npm run build` first.
const MAIN = path.resolve(__dirname, "..", "..", "dist", "cli", "main.js");

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-migrate-exit-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function cli(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: home };
  const r = spawnSync(process.execPath, [MAIN, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

function seed(): string {
  const legacy = path.join(home, ".claude");
  fs.mkdirSync(path.join(legacy, "machines"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "harness.yaml"), "version: 1\n");
  fs.writeFileSync(path.join(legacy, "machines", "default.harness.overrides.yaml"), "version: 1\n");
  return legacy;
}

describe("harness migrate-home exit code", () => {
  it("exits 0 on a clean --apply", () => {
    seed();
    expect(cli(["migrate-home", "--apply"]).status).toBe(0);
  });

  it("exits non-zero with a re-run hint on a partial run, and 0 after the fix", () => {
    const legacy = seed();
    fs.mkdirSync(path.join(home, ".harness"), { recursive: true });
    fs.writeFileSync(path.join(home, ".harness", "machines"), "file, not a dir");
    const bad = cli(["migrate-home", "--apply"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/re-run `harness migrate-home --apply`/);
    expect(fs.existsSync(path.join(legacy, "harness.yaml"))).toBe(true);
    fs.rmSync(path.join(home, ".harness", "machines"));
    expect(cli(["migrate-home", "--apply"]).status).toBe(0);
    expect(fs.existsSync(path.join(home, ".harness", "machines", "default.harness.overrides.yaml"))).toBe(true);
  });

  it("exits non-zero when a layer must be moved by hand", () => {
    const legacy = seed();
    fs.rmSync(path.join(legacy, "machines"), { recursive: true });
    const real = path.join(home, "dotfiles", "machines");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "default.harness.overrides.yaml"), "version: 1\n");
    fs.symlinkSync(real, path.join(legacy, "machines"));
    const r = cli(["migrate-home", "--apply"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/move by hand/);
    expect(fs.existsSync(path.join(real, "default.harness.overrides.yaml"))).toBe(true);
  });
});
