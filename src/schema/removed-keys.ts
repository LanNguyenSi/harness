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
// returned as warnings (`harness validate` and `harness doctor` print them,
// `harness validate --strict` fails on them). A key that was never valid is
// not in the table and still fails the parse.

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
];

export const REMOVED_PACK_NAMES: readonly RemovedPackName[] = [
  {
    name: "post-merge-gate",
    removedIn: "1.0.0",
    reason: "opt-in ledger-backed gate removed with the harness simplification",
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
