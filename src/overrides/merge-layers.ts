import { EX_NOINPUT, HarnessExitError } from "../cli/exit-codes.js";
import { stripRemovedManifestPaths, type ManifestPostureWarning } from "../schema/removed-keys.js";
import { applyLayers } from "./merge.js";

/**
 * Merge the base manifest and its override layers (in load order), stripping
 * every removed manifest path (`src/schema/removed-keys.ts`) from the base and
 * from each layer BEFORE it is merged.
 *
 * The merge walks name-keyed lists and throws `OverrideMergeError` on a shape
 * it cannot reconcile (a list that mixes named and unnamed entries, a named
 * list over a plain one). A removed key such as `policies:` or `workflows:`
 * is a list of that kind, and it is stripped from the merged manifest only
 * after the merge; a stale layer whose `policies:` list has the wrong shape
 * would therefore fail the load before the strip ran. Every hook loads the
 * manifest, so that failure would lock the machine out. Stripping the layer
 * first leaves the merge nothing of those keys to walk.
 *
 * The warnings are the ones the strip of each source produced; a layer's
 * warnings name the layer, so an operator can tell which file to edit. The
 * base's warnings are unlabelled, as they are for a manifest without layers.
 *
 * A layer that parses to no YAML document at all (an empty or comment-only
 * file parses to `null`) is skipped with one warning naming it: merging the
 * `null` would tombstone the root, erasing the whole manifest, and every hook
 * (the branch-protection hook first) fails closed on a failed load, so such a
 * layer would lock the machine out of every edit. A layer whose root is a
 * scalar or a list is a different mistake, not an absent layer, and fails the
 * load with an error naming the file: silently ignoring it would let an
 * override the operator believes applied stay silently unapplied.
 */
export function mergeLayersStrippingRemovedPaths(
  baseRaw: unknown,
  layers: ReadonlyArray<{ raw: unknown; label: string }>,
): { merged: unknown; warnings: ManifestPostureWarning[] } {
  const base = stripRemovedManifestPaths(baseRaw);
  const warnings: ManifestPostureWarning[] = [...base.warnings];
  let current: unknown = base.raw;
  for (const layer of layers) {
    if (layer.raw === undefined) continue;
    if (layer.raw === null) {
      warnings.push({
        path: "<root>",
        message:
          "this override layer has no YAML document in it (an empty or comment-only file parses to no value); " +
          `it is skipped and the manifest loads as if it were absent; found in the ${layer.label}`,
      });
      continue;
    }
    if (!isPlainObject(layer.raw)) {
      throw new HarnessExitError(
        `an override layer must be a mapping of manifest keys to their overrides, but the ${layer.label} is ${rootShape(layer.raw)}`,
        EX_NOINPUT,
      );
    }
    const stripped = stripRemovedManifestPaths(layer.raw);
    for (const w of stripped.warnings) {
      warnings.push({ path: w.path, message: `${w.message}; found in the ${layer.label}` });
    }
    current = applyLayers(current, stripped.raw);
  }
  return { merged: current, warnings };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** How a non-mapping layer root reads in the error: what it is, not its content. */
function rootShape(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  const t = typeof value;
  if (t === "object") return "a YAML value that is not a mapping";
  return `a ${t}`;
}
