import { parse as parseYaml } from "yaml";
import { ManifestParseError, parseManifest, type Manifest } from "../../schema/index.js";
import { EX_NOINPUT, EX_USAGE, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";
import { diffManifests, formatDiff, type Change } from "./engine.js";
import { locateGitContext, readManifestAtRef } from "./git.js";

export interface DiffOptions extends LoaderOptions {
  since?: string;
}

export interface DiffResult {
  changes: Change[];
  output: string;
  before: Manifest;
  after: Manifest;
}

function parseRefManifest(raw: string): Manifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new HarnessExitError(
      `manifest at git ref is not valid YAML: ${(err as Error).message}`,
      EX_NOINPUT,
    );
  }
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
  const before = parseRefManifest(refRaw);
  const { manifest: after } = loadManifest(opts);
  const changes = diffManifests(before, after);
  const output = formatDiff(changes);
  return { changes, output, before, after };
}

export { diffManifests, formatDiff } from "./engine.js";
export type { Change, ChangeKind } from "./engine.js";
