import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { applyLayers } from "../overrides/merge.js";
import {
  machineOverrideCandidates,
  resolveMachineDiscriminators,
  type DiscriminatorOptions,
} from "../overrides/machines.js";
import {
  ManifestParseError,
  parseManifestWithWarnings,
  type Manifest,
  type ManifestPostureWarning,
  type StrippedIndexMaps,
} from "../schema/index.js";
import { readTextFileBoundedOrThrow } from "../io/read-regular-file.js";
import { resolveHomeDir } from "../runtime/home-dir.js";
import { isValidProjectName } from "../runtime/git-context.js";
import { EX_NOINPUT, HarnessExitError } from "./exit-codes.js";

export interface LoaderOptions {
  configPath?: string;
  project?: string;
  homeDir?: string;
  discriminator?: DiscriminatorOptions;
}

export interface ResolvedPaths {
  base: string;
  machineLayers: string[];
  projectLayer: string | null;
}

export interface LoadedManifest {
  manifest: Manifest;
  resolved: ResolvedPaths;
  /**
   * Removed manifest keys and removed packs the load stripped and ignored,
   * and sites that still call a removed command (src/schema/removed-keys.ts).
   * `harness doctor` and `harness apply` print them.
   */
  warnings: ManifestPostureWarning[];
  /**
   * Original positions of the policies[] / policy_packs[] entries that
   * survived the load-time drop (`parseManifestWithWarnings`); absent when
   * nothing was dropped. Used to name an index as written in a diagnostic.
   */
  indexMaps?: StrippedIndexMaps;
}

export interface LoadedRaw {
  mergedRaw: unknown;
  resolved: ResolvedPaths;
  warnings: ManifestPostureWarning[];
}

const DEFAULT_BASENAME = "harness.yaml";

function defaultHome(opts: LoaderOptions): string {
  // resolveHomeDir handles flag > $HARNESS_HOME > ~/.harness/ (new) >
  // ~/.claude/ (legacy fallback with deprecation warning) >
  // ~/.harness/ (create-on-first-use). See runtime/home-dir.ts.
  return resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path;
}

export function resolvePaths(opts: LoaderOptions = {}): ResolvedPaths {
  if (
    opts.homeDir === undefined &&
    opts.configPath === undefined &&
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] !== "1"
  ) {
    // Defense against the recurring test-isolation class (v0.21.1 preflight
    // stage leak, v0.22.0 approveUnderstanding marker leak, latent post-pause
    // pause-sentinel read leak): without an explicit `homeDir` or
    // `configPath`, this resolver would silently fall back to the
    // operator's real `~/.harness/` (or legacy `~/.claude/`) and the
    // caller would read/write that real state dir. The harness CLI
    // binary sets the env var before `run()`; tests don't, so this
    // throw surfaces leak sites at assertion time instead of as silent
    // operator-state mutation.
    throw new Error(
      "resolvePaths refused to fall back to the real harness home dir, set { homeDir } or { configPath } on LoaderOptions, " +
        "or (for the real harness binary) set HARNESS_ALLOW_REAL_GENERATED_DIR=1",
    );
  }
  const home = defaultHome(opts);
  const base = opts.configPath ?? path.join(home, DEFAULT_BASENAME);
  const machinesDir = path.join(home, "machines");

  const candidates = machineOverrideCandidates(
    resolveMachineDiscriminators(opts.discriminator ?? {}),
  );
  const machineLayers: string[] = [];
  for (const c of candidates) {
    const candidatePath = path.join(machinesDir, `${c}.harness.overrides.yaml`);
    if (fs.existsSync(candidatePath)) machineLayers.push(candidatePath);
  }

  // Defense in depth (task c88461c1, review round 3 residual; task
  // `1c4eb3ea` of the batch-44 follow-up run): `deriveProjectName`
  // (`src/runtime/git-context.ts`) already validates the name it
  // returns with the SAME `isValidProjectName` guard at every one of
  // its own exits, so a value reaching this sink through that helper
  // is already safe. This check guards the sink itself, for an
  // `opts.project` that reaches `resolvePaths` from anywhere else (a
  // caller building `LoaderOptions` by hand, a future producer that
  // feeds an unvalidated string through `--project`), so a name like
  // `".."` or one containing a path separator can never be joined into
  // `<home>/projects/<name>/harness.overrides.yaml` regardless of
  // where it came from. An invalid name is treated exactly like "no
  // project layer on disk" (`projectLayer: null`), matching the
  // existing "file does not exist" degrade below, not a thrown error.
  let projectLayer: string | null = null;
  if (opts.project && isValidProjectName(opts.project)) {
    const projectPath = path.join(
      home,
      "projects",
      opts.project,
      "harness.overrides.yaml",
    );
    if (fs.existsSync(projectPath)) projectLayer = projectPath;
  }

  return { base, machineLayers, projectLayer };
}

