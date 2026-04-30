// `harness apply [--dry-run] [--overwrite-drift]`.
//
// Pipeline:
//   1. Load the effective manifest.
//   2. Generate expected runtime files: settings.json (Phase 3 #2),
//      MEMORY.md index (Phase 3 #3).
//   3. Read `harness.generated/.last-apply` (Phase 3 #1) if present.
//   4. Read on-disk `harness.generated/<file>` if present.
//   5. Three-state-compare per file (Phase 3 #1):
//        no-drift       → write expected (overwrite is safe)
//        safe-overwrite → write expected (no on-disk file existed)
//        drift-refuse   → refuse with diff + adopt-or-overwrite hint
//   6. `--overwrite-drift` requires literal `yes` confirmation before
//      discarding on-disk changes; on confirm, treat refusals as
//      safe-overwrite.
//   7. `--dry-run` prints the would-be diff + would-emit hints, exits 0
//      without writing.
//   8. After successful write: refresh `.last-apply` (with a manifest
//      snapshot for the next apply's restart-hint comparison), write
//      `harness.lock` next to `harness.yaml`, emit restart hints.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { LOCK_BASENAME, buildLockEntries, writeLock } from "../../io/harness-lock.js";
import {
  buildLastApply,
  readLastApply,
  sha256Hex,
  writeLastApply,
  type LastApplyRecord,
} from "../../io/last-apply.js";
import { unifiedDiff } from "../../io/patch.js";
import { emitRestartHints } from "../../io/restart-hints.js";
import { compare, type ThreeStateVerdict } from "../../io/three-state.js";
import { parseManifest, type Manifest } from "../../schema/index.js";
import { EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { loadManifest } from "../loader.js";
import { generateMemoryIndex } from "./generate-memory-index.js";
import { generateSettings } from "./generate-settings.js";

export const GENERATED_DIRNAME = "harness.generated";
export const SETTINGS_BASENAME = "settings.json";
export const MEMORY_BASENAME = "MEMORY.md";
export const MANIFEST_BASENAME = "harness.yaml";

export interface ApplyOptions {
  configPath?: string;
  homeDir?: string;
  project?: string;
  dryRun?: boolean;
  overwriteDrift?: boolean;
  /** Test-injectable confirmation prompt; defaults to a stdin readline. */
  prompt?: (message: string) => Promise<string>;
}

export type ApplyOutcome =
  | "no-changes"
  | "applied"
  | "drift-refuse"
  | "drift-discarded"
  | "would-apply";

export interface FileApplyOutcome {
  basename: string;
  path: string;
  verdict: ThreeStateVerdict;
  /** Unified diff, present when verdict is `drift-refuse`. */
  diff?: string;
  /** True when `expected !== onDiskCurrent` (whether or not we wrote). */
  changed: boolean;
}

export interface ApplyResult {
  manifestPath: string;
  generatedDir: string;
  files: FileApplyOutcome[];
  warnings: string[];
  restartHints: string[];
  outcome: ApplyOutcome;
  written: boolean;
  dryRun: boolean;
  /** Path of the harness.lock that was (or would be) written. */
  lockPath: string;
}

const DRIFT_HINT_MESSAGE =
  'run "harness adopt <file>" to capture changes, or re-run with --overwrite-drift to discard them';

function defaultHome(opts: ApplyOptions): string {
  return opts.homeDir ?? path.join(os.homedir(), ".claude");
}

function resolveManifestPath(opts: ApplyOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(defaultHome(opts), MANIFEST_BASENAME);
}

async function readlinePrompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

interface ExpectedFile {
  basename: string;
  content: string;
}

function buildExpectedFiles(
  manifest: Manifest,
  opts: ApplyOptions,
): { files: ExpectedFile[]; warnings: string[] } {
  const settings = `${JSON.stringify(generateSettings(manifest), null, 2)}\n`;
  const indexResult = generateMemoryIndex(manifest, {
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.project !== undefined ? { projectName: opts.project } : {}),
  });
  return {
    files: [
      { basename: SETTINGS_BASENAME, content: settings },
      { basename: MEMORY_BASENAME, content: indexResult.content },
    ],
    warnings: indexResult.warnings,
  };
}

function readOnDisk(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function buildPrevManifestForHints(record: LastApplyRecord | null): Manifest | null {
  if (!record?.manifest) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.manifest.content);
  } catch {
    return null;
  }
  try {
    return parseManifest(parsed);
  } catch {
    return null;
  }
}

