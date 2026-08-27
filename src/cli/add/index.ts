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
import { withDerivedPolicies } from "../../runtime/workflow-policies.js";
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
  warnings: string[];
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
  // typed Manifest for runAssetChecks. defaults flow through. Both this and
  // the baseline below take the DERIVED view (workflows[]-derived policies
  // folded in), the same view `harness validate` checks, so the gate here
  // and validate cannot disagree about what "declared" means (review round
  // 3, 99f47307 Slice 1); the derived entries cancel out in the baseline
  // comparison unless the add itself changes what is derived. This is
  // consistency-only, not a behavioral difference today: no error-severity
  // check in runAssetChecks reads manifest.policies, so no fixture that
  // parseManifest alone would pass and withDerivedPolicies would fail is
  // known to exist right now (review round 3, F2). The derived view is
  // kept as a parity pin against validate, and to stay correct the moment
  // a future check does read manifest.policies at error severity.
  const manifest = withDerivedPolicies(parseManifest(parseYaml(proposed)));
  // gitIgnoreProbe stays null: the knob-ignored check is warning-only and
  // this gate consumes errors, so the git spawn would be wasted work.
  const proposedErrors = runAssetChecks(manifest, {
    homeDir: opts.homeDir,
    gitIgnoreProbe: () => null,
  }).filter((d) => d.severity === "error");

  // Compute a baseline error set from the original manifest so that
  // pre-existing asset problems unrelated to this add do not block it.
  // If the original manifest cannot be parsed (broken base), fall back to
  // blocking on all proposed errors so the gate never weakens on a broken base.
  let baselineKeys = new Set<string>();
  try {
    const baselineManifest = withDerivedPolicies(parseManifest(parseYaml(original)));
    const baselineErrors = runAssetChecks(baselineManifest, {
      homeDir: opts.homeDir,
      gitIgnoreProbe: () => null,
    }).filter((d) => d.severity === "error");
    baselineKeys = new Set(baselineErrors.map((d) => `${d.severity}|${d.path}|${d.message}`));
  } catch {
    // Defensive backstop: a base manifest that cannot be parsed is normally
    // caught earlier (applyAdd / the proposed schema gate throw first), so this
    // branch is rarely reached. If it is, baselineKeys stays empty and every
    // proposed error is treated as new, i.e. the gate fails closed.
  }

  const newErrors = proposedErrors.filter(
    (d) => !baselineKeys.has(`${d.severity}|${d.path}|${d.message}`),
  );
  const preExistingErrors = proposedErrors.filter((d) =>
    baselineKeys.has(`${d.severity}|${d.path}|${d.message}`),
  );

  if (newErrors.length > 0) {
    const lines = newErrors.map(fmtDiagnostic).join("\n");
    throw new HarnessExitError(
      `proposed manifest fails asset validation:\n${lines}`,
      EX_FAIL,
    );
  }

  const warnings: string[] = [];
  if (preExistingErrors.length > 0) {
    const lines = preExistingErrors.map(fmtDiagnostic).join("\n");
    warnings.push(
      `harness manifest has ${preExistingErrors.length} pre-existing asset error(s) unrelated to this add; run \`harness validate\` to see them:\n${lines}`,
    );
  }

  if (opts.dryRun) {
    return { path: target, type: action.type, name: entryName(action), diff, applied: false, warnings };
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

  return { path: target, type: action.type, name: entryName(action), diff, applied: true, warnings };
}
