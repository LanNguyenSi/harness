import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HARNESS_HOME_DIRNAME,
  HARNESS_HOME_ENV,
  LEGACY_HARNESS_HOME_DIRNAME,
  _resetLegacyWarningForTests,
  resolveHomeDir,
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

let savedEnv: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-home-dir-"));
  savedEnv = process.env[HARNESS_HOME_ENV];
  delete process.env[HARNESS_HOME_ENV];
  _resetLegacyWarningForTests();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[HARNESS_HOME_ENV];
  else process.env[HARNESS_HOME_ENV] = savedEnv;
});

describe("resolveHomeDir — precedence", () => {
  it("tier 1: explicit homeDir wins", () => {
    const explicit = path.join(tmp, "explicit");
    fs.mkdirSync(explicit, { recursive: true });
    fs.mkdirSync(path.join(tmp, HARNESS_HOME_DIRNAME), { recursive: true });
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.generated"), {
      recursive: true,
    });
    process.env[HARNESS_HOME_ENV] = path.join(tmp, "from-env");
    const result = resolveHomeDir({ homeDir: explicit, userHome: tmp });
    expect(result.path).toBe(explicit);
    expect(result.source).toBe("explicit");
  });

  it("tier 2: $HARNESS_HOME env wins when explicit is unset", () => {
    const envHome = path.join(tmp, "from-env");
    process.env[HARNESS_HOME_ENV] = envHome;
    fs.mkdirSync(path.join(tmp, HARNESS_HOME_DIRNAME), { recursive: true });
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.generated"), {
      recursive: true,
    });
    const result = resolveHomeDir({ userHome: tmp });
    expect(result.path).toBe(envHome);
    expect(result.source).toBe("env");
  });

  it("tier 3: existing ~/.harness/ wins over legacy ~/.claude/", () => {
    fs.mkdirSync(path.join(tmp, HARNESS_HOME_DIRNAME), { recursive: true });
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.generated"), {
      recursive: true,
    });
    const result = resolveHomeDir({ userHome: tmp });
    expect(result.path).toBe(path.join(tmp, HARNESS_HOME_DIRNAME));
    expect(result.source).toBe("new");
  });

  it("tier 4: falls back to ~/.claude/ when ~/.harness/ does not exist and legacy has harness.yaml", () => {
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.yaml"),
      "version: 1\n",
    );
    const stderr = bufferStream();
    const result = resolveHomeDir({ userHome: tmp, stderr: stderr.stream });
    expect(result.path).toBe(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME));
    expect(result.source).toBe("legacy");
    expect(stderr.read()).toMatch(/state still under legacy.*harness migrate-home/);
  });

  it("tier 4: falls back to ~/.claude/ when only harness.generated/ exists there", () => {
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.generated"), {
      recursive: true,
    });
    const result = resolveHomeDir({ userHome: tmp, stderr: bufferStream().stream });
    expect(result.source).toBe("legacy");
  });

  it("tier 4: deprecation warning fires at most once per process", () => {
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "harness.yaml"),
      "version: 1\n",
    );
    const stderr = bufferStream();
    resolveHomeDir({ userHome: tmp, stderr: stderr.stream });
    resolveHomeDir({ userHome: tmp, stderr: stderr.stream });
    resolveHomeDir({ userHome: tmp, stderr: stderr.stream });
    const lines = stderr.read().split("\n").filter((l) => l.includes("state still under legacy"));
    expect(lines).toHaveLength(1);
  });

  it("tier 4: a bare ~/.claude/ without harness state is NOT claimed (would clobber Claude Code's config)", () => {
    // Empty legacy dir or one containing only Claude Code's settings.json
    // must not trigger the legacy fallback, otherwise harness would write
    // its state into a runtime config dir it does not own.
    fs.mkdirSync(path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, LEGACY_HARNESS_HOME_DIRNAME, "settings.json"),
      "{}",
    );
    const result = resolveHomeDir({ userHome: tmp });
    expect(result.source).toBe("default-new");
    expect(result.path).toBe(path.join(tmp, HARNESS_HOME_DIRNAME));
  });

  it("tier 5: create-on-first-use target is ~/.harness/ when nothing exists yet", () => {
    // Neither ~/.harness/ nor ~/.claude/ exists. The resolver returns the
    // ~/.harness/ path without creating it; the caller is responsible for
    // mkdir + writes.
    const result = resolveHomeDir({ userHome: tmp });
    expect(result.path).toBe(path.join(tmp, HARNESS_HOME_DIRNAME));
    expect(result.source).toBe("default-new");
    expect(fs.existsSync(path.join(tmp, HARNESS_HOME_DIRNAME))).toBe(false);
  });

  it("env value beats existing-on-disk: $HARNESS_HOME=/somewhere/else is honored even when ~/.harness/ exists", () => {
    fs.mkdirSync(path.join(tmp, HARNESS_HOME_DIRNAME), { recursive: true });
    const envHome = path.join(tmp, "elsewhere");
    process.env[HARNESS_HOME_ENV] = envHome;
    const result = resolveHomeDir({ userHome: tmp });
    expect(result.path).toBe(envHome);
    expect(result.source).toBe("env");
  });
});
