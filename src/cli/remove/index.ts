import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
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
  force?: boolean;
}

export interface RemoveResult {
  path: string;
  type: RemoveType;
  name: string;
  diff: string;
  applied: boolean;
  forcedReferences: string[];
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: RemoveOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(opts.homeDir ?? path.join(os.homedir(), ".claude"), DEFAULT_BASENAME);
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

  if (plan.referencingPolicies.length > 0 && !opts.force) {
    const refList = plan.referencingPolicies.map((p) => `"${p}"`).join(", ");
    const verb = plan.referencingPolicies.length === 1 ? "policy" : "policies";
    throw new HarnessExitError(
      `${verb} ${refList} reference${plan.referencingPolicies.length === 1 ? "s" : ""} this hook; remove the ${verb} first or pass --force`,
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

  // Schema gate. With --force on a referenced hook, the resulting manifest
  // contains a dangling policy.hook reference, which the schema rejects.
  // That refusal is the contract: --force does not let you ship a broken
  // manifest, it just tells remove to skip the human-readable hook-reference
  // pre-check. The actual safety net is the schema, which still fires.
  const schemaResult = validateBeforeWrite(parseYaml(proposed));
  if (!schemaResult.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(schemaResult.errors)}`,
      EX_FAIL,
    );
  }

  if (opts.dryRun) {
    // forcedReferences is informational on dry-run: it shows the user which
    // policies would have been overridden if the schema gate did not refuse.
    // On the write path below it is always [] because --force on a referenced
    // hook never reaches that point — the schema rejects the dangling reference.
    return {
      path: target,
      type,
      name,
      diff,
      applied: false,
      forcedReferences: opts.force ? plan.referencingPolicies : [],
    };
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
    // Always [] on the write path — schema gate rejects --force on a referenced
    // hook, so the only way to reach here with --force is when there are no
    // referencing policies to begin with.
    forcedReferences: [],
  };
}

export const KNOWN_REMOVE_TYPES: RemoveType[] = ["mcp", "cli", "skill", "hook"];

export function isRemoveType(s: string): s is RemoveType {
  return (KNOWN_REMOVE_TYPES as string[]).includes(s);
}
