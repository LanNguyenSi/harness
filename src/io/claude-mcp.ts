// All interaction with Claude Code's user-scope MCP registration lives here.
// harness never writes `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`)
// itself — mutations go exclusively through the `claude mcp` CLI, which is
// the only thing Claude Code actually reads at runtime for user-scope
// servers (unlike the `mcpServers` block in `~/.claude/settings.json`,
// which Claude Code does not consume — see
// .ai/runs/2026-07-18-init-mcp-wiring-claude-code/01-plan.md).
//
// Three layers, task T-001 scope only (no init/doctor wiring — that's
// T-002/T-003):
//   1. A thin, injectable-exec wrapper around `claude mcp get/add-json/
//      remove/list`, ENOENT-tolerant and timeout-bounded, that turns raw
//      exit codes/stderr into structured result objects (never throws for
//      "CLI missing" or "timed out" — those are just another outcome).
//   2. `ensureMcpServers`: reconciles a desired per-server state against
//      the live registry. The ONLY read of the registry file this module
//      performs is for this drift comparison, and it reads strictly the
//      top-level `mcpServers` key — never `projects.<path>.mcpServers`
//      (that's project-local Claude Code state; `uninstall`'s
//      `probeProjectLocalClaudeJson` already surfaces it separately,
//      read-only). All writes still go through the CLI wrapper above.
//   3. `stripOwnedMcpServers`: a pure function that removes owned names
//      from a parsed settings.json object (the dead `mcpServers` block
//      the old write path left behind). No file I/O — callers own reading
//      and writing the file.
//
// Verified CLI contract (empirical probe, 2026-07-18, disposable
// CLAUDE_CONFIG_DIR):
//   `claude mcp add-json --scope user <name> <json>`
//     new name    → exit 0, stdout "Added stdio MCP server <name> to user config"
//     name exists → exit 1, stderr "MCP server <name> already exists in user config" (no overwrite, no prompt)
//     malformed   → exit 1, stderr "Invalid configuration"
//   `claude mcp remove --scope user <name>`
//     present → exit 0
//     absent  → exit 1, stderr 'No MCP server named "<name>" in user scope'
//   `claude mcp get <name>`
//     present → exit 0; absent → exit 1
//   `claude mcp list`
//     exit 0 even with dead servers. Line format:
//     `<name>: <command> <args> - <marker> <statusText>` with marker one
//     of "✔ Connected" | "✘ Failed to connect" | "! Needs authentication".
//   Respects CLAUDE_CONFIG_DIR: the user-scope registry then lives at
//   $CLAUDE_CONFIG_DIR/.claude.json instead of ~/.claude.json.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------
// Layer 1: injectable exec + per-verb CLI wrapper
// ---------------------------------------------------------------------

export interface ClaudeMcpExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True iff the failure was a spawn-time ENOENT (the `claude` binary is not resolvable on PATH). */
  enoent: boolean;
  /** True iff the call was killed after exceeding the timeout. */
  timedOut: boolean;
}

export interface ClaudeMcpExec {
  (args: string[], timeoutMs: number): Promise<ClaudeMcpExecResult>;
}

function realClaudeMcpExec(args: string[], timeoutMs: number): Promise<ClaudeMcpExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        code: 127,
        stdout: "",
        stderr: `spawn failed: ${e.message}`,
        enoent: e.code === "ENOENT",
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ code: -1, stdout, stderr, enoent: false, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      resolve({ code: 127, stdout, stderr, enoent: e.code === "ENOENT", timedOut: false });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, enoent: false, timedOut: false });
    });
  });
}

