// Hermetic config dirs (vitest setupFile).
//
// A family of tests reads the operator's real Claude config, either directly
// or transitively: `resolveClaudeUserRegistryPath`/`resolveMcpConfigDirOverride`
// fall back to `$CLAUDE_CONFIG_DIR/.claude.json` then `~/.claude.json`, and the
// harness CLI, when spawned with `env: { ...process.env }`, inherits both
// `CLAUDE_CONFIG_DIR` and `HOME` from the developer's shell. That makes the
// suite's result depend on the machine it runs on: with `CLAUDE_CONFIG_DIR`
// pointed at a directory that does not exist, tests that were reading the real
// config take a different branch and fail.
//
// This setup file removes that dependency for the WHOLE suite, once, at the
// same point in the lifecycle the sibling `hermetic-spawn-allowlist.ts` uses
// (a vitest `setupFile`, evaluated before each test file imports its graph), so
// by the time any test or `src/` module reads either variable it is already
// neutralised:
//
//   * `CLAUDE_CONFIG_DIR` is deleted outright. An inherited value must never
//     reach a test process or a child spawned from one with `...process.env`.
//   * `HOME` is pointed at a fresh, empty directory created under `os.tmpdir()`.
//     `os.homedir()` reads `$HOME` on POSIX, so this also redirects every
//     `~/.claude`/`~/.harness` fallback the code probes. It is NOT merely
//     deleted: an unset `HOME` makes `os.homedir()` fall back to the passwd
//     entry and silently read the real home again, which is exactly what we are
//     removing.
//
// Precedence. setupFiles finish loading (and running their top-level side
// effects) before the test file is imported, and a test's own body / beforeEach
// runs after that. So a test that deliberately sets `process.env.HOME` or
// `process.env.CLAUDE_CONFIG_DIR` itself sets it AFTER this file and wins for
// that test, the tests that exercise the `CLAUDE_CONFIG_DIR` seam or a temp
// home on purpose (adopt, doctor-claude-mcp, claude-mcp real-spawn, program,
// apply-codex, generated-dir) keep working unchanged. This file only clears the
// ambient, inherited value; it never overwrites one a test set.
//
// One temp directory per test process. `hermetic-spawn-allowlist.ts` documents
// that vitest reuses a worker process across files (forks pool) while re-
// evaluating each setupFile per file, so a `HOME` a test deleted and never
// restored would otherwise leak into a later file in the same worker. The
// directory path is therefore stashed in a sentinel env var and the home is
// re-asserted from it on every evaluation, creating a fresh directory only once
// per process (and only if the stashed one is gone). Nothing in the suite
// writes into the ambient `$HOME`, every test that needs a writable home does
// so through its own `homeDir`/`HARNESS_HOME`/`homeOverride` seam, so the
// shared directory stays empty and cannot couple two files.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// An inherited `$CLAUDE_CONFIG_DIR` must never be observed by a test or leaked
// into a `spawn(..., { env: { ...process.env } })` child. Deleting here is safe
// because a test that wants the variable sets it itself, later, and wins.
delete process.env.CLAUDE_CONFIG_DIR;

// Sentinel holding this process's hermetic home, so every per-file re-evaluation
// of this setup file reuses one directory and re-asserts `HOME` from it.
const HERMETIC_HOME_ENV = "HARNESS_HERMETIC_TEST_HOME";

function ensureHermeticHome(): string {
  const existing = process.env[HERMETIC_HOME_ENV];
  if (existing !== undefined) {
    try {
      // Reuse it only while it is still an existing directory: a test (or the
      // OS) that removed it must not leave `HOME` dangling.
      if (fs.statSync(existing).isDirectory()) return existing;
    } catch {
      // Stale sentinel (directory gone), fall through and recreate.
    }
  }
  // `fs.mkdtempSync` under `os.tmpdir()` is fine here: it runs inside the test
  // process, not an operator shell, and the result is a throwaway fixture dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-home-"));
  process.env[HERMETIC_HOME_ENV] = dir;
  return dir;
}

process.env.HOME = ensureHermeticHome();
