// Phase 7 #5 — `policy.when:` evaluator unit tests.
//
// Covers each of the four clause kinds (match + no-match), the AND
// semantics across clauses, and the load-bearing "unknown is not safe"
// rule: an unclassified risk profile satisfies every risk-derived clause.

import { describe, expect, it } from "vitest";
import type { DeletionTargetVerdict } from "../../src/runtime/deletion-target-resolve.js";
import type { EnvironmentResolution } from "../../src/runtime/environment-resolver.js";
import type { RiskProfile } from "../../src/runtime/risk-classifier.js";
import { evaluateWhen } from "../../src/runtime/when-eval.js";
import { buildActionEnvelope, classifyRisk } from "../../src/runtime/index.js";
import type { EnvelopeContext } from "../../src/runtime/index.js";
import type { ToolEvent } from "../../src/runtime/intercept.js";
import type { PolicyWhen } from "../../src/schema/index.js";

const classified = (over: Partial<RiskProfile> = {}): RiskProfile => ({
  classified: true,
  severity: "high",
  categories: ["destructive"],
  reversible: false,
  confidence: "high",
  reasons: ["test pattern matched"],
  ...over,
});

const UNCLASSIFIED: RiskProfile = {
  classified: false,
  severity: null,
  categories: [],
  reversible: null,
  confidence: "low",
  reasons: ["no classifier pattern matched the action"],
};

const env = (name: EnvironmentResolution["name"]): EnvironmentResolution => ({
  name,
  confidence: name === "unknown" ? "low" : "medium",
  signals: name === "unknown" ? [] : [`signal for ${name}`],
  resolver: name === "unknown" ? null : `${name}-resolver`,
});

const when = (w: PolicyWhen): PolicyWhen => w;

describe("evaluateWhen — risk.severity_at_least", () => {
  it("matches when classified severity is at or above the threshold", () => {
    for (const sev of ["high", "critical"] as const) {
      const r = evaluateWhen(when({ "risk.severity_at_least": "high" }), {
        risk: classified({ severity: sev }),
        environment: env("production"),
      });
      expect(r.matched).toBe(true);
    }
  });

  it("does not match when classified severity is below the threshold", () => {
    const r = evaluateWhen(when({ "risk.severity_at_least": "high" }), {
      risk: classified({ severity: "medium" }),
      environment: env("production"),
    });
    expect(r.matched).toBe(false);
    expect(r.clauses[0]?.actual).toBe("medium");
  });

  it("matches an UNCLASSIFIED profile against any threshold (unknown is not safe)", () => {
    const r = evaluateWhen(when({ "risk.severity_at_least": "critical" }), {
      risk: UNCLASSIFIED,
      environment: env("production"),
    });
    expect(r.matched).toBe(true);
    expect(r.unclassifiedFallback).toBe(true);
    expect(r.clauses[0]?.actual).toContain("unclassified");
  });
});

describe("evaluateWhen — risk.category_in", () => {
  it("matches when the profile carries any listed category", () => {
    const r = evaluateWhen(
      when({ "risk.category_in": ["destructive", "data_loss"] }),
      { risk: classified({ categories: ["destructive"] }), environment: env("dev") },
    );
    expect(r.matched).toBe(true);
  });

  it("does not match when no category overlaps", () => {
    const r = evaluateWhen(when({ "risk.category_in": ["destructive"] }), {
      risk: classified({ categories: ["mass_update"] }),
      environment: env("dev"),
    });
    expect(r.matched).toBe(false);
  });

  it("matches an UNCLASSIFIED profile (empty categories treated as risk-bearing)", () => {
    const r = evaluateWhen(when({ "risk.category_in": ["destructive"] }), {
      risk: UNCLASSIFIED,
      environment: env("dev"),
    });
    expect(r.matched).toBe(true);
    expect(r.unclassifiedFallback).toBe(true);
  });
});

describe("evaluateWhen — environment.name", () => {
  it("matches on exact environment equality", () => {
    const r = evaluateWhen(when({ "environment.name": "production" }), {
      risk: classified(),
      environment: env("production"),
    });
    expect(r.matched).toBe(true);
  });

  it("does not match a different environment", () => {
    const r = evaluateWhen(when({ "environment.name": "production" }), {
      risk: classified(),
      environment: env("dev"),
    });
    expect(r.matched).toBe(false);
  });

  it("matches `unknown` — the no-resolver-fired case is addressable", () => {
    const r = evaluateWhen(when({ "environment.name": "unknown" }), {
      risk: classified(),
      environment: env("unknown"),
    });
    expect(r.matched).toBe(true);
  });

  it("environment.name is NOT subject to the unclassified-risk fallback", () => {
    // An unclassified RISK profile must not flip an environment clause:
    // the resolver always returns a concrete environment.
    const r = evaluateWhen(when({ "environment.name": "production" }), {
      risk: UNCLASSIFIED,
      environment: env("dev"),
    });
    expect(r.matched).toBe(false);
    expect(r.unclassifiedFallback).toBe(false);
  });
});

