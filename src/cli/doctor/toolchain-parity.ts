// Toolchain-parity doctor section (task 13919613, doctor companion to
// `harness session-start toolchain-parity`). Reuses the Collector +
// Comparator core straight from src/cli/session-start/toolchain-parity.ts
// (`collectLocalSnapshot`, `compareToPeer`, `parseSnapshotJson`,
// `formatSnapshotAge`, the real collectors, `sanitizeProfileName`,
// `defaultMachineStateDir`) — see that module's header for the full
// rationale of what each collected field means and how a peer comparison
// is computed. No comparison logic is re-implemented here.
//
// Unlike the SessionStart producer, this check is READ-ONLY: it never
// writes a snapshot file (that stays the producer's job — the thing that
// actually keeps the machine-state directory populated for every OTHER
// machine to compare against) and never touches the ledger. It only
// answers "if I compared my current live toolchain against whatever peer
// snapshots already exist, right now, what would I see?" — an on-demand
// read of the same comparison SessionStart runs automatically.
//
// Advisory only: drift is always a warning, never an error, and this is
// not any kind of gate (constraint carried over verbatim from the
// producer's own contract).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Manifest } from "../../schema/index.js";
import {
  collectLocalSnapshot,
  compareToPeer,
  defaultMachineStateDir,
  formatSnapshotAge,
  parseSnapshotJson,
  realNodeVersionSpawn,
  realNpmGlobalsSpawn,
  realReadMcpServerNames,
  realReadOwKitVersion,
  sanitizeProfileName,
  type CollectNodeVersionResult,
  type CollectNpmGlobalsResult,
  type DriftItem,
} from "../session-start/toolchain-parity.js";

// Same ceilings as the producer's own defaults (see that module's
// timeout-constants comment for the full budget derivation) — doctor
// pays the same worst-case spawn cost when it actually collects.
const DEFAULT_NODE_TIMEOUT_MS = 2_000;
const DEFAULT_NPM_GLOBALS_TIMEOUT_MS = 4_000;

/** One peer comparison, ready to render. Mirrors `PeerComparison` (session-start) plus a `status` roll-up for `countDiagnostics`. */
export interface ToolchainParityPeerReport {
  peerProfile: string;
  /** `"drift"` is the only status that rolls into `warningCount` (see `countDiagnostics` in index.ts). */
  status: "ok" | "drift";
  driftCount: number;
  ageMs: number;
  /** `formatSnapshotAge(ageMs)` — human-scannable ("just now" / "3h" / "2d"). */
  ageLabel: string;
  drift: DriftItem[];
}

export interface ToolchainParitySection {
  /**
   * `"skipped"`: `--shallow` suppressed the live collection (no spawn).
   * `"no-peers"`: configured, but no comparable peer snapshot exists yet
   * (none present, or every present peer file was unreadable/corrupt).
   * `"ok"` / `"drift"`: at least one peer was compared.
   * All four are advisory — only `"drift"` peers roll into warningCount;
   * none of the four ever roll into errorCount.
   */
  status: "skipped" | "no-peers" | "ok" | "drift";
  message: string;
  /** This machine's resolved `toolchain_parity.profile` (post-sanitization). */
  profile: string;
  /** Empty for `"skipped"` / `"no-peers"`. */
  peers: ToolchainParityPeerReport[];
  /** Sum of `peers[].driftCount`. */
  driftTotal: number;
  /**
   * Peer files present in the machine-state directory that failed to
   * parse as a valid snapshot (informational only — never rolls into
   * `driftTotal` or any diagnostic counter, mirroring the producer's own
   * `unparseablePeerCount` treatment).
   */
  unparseablePeers: string[];
}

export interface RunDoctorToolchainParityOptions {
  /** Skips the live collection (no `node`/`npm` spawn) — mirrors `npmGlobalBin` / `claudeMcp`'s shallow behaviour. */
  shallow?: boolean;
  /** Overrides `toolchain_parity.workspace_root`'s fallback. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Overrides "now" for deterministic snapshot-age tests. */
  now?: Date;
  nodeTimeoutMs?: number;
  npmTimeoutMs?: number;
  /** Inject the `node --version` collector (tests) — see `realNodeVersionSpawn`'s doc in the session-start module. */
  runNodeVersion?: (timeoutMs: number) => Promise<CollectNodeVersionResult>;
  /** Inject the `npm ls -g` collector (tests) — see `realNpmGlobalsSpawn`'s doc in the session-start module. */
  runNpmGlobals?: (timeoutMs: number) => Promise<CollectNpmGlobalsResult>;
  /** Inject the OW-Kit-version file reader (tests). */
  readOwKitVersion?: (workspaceRoot: string) => { version?: string; error?: string };
  /** Inject the MCP-server-names file reader (tests). */
  readMcpServerNames?: () => { names: string[]; error?: string };
}

