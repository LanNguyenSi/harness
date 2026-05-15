// `harness pack remove <name>` — managed remove from policy_packs[].
//
// Reference-checked: refuses (without --force) when `.last-apply` records
// files under `policy-packs/<name>/`, on the theory that `harness apply`
// has run with this pack present and removing it without telling apply
// would leave orphan files in `harness.generated/`. With --force, the
// manifest entry is removed AND the orphan files are deleted AND the
// `.last-apply` file entries are pruned, so the next `harness apply` is
// a clean no-op.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import { writeLastApply } from "../../io/last-apply.js";
import {
  LAST_APPLY_BASENAME,
  readLastApply,
  type LastApplyRecord,
} from "../../io/last-apply.js";
import { withFileLock } from "../../io/lock.js";
import { unifiedDiff } from "../../io/patch.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { applyPackRemove, planPackRemove } from "./mutate.js";

export interface PackRemoveOptions {
  configPath?: string;
  homeDir?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface PackRemoveResult {
  path: string;
  name: string;
  diff: string;
  applied: boolean;
  /** Pack files that were (or would be) deleted because of --force. */
  cleanedFiles: string[];
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: PackRemoveOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(opts.homeDir ?? path.join(os.homedir(), ".claude"), DEFAULT_BASENAME);
}

function packFileKeys(record: LastApplyRecord | null, packName: string): string[] {
  if (!record) return [];
  const prefix = `policy-packs/${packName}/`;
  return Object.keys(record.files)
    .filter((k) => k.startsWith(prefix))
    .sort();
}

function pruneRecord(record: LastApplyRecord, packName: string): LastApplyRecord {
  const out: LastApplyRecord = {
    files: {},
    ...(record.manifest !== undefined ? { manifest: record.manifest } : {}),
    ...(record.memoryDirs !== undefined ? { memoryDirs: record.memoryDirs } : {}),
  };
  const prefix = `policy-packs/${packName}/`;
  for (const [key, entry] of Object.entries(record.files)) {
    if (!key.startsWith(prefix)) out.files[key] = entry;
  }
  return out;
}

function formatNameList(names: string[]): string {
  if (names.length === 0) return "(none declared)";
  return names.map((n) => `  - ${n}`).join("\n");
}

// Belt-and-braces defense against a path-traversal `name` reaching the
// filesystem cleanup. The schema regex on PolicyPackSchema.name catches
// this at parseManifest time, but planPackRemove reads the YAML
// directly (not via the schema), so a malformed manifest could still
// surface a bad name here. Refuse rather than rmSync into the void.
const SAFE_PACK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function packRemove(
  name: string,
  opts: PackRemoveOptions = {},
): Promise<PackRemoveResult> {
  const target = resolveTargetPath(opts);
  if (!fs.existsSync(target)) {
    throw new HarnessExitError(
      `harness manifest not found at ${target}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  if (!SAFE_PACK_NAME_RE.test(name)) {
    throw new HarnessExitError(
      `policy_pack name ${JSON.stringify(
        name,
      )} contains path separators or other unsafe characters; refusing to operate on it. Allowed: [A-Za-z0-9._-], leading char alphanumeric.`,
      EX_FAIL,
    );
  }

  const original = fs.readFileSync(target, "utf8");
  const plan = planPackRemove(original, name);

  if (!plan.found) {
    throw new HarnessExitError(
      `policy_packs entry "${name}" not found. Available entries:\n${formatNameList(
        plan.availableNames,
      )}`,
      EX_FAIL,
    );
  }

  const generatedDir = resolveGeneratedDir({ homeDir: opts.homeDir, manifestPath: target });
  const lastApply = readLastApply(generatedDir);
  const trackedFiles = packFileKeys(lastApply, name);

  if (trackedFiles.length > 0 && !opts.force) {
    const list = trackedFiles.map((f) => `  - ${f}`).join("\n");
    throw new HarnessExitError(
      `pack "${name}" has applied state present in ${LAST_APPLY_BASENAME}:\n${list}\n` +
        `Pass --force to remove the manifest entry and clean up these generated files. ` +
        `(Without cleanup, a subsequent \`harness apply\` would not delete them.)`,
      EX_FAIL,
    );
  }

  const proposed = applyPackRemove(original, name);
  const diff = unifiedDiff({
    fileName: path.basename(target),
    oldText: original,
    newText: proposed,
    oldHeader: "current",
    newHeader: "proposed",
  });

  const schemaResult = validateBeforeWrite(parseYaml(proposed));
  if (!schemaResult.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(schemaResult.errors)}`,
      EX_FAIL,
    );
  }

  if (opts.dryRun) {
    // On dry-run, surface what --force WOULD clean up so the user can
    // sanity-check the blast radius before committing.
    return {
      path: target,
      name,
      diff,
      applied: false,
      cleanedFiles: opts.force ? trackedFiles : [],
    };
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  const cleanedFiles: string[] = [];

  await withFileLock(lockPath, () => {
    const current = fs.readFileSync(target, "utf8");
    const next = applyPackRemove(current, name);
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, next);

    // Best-effort cleanup under --force. We do this AFTER the manifest
    // write has succeeded so a partial cleanup never leaves the manifest
    // in a confusing half-state. Each fs operation is wrapped: a missing
    // file is a no-op, not a failure (the user may have deleted it
    // manually since the last apply).
    if (opts.force && trackedFiles.length > 0) {
      const packDir = path.join(generatedDir, "policy-packs", name);
      try {
        fs.rmSync(packDir, { recursive: true, force: true });
      } catch {
        // ignore — best-effort
      }
      // Update .last-apply so the next `harness apply` no-ops cleanly
      // instead of detecting the now-missing files as drift.
      const fresh = readLastApply(generatedDir);
      if (fresh) {
        const pruned = pruneRecord(fresh, name);
        writeLastApply(generatedDir, pruned);
      }
      cleanedFiles.push(...trackedFiles);
    }
  });

  return {
    path: target,
    name,
    diff,
    applied: true,
    cleanedFiles,
  };
}
