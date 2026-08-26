// Task d03af8f6 — end-to-end `intercept()` coverage for
// gate-dev-unsafe-deletion / `action.deletion_target_unresolvable`.
//
// Mirrors the shape of the existing "Phase 7 #5 when: evaluation" /
// "Phase 7 #5 four-way decision" blocks in tests/runtime/intercept.test.ts
// (gate-prod-destructive), but for the new environment-independent
// deletion gate. Kept in its own file rather than appended to the (very
// large) shared suite.

import { describe, expect, it } from "vitest";
import { intercept, type LedgerClient, type RiskGateContext, type ToolEvent } from "../../src/runtime/index.js";
import type { EnvironmentResolver, Policy, RiskClassifier } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

const BUILTINS = {
  SESSION_ID: "sess-1",
  REPO: "harness",
  BRANCH: "task/x",
  TOOL_NAME: "Bash",
  CWD: "/tmp/proj",
};

function makeLedger(entries: Array<{ id: string; content: string; createdAt: string }> = []): LedgerClient {
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

const riskCtx = (branch: string): RiskGateContext => ({
  git: { repo: "proj", branch, sha: "" },
  cwd: "/tmp/proj",
  user: "tester",
  host: "testhost",
  env: {},
  kubeContext: "",
  kubeNamespace: "",
});

// gate-dev-unsafe-deletion — the shipped policy shape from
// docs/examples/full-manifest.yaml / src/cli/init/templates.ts.
const DELETION_GATE_POLICY: Policy = {
  name: "gate-dev-unsafe-deletion",
  description: "require approval for a deletion-verb command whose target cannot be statically proven safe",
  trigger: { event: "PreToolUse", match: "Bash" },
  when: { "action.deletion_target_unresolvable": true },
  // Own ledger tag (task d03af8f6, review round 2, HIGH 2 fix) — see
  // "cross-tier tag independence" below for why this must NOT be the
  // same tag gate-prod-destructive-approval consults.
  requires: { ledger_tag: "risk-approved:deletion:${SESSION_ID}" },
  hook: "h",
  enforcement: "require_approval",
} as Policy;

function bashEvent(command: string): ToolEvent {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    session_id: "sess-1",
    cwd: "/tmp/proj",
  };
}

describe("intercept — AC1: dev-context, target outside the allowlist -> require_approval envelope", () => {
  it("emits the require_approval envelope (blockJson.decision === block) with environment unknown", async () => {
    const ledger = makeLedger();
    const result = await intercept({
      manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
      event: bashEvent("rm -rf /home/user/project/some-dir"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("task/x"),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.policyName).toBe("gate-dev-unsafe-deletion");
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.decisions[0]?.environment?.name).toBe("unknown");
    // Phase 7 #6: require_approval is authoritative — it blocks.
    expect(result.blockJson?.decision).toBe("block");
  });

  it("resolves to allow once the risk-approved:deletion ledger tag is on record (one approval, not per-command)", async () => {
    const ledger = makeLedger([
      { id: "a1", content: "risk-approved:deletion:sess-1", createdAt: NOW.toISOString() },
    ]);
    const result = await intercept({
      manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
      event: bashEvent("rm -rf /home/user/project/some-dir"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("task/x"),
    });
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.blockJson).toBeNull();
  });
});

describe("intercept — cross-tier tag independence (task d03af8f6, review round 2, HIGH 2)", () => {
  const GATE_PROD_DESTRUCTIVE_APPROVAL: Policy = {
    name: "gate-prod-destructive-approval",
    description: "require operator approval for high-severity destructive shell actions against a production target",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: { "risk.severity_at_least": "high", "environment.name": "production" },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "h",
    enforcement: "require_approval",
  } as Policy;
  const DESTROY_CLASSIFIER: RiskClassifier = {
    name: "dangerous-shell",
    tool: "Bash",
    patterns: [
      { pattern: "rm\\s+-rf\\s+/", categories: ["destructive", "data_loss"], severity: "high" },
    ],
  };
  const PROD_RESOLVER: EnvironmentResolver = {
    name: "production-signals",
    environment: "production",
    signals: { branch_patterns: ["main"] },
  };

  it("a deletion-scope approval does NOT clear gate-prod-destructive-approval", async () => {
    // Approve ONLY the deletion arm's own tag.
    const ledger = makeLedger([
      { id: "a1", content: "risk-approved:deletion:sess-1", createdAt: NOW.toISOString() },
    ]);
    const result = await intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE_APPROVAL],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent("rm -rf /var/lib/data"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    // Still gated — the shared-tag bug would have cleared this.
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.blockJson?.decision).toBe("block");
  });

  it("a production approval does NOT clear the dev-context deletion arm", async () => {
    // Approve ONLY the production tag.
    const ledger = makeLedger([
      { id: "a1", content: "risk-approved:sess-1", createdAt: NOW.toISOString() },
    ]);
    const result = await intercept({
      manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
      event: bashEvent("rm -rf /home/user/project/some-dir"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("task/x"),
    });
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.blockJson?.decision).toBe("block");
  });
});

