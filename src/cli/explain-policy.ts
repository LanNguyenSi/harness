// Phase 7 #5 — `harness explain-policy` CLI entrypoint.
//
// Risk Gate debug verb: given a policy name and a tool-event JSON file,
// explain whether the policy would APPLY to that event, and why. A
// policy applies only when its `trigger:` matches AND — when declared —
// every `when:` clause holds against the enriched Action Envelope. This
// verb shows both verdicts side by side: the trigger match, the Risk
// Classifier profile, the resolved environment, and a per-clause `when:`
// breakdown, so an operator authoring a risk policy sees exactly which
// clause admitted an action or held it back.
//
// Distinct from `harness explain <policy> --trace`: that replays the
// LAST recorded decision from the evidence ledger; `explain-policy`
// evaluates a hypothetical event live and reads nothing from the ledger.

import { stringify as stringifyYaml } from "yaml";
import {
  classifyRisk,
  evaluateWhen,
  policyMatchesEvent,
  resolveDeletionTarget,
  resolveEnvironment,
  type DeletionTargetVerdict,
  type EnvironmentResolution,
  type RiskProfile,
  type WhenClauseResult,
} from "../runtime/index.js";
import { parseKubectlTarget } from "../runtime/kubectl-target-parse.js";
import { extractShellCommand } from "../runtime/tool-name-aliases.js";
import type { Manifest } from "../schema/index.js";
import { DEFAULT_SAFE_DELETION_ROOTS } from "../schema/risk.js";
import { enrichLoadedEvent } from "./enriched-event.js";
import { loadEventEnvelope, type EventInputSeams } from "./event-input.js";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface ExplainPolicyOptions extends EventInputSeams, LoaderOptions {
  /** Path to the tool-event JSON file (the `--event` argument). */
  eventPath: string;
  /** Emit JSON instead of YAML. */
  json?: boolean;
  /** Inject the resolved manifest (tests); bypasses `loadManifest`. */
  manifest?: Manifest;
  /** Inject env vars for `env_var_patterns` (tests); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Inject the kube context (tests); bypasses `~/.kube/config`. */
  kubeContext?: string;
  /** Inject the kube namespace (tests); bypasses `~/.kube/config`. */
  kubeNamespace?: string;
}

interface ExplainPolicyProjection {
  policy: string;
  description: string;
  trigger: {
    event: string;
    match?: string;
    path_match?: string;
    bash_match?: string;
    matched: boolean;
  };
  classifier: RiskProfile;
  environment: EnvironmentResolution;
  /**
   * Which parts of the hook's evaluation this verb mirrors and which it
   * deliberately does not (task 7c3919a2). `envelope_enrichment` lists the
   * Bash-prefix merges shared with `harness policy intercept`;
   * `not_evaluated` lists what the hook does that this hypothetical,
   * read-free verb does not.
   */
  parity: {
    envelope_enrichment: string[];
    not_evaluated: string[];
    /**
     * Per-event (task 8b891e83): true when the Bash prefix remainder
     * (what follows a leading `cd`/`VAR=value`/`git switch` prefix) is a
     * `kubectl` command carrying an explicit `--context`/`--namespace`/
     * `-n`. The hook merges that target into its environment resolution
     * upgrade-only; this verb never does (`not_evaluated` lists
     * `kubectl_target` statically), so `true` tells the operator the
     * `applies` verdict below was computed WITHOUT a merge the hook
     * would perform for this very event. `false` means no such target
     * was found, i.e. the skipped merge would have been a no-op.
     */
    kubectl_target_present: boolean;
  };
  /** Static deletion-target verdict (task d03af8f6); null when the
   *  event's command is not a recognized deletion verb. */
  deletion_target: DeletionTargetVerdict | null;
  when:
    | { declared: false }
    | {
        declared: true;
        matched: boolean;
        clauses: WhenClauseResult[];
        unclassifiedFallback: boolean;
      };
  /** trigger AND when — would this policy fire on this event? */
  applies: boolean;
}

export interface ExplainPolicyResult {
  output: string;
  projection: ExplainPolicyProjection;
}

/**
 * Explain whether `policyName` applies to the event at `opts.eventPath`.
 *
 * Throws `HarnessExitError(EX_USAGE)` when the named policy is not
 * declared in the manifest, and `HarnessExitError(EX_NOINPUT)` (via
 * `loadEventEnvelope`) when the event file is missing or malformed.
 */
