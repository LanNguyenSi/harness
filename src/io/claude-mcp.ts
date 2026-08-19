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
//      the live registry (add/replace-on-drift/no-op), and — opt-in via
//      `opts.gc` (task 363a6de0, MCP-removal GC) — also `claude mcp
//      remove`s any caller-designated "owned" name that's registered but
//      no longer in `desired` (a manifest entry the operator removed or
//      disabled). Ownership is entirely the caller's call: this module
//      never guesses which names harness owns, so a foreign/manually
//      registered server is never touched, no matter how it drifts from
//      `desired`. The ONLY read of the registry file this module performs
//      serves both the drift comparison and the GC candidate scan, and it
//      reads strictly the top-level `mcpServers` key — never
//      `projects.<path>.mcpServers` (that's project-local Claude Code
//      state; `uninstall`'s `probeProjectLocalClaudeJson` already surfaces
//      it separately, read-only). All writes still go through the CLI
//      wrapper above.
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
//
// Re-verified/extended (empirical probe, 2026-08-19, disposable
// CLAUDE_CONFIG_DIR, batch19/T-005 — task fb3e4dce): `claude mcp get
// <name>`'s stdout is human-readable prose (`<name>:\n  Scope: ...\n
// Status: ...\n  Issue: ...`) — it does NOT print the registered
// `command`/`args`/`env`, on Claude Code 2.1.235. This is why the
// already-exists verification below (`addAndVerifyAlreadyExists`)
// confirms EXISTENCE via `get`'s exit code, then compares the actual
// registered spec via a fresh re-read of the same registry file
// `ensureMcpServers` already trusts for drift comparison — `get`'s prose
// output has nothing machine-parseable to compare against.

// Two review findings fixed here (batch19/T-005, task fb3e4dce, follow-up
// to run 2026-07-18-init-mcp-wiring-claude-code):
//   Finding 2 (CLAUDE_CONFIG_DIR drift): `realClaudeMcpExec` used to spawn
//   `claude` with no explicit `env`, so it inherited `process.env`
//   verbatim — identical to `ensureMcpServers`'s drift-read directory only
//   when `homeDir`/`registryPath` happens to match the OS default. A
//   non-default home (`--home`, or any `homeDir`/`registryPath` override)
//   made the live CLI spawn mutate/read a DIFFERENT `.claude.json` than
//   the one `ensureMcpServers` just compared against. Fixed by threading
//   `ClaudeMcpCallOptions.configDir` (== `path.dirname(registryPath)`,
//   always, both branches of `resolveClaudeUserRegistryPath`'s precedence)
//   through every verb wrapper to `exec`'s new third argument;
//   `realClaudeMcpExec` sets `CLAUDE_CONFIG_DIR` in the child's env from
//   it. `configDir` undefined (every caller other than `ensureMcpServers`
//   today) preserves the pre-existing behavior exactly: no explicit `env`
//   passed to `spawn`, i.e. plain `process.env` inheritance.
//   Finding 3 (already-exists treated as failure): `ensureMcpServers`
//   used to report an `add-json` "already exists" outcome exactly like any
//   other add failure, even though the actual condition — the desired
//   server IS registered — is the target state the caller wanted.
//   `addAndVerifyAlreadyExists` now verifies via `claude mcp get` (see the
//   2026-08-19 probe note above) + a fresh registry-file re-read whenever
//   `addJsonMcpServer` reports "already-exists": a confirmed, spec-matching
//   registration is surfaced via `EnsureServerResult.verifiedAlreadyExists
//   .matches = true` so a caller (`wireClaudeMcp` in
//   `cli/init/interactive.ts`) can treat it as an effective success (e.g.
//   letting the dead-settings.json migration proceed); an unconfirmed or
//   spec-mismatched registration preserves the PRIOR conservative
//   behavior (`matches = false`, caller keeps treating the overall result
//   as not-yet-successful).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertNoRealSpawnInTests } from "../runtime/hermetic-spawn-guard.js";

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
  /**
   * `configDir`, when given (batch19/T-005, Finding 2), is the value the
   * real spawn must expose as `CLAUDE_CONFIG_DIR` so it operates on
   * exactly the registry file the caller resolved `registryPath` from. A
   * fake `exec` injected by a test is free to ignore this third argument
   * entirely — it never spawns for real, so there is no env to align.
   */
  (args: string[], timeoutMs: number, configDir?: string): Promise<ClaudeMcpExecResult>;
}

