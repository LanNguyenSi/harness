import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { applyLayers } from "../../overrides/merge.js";
import { ManifestParseError, parseManifest, type Manifest } from "../../schema/index.js";
import { EX_NOINPUT, EX_USAGE, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";
import { diffManifests, formatDiff, type Change } from "./engine.js";
import {
  locateGitContext,
  readFileAtRefOrNull,
  readManifestAtRef,
  repoRelativePath,
} from "./git.js";

export interface DiffOptions extends LoaderOptions {
  since?: string;
}

export interface DiffResult {
  changes: Change[];
  output: string;
  before: Manifest;
  after: Manifest;
  /**
   * Override-layer diagnostics (task b2660f9e): one entry per active
   * layer that is not versioned in the manifest's repo and was therefore
   * treated as constant on both sides of the comparison. Callers print
   * these to stderr so the diff on stdout stays clean.
   */
  warnings: string[];
}

function parseRefYaml(raw: string, label: string): unknown {
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new HarnessExitError(
      `${label} is not valid YAML: ${(err as Error).message}`,
      EX_NOINPUT,
    );
  }
}

function parseRefSchema(parsed: unknown): Manifest {
  try {
    return parseManifest(parsed);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      throw new HarnessExitError(
        `manifest at git ref failed schema validation:\n${err.message}`,
        EX_NOINPUT,
      );
    }
    throw err;
  }
}

/**
 * Build the "before" manifest for `--since <ref>` with the SAME override
 * layers the working side gets from loadManifest (task b2660f9e). Without
 * this the ref side was override-naive while the working side was
 * override-merged, so every override key appeared as a phantom diff.
 *
 * Per-layer ref semantics:
 * - versioned in this repo and present at the ref → read at the ref
 *   (true history of the layer);
 * - versioned but absent at the ref → the layer was added since; the ref
 *   side goes without it, which IS a real effective-config change;
 * - not versioned in this repo (e.g. a ~/.harness home outside the
 *   manifest's repo) → current content is applied to BOTH sides: the
 *   layer is constant across the comparison and cancels out. A base
 *   change masked by such an override does not change effective config,
 *   so not reporting it is correct for an effective-config diff. Surfaced
 *   via `warnings` so the operator knows the layer has no history here.
 */
function buildRefManifest(
  ctx: ReturnType<typeof locateGitContext>,
  since: string,
  refRaw: string,
  layerPaths: string[],
  warnings: string[],
): Manifest {
  const refLayerRaws: unknown[] = [];
  for (const layerPath of layerPaths) {
    const rel = repoRelativePath(ctx, layerPath);
    if (rel === null) {
      warnings.push(
        `override layer ${layerPath} is not versioned in this repo; ` +
          `treating its current content as constant on both sides of the comparison`,
      );
      refLayerRaws.push(
        parseRefYaml(fs.readFileSync(layerPath, "utf8"), `override layer ${layerPath}`),
      );
      continue;
    }
    const atRef = readFileAtRefOrNull(ctx, since, rel);
    if (atRef === null) continue; // layer added since <ref>: a real change
    refLayerRaws.push(parseRefYaml(atRef, `override layer ${rel} at git ref "${since}"`));
  }
  const baseRaw = parseRefYaml(refRaw, "manifest at git ref");
  if (refLayerRaws.length === 0) return parseRefSchema(baseRaw);
  return parseRefSchema(applyLayers(baseRaw, ...refLayerRaws));
}

export function diff(opts: DiffOptions): DiffResult {
  if (!opts.since) {
    throw new HarnessExitError(
      "harness diff requires --since <ref>; --since-apply lands in Phase 3",
      EX_USAGE,
    );
  }
  const resolved = resolvePaths(opts);
  const ctx = locateGitContext(resolved.base);
  const refRaw = readManifestAtRef(ctx, opts.since);
  const warnings: string[] = [];
  const layerPaths = [
    ...resolved.machineLayers,
    ...(resolved.projectLayer ? [resolved.projectLayer] : []),
  ];
  const before = buildRefManifest(ctx, opts.since, refRaw, layerPaths, warnings);
  const { manifest: after } = loadManifest(opts);
  const changes = diffManifests(before, after);
  const output = formatDiff(changes);
  return { changes, output, before, after, warnings };
}

export { diffManifests, formatDiff } from "./engine.js";
export type { Change, ChangeKind } from "./engine.js";
