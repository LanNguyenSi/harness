// End-to-end integration test for the kubectl explicit-target resolver
// fix (task a7eb1a71).
//
// Before this fix, the Kube half of the Risk Gate's environment
// resolver only ever saw the AMBIENT `~/.kube/config` current-context;
// an explicit `--context`/`--namespace`/`-n` flag named directly in the
// Bash command was invisible, so the whole Kube signal only fired when
// the ambient kubeconfig happened to already point at production.
// Measured 2026-08-06 (task spec): both
// `kubectl --context=prod-eu-1 delete namespace payments` (leading
// flag, ALSO defeated the rigid `kubectl\s+delete\s+...` classifier
// pattern, unclassified) and `kubectl delete namespace payments
// --context prod-eu-1` (trailing flag, classified high but environment
// unknown) resolved ALLOW.
//
// Fix round 2 (review): the fix round 1 shape merged the explicit flag
// as a straight per-field replacement, which could LOWER an
// already-resolved ambient production classification (see the
// "downgrade" describe block below). The merge is now upgrade-only,
// mirroring the existing branch-switch merge; see
// `applyKubeTargetUpgrade`'s doc comment in
// `src/cli/policy/intercept.ts`.
//
// Every AC1-AC5 test below passes `kubeContext: "", kubeNamespace: ""`
// as the ambient override, so a real `~/.kube/config` on the machine
// running this test can never influence the result; the "downgrade"
// and "cd/env prefix coverage" blocks pass a non-empty ambient
// explicitly, on purpose, to exercise the upgrade-only merge and the
// prefix-stripped head test.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient, ToolEvent } from "../../src/runtime/intercept.js";
import { buildActionEnvelope, classifyRisk } from "../../src/runtime/index.js";
import type { ActionEnvelope, EnvelopeContext } from "../../src/runtime/index.js";
import {
  parseManifest,
  type EnvironmentResolver,
  type Manifest,
  type Policy,
  type RiskClassifier,
} from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

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

// Token-based, flag-tolerant, linear-time (review HIGH finding 1: the
// fix round 1 pattern below was quadratic and measured at seconds on a
// long flag run):
//   kubectl(?:\s+-{1,2}[\w-]+(?:=\S+|\s+(?!delete\b)\S+)?)*\s+delete\s+...
// This is the shipped `docs/examples/full-manifest.yaml` pattern; the
// "stays in lockstep" test below pins that this local copy never
// drifts from the real shipped one.
const KUBECTL_PATTERN =
  "kubectl(?:\\s+-\\S+(?:\\s+(?!delete\\b)(?!-)\\S+)?)*\\s+delete\\s+(namespace|deployment|statefulset|pvc)";
const TERRAFORM_PATTERN = "terraform(?:\\s+-\\S+(?:\\s+(?!destroy\\b)(?!-)\\S+)?)*\\s+destroy";

const KUBECTL_CLASSIFIER: RiskClassifier = {
  name: "dangerous-shell",
  tool: "Bash",
  patterns: [
    {
      pattern: KUBECTL_PATTERN,
      categories: ["destructive", "infrastructure_change"],
      severity: "high",
    },
    {
      pattern: TERRAFORM_PATTERN,
      categories: ["destructive", "infrastructure_change"],
      severity: "critical",
    },
  ],
};

describe("shipped pattern parity", () => {
  it("KUBECTL_PATTERN / TERRAFORM_PATTERN above match docs/examples/full-manifest.yaml verbatim", () => {
    const yamlPath = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");
    const parsed: Manifest = parseManifest(parseYaml(fs.readFileSync(yamlPath, "utf8")));
    const patterns = parsed.risk.classifiers[0]!.patterns.map((p) => p.pattern);
    expect(patterns).toContain(KUBECTL_PATTERN);
    expect(patterns).toContain(TERRAFORM_PATTERN);
  });
});

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
async function intercept(
  command: string,
  ambient: { kubeContext?: string; kubeNamespace?: string } = {},
) {
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
    kubeContext: ambient.kubeContext ?? "",
    kubeNamespace: ambient.kubeNamespace ?? "",
  });
  return { result, output };
}

