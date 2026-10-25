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
  });
});
