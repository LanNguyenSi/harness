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
  resolveKubeContext,
  type DeletionTargetVerdict,
  type EnvironmentResolution,
  type RiskProfile,
  type WhenClauseResult,
} from "../runtime/index.js";
import { extractShellCommand } from "../runtime/tool-name-aliases.js";
import type { Manifest } from "../schema/index.js";
import { DEFAULT_SAFE_DELETION_ROOTS } from "../schema/risk.js";
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
  const manifest = opts.manifest ?? loadManifest(opts).manifest;
  const policy = manifest.policies.find((p) => p.name === policyName);
  if (!policy) {
    const available = manifest.policies.map((p) => p.name).join(", ") || "(none)";
    throw new HarnessExitError(
      `no policy named "${policyName}" declared; available: ${available}`,
      EX_USAGE,
    );
  }

  const { event, envelope } = loadEventEnvelope(
    opts.eventPath,
    opts,
    "explain-policy",
  );

  // Kube seams resolve together: if either is injected, skip the
  // `~/.kube/config` read entirely — same contract as `resolve-env`.
  const kube =
    opts.kubeContext !== undefined || opts.kubeNamespace !== undefined
      ? { context: opts.kubeContext ?? "", namespace: opts.kubeNamespace ?? "" }
      : resolveKubeContext();

  const classifier = classifyRisk(envelope, manifest.risk.classifiers);
  const environment = resolveEnvironment(
    envelope,
    manifest.environments.resolvers,
    {
      env: opts.env ?? process.env,
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