describe("evaluateWhen — action.reversible", () => {
  it("matches when classified reversibility equals the clause", () => {
    const r = evaluateWhen(when({ "action.reversible": false }), {
      risk: classified({ reversible: false }),
      environment: env("production"),
    });
    expect(r.matched).toBe(true);
  });

  it("does not match when classified reversibility differs", () => {
    const r = evaluateWhen(when({ "action.reversible": false }), {
      risk: classified({ reversible: true }),
      environment: env("production"),
    });
    expect(r.matched).toBe(false);
  });

  it("matches an UNCLASSIFIED profile on either branch (reversibility unknown)", () => {
    for (const branch of [true, false]) {
      const r = evaluateWhen(when({ "action.reversible": branch }), {
        risk: UNCLASSIFIED,
        environment: env("production"),
      });
      expect(r.matched).toBe(true);
      expect(r.unclassifiedFallback).toBe(true);
    }
  });
});

describe("evaluateWhen — AND semantics across clauses", () => {
  it("requires every declared clause to hold", () => {
    const block = when({
      "risk.severity_at_least": "high",
      "environment.name": "production",
    });
    const allHold = evaluateWhen(block, {
      risk: classified({ severity: "critical" }),
      environment: env("production"),
    });
    expect(allHold.matched).toBe(true);
    expect(allHold.clauses).toHaveLength(2);

    const oneFails = evaluateWhen(block, {
      risk: classified({ severity: "critical" }),
      environment: env("staging"),
    });
    expect(oneFails.matched).toBe(false);
  });

  it("reports one clause result per declared clause, in key order", () => {
    const r = evaluateWhen(
      when({
        "risk.severity_at_least": "high",
        "risk.category_in": ["destructive"],
        "environment.name": "production",
        "action.reversible": false,
      }),
      { risk: classified(), environment: env("production") },
    );
    expect(r.clauses.map((c) => c.clause)).toEqual([
      "risk.severity_at_least",
      "risk.category_in",
      "environment.name",
      "action.reversible",
    ]);
  });
});

describe("evaluateWhen — Friction-log #35 regression (benign harness floor defeats fail-close)", () => {
  // The bug: `harness preflight` was unclassified, so the fail-close
  // satisfied `risk.severity_at_least: critical` and a prod-scoped
  // gate-prod-destructive policy HARD-DENIED it. With the built-in floor
  // it classifies `low`, so the severity clause no longer matches even
  // when the environment genuinely resolves to production.
  const ENVELOPE_CTX: EnvelopeContext = {
    cwd: "/work/repo",
    git: { repo: "repo", branch: "main", sha: "" },
    user: "agent",
    host: "host",
    now: new Date("2026-05-29T12:00:00.000Z"),
  };
  const bashEnvelope = (command: string) =>
    buildActionEnvelope(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as ToolEvent,
      ENVELOPE_CTX,
    );
  const GATE_PROD_DESTRUCTIVE: PolicyWhen = {
    "risk.severity_at_least": "critical",
    "environment.name": "production",
  };

  it("does NOT match gate-prod-destructive for `harness preflight` in production", () => {
    const risk = classifyRisk(bashEnvelope("harness preflight"), []);
    const result = evaluateWhen(GATE_PROD_DESTRUCTIVE, { risk, environment: env("production") });
    expect(result.matched).toBe(false);
    // Crucial: the non-match is a real low-severity classification, not a
    // fail-close that happened to be ANDed out by the environment clause.
    expect(result.unclassifiedFallback).toBe(false);
    const sevClause = result.clauses.find((c) => c.clause === "risk.severity_at_least");
    expect(sevClause).toMatchObject({ actual: "low", matched: false });
  });

  it("STILL matches gate-prod-destructive for a genuinely destructive command in production", () => {
    // Negative control: the floor must not weaken the gate for real danger.
    const danger: RiskProfile = classified({ severity: "critical" });
    const result = evaluateWhen(GATE_PROD_DESTRUCTIVE, {
      risk: danger,
      environment: env("production"),
    });
    expect(result.matched).toBe(true);
  });
});

