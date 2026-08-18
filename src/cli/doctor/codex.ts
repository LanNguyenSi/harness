// Phase 6 #6 follow-up — `harness doctor --target codex` checks.
//
// Validates the wiring shipped in Phase 6 #6: the harness CLI itself is
// reachable (so the `harness pack hook codex-*` subcommands resolve),
// the harness-generated `harness.generated/codex/config.toml` exists,
// every contributed `[[hooks.*]]` stanza references a command that
// resolves on PATH, and the persisted-report directory is writable.
//
// The checks here intentionally do NOT exercise the actual Codex CLI
// binary — that is a Codex-runtime concern, out of harness's scope.
// What this module guarantees is "the harness side of the integration
// is wired correctly"; whether Codex itself reads the emitted TOML is
// up to the operator's `~/.codex/config.toml` setup.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultReportsDir } from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { expandPolicyPacks } from "../../policy-packs/index.js";
import type { Hook, Manifest } from "../../schema/index.js";
import { VERSION as HARNESS_VERSION } from "../../version.js";
import { countStatusDiagnostics, type DoctorCheckStatus } from "./target-checks.js";

// LOW-F5 (batch18 fix-round, task f34eb233 review): re-exported for
// import-path compatibility -- see target-checks.ts's header for why
// these moved out of this file.
export { countStatusDiagnostics };
export type CodexCheckStatus = DoctorCheckStatus;

export interface CodexCheckEntry {
  name: string;
  status: CodexCheckStatus;
  message: string;
}

export interface CodexTargetReport {
  target: "codex";
  checks: CodexCheckEntry[];
}

export interface RunCodexCheckOptions {
  /** Manifest directory; the codex config is at <dir>/harness.generated/codex/config.toml. */
  manifestDir: string;
  /**
   * Pre-task-4f4a1178: working directory used to resolve the persisted-
   * report path. Retained for compat but ignored — the report dir is
   * now resolved via `defaultReportsDir(manifestDir)` so the doctor's
   * answer matches what apply bakes into the hook commands.
   */
  cwd?: string;
  /** Override for $PATH lookup (test injection). */
  pathEnv?: string;
  /** Override for path existence + executable check (test injection). */
  isExecutable?: (p: string) => boolean;
  /** Override for the `harness` binary location (test injection). */
  harnessBinary?: string;
  /**
   * Override for the `harness --version` probe. Returns null when the
   * probe could not run (binary missing, spawn error, non-zero exit).
   * Returns the trimmed stdout otherwise. Test injection only.
   */
  versionProbe?: (binary: string) => string | null;
}

const HARNESS_COMMAND_PREFIX = "harness ";
const CODEX_CONFIG_RELPATH = path.join("harness.generated", "codex", "config.toml");

function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `binary` against `pathEnv`: absolute paths resolve to themselves
 * (when they exist and are executable), everything else scans each `PATH`
 * segment. Exported (task 7f8fb4bc) so `doctor/index.ts`'s `checkCli` and
 * the lighter-weight `checkBinResolution` reuse this instead of a second,
 * near-identical copy (the check:duplication fitness function flags that).
 */