export async function apply(opts: ApplyOptions = {}): Promise<ApplyResult> {
  const manifestPath = resolveManifestPath(opts);
  if (!fs.existsSync(manifestPath)) {
    throw new HarnessExitError(
      `harness manifest not found at ${manifestPath}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  const generatedDir = path.join(defaultHome(opts), GENERATED_DIRNAME);
  const lockPath = path.join(path.dirname(manifestPath), LOCK_BASENAME);

  const loaderOpts: Parameters<typeof loadManifest>[0] = {
    configPath: manifestPath,
  };
  if (opts.homeDir !== undefined) loaderOpts.homeDir = opts.homeDir;
  if (opts.project !== undefined) loaderOpts.project = opts.project;
  const { manifest } = loadManifest(loaderOpts);

  const { files: expected, warnings } = buildExpectedFiles(manifest, opts);
  const lastApply = readLastApply(generatedDir);

  const fileOutcomes: FileApplyOutcome[] = [];
  let anyDriftRefuse = false;
  let anyChanged = false;

  for (const f of expected) {
    const target = path.join(generatedDir, f.basename);
    const onDisk = readOnDisk(target);
    const lastAppliedContent = lastApply?.files[f.basename]?.content ?? null;
    const verdict = compare({
      manifestExpected: f.content,
      lastApplied: lastAppliedContent,
      onDiskCurrent: onDisk,
    });
    const outcome: FileApplyOutcome = {
      basename: f.basename,
      path: target,
      verdict,
      changed: f.content !== onDisk,
    };
    if (verdict === "drift-refuse") {
      anyDriftRefuse = true;
      outcome.diff = unifiedDiff({
        fileName: f.basename,
        oldText: lastAppliedContent ?? "",
        newText: onDisk ?? "",
        oldHeader: "last-apply",
        newHeader: "on-disk",
      });
    }
    if (outcome.changed) anyChanged = true;
    fileOutcomes.push(outcome);
  }

  if (anyDriftRefuse && !opts.overwriteDrift) {
    return {
      manifestPath,
      generatedDir,
      files: fileOutcomes,
      warnings,
      restartHints: [],
      outcome: "drift-refuse",
      written: false,
      dryRun: opts.dryRun ?? false,
      lockPath,
    };
  }

  if (anyDriftRefuse && opts.overwriteDrift) {
    const promptFn = opts.prompt ?? readlinePrompt;
    const answer = await promptFn(
      "Type 'yes' to discard on-disk hand-edits and overwrite with manifest-expected content: ",
    );
    if (answer.trim() !== "yes") {
      return {
        manifestPath,
        generatedDir,
        files: fileOutcomes,
        warnings,
        restartHints: [],
        outcome: "drift-discarded",
        written: false,
        dryRun: opts.dryRun ?? false,
        lockPath,
      };
    }
    // Confirmed: promote drift-refuse outcomes to safe-overwrite for the
    // write phase. We keep the original verdict on the result for callers
    // that want to know what fired.
  }

  // Restart hints: compare the previous-apply's manifest snapshot to the
  // current effective manifest.
  const prevManifest = buildPrevManifestForHints(lastApply);
  const restartHints = prevManifest ? emitRestartHints(prevManifest, manifest) : [];

  if (opts.dryRun) {
    return {
      manifestPath,
      generatedDir,
      files: fileOutcomes,
      warnings,
      restartHints,
      outcome: anyChanged ? "would-apply" : "no-changes",
      written: false,
      dryRun: true,
      lockPath,
    };
  }

  if (!anyChanged && lastApply !== null) {
    // Idempotent no-op: nothing to write, .last-apply already current.
    return {
      manifestPath,
      generatedDir,
      files: fileOutcomes,
      warnings,
      restartHints,
      outcome: "no-changes",
      written: false,
      dryRun: false,
      lockPath,
    };
  }

  fs.mkdirSync(generatedDir, { recursive: true });
  for (const f of expected) {
    const target = path.join(generatedDir, f.basename);
    atomicWriteFile(target, f.content);
  }

  const newRecord: LastApplyRecord = buildLastApply(
    Object.fromEntries(expected.map((f) => [f.basename, f.content])),
  );
  const manifestSnapshotJson = JSON.stringify(manifest);
  newRecord.manifest = {
    sha256: sha256Hex(manifestSnapshotJson),
    content: manifestSnapshotJson,
  };
  writeLastApply(generatedDir, newRecord);

  const lockEntries = buildLockEntries(manifest, {
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.project !== undefined ? { projectName: opts.project } : {}),
  });
  writeLock(lockPath, lockEntries);

  return {
    manifestPath,
    generatedDir,
    files: fileOutcomes,
    warnings,
    restartHints,
    outcome: "applied",
    written: true,
    dryRun: false,
    lockPath,
  };
}

export { DRIFT_HINT_MESSAGE };
