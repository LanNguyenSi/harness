// Read-only environment probe for `harness init --interactive` (and the
// `--probe` debug flag that prints these results as JSON). Best-effort:
// missing config files or unparseable JSON are reported in the returned
// shape, never thrown. No writes, no network, no child processes.
//
// v1 scope (mirrors task c5287b80): Claude Code + Codex. MCP detection
// reads Claude Code's EFFECTIVE user-scope registration only — the
// top-level `mcpServers` key of `~/.claude.json` /
// `$CLAUDE_CONFIG_DIR/.claude.json`, read read-only via
// `readTopLevelMcpServers` (io/claude-mcp.ts) (task 83d8d03a). It no
// longer reads the `mcpServers` block in `~/.claude/settings.json`: Claude
// Code never consumed that block at runtime (see io/claude-mcp.ts:1-9),
// so `team`/`full` profile recognition (interactive.ts's
// `detectionHasAgentTasks`) would otherwise key off dead state. Codex's
// TOML parser lives in the v1.1 opencode-adapter task. The result is
// still useful for Codex users: `runtimes[]` flags presence so the
// wizard can pre-select.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTopLevelMcpServers, resolveClaudeUserRegistryPath } from "../../io/claude-mcp.js";
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
}

export interface DetectedMcpServer {
  name: string;
  /**
   * Which runtime this entry was read from. v1: only claude-code — read
   * from its effective user-scope registry (~/.claude.json), not
   * settings.json (task 83d8d03a).
   */
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
  /**
   * Set when the Claude Code user-scope MCP registry (~/.claude.json /
   * $CLAUDE_CONFIG_DIR/.claude.json) exists but could not be read safely
   * (malformed JSON, `mcpServers` not an object). A missing registry file
   * is NOT an error — `mcpServers` is simply `[]` in that case; this field
   * lets a caller distinguish "genuinely not registered" from "could not
   * tell" instead of detect() silently guessing empty (task 83d8d03a).
   */
  mcpRegistryParseError?: string;
}

export interface DetectOptions {
  /** Override `os.homedir()` for tests. */
  homeDir?: string;
  /**
   * Override for process.env (CLAUDE_CONFIG_DIR lookup) used to resolve
   * the Claude Code user-scope MCP registry path. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv;
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

interface RegistryMcpSpec {
  command?: unknown;
  args?: unknown;
}

/**
 * Read Claude Code's EFFECTIVE user-scope MCP registration: the top-level
 * `mcpServers` key of `~/.claude.json` / `$CLAUDE_CONFIG_DIR/.claude.json`
 * (task 83d8d03a), via the shared read-only primitive in io/claude-mcp.ts.
 * Never reads `~/.claude/settings.json` for this — Claude Code does not
 * consume that file's `mcpServers` block at runtime. A missing registry
 * file is not an error (empty list); malformed JSON / a non-object
 * `mcpServers` is reported via `parseError` rather than guessed at.
 */
function parseClaudeMcpServers(
  runtime: DetectedRuntime,
  env: NodeJS.ProcessEnv,
): { servers: DetectedMcpServer[]; parseError?: string } {
  const registryPath = resolveClaudeUserRegistryPath({ homeDir: runtime.home, env });
  const { servers: rawServers, error } = readTopLevelMcpServers(registryPath);
  const servers: DetectedMcpServer[] = [];
  for (const name of Object.keys(rawServers).sort()) {
    const entryRaw = rawServers[name];
    if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) continue;
    const entry = entryRaw as RegistryMcpSpec;
    if (typeof entry.command !== "string" || entry.command.length === 0) continue;
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];
    servers.push({ name, runtime: "claude-code", command: entry.command, args });
  }
  return error !== null ? { servers, parseError: error } : { servers };
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
  const { servers, parseError } = parseClaudeMcpServers(claude, opts.env ?? process.env);
  const result: DetectionResult = {
    harness: { version: VERSION },
    runtimes: [claude, codex],
    manifest,
    mcpServers: servers,
  };
  if (parseError !== undefined) result.mcpRegistryParseError = parseError;
  return result;
}