/**
 * Hermetic guard (task 54739002 primitive, applied here per task
 * 0d80e969): asserts BEFORE touching `child_process` that we are not
 * running under vitest without a test having injected `opts.exec`. This
 * is the ONLY spawn point behind every `claude mcp <verb>` call in this
 * module (add-json/remove/get/list all default to `opts.exec ??
 * realClaudeMcpExec`). An accidental real spawn here talks to the
 * OPERATOR'S REAL Claude Code user-scope MCP registry (`~/.claude.json`
 * or `$CLAUDE_CONFIG_DIR/.claude.json`) — `list`/`get` only read it, but
 * `add-json`/`remove` actually mutate it. See
 * src/runtime/hermetic-spawn-guard.ts for why and the env signal used.
 *
 * `realClaudeMcpExec` has no try/catch around this call, so the thrown
 * `HermeticSpawnViolationError` propagates directly to whichever
 * exported wrapper (addJsonMcpServer/removeMcpServer/getMcpServer/
 * listMcpServers) called it, and from there to every one of THEIR
 * callers (including `ensureMcpServers`). Local "no try/catch here" is
 * not the actual guarantee, though: the OW guard
 * (src/cli/init/interactive.ts) proved a local absence-of-catch
 * argument isn't enough on its own — that violation had to survive a
 * catch further up the call chain. The backstops verified for THIS
 * module's call sites:
 *   - init's wire-now path: `wireRuntime`'s own catch
 *     (src/cli/init/interactive.ts, the "Failed to wire ..." handler)
 *     re-throws a `HermeticSpawnViolationError` before its normal
 *     degrade-to-warning-and-retry handling, and runInteractive's outer
 *     catch (src/cli/init/interactive.ts, the top-level handler that
 *     otherwise treats a caught error as either an `isAbortError`
 *     Ctrl-C or a rethrow) re-throws it again past every remaining
 *     intermediate handler.
 *   - doctor's `buildClaudeMcpRegistration` (src/cli/doctor/claude-mcp.ts)
 *     and `doctor()` (src/cli/doctor/index.ts) have no try/catch at all
 *     around the `listMcpServers` call, so it propagates unmodified.
 *   - uninstall's `removeRegisteredMcpServers` (src/cli/uninstall/
 *     index.ts) and `uninstall()` likewise have no try/catch around the
 *     `removeMcpServer` call.
 *
 * `configDir` (batch19/T-005, Finding 2): when given, exposed to the
 * spawned `claude` process as `CLAUDE_CONFIG_DIR` (on top of an otherwise
 * unmodified `process.env`), so the real CLI resolves the exact same
 * `$CLAUDE_CONFIG_DIR/.claude.json` that `ensureMcpServers` already read
 * for its drift comparison — see the module doc's "Finding 2" note.
 * `undefined` (every caller other than `ensureMcpServers` today) keeps the
 * pre-existing behavior byte-for-byte: no explicit `env` key is passed to
 * `spawn` at all, i.e. plain `process.env` inheritance, exactly as before
 * this parameter existed.
 */
