import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATION_MARKER_BASENAME,
  migrateHome,
} from "../../src/cli/migrate-home/index.js";
import {
  HARNESS_HOME_DIRNAME,
  LEGACY_HARNESS_HOME_DIRNAME,
} from "../../src/runtime/home-dir.js";

let tmp: string;

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

/** Every path under `root` with its type, permission bits and content or link target. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      const st = fs.lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out.push(`l ${rel} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.push(`d ${rel} ${mode}`);
        walk(p);
      } else out.push(`f ${rel} ${mode} ${fs.readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return out;
}

function seedLegacyState(tmp: string): {
  legacy: string;
  manifestPath: string;
  generatedDir: string;
  reportsDir: string;
  lockPath: string;
} {
  const legacy = path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME);
  const manifestPath = path.join(legacy, "harness.yaml");
  const generatedDir = path.join(legacy, "harness.generated");
  const reportsDir = path.join(legacy, ".understanding-gate", "reports");
  const lockPath = path.join(legacy, "harness.lock");

  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(manifestPath, "version: 1\n");
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(
    path.join(generatedDir, "settings.json"),
    '{"hooks":{}}\n',
  );
  fs.writeFileSync(path.join(generatedDir, ".pending-approval"), "sess-1");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, "rpt.json"),
    '{"sessionId":"sess-1","approvalStatus":"pending"}\n',
  );
  fs.writeFileSync(lockPath, "[]\n");

  // Operator-owned content we must NOT touch.
  fs.writeFileSync(path.join(legacy, "settings.json"), '{"foo":"bar"}\n');

  return { legacy, manifestPath, generatedDir, reportsDir, lockPath };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-migrate-home-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migrateHome", () => {
  it("dry-run reports what would move and writes nothing", () => {
    const seed = seedLegacyState(tmp);
    const stdout = bufferStream();
    const result = migrateHome({
      userHome: tmp,
      stdout: stdout.stream,
      stderr: bufferStream().stream,
    });
    expect(result.outcome).toBe("would-apply");
    const moves = result.items.filter((i) => i.action === "would-move");
    expect(moves.map((m) => m.basename).sort()).toEqual(
      ["harness.yaml", "harness.generated", ".understanding-gate", "harness.lock"].sort(),
    );
    expect(stdout.read()).toMatch(/would move 4 item\(s\)/);
    // No-op disk side: nothing under ~/.harness/ yet.
    expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME))).toBe(false);
    // Legacy state untouched.
    expect(fs.existsSync(seed.manifestPath)).toBe(true);
    expect(fs.existsSync(seed.generatedDir)).toBe(true);
    expect(fs.existsSync(seed.reportsDir)).toBe(true);
    expect(fs.existsSync(seed.lockPath)).toBe(true);
  });

  it("--apply moves all four items into ~/.harness/ and leaves a breadcrumb", () => {
    const seed = seedLegacyState(tmp);
    const result = migrateHome({
      apply: true,
      userHome: tmp,
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
    });
    expect(result.outcome).toBe("applied");

    const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
    expect(fs.existsSync(path.join(newHome, "harness.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(newHome, "harness.generated", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(newHome, "harness.generated", ".pending-approval"))).toBe(true);
    expect(
      fs.existsSync(path.join(newHome, ".understanding-gate", "reports", "rpt.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(newHome, "harness.lock"))).toBe(true);

    // Legacy side: harness state removed.
    expect(fs.existsSync(seed.manifestPath)).toBe(false);
    expect(fs.existsSync(seed.generatedDir)).toBe(false);
    expect(fs.existsSync(path.join(seed.legacy, ".understanding-gate"))).toBe(false);
    expect(fs.existsSync(seed.lockPath)).toBe(false);

    // Operator-owned content under ~/.claude/ must NOT be touched.
    expect(fs.existsSync(path.join(seed.legacy, "settings.json"))).toBe(true);
    expect(fs.readFileSync(path.join(seed.legacy, "settings.json"), "utf8")).toBe(
      '{"foo":"bar"}\n',
    );

    // Breadcrumb present.
    expect(result.markerPath).toBe(path.join(seed.legacy, MIGRATION_MARKER_BASENAME));
    expect(fs.existsSync(result.markerPath!)).toBe(true);
    const marker = fs.readFileSync(result.markerPath!, "utf8");
    expect(marker).toContain("harness state was migrated");
    expect(marker).toContain(newHome);
  });

  it("preserves nested file contents byte-for-byte across the move", () => {
    seedLegacyState(tmp);
    migrateHome({
      apply: true,
      userHome: tmp,
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
    });
    const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
    expect(
      fs.readFileSync(path.join(newHome, "harness.generated", "settings.json"), "utf8"),
    ).toBe('{"hooks":{}}\n');
    expect(
      fs.readFileSync(
        path.join(newHome, ".understanding-gate", "reports", "rpt.json"),
        "utf8",
      ),
    ).toBe('{"sessionId":"sess-1","approvalStatus":"pending"}\n');
    expect(fs.readFileSync(path.join(newHome, "harness.lock"), "utf8")).toBe("[]\n");
  });

  it("re-running on already-migrated state is a clean no-op", () => {
    seedLegacyState(tmp);
    migrateHome({
      apply: true,
      userHome: tmp,
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
    });
    const stdout = bufferStream();
    const result = migrateHome({
      apply: true,
      userHome: tmp,
      stdout: stdout.stream,
      stderr: bufferStream().stream,
    });
    expect(result.outcome).toBe("no-op");
    expect(stdout.read()).toMatch(/nothing to migrate/);
  });

  it("refuses to overwrite when the same item already exists at the new path", () => {
    seedLegacyState(tmp);
    const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
    fs.mkdirSync(newHome, { recursive: true });
    fs.writeFileSync(path.join(newHome, "harness.yaml"), "version: 2\n");
    const stderr = bufferStream();
    const result = migrateHome({
      apply: true,
      userHome: tmp,
      stdout: bufferStream().stream,
      stderr: stderr.stream,
    });
    expect(result.outcome).toBe("target-conflict");
    expect(stderr.read()).toMatch(/already present.*refuse to overwrite/);
    // Source side untouched on conflict.
    expect(fs.readFileSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.yaml"), "utf8")).toBe(
      "version: 1\n",
    );
  });

  it("returns no-op when there is no legacy state to migrate (fresh ~/.harness/ install)", () => {
    fs.mkdirSync(path.join(tmp, HARNESS_HOME_DIRNAME), { recursive: true });
    const stdout = bufferStream();
    const result = migrateHome({
      userHome: tmp,
      stdout: stdout.stream,
      stderr: bufferStream().stream,
    });
    expect(result.outcome).toBe("no-op");
  });

  it("handles a partially-migrated legacy state (some items moved, others still at legacy)", () => {
    // Operator ran --apply earlier but the run failed midway and left two
    // items in ~/.claude/ and two in ~/.harness/. The re-run should move
    // the remaining two without touching the existing.
    const seed = seedLegacyState(tmp);
    const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
    fs.mkdirSync(newHome, { recursive: true });
    // Pretend harness.yaml + harness.lock already moved.
    fs.renameSync(seed.manifestPath, path.join(newHome, "harness.yaml"));
    fs.renameSync(seed.lockPath, path.join(newHome, "harness.lock"));
    const result = migrateHome({
      apply: true,
      userHome: tmp,
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
    });
    expect(result.outcome).toBe("applied");
    // All four end up in the new home.
    expect(fs.existsSync(path.join(newHome, "harness.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(newHome, "harness.lock"))).toBe(true);
    expect(fs.existsSync(path.join(newHome, "harness.generated"))).toBe(true);
    expect(fs.existsSync(path.join(newHome, ".understanding-gate"))).toBe(true);
  });
  describe("override layers", () => {
    const machineRel = path.join("machines", "default.harness.overrides.yaml");
    const projectRel = path.join("projects", "acme", "harness.overrides.yaml");

    function seedLayers(): { legacy: string } {
      const { legacy } = seedLegacyState(tmp);
      fs.mkdirSync(path.join(legacy, "machines"), { recursive: true });
      fs.writeFileSync(path.join(legacy, machineRel), "version: 1\n# machine\n");
      fs.mkdirSync(path.join(legacy, "projects", "acme"), { recursive: true });
      fs.writeFileSync(path.join(legacy, projectRel), "version: 1\n# project\n");
      return { legacy };
    }

    function run(apply: boolean) {
      const stdout = bufferStream();
      const stderr = bufferStream();
      const result = migrateHome({
        apply,
        userHome: tmp,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      return { result, stdout: stdout.read(), stderr: stderr.read() };
    }

    it("dry-run lists the machine and project layers and moves nothing", () => {
      const { legacy } = seedLayers();
      const { result, stdout } = run(false);
      expect(result.outcome).toBe("would-apply");
      expect(stdout).toContain(path.join(legacy, machineRel));
      expect(stdout).toContain(path.join(legacy, projectRel));
      expect(fs.existsSync(path.join(legacy, machineRel))).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, machineRel))).toBe(false);
    });

    it("--apply moves a machine layer byte-for-byte and prunes the emptied machines/ dir", () => {
      const { legacy } = seedLayers();
      const { result } = run(true);
      expect(result.outcome).toBe("applied");
      const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
      expect(fs.readFileSync(dst, "utf8")).toBe("version: 1\n# machine\n");
      expect(fs.existsSync(path.join(legacy, machineRel))).toBe(false);
      expect(fs.existsSync(path.join(legacy, "machines"))).toBe(false);
    });

    it("--apply moves a project layer byte-for-byte and prunes the emptied project dirs", () => {
      const { legacy } = seedLayers();
      const { result } = run(true);
      expect(result.outcome).toBe("applied");
      const dst = path.join(tmp, HARNESS_HOME_DIRNAME, projectRel);
      expect(fs.readFileSync(dst, "utf8")).toBe("version: 1\n# project\n");
      expect(fs.existsSync(path.join(legacy, "projects"))).toBe(false);
    });

    it("leaves Claude Code's own files under ~/.claude/projects/ and machines/ alone", () => {
      const { legacy } = seedLayers();
      const transcript = path.join(legacy, "projects", "acme", "session.jsonl");
      fs.writeFileSync(transcript, "{}\n");
      const otherProject = path.join(legacy, "projects", "-Users-me-repo");
      fs.mkdirSync(otherProject, { recursive: true });
      fs.writeFileSync(path.join(otherProject, "x.jsonl"), "{}\n");
      fs.writeFileSync(path.join(legacy, "machines", "notes.txt"), "keep\n");
      run(true);
      expect(fs.existsSync(transcript)).toBe(true);
      expect(fs.existsSync(path.join(otherProject, "x.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(legacy, "machines", "notes.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, "projects", "-Users-me-repo"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, projectRel))).toBe(true);
    });

    it("refuses to overwrite an existing machine layer at the new path and moves nothing", () => {
      const { legacy } = seedLayers();
      const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, "version: 1\n# existing\n");
      const { result, stderr } = run(true);
      expect(result.outcome).toBe("target-conflict");
      expect(stderr).toMatch(/default\.harness\.overrides\.yaml.*refuse to overwrite/);
      expect(fs.readFileSync(dst, "utf8")).toBe("version: 1\n# existing\n");
      expect(fs.existsSync(path.join(legacy, machineRel))).toBe(true);
      expect(fs.existsSync(path.join(legacy, "harness.yaml"))).toBe(true);
    });

    it("refuses to overwrite an existing project layer at the new path and moves nothing", () => {
      const { legacy } = seedLayers();
      const dst = path.join(tmp, HARNESS_HOME_DIRNAME, projectRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, "version: 1\n# existing\n");
      const { result, stderr } = run(true);
      expect(result.outcome).toBe("target-conflict");
      expect(stderr).toMatch(/harness\.overrides\.yaml.*refuse to overwrite/);
      expect(fs.readFileSync(dst, "utf8")).toBe("version: 1\n# existing\n");
      expect(fs.existsSync(path.join(legacy, projectRel))).toBe(true);
    });

    it("skips a project directory whose name the loader would refuse", () => {
      const { legacy } = seedLayers();
      const bad = path.join(legacy, "projects", "a\u0001b");
      fs.mkdirSync(bad, { recursive: true });
      fs.writeFileSync(path.join(bad, "harness.overrides.yaml"), "version: 1\n");
      run(true);
      expect(fs.existsSync(path.join(bad, "harness.overrides.yaml"))).toBe(true);
    });

    it("moves layers when no top-level item is left (layers-only partial re-run)", () => {
      const { legacy } = seedLayers();
      const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(newHome, { recursive: true });
      for (const f of ["harness.yaml", "harness.lock"]) {
        fs.renameSync(path.join(legacy, f), path.join(newHome, f));
      }
      fs.renameSync(path.join(legacy, "harness.generated"), path.join(newHome, "harness.generated"));
      fs.renameSync(path.join(legacy, ".understanding-gate"), path.join(newHome, ".understanding-gate"));
      const { result } = run(true);
      expect(result.outcome).toBe("applied");
      expect(fs.existsSync(path.join(newHome, machineRel))).toBe(true);
      expect(fs.existsSync(path.join(newHome, projectRel))).toBe(true);
    });
    it("reports a machine layer and a project layer that are symlinks as move-by-hand and leaves both links alone", () => {
      const { legacy } = seedLayers();
      const ext = path.join(tmp, "ext");
      fs.mkdirSync(ext, { recursive: true });
      fs.writeFileSync(path.join(ext, "m.yaml"), "version: 1\n# linked machine\n");
      fs.writeFileSync(path.join(ext, "p.yaml"), "version: 1\n# linked project\n");
      fs.rmSync(path.join(legacy, machineRel));
      fs.rmSync(path.join(legacy, projectRel));
      // relative target that would resolve identically from ~/.claude and ~/.harness
      const relTarget = path.join("..", "..", "ext", "m.yaml");
      fs.symlinkSync(relTarget, path.join(legacy, machineRel));
      fs.symlinkSync(path.join(ext, "p.yaml"), path.join(legacy, projectRel));
      const { result, stderr } = run(true);
      expect(result.outcome).toBe("applied");
      expect(result.manual).toEqual([
        `move by hand: ${path.join(legacy, machineRel)} (symlink to ${relTarget})`,
        `move by hand: ${path.join(legacy, projectRel)} (symlink to ${path.join(ext, "p.yaml")})`,
      ]);
      expect(stderr).toContain(`move by hand: ${path.join(legacy, machineRel)} (symlink to ${relTarget})`);
      expect(fs.readlinkSync(path.join(legacy, machineRel))).toBe(relTarget);
      expect(fs.readlinkSync(path.join(legacy, projectRel))).toBe(path.join(ext, "p.yaml"));
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, machineRel))).toBe(false);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, projectRel))).toBe(false);
      expect(fs.readFileSync(path.join(ext, "m.yaml"), "utf8")).toContain("linked machine");
      expect(fs.readFileSync(path.join(ext, "p.yaml"), "utf8")).toContain("linked project");
      // the regular items still moved
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, "harness.yaml"))).toBe(true);
    });

    it("does not move a bare .harness.overrides.yaml in machines/", () => {
      const { legacy } = seedLayers();
      const bare = path.join(legacy, "machines", ".harness.overrides.yaml");
      fs.writeFileSync(bare, "version: 1\n");
      run(true);
      expect(fs.existsSync(bare)).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, "machines", ".harness.overrides.yaml"))).toBe(false);
    });

    it("skips a machine layer whose file name carries a control character, and never prints it raw", () => {
      const { legacy } = seedLayers();
      const bad = path.join(legacy, "machines", "a\u001b[31mb.harness.overrides.yaml");
      fs.writeFileSync(bad, "version: 1\n");
      const dry = run(false);
      const applied = run(true);
      expect(fs.existsSync(bad)).toBe(true);
      const all = dry.stdout + dry.stderr + applied.stdout + applied.stderr;
      expect(all).not.toMatch(/\u001b/);
      expect(fs.readFileSync(path.join(legacy, MIGRATION_MARKER_BASENAME), "utf8")).not.toMatch(/\u001b/);
    });

    it("reports a symlinked project directory as move-by-hand and removes nothing", () => {
      const { legacy } = seedLayers();
      const real = path.join(tmp, "dotfiles", "acme");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "harness.overrides.yaml"), "version: 1\n# real\n");
      fs.rmSync(path.join(legacy, "projects"), { recursive: true });
      fs.mkdirSync(path.join(legacy, "projects"));
      fs.symlinkSync(real, path.join(legacy, "projects", "acme"));
      const { result, stderr } = run(true);
      expect(result.manual).toEqual([
        `move by hand: ${path.join(legacy, "projects", "acme")} (symlink to ${real})`,
      ]);
      expect(stderr).toContain(`move by hand: ${path.join(legacy, "projects", "acme")} (symlink to ${real})`);
      expect(fs.readFileSync(path.join(real, "harness.overrides.yaml"), "utf8")).toContain("# real");
      expect(fs.lstatSync(path.join(legacy, "projects", "acme")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, projectRel))).toBe(false);
    });

    it("reports a symlinked machines/ directory as move-by-hand and removes nothing from its target", () => {
      const { legacy } = seedLayers();
      const real = path.join(tmp, "dotfiles", "machines");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "default.harness.overrides.yaml"), "version: 1\n# real\n");
      fs.rmSync(path.join(legacy, "machines"), { recursive: true });
      fs.symlinkSync(real, path.join(legacy, "machines"));
      const { result, stderr } = run(true);
      expect(result.manual).toEqual([`move by hand: ${path.join(legacy, "machines")} (symlink to ${real})`]);
      expect(stderr).toContain(`move by hand: ${path.join(legacy, "machines")} (symlink to ${real})`);
      expect(fs.existsSync(path.join(real, "default.harness.overrides.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, machineRel))).toBe(false);
    });

    it("reports a symlinked projects/ directory as move-by-hand and removes nothing from its target", () => {
      const { legacy } = seedLayers();
      const real = path.join(tmp, "dotfiles", "projects");
      fs.mkdirSync(path.join(real, "acme"), { recursive: true });
      fs.writeFileSync(path.join(real, "acme", "harness.overrides.yaml"), "version: 1\n# real\n");
      fs.rmSync(path.join(legacy, "projects"), { recursive: true });
      fs.symlinkSync(real, path.join(legacy, "projects"));
      const { result } = run(true);
      expect(result.manual).toEqual([`move by hand: ${path.join(legacy, "projects")} (symlink to ${real})`]);
      expect(fs.existsSync(path.join(real, "acme", "harness.overrides.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, projectRel))).toBe(false);
    });

    it("reports a layer symlink with a relative target as move-by-hand and moves the other layers", () => {
      const { legacy } = seedLayers();
      fs.mkdirSync(path.join(legacy, "shared"), { recursive: true });
      fs.writeFileSync(path.join(legacy, "shared", "m.yaml"), "version: 1\n");
      fs.rmSync(path.join(legacy, machineRel));
      fs.symlinkSync(path.join("..", "shared", "m.yaml"), path.join(legacy, machineRel));
      const { result, stderr } = run(true);
      expect(result.manual).toHaveLength(1);
      expect(stderr).toMatch(/move by hand: .*default\.harness\.overrides\.yaml \(symlink to \.\.\/shared\/m\.yaml\)/);
      expect(fs.lstatSync(path.join(legacy, machineRel)).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, machineRel))).toBe(false);
      // the project layer still moved
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, projectRel))).toBe(true);
    });

    it("leaves a layer symlink that points at a top-level item in place while the item itself moves, and says where the item now lives", () => {
      const { legacy } = seedLayers();
      fs.rmSync(path.join(legacy, machineRel));
      fs.symlinkSync(path.join("..", "harness.yaml"), path.join(legacy, machineRel));
      const { result } = run(true);
      expect(result.outcome).toBe("applied");
      expect(result.manual).toEqual([
        `move by hand: ${path.join(legacy, machineRel)} (symlink to ${path.join("..", "harness.yaml")}; that target now lives at ${path.join(tmp, HARNESS_HOME_DIRNAME, "harness.yaml")})`,
      ]);
      expect(fs.lstatSync(path.join(legacy, machineRel)).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME, machineRel))).toBe(false);
      expect(fs.readFileSync(path.join(tmp, HARNESS_HOME_DIRNAME, "harness.yaml"), "utf8")).toBe("version: 1\n");
    });

    it("moves layers before harness.yaml and rolls back when a layer move fails", () => {
      const { legacy } = seedLayers();
      const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(newHome, { recursive: true });
      fs.writeFileSync(path.join(newHome, "machines"), "not a directory");
      const { result, stderr } = run(true);
      expect(result.outcome).toBe("rolled-back");
      expect(stderr).toMatch(/failed to move machines\/default/);
      expect(stderr).toMatch(/nothing was changed/);
      expect(fs.existsSync(path.join(legacy, "harness.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(newHome, "harness.yaml"))).toBe(false);
      // ~/.harness existed before the run, so the rollback keeps it
      expect(fs.readFileSync(path.join(newHome, "machines"), "utf8")).toBe("not a directory");
      expect(fs.existsSync(path.join(legacy, MIGRATION_MARKER_BASENAME))).toBe(false);
      // recovery: fix the error, re-run
      fs.rmSync(path.join(newHome, "machines"));
      const again = run(true);
      expect(again.result.outcome).toBe("applied");
      expect(fs.existsSync(path.join(newHome, "harness.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(newHome, machineRel))).toBe(true);
      expect(fs.existsSync(path.join(newHome, projectRel))).toBe(true);
    });

    it("rolls back an earlier layer move when a later layer fails, removing only the directories it created", () => {
      const { legacy } = seedLayers();
      const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(newHome, { recursive: true });
      fs.writeFileSync(path.join(newHome, "projects"), "not a directory");
      const { result, stdout, stderr } = run(true);
      expect(result.outcome).toBe("rolled-back");
      expect(stdout).toContain(`moved ${path.join(legacy, machineRel)}`);
      expect(stderr).toMatch(/failed to move projects\/acme\/harness\.overrides\.yaml/);
      expect(fs.readFileSync(path.join(legacy, machineRel), "utf8")).toBe("version: 1\n# machine\n");
      expect(fs.existsSync(path.join(newHome, "machines"))).toBe(false);
      expect(fs.readFileSync(path.join(newHome, "projects"), "utf8")).toBe("not a directory");
      expect(fs.existsSync(newHome)).toBe(true);
    });

    describe.skipIf(process.getuid?.() === 0)("with an unwritable legacy directory", () => {
      const locked: string[] = [];
      function lock(dir: string): void {
        fs.chmodSync(dir, 0o555);
        locked.push(dir);
      }
      afterEach(() => {
        for (const dir of locked.splice(0)) fs.chmodSync(dir, 0o755);
      });

      it("rolls back a genuine mid-run failure with no ~/.harness beforehand: the tree is unchanged", () => {
        const { legacy } = seedLayers();
        fs.writeFileSync(path.join(legacy, "projects", "acme", "session.jsonl"), "{}\n");
        lock(path.join(legacy, "projects", "acme"));
        const before = snapshot(tmp);
        const { result, stdout, stderr } = run(true);
        expect(result.outcome).toBe("rolled-back");
        // the machine layer really moved before the project layer failed
        expect(stdout).toContain(`moved ${path.join(legacy, machineRel)}`);
        expect(stderr).toMatch(/failed to move projects\/acme\/harness\.overrides\.yaml/);
        expect(stderr).toMatch(/nothing was changed/);
        expect(snapshot(tmp)).toEqual(before);
        expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME))).toBe(false);
      });

      it("keeps a failure after harness.yaml moved as partial and says what is where", () => {
        const { legacy } = seedLayers();
        const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
        lock(path.join(legacy, "harness.generated"));
        const { result, stderr } = run(true);
        expect(result.outcome).toBe("partial");
        expect(stderr).toMatch(/failed to move harness\.generated/);
        expect(stderr).toContain(
          `now under ${newHome}: machines/default.harness.overrides.yaml, projects/acme/harness.overrides.yaml, harness.yaml`,
        );
        expect(stderr).toContain(`still under ${legacy}: harness.generated, .understanding-gate, harness.lock`);
        expect(stderr).not.toMatch(/nothing was changed/);
        expect(fs.existsSync(path.join(newHome, "harness.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(legacy, "harness.generated"))).toBe(true);
        expect(fs.existsSync(path.join(legacy, MIGRATION_MARKER_BASENAME))).toBe(true);
        // recovery: fix the error, re-run
        for (const dir of locked.splice(0)) fs.chmodSync(dir, 0o755);
        expect(run(true).result.outcome).toBe("applied");
        expect(fs.existsSync(path.join(newHome, "harness.generated", "settings.json"))).toBe(true);
      });
    });

    it("reports a rollback step that fails, with what is where, instead of claiming nothing changed", () => {
      const { legacy } = seedLayers();
      const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
      const stdout = bufferStream();
      const stderr = bufferStream();
      const result = migrateHome({
        apply: true,
        userHome: tmp,
        stdout: stdout.stream,
        stderr: stderr.stream,
        move: (src, dst) => {
          if (src.startsWith(newHome + path.sep)) throw new Error("injected: cannot move back");
          if (src.includes(`${path.sep}projects${path.sep}`)) throw new Error("injected: project layer");
          fs.renameSync(src, dst);
        },
      });
      const err = stderr.read();
      expect(result.outcome).toBe("partial");
      expect(err).toContain(
        `ROLLBACK FAILED: could not move ${path.join(newHome, machineRel)} back to ${path.join(legacy, machineRel)}: injected: cannot move back`,
      );
      expect(err).toMatch(/ROLLBACK FAILED: could not remove .*\.harness.*which this run created/);
      expect(err).toContain(`now under ${newHome}: machines/default.harness.overrides.yaml`);
      expect(err).toContain(`still under ${legacy}: projects/acme/harness.overrides.yaml, harness.yaml`);
      expect(err).not.toMatch(/nothing was changed/);
      // ~/.harness/ is left without harness.yaml: say that harness reads it now, and how to recover
      expect(err).toContain(
        `harness now reads ${newHome}, which has no harness.yaml, so it does not find your manifest under ${legacy}; to recover, move machines/default.harness.overrides.yaml from ${newHome} back to ${legacy}, then remove ${newHome}, which this run created, and re-run \`harness migrate-home --apply\`.`,
      );
      expect(fs.existsSync(path.join(newHome, machineRel))).toBe(true);
      expect(fs.existsSync(path.join(legacy, "harness.yaml"))).toBe(true);
    });

    describe("after a rollback that fails, the line about which root harness reads", () => {
      /** The project layer's move leaves a stray file in its new directory and fails, so that directory cannot be removed. */
      function strayOnProjectMove(newHome: string, failBack: boolean) {
        const stdout = bufferStream();
        const stderr = bufferStream();
        const result = migrateHome({
          apply: true,
          userHome: tmp,
          stdout: stdout.stream,
          stderr: stderr.stream,
          move: (src, dst) => {
            if (src.startsWith(newHome + path.sep)) {
              if (failBack) throw new Error("injected: cannot move back");
            } else if (src.includes(`${path.sep}projects${path.sep}`)) {
              fs.writeFileSync(path.join(path.dirname(dst), "stray"), "x");
              throw new Error("injected: project layer");
            }
            fs.renameSync(src, dst);
          },
        });
        return { result, err: stderr.read() };
      }

      it("only suggests removing ~/.harness when nothing is left under it and this run created it", () => {
        const { legacy } = seedLayers();
        const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
        const { result, err } = strayOnProjectMove(newHome, false);
        expect(result.outcome).toBe("partial");
        expect(err).toMatch(/ROLLBACK FAILED: could not remove .*projects.*acme/);
        expect(err).toContain(
          `harness now reads ${newHome}, which has no harness.yaml, so it does not find your manifest under ${legacy}; to recover, remove ${newHome}, which this run created, and re-run \`harness migrate-home --apply\`.`,
        );
        expect(fs.readFileSync(path.join(legacy, machineRel), "utf8")).toBe("version: 1\n# machine\n");
      });

      it("never suggests removing a ~/.harness that existed before the run", () => {
        const { legacy } = seedLayers();
        const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
        fs.mkdirSync(newHome);
        const backFails = strayOnProjectMove(newHome, true);
        expect(backFails.result.outcome).toBe("partial");
        expect(backFails.err).toContain(
          `harness now reads ${newHome}, which has no harness.yaml, so it does not find your manifest under ${legacy}; to recover, move machines/default.harness.overrides.yaml from ${newHome} back to ${legacy}, and re-run \`harness migrate-home --apply\`.`,
        );
        expect(backFails.err).not.toMatch(/which this run created, and re-run/);
      });

      it("adds no such line when the run left nothing under a ~/.harness that existed before", () => {
        seedLayers();
        const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
        fs.mkdirSync(newHome);
        const { result, err } = strayOnProjectMove(newHome, false);
        expect(result.outcome).toBe("partial");
        expect(err).toMatch(/ROLLBACK FAILED/);
        expect(err).not.toMatch(/harness now reads/);
      });

      it("adds no such line when a move back fails after it moved and the run left no ~/.harness behind", () => {
        const { legacy } = seedLayers();
        const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
        const stderr = bufferStream();
        const result = migrateHome({
          apply: true,
          userHome: tmp,
          stdout: bufferStream().stream,
          stderr: stderr.stream,
          move: (src, dst) => {
            if (src.startsWith(newHome + path.sep)) {
              // the move back happens, then reports a failure anyway
              fs.renameSync(src, dst);
              throw new Error("injected: move back reported failure after it moved");
            }
            if (src.includes(`${path.sep}projects${path.sep}`)) throw new Error("injected: project layer");
            fs.renameSync(src, dst);
          },
        });
        const err = stderr.read();
        expect(result.outcome).toBe("partial");
        expect(err).toContain(
          `ROLLBACK FAILED: could not move ${path.join(newHome, machineRel)} back to ${path.join(legacy, machineRel)}: injected: move back reported failure after it moved`,
        );
        // every directory the run created was empty again and removed, ~/.harness included
        expect(fs.existsSync(newHome)).toBe(false);
        expect(fs.readFileSync(path.join(legacy, machineRel), "utf8")).toBe("version: 1\n# machine\n");
        // harness still reads ~/.claude, so there is no stranded root to report
        expect(err).not.toMatch(/harness now reads/);
      });
    });

    it("treats a symlinked project directory whose layer already exists under ~/.harness as done", () => {
      const { legacy } = seedLayers();
      const real = path.join(tmp, "dotfiles", "acme");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "harness.overrides.yaml"), "version: 1\n# real\n");
      fs.rmSync(path.join(legacy, "projects", "acme"), { recursive: true });
      fs.symlinkSync(real, path.join(legacy, "projects", "acme"));
      expect(run(true).result.manual).toHaveLength(1);
      // the operator copies the layer to its destination
      const dst = path.join(tmp, HARNESS_HOME_DIRNAME, projectRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(real, "harness.overrides.yaml"), dst);
      const again = run(true);
      expect(again.result.outcome).toBe("no-op");
      expect(again.result.manual).toEqual([]);
      const done = `already at ${path.join(tmp, HARNESS_HOME_DIRNAME, "projects", "acme")}; remove the legacy ${path.join(legacy, "projects", "acme")} when you no longer need it`;
      expect(again.result.manualDone).toEqual([done]);
      expect(again.stdout).toContain(done);
      expect(again.stderr).not.toMatch(/move by hand/);
      // a link at the destination counts too
      fs.rmSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(real, path.dirname(dst));
      expect(run(true).result.manual).toEqual([]);
    });

    it("treats a symlinked layer file whose destination exists as done, and a missing one as open", () => {
      const { legacy } = seedLayers();
      const ext = path.join(tmp, "ext", "m.yaml");
      fs.mkdirSync(path.dirname(ext), { recursive: true });
      fs.writeFileSync(ext, "version: 1\n");
      fs.rmSync(path.join(legacy, machineRel));
      fs.symlinkSync(ext, path.join(legacy, machineRel));
      const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(ext, dst);
      const { result } = run(false);
      expect(result.manual).toEqual([]);
      expect(result.manualDone).toEqual([
        `already at ${dst}; remove the legacy ${path.join(legacy, machineRel)} when you no longer need it`,
      ]);
      fs.rmSync(dst);
      expect(run(false).result.manual).toHaveLength(1);
    });

    describe("a destination that exists but does not resolve to a regular file", () => {
      const notAFile = (p: string): string =>
        `${p} exists but does not resolve to a file, so harness cannot read it as a layer; replace it with the layer file or a link that resolves to it`;

      it("keeps the item open when the destination is a dangling link (a relative legacy target copied verbatim)", () => {
        const { legacy } = seedLayers();
        fs.mkdirSync(path.join(legacy, "shared"), { recursive: true });
        fs.writeFileSync(path.join(legacy, "shared", "m.yaml"), "version: 1\n");
        fs.rmSync(path.join(legacy, machineRel));
        const rel = path.join("..", "shared", "m.yaml");
        fs.symlinkSync(rel, path.join(legacy, machineRel));
        expect(run(true).result.manual).toHaveLength(1);
        const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(rel, dst);
        const { result, stderr } = run(true);
        expect(result.manual).toEqual([`move by hand: ${path.join(legacy, machineRel)} (symlink to ${rel})`, notAFile(dst)]);
        expect(result.manualDone).toEqual([]);
        expect(stderr).toContain(`harness migrate-home: ${notAFile(dst)}\n`);
        // the hint asks for a link that resolves, not a verbatim copy of the link text
        expect(stderr).toContain("(copy the file, or a link that resolves to the same file)");
      });

      it("keeps the item open when the destination links to an old target inside an item the run moved", () => {
        const { legacy } = seedLayers();
        const oldTarget = path.join(legacy, "harness.generated", "p.yaml");
        fs.writeFileSync(oldTarget, "version: 1\n");
        fs.rmSync(path.join(legacy, projectRel));
        fs.symlinkSync(oldTarget, path.join(legacy, projectRel));
        const first = run(true);
        const newTarget = path.join(tmp, HARNESS_HOME_DIRNAME, "harness.generated", "p.yaml");
        expect(first.result.manual).toEqual([
          `move by hand: ${path.join(legacy, projectRel)} (symlink to ${oldTarget}; that target now lives at ${newTarget})`,
        ]);
        expect(fs.readFileSync(newTarget, "utf8")).toBe("version: 1\n");
        const dst = path.join(tmp, HARNESS_HOME_DIRNAME, projectRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(oldTarget, dst);
        const { result } = run(true);
        // nothing moves on this run, so the line no longer claims a move
        expect(result.manual).toEqual([`move by hand: ${path.join(legacy, projectRel)} (symlink to ${oldTarget})`, notAFile(dst)]);
        fs.rmSync(dst);
        fs.symlinkSync(newTarget, dst);
        const fixed = run(true);
        expect(fixed.result.manual).toEqual([]);
        expect(fixed.result.manualDone).toHaveLength(1);
      });

      it("keeps the item open when the destination is a directory", () => {
        const { legacy } = seedLayers();
        const ext = path.join(tmp, "ext", "m.yaml");
        fs.mkdirSync(path.dirname(ext), { recursive: true });
        fs.writeFileSync(ext, "version: 1\n");
        fs.rmSync(path.join(legacy, machineRel));
        fs.symlinkSync(ext, path.join(legacy, machineRel));
        const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
        fs.mkdirSync(dst, { recursive: true });
        const { result } = run(false);
        expect(result.manual).toEqual([`move by hand: ${path.join(legacy, machineRel)} (symlink to ${ext})`, notAFile(dst)]);
        expect(result.manualDone).toEqual([]);
      });

      it.skipIf(process.platform === "win32")(
        "keeps the item open when the destination is a FIFO, and --apply still leaves it open",
        (ctx) => {
          const { legacy } = seedLayers();
          const ext = path.join(tmp, "ext", "m.yaml");
          fs.mkdirSync(path.dirname(ext), { recursive: true });
          fs.writeFileSync(ext, "version: 1\n");
          fs.rmSync(path.join(legacy, machineRel));
          fs.symlinkSync(ext, path.join(legacy, machineRel));
          const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          try {
            execFileSync("mkfifo", [dst]);
          } catch {
            ctx.skip("mkfifo is not available");
          }
          expect(fs.lstatSync(dst).isFIFO()).toBe(true);
          const open = [`move by hand: ${path.join(legacy, machineRel)} (symlink to ${ext})`, notAFile(dst)];
          const dry = run(false);
          expect(dry.result.outcome).toBe("would-apply");
          expect(dry.result.manual).toEqual(open);
          expect(dry.result.manualDone).toEqual([]);
          const applied = run(true);
          expect(applied.result.outcome).toBe("applied");
          // a non-empty `manual` after --apply is what makes the CLI exit non-zero
          expect(applied.result.manual).toEqual(open);
          expect(applied.result.manualDone).toEqual([]);
          expect(applied.stderr).toContain(`harness migrate-home: ${notAFile(dst)}\n`);
          expect(applied.stdout).not.toMatch(/already at/);
          expect(fs.lstatSync(dst).isFIFO()).toBe(true);
        },
      );

      it("adds a line for each destination layer of a linked machines/ that does not resolve, and none for one that is missing", () => {
        const { legacy } = seedLayers();
        const real = path.join(tmp, "dotfiles", "machines");
        fs.mkdirSync(real, { recursive: true });
        fs.writeFileSync(path.join(real, "a.harness.overrides.yaml"), "version: 1\n");
        fs.writeFileSync(path.join(real, "b.harness.overrides.yaml"), "version: 1\n");
        fs.writeFileSync(path.join(real, "c.harness.overrides.yaml"), "version: 1\n");
        fs.rmSync(path.join(legacy, "machines"), { recursive: true });
        fs.symlinkSync(real, path.join(legacy, "machines"));
        const newMachines = path.join(tmp, HARNESS_HOME_DIRNAME, "machines");
        fs.mkdirSync(path.join(newMachines, "a.harness.overrides.yaml"), { recursive: true });
        fs.copyFileSync(path.join(real, "b.harness.overrides.yaml"), path.join(newMachines, "b.harness.overrides.yaml"));
        const { result } = run(false);
        expect(result.manual).toEqual([
          `move by hand: ${path.join(legacy, "machines")} (symlink to ${real})`,
          notAFile(path.join(newMachines, "a.harness.overrides.yaml")),
        ]);
      });
    });

    it("says where a link's target now lives when it points at another layer the run moved", () => {
      const { legacy } = seedLayers();
      const mini = path.join(legacy, "machines", "mini.harness.overrides.yaml");
      fs.writeFileSync(mini, "version: 1\n# mini\n");
      fs.rmSync(path.join(legacy, machineRel));
      fs.symlinkSync(mini, path.join(legacy, machineRel));
      const { result, stderr } = run(true);
      expect(result.outcome).toBe("applied");
      const line = `move by hand: ${path.join(legacy, machineRel)} (symlink to ${mini}; that target now lives at ${path.join(tmp, HARNESS_HOME_DIRNAME, "machines", "mini.harness.overrides.yaml")})`;
      expect(result.manual).toEqual([line]);
      expect(stderr).toContain(line);
    });

    it("does not claim a link's target moved when the run was rolled back", () => {
      const { legacy } = seedLayers();
      const mini = path.join(legacy, "machines", "mini.harness.overrides.yaml");
      fs.writeFileSync(mini, "version: 1\n# mini\n");
      fs.rmSync(path.join(legacy, machineRel));
      fs.symlinkSync(mini, path.join(legacy, machineRel));
      const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(newHome, { recursive: true });
      fs.writeFileSync(path.join(newHome, "projects"), "not a directory");
      const { result, stdout } = run(true);
      expect(result.outcome).toBe("rolled-back");
      expect(stdout).toContain(`moved ${mini}`);
      expect(result.manual).toEqual([`move by hand: ${path.join(legacy, machineRel)} (symlink to ${mini})`]);
    });

    it("never suggests removing a linked ~/.claude/projects or machines/ once their layers are at ~/.harness", () => {
      const { legacy } = seedLayers();
      const vol = path.join(tmp, "vol");
      fs.mkdirSync(path.join(vol, "projects", "acme"), { recursive: true });
      fs.writeFileSync(path.join(vol, "projects", "acme", "harness.overrides.yaml"), "version: 1\n");
      fs.writeFileSync(path.join(vol, "projects", "acme", "session.jsonl"), "{}\n");
      fs.mkdirSync(path.join(vol, "machines"), { recursive: true });
      fs.writeFileSync(path.join(vol, "machines", "default.harness.overrides.yaml"), "version: 1\n");
      fs.rmSync(path.join(legacy, "projects"), { recursive: true });
      fs.rmSync(path.join(legacy, "machines"), { recursive: true });
      fs.symlinkSync(path.join(vol, "projects"), path.join(legacy, "projects"));
      fs.symlinkSync(path.join(vol, "machines"), path.join(legacy, "machines"));
      const newHome = path.join(tmp, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(path.join(newHome, "projects", "acme"), { recursive: true });
      fs.copyFileSync(path.join(vol, "projects", "acme", "harness.overrides.yaml"), path.join(newHome, projectRel));
      fs.mkdirSync(path.join(newHome, "machines"), { recursive: true });
      fs.copyFileSync(path.join(vol, "machines", "default.harness.overrides.yaml"), path.join(newHome, machineRel));
      const { result, stdout } = run(false);
      expect(result.manual).toEqual([]);
      expect(result.manualDone).toEqual([
        `already at ${path.join(newHome, "machines")}; harness no longer reads the legacy ${path.join(legacy, "machines")}`,
        `already at ${path.join(newHome, "projects")}; keep the legacy ${path.join(legacy, "projects")}: Claude Code uses it for its session transcripts`,
      ]);
      expect(stdout).not.toMatch(/remove the legacy/);
    });

    describe("a done destination that still resolves through the legacy link", () => {
      const viaLegacy = (dst: string, legacyPath: string): string =>
        `already at ${dst}, which still reads through the legacy ${legacyPath}; keep it, or replace ${dst} with a copy or a link to the real target`;

      it("says so for a layer-file destination that links to the legacy layer link, absolute or relative, and never suggests removing it", () => {
        const { legacy } = seedLayers();
        const ext = path.join(tmp, "ext", "m.yaml");
        fs.mkdirSync(path.dirname(ext), { recursive: true });
        fs.writeFileSync(ext, "version: 1\n");
        const legacyLink = path.join(legacy, machineRel);
        fs.rmSync(legacyLink);
        fs.symlinkSync(ext, legacyLink);
        const dst = path.join(tmp, HARNESS_HOME_DIRNAME, machineRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(legacyLink, dst);
        const { result, stdout, stderr } = run(true);
        expect(result.outcome).toBe("applied");
        // harness does read the layer through the chain, so the item is done
        expect(result.manual).toEqual([]);
        expect(result.manualDone).toEqual([viaLegacy(dst, legacyLink)]);
        expect(stdout).toContain(`harness migrate-home: ${viaLegacy(dst, legacyLink)}\n`);
        expect(stdout).not.toMatch(/remove the legacy/);
        expect(stderr).not.toMatch(/move by hand/);
        // a relative link to the legacy link reads through it too
        fs.rmSync(dst);
        fs.symlinkSync(path.relative(path.dirname(dst), legacyLink), dst);
        expect(run(false).result.manualDone).toEqual([viaLegacy(dst, legacyLink)]);
        // control: a link straight to the real file gets the plain note
        fs.rmSync(dst);
        fs.symlinkSync(ext, dst);
        expect(run(false).result.manualDone).toEqual([
          `already at ${dst}; remove the legacy ${legacyLink} when you no longer need it`,
        ]);
      });

      it("says so for a ~/.harness/machines that links to the linked legacy machines/", () => {
        const { legacy } = seedLayers();
        const real = path.join(tmp, "dot", "machines");
        fs.mkdirSync(real, { recursive: true });
        fs.writeFileSync(path.join(real, "default.harness.overrides.yaml"), "version: 1\n");
        const legacyMachines = path.join(legacy, "machines");
        fs.rmSync(legacyMachines, { recursive: true });
        fs.symlinkSync(real, legacyMachines);
        expect(run(true).result.manual).toHaveLength(1);
        const newMachines = path.join(tmp, HARNESS_HOME_DIRNAME, "machines");
        fs.symlinkSync(legacyMachines, newMachines);
        const { result, stdout } = run(true);
        expect(result.outcome).toBe("no-op");
        expect(result.manual).toEqual([]);
        expect(result.manualDone).toEqual([viaLegacy(newMachines, legacyMachines)]);
        expect(stdout).toContain(viaLegacy(newMachines, legacyMachines));
        expect(stdout).not.toMatch(/harness no longer reads/);
        // control: a link straight to the real directory gets the plain note
        fs.rmSync(newMachines);
        fs.symlinkSync(real, newMachines);
        expect(run(false).result.manualDone).toEqual([
          `already at ${newMachines}; harness no longer reads the legacy ${legacyMachines}`,
        ]);
        expect(fs.readdirSync(real)).toEqual(["default.harness.overrides.yaml"]);
      });
    });

    it("keeps a symlinked machines/ open until every layer it holds exists under ~/.harness", () => {
      const { legacy } = seedLayers();
      const real = path.join(tmp, "dotfiles", "machines");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "default.harness.overrides.yaml"), "version: 1\n");
      fs.writeFileSync(path.join(real, "mini.harness.overrides.yaml"), "version: 1\n");
      fs.rmSync(path.join(legacy, "machines"), { recursive: true });
      fs.symlinkSync(real, path.join(legacy, "machines"));
      const newMachines = path.join(tmp, HARNESS_HOME_DIRNAME, "machines");
      fs.mkdirSync(newMachines, { recursive: true });
      fs.copyFileSync(path.join(real, "default.harness.overrides.yaml"), path.join(newMachines, "default.harness.overrides.yaml"));
      expect(run(false).result.manual).toEqual([`move by hand: ${path.join(legacy, "machines")} (symlink to ${real})`]);
      fs.copyFileSync(path.join(real, "mini.harness.overrides.yaml"), path.join(newMachines, "mini.harness.overrides.yaml"));
      const { result } = run(false);
      expect(result.manual).toEqual([]);
      expect(result.manualDone).toHaveLength(1);
      expect(fs.readdirSync(real).sort()).toEqual(["default.harness.overrides.yaml", "mini.harness.overrides.yaml"]);
    });

    it("never prunes the legacy root itself when a layer was its only content", () => {
      const legacy = path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME);
      fs.mkdirSync(path.join(legacy, "machines"), { recursive: true });
      fs.writeFileSync(path.join(legacy, machineRel), "version: 1\n");
      const { result } = run(true);
      expect(result.outcome).toBe("applied");
      expect(fs.existsSync(path.join(legacy, MIGRATION_MARKER_BASENAME))).toBe(true);
    });
  });
});
