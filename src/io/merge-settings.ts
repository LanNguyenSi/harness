// 3-way merge for `harness apply --target <path> --merge`.
//
// Merge semantics: harness owns whichever top-level keys appear in the
// generated output (today: `hooks`; once the sibling `tools.mcp` task
// lands: also `mcpServers`). Owned keys are *replaced* wholesale; every
// other key in the existing target file is preserved verbatim.
//
// Insertion order: existing keys first (stable diff against the prior
// file), then any new generated keys appended at the end. Owned keys
// keep their existing position so a re-apply doesn't churn on-disk
// ordering.

export interface MergeResult {
  merged: Record<string, unknown>;
  replacedKeys: string[];
  preservedKeys: string[];
  addedKeys: string[];
}

export function mergeSettings(
  existing: Record<string, unknown> | null,
  generated: Record<string, unknown>,
): MergeResult {
  const replaced: string[] = [];
  const added: string[] = [];
  const preserved: string[] = [];
  const out: Record<string, unknown> = {};

  if (existing) {
    for (const k of Object.keys(existing)) {
      if (k in generated) {
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

  return { merged: out, replacedKeys: replaced, preservedKeys: preserved, addedKeys: added };
}

export function summarizeMerge(target: string, r: MergeResult): string {
  const replacedFrag = r.replacedKeys.length
    ? `replaced ${r.replacedKeys.length} owned key${r.replacedKeys.length === 1 ? "" : "s"} (${r.replacedKeys.join(", ")})`
    : "replaced 0 owned keys";
  const addedFrag = r.addedKeys.length
    ? `, added ${r.addedKeys.length} (${r.addedKeys.join(", ")})`
    : "";
  const preservedFrag = `, preserved ${r.preservedKeys.length} other key${r.preservedKeys.length === 1 ? "" : "s"}`;
  return `merged into ${target}: ${replacedFrag}${addedFrag}${preservedFrag}`;
}