describe("evaluateWhen — Friction-log #38/#40/#43/#50 regression (read-only floor defeats the prod-branch fail-close)", () => {
  // The bug: on a `main` / `release/*` branch the env resolves to
  // production, and an unclassified read-only command (`git diff`,
  // `grep version package.json`) fail-closed into the prod-scoped
  // gate-prod-destructive policy, denying harmless reads during a release
  // cut. The universal workaround was `harness pause`, which silences
  // every gate. With the read-only floor these classify `low`, so the
  // severity clause no longer matches even in production.
  const ENVELOPE_CTX: EnvelopeContext = {
    cwd: "/work/repo",
    git: { repo: "repo", branch: "release/v0.34.0", sha: "" },
    user: "agent",
    host: "host",
    now: new Date("2026-06-10T12:00:00.000Z"),
  };
  const bashEnvelope = (command: string) =>
    buildActionEnvelope(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as ToolEvent,
      ENVELOPE_CTX,
    );
  const GATE_PROD_DESTRUCTIVE: PolicyWhen = {
    "risk.severity_at_least": "critical",
    "environment.name": "production",
  };

  it.each(["git diff", "grep version package.json", "git status -uno"])(
    "does NOT deny the read-only command %j in production",
    (command) => {
      const risk = classifyRisk(bashEnvelope(command), []);
      const result = evaluateWhen(GATE_PROD_DESTRUCTIVE, {
        risk,
        environment: env("production"),
      });
      expect(result.matched).toBe(false);
      // A real low-severity classification, not a fail-close that the
      // environment clause merely ANDed out.
      expect(result.unclassifiedFallback).toBe(false);
      const sevClause = result.clauses.find((c) => c.clause === "risk.severity_at_least");
      expect(sevClause).toMatchObject({ actual: "low", matched: false });
    },
  );

  it("STILL denies a genuinely destructive command in production (floor does not weaken the gate)", () => {
    const result = evaluateWhen(GATE_PROD_DESTRUCTIVE, {
      risk: classified({ severity: "critical" }),
      environment: env("production"),
    });
    expect(result.matched).toBe(true);
  });
});

describe("evaluateWhen — action.deletion_target_unresolvable (task d03af8f6)", () => {
  const UNRESOLVABLE: DeletionTargetVerdict = {
    verb: "rm",
    targets: ["/home/x"],
    unresolvedTargets: ["/home/x"],
    unresolvable: true,
    reason: "rm: target(s) not statically resolvable inside a declared risk.safe_deletion_roots entry: /home/x",
  };
  const RESOLVED: DeletionTargetVerdict = {
    verb: "rm",
    targets: ["/tmp/x"],
    unresolvedTargets: [],
    unresolvable: false,
    reason: "rm: every target resolves inside a declared risk.safe_deletion_roots entry",
  };

  it("matches true against an unresolvable deletion target, in an UNKNOWN environment, with no environment.name clause", () => {
    const result = evaluateWhen(
      { "action.deletion_target_unresolvable": true },
      { risk: UNCLASSIFIED, environment: env("unknown"), deletionTarget: UNRESOLVABLE },
    );
    expect(result.matched).toBe(true);
    // Load-bearing: this clause must NOT be counted as a fail-closed
    // unclassified match — it reads a wholly separate signal.
    expect(result.unclassifiedFallback).toBe(false);
  });

  it("does not match when the target resolves inside the safe-deletion allowlist (allow)", () => {
    const result = evaluateWhen(
      { "action.deletion_target_unresolvable": true },
      { risk: UNCLASSIFIED, environment: env("unknown"), deletionTarget: RESOLVED },
    );
    expect(result.matched).toBe(false);
  });

  it("does NOT fall back to matched=true for an unrelated unclassified command (deletionTarget null)", () => {
    // The load-bearing guarantee this clause exists for: an unscoped
    // policy on this clause must not become a blanket gate on every
    // unclassified Bash call the way the risk.* clauses would.
    const result = evaluateWhen(
      { "action.deletion_target_unresolvable": true },
      { risk: UNCLASSIFIED, environment: env("unknown"), deletionTarget: null },
    );
    expect(result.matched).toBe(false);
    expect(result.unclassifiedFallback).toBe(false);
  });

  it("treats an omitted deletionTarget the same as null (backward-compatible context)", () => {
    const result = evaluateWhen(
      { "action.deletion_target_unresolvable": true },
      { risk: UNCLASSIFIED, environment: env("unknown") },
    );
    expect(result.matched).toBe(false);
  });

  it("supports gating on `false` (target resolved) as an explicit allow-only clause", () => {
    const result = evaluateWhen(
      { "action.deletion_target_unresolvable": false },
      { risk: UNCLASSIFIED, environment: env("unknown"), deletionTarget: RESOLVED },
    );
    expect(result.matched).toBe(true);
  });

  it("ANDs with other clauses normally (composes with environment.name if an operator chooses to add one)", () => {
    const result = evaluateWhen(
      {
        "action.deletion_target_unresolvable": true,
        "environment.name": "production",
      },
      { risk: UNCLASSIFIED, environment: env("dev"), deletionTarget: UNRESOLVABLE },
    );
    expect(result.matched).toBe(false);
    const envClause = result.clauses.find((c) => c.clause === "environment.name");
    expect(envClause).toMatchObject({ matched: false });
  });
});
