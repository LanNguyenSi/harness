// Read-only environment probe for `harness init --interactive` (and the
// `--probe` debug flag that prints these results as JSON). Best-effort:
// missing config files or unparseable JSON are reported in the returned
// shape, never thrown. No writes, no network, no child processes.
//
// v1 scope (mirrors task c5287b80): Claude Code + Codex. MCP detection
// reads Claude Code's settings.json only — Codex's TOML parser lives in
// the v1.1 opencode-adapter task. The result is still useful for Codex
// users: `runtimes[]` flags presence so the wizard can pre-select.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { VERSION } from "../../version.js";

export type RuntimeName = "claude-code" | "codex";

export interface DetectedRuntime {
  name: RuntimeName;
  /** Resolved config-home directory (e.g. ~/.claude). Not guaranteed to exist. */
  home: string;
  homeExists: boolean;
  /** The runtime's primary config file path. */
  settingsPath: string;
  settingsExists: boolean;
  /** Set when settingsExists but parsing failed. settingsExists stays true. */
  settingsParseError?: string;
}

export interface DetectedMcpServer {
  name: string;
  /** Which runtime's config file this entry was read from. v1: only claude-code. */
  runtime: "claude-code";
  command: string;
  args: string[];
}

export interface DetectedManifest {
  path: string;
  exists: boolean;
  /** Set when exists but YAML parse failed. */
  parseError?: string;
}

export interface DetectionResult {
  harness: {
    version: string;
  };
  runtimes: DetectedRuntime[];
  manifest: DetectedManifest;
  mcpServers: DetectedMcpServer[];
}

export interface DetectOptions {
  /** Override `os.homedir()` for tests. */
  homeDir?: string;
}

function resolveHome(opts: DetectOptions): string {
  return opts.homeDir ?? os.homedir();
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function safeReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function detectClaudeRuntime(home: string): DetectedRuntime {
  const claudeHome = path.join(home, ".claude");
  const settingsPath = path.join(claudeHome, "settings.json");
  const homeStat = safeStat(claudeHome);
  const settingsStat = safeStat(settingsPath);
  return {
    name: "claude-code",
    home: claudeHome,
    homeExists: homeStat?.isDirectory() ?? false,
    settingsPath,
    settingsExists: settingsStat?.isFile() ?? false,
  };
}

function detectCodexRuntime(home: string): DetectedRuntime {
  const codexHome = path.join(home, ".codex");
  // Codex's primary config is config.toml per src/cli/apply/generate-codex-config.ts.
  const settingsPath = path.join(codexHome, "config.toml");
  const homeStat = safeStat(codexHome);
  const settingsStat = safeStat(settingsPath);
  return {
    name: "codex",
    home: codexHome,
    homeExists: homeStat?.isDirectory() ?? false,
    settingsPath,
    settingsExists: settingsStat?.isFile() ?? false,
  };
}

interface ClaudeSettingsShape {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

function parseClaudeMcpServers(
  runtime: DetectedRuntime,
): { servers: DetectedMcpServer[]; parseError?: string } {
  if (!runtime.settingsExists) return { servers: [] };
  const raw = safeReadFile(runtime.settingsPath);
  if (raw === null) {
    return { servers: [], parseError: "settings.json unreadable" };
  }
  let parsed: ClaudeSettingsShape;
  try {
    parsed = JSON.parse(raw) as ClaudeSettingsShape;
  } catch (err) {
    return { servers: [], parseError: `settings.json invalid JSON: ${(err as Error).message}` };
  }
  const entries = parsed.mcpServers;
  if (!entries || typeof entries !== "object") return { servers: [] };
  const servers: DetectedMcpServer[] = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command !== "string" || entry.command.length === 0) continue;
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];
    servers.push({ name, runtime: "claude-code", command: entry.command, args });
  }
  return { servers };
}

function detectManifest(userHome: string): DetectedManifest {
  // The harness manifest lives under the runtime-neutral harness home
  // (`resolveHomeDir`: `~/.harness/`, or legacy `~/.claude/` only when
  // harness state still physically lives there). It is NOT pinned to the
  // claude-code runtime config dir — the v0.24.0 home-dir migration
  // decoupled the two. Probing the claude runtime dir here made
  // `init --interactive` mis-detect the manifest as absent on every
  // migrated install, so the wizard prompted for the wrong path and then
  // `init()` (which resolves correctly) refused on the real file
  // (harness/418cebd4). `userHome` is the operator's `$HOME`; pass it as
  // `userHome` so `resolveHomeDir`'s preferred-existence checks anchor on
  // the same home detect() was given.
  const harnessHome = resolveHomeDir({ userHome }).path;
  const manifestPath = path.join(harnessHome, "harness.yaml");
  const stat = safeStat(manifestPath);
  return { path: manifestPath, exists: stat?.isFile() ?? false };
}

export async function detect(opts: DetectOptions = {}): Promise<DetectionResult> {
  const home = resolveHome(opts);
  const claude = detectClaudeRuntime(home);
  const codex = detectCodexRuntime(home);
  const manifest = detectManifest(home);
  const { servers, parseError } = parseClaudeMcpServers(claude);
  if (parseError) claude.settingsParseError = parseError;
  return {
    harness: { version: VERSION },
    runtimes: [claude, codex],
    manifest,
    mcpServers: servers,
  };
}