function realClaudeMcpExec(
  args: string[],
  timeoutMs: number,
  configDir?: string,
): Promise<ClaudeMcpExecResult> {
  // Every caller in this module passes >=2 elements (["mcp", <verb>, ...]),
  // so the fallback below is unreached today — kept anyway so a future
  // call site that passes fewer never degrades to a blank/truncated
  // "claude " label in the guard's own error message.
  const verb = args.slice(0, 2).join(" ") || "(no args)";
  assertNoRealSpawnInTests(
    `claude ${verb}`,
    "Inject a fake `exec` (ClaudeMcpExec) via opts.exec instead of exercising the real spawn path.",
  );
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(configDir !== undefined ? { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } } : {}),
      });
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
  /**
   * Value to expose as `CLAUDE_CONFIG_DIR` to a REAL `claude` spawn
   * (batch19/T-005, Finding 2) — forwarded verbatim as `exec`'s third
   * argument. `ensureMcpServers` always sets this to
   * `path.dirname(registryPath)`, so a real spawn and the drift-read it
   * was compared against always target the same file, including under a
   * non-default `homeDir`/`--home`. Leave undefined for a bare verb call
   * outside `ensureMcpServers` (doctor's `listMcpServers`, uninstall's
   * `removeMcpServer`) to keep their pre-existing `process.env`
   * inheritance unchanged. Ignored by an injected test `exec` (no real
   * spawn happens under test, so there is no env to align).
   */
  configDir?: string;
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
  const r = await exec(["mcp", "add-json", "--scope", "user", name, json], timeoutMs, opts.configDir);
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
  const r = await exec(["mcp", "remove", "--scope", "user", name], timeoutMs, opts.configDir);
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

/**
 * One `claude mcp remove --scope user <name>` line per name, sorted.
 * Sibling of `manualAddJsonLines` in `cli/init/interactive.ts` — the
 * copy-pasteable fallback GC (task 363a6de0) prints when it can't reach
 * the `claude` CLI (or hits some other non-"removed"/"not-found" outcome)
 * to deregister a stale, harness-owned server itself. Uses
 * {@link posixSingleQuote} on the name for the same reason
 * `manualAddJsonLines` quotes its JSON payload: a server name is an
 * ordinary token today, but quoting it costs nothing and keeps the line
 * safe to paste verbatim regardless. Harness never executes these strings
 * itself.
 */