function readYamlFile(filePath: string, label: string): unknown {
  let raw: string;
  try {
    // Bounded (1 MiB, far past any manifest) and non-blocking: every hook
    // loads the manifest and its override layers through here, so a FIFO or
    // a sparse oversized file at one of these paths must fail the load (each
    // hook then applies its own load-failure posture) instead of holding the
    // hook past its budget, which the runtime treats as an allow. A symlinked
    // manifest (a dotfiles checkout) is followed, as before.
    raw = readTextFileBoundedOrThrow(filePath, { followSymlinks: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First-run DX (task 24ec07a6): a fresh machine's first command is
      // often a read verb (doctor/describe/validate), which previously
      // dead-ended here with no pointer to init. Only the BASE manifest
      // gets the hint; a missing override layer mid-read is a race, not
      // a first-run, and "run init" would be wrong advice for it.
      const hint =
        label === "manifest"
          ? ". No harness.yaml on this machine yet: run `harness init --interactive` (or `harness init --template solo`) to create one"
          : "";
      throw new HarnessExitError(
        `${label} not found: ${filePath}${hint}`,
        EX_NOINPUT,
      );
    }
    throw new HarnessExitError(
      `${label} could not be read: ${(err as Error).message}`,
      EX_NOINPUT,
    );
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new HarnessExitError(
      `${label} is not valid YAML (${filePath}): ${(err as Error).message}`,
      EX_NOINPUT,
    );
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function policiesOf(raw: unknown): unknown[] {
  if (!isPlainRecord(raw)) return [];
  const p = raw["policies"];
  return Array.isArray(p) ? p : [];
}

/**
 * Merge the override layers onto the base in load order and report every
 * layer that sets `when` to null (`when: null`, `when: ~`, an empty
 * `when:`) on a policy whose lower layers carry `when:`. The merge deletes
 * the key, so the policy would load trigger-only instead of being dropped
 * as a `when:` policy. A hit is reported only when the policy survives the
 * whole merge without `when:` (a later layer that deletes the policy or
 * sets `when:` again leaves nothing to warn about). The path names the
 * policy's index in the merged manifest.
 */
export function mergeLayersWithWhenTombstones(
  baseRaw: unknown,
  layers: ReadonlyArray<{ raw: unknown; label: string }>,
): { merged: unknown; warnings: ManifestPostureWarning[] } {
  const hits: Array<{ name: string; label: string }> = [];
  let current: unknown = baseRaw;
  for (const layer of layers) {
    if (layer.raw === undefined) continue;
    const lower = policiesOf(current);
    for (const entry of policiesOf(layer.raw)) {
      if (!isPlainRecord(entry) || typeof entry["name"] !== "string") continue;
      if (!Object.prototype.hasOwnProperty.call(entry, "when") || entry["when"] !== null) continue;
      const name = entry["name"];
      const target = lower.find((p) => isPlainRecord(p) && p["name"] === name);
      if (!isPlainRecord(target) || !Object.prototype.hasOwnProperty.call(target, "when")) continue;
      hits.push({ name, label: layer.label });
    }
    current = applyLayers(current, layer.raw);
  }
  const mergedPolicies = policiesOf(current);
  const warnings: ManifestPostureWarning[] = [];
  for (const { name, label } of hits) {
    const idx = mergedPolicies.findIndex((p) => isPlainRecord(p) && p["name"] === name);
    if (idx < 0) continue;
    const policy = mergedPolicies[idx];
    if (isPlainRecord(policy) && Object.prototype.hasOwnProperty.call(policy, "when")) continue;
    warnings.push({
      path: `policies[${idx}]`,
      message: `the ${label} sets when: to null on policy "${name}", whose lower layers carry when:; the merge deletes the key, so the policy loads trigger-only (matching every call its trigger names) instead of being dropped. Remove the when: line from the layer, or remove the policy.`,
    });
  }
  return { merged: current, warnings };
}

/** The warnings of `mergeLayersWithWhenTombstones` alone. */
export function findWhenTombstones(
  baseRaw: unknown,
  layers: ReadonlyArray<{ raw: unknown; label: string }>,
): ManifestPostureWarning[] {
  return mergeLayersWithWhenTombstones(baseRaw, layers).warnings;
}

export function loadMergedRaw(opts: LoaderOptions = {}): LoadedRaw {
  const resolved = resolvePaths(opts);

  const baseRaw = readYamlFile(resolved.base, "manifest");
  const machineLayers = resolved.machineLayers.map((p, i) =>
    readYamlFile(p, `machine override layer ${i + 1}`),
  );
  const projectLayer = resolved.projectLayer
    ? readYamlFile(resolved.projectLayer, "project override layer")
    : undefined;

  // One merge: the walk merges every layer in load order (the same order
  // `applyLayers` uses) and returns the merged manifest with the warnings.
  const { merged: mergedRaw, warnings } = mergeLayersWithWhenTombstones(baseRaw, [
    ...machineLayers.map((raw, i) => ({ raw, label: `machine override layer ${i + 1} (${resolved.machineLayers[i]})` })),
    ...(resolved.projectLayer ? [{ raw: projectLayer, label: `project override layer (${resolved.projectLayer})` }] : []),
  ]);
  return { mergedRaw, resolved, warnings };
}

export function loadManifest(opts: LoaderOptions = {}): LoadedManifest {
  const { mergedRaw, resolved, warnings: layerWarnings } = loadMergedRaw(opts);
  let manifest: Manifest;
  let warnings: ManifestPostureWarning[];
  let indexMaps: StrippedIndexMaps | undefined;
  try {
    ({ manifest, warnings, indexMaps } = parseManifestWithWarnings(mergedRaw));
  } catch (err) {
    if (err instanceof ManifestParseError) {
      throw new HarnessExitError(err.message, EX_NOINPUT);
    }
    throw err;
  }

  return {
    manifest,
    resolved,
    warnings: [...layerWarnings, ...warnings],
    ...(indexMaps !== undefined ? { indexMaps } : {}),
  };
}
