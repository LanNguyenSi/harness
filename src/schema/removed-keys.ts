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
// An empty value (`[]`, `{}`, null) of a key marked `silentWhenEmpty` is
// stripped without a warning: a manifest written before the removal often
// carries an empty `policies: []`, and warning about a key that configures
// nothing would only make `harness validate --strict` fail on it. A non-empty
// value warns.
//
// A removed per-hook field (REMOVED_HOOK_FIELDS below) is stripped from the
// hook, which stays: `hooks[].bash_match` and `hooks[].path_match` were never
// projected into settings.json or the Codex config (`generate-settings.ts` and
// `generate-codex-config.ts` documented them as script-side filters), so
// dropping the key does not change what the hook runs on, while dropping the
// hook would remove an operator's own script. There is one warning per hook.
//
// Removed manifest paths and removed per-hook fields are also stripped from
// the base and from every override layer BEFORE the layers are merged
// (`stripRemovedManifestPaths` and `stripRemovedHookFields`, used by
// `mergeLayersStrippingRemovedPaths` in src/overrides): the merge walks
// name-keyed lists and throws on a shape it cannot reconcile, and that throw
// happens before the strip of the merged manifest runs. A removed hook field
// can collide the same way (`bash_match` as a list of named objects in the
// base under a plain list in a layer), so its strip runs pre-merge too; the
// post-merge strip of `stripRemovedManifestEntries` stays as the safety net
// for callers that parse a single source without merging, where it finds
// nothing left and warns no second time.
//
// Removed CLI commands (REMOVED_COMMANDS below) are not stripped: a hook or
// pack config that still calls one parses fine, so `findRemovedCommandUses`
// reports each such site through the same warning channel.

/** A manifest path a release removed. */
export interface RemovedManifestPath {
  /** Dotted path from the manifest root, e.g. `grounding.policies_source`. */
  path: string;
  /** The release that removed it. */
  removedIn: string;
  /** One line on why it went. */
  reason: string;
  /**
   * Extra sentence for the warning, derived from the stripped value (for
   * example a sub-setting whose removal changes behaviour). Return undefined
   * when the value needs no extra sentence.
   */
  note?: (stripped: unknown) => string | undefined;
  /**
   * Strip an empty value (`[]`, `{}`, null) without a warning. A non-empty
   * value, or a scalar, still warns.
   */
  silentWhenEmpty?: boolean;
}

/**
 * A field of a `hooks[]` entry a release removed. The field is stripped and
 * ignored, with one warning per hook; a later layer may still delete the hook.
 */
export interface RemovedHookField {
  /** The key on a `hooks[]` entry, e.g. `bash_match`. */
  field: string;
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
  hookFields: readonly RemovedHookField[];
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
    reason: "reserved and never consumed: policies live in policy_packs[]",
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
  {
    path: "risk",
    removedIn: "1.0.0",
    reason: "the Risk Gate is removed, so its classifier configuration has no consumer",
    note: (stripped) =>
      isPlainObject(stripped) && stripped["degraded_fail_posture"] === "fail_open"
        ? "risk.degraded_fail_posture: fail_open is no longer honoured: manifest policies are no longer evaluated, so no policy fails open or closed on unreadable evidence"
        : undefined,
  },
  {
    path: "environments",
    removedIn: "1.0.0",
    reason: "the Risk Gate is removed, so environment resolution has no consumer",
  },
  {
    path: "policies",
    removedIn: "1.0.0",
    reason: "the policy engine is removed, so manifest policies are no longer evaluated (the branch-protection pack in policy_packs[] is unaffected)",
    silentWhenEmpty: true,
    note: policiesNote,
  },
  {
    path: "workflows",
    removedIn: "1.0.0",
    reason: "workflows[] only derived review-gate policies, and the policy engine is removed",
    silentWhenEmpty: true,
    note: () => "workflow-derived review gates are no longer enforced",
  },
  {
    path: "review_templates",
    removedIn: "1.0.0",
    reason: "only workflows[] used review templates",
    silentWhenEmpty: true,
  },
  {
    path: "doctor",
    removedIn: "1.0.0",
    reason: "its only setting, ignore_template_drift, has no reader since the template drift check was removed",
    silentWhenEmpty: true,
  },
];

/** How many policy names the `policies` note spells out. */
const POLICY_NAMES_IN_NOTE = 5;

