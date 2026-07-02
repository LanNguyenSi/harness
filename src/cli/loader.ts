import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { applyLayers } from "../overrides/merge.js";
import {
  machineOverrideCandidates,
  resolveMachineDiscriminators,
  type DiscriminatorOptions,
} from "../overrides/machines.js";
import { ManifestParseError, parseManifest, type Manifest } from "../schema/index.js";
import { resolveHomeDir } from "../runtime/home-dir.js";
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
}

export interface LoadedRaw {
  mergedRaw: unknown;
  resolved: ResolvedPaths;
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

  let projectLayer: string | null = null;
  if (opts.project) {
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
    raw = fs.readFileSync(filePath, "utf8");
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

export function loadMergedRaw(opts: LoaderOptions = {}): LoadedRaw {
  const resolved = resolvePaths(opts);

  const baseRaw = readYamlFile(resolved.base, "manifest");
  const machineLayers = resolved.machineLayers.map((p, i) =>
    readYamlFile(p, `machine override layer ${i + 1}`),
  );
  const projectLayer = resolved.projectLayer
    ? readYamlFile(resolved.projectLayer, "project override layer")
    : undefined;

  const mergedRaw = applyLayers(baseRaw, ...machineLayers, projectLayer);
  return { mergedRaw, resolved };
}

export function loadManifest(opts: LoaderOptions = {}): LoadedManifest {
  const { mergedRaw, resolved } = loadMergedRaw(opts);
  let manifest: Manifest;
  try {
    manifest = parseManifest(mergedRaw);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      throw new HarnessExitError(err.message, EX_NOINPUT);
    }
    throw err;
  }

  return { manifest, resolved };
}
