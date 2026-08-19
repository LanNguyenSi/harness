// `harness session-start toolchain-parity` — SessionStart hook entrypoint,
// third sibling of `harness session-start preflight` / `branch-check`.
//
// Anlass: the 2026-07-22 PATH-shim incident, where a machine ran an entire
// session unnoticed on Node 22 + understanding-gate 0.4.6 instead of the
// intended Node 26 + 0.4.9 — nothing on that machine ever compared its own
// toolchain against any other machine's. This producer closes that gap,
// purely advisorily:
//
//   (a) writes a toolchain snapshot of THIS machine to
//       `<machineStateDir>/<ownProfile>.json` (owner-writes-only — every
//       OTHER `*.json` in that directory is read-only input, never
//       touched);
//   (b) compares the local LIVE toolchain state against every peer
//       snapshot file already in that directory;
//   (c) reports drift as stderr warning lines plus a single
//       `toolchain-parity:ok` / `toolchain-parity:drift:<n>` ledger fact,
//       with a `:unparseable-peer:<n>` suffix appended whenever one or more
//       peer files failed to parse as JSON (task 690fba7c, follow-up from
//       the agent-memory 06d09cde incident: an unparseable peer snapshot is
//       a real corruption/drift signal and must not vanish from `drift:N`
//       as if it had been a complete comparison).
//
// Transport of the snapshot files BETWEEN machines is entirely
// agent-memory-sync's job (agent-memory PR #64, already shipped) — this
// module only ever reads/writes the local directory.
//
// SessionStart contract, same as the two siblings: `blocking:false`. Every
// failure path (not configured, mkdir/write/read failure, a broken peer
// file, a spawn timeout, a ledger-write failure) logs one line to stderr
// and exits 0. There is no "gate" this producer can leave closed — it is
// purely advisory, so degrading silently (well, LOUDLY on stderr, just
// never blocking) is always the right move.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readTopLevelMcpServers,
  resolveClaudeUserRegistryPath,
} from "../../io/claude-mcp.js";
import { assertNoRealSpawnInTests } from "../../runtime/hermetic-spawn-guard.js";
import { resolveManifestLedgerWriter } from "../../runtime/ledger-writer.js";
import {
  resolveReadSessionId,
  type ResolveReadSessionOptions,
} from "../../runtime/session-id.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const FALLBACK_SESSION = "default";
const LEDGER_SOURCE = "harness-session-start-toolchain-parity";
const SNAPSHOT_SCHEMA_VERSION = 1;

// Individual spawn ceilings, not the expected duration: `node --version`
// and `npm ls -g --depth=0 --json` run IN PARALLEL (Promise.all in
// collectLocalSnapshot below), so the wall-time contribution of the two
// spawns together is max(nodeTimeoutMs, npmTimeoutMs), not their sum.
// Combined with two near-instant fs reads (OW-Kit version, MCP registry)
// and a ledger write, normal-case wall time targets well under 5s, matching
// the fast-path budget the `branch-check` sibling runs at (git-preflight's
// 70s budget is the outlier — it wraps a full external test-suite run,
// which this producer never does).
const DEFAULT_NODE_TIMEOUT_MS = 2_000;
const DEFAULT_NPM_GLOBALS_TIMEOUT_MS = 4_000;

interface SessionStartEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

/** Profile names land in a filename; strip anything not filename-safe. */
function sanitizeProfileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return cleaned.length > 0 ? cleaned : "profile";
}

// ---------------------------------------------------------------------
// Snapshot shape (v1) + (de)serialization
// ---------------------------------------------------------------------

/**
 * The toolchain snapshot v1 content (task brief §"Snapshot-Inhalt v1").
 * Every collected field is optional: a collection failure (spawn missing/
 * timed out, file unreadable) degrades to the matching `*Error` field
 * instead of ever throwing — see collectLocalSnapshot below. The harness
 * package's own version is deliberately NOT a separate field: it is just
 * one more entry in `npmGlobals` (key `@lannguyensi/harness`), which the
 * generic npm-package-version comparison in compareToPeer already covers.
 */
export interface ToolchainSnapshot {
  schemaVersion: 1;
  /** This machine's configured/derived profile name. */
  profile: string;
  /** ISO timestamp of when this snapshot was collected. */
  timestamp: string;
  /** `node --version` output (e.g. "v22.1.0"), PATH-resolved — see collectNodeVersion. */
  node?: string;
  nodeError?: string;
  /** `npm ls -g --depth=0 --json` dependencies, name -> version. */
  npmGlobals: Record<string, string>;
  npmGlobalsError?: string;
  /** `<workspaceRoot>/.ai/workflow/manifest.json`'s `version` field. */
  owKitVersion?: string;
  owKitError?: string;
  /** MCP server names registered with the `claude` CLI (file-read, no spawn). */
  mcpServers: string[];
  mcpServersError?: string;
}