function policiesNote(stripped: unknown): string | undefined {
  if (!Array.isArray(stripped)) return "manifest policies are no longer evaluated";
  const names = stripped
    .map((p) => stringAt(p, "name"))
    .filter((n): n is string => n !== undefined);
  const count = stripped.length;
  const listed = names.slice(0, POLICY_NAMES_IN_NOTE).map((n) => `"${n}"`);
  const more = names.length - listed.length;
  const suffix =
    listed.length === 0 ? "" : ` (${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""})`;
  return `${count} ${count === 1 ? "policy is" : "policies are"} no longer evaluated${suffix}`;
}

const HOOK_FILTER_REASON =
  "it was never projected into settings.json or the Codex config, so the hook runs on the same events with or without it";

export const REMOVED_HOOK_FIELDS: readonly RemovedHookField[] = [
  { field: "bash_match", removedIn: "1.0.0", reason: HOOK_FILTER_REASON },
  { field: "path_match", removedIn: "1.0.0", reason: HOOK_FILTER_REASON },
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
  hookFields: REMOVED_HOOK_FIELDS,
  packs: REMOVED_PACK_NAMES,
};

/**
 * A `harness list` category or `harness describe --pillar` value a release
 * removed. Naming one on the command line is a usage error that says so.
 */
export interface RemovedInspectName {
  name: string;
  removedIn: string;
  reason: string;
}

export const REMOVED_LIST_CATEGORIES: readonly RemovedInspectName[] = [
  { name: "policies", removedIn: "1.0.0", reason: "the manifest has no policies key any more" },
  { name: "workflows", removedIn: "1.0.0", reason: "the manifest has no workflows key any more" },
];

export const REMOVED_DESCRIBE_PILLARS: readonly RemovedInspectName[] = [
  { name: "policies", removedIn: "1.0.0", reason: "the manifest has no policies key any more" },
  { name: "workflows", removedIn: "1.0.0", reason: "the manifest has no workflows key any more" },
  { name: "review_templates", removedIn: "1.0.0", reason: "the manifest has no review_templates key any more" },
];

/** The usage-error text for a removed `kind` ("list category", "pillar") given on the command line. */
export function removedInspectNameMessage(kind: string, removed: RemovedInspectName): string {
  return `${kind} "${removed.name}" was removed in ${removed.removedIn} (${removed.reason})`;
}

/** One stripped entry, for display. */
export interface ManifestPostureWarning {
  /** Where it was found (`grounding.policies_source`, `policy_packs[2]`). */
  path: string;
  message: string;
}

/**
 * Where the entries an array kept sat in the manifest as written. Dropping an
 * entry re-indexes the array, so a diagnostic about a later entry would name
 * the wrong position without it.
 */
export interface IndexMap {
  /** `kept[k]` is the original index of the entry now at index `k`. */
  kept: readonly number[];
  /** Length of the array before any entry was dropped. */
  originalLength: number;
}

/** Index maps of the arrays `stripRemovedManifestEntries` dropped entries from. */
export interface StrippedIndexMaps {
  policy_packs?: IndexMap;
}

export interface StrippedManifest {
  raw: unknown;
  warnings: ManifestPostureWarning[];
  /** Present only when an array lost an entry. */
  indexMaps?: StrippedIndexMaps;
}

/**
 * The index in the manifest as written for index `k` of the stripped array.
 * An index past the kept entries (an entry appended after the parse) keeps
 * its distance from the end.
 */
export function originalIndex(map: IndexMap | undefined, k: number): number {
  if (map === undefined) return k;
  const hit = map.kept[k];
  return hit !== undefined ? hit : k + (map.originalLength - map.kept.length);
}

/** Remap a zod issue path (`["policy_packs", 0, ...]`) to the manifest as written. */
export function remapIssuePath(path: ReadonlyArray<string | number>, maps: StrippedIndexMaps | undefined): Array<string | number> {
  const [head, idx, ...rest] = path;
  if (maps === undefined || typeof idx !== "number") return [...path];
  if (head === "policy_packs") return [head, originalIndex(maps.policy_packs, idx), ...rest];
  return [...path];
}

/**
 * Remap a diagnostic path that names `policy_packs[k]` (also the dotted
 * `policy_packs.k`) to the manifest as written. Any other path is returned
 * unchanged.
 */
export function remapDiagnosticPath(path: string, maps: StrippedIndexMaps | undefined): string {
  if (maps === undefined) return path;
  const m = /^policy_packs(?:\[(\d+)\]|\.(\d+)(?=\.|$))/.exec(path);
  if (m === null) return path;
  const k = Number(m[1] ?? m[2]);
  const mapped = originalIndex(maps.policy_packs, k);
  return `policy_packs${m[1] !== undefined ? `[${mapped}]` : `.${mapped}`}${path.slice(m[0].length)}`;
}

