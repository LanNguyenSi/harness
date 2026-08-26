// End-to-end integration test for the kubectl explicit-target resolver
// fix (task a7eb1a71).
//
// Before this fix, the Kube half of the Risk Gate's environment
// resolver only ever saw the AMBIENT `~/.kube/config` current-context —
// an explicit `--context`/`--namespace`/`-n` flag named directly in the
// Bash command was invisible, so the whole Kube signal only fired when
// the ambient kubeconfig happened to already point at production.
// Measured 2026-08-06 (task spec): both
// `kubectl --context=prod-eu-1 delete namespace payments` (leading
// flag, ALSO defeated the rigid `kubectl\s+delete\s+...` classifier
// pattern — unclassified) and `kubectl delete namespace payments
// --context prod-eu-1` (trailing flag, classified high but environment
// unknown) resolved ALLOW.
//
// Every test here passes `kubeContext: "", kubeNamespace: ""` as the
// ambient override, so a real `~/.kube/config` on the machine running
// this test can never influence the result — the ONLY source of any
// kube signal in these tests is the command string itself.

import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient, ToolEvent } from "../../src/runtime/intercept.js";
import { buildActionEnvelope, classifyRisk } from "../../src/runtime/index.js";
import type { ActionEnvelope, EnvelopeContext } from "../../src/runtime/index.js";
import type { EnvironmentResolver, Manifest, Policy, RiskClassifier } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStdout(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

// The shipped `docs/examples/full-manifest.yaml` classifier pattern
// (post-fix, task a7eb1a71): token-based, flag-tolerant between
// `kubectl` and `delete`, still requires the literal `delete` verb so
// `kubectl get`/`describe` never classify.
const KUBECTL_CLASSIFIER: RiskClassifier = {
  name: "dangerous-shell",
  tool: "Bash",
  patterns: [
    {
      pattern:
        "kubectl(?:\\s+-{1,2}[\\w-]+(?:=\\S+|\\s+(?!delete\\b)\\S+)?)*\\s+delete\\s+(namespace|deployment|statefulset|pvc)",
      categories: ["destructive", "infrastructure_change"],
      severity: "high",
    },
  ],
};

// The shipped `production-signals` resolver's kube signals.
const PROD_RESOLVER: EnvironmentResolver = {
  name: "production-signals",
  environment: "production",
  signals: {
    kube_context_patterns: [".*prod.*"],
    kube_namespace_patterns: ["prod", "production"],
  },
};

// Mirrors the shipped `gate-prod-destructive-approval` policy: high
// severity + production environment requires operator approval.
const GATE_PROD_APPROVAL: Policy = {
  name: "gate-prod-destructive-approval",
  description: "require approval for high-severity destructive actions against production",
  trigger: { event: "PreToolUse", match: "Bash" },
  when: {
    "risk.severity_at_least": "high",
    "environment.name": "production",
  },
  requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
  hook: "risk-gate",
  enforcement: "require_approval",
} as Policy;

const manifest: Manifest = makeManifest({
  policies: [GATE_PROD_APPROVAL],
  classifiers: [KUBECTL_CLASSIFIER],
  resolvers: [PROD_RESOLVER],
});

const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

let seq = 0;
async function intercept(command: string) {
  seq += 1;
  const { stream, output } = captureStdout();
  const result = await runInterceptCli({
    stdin: streamFrom(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        session_id: `sess-kube-${seq}`,
        cwd: process.cwd(),
      }),
    ),
    stdout: stream,
    manifest,
    ledger: emptyLedger,
    env: {},
    // Ambient kube state is deliberately empty in every test below —
    // any signal that fires must come from the command's OWN explicit
    // flag, not from a machine-local kubeconfig.
    kubeContext: "",
    kubeNamespace: "",
  });
  return { result, output };
}

