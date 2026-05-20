// Runtime-neutral harness home-dir resolver.
//
// The harness's operator-state root was historically hardcoded to
// `~/.claude/`. Phase 6 #6 added Codex as a first-class runtime
// (task e65decef); the `.claude/` naming became misleading for
// Codex-only operators who never installed Claude Code. v0.24.0
// introduces `~/.harness/` as the runtime-neutral root, with a
// legacy fallback to `~/.claude/` so existing v0.23.x installs
// continue to work.
//
// Resolution precedence:
//   1. Explicit `homeDir` parameter (test injection, `--home` flag).
//   2. `$HARNESS_HOME` env var (pin without flag).
//   3. `~/.harness/` if it exists on disk.
//   4. `~/.claude/` if the legacy `harness.generated/` directory or
//      `harness.yaml` manifest exists there (legacy fallback with
//      one-shot stderr deprecation warning per process).
//   5. `~/.harness/` as the create-on-first-use target.
//
// The legacy fallback warning fires at most ONCE per process. Multiple
// callers (manifest load, apply, doctor, …) resolve through the same
// helper; a per-call warning would be noise. The warning text names
// the `harness migrate-home` command so the operator has an explicit
// next step.
//
// Subdirectory names are unchanged from the v0.23.x layout: a fresh
// `~/.harness/` install contains the same `harness.yaml`,
// `harness.generated/`, `.understanding-gate/`, `harness.lock`
// children that the legacy `~/.claude/` install would have. This
// keeps the migration `mv`-only and avoids cascading file-rename
// churn across every test fixture.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const HARNESS_HOME_DIRNAME = ".harness";
export const LEGACY_HARNESS_HOME_DIRNAME = ".claude";
export const HARNESS_HOME_ENV = "HARNESS_HOME";

/**
 * Per-process flag for the deprecation warning. Resolvers re-enter many
 * times in a single command (loader, apply, doctor, hook commands).
 * Without a singleton the warning would fan out to dozens of lines and
 * obscure real output.
 */
let warnedLegacy = false;

export interface ResolveHomeDirOptions {
  /**
   * Explicit override. Tests inject a tmp dir here; the CLI passes the
   * `--home` flag value when set.
   */
  homeDir?: string;
  /**
   * Stream to write the legacy-fallback deprecation warning to. Defaults
   * to `process.stderr`. Tests can capture by passing a buffer-backed
   * Writable.
   */
  stderr?: NodeJS.WritableStream;
  /**
   * Test injection: override `os.homedir()`. The `homeDir` field is for
   * an explicit harness state-root; this is for the operator's `$HOME`
   * which the new + legacy preferred-existence checks anchor on.
   */
  userHome?: string;
}

export interface HomeDirResolution {
  /** Resolved harness state-root directory. */
  path: string;
  /**
   * Which precedence tier won. `legacy` indicates the deprecation
   * warning fired (or would have, had it not already fired this
   * process).
   */
  source: "explicit" | "env" | "new" | "legacy" | "default-new";
}

export function resolveHomeDir(opts: ResolveHomeDirOptions = {}): HomeDirResolution {
  if (typeof opts.homeDir === "string" && opts.homeDir.length > 0) {
    return { path: opts.homeDir, source: "explicit" };
  }

  const envValue = process.env[HARNESS_HOME_ENV];
  if (typeof envValue === "string" && envValue.length > 0) {
    return { path: envValue, source: "env" };
  }

  const userHome = opts.userHome ?? os.homedir();
  const newPath = path.join(userHome, HARNESS_HOME_DIRNAME);
  const legacyPath = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);

  if (existsDir(newPath)) {
    return { path: newPath, source: "new" };
  }

  // Legacy fallback: only honor when the legacy dir carries actual
  // harness state. A bare `~/.claude/` without `harness.yaml` or
  // `harness.generated/` is somebody else's directory (Claude Code's
  // runtime config) and we must not write into it.
  if (legacyHasHarnessState(legacyPath)) {
    if (!warnedLegacy) {
      const stderr = opts.stderr ?? process.stderr;
      stderr.write(
        `harness: state still under legacy ${legacyPath}/; run \`harness migrate-home\` to move it to ${newPath}/. The legacy fallback will be removed in a future release.\n`,
      );
      warnedLegacy = true;
    }
    return { path: legacyPath, source: "legacy" };
  }

  return { path: newPath, source: "default-new" };
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function legacyHasHarnessState(legacyPath: string): boolean {
  // The legacy dir is shared with Claude Code's `settings.json`. We
  // claim "harness lives here" only when one of the harness-owned
  // artefacts exists: the manifest (`harness.yaml`) or the generated
  // dir (`harness.generated/`). Either is sufficient evidence.
  try {
    if (fs.existsSync(path.join(legacyPath, "harness.yaml"))) return true;
    if (fs.existsSync(path.join(legacyPath, "harness.generated"))) return true;
  } catch {
    /* fall through to false */
  }
  return false;
}

/**
 * Reset the per-process warning flag. Test-only — production code never
 * needs to clear this. Exported so vitest's `beforeEach` can isolate
 * test cases without leaking warning state between them.
 */
export function _resetLegacyWarningForTests(): void {
  warnedLegacy = false;
}
