// E2E subprocess tests for `harness pack hook pre-tool-use`.
//
// Spawns the REAL built CLI (dist/cli/main.js) as a child process to verify
// the complete hook entry path — manifest load, pack lookup, decision, stdout
// decision envelope — without mocking internals.
//
// Home-dir isolation: we pass `--config <tmpdir>/harness.yaml` AND set
// HARNESS_HOME to a tmp path. `--config` only overrides the base manifest path;
// the loader still resolves the machine/project override layers under the
// harness home (resolveHomeDir honors $HARNESS_HOME before any disk lookup), so
// without HARNESS_HOME a real ~/.harness/machines override could merge into the
// planted manifest and change the decision. With both set, the child reads and
// writes only under the tmp dir, never the operator's real ~/.harness/.
//
// Deterministic allow path: the planted harness.yaml declares NO
// policy_packs[], so the hook allows with "pack not declared in manifest,
// allowing." before it ever reaches the ledger or approval-marker checks.
// This gives a zero-dependency, fast, reproducible assertion.
//
// Why subprocess (not in-process): main.ts sets
// HARNESS_ALLOW_REAL_GENERATED_DIR=1 before importing. Running the module
// in-process inside vitest would skip that assignment and trip the
// resolvePaths() isolation guard. A subprocess gets a clean module state.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

// Minimal valid harness.yaml with NO policy_packs declared.
// Hook will allow immediately with "pack not declared in manifest, allowing."
const MANIFEST_NO_PACKS = `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-hook-e2e-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runHook(
  configPath: string,
  stdinPayload: string,
): { status: number | null; stdout: string; stderr: string } {
  // Strip session-id env vars so the test controls which code path the hook
  // takes (otherwise the dev host's $CLAUDE_CODE_SESSION_ID could influence
  // the decision for a pack-declared manifest).
  const childEnv = { ...process.env };
  delete childEnv["CLAUDE_CODE_SESSION_ID"];
  delete childEnv["CLAUDE_SESSION_ID"];
  // Pin the harness home under the tmp dir so the machine/project override
  // layers cannot resolve against the operator's real ~/.harness/.
  childEnv["HARNESS_HOME"] = path.join(tmpDir, "home");

  const result = spawnSync(
    "node",
    [MAIN_JS, "pack", "hook", "pre-tool-use", "--config", configPath],
    {
      input: stdinPayload,
      encoding: "utf8",
      timeout: 15_000,
      env: childEnv,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout as string,
    stderr: result.stderr as string,
  };
}

describe("pack hook pre-tool-use — subprocess E2E (allow path)", () => {
  it("exits 0 with empty stdout when the pack is not declared in the manifest", () => {
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_NO_PACKS, "utf8");

    const event = JSON.stringify({
      session_id: "sess-hook-e2e-1",
      tool_name: "Edit",
      tool_input: { file_path: "/some/file.ts", old_string: "x", new_string: "y" },
    });

    const { status, stdout, stderr } = runHook(configPath, event);

    expect(status).toBe(0);
    // Allow path: hook writes nothing to stdout (only block/ask emit JSON)
    expect(stdout.trim()).toBe("");
    // The hook always writes a diagnostic line to stderr
    expect(stderr).toContain("not declared in manifest");
  });

  it("exits 0 with empty stdout on malformed stdin JSON (fail-open contract)", () => {
    // When stdin is not valid JSON, the hook falls through to allow rather
    // than erroring, so a broken event injector never hard-blocks the session.
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_NO_PACKS, "utf8");

    const { status, stdout, stderr } = runHook(configPath, "{not valid json}");

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
    // Loud degradation: the fail-open path must announce why on stderr, so a
    // silent-swallow regression is caught.
    expect(stderr).toContain("malformed event JSON on stdin");
  });

  it("exits 0 with empty stdout on empty stdin", () => {
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_NO_PACKS, "utf8");

    const { status, stdout } = runHook(configPath, "");

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