function isRecordOfStrings(x: unknown): x is Record<string, string> {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    Object.values(x).every((v) => typeof v === "string")
  );
}

/**
 * Parse a stored snapshot JSON. Rejects (`ok:false`) only on the shapes
 * that make comparison meaningless — not valid JSON, not an object,
 * missing/invalid `profile` or `timestamp`. Every other field degrades
 * leniently (missing/malformed -> empty/absent) rather than rejecting the
 * whole file, since a peer snapshot written by a future schema version
 * should still compare on the fields this version understands.
 */
export function parseSnapshotJson(
  raw: string,
): { ok: true; snapshot: ToolchainSnapshot } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p["profile"] !== "string" || p["profile"].length === 0) {
    return { ok: false, reason: "missing or invalid `profile` field" };
  }
  if (typeof p["timestamp"] !== "string" || Number.isNaN(Date.parse(p["timestamp"]))) {
    return { ok: false, reason: "missing or invalid `timestamp` field" };
  }
  const snapshot: ToolchainSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    profile: p["profile"],
    timestamp: p["timestamp"],
    npmGlobals: isRecordOfStrings(p["npmGlobals"]) ? p["npmGlobals"] : {},
    mcpServers:
      Array.isArray(p["mcpServers"]) && p["mcpServers"].every((v) => typeof v === "string")
        ? (p["mcpServers"] as string[])
        : [],
  };
  if (typeof p["node"] === "string") snapshot.node = p["node"];
  if (typeof p["nodeError"] === "string") snapshot.nodeError = p["nodeError"];
  if (typeof p["npmGlobalsError"] === "string") snapshot.npmGlobalsError = p["npmGlobalsError"];
  if (typeof p["owKitVersion"] === "string") snapshot.owKitVersion = p["owKitVersion"];
  if (typeof p["owKitError"] === "string") snapshot.owKitError = p["owKitError"];
  if (typeof p["mcpServersError"] === "string") snapshot.mcpServersError = p["mcpServersError"];
  return { ok: true, snapshot };
}

// ---------------------------------------------------------------------
// Collectors (pure orchestration; every side-effecting piece is
// injectable, mirroring src/cli/doctor/npm-bin-path.ts's NpmExec seam)
// ---------------------------------------------------------------------

export type CollectNodeVersionResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

export type CollectNpmGlobalsResult =
  | { ok: true; packages: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Hermetic guard (mirrors `realNpmExec` in src/cli/doctor/npm-bin-path.ts):
 * asserts BEFORE touching `child_process` that we are not running under
 * vitest without a test having injected `runNodeVersion`. This function has
 * no try/catch around the assertion, and its only caller,
 * `collectLocalSnapshot`, calls it (via the `runNodeVersion` param, defaulted
 * to this function in `runSessionStartToolchainParity`) with no surrounding
 * try/catch either — see src/runtime/hermetic-spawn-guard.ts for why that
 * matters (a thrown `HermeticSpawnViolationError` must propagate, not be
 * folded into an ordinary "collection failed" outcome).
 *
 * PATH-resolved deliberately: `execFile("node", ...)` does a PATH lookup for
 * the literal string "node", NOT `process.execPath` — the entire point of
 * this collector is capturing the PATH state of the *shell* the session
 * runs in (the PATH-shim incident this task follows up on was exactly a
 * PATH pointing at the wrong node), which `process.version` (the node
 * running THIS harness process) would silently paper over.
 */
function realNodeVersionSpawn(timeoutMs: number): Promise<CollectNodeVersionResult> {
  assertNoRealSpawnInTests(
    "node --version",
    "Inject a fake `runNodeVersion` (SessionStartToolchainParityOptions.runNodeVersion) instead of exercising the real spawn path.",
  );
  return new Promise((resolve) => {
    execFile(
      "node",
      ["--version"],
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout) => {
        const text = (stdout ?? "").trim();
        if (text.length > 0) {
          resolve({ ok: true, version: text });
          return;
        }
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") {
            resolve({ ok: false, reason: "`node` not on PATH" });
            return;
          }
          if (e.killed) {
            resolve({ ok: false, reason: `\`node --version\` timed out after ${timeoutMs}ms` });
            return;
          }
          resolve({ ok: false, reason: `\`node --version\` failed: ${e.message}` });
          return;
        }
        resolve({ ok: false, reason: "`node --version` produced no output" });
      },
    );
  });
}