/**
 * A plain `{...}` mapping: not null, not an array, and with `Object.prototype`
 * or no prototype at all. The one shared copy (the merge engine and the
 * layer-root check were copies of this); YAML-parsed documents only ever
 * carry such objects, arrays, and scalars, so the prototype check only
 * excludes exotic values like a YAML timestamp's `Date`.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
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

/** The value at `segments` under `node`, or undefined (own properties only). */
function valueAt(node: unknown, segments: readonly string[]): unknown {
  let cur: unknown = node;
  for (const seg of segments) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * True for a value that configures nothing: null, `[]` or `{}`. Only a
 * prototype-plain object counts as `{}`: a YAML-typed value (a `!!set` Set, an
 * `!!omap` Map, a `!!timestamp` Date) has no own enumerable keys either, but
 * it is not empty, so it warns.
 */
function isEmptyValue(v: unknown): boolean {
  if (v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (!isPlainObject(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return (proto === Object.prototype || proto === null) && Object.keys(v).length === 0;
}

/**
 * Strip every removed manifest path from a raw manifest (or one override
 * layer), one warning per path that was present, none for an empty value of a
 * `silentWhenEmpty` path. Pure: `raw` is not modified, and the same object is
 * returned when nothing was stripped.
 */
export function stripRemovedManifestPaths(
  raw: unknown,
  paths: readonly RemovedManifestPath[] = REMOVED_MANIFEST_PATHS,
): { raw: unknown; warnings: ManifestPostureWarning[] } {
  const warnings: ManifestPostureWarning[] = [];
  let current = raw;
  for (const entry of paths) {
    const segments = entry.path.split(".");
    const stripped = valueAt(current, segments);
    const r = withoutPath(current, segments);
    if (!r.removed) continue;
    current = r.node;
    if (entry.silentWhenEmpty === true && isEmptyValue(stripped)) continue;
    const note = entry.note?.(stripped);
    warnings.push({
      path: entry.path,
      message:
        `removed in ${entry.removedIn} and ignored (${entry.reason}); delete it from the manifest` +
        (note !== undefined ? `. ${note}` : ""),
    });
  }
  return { raw: current, warnings };
}

/**
 * Strip every removed field from the hooks that carry it (the hook stays,
 * one warning per hook), over one `hooks` array. Shared by
 * `stripRemovedHookFields` (one raw source, before the merge) and
 * `stripRemovedManifestEntries` (the merged manifest), so the wording exists
 * once. Pure: `hooks` is not modified.
 */
function stripRemovedHookFieldsFromHooks(
  hooks: readonly unknown[],
  hookFields: readonly RemovedHookField[],
): { hooks: unknown[]; changed: boolean; warnings: ManifestPostureWarning[] } {
  const warnings: ManifestPostureWarning[] = [];
  let changed = false;
  const next = hooks.map((hook, i) => {
    if (!isPlainObject(hook)) return hook;
    const found = hookFields.filter((f) => Object.prototype.hasOwnProperty.call(hook, f.field));
    if (found.length === 0) return hook;
    changed = true;
    const copy: Record<string, unknown> = { ...hook };
    for (const f of found) delete copy[f.field];
    const name = stringAt(hook, "name");
    warnings.push({
      path: `hooks[${i}]`,
      message:
        `${name !== undefined ? `hook "${name}"` : "this hook"} carries ${found.map((f) => f.field).join(" and ")}, ` +
        `removed in ${found[0]!.removedIn} (${[...new Set(found.map((f) => f.reason))].join("; ")}); the field is ignored, delete the ` +
        `${found.length === 1 ? "key" : "keys"} from it`,
    });
    return copy;
  });
  return { hooks: next, changed, warnings };
}

/**
 * Strip every removed per-hook field from one raw source (the base manifest
 * or one override layer) BEFORE it is merged: the merge walks name-keyed
 * lists and throws on a shape it cannot reconcile, and a removed field like
 * `bash_match` can carry exactly such colliding shapes across sources. The
 * hooks stay; one warning per hook that carried a key, as in
 * `stripRemovedManifestEntries`, whose post-merge strip stays as the safety
 * net for callers that parse without merging (it then finds nothing left).
 * Pure: `raw` is not modified, and the same object is returned when nothing
 * was stripped.
 */
export function stripRemovedHookFields(
  raw: unknown,
  hookFields: readonly RemovedHookField[] = REMOVED_HOOK_FIELDS,
): { raw: unknown; warnings: ManifestPostureWarning[] } {
  if (!isPlainObject(raw) || !Array.isArray(raw["hooks"]) || hookFields.length === 0) {
    return { raw, warnings: [] };
  }
  const stripped = stripRemovedHookFieldsFromHooks(raw["hooks"] as unknown[], hookFields);
  if (!stripped.changed) return { raw, warnings: [] };
  return { raw: { ...raw, hooks: stripped.hooks }, warnings: stripped.warnings };
}

/**
 * Strip every removed manifest path, strip every removed field from the
 * hooks that carry it (the hook stays), and drop every removed pack entry
 * from a raw (merged, not yet parsed) manifest. After a
 * `mergeLayersStrippingRemovedPaths` merge the hook fields are already
 * stripped (they went before the merge), so this strip finds nothing left of
 * them and warns no second time; it stays for callers that parse a single
 * source without merging. Pure: `raw` is not modified.
 */
export function stripRemovedManifestEntries(
  raw: unknown,
  table: RemovedManifestTable = REMOVED_MANIFEST_TABLE,
): StrippedManifest {
  const indexMaps: StrippedIndexMaps = {};
  const paths = stripRemovedManifestPaths(raw, table.paths);
  const warnings: ManifestPostureWarning[] = paths.warnings;
  let current = paths.raw;
  if (isPlainObject(current) && Array.isArray(current["hooks"]) && table.hookFields.length > 0) {
    const stripped = stripRemovedHookFieldsFromHooks(current["hooks"] as unknown[], table.hookFields);
    warnings.push(...stripped.warnings);
    if (stripped.changed) current = { ...current, hooks: stripped.hooks };
  }
  if (isPlainObject(current) && Array.isArray(current["policy_packs"]) && table.packs.length > 0) {
    const packs = current["policy_packs"] as unknown[];
    const kept: unknown[] = [];
    const keptFrom: number[] = [];
    packs.forEach((pack, i) => {
      const name = isPlainObject(pack) ? pack["name"] : undefined;
      const removed = typeof name === "string" ? table.packs.find((p) => p.name === name) : undefined;
      if (removed === undefined) {
        kept.push(pack);
        keptFrom.push(i);
        return;
      }
      warnings.push({
        path: `policy_packs[${i}]`,
        message: `pack "${removed.name}" was removed in ${removed.removedIn} and is skipped (${removed.reason}); delete the entry from the manifest`,
      });
    });
    if (kept.length !== packs.length) {
      current = { ...current, policy_packs: kept };
      indexMaps.policy_packs = { kept: keptFrom, originalLength: packs.length };
    }
  }
  return Object.keys(indexMaps).length > 0 ? { raw: current, warnings, indexMaps } : { raw: current, warnings };
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
  { command: "harness approve risk", removedIn: "1.0.0", reason: "the Risk Gate approval verb is removed" },
  { command: "harness explain-policy", removedIn: "1.0.0", reason: "the Risk Gate debug verbs are removed" },
  { command: "harness dry-run", removedIn: "1.0.0", reason: "the policy engine's debug verbs are removed" },
  { command: "harness policy intercept", removedIn: "1.0.0", reason: "the policy engine behind the PreToolUse intercept hook is removed" },
  { command: "harness record", removedIn: "1.0.0", reason: "the evidence recording verbs for the removed policy gates are removed" },
  { command: "harness smoke", removedIn: "1.0.0", reason: "the end-to-end smoke verb, whose decision mode read the removed policy engine, is removed" },
  { command: "harness pause", removedIn: "1.0.0", reason: "the operator pause is removed; use `harness gate disable`" },
  { command: "harness resume", removedIn: "1.0.0", reason: "the operator pause is removed; use `harness gate enable`" },
  // `harness explain` is a prefix of `harness explain-action` and
  // `harness explain-policy` (hyphen continuation) and lookup takes the
  // FIRST matching row, so this row must stay below both of them; pinned
  // in tests/schema/removed-commands.test.ts (task bfe5efb4).
  { command: "harness explain", removedIn: "1.0.0", reason: "the policy engine's debug verbs are removed" },
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
 * and pack configs until the operator deletes them: `harness apply` renders from
 * the manifest, so it re-emits them, and the hook or the agent-facing remedy
 * then runs a command that no longer exists.
 *
 * Scanned sites: `hooks[].command`; each pack's `config.producers[].command`
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
      `delete ${name !== undefined ? `hook "${name}"` : "this hook"} from the manifest, then re-run \`harness apply\``,
    );
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
