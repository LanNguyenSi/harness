import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { withFileLock } from "../../io/lock.js";
import { unifiedDiff } from "../../io/patch.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { parseManifest, type McpServer } from "../../schema/index.js";
import { applyAdd, type McpEntry as McpAddEntry } from "../add/mutate.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { readTopLevelMcpServers, resolveClaudeUserRegistryPath } from "../../io/claude-mcp.js";
import {
  computeDrift,
  computeMcpDrift,
  manifestMcpProjection,
  manifestProjection,
  parseSettingsHooks,
  parseSettingsMcpServers,
  projectRegistryMcpServers,
  synthesizeName,
  type DerivedHook,
  type DerivedMcp,
} from "./derive.js";

export interface AdoptOptions {
  configPath?: string;
  homeDir?: string;
  yes?: boolean;
  /** Optional injection point for tests; defaults to readline against stdin. */
  prompt?: (message: string) => Promise<string>;
  /**
   * Test seam mirroring `approve risk` / `pause`: overrides the
   * `process.stdin.isTTY` read that decides whether the default
   * confirmation prompt may run, so the non-TTY refusal can be
   * exercised hermetically.
   */
  stdinIsTTY?: boolean;
  /**
   * Test seam (D-101/D-102, task 83d8d03a): explicit override for the
   * Claude Code user-scope MCP registry file (~/.claude.json /
   * $CLAUDE_CONFIG_DIR/.claude.json) `adopt` reads READ-ONLY to compute
   * MCP drift. Takes precedence over `env`. Production callers leave this
   * unset; the CLI never needs to pass it since the real registry always
   * lives at the resolved default path.
   */
  registryPath?: string;
  /**
   * Override for process.env (CLAUDE_CONFIG_DIR lookup) used to resolve
   * the default registry path when `registryPath` is not given. Defaults
   * to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

export interface AdoptResult {
  manifestPath: string;
  settingsPath: string;
  driftCount: number;
  /** Hook entries adopted (subset of driftCount). */
  hookDriftCount: number;
  /** MCP entries adopted (subset of driftCount). */
  mcpDriftCount: number;
  /** The unified diff of the proposed change. Empty when nothing to adopt. */
  diff: string;
  applied: boolean;
  /** Names synthesised for the new hook entries. */
  adoptedNames: string[];
  /** Names of MCP entries adopted (new) or replaced (modified). */
  adoptedMcpNames: string[];
  /** Names of MCP entries replaced (existed in manifest, content differed). */
  replacedMcpNames: string[];
  /** Human-readable status: "no-drift" | "declined" | "applied". */
  outcome: "no-drift" | "declined" | "applied";
  /**
   * Names present in a legacy/dead top-level `mcpServers` block inside
   * `settingsPath` (D-101, task 83d8d03a). Claude Code does not read this
   * file for MCP registration at runtime (io/claude-mcp.ts:1-9) — this is
   * surfaced purely as a cleanup hint, NEVER as a source of `mcpDrift`.
   * Sorted; empty when `settingsPath` has no such block.
   */
  deadSettingsMcpNames: string[];
  /**
   * Set when the effective MCP registry file could not be read safely
   * (malformed JSON, `mcpServers` not an object — an ENOENT/missing file
   * is NOT an error and leaves this unset). MCP drift is computed against
   * an empty registry projection in that case rather than guessing.
   */
  registryReadError?: string;
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveManifestPath(opts: AdoptOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(
    resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path,
    DEFAULT_BASENAME,
  );
}

// Callers must guard non-TTY stdin BEFORE invoking this (see the
// confirmation block in `adopt`): readline on a non-TTY stdin blocks
// forever waiting for input that never comes.
async function defaultPrompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

export async function adopt(
  settingsPath: string,
  opts: AdoptOptions = {},
): Promise<AdoptResult> {
  const manifestPath = resolveManifestPath(opts);
  if (!fs.existsSync(manifestPath)) {
    throw new HarnessExitError(
      `harness manifest not found at ${manifestPath}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }
  if (!fs.existsSync(settingsPath)) {
    throw new HarnessExitError(
      `cannot adopt: file does not exist: ${settingsPath}`,
      EX_NOINPUT,
    );
  }

  const originalYaml = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(parseYaml(originalYaml));
  const projection = manifestProjection(manifest);

  let settingsRaw: unknown;
  try {
    settingsRaw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (e) {
    throw new HarnessExitError(
      `cannot adopt: ${settingsPath} is not valid JSON: ${(e as Error).message}`,
      EX_FAIL,
    );
  }

  const settingsHooks = parseSettingsHooks(settingsRaw);
  const drift = computeDrift(settingsHooks, projection);

  // D-101: MCP drift is ALWAYS computed against the effective Claude Code
  // user-scope registry (read-only top-level `mcpServers` of
  // ~/.claude.json / $CLAUDE_CONFIG_DIR/.claude.json), regardless of
  // `settingsPath` — Claude Code does not consume settings.json's
  // `mcpServers` block at runtime (io/claude-mcp.ts:1-9). `settingsPath`
  // remains the source for hook adoption above. A dead `mcpServers` block
  // in `settingsPath`, if present, is still surfaced (`deadSettingsMcpNames`)
  // as a cleanup hint but never feeds `mcpDrift`.
  const deadSettingsMcpNames = parseSettingsMcpServers(settingsRaw)
    .map((m) => m.name)
    .sort();

  const registryPath = opts.registryPath ?? resolveClaudeUserRegistryPath({ env: opts.env });
  const { servers: registryServers, error: registryReadError } =
    readTopLevelMcpServers(registryPath);
  const registryMcp = projectRegistryMcpServers(registryServers);
  const mcpProjection = manifestMcpProjection(manifest);
  const mcpDrift = computeMcpDrift(registryMcp, mcpProjection);

  if (drift.length === 0 && mcpDrift.length === 0) {
    return {
      manifestPath,
      settingsPath,
      driftCount: 0,
      hookDriftCount: 0,
      mcpDriftCount: 0,
      diff: "",
      applied: false,
      adoptedNames: [],
      adoptedMcpNames: [],
      replacedMcpNames: [],
      outcome: "no-drift",
      deadSettingsMcpNames,
      ...(registryReadError !== null ? { registryReadError } : {}),
    };
  }

  const taken = new Set(manifest.hooks.map((h) => h.name));
  const adoptedNames: string[] = [];
  let proposedYaml = originalYaml;
  for (const d of drift) {
    const name = synthesizeName(d, taken);
    taken.add(name);
    adoptedNames.push(name);
    proposedYaml = applyAdd(proposedYaml, {
      type: "hook",
      entry: buildHookEntry(name, d),
    });
  }

  const adoptedMcpNames: string[] = [];
  const replacedMcpNames: string[] = [];
  // Preserve manifest-only fields when replacing an existing entry —
  // `buildMcpEntry` is the single source of truth for exactly which
  // fields are carried forward and why.
  const manifestByName = new Map(manifest.tools.mcp.map((m) => [m.name, m]));
  for (const m of mcpDrift) {
    if (m.reason === "modified") replacedMcpNames.push(m.entry.name);
    adoptedMcpNames.push(m.entry.name);
    proposedYaml = applyAdd(proposedYaml, {
      type: "mcp_replace",
      name: m.entry.name,
      entry: buildMcpEntry(m.entry, manifestByName.get(m.entry.name)),
    });
  }

  const diff = unifiedDiff({
    fileName: path.basename(manifestPath),
    oldText: originalYaml,
    newText: proposedYaml,
    oldHeader: "current",
    newHeader: "proposed",
  });

  // Defence-in-depth gate. From a happy-path adopt (well-formed input manifest +
  // well-formed settings.json) every synthesised hook field is already
  // schema-valid by construction (event from KNOWN_EVENTS, non-empty command,
  // disambiguated name, blocking:false). The gate is here to catch structural
  // bugs in synthesizeName / applyAdd that future maintainers might introduce.
  const validation = validateBeforeWrite(parseYaml(proposedYaml));
  if (!validation.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(validation.errors)}`,
      EX_FAIL,
    );
  }

  if (!opts.yes) {
    // Non-TTY stdin (CI, agent-driven shells) cannot answer the default
    // readline prompt; refuse loudly and name the escape hatch instead
    // of blocking forever (harness-discovery H4). Injected prompts are
    // exempt: they answer without stdin.
    if (opts.prompt === undefined && !(opts.stdinIsTTY ?? process.stdin.isTTY)) {
      throw new HarnessExitError(
        "confirmation required but stdin is not a TTY; re-run with --yes to confirm non-interactively",
        EX_FAIL,
      );
    }
    const promptFn = opts.prompt ?? defaultPrompt;
    const answer = (await promptFn(`${diff}\nApply (y/N)? `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return {
        manifestPath,
        settingsPath,
        driftCount: drift.length + mcpDrift.length,
        hookDriftCount: drift.length,
        mcpDriftCount: mcpDrift.length,
        diff,
        applied: false,
        adoptedNames,
        adoptedMcpNames,
        replacedMcpNames,
        outcome: "declined",
        deadSettingsMcpNames,
        ...(registryReadError !== null ? { registryReadError } : {}),
      };
    }
  }

  const lockPath = path.join(path.dirname(manifestPath), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    const current = fs.readFileSync(manifestPath, "utf8");
    let next = current;
    const currentManifest = parseManifest(parseYaml(current));
    const lockTaken = new Set(currentManifest.hooks.map((h) => h.name));
    for (let i = 0; i < drift.length; i++) {
      const d = drift[i]!;
      const name = adoptedNames[i]!;
      // If a concurrent adopt landed the same drift, skip silently rather than
      // duplicating. This makes adopt idempotent across repeated runs.
      // KNOWN GAP: a concurrent adopt that resolved the same drift to a
      // *different* name (e.g. our `foo` vs their `foo-2`) would NOT be caught
      // here — both would land as separate hooks with different names. Schema
      // accepts it (no name collision), but the manifest contains two entries
      // pointing at the same command. Acceptable rarity for Phase 2; revisit
      // when a SHA-based drift identity ships in Phase 3 alongside harness.lock.
      if (lockTaken.has(name)) continue;
      next = applyAdd(next, { type: "hook", entry: buildHookEntry(name, d) });
      lockTaken.add(name);
    }
    // MCP entries adopt as replace-or-append (keyed by name), so re-applying
    // the same drift under the lock is naturally idempotent: the same name
    // gets the same replacement. Use the freshly-read manifest's entries
    // for the field-preservation merge, in case a concurrent adopt added
    // health/enabled to the same name in between.
    const lockedMcpByName = new Map(currentManifest.tools.mcp.map((m) => [m.name, m]));
    for (const m of mcpDrift) {
      next = applyAdd(next, {
        type: "mcp_replace",
        name: m.entry.name,
        entry: buildMcpEntry(m.entry, lockedMcpByName.get(m.entry.name)),
      });
    }
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(manifestPath, next);
  });

  return {
    manifestPath,
    settingsPath,
    driftCount: drift.length + mcpDrift.length,
    hookDriftCount: drift.length,
    mcpDriftCount: mcpDrift.length,
    diff,
    applied: true,
    adoptedNames,
    adoptedMcpNames,
    replacedMcpNames,
    outcome: "applied",
    deadSettingsMcpNames,
    ...(registryReadError !== null ? { registryReadError } : {}),
  };
}

function buildMcpEntry(
  d: DerivedMcp,
  existing: McpServer | undefined,
): McpAddEntry {
  const entry: McpAddEntry = {
    name: d.name,
    command: [...d.command],
  };
  if (d.env && Object.keys(d.env).length > 0) entry.env = { ...d.env };
  // Carry forward the manifest-only fields — exactly these four:
  // `health` (doctor / probe / policy paths), `enabled: false` (explicit
  // opt-out), `min_version` and `version_command` (doctor's version
  // probe floor, task 059b669c). settings.json's mcpServers shape has no
  // projection for any of them, so a pure replace from the projected
  // drift would silently wipe them. `enabled: true` is the schema
  // default and is omitted to keep the re-emitted YAML clean.
  if (existing) {
    if (existing.health) entry.health = { ...existing.health };
    if (existing.enabled === false) entry.enabled = false;
    if (existing.min_version !== undefined) entry.min_version = existing.min_version;
    if (existing.version_command !== undefined) {
      entry.version_command = [...existing.version_command];
    }
  }
  return entry;
}

function buildHookEntry(
  name: string,
  d: DerivedHook,
): {
  name: string;
  event: string;
  command: string;
  match?: string;
  blocking: false;
  budget_ms?: number;
} {
  // Adopted hooks default to non-blocking so the captured entry doesn't
  // unexpectedly start gating tool calls. The user can promote to soft/hard
  // explicitly if they want enforcement. (Blocking is harness-internal —
  // settings.json has no equivalent field — so it is genuinely not
  // inferable from the adopted source; `timeout` IS captured and becomes
  // `budget_ms`, task 059b669c.) UNIT: `d.timeout` is settings.json's
  // SECONDS value (see DerivedHook.timeout in ./derive.ts); `budget_ms` is
  // milliseconds, so it is multiplied by 1000 here, the inverse of
  // apply's `hookTimeoutSeconds` (generate-settings.ts), fixed alongside
  // this in task 7bf47554.
  const entry: {
    name: string;
    event: string;
    command: string;
    match?: string;
    blocking: false;
    budget_ms?: number;
  } = {
    name,
    event: d.event,
    command: d.command,
    blocking: false,
  };
  if (d.match !== undefined) entry.match = d.match;
  if (d.timeout !== undefined) entry.budget_ms = d.timeout * 1000;
  return entry;
}
