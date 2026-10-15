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
    const stripped = stripRemovedManifestPaths(layer.raw);
    for (const w of stripped.warnings) {
      warnings.push({ path: w.path, message: `${w.message}; found in the ${layer.label}` });
    }
    current = applyLayers(current, stripped.raw);
  }
  return { merged: current, warnings };
}
