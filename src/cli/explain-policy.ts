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

import * as fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  classifyRisk,
  deriveProjectName,
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
import { loadManifest, type LoaderOptions, type ResolvedPaths } from "./loader.js";

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
  /**
   * cwd `session_start_preflight.setup`'s per-repo project layer is
   * derived from when `opts.project` is absent (task c88461c1, review
   * round 2, decision D-021b): the same `deriveProjectName` helper
   * `harness session-start preflight` and `harness doctor` also feed
   * their own `loadManifest` call from, so all three consumers agree on
   * which project layer applies to a given cwd instead of `explain-
   * policy` silently reporting the base/machine value for a repo whose
   * producer is actually reading a project layer. Defaults to
   * `process.cwd()`; tests inject a fixture repo dir to stay hermetic
   * against the real cwd.
   */
  cwd?: string;
}

/**
 * Which resolved layer decided `session_start_preflight.setup` (task
 * c88461c1): "project" when the resolved project-override layer
 * itself declares the key, "machine" when a resolved machine-override
 * layer declares it (and no project layer does), "base" otherwise
 * (the base manifest, or the schema default when nothing declares the
 * key at all). Mirrors the loader's own last-wins precedence
 * (`applyLayers(baseRaw, ...machineLayers, projectLayer)`,
 * `src/overrides/merge.ts`): the project layer is checked first since
 * it is the highest-precedence layer, then machine layers from the
 * last-applied (highest-precedence) one back to the first.
 *
 * "unresolvable" (task c88461c1, review round 3 residual, decision
 * D-006 of the follow-up run): the cwd-derived project-scoped SECOND
 * load itself threw (a malformed project layer, an unreadable file).
 * Deliberately NOT "base": the base/machine values were never actually
 * re-read on this path (the plain load above them; see the round-3
 * comment this residual corrected), so attributing the result to
 * "base" would claim a value the base layer may not carry. `setup`
 * degrades to `false` alongside it, matching the producer's own
 * `setupEnabled` catch (`src/cli/session-start/index.ts`), so the two
 * agree on a scoped-load failure instead of only on a healthy load.
 */
export type SessionStartPreflightLayerSource = "base" | "machine" | "project" | "unresolvable";

/**
 * Does `filePath`'s raw YAML explicitly declare `session_start_preflight.setup`?
 *
 * "Declare" means KEY PRESENCE, not "holds a boolean" (review round 2,
 * finding: a tombstone, `session_start_preflight: null` or `{setup:
 * null}`, both honoured by `mergeValue` in src/overrides/merge.ts as
 * "delete whatever a lower layer set, falling back to the schema
 * default", is exactly as much a deliberate declaration by THIS layer
 * as `setup: true`/`false` is; it just resolves to a different final
 * value. Attributing a tombstoned layer's decision to whichever lower
 * layer happens to also declare the key (or to "base" when none does)
 * would name the WRONG layer as the one that decided the merged
 * result.
 */
