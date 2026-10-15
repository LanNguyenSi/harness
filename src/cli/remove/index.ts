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
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { applyRemove, planRemove, type RemoveType } from "./mutate.js";

export interface RemoveOptions {
  configPath?: string;
  homeDir?: string;
  dryRun?: boolean;
}

export interface RemoveResult {
  path: string;
  type: RemoveType;
  name: string;
  diff: string;
  applied: boolean;
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: RemoveOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(
    resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path,
    DEFAULT_BASENAME,
  );
}

function formatNameList(names: string[]): string {
  if (names.length === 0) return "(none declared)";
  return names.map((n) => `  - ${n}`).join("\n");
}

export async function remove(
  type: RemoveType,
  name: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const target = resolveTargetPath(opts);
  if (!fs.existsSync(target)) {
    throw new HarnessExitError(
      `harness manifest not found at ${target}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  const original = fs.readFileSync(target, "utf8");
  const plan = planRemove(original, type, name);

  if (!plan.found) {
    throw new HarnessExitError(
      `${type} entry "${name}" not found. Available ${type} entries:\n${formatNameList(plan.availableNames)}`,
      EX_FAIL,
    );
  }

  const proposed = applyRemove(original, type, name);
  const diff = unifiedDiff({
    fileName: path.basename(target),
    oldText: original,
    newText: proposed,
    oldHeader: "current",
    newHeader: "proposed",
  });

  // Schema gate: the resulting manifest has to parse.
  const schemaResult = validateBeforeWrite(parseYaml(proposed));
  if (!schemaResult.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(schemaResult.errors)}`,
      EX_FAIL,
    );
  }

  if (opts.dryRun) {
    return { path: target, type, name, diff, applied: false };
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    const current = fs.readFileSync(target, "utf8");
    const next = applyRemove(current, type, name);
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, next);
  });

  return {
    path: target,
    type,
    name,
    diff,
    applied: true,
  };
}

export const KNOWN_REMOVE_TYPES: RemoveType[] = ["mcp", "cli", "skill", "hook"];

export function isRemoveType(s: string): s is RemoveType {
  return (KNOWN_REMOVE_TYPES as string[]).includes(s);
}
