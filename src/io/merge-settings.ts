// 3-way merge for `harness apply --target <path> --merge`.
//
// Merge semantics: harness owns whichever top-level keys appear in the
// generated output (today: `hooks` and `mcpServers`). Owned keys are
// replaced wholesale — EXCEPT `mcpServers`, which is deep-merged by
// server name (task 059b669c, operator decision 2026-07-02): a server
// the operator hand-added directly to the target file survives the
// merge, while every name harness declares is taken from the generated
// output (the manifest stays the source of truth for what it declares).
// `hooks` stays wholesale-owned: its nested array-of-groups shape has
// no stable identity key to merge on, so partial ownership would be
// ambiguous; hand-added hooks belong in the manifest (documented in
// docs/for-humans.md).
//
// Insertion order: existing keys first (stable diff against the prior
// file), then any new generated keys appended at the end. Owned keys
// keep their existing position so a re-apply doesn't churn on-disk
// ordering. Inside a deep-merged mcpServers block the same rule holds:
// existing server names keep their position, new generated names are
// appended.

export interface MergeResult {
  merged: Record<string, unknown>;
  replacedKeys: string[];
  preservedKeys: string[];
  addedKeys: string[];
  /**
   * Server names inside `mcpServers` that exist only in the target file
   * (operator hand-adds) and survived the deep merge. Empty when the
   * key was absent on either side or not an object on both sides.
   */
  preservedMcpServers: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function mergeSettings(
  existing: Record<string, unknown> | null,
  generated: Record<string, unknown>,
): MergeResult {
  const replaced: string[] = [];
  const added: string[] = [];
  const preserved: string[] = [];
  const preservedMcpServers: string[] = [];
  const out: Record<string, unknown> = {};

  if (existing) {
    for (const k of Object.keys(existing)) {
      if (k in generated) {
        if (k === "mcpServers" && isRecord(existing[k]) && isRecord(generated[k])) {
          const { merged, operatorNames } = mergeMcpServers(
            existing[k] as Record<string, unknown>,
            generated[k] as Record<string, unknown>,
          );
          out[k] = merged;
          preservedMcpServers.push(...operatorNames);
        } else {
          // Wholesale replace: harness owns the key. Also the fallback
          // when either side's mcpServers is not an object (malformed
          // target) — the generated shape wins rather than merging into
          // a corrupt value.
          out[k] = generated[k];
        }
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
    preservedMcpServers,
  };
}

/**
 * Union by server name. Harness-declared names win (generated value
 * replaces the existing one); operator-added names survive verbatim.
 * Existing insertion order is kept, new generated names are appended in
 * their generated (lexical) order.
 */
function mergeMcpServers(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): { merged: Record<string, unknown>; operatorNames: string[] } {
  const merged: Record<string, unknown> = {};
  const operatorNames: string[] = [];
  for (const name of Object.keys(existing)) {
    if (name in generated) {
      merged[name] = generated[name];
    } else {
      merged[name] = existing[name];
      operatorNames.push(name);
    }
  }
  for (const name of Object.keys(generated)) {
    if (name in existing) continue;
    merged[name] = generated[name];
  }
  return { merged, operatorNames };
}

export function summarizeMerge(target: string, r: MergeResult): string {
  const replacedFrag = r.replacedKeys.length
    ? `replaced ${r.replacedKeys.length} owned key${r.replacedKeys.length === 1 ? "" : "s"} (${r.replacedKeys.join(", ")})`
    : "replaced 0 owned keys";
  const addedFrag = r.addedKeys.length
    ? `, added ${r.addedKeys.length} (${r.addedKeys.join(", ")})`
    : "";
  const preservedFrag = `, preserved ${r.preservedKeys.length} other key${r.preservedKeys.length === 1 ? "" : "s"}`;
  const mcpFrag = r.preservedMcpServers.length
    ? `, kept ${r.preservedMcpServers.length} operator-added mcpServer${r.preservedMcpServers.length === 1 ? "" : "s"} (${r.preservedMcpServers.join(", ")})`
    : "";
  return `merged into ${target}: ${replacedFrag}${addedFrag}${preservedFrag}${mcpFrag}`;
}
