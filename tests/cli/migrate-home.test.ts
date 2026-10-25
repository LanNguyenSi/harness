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

    it("leaves a layer symlink that points at a top-level item in place while the item itself moves", () => {
      const { legacy } = seedLayers();
      fs.rmSync(path.join(legacy, machineRel));
      fs.symlinkSync(path.join("..", "harness.yaml"), path.join(legacy, machineRel));
      const { result } = run(true);
      expect(result.outcome).toBe("applied");
      expect(result.manual).toEqual([
        `move by hand: ${path.join(legacy, machineRel)} (symlink to ${path.join("..", "harness.yaml")})`,
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
      expect(fs.existsSync(path.join(newHome, machineRel))).toBe(true);
      expect(fs.existsSync(path.join(legacy, "harness.yaml"))).toBe(true);
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
