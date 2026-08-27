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
import {
  deriveWorkflowGatePolicies,
  REVIEW_EVIDENCE_HOOK_BASH,
  REVIEW_EVIDENCE_HOOK_MCP,
} from "../../runtime/workflow-policies.js";
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
  /**
   * F8 (review round 2, 99f47307 Slice 1): workflow names whose runtime
   * merge gate is derived FROM this hook (see
   * `derivedGateReferencingWorkflows` below). Empty unless `type` is
   * `"hook"`, `name` is one of the two evidence hooks, AND `--force` was
   * passed (without it the pre-check refuses before either path). Unlike
   * `forcedReferences`, this is populated on the dry-run AND the write
   * path (F3, review round 3): there is no schema safety net for a
   * derived-only reference, so a `--force` write really does drop the
   * gate, and the CLI prints this list as the warning for it.
   */
  derivedGateReferences: string[];
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

/**
 * F8 (review round 2, 99f47307 Slice 1): `planRemove`'s
 * `referencingPolicies` only ever sees HAND-authored `policies:` entries
 * (it walks the raw YAML document). A `require-review-evidence[-bash]`
 * hook referenced ONLY by a `workflows[]`-derived merge gate (no
 * hand-authored policy names it) passed that check silently — `harness
 * remove hook require-review-evidence` would delete the hook and the
 * next `harness apply`/`policy intercept` would derive nothing for it
 * (hasWiredMergeGateHooks requires BOTH hooks), a silent regression from
 * "enforced" to "not enforced" for every workflow with `spawn:
 * "required"`. This consults the SAME derivation `withDerivedPolicies`
 * uses (`deriveWorkflowGatePolicies`) against the manifest as it stands
 * BEFORE the removal, and returns the names of workflows whose derived
 * gate references `hookName` — empty for any type/name that isn't one of
 * the two evidence hooks, or when the manifest fails to parse (the
 * existing schema-gate checks further down handle a malformed manifest;
 * this is a best-effort pre-check, not the safety net).
 */
function derivedGateReferencingWorkflows(yamlText: string, type: RemoveType, hookName: string): string[] {
  if (type !== "hook") return [];
  if (hookName !== REVIEW_EVIDENCE_HOOK_MCP && hookName !== REVIEW_EVIDENCE_HOOK_BASH) return [];
  let manifest;
  try {
    manifest = parseManifest(parseYaml(yamlText));
  } catch (err) {
    if (err instanceof ManifestParseError) return [];
    throw err;
  }
  // Non-empty only when BOTH evidence hooks are currently wired (see
  // `hasWiredMergeGateHooks`) — if only one is present already, no
  // workflow has an enforced gate to lose from removing the other.
  const derivedPolicies = deriveWorkflowGatePolicies(manifest);
  if (derivedPolicies.length === 0) return [];
  // F5 (review round 3 follow-up, 99f47307 Slice 1): this used to return
  // every workflow matching `workflowRequiresMergeGate` (the SHAPE test),
  // not the workflows the derivation actually produced a policy for (the
  // dedupe an equivalent hand-authored policy already covers on the same
  // surface derives NOTHING for; see `deriveWorkflowGates`'s `seen` set).
  // A manifest with two qualifying workflows where only one is actually
  // derived would name both here even though only one's gate is really
  // lost. Project the workflow name back out of each derived policy's
  // name instead (`workflow:<name>:review-before-merge[-bash]`), filtered
  // to the hook being removed so a `require-review-evidence`-only removal
  // does not also name workflows whose gate only depends on the bash hook.
  const affected = new Set<string>();
  for (const policy of derivedPolicies) {
    if (policy.hook !== hookName) continue;
    const match = /^workflow:(.+):review-before-merge(?:-bash)?$/.exec(policy.name);
    const workflowName = match?.[1];
    if (workflowName !== undefined) affected.add(workflowName);
  }
  return manifest.workflows.filter((wf) => affected.has(wf.name)).map((wf) => wf.name);
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

  // F8 (review round 2, 99f47307 Slice 1): the check above only sees
  // hand-authored `policies:` entries; a hook referenced ONLY by a
  // workflows[]-derived merge gate must get the same protection, or
  // `harness remove hook require-review-evidence` silently disables the
  // gate for every workflow with `spawn: "required"` (no dangling
  // schema reference to catch it afterwards — see
  // `derivedGateReferencingWorkflows`'s header for why there is no
  // schema-level safety net here the way there is for hand policies).
  const derivedGateWorkflows = derivedGateReferencingWorkflows(original, type, name);
  if (derivedGateWorkflows.length > 0 && !opts.force) {
    const wfList = derivedGateWorkflows.map((n) => `"${n}"`).join(", ");
    const verb = derivedGateWorkflows.length === 1 ? "workflow" : "workflows";
    throw new HarnessExitError(
      `${verb} ${wfList} derive${derivedGateWorkflows.length === 1 ? "s" : ""} a runtime merge gate ` +
        `from this hook (a review_subagent step with spawn: "required" followed by a merge step); ` +
        `removing it would silently disable that gate. Drop spawn: "required" on the workflow step ` +
        "first, or pass --force.",
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

  // derivedGateWorkflows is non-empty here only under --force (the
  // pre-check above threw otherwise), on BOTH paths: unlike a dangling
  // policy.hook reference, nothing downstream refuses a --force'd
  // derived-gate removal (see `derivedGateReferencingWorkflows`), so the
  // write path must report it too, not only the dry-run (F3, review
  // round 3; the round-2 code hard-coded `[]` on the write path and the
  // CLI never printed either).
  const derivedGateReferences = derivedGateWorkflows;

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
      derivedGateReferences,
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
    derivedGateReferences,
  };
}

export const KNOWN_REMOVE_TYPES: RemoveType[] = ["mcp", "cli", "skill", "hook"];

export function isRemoveType(s: string): s is RemoveType {
  return (KNOWN_REMOVE_TYPES as string[]).includes(s);
}
