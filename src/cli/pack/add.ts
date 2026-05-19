// `harness pack add <name>` — managed insert into policy_packs[].
//
// Mirrors src/cli/add/index.ts: schema-validate-before-write under a
// flock; surface dup-name + bad-mode errors at the point the user runs
// the command, not at the next `harness apply`.

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
import { isBuiltinPackName } from "../../policy-packs/index.js";
import { parsePackSource } from "../../policy-packs/source.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { applyPackAdd, type PackAddEntry } from "./mutate.js";

export interface PackAddOptions {
  configPath?: string;
  homeDir?: string;
  dryRun?: boolean;
}

export interface PackAddResult {
  path: string;
  name: string;
  diff: string;
  applied: boolean;
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: PackAddOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(
    resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path,
    DEFAULT_BASENAME,
  );
}

export async function packAdd(
  entry: PackAddEntry,
  opts: PackAddOptions = {},
): Promise<PackAddResult> {
  const target = resolveTargetPath(opts);
  if (!fs.existsSync(target)) {
    throw new HarnessExitError(
      `harness manifest not found at ${target}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  // Pre-flight: catch obviously-broken inputs before we touch the file lock.
  // The schema validate-before-write below catches the same conditions, but
  // surfacing a typed message here gives the user a one-liner hint instead
  // of a zod issue tree for the common cases.
  const sourceParsed = parsePackSource(entry.source ?? "builtin");
  if (sourceParsed.kind === "unknown") {
    throw new HarnessExitError(
      `policy_packs source ${JSON.stringify(
        entry.source,
      )} is not recognised in v1 (only "builtin" resolves). See docs/policy-packs/.`,
      EX_FAIL,
    );
  }
  if (sourceParsed.kind === "builtin" && !isBuiltinPackName(entry.name)) {
    throw new HarnessExitError(
      `policy_packs name ${JSON.stringify(
        entry.name,
      )} is not a known builtin pack. See docs/policy-packs/ for supported names.`,
      EX_FAIL,
    );
  }

  const original = fs.readFileSync(target, "utf8");
  const proposed = applyPackAdd(original, entry);
  const diff = unifiedDiff({
    fileName: path.basename(target),
    oldText: original,
    newText: proposed,
    oldHeader: "current",
    newHeader: "proposed",
  });

  // Schema gate: this is what catches duplicate-name across packs (the
  // PolicyPacksSchema superRefine fires here).
  const schemaResult = validateBeforeWrite(parseYaml(proposed));
  if (!schemaResult.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(schemaResult.errors)}`,
      EX_FAIL,
    );
  }

  if (opts.dryRun) {
    return { path: target, name: entry.name, diff, applied: false };
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    const current = fs.readFileSync(target, "utf8");
    const next = applyPackAdd(current, entry);
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, next);
  });

  return { path: target, name: entry.name, diff, applied: true };
}