/**
 * Hermetic guard, same shape/rationale as {@link realNodeVersionSpawn} —
 * see that function's doc. Tolerant of a non-zero exit the same way
 * `spawnPreflight` (session-start/index.ts) is tolerant of `preflight run`'s
 * exit code: `npm ls -g` can exit non-zero on an unrelated extraneous/
 * invalid global entry while still emitting a perfectly parseable
 * `dependencies` JSON block, so a parseable stdout wins over the exit code.
 */
function realNpmGlobalsSpawn(timeoutMs: number): Promise<CollectNpmGlobalsResult> {
  assertNoRealSpawnInTests(
    "npm ls -g --depth=0 --json",
    "Inject a fake `runNpmGlobals` (SessionStartToolchainParityOptions.runNpmGlobals) instead of exercising the real spawn path.",
  );
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["ls", "-g", "--depth=0", "--json"],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        const text = (stdout ?? "").trim();
        if (text.length > 0) {
          try {
            const parsed = JSON.parse(text) as { dependencies?: Record<string, { version?: unknown }> };
            const packages: Record<string, string> = {};
            for (const [name, entry] of Object.entries(parsed.dependencies ?? {})) {
              if (typeof entry?.version === "string") packages[name] = entry.version;
            }
            resolve({ ok: true, packages });
            return;
          } catch {
            /* fall through to the error path */
          }
        }
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") {
            resolve({ ok: false, reason: "`npm` not on PATH" });
            return;
          }
          if (e.killed) {
            resolve({
              ok: false,
              reason: `\`npm ls -g --depth=0 --json\` timed out after ${timeoutMs}ms`,
            });
            return;
          }
          resolve({ ok: false, reason: `\`npm ls -g\` failed: ${e.message}` });
          return;
        }
        resolve({ ok: false, reason: "`npm ls -g --depth=0 --json` produced no parseable JSON" });
      },
    );
  });
}

/**
 * Read `<workspaceRoot>/.ai/workflow/manifest.json`'s `version` field
 * (the orchestrator-workflow kit's own version marker). A missing file is
 * the expected common case (most repos are not OW-kit-managed) and is
 * NOT an error — it degrades silently to `{}`. Malformed JSON or a
 * non-string `version` field on a manifest that DOES exist is noteworthy
 * (something is there but broken), so that degrades to `{ error }`.
 */
function realReadOwKitVersion(workspaceRoot: string): { version?: string; error?: string } {
  const manifestPath = path.join(workspaceRoot, ".ai", "workflow", "manifest.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    return { error: `cannot read ${manifestPath}: ${e.message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${manifestPath} is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${manifestPath} is not a JSON object` };
  }
  const version = (parsed as Record<string, unknown>)["version"];
  if (typeof version !== "string" || version.length === 0) {
    return { error: `${manifestPath} has no string \`version\` field` };
  }
  return { version };
}

/**
 * MCP server names from Claude Code's user-scope registry — a pure FILE
 * READ (never a spawn), reusing the exact primitive `harness doctor`'s
 * claude-mcp check ultimately compares against
 * (`resolveClaudeUserRegistryPath` + `readTopLevelMcpServers` in
 * src/io/claude-mcp.ts — the same functions `adopt`/`detect` use for the
 * same "read the effective registration from outside io/claude-mcp.ts"
 * purpose). Deliberately NOT `claude mcp list` (a spawn): the brief calls
 * for a file-read source for the NAMES here, and this is it.
 */
function realReadMcpServerNames(): { names: string[]; error?: string } {
  const registryPath = resolveClaudeUserRegistryPath();
  const { servers, error } = readTopLevelMcpServers(registryPath);
  if (error !== null) return { names: [], error };
  return { names: Object.keys(servers).sort() };
}

interface CollectLocalSnapshotOptions {
  profile: string;
  now: Date;
  workspaceRoot: string;
  nodeTimeoutMs: number;
  npmTimeoutMs: number;
  runNodeVersion: (timeoutMs: number) => Promise<CollectNodeVersionResult>;
  runNpmGlobals: (timeoutMs: number) => Promise<CollectNpmGlobalsResult>;
  readOwKitVersion: (workspaceRoot: string) => { version?: string; error?: string };
  readMcpServerNames: () => { names: string[]; error?: string };
}

/**
 * Collect the local, LIVE toolchain snapshot. Never throws (every
 * collector above degrades to `{ok:false,reason}` / `{error}` instead of
 * rejecting/throwing) — a collection failure is reported both inline on
 * the returned snapshot (the matching `*Error` field) AND as a `notes`
 * line for the caller to log, but never stops the other collectors from
 * running. node/npm run in PARALLEL (see the timeout constants' comment
 * above for why).
 */