export interface ClaudeMcpCallOptions {
  /** Override the `claude` spawn. Tests inject a fake; default is the real CLI. */
  exec?: ClaudeMcpExec;
  /** Per-call timeout in ms. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Claude Code's `mcpServers` entry shape: command + optional args/env (matches SettingsMcpServer in generate-settings.ts). */
export interface ClaudeMcpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// Omit empty args/env so the JSON handed to `add-json` stays minimal
// (mirrors buildMcpServers in generate-settings.ts).
function compactSpec(spec: ClaudeMcpServerSpec): ClaudeMcpServerSpec {
  const out: ClaudeMcpServerSpec = { command: spec.command };
  if (spec.args && spec.args.length > 0) out.args = spec.args;
  if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
  return out;
}

export type AddJsonStatus =
  | "added"
  | "already-exists"
  | "invalid-config"
  | "cli-missing"
  | "timeout"
  | "error";

export interface AddJsonResult {
  status: AddJsonStatus;
  message: string;
  code: number;
}

/**
 * Wrap a value as a single POSIX shell single-quoted token, escaping any
 * embedded single quote as `'\''`. Used to build the copy-pasteable
 * `claude mcp add-json ... <json>` fallback commands harness prints when the
 * CLI is missing or a server is unregistered, so the operator can paste them
 * verbatim even when a value (e.g. a home path containing an apostrophe, as
 * projected into grounding-mcp's EVIDENCE_LEDGER_DB) has a single quote.
 * Harness never executes these strings itself.
 */
export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function addJsonMcpServer(
  name: string,
  spec: ClaudeMcpServerSpec,
  opts: ClaudeMcpCallOptions = {},
): Promise<AddJsonResult> {
  const exec = opts.exec ?? realClaudeMcpExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const json = JSON.stringify(compactSpec(spec));
  const r = await exec(["mcp", "add-json", "--scope", "user", name, json], timeoutMs);
  if (r.timedOut) {
    return { status: "timeout", message: `claude mcp add-json timed out after ${timeoutMs}ms`, code: r.code };
  }
  if (r.enoent) {
    return { status: "cli-missing", message: "claude CLI not found on PATH", code: r.code };
  }
  if (r.code === 0) {
    return { status: "added", message: r.stdout.trim(), code: r.code };
  }
  const stderr = r.stderr.trim();
  if (/already exists/i.test(stderr)) {
    return { status: "already-exists", message: stderr, code: r.code };
  }
  if (/invalid configuration/i.test(stderr)) {
    return { status: "invalid-config", message: stderr, code: r.code };
  }
  return { status: "error", message: stderr || `claude mcp add-json exited ${r.code}`, code: r.code };
}

export type RemoveStatus = "removed" | "not-found" | "cli-missing" | "timeout" | "error";

export interface RemoveResult {
  status: RemoveStatus;
  message: string;
  code: number;
}

export async function removeMcpServer(
  name: string,
  opts: ClaudeMcpCallOptions = {},
): Promise<RemoveResult> {
  const exec = opts.exec ?? realClaudeMcpExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = await exec(["mcp", "remove", "--scope", "user", name], timeoutMs);
  if (r.timedOut) {
    return { status: "timeout", message: `claude mcp remove timed out after ${timeoutMs}ms`, code: r.code };
  }
  if (r.enoent) {
    return { status: "cli-missing", message: "claude CLI not found on PATH", code: r.code };
  }
  if (r.code === 0) {
    return { status: "removed", message: r.stdout.trim(), code: r.code };
  }
  const stderr = r.stderr.trim();
  if (/No MCP server named/i.test(stderr)) {
    return { status: "not-found", message: stderr, code: r.code };
  }
  return { status: "error", message: stderr || `claude mcp remove exited ${r.code}`, code: r.code };
}

export type GetStatus = "found" | "not-found" | "cli-missing" | "timeout";

export interface GetResult {
  status: GetStatus;
  raw: string;
  code: number;
}

export async function getMcpServer(name: string, opts: ClaudeMcpCallOptions = {}): Promise<GetResult> {
  const exec = opts.exec ?? realClaudeMcpExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = await exec(["mcp", "get", name], timeoutMs);
  if (r.timedOut) {
    return { status: "timeout", raw: "", code: r.code };
  }
  if (r.enoent) {
    return { status: "cli-missing", raw: "", code: r.code };
  }
  if (r.code === 0) {
    return { status: "found", raw: r.stdout, code: r.code };
  }
  // Per the verified contract `get` only ever exits 0 (found) or 1
  // (absent); any other non-zero, non-enoent exit still reads as
  // "not-found" rather than inventing an "error" bucket the contract
  // never demonstrated.
  return { status: "not-found", raw: r.stderr.trim(), code: r.code };
}

export type ClaudeMcpConnectionStatus = "connected" | "failed" | "needs-authentication" | "unknown";

export interface ClaudeMcpListEntry {
  name: string;
  command: string;
  args: string[];
  status: ClaudeMcpConnectionStatus;
  statusText: string;
}

function markerToStatus(marker: string): ClaudeMcpConnectionStatus {
  switch (marker) {
    case "✔":
      return "connected";
    case "✘":
      return "failed";
    case "!":
      return "needs-authentication";
    default:
      return "unknown";
  }
}

// `<name>: <command> <args...> - <marker> <statusText>`. Greedy `.+` for
// the command segment finds the RIGHTMOST " - <marker> " separator,
// which is what we want since the command/args portion (e.g. a URL like
// `https://...`) may itself contain " - ". The name segment stops at the
// first ": " (not just ":") so URLs like "https://..." — colon with no
// following space — never get mistaken for the name/command boundary.
const LIST_LINE_RE = /^(.+?): (.+) - (✔|✘|!) (.+)$/;

/**
 * Parse `claude mcp list` stdout. Lines that don't match the expected
 * shape (blank lines, any future banner/preamble) are skipped rather
 * than throwing — the exit code alone tells us the command succeeded.
 *
 * Caveat (same one `buildMcpServers` in generate-settings.ts documents
 * for the inverse direction): splitting the command+args segment on
 * whitespace mis-splits a command path with embedded spaces. Foreign
 * entries whose "command" is a URL (e.g. `claude.ai Gmail: https://... -
 * ! Needs authentication`) still parse correctly since URLs have no
 * embedded whitespace.
 */
export function parseClaudeMcpListOutput(stdout: string): ClaudeMcpListEntry[] {
  const entries: ClaudeMcpListEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = LIST_LINE_RE.exec(line);
    if (!m) continue;
    const name = (m[1] ?? "").trim();
    const commandLine = (m[2] ?? "").trim();
    const marker = m[3] ?? "";
    const statusText = (m[4] ?? "").trim();
    const tokens = commandLine.split(/\s+/).filter((t) => t.length > 0);
    entries.push({
      name,
      command: tokens[0] ?? "",
      args: tokens.slice(1),
      status: markerToStatus(marker),
      statusText,
    });
  }
  return entries;
}

