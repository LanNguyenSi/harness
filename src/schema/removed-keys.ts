// Manifest posture for removed keys and removed packs: warn and ignore,
// never reject (task a4d8adc5).
//
// `ManifestSchema` is `.strict()`, so a key the schema no longer declares
// would fail the whole load. Every hook loads the manifest, and the
// branch-protection hook refuses every edit when the load fails, so a machine
// whose manifest still carries a key a newer release removed would lock
// itself out the moment the new release is installed. Instead the table below
// names every removed manifest path and every removed pack name; matching
// entries are stripped from the raw manifest before the strict parse and
// returned as warnings (`harness validate`, `harness doctor` and `harness
// apply` print them, `harness validate --strict` fails on them). A key that was
// never valid is not in the table and still fails the parse.
//
// Removed CLI commands (REMOVED_COMMANDS below) are not stripped: a hook or
// policy that still calls one parses fine, so `findRemovedCommandUses` reports
// each such site through the same warning channel.

/** A manifest path a release removed. */
export interface RemovedManifestPath {
  /** Dotted path from the manifest root, e.g. `grounding.policies_source`. */
  path: string;
  /** The release that removed it. */
  removedIn: string;
  /** One line on why it went. */
  reason: string;
}

/** A builtin pack name a release removed. */
export interface RemovedPackName {
  name: string;
  removedIn: string;
  reason: string;
}

export interface RemovedManifestTable {
  paths: readonly RemovedManifestPath[];
  packs: readonly RemovedPackName[];
}

export const REMOVED_MANIFEST_PATHS: readonly RemovedManifestPath[] = [
  {
    path: "grounding.evidence_ledger.retention_days",
    removedIn: "1.0.0",
    reason: "reserved and never consumed: evidence-ledger implements no retention pruning",
  },
  {
    path: "grounding.policies_source",
    removedIn: "1.0.0",
    reason: "reserved and never consumed: policies live in policies[] / policy_packs[]",
  },
  {
    path: "session_start_preflight",
    removedIn: "1.0.0",
    reason: "the session-start preflight producer is removed",
  },
  {
    path: "toolchain_parity",
    removedIn: "1.0.0",
    reason: "the session-start toolchain-parity producer is removed",
  },
  {
    path: "stale_base_check",
    removedIn: "1.0.0",
    reason: "the session-start stale-base-check producer is removed",
  },
  {
    path: "permission_profiles",
    removedIn: "1.0.0",
    reason: "only the removed understanding-gate pack consumed permission profiles",
  },
];

export const REMOVED_PACK_NAMES: readonly RemovedPackName[] = [
  {
    name: "post-merge-gate",
    removedIn: "1.0.0",
    reason: "opt-in ledger-backed gate removed with the harness simplification",
  },
  {
    name: "solution-acceptance",
    removedIn: "1.0.0",
    reason: "opt-in verdict-gated completion gate removed with the harness simplification",
  },
  {
    name: "understanding-before-execution",
    removedIn: "1.0.0",
    reason: "the understanding-gate pack is removed with the harness simplification",
  },
];

export const REMOVED_MANIFEST_TABLE: RemovedManifestTable = {
  paths: REMOVED_MANIFEST_PATHS,
  packs: REMOVED_PACK_NAMES,
};

/** One stripped entry, for display. */
export interface ManifestPostureWarning {
  /** Where it was found (`grounding.policies_source`, `policy_packs[2]`). */
  path: string;
  message: string;
}

