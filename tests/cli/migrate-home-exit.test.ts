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

/** Every path under `root` with its type, permission bits and content or link target. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      const rel = `${path.relative(root, p)} ${(st.mode & 0o7777).toString(8)}`;
      if (st.isSymbolicLink()) out.push(`l ${rel} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.push(`d ${rel}`);
        walk(p);
      } else out.push(`f ${rel} ${fs.readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return out;
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

  it("exits non-zero with a re-run hint when a layer move fails and is undone, and 0 after the fix", () => {
    const legacy = seed();
    fs.mkdirSync(path.join(home, ".harness"), { recursive: true });
    fs.writeFileSync(path.join(home, ".harness", "machines"), "file, not a dir");
    const bad = cli(["migrate-home", "--apply"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/nothing was changed/);
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
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/move by hand/);
    expect(fs.existsSync(path.join(real, "default.harness.overrides.yaml"))).toBe(true);
    // the dry run reports the same item without failing
    expect(cli(["migrate-home"]).status).toBe(0);
  });

  it("exits 0 with an `already at` note once the move-by-hand layer exists under ~/.harness", () => {
    const legacy = seed();
    fs.rmSync(path.join(legacy, "machines"), { recursive: true });
    const real = path.join(home, "dotfiles", "machines");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "default.harness.overrides.yaml"), "version: 1\n");
    fs.symlinkSync(real, path.join(legacy, "machines"));
    expect(cli(["migrate-home", "--apply"]).status).toBe(1);
    fs.symlinkSync(real, path.join(home, ".harness", "machines"));
    const r = cli(["migrate-home", "--apply"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already at .*\.harness\/machines; remove the legacy .*\.claude\/machines when you no longer need it/);
    expect(r.stderr).not.toMatch(/move by hand/);
  });

  describe.skipIf(process.getuid?.() === 0)("with an unwritable legacy directory", () => {
    const locked: string[] = [];
    afterEach(() => {
      for (const dir of locked.splice(0)) fs.chmodSync(dir, 0o755);
    });

    it("exits 1 and leaves the tree as it was when a failure before harness.yaml is rolled back", () => {
      const legacy = seed();
      fs.mkdirSync(path.join(legacy, "projects", "acme"), { recursive: true });
      fs.writeFileSync(path.join(legacy, "projects", "acme", "harness.overrides.yaml"), "version: 1\n");
      fs.chmodSync(path.join(legacy, "projects", "acme"), 0o555);
      locked.push(path.join(legacy, "projects", "acme"));
      const before = tree(home);
      const r = cli(["migrate-home", "--apply"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/moved .*machines\/default\.harness\.overrides\.yaml/);
      expect(r.stderr).toMatch(/failed to move projects\/acme\/harness\.overrides\.yaml/);
      expect(r.stderr).toMatch(/nothing was changed/);
      expect(tree(home)).toEqual(before);
      expect(fs.existsSync(path.join(home, ".harness"))).toBe(false);
    });

    it("exits 1 and says what is where when a failure after harness.yaml leaves a partial state", () => {
      const legacy = seed();
      fs.mkdirSync(path.join(legacy, "harness.generated"));
      fs.writeFileSync(path.join(legacy, "harness.generated", "settings.json"), "{}\n");
      fs.chmodSync(path.join(legacy, "harness.generated"), 0o555);
      locked.push(path.join(legacy, "harness.generated"));
      const r = cli(["migrate-home", "--apply"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/now under .*\.harness: machines\/default\.harness\.overrides\.yaml, harness\.yaml/);
      expect(r.stderr).toMatch(/still under .*\.claude: harness\.generated/);
      expect(r.stderr).toMatch(/stopped part-way/);
      expect(fs.existsSync(path.join(home, ".harness", "harness.yaml"))).toBe(true);
    });
  });
});