describe("runInterceptCli — kubectl explicit --context/--namespace resolver signal (task a7eb1a71)", () => {
  it("AC1: trailing --context prod-like from a non-prod cwd resolves production and requires approval", async () => {
    const { result, output } = await intercept(
      "kubectl delete namespace payments --context prod-eu-1",
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.decisions[0]?.policyName).toBe("gate-prod-destructive-approval");
    // Phase 7 #6: require_approval is authoritative — the stdout deny
    // JSON's top-level `decision` field is always literally "block"
    // (Claude Code's hook contract has no third state), so the outcome
    // above — not this field — is what distinguishes require_approval
    // from a hard `deny`.
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("gate-prod-destructive-approval");
  });

  it("AC2: leading --context= is classified high AND resolves production (both defects fixed together)", async () => {
    const { result, output } = await intercept(
      "kubectl --context=prod-eu-1 delete namespace payments",
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.decisions[0]?.policyName).toBe("gate-prod-destructive-approval");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("gate-prod-destructive-approval");
  });

  it("AC3: a staging --context is not production and allows", async () => {
    const { result, output } = await intercept(
      "kubectl --context=staging-1 delete namespace payments",
    );
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("AC4: a non-kubectl command carrying --context sets no kube signal (negative control)", async () => {
    // `echo` is not `kubectl`: the narrow command-head anchor
    // (`parseKubectlTarget`'s scope point 1) must not read this
    // --context flag at all. This is also a meaningful end-to-end
    // regression probe: if the parsing WERE too broad and picked this
    // up, the environment would resolve `production` and the
    // pre-existing "unknown is not safe" rule (this command is
    // unclassified — no pattern matches `echo`) would make
    // `risk.severity_at_least` match anyway, and the action would
    // block — exactly the false-positive class the task's own risk
    // note warns against.
    const { result, output } = await intercept("echo --context=prod-eu-1");
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("AC5 (intercept-level, no explicit context): `kubectl get pods` stays allow", async () => {
    // Regression check with the ambient kube state empty and no
    // explicit --context in the command at all: nothing resolves
    // production, so this is unaffected by the classifier fix either
    // way.
    const { result, output } = await intercept("kubectl get pods");
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });
});

// AC5's classifier half, isolated from the policy engine (task
// a7eb1a71): `kubectl get pods --context prod-eu-1` must stay
// unclassified under the new flag-tolerant pattern (no `delete` literal
// to anchor on), exactly like the old rigid pattern already left `get`
// alone. Tested at the `classifyRisk` layer directly — not through
// `runInterceptCli` — because an END-TO-END check of this exact command
// collides with UNRELATED, pre-existing, and out-of-scope behavior: once
// the resolver correctly resolves `environment: production` from the
// explicit --context (this task's own fix), the "unknown is not safe"
// rule in `when-eval.ts` makes an UNCLASSIFIED action satisfy
// `risk.severity_at_least` regardless of its actual severity, so the
// shipped `gate-prod-destructive-approval` policy (severity_at_least +
// environment.name) requires approval for ANY unclassified Bash command
// against a resolved-production environment — not something this task's
// scope touches (expanding kubectl subcommand classification, e.g.
// giving `get`/`describe` a read-only floor, is explicitly out of scope:
// "Klassifikation weiterer kubectl-Subcommands ueber die vier
// vorhandenen hinaus"). Measured directly in this worktree: replacing
// this test's manifest with the AC1/AC2 one and running `kubectl get
// pods --context prod-eu-1` end to end DOES block via that unrelated
// mechanism — reported as an open question, not fixed here.
describe("classifyRisk — AC5: kubectl get stays unclassified under the flag-tolerant pattern", () => {
  const CTX: EnvelopeContext = {
    cwd: "/work/repo",
    git: { repo: "repo", branch: "feature/work", sha: "" },
    user: "agent",
    host: "host",
    now: new Date("2026-08-26T12:00:00.000Z"),
  };

  function bashEnvelope(command: string): ActionEnvelope {
    const event: ToolEvent = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    };
    return buildActionEnvelope(event, CTX);
  }

  it("`kubectl get pods --context prod-eu-1` is unclassified", () => {
    const p = classifyRisk(bashEnvelope("kubectl get pods --context prod-eu-1"), [
      KUBECTL_CLASSIFIER,
    ]);
    expect(p.classified).toBe(false);
    expect(p.severity).toBeNull();
  });

  it("`kubectl describe namespace payments --context prod-eu-1` is unclassified", () => {
    const p = classifyRisk(
      bashEnvelope("kubectl describe namespace payments --context prod-eu-1"),
      [KUBECTL_CLASSIFIER],
    );
    expect(p.classified).toBe(false);
    expect(p.severity).toBeNull();
  });

  it("regression: `kubectl delete namespace payments` (no flags) still classifies high", () => {
    const p = classifyRisk(bashEnvelope("kubectl delete namespace payments"), [
      KUBECTL_CLASSIFIER,
    ]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("high");
  });
});
