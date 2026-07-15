// `harness pack reseed <name>` — pull the shipped builtin template's
// `config.ux` (and `config.producers`) into an already-installed manifest
// (task 68b9ad9c).
//
// Motivation: `harness apply` only projects the manifest OUT to
// settings.json / MEMORY.md; nothing propagates a deny-message wording
// fix in the shipped init templates back INTO an operator's existing
// `policy_packs[].config.ux` — the fix reaches only NEW `harness init`
// manifests. This is the opt-in write side of that gap; the read-side
// warning lives in `src/policy-packs/ux-drift-check.ts` (consumed by
// `harness doctor`). Both read the same canonical default via
// `resolveBuiltinDefaultConfig` (src/policy-packs/registry.ts).
//
// Deliberately explicit-only, mirroring `add`/`remove`: this verb is
// NEVER invoked by `apply`, so an operator's deliberate ux customisation
// is never silently clobbered by an upgrade — the operator has to
// actually run this command for their manifest to change. `--dry-run`
// prints the diff without writing so the change can be reviewed first.
// A pack whose current `config.ux` / `config.producers` already matches
// the shipped template is a no-op (nothing to write).

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
import { ManifestParseError, parseManifest } from "../../schema/index.js";
import { resolveBuiltinDefaultConfig } from "../../policy-packs/registry.js";
import { producersEqual, safeParseProducers, safeParseUx, uxEqual } from "../../policy-packs/ux-compare.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { applyPackReseedUx, type PackReseedFields } from "./mutate.js";

export interface PackReseedOptions {
  configPath?: string;
  homeDir?: string;
  dryRun?: boolean;
}

export type PackReseedField = "ux" | "producers";

export interface PackReseedResult {
  path: string;
  name: string;
  diff: string;
  applied: boolean;
  /**
   * Fields the reseed changed (or would change, on `--dry-run`):
   * "ux", "producers", both, or an empty array when the pack already
   * matched the shipped template (no-op, nothing written).
   */
  fieldsChanged: PackReseedField[];
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: PackReseedOptions): string {
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

export async function packReseed(
  name: string,
  opts: PackReseedOptions = {},
): Promise<PackReseedResult> {
  const target = resolveTargetPath(opts);
  if (!fs.existsSync(target)) {
    throw new HarnessExitError(
      `harness manifest not found at ${target}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  const original = fs.readFileSync(target, "utf8");
  let manifest;
  try {
    manifest = parseManifest(parseYaml(original));
  } catch (err) {
    const detail = err instanceof ManifestParseError ? err.message : String(err);
    throw new HarnessExitError(
      `manifest at ${target} fails schema validation; fix it with \`harness validate\` before reseeding:\n${detail}`,
      EX_FAIL,
    );
  }

  const pack = manifest.policy_packs.find((p) => p.name === name);
  if (!pack) {
    throw new HarnessExitError(
      `policy_packs entry ${JSON.stringify(name)} not found. Available entries:\n${formatNameList(
        manifest.policy_packs.map((p) => p.name),
      )}`,
      EX_FAIL,
    );
  }

  const canonical = resolveBuiltinDefaultConfig(pack);
  if (!canonical || (canonical.ux === undefined && canonical.producers === undefined)) {
    throw new HarnessExitError(
      `no shipped default config.ux / config.producers is registered for pack ${JSON.stringify(
        name,
      )}; nothing to reseed. See docs/policy-packs/ for which packs support reseed.`,
      EX_FAIL,
    );
  }

  const fieldsChanged: PackReseedField[] = [];
  const fields: PackReseedFields = {};

  if (canonical.ux !== undefined) {
    const currentUx = pack.config["ux"];
    const parsed = currentUx === undefined ? null : safeParseUx(currentUx);
    const alreadyCanonical = parsed !== null && uxEqual(parsed, canonical.ux);
    if (!alreadyCanonical) {
      fields.ux = canonical.ux;
      fieldsChanged.push("ux");
    }
  }
  if (canonical.producers !== undefined) {
    const currentProducers = pack.config["producers"];
    const parsed = currentProducers === undefined ? null : safeParseProducers(currentProducers);
    const alreadyCanonical = parsed !== null && producersEqual(parsed, canonical.producers);
    if (!alreadyCanonical) {
      fields.producers = canonical.producers;
      fieldsChanged.push("producers");
    }
  }

  if (fieldsChanged.length === 0) {
    return { path: target, name, diff: "", applied: false, fieldsChanged: [] };
  }

  const proposed = applyPackReseedUx(original, name, fields);
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
    return { path: target, name, diff, applied: false, fieldsChanged };
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    const current = fs.readFileSync(target, "utf8");
    const next = applyPackReseedUx(current, name, fields);
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, next);
  });

  return { path: target, name, diff, applied: true, fieldsChanged };
}