export function explainPolicy(
  policyName: string,
  opts: ExplainPolicyOptions,
): ExplainPolicyResult {
  // PLAIN load (task c88461c1, review round 3, decision D-028): every
  // check this verb performs against `manifest` below -- finding the
  // named policy, trigger matching, the Risk Classifier, environment
  // resolution, deletion-target resolution, and the `when:` evaluation
  // -- reads the base/machine/explicit-`--project` manifest only, an
  // explicit `opts.project` still wins outright but NOTHING is derived
  // from cwd here. This mirrors `harness policy intercept`
  // (src/cli/policy/intercept.ts) and `harness dry-run`
  // (src/cli/dry-run.ts), the two enforcement-facing verbs that decide
  // a policy's real trigger verdict: neither ever consults a derived
  // project layer, so this manifest must not either, or an operator's
  // "would this apply" answer could disagree with what actually enforces.
  let manifest: Manifest;
  if (opts.manifest) {
    manifest = opts.manifest;
  } else {
    manifest = loadManifest(opts).manifest;
  }
  const policy = manifest.policies.find((p) => p.name === policyName);
  if (!policy) {
    const available = manifest.policies.map((p) => p.name).join(", ") || "(none)";
    throw new HarnessExitError(
      `no policy named "${policyName}" declared; available: ${available}`,
      EX_USAGE,
    );
  }

  const loaded = loadEventEnvelope(opts.eventPath, opts, "explain-policy");
  const { event } = loaded;

  // Envelope enrichment shared with `harness policy intercept` (task
  // 7c3919a2): the leading Bash prefix (inline `VAR=value`, `cd <path>
  // &&`, `git switch|checkout <branch> &&`) is parsed and merged into
  // the resolver inputs by the SAME helper the hook uses (through
  // `enrichLoadedEvent`, shared with `resolve-env`, `test-risk` and
  // `explain-action`, task 8b891e83), so this verb cannot report
  // `unknown` for a command the hook resolves to `production`. Only the
  // envelope enrichment is shared; this verb still reads no ledger or
  // evidence.
  const { envelope, enrichment, kube } = enrichLoadedEvent(loaded, manifest, opts);

  const classifier = classifyRisk(envelope, manifest.risk.classifiers);
  const environment = resolveEnvironment(
    envelope,
    manifest.environments.resolvers,
    {
      env: enrichment.env,
      kubeContext: kube.context,
      kubeNamespace: kube.namespace,
    },
  );

  // Static deletion-target resolution (task d03af8f6) — same "raw
  // command only, no ambient cwd/env" contract as the runtime's own
  // `enrichEnvelope`. See `deletion-target-resolve.ts`.
  const explainShellCommand = extractShellCommand({ raw_input: envelope.raw_input });
  const deletionTarget =
    explainShellCommand === null
      ? null
      : resolveDeletionTarget(
          explainShellCommand,
          manifest.risk.safe_deletion_roots ?? DEFAULT_SAFE_DELETION_ROOTS,
        );

  const triggerMatched = policyMatchesEvent(policy, event);
  const whenEval =
    policy.when !== undefined
      ? evaluateWhen(policy.when, { risk: classifier, environment, deletionTarget })
      : undefined;

  // Same remainder the hook feeds `parseKubectlTarget` (after the
  // prefix consumed `cd`/`VAR=value`/`git switch`); flag only, no merge.
  const kubectlSubject =
    enrichment.riskBashCommand === null
      ? null
      : enrichment.riskBashCommand.slice(enrichment.bashPrefix?.remainderStart ?? 0);
  const kubectlTarget = kubectlSubject === null ? null : parseKubectlTarget(kubectlSubject);
  const kubectlTargetPresent =
    kubectlTarget !== null && (kubectlTarget.context !== null || kubectlTarget.namespace !== null);

  const projection: ExplainPolicyProjection = {
    policy: policy.name,
    description: policy.description,
    trigger: {
      event: policy.trigger.event,
      ...(policy.trigger.match !== undefined && { match: policy.trigger.match }),
      ...(policy.trigger.path_match !== undefined && {
        path_match: policy.trigger.path_match,
      }),
      ...(policy.trigger.bash_match !== undefined && {
        bash_match: policy.trigger.bash_match,
      }),
      matched: triggerMatched,
    },
    classifier,
    environment,
    parity: {
      envelope_enrichment: ["inline_env", "cd_git_context", "branch_switch_upgrade"],
      not_evaluated: ["ledger_requires", "kubectl_target"],
      kubectl_target_present: kubectlTargetPresent,
    },
    deletion_target: deletionTarget,
    when: whenEval
      ? {
          declared: true,
          matched: whenEval.matched,
          clauses: whenEval.clauses,
          unclassifiedFallback: whenEval.unclassifiedFallback,
        }
      : { declared: false },
    applies: triggerMatched && (whenEval ? whenEval.matched : true),
  };

  const output = opts.json
    ? `${JSON.stringify(projection, null, 2)}\n`
    : stringifyYaml(projection, { lineWidth: 0 });
  return { output, projection };
}
