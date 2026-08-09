// Drift guard (reviewer LOW finding, task 341e024b fix round 1): `ENV_RANK`
// in src/cli/policy/intercept.ts is a hand-maintained copy of
// `ENV_PRECEDENCE` in src/runtime/environment-resolver.ts, used by
// `applyBranchSwitchUpgrade` to decide whether a leading `git
// switch`/`checkout <branch>` candidate is MORE dangerous than the base
// git context. TypeScript's `Record<MatchableEnvironment, number>` type
// catches an added/removed environment, but nothing catches a REORDER of
// `ENV_PRECEDENCE` — `ENV_RANK` would then silently rank environments in
// the wrong relative order, and a reorder could invert the upgrade-only
// direction the whole feature depends on. No source-level guard connects
// the two: `ENV_PRECEDENCE` is private to environment-resolver.ts, and
// exporting it so `ENV_RANK` could be derived from it would touch a file
// outside this task's original three (bash-prefix-parse.ts,
// intercept.ts, git-context.ts) — the reviewer's preferred, scope-true
// fix is this test-only guard instead. It measures BOTH orderings live,
// through their own public behavior, and asserts they agree.
//
//   1. `measureActualPrecedence()` below discovers `ENV_PRECEDENCE`'s
//      REAL current order by calling `resolveEnvironment` directly: four
//      resolvers, one per environment, each keyed on a DIFFERENT signal
//      kind (branch / env var / kube context / kube namespace) so all
//      four can fire on ONE probe envelope simultaneously; whichever
//      environment wins the conflict IS, by `resolveEnvironment`'s own
//      "most-dangerous-wins" contract, the most dangerous per
//      `ENV_PRECEDENCE`. Removing the winner's resolver and repeating
//      reveals the next-most-dangerous, and so on — the full order falls
//      out in four calls without this test ever assuming what the order
//      is (no hardcoded `["production", "staging", ...]` reference list).
//   2. For every ADJACENT pair in that measured order, a `runInterceptCli`
//      round-trip probes `ENV_RANK`'s real comparative behavior via
//      `applyBranchSwitchUpgrade`: switching (via a leading `git switch`)
//      from the less-dangerous branch to the more-dangerous one must
//      upgrade (the more-dangerous environment's policy fires); switching
//      the other way must NOT downgrade (the more-dangerous environment's
//      policy still fires, from the base branch).
//
// A reorder of `ENV_PRECEDENCE` without a matching reorder of `ENV_RANK`
// changes step 1's measured order but not step 2's `ENV_RANK`-driven
// behavior, so at least one adjacent pair disagrees and this file goes
// red. Mutation-probed: swapping two entries in `ENV_PRECEDENCE`
// (src/runtime/environment-resolver.ts) without touching `ENV_RANK`
// fails this file (see task notes; not committed as a standing mutant).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import {
  buildActionEnvelope,
  resolveEnvironment,
  type ActionEnvelope,
  type EnvelopeContext,
  type SignalInputs,
} from "../../src/runtime/index.js";
import type { LedgerClient, ToolEvent } from "../../src/runtime/intercept.js";
import type {
  EnvironmentName,
  EnvironmentResolver,
  Manifest,
  Policy,
  RiskClassifier,
} from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
// `EnvironmentName` (production/staging/dev/local) — the resolver-
// assertable subset of `MatchableEnvironment`, deliberately excluding
// `unknown` (a resolver cannot assert "unknown"; see schema/environments.ts).
const ENVS: EnvironmentName[] = ["production", "staging", "dev", "local"];

function probeEnvelope(): ActionEnvelope {
  const ctx: EnvelopeContext = {
    cwd: "/work/repo",
    git: { repo: "repo", branch: "probe-branch", sha: "" },
    user: "agent",
    host: "host",
    now: NOW,
  };
  const event: ToolEvent = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  return buildActionEnvelope(event, ctx);
}

// One resolver per environment, each on a DIFFERENT signal kind so all
// four can fire simultaneously on the same probe envelope/inputs below —
// that simultaneity is what makes `resolveEnvironment`'s winner reveal
// the REAL `ENV_PRECEDENCE` order rather than each resolver simply
// firing alone.
const PROBE_RESOLVERS: Record<EnvironmentName, EnvironmentResolver> = {
  production: {
    name: "probe-production",
    environment: "production",
    signals: { branch_patterns: ["probe-branch"] },
  },
  staging: {
    name: "probe-staging",
    environment: "staging",
    signals: { env_var_patterns: [{ var: "DRIFT_PROBE", patterns: ["stg"] }] },
  },
  dev: {
    name: "probe-dev",
    environment: "dev",
    signals: { kube_context_patterns: ["drift-probe-ctx"] },
  },
  local: {
    name: "probe-local",
    environment: "local",
    signals: { kube_namespace_patterns: ["drift-probe-ns"] },
  },
};