export interface StrippedManifest {
  raw: unknown;
  warnings: ManifestPostureWarning[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Remove the key at `segments` from `node`, copying every object on the way
 * so the caller's raw manifest is never mutated. Returns the new node and
 * whether a key was removed. A path through anything but plain objects is
 * left alone (the strict parse then reports whatever is wrong there).
 */
function withoutPath(node: unknown, segments: readonly string[]): { node: unknown; removed: boolean } {
  if (!isPlainObject(node) || segments.length === 0) return { node, removed: false };
  const [head, ...rest] = segments as [string, ...string[]];
  if (!Object.prototype.hasOwnProperty.call(node, head)) return { node, removed: false };
  if (rest.length === 0) {
    const copy: Record<string, unknown> = { ...node };
    delete copy[head];
    return { node: copy, removed: true };
  }
  const inner = withoutPath(node[head], rest);
  if (!inner.removed) return { node, removed: false };
  return { node: { ...node, [head]: inner.node }, removed: true };
}

/**
 * Strip every removed manifest path and every removed pack entry from a raw
 * (merged, not yet parsed) manifest. Pure: `raw` is not modified.
 */
export function stripRemovedManifestEntries(
  raw: unknown,
  table: RemovedManifestTable = REMOVED_MANIFEST_TABLE,
): StrippedManifest {
  const warnings: ManifestPostureWarning[] = [];
  let current = raw;
  for (const entry of table.paths) {
    const r = withoutPath(current, entry.path.split("."));
    if (r.removed) {
      current = r.node;
      warnings.push({
        path: entry.path,
        message: `removed in ${entry.removedIn} and ignored (${entry.reason}); delete it from the manifest`,
      });
    }
  }
  if (isPlainObject(current) && Array.isArray(current["policy_packs"]) && table.packs.length > 0) {
    const packs = current["policy_packs"] as unknown[];
    const kept: unknown[] = [];
    packs.forEach((pack, i) => {
      const name = isPlainObject(pack) ? pack["name"] : undefined;
      const removed = typeof name === "string" ? table.packs.find((p) => p.name === name) : undefined;
      if (removed === undefined) {
        kept.push(pack);
        return;
      }
      warnings.push({
        path: `policy_packs[${i}]`,
        message: `pack "${removed.name}" was removed in ${removed.removedIn} and is skipped (${removed.reason}); delete the entry from the manifest`,
      });
    });
    if (kept.length !== packs.length) current = { ...current, policy_packs: kept };
  }
  return { raw: current, warnings };
}

/** One line per warning, as `harness validate` / `harness doctor` print it. */
export function formatPostureWarning(w: ManifestPostureWarning): string {
  return `${w.path}: ${w.message}`;
}

/** A CLI command prefix a release removed (a generated hook or producer that still calls it fails). */
export interface RemovedCommand {
  /** Command prefix as it appears in a hook or producer `command`, e.g. `harness session-start`. */
  command: string;
  removedIn: string;
  reason: string;
}

export const REMOVED_COMMANDS: readonly RemovedCommand[] = [
  { command: "harness session-start", removedIn: "1.0.0", reason: "the SessionStart producers are removed" },
  { command: "harness preflight", removedIn: "1.0.0", reason: "alias of the removed session-start preflight producer" },
  { command: "harness pack hook post-merge-gate", removedIn: "1.0.0", reason: "the post-merge-gate pack is removed" },
  { command: "harness pack hook solution-acceptance", removedIn: "1.0.0", reason: "the solution-acceptance pack is removed" },
  { command: "harness pack hook pre-tool-use", removedIn: "1.0.0", reason: "the understanding-gate PreToolUse hook is removed" },
  { command: "harness pack hook post-tool-use", removedIn: "1.0.0", reason: "the understanding-gate PostToolUse hook is removed" },
  { command: "harness pack hook track-active-claim", removedIn: "1.0.0", reason: "the understanding-gate active-claim hook is removed" },
  { command: "harness pack hook stay-in-scope", removedIn: "1.0.0", reason: "the understanding-gate stay-in-scope hook is removed" },
  { command: "harness pack hook subagent-start", removedIn: "1.0.0", reason: "the understanding-gate subagent hooks are removed" },
  { command: "harness pack hook subagent-stop", removedIn: "1.0.0", reason: "the understanding-gate subagent hooks are removed" },
  { command: "harness pack hook codex-pre-tool-use", removedIn: "1.0.0", reason: "the understanding-gate Codex hooks are removed" },
  { command: "harness pack hook codex-post-tool-use", removedIn: "1.0.0", reason: "the understanding-gate Codex hooks are removed" },
  { command: "harness pack hook codex-user-prompt-submit", removedIn: "1.0.0", reason: "the understanding-gate Codex hooks are removed" },
  { command: "harness pack hook codex-stop", removedIn: "1.0.0", reason: "the understanding-gate Codex hooks are removed" },
  { command: "harness delegate", removedIn: "1.0.0", reason: "subagent delegation for the understanding gate is removed" },
  { command: "harness approve understanding", removedIn: "1.0.0", reason: "the understanding-gate approval verb is removed" },
  { command: "harness gc", removedIn: "1.0.0", reason: "the understanding-gate state cleanup verb is removed" },
  { command: "harness pack upgrade", removedIn: "1.0.0", reason: "the understanding-gate auto_approve upgrade verb is removed" },
  { command: "harness explain-action", removedIn: "1.0.0", reason: "the Risk Gate debug verbs are removed" },
  { command: "harness test-risk", removedIn: "1.0.0", reason: "the Risk Gate debug verbs are removed" },
  { command: "harness resolve-env", removedIn: "1.0.0", reason: "the Risk Gate debug verbs are removed" },
  { command: "harness explain-policy", removedIn: "1.0.0", reason: "the Risk Gate debug verbs are removed" },
];

// Leading `NAME=value` shell assignments in front of the command word. Only
// unquoted values without shell metacharacters count: a quote, a backslash, a
// `$` or a backtick could hide where the assignment ends, so such a command is
// left unmatched (a missed warning) rather than guessed at (a false one).
const LEADING_ENV_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s'"\\$`;|&<>()]*\s+)*/;

/**
 * The removed command `command` invokes, if any. Matching rule: after trimming
 * and dropping leading plain `NAME=value` assignments, the command must start
 * with a table entry followed by the end, whitespace or a hyphen. Anything
 * else is not matched: a command word given as a path (`/usr/local/bin/harness
 * preflight`), a wrapper (`npx harness preflight`), a compound command (`cd x
 * && harness preflight`), or an assignment with a quoted or expanded value.
 */
export function invokesRemovedCommand(command: string, table: readonly RemovedCommand[] = REMOVED_COMMANDS): RemovedCommand | undefined {
  const trimmed = command.trim().replace(LEADING_ENV_ASSIGNMENTS, "");
  return table.find((r) => trimmed === r.command || trimmed.startsWith(`${r.command} `) || trimmed.startsWith(`${r.command}-`));
}

export function removedCommandMessage(removed: RemovedCommand, remedy: string): string {
  return `calls "${removed.command}", removed in ${removed.removedIn} (${removed.reason}), so it fails with "unknown command"; ${remedy}`;
}

function stringAt(node: unknown, key: string): string | undefined {
  if (!isPlainObject(node)) return undefined;
  const v = node[key];
  return typeof v === "string" ? v : undefined;
}

function arrayAt(node: unknown, key: string): unknown[] {
  if (!isPlainObject(node)) return [];
  const v = node[key];
  return Array.isArray(v) ? v : [];
}

/**
 * Every place a raw (merged) manifest still calls a removed CLI command, one
 * warning per site. A manifest generated before the removal keeps such hooks
 * and policies until the operator deletes them: `harness apply` renders from
 * the manifest, so it re-emits them, and the hook or the agent-facing remedy
 * then runs a command that no longer exists.
 *
 * Scanned sites: `hooks[].command`; each policy's `producers[].command` (the
 * `bash` and `ask` kinds) and `ux.run[]`; each pack's `config.producers[].command`
 * and `config.ux.run[]`. An entry of a removed pack is skipped (the pack
 * itself already warns). Pure and tolerant: anything that is not the expected
 * shape is skipped, the strict parse reports it.
 */
export function findRemovedCommandUses(
  raw: unknown,
  commands: readonly RemovedCommand[] = REMOVED_COMMANDS,
  removedPacks: readonly RemovedPackName[] = REMOVED_PACK_NAMES,
): ManifestPostureWarning[] {
  const warnings: ManifestPostureWarning[] = [];
  const check = (value: unknown, path: string, remedy: () => string): void => {
    if (typeof value !== "string") return;
    const removed = invokesRemovedCommand(value, commands);
    if (removed !== undefined) warnings.push({ path, message: removedCommandMessage(removed, remedy()) });
  };

  arrayAt(raw, "hooks").forEach((hook, i) => {
    const name = stringAt(hook, "name");
    check(stringAt(hook, "command"), `hooks[${i}].command`, () =>
      `delete ${name !== undefined ? `hook "${name}"` : "this hook"} from the manifest (and every policy that names it), then re-run \`harness apply\``,
    );
  });

  arrayAt(raw, "policies").forEach((policy, i) => {
    const name = stringAt(policy, "name");
    const hook = stringAt(policy, "hook");
    const remedy = (): string =>
      `delete ${name !== undefined ? `policy "${name}"` : "this policy"} from the manifest` +
      (hook !== undefined ? ` (and its hook "${hook}" when no other policy names it)` : "") +
      ", then re-run `harness apply`";
    arrayAt(policy, "producers").forEach((producer, j) => {
      check(stringAt(producer, "command"), `policies[${i}].producers[${j}].command`, remedy);
    });
    const ux = isPlainObject(policy) ? policy["ux"] : undefined;
    arrayAt(ux, "run").forEach((line, j) => {
      check(line, `policies[${i}].ux.run[${j}]`, remedy);
    });
  });

  arrayAt(raw, "policy_packs").forEach((pack, i) => {
    const name = stringAt(pack, "name");
    if (name !== undefined && removedPacks.some((p) => p.name === name)) return;
    const config = isPlainObject(pack) ? pack["config"] : undefined;
    const remedy = (): string =>
      `remove the line from the pack's config, or run \`harness pack reseed ${name ?? "<name>"}\` when the pack ships a default`;
    arrayAt(config, "producers").forEach((producer, j) => {
      check(stringAt(producer, "command"), `policy_packs[${i}].config.producers[${j}].command`, remedy);
    });
    const ux = isPlainObject(config) ? config["ux"] : undefined;
    arrayAt(ux, "run").forEach((line, j) => {
      check(line, `policy_packs[${i}].config.ux.run[${j}]`, remedy);
    });
  });

  return warnings;
}