export type ListStatus = "ok" | "cli-missing" | "timeout" | "error";

export interface ListResult {
  status: ListStatus;
  servers: ClaudeMcpListEntry[];
  message?: string;
}

export async function listMcpServers(opts: ClaudeMcpCallOptions = {}): Promise<ListResult> {
  const exec = opts.exec ?? realClaudeMcpExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = await exec(["mcp", "list"], timeoutMs);
  if (r.timedOut) {
    return { status: "timeout", servers: [], message: `claude mcp list timed out after ${timeoutMs}ms` };
  }
  if (r.enoent) {
    return { status: "cli-missing", servers: [], message: "claude CLI not found on PATH" };
  }
  if (r.code !== 0) {
    return { status: "error", servers: [], message: r.stderr.trim() || `claude mcp list exited ${r.code}` };
  }
  return { status: "ok", servers: parseClaudeMcpListOutput(r.stdout) };
}

// ---------------------------------------------------------------------
// Layer 2: ensure routine (desired-state reconciliation)
// ---------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export interface ResolveRegistryPathOptions {
  /** Override for Claude Code's own config home. Defaults to `path.join(os.homedir(), ".claude")`. */
  homeDir?: string;
  /** Override for process.env (CLAUDE_CONFIG_DIR lookup). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the path to the user-scope registry file the `claude` CLI
 * itself reads/writes — the same precedence the CLI applies: an explicit
 * `CLAUDE_CONFIG_DIR` wins (`$CLAUDE_CONFIG_DIR/.claude.json`); otherwise
 * it's `~/.claude.json`, derived here as `path.join(path.dirname(homeDir),
 * ".claude.json")` to match the existing resolution in
 * `src/cli/uninstall/index.ts` (`probeProjectLocalClaudeJson`).
 */
