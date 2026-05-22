// Phase 7 #4 — Context Resolver.
//
// Classifies an Action Envelope's target environment by matching the
// manifest's `environments.resolvers[]` signals. The Risk Gate stage
// that reads the `environments:` schema vocabulary shipped in
// Phase 7 #1.
//
// STATUS: invoked by `harness resolve-env` (Phase 7 #4). NOT yet
// consumed by `harness policy intercept` — wiring the runtime through
// the resolver is Phase 7 #5. See docs/risk-gate.md and docs/ROADMAP.md.
//
// "Unknown is not safe": when no resolver matches, the environment is
// `unknown` — not a safe default. The Phase 7 #5 policy evaluator must
// treat `unknown` as risk-bearing. `MatchableEnvironmentSchema` already
// admits `unknown` so a `policy.when.environment.name` clause can gate
// on it.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md
// (design phase C).

import type {
  EnvironmentResolver,
  MatchableEnvironment,
} from "../schema/index.js";
import type { ActionEnvelope } from "./action-envelope.js";

export type EnvironmentConfidence = "high" | "medium" | "low";

export interface EnvironmentResolution {
  /** Resolved environment, or `unknown` when no resolver matched. */
  name: MatchableEnvironment;
  /**
   * `high` when two or more signals (unioned across every resolver
   * asserting the winning environment) back the result, `medium` for a
   * single signal, `low` for `unknown` (no signal matched at all).
   */
  confidence: EnvironmentConfidence;
  /** Matched signal descriptors that back the result, for explainability. */
  signals: string[];
  /** Name of the resolver whose environment won, or `null` when unresolved. */
  resolver: string | null;
}

/** Ambient inputs the resolver matches signals against. */
export interface SignalInputs {
  /** Environment variables, for `env_var_patterns`. */
  env: Record<string, string | undefined>;
  /** Current kube context name, for `kube_context_patterns`. "" when unknown. */
  kubeContext: string;
  /** Current kube namespace, for `kube_namespace_patterns`. "" when unknown. */
  kubeNamespace: string;
}

// Most-dangerous-wins precedence: when resolvers disagree, the earlier
// entry here is the resolved environment. `unknown` is the implicit
// fallback and is not a resolver-assertable value.
const ENV_PRECEDENCE: readonly MatchableEnvironment[] = [
  "production",
  "staging",
  "dev",
  "local",
];

/**
 * Convert a `*`-glob to an anchored RegExp. Only `*` is special (the
 * Phase 7 #1 signal patterns are simple, e.g. `main`, `release/*`); all
 * other regex metacharacters are escaped literally.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Match one resolver's signals against the envelope + ambient inputs.
 * Signals are OR-ed: a resolver fires when ANY signal matches. Returns
 * the matched signal descriptors (empty when the resolver did not fire).
 *
 * Per-signal-kind semantics: `branch_patterns` and
 * `kube_namespace_patterns` are globs, `kube_context_patterns` are
 * regexes, `env_var_patterns` are substrings of the variable's value.
 */
function matchResolver(
  resolver: EnvironmentResolver,
  envelope: ActionEnvelope,
  inputs: SignalInputs,
): string[] {
  const matched: string[] = [];
  const sig = resolver.signals;

  const branch = envelope.session.branch;
  if (sig.branch_patterns !== undefined && branch !== "") {
    for (const p of sig.branch_patterns) {
      if (globToRegExp(p).test(branch)) {
        matched.push(`branch:${branch} ~ ${p}`);
      }
    }
  }

  if (sig.env_var_patterns !== undefined) {
    for (const evp of sig.env_var_patterns) {
      const value = inputs.env[evp.var];
      if (typeof value !== "string") continue;
      for (const p of evp.patterns) {
        if (value.includes(p)) {
          matched.push(`env:${evp.var} contains "${p}"`);
        }
      }
    }
  }

  if (sig.kube_context_patterns !== undefined && inputs.kubeContext !== "") {
    for (const p of sig.kube_context_patterns) {
      let re: RegExp;
      try {
        re = new RegExp(p);
      } catch {
        continue;
      }
      if (re.test(inputs.kubeContext)) {
        matched.push(`kube-context:${inputs.kubeContext} ~ /${p}/`);
      }
    }
  }

  if (
    sig.kube_namespace_patterns !== undefined &&
    inputs.kubeNamespace !== ""
  ) {
    for (const p of sig.kube_namespace_patterns) {
      if (globToRegExp(p).test(inputs.kubeNamespace)) {
        matched.push(`kube-namespace:${inputs.kubeNamespace} ~ ${p}`);
      }
    }
  }

  return matched;
}

/**
 * Resolve the target environment of an Action Envelope.
 *
 * Pure: envelope + resolvers + ambient inputs in, resolution out, no
 * I/O. When resolvers disagree, the most-dangerous environment wins
 * (`ENV_PRECEDENCE`). Signals from every fired resolver that asserts the
 * winning environment are unioned for explainability. When nothing
 * matches, the result is `unknown` — deliberately not a safe default.
 */
export function resolveEnvironment(
  envelope: ActionEnvelope,
  resolvers: readonly EnvironmentResolver[],
  inputs: SignalInputs,
): EnvironmentResolution {
  const fired: Array<{ resolver: EnvironmentResolver; signals: string[] }> = [];
  for (const resolver of resolvers) {
    const signals = matchResolver(resolver, envelope, inputs);
    if (signals.length > 0) fired.push({ resolver, signals });
  }

  if (fired.length === 0) {
    return { name: "unknown", confidence: "low", signals: [], resolver: null };
  }

  let best = fired[0]!;
  for (const f of fired) {
    if (
      ENV_PRECEDENCE.indexOf(f.resolver.environment) <
      ENV_PRECEDENCE.indexOf(best.resolver.environment)
    ) {
      best = f;
    }
  }

  // Union the signals of every fired resolver that asserts the winning
  // environment, so the explanation is complete when several resolvers
  // agree. `resolver` names the highest-precedence (first-found) one.
  const winningEnv = best.resolver.environment;
  const signals = [
    ...new Set(
      fired
        .filter((f) => f.resolver.environment === winningEnv)
        .flatMap((f) => f.signals),
    ),
  ].sort();

  return {
    name: winningEnv,
    confidence: signals.length >= 2 ? "high" : "medium",
    signals,
    resolver: best.resolver.name,
  };
}