/**
 * A peer JSON filename (minus its `.json` suffix) is untrusted,
 * cross-machine-synced content (agent-memory-sync populates this
 * directory from other machines) — the same class of content the
 * producer's `note()` choke point CR/LF-strips before ever reaching a
 * stderr line (task c1b5ade5 R2b). This module hands its section back as
 * STRUCTURED data (profile strings, drift `message` strings assembled by
 * the reused `compareToPeer`), so the equivalent choke point lives at the
 * doctor FORMAT layer (`formatToolchainParitySection` in format.ts) —
 * every string this section produces that could carry a peer-controlled
 * value gets CR/LF-stripped there, at the point it actually becomes
 * terminal output, not here.
 */
function peerLabelFromFileName(fileName: string): string {
  return fileName.replace(/\.json$/, "") || fileName;
}

export async function runDoctorToolchainParity(
  manifest: Manifest,
  opts: RunDoctorToolchainParityOptions = {},
): Promise<ToolchainParitySection> {
  const config = manifest.toolchain_parity;
  const now = opts.now ?? new Date();
  const cwd = opts.cwd ?? process.cwd();
  const machineStateDir = config.machine_state_dir ?? defaultMachineStateDir();
  const profile = config.profile ?? sanitizeProfileName(os.hostname());
  const sanitizedProfile = sanitizeProfileName(profile);
  const ownFileName = `${sanitizedProfile}.json`;
  const workspaceRoot = config.workspace_root ?? cwd;

  const noPeers = (message: string): ToolchainParitySection => ({
    status: "no-peers",
    message,
    profile,
    peers: [],
    driftTotal: 0,
    unparseablePeers: [],
  });

  // Peer-existence check runs BEFORE any collection: there is nothing to
  // compare the local live snapshot against without at least one peer
  // file, so this order avoids paying the node/npm spawn cost (and, in
  // `--shallow` mode, avoids the spawn-skip branch entirely having to be
  // reached) in the common "first machine, no peer has run session-start
  // toolchain-parity yet" case.
  let entries: string[];
  try {
    entries = fs.readdirSync(machineStateDir);
  } catch {
    return noPeers(
      `no peer snapshots found (machine-state dir ${machineStateDir} does not exist yet); ` +
        "normal for the first machine, or before any peer has run `harness session-start toolchain-parity`",
    );
  }
  const peerFiles = entries.filter((name) => name.endsWith(".json") && name !== ownFileName).sort();
  if (peerFiles.length === 0) {
    return noPeers(
      `no peer snapshots found in ${machineStateDir}; nothing to compare (normal for the first ` +
        "machine, or before any peer has run `harness session-start toolchain-parity`)",
    );
  }

  if (opts.shallow) {
    return {
      status: "skipped",
      message: "harness doctor --shallow does not collect a live toolchain snapshot to compare",
      profile,
      peers: [],
      driftTotal: 0,
      unparseablePeers: [],
    };
  }

  const runNodeVersion = opts.runNodeVersion ?? realNodeVersionSpawn;
  const runNpmGlobals = opts.runNpmGlobals ?? realNpmGlobalsSpawn;
  const readOwKitVersion = opts.readOwKitVersion ?? realReadOwKitVersion;
  const readMcpServerNames = opts.readMcpServerNames ?? realReadMcpServerNames;

  const { snapshot: localSnapshot } = await collectLocalSnapshot({
    profile,
    now,
    workspaceRoot,
    nodeTimeoutMs: opts.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
    npmTimeoutMs: opts.npmTimeoutMs ?? DEFAULT_NPM_GLOBALS_TIMEOUT_MS,
    runNodeVersion,
    runNpmGlobals,
    readOwKitVersion,
    readMcpServerNames,
  });

  const peers: ToolchainParityPeerReport[] = [];
  const unparseablePeers: string[] = [];
  let driftTotal = 0;
  for (const fileName of peerFiles) {
    const filePath = path.join(machineStateDir, fileName);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      unparseablePeers.push(peerLabelFromFileName(fileName));
      continue;
    }
    const parsed = parseSnapshotJson(raw);
    if (!parsed.ok) {
      unparseablePeers.push(peerLabelFromFileName(fileName));
      continue;
    }
    const comparison = compareToPeer(localSnapshot, parsed.snapshot, now);
    driftTotal += comparison.drift.length;
    peers.push({
      peerProfile: comparison.peerProfile,
      status: comparison.drift.length === 0 ? "ok" : "drift",
      driftCount: comparison.drift.length,
      ageMs: comparison.ageMs,
      ageLabel: formatSnapshotAge(comparison.ageMs),
      drift: comparison.drift,
    });
  }

  if (peers.length === 0) {
    return {
      ...noPeers(
        `no comparable peer snapshots (all ${peerFiles.length} peer file(s) in ${machineStateDir} ` +
          "were unreadable/corrupt)",
      ),
      unparseablePeers,
    };
  }

  return {
    status: driftTotal === 0 ? "ok" : "drift",
    message:
      driftTotal === 0
        ? `toolchain parity ok against ${peers.length} peer(s)`
        : `${driftTotal} drift item(s) found across ${peers.length} peer(s)`,
    profile,
    peers,
    driftTotal,
    unparseablePeers,
  };
}
