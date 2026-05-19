import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { withFileLock } from "../../io/lock.js";
import { unifiedDiff } from "../../io/patch.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { parseManifest } from "../../schema/index.js";
import { runAssetChecks } from "../validate/checks.js";
import { fmtDiagnostic } from "../validate/types.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { applyAdd, type AddEntry } from "./mutate.js";

export interface AddOptions {
  configPath?: string;
  homeDir?: string;
  dryRun?: boolean;
}

export interface AddResult {
  path: string;
  type: AddEntry["type"];
  name: string;
  diff: string;
  applied: boolean;
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: AddOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(
    resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path,
    DEFAULT_BASENAME,
  );
}

function entryName(action: AddEntry): string {
  return action.type === "skill" ? action.entry : action.entry.name;
}

export async function add(action: AddEntry, opts: AddOptions = {}): Promise<AddResult> {
  const target = resolveTargetPath(opts);
  if (!fs.existsSync(target)) {
    throw new HarnessExitError(
      `harness manifest not found at ${target}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  const original = fs.readFileSync(target, "utf8");
  const proposed = applyAdd(original, action);
  const diff = unifiedDiff({
    fileName: path.basename(target),
    oldText: original,
    newText: proposed,
    oldHeader: "current",
    newHeader: "proposed",
  });

  // Schema gate.
  const schemaResult = validateBeforeWrite(parseYaml(proposed));
  if (!schemaResult.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(schemaResult.errors)}`,
      EX_FAIL,
    );
  }

  // Asset gate — surfaces hook +x failures, missing required CLIs, etc.
  // We use parseManifest (not the result of validateBeforeWrite) so we have a
  // typed Manifest for runAssetChecks. defaults flow through.
  const manifest = parseManifest(parseYaml(proposed));
  const assetDiagnostics = runAssetChecks(manifest, { homeDir: opts.homeDir }).filter(
    (d) => d.severity === "error",
  );
  if (assetDiagnostics.length > 0) {
    const lines = assetDiagnostics.map(fmtDiagnostic).join("\n");
    throw new HarnessExitError(
      `proposed manifest fails asset validation:\n${lines}`,
      EX_FAIL,
    );
  }

  if (opts.dryRun) {
    return { path: target, type: action.type, name: entryName(action), diff, applied: false };
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    // Re-read under the lock and re-apply so we never clobber a concurrent
    // commit. The schema/asset checks above ran on the pre-lock snapshot;
    // the post-lock apply re-validates implicitly via parseDocument round-trip
    // and the inserted entry is still added because applyAdd is purely additive.
    const current = fs.readFileSync(target, "utf8");
    const next = applyAdd(current, action);
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, next);
  });

  return { path: target, type: action.type, name: entryName(action), diff, applied: true };
}
