// Subprocess smoke tests for the built harness CLI binary (dist/cli/main.js).
//
// These tests spawn the REAL binary rather than calling run() in-process.
// This exercises the full entry path including the
// `HARNESS_ALLOW_REAL_GENERATED_DIR=1` assignment in src/cli/main.ts that
// only fires in an actual binary invocation, and ensures the dist/ artefact
// matches the expected surface (version string, exit codes).
//
// They complement the in-process tests in tests/cli/program.test.ts, which
// test CLI logic but cannot exercise the real binary entry point.
//
// Build prerequisite: dist/cli/main.js must be up-to-date. Run
// `npm run build` before this suite if you are iterating on CLI code.
//
// Home-dir isolation: --help, --version, and an unknown command do not
// load the harness manifest, so no HARNESS_HOME override is needed.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

// Read the expected version from package.json so the test stays correct
// across bumps without a manual update.
const PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

function spawn(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [MAIN_JS, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout as string,
    stderr: result.stderr as string,
  };
}

describe("CLI subprocess smoke — --help", () => {
  it("exits 0", () => {
    expect(spawn(["--help"]).status).toBe(0);
  });

  it("prints a Usage: banner to stdout", () => {
    expect(spawn(["--help"]).stdout).toMatch(/Usage:/);
  });

  it("produces no stderr output", () => {
    expect(spawn(["--help"]).stderr).toBe("");
  });
});

describe("CLI subprocess smoke — --version", () => {
  it("exits 0", () => {
    expect(spawn(["--version"]).status).toBe(0);
  });

  it("prints exactly the package.json version on stdout", () => {
    // The trim() strips the trailing newline Commander appends.
    expect(spawn(["--version"]).stdout.trim()).toBe(PKG_VERSION);
  });

  it("produces no stderr output", () => {
    expect(spawn(["--version"]).stderr).toBe("");
  });
});

describe("CLI subprocess smoke — unknown command", () => {
  it("exits 64 (EX_USAGE) for an unrecognised command", () => {
    expect(spawn(["totally-unknown-cmd-xyz"]).status).toBe(64);
  });

  it("emits an 'unknown command' message to stderr", () => {
    expect(spawn(["totally-unknown-cmd-xyz"]).stderr).toMatch(/unknown command/i);
  });

  it("produces no stdout output", () => {
    expect(spawn(["totally-unknown-cmd-xyz"]).stdout).toBe("");
  });
});