export function manualRemoveLines(names: readonly string[]): string[] {
  return [...names].sort().map((name) => `claude mcp remove --scope user ${posixSingleQuote(name)}`);
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
  const r = await exec(["mcp", "get", name], timeoutMs, opts.configDir);
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
  const r = await exec(["mcp", "list"], timeoutMs, opts.configDir);
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
// Layer 2: ensure routine (desired-state reconciliation + opt-in GC)
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

/**
 * Result of verifying an `add-json` "already exists" outcome (batch19/
 * T-005, Finding 3) via `claude mcp get` + a fresh registry-file re-read.
 * See the module doc's "Finding 3" note for why a re-read of the file (not
 * `get`'s own stdout) is what supplies the spec comparison.
 */
export interface VerifiedAlreadyExistsResult {
  /** Outcome of the `claude mcp get <name>` call used to confirm existence. */
  getStatus: GetStatus;
  /**
   * `true` iff `getStatus === "found"` AND a fresh re-read of the SAME
   * registry file `ensureMcpServers` derived `registryPath` from shows a
   * spec identical to `desired[name]` (same equality `specsEqual` already
   * uses for drift detection). A verified match means the caller's target
   * state already holds — treat this the same as a fresh "added" for
   * gating purposes. `false` (verification failed, the re-read errored, or
   * the spec genuinely differs) preserves the prior conservative
   * behavior: the caller must keep treating the overall result as
   * not-yet-successful.
   */
  matches: boolean;
}

export interface EnsureServerResult {
  name: string;
  action: EnsureAction;
  /** Present when action === "replace". */
  remove?: RemoveResult;
  /** Present when action === "add" or a "replace" whose remove step succeeded. */
  add?: AddJsonResult;
  /** Present when action === "skipped": the registry file could not be read safely, so drift cannot be determined. */
  reason?: string;
  /** Present iff `add?.status === "already-exists"` — see {@link VerifiedAlreadyExistsResult}. */
  verifiedAlreadyExists?: VerifiedAlreadyExistsResult;
}

export interface EnsureMcpServersGcOptions {
  /**
   * Names this harness install is allowed to garbage-collect from the
   * registry (task 363a6de0, D-107 ownership union: the current
   * manifest's `tools.mcp[]` names, union the `.last-apply` manifest
   * snapshot's `tools.mcp[]` names — the snapshot as of BEFORE the
   * caller's own apply ran, so a combined edit that both drops an entry
   * and re-stamps `.last-apply` doesn't erase the provenance). Building
   * this set is entirely the caller's responsibility — see `wireClaudeMcp`
   * in `cli/init/interactive.ts` for the reference construction.
   * Deliberately NOT included: the uninstall module's
   * `DEFAULT_OWNED_MCP_SERVERS` (D-107 supersedes the original D-103,
   * reviewer HIGH finding) — a server sharing one of those default names
   * that the operator registered themselves, outside/before any harness
   * manifest, must never be GC'd just because it's absent from `desired`.
   * A registry entry outside this set is NEVER touched by GC, no matter
   * how it drifts from `desired`.
   */
  ownedNames: string[];
}

export type GcAction = "removed" | "skipped";

export interface GcServerResult {
  name: string;
  action: GcAction;
  /** The underlying `claude mcp remove` outcome. */
  remove: RemoveResult;
  /**
   * Present when action === "skipped": `remove.status` was something
   * other than "removed"/"not-found" (cli-missing, timeout, or a genuine
   * error) — restated here as a human-readable reason so callers don't
   * have to re-derive it from `remove`.
   */
  reason?: string;
}

export interface GcResult {
  /**
   * One entry per GC candidate: an owned name (per `opts.gc.ownedNames`)
   * that is present in the registry and absent from `desired`. Empty when
   * there were no candidates, or when `registryReadError` is set.
   */
  results: GcServerResult[];
  /**
   * Present when the registry could not be read safely — the same
   * condition the main loop reports per-name via `skipped`/`reason`. No
   * GC candidate could be determined, so no removal was attempted for any
   * owned name; `results` stays empty rather than guessing.
   */
  registryReadError?: string;
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
  /**
   * Opt-in garbage collection (task 363a6de0): after reconciling
   * `desired`, additionally `claude mcp remove` any name in
   * `gc.ownedNames` that's registered but no longer in `desired` (i.e.
   * removed or disabled in the manifest since it was last registered).
   * Omitted entirely: behavior is exactly the pre-GC contract — every
   * registry entry outside `desired` is left untouched, and
   * `EnsureMcpServersResult.gc` stays undefined.
   */
  gc?: EnsureMcpServersGcOptions;
}

export interface EnsureMcpServersResult {
  registryPath: string;
  results: EnsureServerResult[];
  /** Present iff `opts.gc` was given. */
  gc?: GcResult;
}

/**
 * Wrap `addJsonMcpServer`: when the CLI reports `already-exists`
 * (batch19/T-005, Finding 3), verify via `claude mcp get` that the server
 * is genuinely registered, then re-read the SAME registry file
 * `ensureMcpServers` derived `registryPath` from (the add-json call may
 * have raced ahead of, or exposed a staleness in, the initial file read
 * `ensureMcpServers` took its `current`/drift snapshot from) to compare
 * the live spec against `desired`. Every other `add.status` passes
 * through unchanged — no extra call, no `verifiedAlreadyExists`.
 */
async function addAndVerifyAlreadyExists(
  name: string,
  spec: ClaudeMcpServerSpec,
  callOpts: ClaudeMcpCallOptions,
  registryPath: string,
): Promise<{ add: AddJsonResult; verifiedAlreadyExists?: VerifiedAlreadyExistsResult }> {
  const add = await addJsonMcpServer(name, spec, callOpts);
  if (add.status !== "already-exists") {
    return { add };
  }
  const verify = await getMcpServer(name, callOpts);
  let matches = false;
  if (verify.status === "found") {
    const fresh = readTopLevelMcpServers(registryPath);
    if (fresh.error === null) {
      matches = specsEqual(fresh.servers[name], spec);
    }
  }
  return { add, verifiedAlreadyExists: { getStatus: verify.status, matches } };
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
 *
 * `opts.gc` (task 363a6de0) opts into a second pass over the SAME
 * registry snapshot: every name in `opts.gc.ownedNames` that is currently
 * registered but absent from `desired` gets `claude mcp remove`d — this is
 * how a manifest edit that deletes or disables a `tools.mcp[]` entry
 * propagates into a deregistration on the next ensure run. A name that's
 * owned but ALSO still in `desired` (e.g. an operator hand-registered a
 * drifted copy of a still-active entry) is never a GC candidate — the
 * `desired` membership check excludes it before ownership is even
 * considered, so it's protected automatically, not via special-cased
 * content comparison. Without `opts.gc`, behavior is exactly the pre-GC
 * contract: every registry entry outside `desired` is left alone. If the
 * registry couldn't be read safely, GC is skipped too, mirroring the main
 * loop (`gc.registryReadError` set, `gc.results` empty) — same "never
 * guess" rule.
 *
 * `configDir` (batch19/T-005, Finding 2) is always set to
 * `path.dirname(registryPath)` and threaded to every CLI call this
 * function makes, so a REAL `claude` spawn (`realClaudeMcpExec`, when the
 * caller didn't inject `opts.exec`) mutates/reads exactly the registry
 * file this function's own drift comparison just read — no divergence
 * under a non-default `homeDir`/`--home`/`registryPath` override.
 *
 * An `add-json` "already exists" outcome (Finding 3) is verified via
 * `addAndVerifyAlreadyExists` before being reported: see
 * {@link VerifiedAlreadyExistsResult} for what a caller does with the
 * result.
 */
export async function ensureMcpServers(opts: EnsureMcpServersOptions): Promise<EnsureMcpServersResult> {
  const registryPath =
    opts.registryPath ?? resolveClaudeUserRegistryPath({ homeDir: opts.homeDir, env: opts.env });
  const { servers: existing, error: readError } = readTopLevelMcpServers(registryPath);
  const callOpts: ClaudeMcpCallOptions = {
    exec: opts.exec,
    timeoutMs: opts.timeoutMs,
    configDir: path.dirname(registryPath),
  };
  const results: EnsureServerResult[] = [];

  for (const name of Object.keys(opts.desired).sort()) {
    const spec = opts.desired[name]!;

    if (readError !== null) {
      results.push({ name, action: "skipped", reason: readError });
      continue;
    }

    const current = existing[name];
    if (current === undefined) {
      const { add, verifiedAlreadyExists } = await addAndVerifyAlreadyExists(
        name,
        spec,
        callOpts,
        registryPath,
      );
      results.push({
        name,
        action: "add",
        add,
        ...(verifiedAlreadyExists !== undefined ? { verifiedAlreadyExists } : {}),
      });
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
    const { add, verifiedAlreadyExists } = await addAndVerifyAlreadyExists(
      name,
      spec,
      callOpts,
      registryPath,
    );
    results.push({
      name,
      action: "replace",
      remove,
      add,
      ...(verifiedAlreadyExists !== undefined ? { verifiedAlreadyExists } : {}),
    });
  }

  let gc: GcResult | undefined;
  if (opts.gc) {
    if (readError !== null) {
      gc = { results: [], registryReadError: readError };
    } else {
      const desiredNames = new Set(Object.keys(opts.desired));
      const owned = new Set(opts.gc.ownedNames);
      // Owned ∧ registered ∧ NOT desired (D-103/D-107 — this module is
      // agnostic to how the caller built `ownedNames`). `desired`
      // membership is checked first, so a still-active manifest entry is
      // protected regardless of whether its registered content has
      // drifted.
      const candidates = Object.keys(existing)
        .filter((name) => owned.has(name) && !desiredNames.has(name))
        .sort();
      const gcResults: GcServerResult[] = [];
      for (const name of candidates) {
        const remove = await removeMcpServer(name, callOpts);
        if (remove.status === "removed" || remove.status === "not-found") {
          gcResults.push({ name, action: "removed", remove });
        } else {
          gcResults.push({ name, action: "skipped", remove, reason: remove.message });
        }
      }
      gc = { results: gcResults };
    }
  }

  return { registryPath, results, ...(gc !== undefined ? { gc } : {}) };
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