const PROBE_INPUTS: SignalInputs = {
  env: { DRIFT_PROBE: "stg" },
  kubeContext: "drift-probe-ctx",
  kubeNamespace: "drift-probe-ns",
};

/**
 * Discover `ENV_PRECEDENCE`'s real, current order (most dangerous first)
 * purely through `resolveEnvironment`'s public conflict-resolution
 * behavior — see file doc for the elimination method.
 */
function measureActualPrecedence(): EnvironmentName[] {
  const remaining = new Set<EnvironmentName>(ENVS);
  const order: EnvironmentName[] = [];
  const envelope = probeEnvelope();
  while (remaining.size > 0) {
    const resolvers = [...remaining].map((e) => PROBE_RESOLVERS[e]);
    const winner = resolveEnvironment(envelope, resolvers, PROBE_INPUTS).name;
    if (winner === "unknown" || !remaining.has(winner)) {
      throw new Error(`drift-guard probe malfunction: unexpected winner "${winner}"`);
    }
    order.push(winner);
    remaining.delete(winner);
  }
  return order;
}

// --- e2e half: probe ENV_RANK's real comparative behavior via applyBranchSwitchUpgrade ---

const BRANCH_OF: Record<EnvironmentName, string> = {
  production: "prod-branch",
  staging: "staging-branch",
  dev: "dev-branch",
  local: "local-branch",
};

function branchResolverFor(env: EnvironmentName): EnvironmentResolver {
  return {
    name: `branch-${env}`,
    environment: env,
    signals: { branch_patterns: [BRANCH_OF[env]] },
  };
}

function policyFor(env: EnvironmentName): Policy {
  return {
    name: `gate-${env}-destructive`,
    description: `deny critical-severity destructive shell actions against ${env}`,
    trigger: { event: "PreToolUse", match: "Bash" },
    when: {
      "risk.severity_at_least": "critical",
      "environment.name": env,
    },
    requires: { ledger_tag: `risk-override:${env}:\${SESSION_ID}` },
    hook: "risk-gate",
    enforcement: "block",
  } as Policy;
}

const RM_CLASSIFIER: RiskClassifier = {
  name: "dangerous-rm",
  tool: "Bash",
  patterns: [{ pattern: "rm\\s+-rf", categories: ["destructive"], severity: "critical" }],
};

const rankManifest: Manifest = makeManifest({
  policies: ENVS.map(policyFor),
  classifiers: [RM_CLASSIFIER],
  resolvers: ENVS.map(branchResolverFor),
});

const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

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

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeGitRepo(branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-envrank-"));
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(
    path.join(root, ".git", "refs", "heads", branch),
    "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Runs `git switch <BRANCH_OF[switchToEnv]> && rm -rf <path>` from a repo
 * on `BRANCH_OF[baseEnv]`, and returns which environment's policy fired
 * (or `"allow"` when nothing blocked). This is `applyBranchSwitchUpgrade`
 * / `ENV_RANK`'s real, observable comparative behavior for the pair.
 */
async function resolvedGateEnv(
  baseEnv: EnvironmentName,
  switchToEnv: EnvironmentName,
): Promise<string> {
  const baseRepo = makeGitRepo(BRANCH_OF[baseEnv]);
  const { stream, output } = captureStdout();
  const result = await runInterceptCli({
    stdin: streamFrom(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: `git switch ${BRANCH_OF[switchToEnv]} && rm -rf /var/lib/appdata`,
        },
        session_id: `sess-drift-${baseEnv}-${switchToEnv}`,
        cwd: baseRepo,
      }),
    ),
    stdout: stream,
    manifest: rankManifest,
    ledger: emptyLedger,
    env: {},
  });
  if (!result.blocked) return "allow";
  const parsed = JSON.parse(output().trim());
  const hit = ENVS.find((e) => (parsed.reason as string).includes(`gate-${e}-destructive`));
  return hit ?? "unrecognized";
}

describe("ENV_RANK / ENV_PRECEDENCE drift guard (reviewer finding, task 341e024b fix round 1)", () => {
  const measured = measureActualPrecedence();

  it("measures a full, distinct 4-environment order (probe sanity)", () => {
    expect(new Set(measured).size).toBe(4);
  });

  for (let i = 0; i < measured.length - 1; i++) {
    const moreDangerous = measured[i]!;
    const lessDangerous = measured[i + 1]!;

    it(`ENV_RANK upgrades ${lessDangerous} -> ${moreDangerous} (matches measured ENV_PRECEDENCE order)`, async () => {
      const winner = await resolvedGateEnv(lessDangerous, moreDangerous);
      expect(winner).toBe(moreDangerous);
    });

    it(`ENV_RANK does not downgrade ${moreDangerous} -> ${lessDangerous} (matches measured ENV_PRECEDENCE order)`, async () => {
      const winner = await resolvedGateEnv(moreDangerous, lessDangerous);
      expect(winner).toBe(moreDangerous);
    });
  }
});
