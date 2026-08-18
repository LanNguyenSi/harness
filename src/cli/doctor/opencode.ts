// Batch 18 / task f34eb233 -- `harness doctor --target opencode` checks.
//
// Validates the harness side of the adapter shipped by
// generate-opencode-config.ts: the harness-generated
// `harness.generated/opencode/opencode.json` exists and carries the
// harness-managed banner, and every MCP server the manifest projects
// into it has a command whose first token resolves on PATH.
//
// Unlike codex.ts, there is no "harness binary" / "adapter subcommands
// available" check here: the opencode adapter does not wire any
// declarative hooks (see generate-opencode-config.ts's header for why),
// so there is no `harness pack hook opencode-*` subcommand for opencode
// to invoke and nothing version-gated to probe. What this module
// guarantees is "the harness-projected MCP wiring is real"; whether
// opencode itself reads the emitted JSON is up to the operator's
// $OPENCODE_CONFIG wiring (see the generated file's own banner).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  OPENCODE_GENERATED_HEADER_LINE,
  generateOpencodeConfig,
} from "../apply/generate-opencode-config.js";
import type { Manifest } from "../../schema/index.js";
import { countStatusDiagnostics, findOnPath } from "./codex.js";

export type OpencodeCheckStatus = "ok" | "warn" | "error";

export interface OpencodeCheckEntry {
  name: string;
  status: OpencodeCheckStatus;
  message: string;
}

export interface OpencodeTargetReport {
  target: "opencode";
  checks: OpencodeCheckEntry[];
}

export interface RunOpencodeCheckOptions {
  /** Manifest directory; the opencode config is at <dir>/harness.generated/opencode/opencode.json. */
  manifestDir: string;
  /** Override for $PATH lookup (test injection). */
  pathEnv?: string;
  /** Override for path existence + executable check (test injection). */
  isExecutable?: (p: string) => boolean;
}

const OPENCODE_CONFIG_RELPATH = path.join("harness.generated", "opencode", "opencode.json");

function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checkConfigArtefact(manifestDir: string): OpencodeCheckEntry {
  const target = path.join(manifestDir, OPENCODE_CONFIG_RELPATH);
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const message =
      e.code === "ENOENT"
        ? `${target} not found; run \`harness apply --runtime opencode\` first`
        : `cannot read ${target}: ${e.message}`;
    return { name: "opencode config artefact", status: "error", message };
  }
  if (!content.startsWith(OPENCODE_GENERATED_HEADER_LINE)) {
    return {
      name: "opencode config artefact",
      status: "warn",
      message: `${target} exists but does not carry the harness-managed banner; was it hand-edited?`,
    };
  }
  return { name: "opencode config artefact", status: "ok", message: `present: ${target}` };
}

function checkMcpCommands(
  manifest: Manifest,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): OpencodeCheckEntry[] {
  // Re-derive the projected server map from the pure generator rather
  // than re-parsing the on-disk artefact: the artefact is JSONC (banner
  // comments would break a strict JSON.parse), while `generateOpencodeConfig`
  // is cheap and side-effect-free, so this check works even before
  // `apply --runtime opencode` has ever run.
  const { mcp } = generateOpencodeConfig(manifest);
  const names = Object.keys(mcp);
  if (names.length === 0) {
    return [
      {
        name: "opencode MCP servers",
        status: "warn",
        message: "no MCP servers projected; the opencode config has no `mcp` entries",
      },
    ];
  }
  return names.map((name): OpencodeCheckEntry => {
    const entry = mcp[name]!;
    // LOW-F4 (batch18 fix-round, task f34eb233 review): `mcp` now also
    // carries `{"enabled": false}` markers for disabled manifest
    // entries (generate-opencode-config.ts). There is no command to
    // resolve for those -- skip the PATH check instead of crashing on
    // the missing `.command` field.
    if (!("command" in entry)) {
      return { name: `mcp ${name}`, status: "ok", message: "disabled (enabled: false); command not checked" };
    }
    const firstToken = entry.command[0];
    if (!firstToken) {
      return { name: `mcp ${name}`, status: "error", message: "empty command after projection" };
    }
    const resolved = findOnPath(firstToken, pathEnv, isExecutable);
    if (!resolved) {
      return {
        name: `mcp ${name}`,
        status: "error",
        message: `command first token "${firstToken}" not found on PATH`,
      };
    }
    return { name: `mcp ${name}`, status: "ok", message: `resolved: ${resolved}` };
  });
}

export function runOpencodeTargetChecks(
  manifest: Manifest,
  opts: RunOpencodeCheckOptions,
): OpencodeTargetReport {
  const pathEnv = opts.pathEnv ?? process.env["PATH"] ?? "";
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;

  const checks: OpencodeCheckEntry[] = [
    checkConfigArtefact(opts.manifestDir),
    ...checkMcpCommands(manifest, pathEnv, isExecutable),
  ];
  return { target: "opencode", checks };
}

export function countOpencodeDiagnostics(
  report: OpencodeTargetReport,
): { errorCount: number; warningCount: number } {
  return countStatusDiagnostics(report.checks);
}
