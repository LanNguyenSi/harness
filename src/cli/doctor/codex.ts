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

import * as fs from "node:fs";
import * as path from "node:path";
import { expandPolicyPacks } from "../../policy-packs/index.js";
import type { Hook, Manifest } from "../../schema/index.js";

export type CodexCheckStatus = "ok" | "warn" | "error";

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
  /** Working directory used to resolve the persisted-report path. Defaults to cwd. */
  cwd?: string;
  /** Override for $PATH lookup (test injection). */
  pathEnv?: string;
  /** Override for path existence + executable check (test injection). */
  isExecutable?: (p: string) => boolean;
  /** Override for the `harness` binary location (test injection). */
  harnessBinary?: string;
}

const HARNESS_COMMAND_PREFIX = "harness ";
const REQUIRED_SUBCOMMANDS = [
  "harness pack hook codex-pre-tool-use",
  "harness pack hook codex-user-prompt-submit",
] as const;
const CODEX_CONFIG_RELPATH = path.join("harness.generated", "codex", "config.toml");
const REPORTS_RELPATH = path.join(".understanding-gate", "reports");

function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
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

function checkHarnessBinary(
  opts: Required<Pick<RunCodexCheckOptions, "pathEnv" | "isExecutable">>,
  override?: string,
): CodexCheckEntry {
  if (override !== undefined) {
    if (override === "" || !fs.existsSync(override) || !opts.isExecutable(override)) {
      return {
        name: "harness binary",
        status: "error",
        message: `harness binary override does not resolve: ${override}`,
      };
    }
    return {
      name: "harness binary",
      status: "ok",
      message: `resolved (override): ${override}`,
    };
  }
  const resolved = findOnPath("harness", opts.pathEnv, opts.isExecutable);
  if (!resolved) {
    return {
      name: "harness binary",
      status: "error",
      message:
        "`harness` not found on PATH; the codex-* subcommands cannot be invoked. Install harness globally or expose its bin via PATH.",
    };
  }
  return {
    name: "harness binary",
    status: "ok",
    message: `resolved: ${resolved}`,
  };
}

function checkSubcommandsAvailable(harnessOk: boolean): CodexCheckEntry {
  if (!harnessOk) {
    return {
      name: "codex-* subcommands",
      status: "error",
      message: `cannot verify ${REQUIRED_SUBCOMMANDS.join(", ")} until the harness binary resolves`,
    };
  }
  return {
    name: "codex-* subcommands",
    status: "ok",
    message: `subcommands assumed present (shipped with harness binary): ${REQUIRED_SUBCOMMANDS.join(", ")}`,
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

function checkReportsDir(cwd: string): CodexCheckEntry {
  const dir = path.join(cwd, REPORTS_RELPATH);
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
    target = cwd;
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
  const cwd = opts.cwd ?? process.cwd();

  const checks: CodexCheckEntry[] = [];
  const harnessCheck = checkHarnessBinary(
    { pathEnv, isExecutable },
    opts.harnessBinary,
  );
  checks.push(harnessCheck);
  checks.push(checkSubcommandsAvailable(harnessCheck.status === "ok"));
  checks.push(checkConfigToml(opts.manifestDir));
  checks.push(...checkHookCommands(manifest, pathEnv, isExecutable));
  checks.push(checkReportsDir(cwd));

  return { target: "codex", checks };
}

export function countCodexDiagnostics(
  report: CodexTargetReport,
): { errorCount: number; warningCount: number } {
  let errorCount = 0;
  let warningCount = 0;
  for (const c of report.checks) {
    if (c.status === "error") errorCount += 1;
    else if (c.status === "warn") warningCount += 1;
  }
  return { errorCount, warningCount };
}