async function collectLocalSnapshot(
  opts: CollectLocalSnapshotOptions,
): Promise<{ snapshot: ToolchainSnapshot; notes: string[] }> {
  const notes: string[] = [];
  const [nodeResult, npmResult] = await Promise.all([
    opts.runNodeVersion(opts.nodeTimeoutMs),
    opts.runNpmGlobals(opts.npmTimeoutMs),
  ]);
  const owKit = opts.readOwKitVersion(opts.workspaceRoot);
  const mcp = opts.readMcpServerNames();

  const snapshot: ToolchainSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    profile: opts.profile,
    timestamp: opts.now.toISOString(),
    npmGlobals: {},
    mcpServers: [],
  };

  if (nodeResult.ok) {
    snapshot.node = nodeResult.version;
  } else {
    snapshot.nodeError = nodeResult.reason;
    notes.push(`node --version: ${nodeResult.reason}`);
  }

  if (npmResult.ok) {
    snapshot.npmGlobals = npmResult.packages;
  } else {
    snapshot.npmGlobalsError = npmResult.reason;
    notes.push(`npm ls -g: ${npmResult.reason}`);
  }

  if (owKit.version !== undefined) snapshot.owKitVersion = owKit.version;
  if (owKit.error !== undefined) {
    snapshot.owKitError = owKit.error;
    notes.push(`OW-Kit version: ${owKit.error}`);
  }

  if (mcp.error !== undefined) {
    snapshot.mcpServersError = mcp.error;
    notes.push(`MCP server names: ${mcp.error}`);
  } else {
    snapshot.mcpServers = mcp.names;
  }

  return { snapshot, notes };
}

// ---------------------------------------------------------------------
// Snapshot write (own profile only) + peer comparison
// ---------------------------------------------------------------------

/**
 * Write ONLY `<machineStateDir>/<ownFileName>` (mkdir -p first). Never
 * touches any other file in the directory — the caller passes exactly
 * `sanitizeProfileName(profile) + ".json"`, so there is no path this
 * function could take that reaches a peer's file.
 */