function layerDeclaresSetup(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseYaml(raw) as { session_start_preflight?: unknown } | null;
    if (parsed === null || typeof parsed !== "object") return false;
    if (!("session_start_preflight" in parsed)) return false;
    const block = parsed.session_start_preflight;
    if (block === null) return true; // whole-block tombstone
    if (typeof block !== "object" || Array.isArray(block)) return false;
    return "setup" in (block as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * Re-reads the resolved layer files (independent of the already-merged
 * `manifest` object, which no longer carries per-layer provenance once
 * `applyLayers` has folded them together) to attribute the decided
 * `session_start_preflight.setup` value to the layer that set it.
 */
function resolveSessionStartPreflightSource(
  resolved: ResolvedPaths,
): SessionStartPreflightLayerSource {
  if (resolved.projectLayer !== null && layerDeclaresSetup(resolved.projectLayer)) {
    return "project";
  }
  for (let i = resolved.machineLayers.length - 1; i >= 0; i--) {
    if (layerDeclaresSetup(resolved.machineLayers[i]!)) return "machine";
  }
  return "base";
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
  /**
   * Resolved `session_start_preflight` config (task 30183330), shown
   * only when the explained policy is one of the init-generated
   * `preflight-before-*` gates (name starts with `preflight-before-`):
   * this is the knob that decides whether the `harness session-start
   * preflight` / `harness preflight` producer passes `--setup` to the
   * `preflight run` invocation whose `ready:true` result these policies
   * gate on. Omitted for every other policy; it has no bearing on
   * their evaluation (review round 3 residual, decision D-006: the
   * scoped SECOND load below this field's assignment site runs ONLY
   * when this condition is already true, so a policy this block is
   * never rendered for never pays for that extra load either).
   * `source` (task c88461c1) names which resolved layer decided the
   * value: `"base"` (also covers an injected `opts.manifest`, which
   * carries no per-layer provenance to attribute), `"machine"`,
   * `"project"` (the cwd-derived per-repo layer), or `"unresolvable"`
   * (review round 3 residual, decision D-006: the scoped load itself
   * threw, `setup` degrades to `false` alongside it). This function
   * derives that project name itself, from `opts.cwd`, via the SAME
   * `deriveProjectName` helper `harness session-start preflight` feeds
   * through `LoaderOptions.project` (review round 2, decision D-021b:
   * without this, an operator running `explain-policy` with no
   * `--project` in a repo that DOES have a project layer would see the
   * base/machine value while the producer itself reads the project
   * layer, see src/cli/session-start/index.ts).
   */
  session_start_preflight?: { setup: boolean; source: SessionStartPreflightLayerSource };
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
  // `resolved` is only available on the real `loadManifest(opts)` path:
  // an injected `opts.manifest` already IS the merged result and
  // carries no per-layer provenance, so `session_start_preflight.source`
  // falls back to "base" in that case (see the field's doc comment).
  //
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
  // "would this apply" answer could disagree with what actually
  // enforces. Only `session_start_preflight.setup` (and its `source`
  // attribution) below get a project-scoped SECOND load: routing a
  // derived layer through THIS one, unrelated load would let it
  // silently reach the policy engine this verb evaluates, for zero
  // benefit to the one key that needs it.
  let manifest: Manifest;
  let resolvedPaths: ResolvedPaths | undefined;
  if (opts.manifest) {
    manifest = opts.manifest;
  } else {
    const loaded = loadManifest(opts);
    manifest = loaded.manifest;
    resolvedPaths = loaded.resolved;
  }
  const policy = manifest.policies.find((p) => p.name === policyName);
  if (!policy) {
    const available = manifest.policies.map((p) => p.name).join(", ") || "(none)";
    throw new HarnessExitError(
      `no policy named "${policyName}" declared; available: ${available}`,
      EX_USAGE,
    );
  }

  // `session_start_preflight.setup` / `source` (task c88461c1, review
  // round 2 decision D-021b; scope narrowed to this one key, review
  // round 3 decision D-028; gated on the name-prefix check below,
  // review round 3 residual, decision D-006): an explicit
  // `opts.project` still wins outright; otherwise derive the project
  // name from `opts.cwd` (defaulting to `process.cwd()`) via the SAME
  // shared `deriveProjectName` helper `harness session-start preflight`
  // and `harness doctor` feed their own SECOND load from, so this
  // verb's `setup`/`source` reflect the layer the producer itself
  // would actually read for this cwd -- WITHOUT letting that derived
  // layer reach the policy evaluation above. An injected
  // `opts.manifest` carries no per-layer provenance to re-derive from
  // and always reports "base" (unchanged from before this task).
  //
  // ONLY COMPUTED FOR `preflight-before-*` POLICIES (moved behind this
  // check, review round 3 residual, decision D-006): the block below
  // is rendered into the projection ONLY for those policies (see
  // `ExplainPolicyProjection.session_start_preflight`'s doc comment),
  // so a caller explaining any OTHER policy no longer pays for a
  // second manifest load whose result it can never see.
  let sessionStartPreflightSetup = false;
  let sessionStartPreflightSource: SessionStartPreflightLayerSource = "base";
  if (policy.name.startsWith("preflight-before-")) {
    sessionStartPreflightSetup = manifest.session_start_preflight.setup;
    sessionStartPreflightSource = resolvedPaths
      ? resolveSessionStartPreflightSource(resolvedPaths)
      : "base";
    if (!opts.manifest) {
      try {
        const scoped = loadManifest({
          ...opts,
          project: opts.project ?? deriveProjectName(opts.cwd ?? process.cwd()) ?? undefined,
        });
        sessionStartPreflightSetup = scoped.manifest.session_start_preflight.setup;
        sessionStartPreflightSource = resolveSessionStartPreflightSource(scoped.resolved);
      } catch {
        // Review round 3 residual, decision D-006: degrade to
        // setup:false / source:"unresolvable" rather than keeping the
        // plain load's values, matching the producer's own
        // `setupEnabled` catch (`src/cli/session-start/index.ts`),
        // which degrades to `setup: false` on the identical failure
        // instead of falling back to a base/machine value it never
        // actually re-read on this path. "base" would misattribute
        // the result to a layer this function never consulted here.
        sessionStartPreflightSetup = false;
        sessionStartPreflightSource = "unresolvable";
      }
    }
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
    ...(policy.name.startsWith("preflight-before-") && {
      session_start_preflight: {
        setup: sessionStartPreflightSetup,
        source: sessionStartPreflightSource,
      },
    }),
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
