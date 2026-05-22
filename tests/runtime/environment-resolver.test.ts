import { describe, expect, it } from "vitest";
import {
  buildActionEnvelope,
  resolveEnvironment,
  type ActionEnvelope,
  type EnvelopeContext,
  type SignalInputs,
} from "../../src/runtime/index.js";
import type { ToolEvent } from "../../src/runtime/intercept.js";
import type { EnvironmentResolver } from "../../src/schema/index.js";

const NOW = new Date("2026-05-22T12:00:00.000Z");

/** An envelope whose resolved git branch is `branch`. */
function envelopeOnBranch(branch: string): ActionEnvelope {
  const ctx: EnvelopeContext = {
    cwd: "/work/repo",
    git: { repo: "repo", branch, sha: "" },
    user: "agent",
    host: "host",
    now: NOW,
  };
  const event: ToolEvent = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  return buildActionEnvelope(event, ctx);
}

const NO_SIGNALS: SignalInputs = { env: {}, kubeContext: "", kubeNamespace: "" };

const PROD: EnvironmentResolver = {
  name: "production-signals",
  environment: "production",
  signals: {
    branch_patterns: ["main", "release/*"],
    env_var_patterns: [{ var: "DATABASE_URL", patterns: ["prod"] }],
    kube_context_patterns: [".*prod.*"],
    kube_namespace_patterns: ["prod", "production"],
  },
};

describe("resolveEnvironment — signal kinds", () => {
  it("matches an exact branch glob", () => {
    const r = resolveEnvironment(envelopeOnBranch("main"), [PROD], NO_SIGNALS);
    expect(r.name).toBe("production");
    expect(r.signals).toEqual(["branch:main ~ main"]);
    expect(r.resolver).toBe("production-signals");
  });

  it("matches a `*` branch glob", () => {
    const r = resolveEnvironment(
      envelopeOnBranch("release/2026-05"),
      [PROD],
      NO_SIGNALS,
    );
    expect(r.name).toBe("production");
    expect(r.signals).toEqual(["branch:release/2026-05 ~ release/*"]);
  });

  it("matches an env-var substring", () => {
    const r = resolveEnvironment(envelopeOnBranch("feature/x"), [PROD], {
      ...NO_SIGNALS,
      env: { DATABASE_URL: "postgres://prod-db.internal/app" },
    });
    expect(r.name).toBe("production");
    expect(r.signals).toEqual(['env:DATABASE_URL contains "prod"']);
  });

  it("matches a kube-context regex", () => {
    const r = resolveEnvironment(envelopeOnBranch("feature/x"), [PROD], {
      ...NO_SIGNALS,
      kubeContext: "customer-prod-eu",
    });
    expect(r.name).toBe("production");
    expect(r.signals).toEqual(["kube-context:customer-prod-eu ~ /.*prod.*/"]);
  });

  it("matches a kube-namespace glob", () => {
    const r = resolveEnvironment(envelopeOnBranch("feature/x"), [PROD], {
      ...NO_SIGNALS,
      kubeNamespace: "prod",
    });
    expect(r.name).toBe("production");
    expect(r.signals).toEqual(["kube-namespace:prod ~ prod"]);
  });

  it("confidence is high when two or more signals back the result", () => {
    const r = resolveEnvironment(envelopeOnBranch("main"), [PROD], {
      ...NO_SIGNALS,
      env: { DATABASE_URL: "prod" },
    });
    expect(r.confidence).toBe("high");
    expect(r.signals).toHaveLength(2);
  });

  it("confidence is medium for a single signal", () => {
    const r = resolveEnvironment(envelopeOnBranch("main"), [PROD], NO_SIGNALS);
    expect(r.confidence).toBe("medium");
  });
});

describe("resolveEnvironment — unknown is not safe", () => {
  it("resolves to unknown when no resolver matches", () => {
    const r = resolveEnvironment(
      envelopeOnBranch("feature/x"),
      [PROD],
      NO_SIGNALS,
    );
    expect(r.name).toBe("unknown");
    expect(r.confidence).toBe("low");
    expect(r.signals).toEqual([]);
    expect(r.resolver).toBeNull();
  });

  it("resolves to unknown when there are no resolvers at all", () => {
    expect(resolveEnvironment(envelopeOnBranch("main"), [], NO_SIGNALS).name).toBe(
      "unknown",
    );
  });

  it("does not match a branch signal on a detached HEAD (empty branch)", () => {
    expect(resolveEnvironment(envelopeOnBranch(""), [PROD], NO_SIGNALS).name).toBe(
      "unknown",
    );
  });

  it("skips a kube_context_patterns regex that does not compile", () => {
    // `kube_context_patterns` are plain strings in the schema, so a
    // malformed regex can reach the resolver; it must be skipped, not
    // throw.
    const broken: EnvironmentResolver = {
      name: "broken",
      environment: "production",
      signals: { kube_context_patterns: ["([unclosed"] },
    };
    const r = resolveEnvironment(envelopeOnBranch("feature/x"), [broken], {
      ...NO_SIGNALS,
      kubeContext: "customer-prod",
    });
    expect(r.name).toBe("unknown");
  });
});

describe("resolveEnvironment — conflict resolution", () => {
  const STAGING: EnvironmentResolver = {
    name: "staging-signals",
    environment: "staging",
    signals: { branch_patterns: ["main"] },
  };

  it("most-dangerous environment wins when resolvers disagree", () => {
    // Both fire on branch `main`; production outranks staging.
    const r = resolveEnvironment(
      envelopeOnBranch("main"),
      [STAGING, PROD],
      NO_SIGNALS,
    );
    expect(r.name).toBe("production");
    expect(r.resolver).toBe("production-signals");
  });

  it("unions signals from every resolver asserting the winning environment", () => {
    const prodB: EnvironmentResolver = {
      name: "prod-extra",
      environment: "production",
      signals: { kube_namespace_patterns: ["production"] },
    };
    const r = resolveEnvironment(envelopeOnBranch("main"), [PROD, prodB], {
      ...NO_SIGNALS,
      kubeNamespace: "production",
    });
    expect(r.name).toBe("production");
    expect(r.signals).toEqual([
      "branch:main ~ main",
      "kube-namespace:production ~ production",
    ]);
  });
});