function writeOwnSnapshot(
  machineStateDir: string,
  ownFileName: string,
  snapshot: ToolchainSnapshot,
): { ok: true; path: string } | { ok: false; reason: string } {
  const filePath = path.join(machineStateDir, ownFileName);
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export type DriftKind =
  | "node"
  | "ow_kit"
  | "npm_package_version"
  | "npm_package_missing_local"
  | "npm_package_missing_peer"
  | "mcp_missing_local"
  | "mcp_missing_peer";

export interface DriftItem {
  kind: DriftKind;
  message: string;
}

export interface PeerComparison {
  peerProfile: string;
  /** Snapshot age in ms, derived from the peer's own `timestamp` field. */
  ageMs: number;
  drift: DriftItem[];
}

/** `"just now"` / `"<n>m"` / `"<n>h"` / `"<n>d"` — coarse, human-scannable. */
export function formatSnapshotAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Compare the local LIVE snapshot against one peer's stored snapshot.
 * Node / OW-Kit drift only fires when BOTH sides collected that field
 * successfully (an unavailable field reads as "unknown", not "match" or
 * "drift"). The npm-globals and MCP-name comparisons additionally gate on
 * the WHOLE field having collected without error on both sides — an
 * `npmGlobalsError`/`mcpServersError` on either side means that side's map
 * is "unknown", not "empty", and treating it as empty would fabricate a
 * wall of "missing on N packages" drift instead of the real gap (which the
 * caller's own note()s already surface separately, from collectLocalSnapshot's
 * `notes` and the peer-unreadable path).
 */
export function compareToPeer(
  local: ToolchainSnapshot,
  peer: ToolchainSnapshot,
  now: Date,
): PeerComparison {
  const drift: DriftItem[] = [];
  const peerProfile = peer.profile;

  if (local.node !== undefined && peer.node !== undefined && local.node !== peer.node) {
    drift.push({
      kind: "node",
      message: `node version: local ${local.node} vs peer ${peerProfile} ${peer.node}`,
    });
  }

  if (
    local.owKitVersion !== undefined &&
    peer.owKitVersion !== undefined &&
    local.owKitVersion !== peer.owKitVersion
  ) {
    drift.push({
      kind: "ow_kit",
      message: `orchestrator-workflow kit version: local ${local.owKitVersion} vs peer ${peerProfile} ${peer.owKitVersion}`,
    });
  }

  if (local.npmGlobalsError === undefined && peer.npmGlobalsError === undefined) {
    const names = [...new Set([...Object.keys(local.npmGlobals), ...Object.keys(peer.npmGlobals)])].sort();
    for (const name of names) {
      const lv = local.npmGlobals[name];
      const pv = peer.npmGlobals[name];
      if (lv !== undefined && pv !== undefined) {
        if (lv !== pv) {
          drift.push({
            kind: "npm_package_version",
            message: `npm global \`${name}\`: local ${lv} vs peer ${peerProfile} ${pv}`,
          });
        }
      } else if (lv !== undefined) {
        drift.push({
          kind: "npm_package_missing_peer",
          message: `npm global \`${name}\`: local ${lv}, missing on peer ${peerProfile}`,
        });
      } else if (pv !== undefined) {
        drift.push({
          kind: "npm_package_missing_local",
          message: `npm global \`${name}\`: missing locally, peer ${peerProfile} has ${pv}`,
        });
      }
    }
  }

  if (local.mcpServersError === undefined && peer.mcpServersError === undefined) {
    const localSet = new Set(local.mcpServers);
    const peerSet = new Set(peer.mcpServers);
    const names = [...new Set([...localSet, ...peerSet])].sort();
    for (const name of names) {
      if (localSet.has(name) && !peerSet.has(name)) {
        drift.push({
          kind: "mcp_missing_peer",
          message: `mcp server \`${name}\`: registered locally, missing on peer ${peerProfile}`,
        });
      } else if (!localSet.has(name) && peerSet.has(name)) {
        drift.push({
          kind: "mcp_missing_local",
          message: `mcp server \`${name}\`: missing locally, registered on peer ${peerProfile}`,
        });
      }
    }
  }

  const peerTimeMs = Date.parse(peer.timestamp);
  const ageMs = Number.isFinite(peerTimeMs) ? Math.max(0, now.getTime() - peerTimeMs) : 0;

  return { peerProfile, ageMs, drift };
}

// ---------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------

export interface SessionStartToolchainParityOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (SessionStart). */
  stderr?: NodeJS.WritableStream;
  /** Explicit session id (overrides every other source). */
  session?: string;
  /** Override the cwd resolution (test injection). Falls back to event.cwd then process.cwd(). */
  cwd?: string;
  /** Override "now" for deterministic snapshot-age tests. */
  now?: Date;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** `node --version` subprocess timeout in ms. */
  nodeTimeoutMs?: number;
  /** `npm ls -g --depth=0 --json` subprocess timeout in ms. */
  npmTimeoutMs?: number;
  /** Inject a manifest (tests). Bypasses loadManifest. */
  manifest?: Manifest;
  /** Inject the ledger writer (tests). */
  writeLedger?: (args: {
    sessionId: string;
    content: string;
    source: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** Inject the read-path session resolver (env + transcript discovery). Test seam. */
  resolveSession?: (explicit: string | undefined, opts: ResolveReadSessionOptions) => string;
  /** Inject the `node --version` collector (tests) — see realNodeVersionSpawn's doc. */
  runNodeVersion?: (timeoutMs: number) => Promise<CollectNodeVersionResult>;
  /** Inject the `npm ls -g` collector (tests) — see realNpmGlobalsSpawn's doc. */
  runNpmGlobals?: (timeoutMs: number) => Promise<CollectNpmGlobalsResult>;
  /** Inject the OW-Kit-version file reader (tests). */
  readOwKitVersion?: (workspaceRoot: string) => { version?: string; error?: string };
  /** Inject the MCP-server-names file reader (tests). */
  readMcpServerNames?: () => { names: string[]; error?: string };
}

export interface SessionStartToolchainParityResult {
  /** Always 0 — a SessionStart hook must never break the session loop. */
  exitCode: number;
  /** Whether the `toolchain-parity:` ledger fact was written. */
  wrote: boolean;
  /** Resolved own profile name. */
  profile: string;
  /** Number of peer snapshots actually compared (readable + parseable). */
  peersCompared: number;
  /** Total drift items found across every compared peer. */
  driftCount: number;
  /**
   * Peer files present in the machine-state directory that failed to parse
   * as valid JSON (readable but not JSON, or JSON that fails the minimal
   * `profile`/`timestamp` shape check) and were therefore excluded from
   * `driftCount`/`peersCompared`. A non-zero count here means `driftCount`
   * reflects a PARTIAL comparison, not a full one — see the
   * `:unparseable-peer:<n>` ledger-content suffix this drives.
   *
   * The contrapositive does NOT hold: peers whose file could not be READ
   * at all (EACCES, EISDIR, ...) are skipped by the unreadable branch and
   * are not counted here, so the absence of the suffix does not prove a
   * complete comparison. That branch is scoped to the follow-up hardening
   * round (task c1b5ade5).
   */
  unparseablePeerCount: number;
  /** Resolved session id. */
  sessionId: string;
  sessionSource: "flag" | "stdin" | "env" | "transcript" | "default";
  /** Human-readable explanation of a non-write outcome, for diagnostics. */
  reason?: string;
}

function defaultMachineStateDir(): string {
  return path.join(os.homedir(), ".harness", "machine-state");
}

export async function runSessionStartToolchainParity(
  opts: SessionStartToolchainParityOptions = {},
): Promise<SessionStartToolchainParityResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const now = opts.now ?? new Date();
  const nodeTimeoutMs = opts.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  const npmTimeoutMs = opts.npmTimeoutMs ?? DEFAULT_NPM_GLOBALS_TIMEOUT_MS;
  const note = (msg: string): void => {
    stderr.write(`harness session-start toolchain-parity: ${msg}\n`);
  };
  const done = (
    wrote: boolean,
    profile: string,
    peersCompared: number,
    driftCount: number,
    sessionId: string,
    sessionSource: SessionStartToolchainParityResult["sessionSource"],
    reason?: string,
    unparseablePeerCount = 0,
  ): SessionStartToolchainParityResult => ({
    exitCode: 0,
    wrote,
    profile,
    peersCompared,
    driftCount,
    unparseablePeerCount,
    sessionId,
    sessionSource,
    ...(reason !== undefined && { reason }),
  });

  let event: SessionStartEvent;
  try {
    event = JSON.parse((await readStdin(stdin)).trim() || "{}") as SessionStartEvent;
  } catch (err) {
    const reason = `malformed event JSON: ${(err as Error).message}`;
    note(reason);
    return done(false, "", 0, 0, FALLBACK_SESSION, "default", reason);
  }

  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();

  // Session id resolution: same precedence chain as the two siblings, so
  // all three producers stay symmetric.
  const explicit =
    typeof opts.session === "string" && opts.session.length > 0
      ? opts.session
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? event.session_id
        : undefined;
  const resolveSession = opts.resolveSession ?? resolveReadSessionId;
  // Defensive (task c1b5ade5): a session resolver that throws (real or
  // injected) must degrade to the same FALLBACK_SESSION every OTHER "no
  // session known" path already uses, not crash a producer whose whole
  // contract is "never break the session loop". Unlike collectLocalSnapshot
  // below, this call is NOT part of the hermetic-spawn-guard contract, so
  // wrapping it here does not swallow a HermeticSpawnViolationError.
  let sessionId: string;
  try {
    sessionId = resolveSession(explicit, {});
  } catch (err) {
    note(
      `session id resolution failed: ${(err as Error).message}; falling back to session "${FALLBACK_SESSION}"`,
    );
    sessionId = FALLBACK_SESSION;
  }
  const sessionSource: SessionStartToolchainParityResult["sessionSource"] =
    typeof opts.session === "string" && opts.session.length > 0
      ? "flag"
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? "stdin"
        : sessionId === FALLBACK_SESSION
          ? "default"
          : (typeof process.env.CLAUDE_CODE_SESSION_ID === "string" &&
              process.env.CLAUDE_CODE_SESSION_ID === sessionId) ||
              (typeof process.env.CLAUDE_SESSION_ID === "string" &&
                process.env.CLAUDE_SESSION_ID === sessionId)
            ? "env"
            : "transcript";

  let manifest: Manifest;
  if (opts.manifest) {
    manifest = opts.manifest;
  } else {
    try {
      manifest = loadManifest(opts).manifest;
    } catch (err) {
      const reason = `manifest load failed: ${(err as Error).message}`;
      note(reason);
      return done(false, "", 0, 0, sessionId, sessionSource, reason);
    }
  }

  const config = manifest.toolchain_parity;
  if (!config.enabled) {
    const reason =
      "not configured (add `toolchain_parity: { enabled: true }` to harness.yaml); skipping";
    note(reason);
    return done(false, "", 0, 0, sessionId, sessionSource, reason);
  }

  const machineStateDir = config.machine_state_dir ?? defaultMachineStateDir();
  const profile = config.profile ?? sanitizeProfileName(os.hostname());
  const workspaceRoot = config.workspace_root ?? cwd;
  const sanitizedProfile = sanitizeProfileName(profile);
  const ownFileName = `${sanitizedProfile}.json`;
  // Advisory staleness threshold (AC3, task c1b5ade5): undefined disables
  // the check entirely, matching the schema's default-off comment.
  const staleAfterMs =
    config.stale_after_days !== undefined ? config.stale_after_days * 24 * 60 * 60 * 1000 : undefined;

  try {
    fs.mkdirSync(machineStateDir, { recursive: true });
  } catch (err) {
    const reason = `cannot create/access machine-state dir ${machineStateDir}: ${(err as Error).message}`;
    note(reason);
    return done(false, profile, 0, 0, sessionId, sessionSource, reason);
  }

  // Lossy-sanitization advisory (task c1b5ade5): a `profile` configured
  // with characters that are not filename-safe silently loses information
  // when sanitizeProfileName strips/replaces them. That is invisible to an
  // operator unless flagged — worse, two DIFFERENT configured profiles can
  // sanitize to the SAME filename (e.g. "mac/mini" and "mac-mini" both land
  // on "mac-mini.json"), in which case this run's write is about to
  // silently overwrite what looked like a peer's snapshot. Both cases are
  // advisory-only: this producer still writes its own snapshot and
  // continues normally either way.
  if (sanitizedProfile !== profile) {
    note(
      `configured profile "${profile}" is not filename-safe; using sanitized "${sanitizedProfile}" for the snapshot file (${ownFileName})`,
    );
    try {
      const existingRaw = fs.readFileSync(path.join(machineStateDir, ownFileName), "utf8");
      const existingParsed = parseSnapshotJson(existingRaw);
      if (existingParsed.ok && existingParsed.snapshot.profile !== profile) {
        note(
          `WARNING: sanitized filename "${ownFileName}" collides with an existing snapshot for a DIFFERENT profile ("${existingParsed.snapshot.profile}"); this run's write is about to overwrite it`,
        );
      }
    } catch {
      // No existing file for this sanitized name yet (first run for this
      // profile), or it is unreadable — nothing to warn about here;
      // writeOwnSnapshot below reports its own write failures separately.
    }
  }

  const runNodeVersion = opts.runNodeVersion ?? realNodeVersionSpawn;
  const runNpmGlobals = opts.runNpmGlobals ?? realNpmGlobalsSpawn;
  const readOwKitVersion = opts.readOwKitVersion ?? realReadOwKitVersion;
  const readMcpServerNames = opts.readMcpServerNames ?? realReadMcpServerNames;

  const { snapshot: localSnapshot, notes } = await collectLocalSnapshot({
    profile,
    now,
    workspaceRoot,
    nodeTimeoutMs,
    npmTimeoutMs,
    runNodeVersion,
    runNpmGlobals,
    readOwKitVersion,
    readMcpServerNames,
  });
  for (const n of notes) note(n);

  const written = writeOwnSnapshot(machineStateDir, ownFileName, localSnapshot);
  if (!written.ok) {
    note(`could not write own snapshot: ${written.reason}`);
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(machineStateDir);
  } catch (err) {
    const reason = `cannot list machine-state dir ${machineStateDir}: ${(err as Error).message}`;
    note(reason);
    return done(false, profile, 0, 0, sessionId, sessionSource, reason);
  }
  const peerFiles = entries.filter((name) => name.endsWith(".json") && name !== ownFileName).sort();

  if (peerFiles.length === 0) {
    const reason = `no peer snapshots found in ${machineStateDir}; nothing to compare (normal for the first machine, or before any peer has run this companion)`;
    note(reason);
    return done(false, profile, 0, 0, sessionId, sessionSource, reason);
  }

  let peersCompared = 0;
  let driftTotal = 0;
  // Peer files that were present but failed to parse as valid JSON —
  // AC2 (task 690fba7c): these must not vanish silently from `drift:N`, so
  // their (file-derived) labels are surfaced both as a distinct stderr tag
  // and as a `:unparseable-peer:<n>` suffix on the ledger fact below.
  const unparseablePeers: string[] = [];
  for (const fileName of peerFiles) {
    const filePath = path.join(machineStateDir, fileName);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      note(`peer snapshot ${fileName} unreadable: ${(err as Error).message}`);
      continue;
    }
    const parsed = parseSnapshotJson(raw);
    if (!parsed.ok) {
      // The profile field itself failed to parse, so the filename (minus
      // its `.json` suffix) is the best available peer identifier — it is
      // exactly `sanitizeProfileName(profile)` for any file this producer
      // itself wrote. Files this producer did NOT write are untrusted
      // input (the machine-state dir is populated cross-machine by sync),
      // so the label is re-sanitized before it is interpolated into the
      // greppable stderr tag: a crafted filename must not be able to
      // forge a standalone parity line. The `|| fileName` keeps a
      // degenerate name like a literal `.json` from producing an empty
      // label.
      const peerLabel = sanitizeProfileName(fileName.replace(/\.json$/, "") || fileName);
      note(`peer snapshot ${fileName} is corrupt: ${parsed.reason}`);
      note(`parity:unparseable-peer:${peerLabel}`);
      unparseablePeers.push(peerLabel);
      continue;
    }
    const comparison = compareToPeer(localSnapshot, parsed.snapshot, now);
    peersCompared += 1;
    driftTotal += comparison.drift.length;
    const age = formatSnapshotAge(comparison.ageMs);
    if (comparison.drift.length === 0) {
      note(`ok against ${comparison.peerProfile} (snapshot age ${age})`);
    } else {
      note(`drift:${comparison.drift.length} against ${comparison.peerProfile} (snapshot age ${age})`);
      for (const item of comparison.drift) note(`drift — ${item.message}`);
    }
    // AC3 (task c1b5ade5): a stale peer is a trustworthiness CAVEAT on the
    // comparison above, not a drift finding — it never touches driftTotal.
    // Only fires when `stale_after_days` is explicitly configured.
    if (staleAfterMs !== undefined && comparison.ageMs > staleAfterMs) {
      note(
        `peer ${comparison.peerProfile} snapshot is stale (age ${age}, exceeds the configured ${config.stale_after_days}d threshold); its comparison may not reflect that machine's CURRENT toolchain`,
      );
    }
  }

  if (peersCompared === 0) {
    const reason = `no comparable peer snapshots (all ${peerFiles.length} peer file(s) in ${machineStateDir} were unreadable/corrupt)`;
    note(reason);
    return done(false, profile, 0, 0, sessionId, sessionSource, reason, unparseablePeers.length);
  }

  // AC2 (task 690fba7c): a non-zero `unparseablePeers` count means the
  // comparison below is PARTIAL, so it is appended to the ledger fact
  // itself — the artifact an operator is most likely to read after the
  // fact via `harness audit` — not just to the stderr notes above. Absent
  // any unparseable peer, `content` is byte-identical to the pre-existing
  // format (AC3: no behaviour change for the all-valid-peers case).
  const unparseableSuffix =
    unparseablePeers.length > 0 ? `:unparseable-peer:${unparseablePeers.length}` : "";
  const content =
    (driftTotal === 0 ? "toolchain-parity:ok" : `toolchain-parity:drift:${driftTotal}`) + unparseableSuffix;

  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    // Defensive (task c1b5ade5): resolveManifestLedgerWriter is currently a
    // pure function that always returns a discriminated result rather than
    // throwing, but that is an implementation detail of its own, not a
    // contract this call site should lean on — a future change to it (or
    // to findGroundingMcp/mcpCommandList underneath) throwing would
    // otherwise crash a producer whose whole contract is "never break the
    // session loop".
    let resolved: ReturnType<typeof resolveManifestLedgerWriter>;
    try {
      resolved = resolveManifestLedgerWriter(manifest, {
        ...(opts.ledgerTimeoutMs !== undefined ? { ledgerTimeoutMs: opts.ledgerTimeoutMs } : {}),
      });
    } catch (err) {
      const reason = `resolveManifestLedgerWriter threw: ${(err as Error).message}; cannot record ${content}`;
      note(reason);
      return done(false, profile, peersCompared, driftTotal, sessionId, sessionSource, reason, unparseablePeers.length);
    }
    if (!resolved.ok) {
      const reason = `${resolved.reason}; cannot record ${content}`;
      note(reason);
      return done(false, profile, peersCompared, driftTotal, sessionId, sessionSource, reason, unparseablePeers.length);
    }
    writeLedger = resolved.write;
  }

  // Defensive (task c1b5ade5): an injected or real writeLedger that REJECTS
  // instead of resolving to `{ ok: false, reason }` must degrade the same
  // way the `!result.ok` branch below already does, not propagate as an
  // unhandled rejection out of a SessionStart hook.
  let result: { ok: boolean; reason?: string };
  try {
    result = await writeLedger({ sessionId, content, source: LEDGER_SOURCE });
  } catch (err) {
    const reason = `ledger write threw: ${(err as Error).message}`;
    note(reason);
    return done(false, profile, peersCompared, driftTotal, sessionId, sessionSource, reason, unparseablePeers.length);
  }
  if (!result.ok) {
    const reason = `ledger write failed: ${result.reason ?? "unknown error"}`;
    note(reason);
    return done(false, profile, peersCompared, driftTotal, sessionId, sessionSource, reason, unparseablePeers.length);
  }
  note(`recorded ${content} for session ${sessionId}`);
  if (sessionSource === "default") {
    note(
      "WARNING: session resolved to the literal \"default\". This tag is audit-only (no gate " +
        "consumes toolchain-parity: yet), but pipe SessionStart event JSON on stdin, export " +
        "$CLAUDE_SESSION_ID, or pass --session <id> for manual / scripted use to keep the audit trail useful.",
    );
  }
  return done(true, profile, peersCompared, driftTotal, sessionId, sessionSource, undefined, unparseablePeers.length);
}