export function resolveClaudeUserRegistryPath(opts: ResolveRegistryPathOptions = {}): string {
  const env = opts.env ?? process.env;
  const configDir = env["CLAUDE_CONFIG_DIR"];
  if (typeof configDir === "string" && configDir.length > 0) {
    return path.join(configDir, ".claude.json");
  }
  const homeDir = opts.homeDir ?? path.join(os.homedir(), ".claude");
  return path.join(path.dirname(homeDir), ".claude.json");
}

export interface RegistryReadResult {
  servers: Record<string, unknown>;
  error: string | null;
}

/**
 * Read strictly the top-level `mcpServers` key of the registry file. Never
 * reads/interprets `projects.<path>.mcpServers` — that's project-local
 * Claude Code state, out of scope here (see `probeProjectLocalClaudeJson`
 * in uninstall for the existing, separate, read-only handling of it).
 *
 * Exported (task 83d8d03a) as the single allowed primitive for reading the
 * effective Claude Code user-scope MCP registration from outside this
 * module — `adopt` (MCP-drift comparison) and `detect` (team/full
 * recognition) both call this directly instead of duplicating a registry
 * reader or spawning `claude mcp list`. Read-only; never writes.
 */
export function readTopLevelMcpServers(registryPath: string): RegistryReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { servers: {}, error: null };
    return { servers: {}, error: `cannot read ${registryPath}: ${e.message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { servers: {}, error: `${registryPath} is not valid JSON: ${(err as Error).message}` };
  }
  if (!isRecord(parsed)) {
    return { servers: {}, error: `${registryPath} is not a JSON object` };
  }
  const mcp = parsed["mcpServers"];
  if (mcp === undefined) return { servers: {}, error: null };
  if (!isRecord(mcp)) {
    return { servers: {}, error: `${registryPath} \`mcpServers\` is not a JSON object` };
  }
  return { servers: mcp, error: null };
}

// Equality tolerates a missing `args` on either side as `[]` and a
// missing `env` on either side as `{}` (constraint: "args-Default []
// tolerieren"; env gets the same treatment for consistency).
function specsEqual(existing: unknown, desired: ClaudeMcpServerSpec): boolean {
  if (!isRecord(existing)) return false;
  if (existing["command"] !== desired.command) return false;

  const existingArgs = Array.isArray(existing["args"]) ? (existing["args"] as unknown[]) : [];
  const desiredArgs = desired.args ?? [];
  if (existingArgs.length !== desiredArgs.length) return false;
  for (let i = 0; i < existingArgs.length; i++) {
    if (existingArgs[i] !== desiredArgs[i]) return false;
  }

  const existingEnv = isRecord(existing["env"]) ? (existing["env"] as Record<string, unknown>) : {};
  const desiredEnv = desired.env ?? {};
  const existingEnvKeys = Object.keys(existingEnv).sort();
  const desiredEnvKeys = Object.keys(desiredEnv).sort();
  if (existingEnvKeys.length !== desiredEnvKeys.length) return false;
  for (let i = 0; i < existingEnvKeys.length; i++) {
    const k = existingEnvKeys[i]!;
    if (k !== desiredEnvKeys[i]) return false;
    if (existingEnv[k] !== desiredEnv[k]) return false;
  }
  return true;
}

export type EnsureAction = "noop" | "add" | "replace" | "skipped";

export interface EnsureServerResult {
  name: string;
  action: EnsureAction;
  /** Present when action === "replace". */
  remove?: RemoveResult;
  /** Present when action === "add" or a "replace" whose remove step succeeded. */
  add?: AddJsonResult;
  /** Present when action === "skipped": the registry file could not be read safely, so drift cannot be determined. */
  reason?: string;
}

export interface EnsureMcpServersOptions {
  /** Desired state: server name -> spec. */
  desired: Record<string, ClaudeMcpServerSpec>;
  exec?: ClaudeMcpExec;
  timeoutMs?: number;
  /** Explicit override for the registry file read for drift comparison. Takes precedence over homeDir/env. */
  registryPath?: string;
  /** Base for the default registry path when `registryPath` is not given. */
  homeDir?: string;
  /** Override for process.env (CLAUDE_CONFIG_DIR lookup) when `registryPath` is not given. */
  env?: NodeJS.ProcessEnv;
}

