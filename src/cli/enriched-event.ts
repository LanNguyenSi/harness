// Shared "enrich a loaded tool event like the hook does" front end for the
// Risk Gate debug verbs that read an event file and predict a verdict:
// `harness explain-policy`, `harness resolve-env`, `harness test-risk` and
// `harness explain-action` (task 8b891e83).
//
// `harness policy intercept` resolves its envelope and environment through
// `resolveBashPrefixEnrichment` (inline `VAR=value`, leading `cd`, leading
// `git switch|checkout`). Every verb that predicts the gate must read the
// same enriched inputs, or an operator's prediction disagrees with the
// gate (`DATABASE_URL=...prod... psql ...` resolved `unknown` in the debug
// verbs and `production` in the hook). This module is the one place the
// verbs call that helper; it reads no ledger or evidence and imports
// nothing from `policies/`.

import {
  buildActionEnvelope,
  resolveKubeContext,
  type ActionEnvelope,
} from "../runtime/index.js";
import type { Manifest } from "../schema/index.js";
import type { LoadedEvent } from "./event-input.js";
import {
  resolveBashPrefixEnrichment,
  type BashPrefixEnrichment,
} from "./policy/risk-envelope-enrichment.js";

/** Injectable env and kube seams (tests); ambient values otherwise. */
export interface EnrichmentSeams {
  /** Env vars the inline assignments merge over; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Kube context; when either kube seam is set `~/.kube/config` is not read. */
  kubeContext?: string;
  /** Kube namespace; see `kubeContext`. */
  kubeNamespace?: string;
}

export interface EnrichedEvent {
  /** The envelope after the `cd` merge and the branch-switch upgrade. */
  envelope: ActionEnvelope;
  enrichment: BashPrefixEnrichment;
  kube: { context: string; namespace: string };
}

/**
 * Kube seams resolve together: if either is injected, skip the
 * `~/.kube/config` read entirely (same contract `resolve-env` always had).
 */
export function resolveKubeSeams(seams: EnrichmentSeams): { context: string; namespace: string } {
  return seams.kubeContext !== undefined || seams.kubeNamespace !== undefined
    ? { context: seams.kubeContext ?? "", namespace: seams.kubeNamespace ?? "" }
    : resolveKubeContext();
}

/**
 * Run the hook's Bash-prefix enrichment over a loaded event and rebuild
 * the envelope when the enrichment moved the git context.
 */
export function enrichLoadedEvent(
  loaded: LoadedEvent,
  manifest: Manifest,
  seams: EnrichmentSeams,
): EnrichedEvent {
  const { event, envelope: baseEnvelope } = loaded;
  const kube = resolveKubeSeams(seams);
  const enrichment = resolveBashPrefixEnrichment({
    event,
    manifest,
    cwd: baseEnvelope.runtime.cwd,
    cwdGitContext: {
      repo: baseEnvelope.session.repo,
      branch: baseEnvelope.session.branch,
      sha: "",
    },
    env: seams.env ?? process.env,
    kubeContext: kube.context,
    kubeNamespace: kube.namespace,
    user: baseEnvelope.runtime.user,
    host: baseEnvelope.runtime.host,
    now: new Date(baseEnvelope.timestamp),
  });
  const envelope =
    enrichment.git.repo === baseEnvelope.session.repo &&
    enrichment.git.branch === baseEnvelope.session.branch
      ? baseEnvelope
      : buildActionEnvelope(event, {
          cwd: baseEnvelope.runtime.cwd,
          git: enrichment.git,
          user: baseEnvelope.runtime.user,
          host: baseEnvelope.runtime.host,
          now: new Date(baseEnvelope.timestamp),
        });
  return { envelope, enrichment, kube };
}
