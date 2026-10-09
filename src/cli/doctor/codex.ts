// Phase 6 #6 follow-up — `harness doctor --target codex` checks.
//
// Validates the wiring shipped in Phase 6 #6: the harness CLI itself is
// reachable (so hook commands that invoke `harness` resolve),
// the harness-generated `harness.generated/codex/config.toml` exists,
// every contributed `[[hooks.*]]` stanza references a command that
// resolves on PATH.
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
import { invokesRemovedCommand, removedCommandMessage } from "../../schema/removed-keys.js";
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
  /**
   * The finding is already tallied by another doctor section (the manifest
   * warnings), so the target tally skips it. It still renders at its status.
   */
  countedElsewhere?: boolean;
}

export interface CodexTargetReport {
  target: "codex";
  checks: CodexCheckEntry[];
}

export interface RunCodexCheckOptions {
  /** Manifest directory; the codex config is at <dir>/harness.generated/codex/config.toml. */
  manifestDir: string;
  /** Retained for compat but ignored. */
  cwd?: string;
  /** Override for $PATH lookup (test injection). */
  pathEnv?: string;
  /** Override for path existence + executable check (test injection). */
  isExecutable?: (p: string) => boolean;
  /** Override for the `harness` binary location (test injection). */
  harnessBinary?: string;
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
          "`harness` not found on PATH; hook commands that invoke `harness` cannot run. Install harness globally or expose its bin via PATH.",
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

/**
 * `expansionHooks` are the hooks the codex pack expansion contributes; they
 * default to the real expansion and are a parameter so a test can feed one
 * that calls a removed verb.
 */
export function checkHookCommands(
  manifest: Manifest,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
  expansionHooks: Hook[] = expandPolicyPacks(manifest, "codex").hooks,
): CodexCheckEntry[] {
  const manifestHooks = new Set<Hook>(manifest.hooks);
  const hooks = [...manifest.hooks, ...expansionHooks];
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
    // A hook that calls a removed verb fails at runtime with "unknown
    // command", so it must not pass as a healthy harness subcommand below.
    const removed = invokesRemovedCommand(h.command);
    if (removed !== undefined) {
      // A manifest hook is already a manifest warning (hooks[].command), and
      // doctor counts each site once: this line stays non-ok but is not
      // tallied again. A pack-expansion hook has no manifest site, so its
      // warning is the only one and is counted.
      const fromManifest = manifestHooks.has(h);
      out.push({
        name: `hook ${h.name}`,
        status: "warn",
        message:
          removedCommandMessage(
            removed,
            `delete hook "${h.name}" from the manifest (and every policy that names it), then re-run \`harness apply --runtime codex\``,
          ) + (fromManifest ? " (counted once, in the manifest warnings)" : ""),
        ...(fromManifest ? { countedElsewhere: true } : {}),
      });
      continue;
    }
    // Bare `harness` subcommands resolve as long as the harness binary
    // does (already checked above); skip the per-hook PATH lookup for
    // them so the error tally doesn't double-count a missing harness.
    // Bare `harness <subcommand>` form: any operator-authored hook that
    // calls into the harness binary lands here, not just pack-contributed
    // ones. The harness-binary check above is the upstream gate.
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

export function runCodexTargetChecks(
  manifest: Manifest,
  opts: RunCodexCheckOptions,
): CodexTargetReport {
  const pathEnv = opts.pathEnv ?? process.env["PATH"] ?? "";
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;

  const checks: CodexCheckEntry[] = [];
  const harnessResult = resolveHarnessBinary(
    { pathEnv, isExecutable },
    opts.harnessBinary,
  );
  checks.push(harnessResult.entry);
  checks.push(checkConfigToml(opts.manifestDir));
  checks.push(...checkHookCommands(manifest, pathEnv, isExecutable));

  return { target: "codex", checks };
}

export function countCodexDiagnostics(
  report: CodexTargetReport,
): { errorCount: number; warningCount: number } {
  return countStatusDiagnostics(report.checks.filter((c) => c.countedElsewhere !== true));
}