export function findOnPath(
  binary: string,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): string | null {
  if (path.isAbsolute(binary)) {
    return fs.existsSync(binary) && isExecutable(binary) ? binary : null;
  }
  for (const seg of pathEnv.split(path.delimiter)) {
    if (!seg) continue;
    const candidate = path.join(seg, binary);
    if (fs.existsSync(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveHookCommand(
  command: string,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): { resolved: string | null; firstToken: string } {
  const firstToken = command.trim().split(/\s+/)[0] ?? "";
  if (firstToken === "") return { resolved: null, firstToken };
  return {
    resolved: findOnPath(firstToken, pathEnv, isExecutable),
    firstToken,
  };
}

function resolveHarnessBinary(
  opts: Required<Pick<RunCodexCheckOptions, "pathEnv" | "isExecutable">>,
  override?: string,
): { entry: CodexCheckEntry; resolved: string | null } {
  if (override !== undefined) {
    if (override === "" || !fs.existsSync(override) || !opts.isExecutable(override)) {
      return {
        entry: {
          name: "harness binary",
          status: "error",
          message: `harness binary override does not resolve: ${override}`,
        },
        resolved: null,
      };
    }
    return {
      entry: {
        name: "harness binary",
        status: "ok",
        message: `resolved (override): ${override}`,
      },
      resolved: override,
    };
  }
  const resolved = findOnPath("harness", opts.pathEnv, opts.isExecutable);
  if (!resolved) {
    return {
      entry: {
        name: "harness binary",
        status: "error",
        message:
          "`harness` not found on PATH; the codex-* subcommands cannot be invoked. Install harness globally or expose its bin via PATH.",
      },
      resolved: null,
    };
  }
  return {
    entry: {
      name: "harness binary",
      status: "ok",
      message: `resolved: ${resolved}`,
    },
    resolved,
  };
}

// Phase 6 #6 ships in 0.7.0 (the version this module is shipped from).
// A stale `harness` on PATH from before Phase 6 #6 would resolve as a
// binary but reject the codex-* subcommands at runtime. The
// version-gate catches that.
const MIN_VERSION_WITH_CODEX_SUBCOMMANDS = "0.7.0";

function defaultVersionProbe(binary: string): string | null {
  try {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const aa = a.split(".").map((n) => Number.parseInt(n, 10));
  const bb = b.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const ai = aa[i] ?? 0;
    const bi = bb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

function checkSubcommandsAvailable(
  harnessBinaryPath: string | null,
  versionProbe: (binary: string) => string | null,
): CodexCheckEntry | null {
  // When the binary is missing the operator already gets a clear error
  // from `checkHarnessBinary`; emitting a second cascade-error here
  // would double-count in `errorCount` for one root cause. Skip
  // entirely.
  if (!harnessBinaryPath) {
    return null;
  }
  const stdout = versionProbe(harnessBinaryPath);
  if (stdout === null) {
    return {
      name: "codex-* subcommands",
      status: "warn",
      message: `\`${harnessBinaryPath} --version\` did not respond cleanly; cannot confirm the codex-* subcommands are wired (need >= ${MIN_VERSION_WITH_CODEX_SUBCOMMANDS})`,
    };
  }
  const m = stdout.match(/(\d+(?:\.\d+){0,3})/);
  if (!m || !m[1]) {
    return {
      name: "codex-* subcommands",
      status: "warn",
      message: `could not parse a version from "${stdout}"; cannot confirm the codex-* subcommands are wired`,
    };
  }
  const actual = m[1];
  if (compareSemver(actual, MIN_VERSION_WITH_CODEX_SUBCOMMANDS) < 0) {
    return {
      name: "codex-* subcommands",
      status: "error",
      message: `harness on PATH is v${actual}; codex-* subcommands require >= ${MIN_VERSION_WITH_CODEX_SUBCOMMANDS}. Update the harness install.`,
    };
  }
  // Sanity-check against the version this module is shipped from: if
  // the harness on PATH is markedly newer or older than the in-process
  // version, the operator probably has more than one harness install.
  // Not an error; just informative.
  const note =
    actual !== HARNESS_VERSION
      ? ` (in-process v${HARNESS_VERSION}; mismatch is harmless if intentional)`
      : "";
  return {
    name: "codex-* subcommands",
    status: "ok",
    message: `harness on PATH v${actual} >= ${MIN_VERSION_WITH_CODEX_SUBCOMMANDS}${note}`,
  };
}

function checkConfigToml(manifestDir: string): CodexCheckEntry {
  const target = path.join(manifestDir, CODEX_CONFIG_RELPATH);
  if (!fs.existsSync(target)) {
    return {
      name: "codex config artefact",
      status: "error",
      message: `${target} not found; run \`harness apply --runtime codex\` first`,
    };
  }
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (err) {
    return {
      name: "codex config artefact",
      status: "error",
      message: `cannot read ${target}: ${(err as Error).message}`,
    };
  }
  if (!content.includes("Generated by harness apply --runtime codex")) {
    return {
      name: "codex config artefact",
      status: "warn",
      message: `${target} exists but does not carry the harness-managed banner; was it hand-edited?`,
    };
  }
  return {
    name: "codex config artefact",
    status: "ok",
    message: `present: ${target}`,
  };
}

function codexHooksFromManifest(manifest: Manifest): Hook[] {
  const expansion = expandPolicyPacks(manifest, "codex");
  // The manifest's own hooks[] AND the codex-pack expansion both ship
  // into the generated TOML, so we check both.
  const all = [...manifest.hooks, ...expansion.hooks];
  return all;
}

function checkHookCommands(
  manifest: Manifest,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): CodexCheckEntry[] {
  const hooks = codexHooksFromManifest(manifest);
  if (hooks.length === 0) {
    return [
      {
        name: "codex hook commands",
        status: "warn",
        message: "no hooks contributed; codex config will be empty",
      },
    ];
  }
  const out: CodexCheckEntry[] = [];
  for (const h of hooks) {
    const { resolved, firstToken } = resolveHookCommand(h.command, pathEnv, isExecutable);
    if (firstToken === "") {
      out.push({
        name: `hook ${h.name}`,
        status: "error",
        message: "empty command after parsing",
      });
      continue;
    }
    // Bare `harness` subcommands resolve as long as the harness binary
    // does (already checked above); skip the per-hook PATH lookup for
    // them so the error tally doesn't double-count a missing harness.
    // Bare `harness <subcommand>` form: any operator-authored hook that
    // calls into the harness binary lands here, not just pack-contributed
    // ones. The harness-binary check above is the upstream gate; the
    // version-gate (`checkSubcommandsAvailable`) catches stale installs
    // that would reject the subcommand at runtime.
    if (h.command.startsWith(HARNESS_COMMAND_PREFIX)) {
      out.push({
        name: `hook ${h.name}`,
        status: "ok",
        message: `subcommand of harness: ${h.command}`,
      });
      continue;
    }
    if (!resolved) {
      out.push({
        name: `hook ${h.name}`,
        status: "error",
        message: `command first token "${firstToken}" not found on PATH (${h.command})`,
      });
      continue;
    }
    out.push({
      name: `hook ${h.name}`,
      status: "ok",
      message: `resolved: ${resolved}`,
    });
  }
  return out;
}

function checkReportsDir(manifestDir: string): CodexCheckEntry {
  // Use the same resolver the rest of the stack uses so the doctor's
  // reported path agrees with what the Stop hook, PreToolUse blocker
  // and `harness approve understanding` will actually touch:
  //   1. UNDERSTANDING_GATE_REPORT_DIR if set,
  //   2. manifest-anchored fallback otherwise.
  const dir = defaultReportsDir(manifestDir);
  // We do NOT require the directory to exist (a fresh project has no
  // reports yet). What we do require is that we can either create it
  // or write into it. Best-effort probe: if the parent is writable,
  // we are fine.
  const parent = path.dirname(dir);
  let target: string;
  if (fs.existsSync(dir)) {
    target = dir;
  } else if (fs.existsSync(parent)) {
    target = parent;
  } else {
    target = manifestDir;
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return {
      name: "persisted-report directory",
      status: "ok",
      message: fs.existsSync(dir)
        ? `${dir} writable`
        : `${dir} not present; ${target} is writable (the directory is created on first report)`,
    };
  } catch {
    return {
      name: "persisted-report directory",
      status: "warn",
      message: `cannot write to ${target}; the Stop-equivalent (when shipped) will fail to capture reports`,
    };
  }
}

export function runCodexTargetChecks(
  manifest: Manifest,
  opts: RunCodexCheckOptions,
): CodexTargetReport {
  const pathEnv = opts.pathEnv ?? process.env["PATH"] ?? "";
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const versionProbe = opts.versionProbe ?? defaultVersionProbe;

  const checks: CodexCheckEntry[] = [];
  const harnessResult = resolveHarnessBinary(
    { pathEnv, isExecutable },
    opts.harnessBinary,
  );
  checks.push(harnessResult.entry);
  const subcmdEntry = checkSubcommandsAvailable(harnessResult.resolved, versionProbe);
  if (subcmdEntry !== null) checks.push(subcmdEntry);
  checks.push(checkConfigToml(opts.manifestDir));
  checks.push(...checkHookCommands(manifest, pathEnv, isExecutable));
  checks.push(checkReportsDir(opts.manifestDir));

  return { target: "codex", checks };
}

export function countCodexDiagnostics(
  report: CodexTargetReport,
): { errorCount: number; warningCount: number } {
  return countStatusDiagnostics(report.checks);
}
