// 3-way merge for `harness apply --target <path> --merge`.
//
// Merge semantics: harness owns whichever top-level keys appear in the
// generated output (today: `hooks` and `mcpServers`). Owned keys are
// replaced wholesale — EXCEPT `mcpServers`, which is deep-merged by
// server name (task 059b669c, operator decision 2026-07-02). Per name:
//
//   - declared in the current generated output → generated value wins
//     (the manifest stays the source of truth for what it declares);
//   - absent from the generated output but recorded as harness-written
//     on a PREVIOUS apply (`previouslyGeneratedMcpNames`, derived from
//     `.last-apply`) → DROPPED: the operator removed or disabled the
//     server in the manifest, and `enabled: false` must stay an
//     effective kill switch on --merge targets;
//   - absent from both → operator hand-add, preserved verbatim.
//
// Without the provenance set (first merge, or a pre-provenance
// `.last-apply`), unknown names are preserved — the conservative
// reading, since dropping could destroy an operator hand-add.
//
// `hooks` stays wholesale-owned: its nested array-of-groups shape has
// no stable identity key to merge on, so partial ownership would be
// ambiguous; hand-added hooks belong in the manifest (documented in
// docs/for-humans.md).
//
// Insertion order: existing keys first (stable diff against the prior
// file), then any new generated keys appended at the end. Owned keys
// keep their existing position so a re-apply doesn't churn on-disk
// ordering. Inside a deep-merged mcpServers block the same rule holds.
//
// Accumulators are null-prototype objects: a server literally named
// `__proto__` in the target file must round-trip as an own property,
// not hit the inherited prototype setter.

export interface MergeOptions {
  /**
   * Server names harness itself wrote into the generated settings.json
   * on the PREVIOUS apply (from `.last-apply`). Used to tell "operator
   * hand-added" apart from "harness-written before, since removed or
   * disabled in the manifest". Omit when no prior apply is recorded.
   */
  previouslyGeneratedMcpNames?: ReadonlySet<string>;
}

export interface MergeResult {
  merged: Record<string, unknown>;
  replacedKeys: string[];
  preservedKeys: string[];
  addedKeys: string[];
  /** Owned keys that were deep-merged instead of wholesale-replaced. */
  deepMergedKeys: string[];
  /**
   * Server names inside `mcpServers` that exist only in the target file
   * (operator hand-adds) and survived the deep merge.
   */
  preservedMcpServers: string[];
  /**
   * Server names dropped because harness wrote them on a previous apply
   * but the current manifest no longer emits them (removed or
   * `enabled: false`).
   */
  removedMcpServers: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function mergeSettings(
  existing: Record<string, unknown> | null,
  generated: Record<string, unknown>,
  opts: MergeOptions = {},
): MergeResult {
  const replaced: string[] = [];
  const added: string[] = [];
  const preserved: string[] = [];
  const deepMerged: string[] = [];
  const preservedMcpServers: string[] = [];
  const removedMcpServers: string[] = [];
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  if (existing) {
    for (const k of Object.keys(existing)) {
      if (k === "mcpServers" && isRecord(existing[k])) {
        const inGenerated = k in generated;
        if (inGenerated && !isRecord(generated[k])) {
          // Malformed generated side: wholesale, generated wins.
          out[k] = generated[k];
          replaced.push(k);
          continue;
        }
        if (!inGenerated && opts.previouslyGeneratedMcpNames === undefined) {
          // The manifest emits no servers AND no provenance is
          // available: nothing here is provably harness-written, so the
          // key is not ours to touch.
          out[k] = existing[k];
          preserved.push(k);
          continue;
        }
        // Deep merge — also when the generated output has NO mcpServers
        // key at all (every declared server removed or disabled): the
        // provenance set still identifies the harness-written leftovers
        // that must be dropped so enabled:false stays a kill switch.
        const r = mergeMcpServers(
          existing[k] as Record<string, unknown>,
          inGenerated ? (generated[k] as Record<string, unknown>) : {},
          opts.previouslyGeneratedMcpNames,
        );
        preservedMcpServers.push(...r.operatorNames);
        removedMcpServers.push(...r.removedNames);
        if (inGenerated || Object.keys(r.merged).length > 0) {
          out[k] = r.merged;
        }
        // else: every entry was harness-written and dropped, and the
        // generated output has no mcpServers key — omit it, mirroring
        // what a fresh (non-merge) apply would write.
        deepMerged.push(k);
        continue;
      }
      if (k in generated) {
        // Wholesale replace: harness owns the key. Also the fallback
        // when the existing mcpServers is not an object (malformed
        // target) — the generated shape wins rather than merging into
        // a corrupt value.
        out[k] = generated[k];
        replaced.push(k);
      } else {
        out[k] = existing[k];
        preserved.push(k);
      }
    }
  }

  for (const k of Object.keys(generated)) {
    if (existing && k in existing) continue;
    out[k] = generated[k];
    added.push(k);
  }

  return {
    merged: out,
    replacedKeys: replaced,
    preservedKeys: preserved,
    addedKeys: added,
    deepMergedKeys: deepMerged,
    preservedMcpServers,
    removedMcpServers,
  };
}

/**
 * Union by server name with provenance (see the module header for the
 * three per-name cases). Existing insertion order is kept, new
 * generated names are appended in their generated (lexical) order.
 */
function mergeMcpServers(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
  previouslyGenerated: ReadonlySet<string> | undefined,
): {
  merged: Record<string, unknown>;
  operatorNames: string[];
  removedNames: string[];
} {
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const operatorNames: string[] = [];
  const removedNames: string[] = [];
  for (const name of Object.keys(existing)) {
    if (Object.prototype.hasOwnProperty.call(generated, name)) {
      merged[name] = generated[name];
    } else if (previouslyGenerated?.has(name)) {
      removedNames.push(name);
    } else {
      merged[name] = existing[name];
      operatorNames.push(name);
    }
  }
  for (const name of Object.keys(generated)) {
    if (Object.prototype.hasOwnProperty.call(existing, name)) continue;
    merged[name] = generated[name];
  }
  return { merged, operatorNames, removedNames };
}

export function summarizeMerge(target: string, r: MergeResult): string {
  const replacedFrag = r.replacedKeys.length
    ? `replaced ${r.replacedKeys.length} owned key${r.replacedKeys.length === 1 ? "" : "s"} (${r.replacedKeys.join(", ")})`
    : "replaced 0 owned keys";
  const deepMergedFrag = r.deepMergedKeys.length
    ? `, deep-merged ${r.deepMergedKeys.join(", ")}`
    : "";
  const addedFrag = r.addedKeys.length
    ? `, added ${r.addedKeys.length} (${r.addedKeys.join(", ")})`
    : "";
  const preservedFrag = `, preserved ${r.preservedKeys.length} other key${r.preservedKeys.length === 1 ? "" : "s"}`;
  const keptFrag = r.preservedMcpServers.length
    ? `, kept ${r.preservedMcpServers.length} operator-added mcpServer${r.preservedMcpServers.length === 1 ? "" : "s"} (${r.preservedMcpServers.join(", ")})`
    : "";
  const droppedFrag = r.removedMcpServers.length
    ? `, dropped ${r.removedMcpServers.length} manifest-removed mcpServer${r.removedMcpServers.length === 1 ? "" : "s"} (${r.removedMcpServers.join(", ")})`
    : "";
  return `merged into ${target}: ${replacedFrag}${deepMergedFrag}${addedFrag}${preservedFrag}${keptFrag}${droppedFrag}`;
}