describe("intercept — AC2: dev-context, target inside a declared safe root -> allow, no new false positives", () => {
  it("does not gate rm -rf against an absolute path inside the default /tmp allowlist", async () => {
    const ledger = makeLedger();
    const result = await intercept({
      manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
      event: bashEvent("rm -rf /tmp/scratch/build-output"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("task/x"),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blockJson).toBeNull();
  });

  it.each(["ls -la", "git status", "git diff", "cat README.md", "head -20 CHANGELOG.md"])(
    "does not gate the pre-existing read-only command %j (no new false positives)",
    async (command) => {
      const ledger = makeLedger();
      const result = await intercept({
        manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
        event: bashEvent(command),
        ledger,
        builtins: BUILTINS,
        now: NOW,
        riskContext: riskCtx("task/x"),
      });
      expect(result.decisions).toHaveLength(0);
      expect(result.blockJson).toBeNull();
    },
  );
});

describe("intercept — AC3: unresolvable-target fixtures gate identically to AC1", () => {
  it.each([
    ["unset variable", "rm -rf $SCRATCH_DIR/foo"],
    ["relative path", "rm -rf scratch-files"],
    ["traversal escaping every root", "rm -rf /tmp/scratch/../../home/lan/x"],
  ])("gates on %s: %j", async (_label, command) => {
    const ledger = makeLedger();
    const result = await intercept({
      manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
      event: bashEvent(command),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("task/x"),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.policyName).toBe("gate-dev-unsafe-deletion");
    expect(result.blockJson?.decision).toBe("block");
  });
});

describe("intercept — review round 4, HIGH: xargs -I {} rm -rf {} gates end-to-end", () => {
  it("emits require_approval for the xargs -I {} separated-value spelling (round 3 left this ungated)", async () => {
    const ledger = makeLedger();
    const result = await intercept({
      manifest: makeManifest({ policies: [DELETION_GATE_POLICY] }),
      event: bashEvent("xargs -I {} rm -rf {}"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("task/x"),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.policyName).toBe("gate-dev-unsafe-deletion");
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.blockJson?.decision).toBe("block");
  });
});

describe("intercept — AC4: production-context regression, deny-first order unaffected", () => {
  const DESTROY_CLASSIFIER: RiskClassifier = {
    name: "dangerous-shell",
    tool: "Bash",
    patterns: [
      {
        pattern: "rm\\s+-rf\\s+/",
        categories: ["destructive", "data_loss"],
        severity: "critical",
      },
    ],
  };
  const PROD_RESOLVER: EnvironmentResolver = {
    name: "production-signals",
    environment: "production",
    signals: { branch_patterns: ["main"] },
  };
  const GATE_PROD_DESTRUCTIVE: Policy = {
    name: "gate-prod-destructive",
    description: "deny critical-severity destructive shell actions against a production target",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: { "risk.severity_at_least": "critical", "environment.name": "production" },
    requires: { ledger_tag: "risk-override:${SESSION_ID}" },
    hook: "h",
    enforcement: "block",
  } as Policy;
  const GATE_PROD_DESTRUCTIVE_APPROVAL: Policy = {
    name: "gate-prod-destructive-approval",
    description: "require operator approval for high-severity destructive shell actions against a production target",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: { "risk.severity_at_least": "high", "environment.name": "production" },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "h",
    enforcement: "require_approval",
  } as Policy;

  it("still DENIES in production; the new arm does not downgrade the deny to require_approval", async () => {
    const ledger = makeLedger();
    // Same order as the shipped template: deny-first, approval second,
    // the new environment-independent deletion gate last.
    const result = await intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE, GATE_PROD_DESTRUCTIVE_APPROVAL, DELETION_GATE_POLICY],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent("rm -rf /home/user/project/some-dir"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    // All three policies' when: clauses hold for this event (critical
    // severity, production environment, AND an unresolvable target), so
    // all three are in the matching/decisions set...
    expect(result.decisions).toHaveLength(3);
    const names = result.decisions.map((d) => d.policyName);
    expect(names).toEqual([
      "gate-prod-destructive",
      "gate-prod-destructive-approval",
      "gate-dev-unsafe-deletion",
    ]);
    // ...but the FIRST blocking decision in manifest order is the
    // hard deny, exactly as the pre-existing production-only gates
    // already guaranteed. The new arm never gets a chance to soften it.
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blockJson?.decision).toBe("block");
  });

  it("the existing gate-prod-destructive/-approval fixtures are unaffected when the new policy is absent", async () => {
    // Sanity control mirroring tests/runtime/intercept.test.ts's own
    // "Phase 7 #5 four-way decision" block, run here to confirm nothing
    // about this task changed that file's behavior.
    const ledger = makeLedger();
    const result = await intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent("rm -rf /var/lib/data"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
  });
});