describe("runInterceptCli - kubectl explicit --context/--namespace resolver signal (task a7eb1a71)", () => {
  it("AC1: trailing --context prod-like from a non-prod cwd resolves production and requires approval", async () => {
    const { result, output } = await intercept(
      "kubectl delete namespace payments --context prod-eu-1",
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    expect(result.decisions[0]?.policyName).toBe("gate-prod-destructive-approval");
    // Phase 7 #6: require_approval is authoritative; the stdout deny
    // JSON's top-level `decision` field is always literally "block"
    // (Claude Code's hook contract has no third state), so the outcome
    // above, not this field, is what distinguishes require_approval
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
    // unclassified, no pattern matches `echo`) would make
    // `risk.severity_at_least` match anyway, and the action would
    // block, exactly the false-positive class the task's own risk note
    // warns against.
    const { result, output } = await intercept("echo --context=prod-eu-1");
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("AC5 (intercept-level, no explicit context): `kubectl get pods` stays allow", async () => {
    // Regression check with the ambient kube state empty and no
    // explicit --context in the command at all: nothing resolves
    // production, so this is unaffected by the classifier fix either
    // way. The interaction between an explicit-context `kubectl get`
    // and the pre-existing "unknown is not safe" rule is a separate,
    // orchestrator-waived decision; see the classifyRisk-level block
    // below.
    const { result, output } = await intercept("kubectl get pods");
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });
});

// Review HIGH finding 2: the fix round 1 merge replaced the ambient
// kube context/namespace per field with whatever the command's own
// flag said, unconditionally. Measured, all three commands below
// BLOCKED on master's pure-ambient behavior (no command parsing exists
// there) but ALLOWED on the fix round 1 branch with an ambient
// kubeconfig on production: command text could LOWER an
// already-resolved production classification. The merge is now
// upgrade-only (`applyKubeTargetUpgrade`): every test here passes an
// ambient production-like kube context explicitly and asserts the
// action still blocks.
describe("runInterceptCli - kubectl explicit target never downgrades an ambient production (review HIGH finding 2)", () => {
  const ambientProd = { kubeContext: "prod-eu-1" };

  it("an empty --context= does not clear an ambient production context", async () => {
    const { result } = await intercept(
      "kubectl delete namespace payments --context=",
      ambientProd,
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });

  it("a flag read past a kubectl exec -- separator does not clear an ambient production context", async () => {
    const { result } = await intercept(
      "kubectl exec -it pod -- myapp --context staging-1",
      ambientProd,
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });

  it("an explicit non-production --context does not downgrade an ambient production context", async () => {
    const { result } = await intercept(
      "kubectl delete namespace payments --context staging-1",
      ambientProd,
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });

  it("ambient production + explicit staging stays production (same case, restated for the review's own wording)", async () => {
    const { result } = await intercept(
      "kubectl --context=staging-1 delete namespace payments",
      ambientProd,
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });

  it("still upgrades: an explicit production-like --context raises a non-production ambient context (regression, AC1/AC2 shape)", async () => {
    const { result } = await intercept(
      "kubectl delete namespace payments --context prod-eu-1",
      { kubeContext: "staging-1" },
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });
});

// Review MEDIUM finding (coverage): parseKubectlTarget's own head test
// is narrow by design (module doc scope point 1); intercept.ts feeds it
// the REMAINDER after `parseBashPrefix` strips a leading `cd <path> &&`
// or `VAR=value` prefix, so a wrapped kubectl invocation is still
// covered end to end.
describe("runInterceptCli - kubectl target behind a cd / inline-env prefix (review MEDIUM: coverage)", () => {
  it("cd <path> && kubectl ... --context prod-eu-1 resolves production", async () => {
    const { result } = await intercept("cd /tmp && kubectl delete namespace payments --context prod-eu-1");
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });

  it("KUBECONFIG=/tmp/k kubectl ... --context prod-eu-1 resolves production", async () => {
    const { result } = await intercept(
      "KUBECONFIG=/tmp/k kubectl delete namespace payments --context prod-eu-1",
    );
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
  });
});

// Review item 6 (round 3): the `--` end-of-flags stop is the ONLY thing
// preventing a false upgrade here (there is no ambient signal to fall
// back on, unlike the downgrade block above). Without it, the exec'd
// program's own --context would be read as kubectl's, wrongly resolving
// production and requiring approval for an ordinary exec.
describe("runInterceptCli - the -- stop is the only protection against a false upgrade (review, fix round 3)", () => {
  it("kubectl exec -it pod -- myapp --context prod-eu-1 stays non-production", async () => {
    const { result, output } = await intercept(
      "kubectl exec -it pod -- myapp --context prod-eu-1",
    );
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });
});

// AC5's classifier half, isolated from the policy engine: `kubectl get
// pods --context prod-eu-1` must stay unclassified under the new
// flag-tolerant pattern (no `delete` literal to anchor on).
//
// Orchestrator decision (review MEDIUM finding, AC5): the full
// end-to-end block of a read-only `kubectl get --context prod` is the
// pre-existing "unknown is not safe" rule, not something this fix
// introduces, and is WAIVED for this task; giving `kubectl get` a
// read-only classified floor is its own follow-up task.
describe("classifyRisk - AC2/AC5: kubectl classifier flag-tolerance", () => {
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

  it("AC2: `kubectl --context=prod-eu-1 delete namespace payments` (leading flag) classifies high", () => {
    // The classifier half of AC2: the old rigid `kubectl\s+delete\s+...`
    // pattern required the two verbs adjacent, so a leading flag between
    // them fell back to unclassified entirely. This is the
    // discriminating assertion for that specific defect, independent of
    // the resolver half tested above.
    const p = classifyRisk(
      bashEnvelope("kubectl --context=prod-eu-1 delete namespace payments"),
      [KUBECTL_CLASSIFIER],
    );
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("high");
  });

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

  it("pattern-level negative control: `kubectl delete-me namespace x` does not classify (review HIGH finding 1)", () => {
    // The unanchored literal "delete" inside "delete-me" must not be
    // read as the verb: `\s+delete\s+` requires whitespace on both
    // sides.
    const p = classifyRisk(bashEnvelope("kubectl delete-me namespace x"), [KUBECTL_CLASSIFIER]);
    expect(p.classified).toBe(false);
  });

  it("pattern-level negative control: `terraform plan -destroy` does not classify (review HIGH finding 1)", () => {
    // "plan" is not a `-`-prefixed flag token, so the flag-loop cannot
    // consume it and skip ahead to the trailing "-destroy"; the
    // required verb sequence never matches.
    const p = classifyRisk(bashEnvelope("terraform plan -destroy"), [KUBECTL_CLASSIFIER]);
    expect(p.classified).toBe(false);
  });

  it("timing regression: a 40-flag non-matching kubectl/terraform command classifies in well under 100ms (review HIGH finding 1)", () => {
    // The fix round 1 patterns were quadratic in the number of flag
    // tokens (measured: 26 flags at ~4.5s via classifyRisk-equivalent
    // regex evaluation). The replacement patterns are linear; this pins
    // that regression at a generous margin (well under 100ms, actual
    // measured well under 1ms) so a future re-introduction of
    // backtracking ambiguity is caught in CI rather than in production.
    let flags = "";
    for (let i = 0; i < 40; i++) flags += ` --flag${i} val${i}`;
    const kubectlCmd = `kubectl${flags} get pods`;
    const terraformCmd = `terraform${flags} plan`;

    const t0 = Date.now();
    const pk = classifyRisk(bashEnvelope(kubectlCmd), [KUBECTL_CLASSIFIER]);
    const pt = classifyRisk(bashEnvelope(terraformCmd), [KUBECTL_CLASSIFIER]);
    const elapsedMs = Date.now() - t0;

    expect(pk.classified).toBe(false);
    expect(pt.classified).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
  });
});