export interface EnsureMcpServersResult {
  registryPath: string;
  results: EnsureServerResult[];
}

/**
 * Reconcile `desired` against the live user-scope registry:
 *   - name absent from the registry           → `add-json`
 *   - name present, spec identical             → no-op, NO exec call at all
 *   - name present, spec differs (drift)        → `remove` then `add-json`
 * The registry is only ever read (for the comparison); every write goes
 * through the CLI wrapper. If the registry file can't be read safely
 * (malformed JSON, `mcpServers` not an object, non-ENOENT read error),
 * every desired server is reported `skipped` with a reason instead of
 * guessing — a missing file (ENOENT, i.e. no registry yet) is NOT an
 * error and is treated as an empty registry.
 */
export async function ensureMcpServers(opts: EnsureMcpServersOptions): Promise<EnsureMcpServersResult> {
  const registryPath =
    opts.registryPath ?? resolveClaudeUserRegistryPath({ homeDir: opts.homeDir, env: opts.env });
  const { servers: existing, error: readError } = readTopLevelMcpServers(registryPath);
  const callOpts: ClaudeMcpCallOptions = { exec: opts.exec, timeoutMs: opts.timeoutMs };
  const results: EnsureServerResult[] = [];

  for (const name of Object.keys(opts.desired).sort()) {
    const spec = opts.desired[name]!;

    if (readError !== null) {
      results.push({ name, action: "skipped", reason: readError });
      continue;
    }

    const current = existing[name];
    if (current === undefined) {
      const add = await addJsonMcpServer(name, spec, callOpts);
      results.push({ name, action: "add", add });
      continue;
    }

    if (specsEqual(current, spec)) {
      results.push({ name, action: "noop" });
      continue;
    }

    const remove = await removeMcpServer(name, callOpts);
    if (remove.status !== "removed" && remove.status !== "not-found") {
      // remove failed for a reason unrelated to "already gone" (cli-missing,
      // timeout, or a genuine error) — a follow-up add-json would just fail
      // the same way (or worse, collide), so stop here and report it.
      results.push({ name, action: "replace", remove });
      continue;
    }
    const add = await addJsonMcpServer(name, spec, callOpts);
    results.push({ name, action: "replace", remove, add });
  }

  return { registryPath, results };
}

// ---------------------------------------------------------------------
// Layer 3: migration (pure function on a settings.json object)
// ---------------------------------------------------------------------

export interface StripOwnedMcpServersResult {
  settings: Record<string, unknown>;
  /** Names actually removed (subset of ownedNames that were present), sorted. */
  removedNames: string[];
}

/**
 * Remove exactly the given owned names from `settings.mcpServers`,
 * preserve every foreign entry, drop the `mcpServers` key entirely when
 * it becomes empty, and leave every other top-level key byte-identical
 * (same values, same insertion order). Pure — no file I/O; callers own
 * reading/writing settings.json.
 */
export function stripOwnedMcpServers(
  settings: Record<string, unknown>,
  ownedNames: readonly string[],
): StripOwnedMcpServersResult {
  const mcpServers = settings["mcpServers"];
  if (!isRecord(mcpServers)) {
    // Absent or malformed `mcpServers`: nothing this function owns to
    // strip. Returning the same reference keeps the "byte-identical"
    // guarantee trivially true.
    return { settings, removedNames: [] };
  }

  const owned = new Set(ownedNames);
  const kept: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (owned.has(name)) {
      removed.push(name);
    } else {
      kept[name] = value;
    }
  }

  if (removed.length === 0) {
    return { settings, removedNames: [] };
  }

  // Spread preserves existing key order; reassigning `mcpServers` in
  // place keeps its original position instead of moving it to the end.
  const out: Record<string, unknown> = { ...settings };
  if (Object.keys(kept).length === 0) {
    delete out["mcpServers"];
  } else {
    out["mcpServers"] = kept;
  }
  return { settings: out, removedNames: removed.sort() };
}
