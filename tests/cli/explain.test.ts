import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { explain } from "../../src/cli/explain.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { makeDecisionEntry } from "../_helpers/decision.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("explain — happy path", () => {
  it("prints a structured definition for a known policy", async () => {
    const r = await explain("review-before-merge", { configPath: FULL_MANIFEST });
    expect(r.output).toContain("name: review-before-merge");
    expect(r.output).toContain("trigger:");
    expect(r.output).toContain("requires:");
    expect(r.output).toContain("hook: require-review-evidence");
    expect(r.output).toContain("enforcement: block");
    expect(r.output).toContain("--trace");
  });

  it("emits parseable JSON when --json is passed", async () => {
    const r = await explain("dogfood-before-release", {
      configPath: FULL_MANIFEST,
      json: true,
    });
    const parsed = JSON.parse(r.output);
    expect(parsed.name).toBe("dogfood-before-release");
    expect(parsed.requires.within).toBe("24h");
  });

  it("non-trace projection includes a `toSatisfy` hint built from the policy's requires spec (agent-tasks/32ed47cb)", async () => {
    const r = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      json: true,
    });
    const parsed = JSON.parse(r.output);
    // The reference manifest's review-before-merge requires the
    // un-substituted `review:${PR_NUMBER}` tag; explain shows the
    // contract, not a per-event instance, so the placeholder survives.
    expect(parsed.toSatisfy).toMatch(/review:\$\{PR_NUMBER\}/);
    expect(parsed.toSatisfy).toMatch(/evidence-ledger entry/);
  });
});

describe("explain — error handling", () => {
  it("throws HarnessExitError 64 when the named policy does not exist", async () => {
    let caught: unknown;
    try {
      await explain("does-not-exist", { configPath: FULL_MANIFEST });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
    expect(err.message).toMatch(/no policy named "does-not-exist"/);
    expect(err.message).toMatch(/review-before-merge/);
  });

  it("reports `(none)` when a manifest has no policies declared", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-empty-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1\nhooks: []\npolicies: []\n`,
      "utf8",
    );
    let caught: unknown;
    try {
      await explain("any-name", {
        homeDir: home,
        configPath: path.join(home, "harness.yaml"),
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
    expect(err.message).toMatch(/any-name/);
    expect(err.message).toMatch(/available: \(none\)/);
  });
});

describe("explain --trace", () => {
  // Local thin wrapper: explain tests pin SESSION_ID into extractValues
  // by default (the "renders the most recent decision trail" test
  // matches `PR_NUMBER` in the trace yaml). Pass through to the shared
  // helper, layering the extra extract value.
  const decisionEntry: typeof makeDecisionEntry = (overrides, createdAt) =>
    makeDecisionEntry(
      {
        ...overrides,
        extractValues: {
          PR_NUMBER: "42",
          SESSION_ID: "sess-1",
          ...overrides.extractValues,
        },
      },
      createdAt,
    );

  it("renders the most recent decision trail", async () => {
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T10:00:00.000Z"),
          decisionEntry(
            { policyName: "review-before-merge", outcome: "allow", reason: "1 matching" },
            "2026-04-30T12:00:00.000Z",
          ),
          decisionEntry({ policyName: "other-policy" }, "2026-04-30T13:00:00.000Z"),
        ],
      }),
    });
    expect(result.output).toContain("name: review-before-merge");
    expect(result.output).toContain("decision: allow");
    expect(result.output).toContain("evaluatedAt: 2026-04-30T12:00:00.000Z");
    expect(result.output).toContain("verb: ledger_summary");
    expect(result.output).toMatch(/PR_NUMBER: ["']42["']/);
  });

  it("emits a structured JSON projection under --json", async () => {
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      json: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T12:00:00.000Z")],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.name).toBe("review-before-merge");
    expect(parsed.decision).toBe("deny");
    expect(parsed.requiresEval.matchedCount).toBe(0);
    expect(parsed.ledgerQuery).toEqual({ verb: "ledger_summary", sessionId: "sess-1" });
    expect(parsed.triggerMatched.event).toBe("PreToolUse");
    expect(parsed.extract.PR_NUMBER).toBe("42");
    expect(parsed.enforcement).toBe("block");
    expect(parsed.reason).toMatch(/no matching ledger entry/);
    expect(parsed.ledgerTag).toBe("review:42");
    expect(parsed.evaluatedAt).toBe("2026-04-30T12:00:00.000Z");
  });

  it("Phase 7 #5: --trace surfaces the recorded classifier + environment", async () => {
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      json: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry(
            {
              policyName: "review-before-merge",
              risk: {
                classified: true,
                severity: "critical",
                categories: ["destructive", "infrastructure_change"],
                reversible: false,
                confidence: "high",
                reasons: ['classifier "dangerous-shell" matched'],
              },
              environment: {
                name: "production",
                confidence: "medium",
                signals: ["branch:main ~ main"],
                resolver: "production-signals",
              },
            },
            "2026-04-30T12:00:00.000Z",
          ),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.classifier.severity).toBe("critical");
    expect(parsed.classifier.categories).toContain("destructive");
    expect(parsed.environment.name).toBe("production");
    expect(parsed.environment.resolver).toBe("production-signals");
  });

  it("Phase 7 #5: --trace omits classifier/environment for a pre-#5 decision", async () => {
    // A decision recorded before #5 (or by a no-`when:` manifest) carries
    // no `risk` / `environment` payload — the trace simply omits them.
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      json: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T12:00:00.000Z"),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.classifier).toBeUndefined();
    expect(parsed.environment).toBeUndefined();
  });

  it("silently skips malformed policy_decision content and uses the latest valid entry", async () => {
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      json: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          // Garbage content from a future schema or a buggy writer.
          {
            id: "junk-1",
            content: "policy_decision:review-before-merge:deny not-json",
            createdAt: "2026-04-30T13:00:00.000Z",
          },
          {
            id: "junk-2",
            content: "review:42:approved",
            createdAt: "2026-04-30T13:30:00.000Z",
          },
          decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T12:00:00.000Z"),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.evaluatedAt).toBe("2026-04-30T12:00:00.000Z");
    expect(parsed.decision).toBe("deny");
  });

  it("Phase 5 #9: picks the latest decision by evaluatedAt when multiple fires share an SQL second", async () => {
    // Both entries collide at the SQL DATETIME's 1-second precision, but
    // the decoded payload's evaluatedAt distinguishes them in ms.
    // Pre-fix this test would fail because selectLatestForPolicy sorted on
    // createdAt — the two ties stable-sorted to the first (deny).
    const createdAt = "2026-05-01 08:33:24";
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry(
            {
              policyName: "review-before-merge",
              outcome: "deny",
              reason: "first fire",
              evaluatedAt: "2026-05-01T08:33:23.780Z",
            },
            createdAt,
          ),
          decisionEntry(
            {
              policyName: "review-before-merge",
              outcome: "allow",
              reason: "second fire",
              evaluatedAt: "2026-05-01T08:33:24.668Z",
            },
            createdAt,
          ),
        ],
      }),
    });
    expect(result.output).toContain("decision: allow");
    expect(result.output).toContain("evaluatedAt: 2026-05-01T08:33:24.668Z");
    expect(result.output).toContain("second fire");
    expect(result.output).not.toContain("first fire");
  });

  it("Phase 5 #9: falls back to createdAt when evaluatedAt is missing or unparseable", async () => {
    const result = await explain("review-before-merge", {
      configPath: FULL_MANIFEST,
      trace: true,
      json: true,
      sessionId: "sess-1",
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          // Older decision but un-parseable evaluatedAt — sort key
          // should fall back to createdAt and order it first (oldest).
          decisionEntry(
            {
              policyName: "review-before-merge",
              outcome: "deny",
              reason: "older",
              evaluatedAt: "not-a-real-iso",
            },
            "2026-05-01T08:00:00.000Z",
          ),
          decisionEntry(
            {
              policyName: "review-before-merge",
              outcome: "allow",
              reason: "newer",
              evaluatedAt: "2026-05-01T09:00:00.000Z",
            },
            "2026-05-01T09:00:00.000Z",
          ),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.decision).toBe("allow");
    expect(parsed.reason).toBe("newer");
  });

  it("Phase 5 #2: --trace uses $CLAUDE_SESSION_ID when --session is not given", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "env-session-22";
    try {
      let observedSessionId: string | undefined;
      const result = await explain("review-before-merge", {
        configPath: FULL_MANIFEST,
        trace: true,
        json: true,
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return {
            kind: "ok",
            entries: [
              decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T10:00:00.000Z"),
            ],
          };
        },
      });
      expect(observedSessionId).toBe("env-session-22");
      const parsed = JSON.parse(result.output);
      expect(parsed.ledgerQuery.sessionId).toBe("env-session-22");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("Phase 5 #2: explicit --session beats $CLAUDE_SESSION_ID for --trace", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "env-session-22";
    try {
      let observedSessionId: string | undefined;
      await explain("review-before-merge", {
        configPath: FULL_MANIFEST,
        trace: true,
        sessionId: "flag-session-44",
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return {
            kind: "ok",
            entries: [
              decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T10:00:00.000Z"),
            ],
          };
        },
      });
      expect(observedSessionId).toBe("flag-session-44");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("--trace discovers the live session from the newest transcript when no env or flag", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      let observedSessionId: string | undefined;
      const result = await explain("review-before-merge", {
        configPath: FULL_MANIFEST,
        trace: true,
        json: true,
        sessionDiscovery: { discover: () => "discovered-session-55" },
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return {
            kind: "ok",
            entries: [
              decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T10:00:00.000Z"),
            ],
          };
        },
      });
      expect(observedSessionId).toBe("discovered-session-55");
      expect(JSON.parse(result.output).ledgerQuery.sessionId).toBe(
        "discovered-session-55",
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("--trace names the queried session in the no-evaluations error", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      let caught: unknown;
      try {
        await explain("review-before-merge", {
          configPath: FULL_MANIFEST,
          trace: true,
          sessionDiscovery: { discover: () => null },
          fetchLedger: async () => ({ kind: "ok", entries: [] }),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HarnessExitError);
      expect((caught as HarnessExitError).message).toContain("in session `default`");
      expect((caught as HarnessExitError).message).toContain("--session");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("exits 1 with the documented message when no recorded evaluations exist", async () => {
    let caught: unknown;
    try {
      await explain("review-before-merge", {
        configPath: FULL_MANIFEST,
        trace: true,
        fetchLedger: async () => ({ kind: "ok", entries: [] }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/no recorded evaluations for policy `review-before-merge`/);
  });

  it("exits 1 when the audit log is unreachable", async () => {
    let caught: unknown;
    try {
      await explain("review-before-merge", {
        configPath: FULL_MANIFEST,
        trace: true,
        fetchLedger: async () => ({
          kind: "degraded",
          reason: "grounding-mcp not reachable",
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/cannot read audit log: grounding-mcp not reachable/);
  });
});

describe("explain --last", () => {
  const decisionEntry: typeof makeDecisionEntry = (overrides, createdAt) =>
    makeDecisionEntry(
      {
        ...overrides,
        extractValues: {
          PR_NUMBER: "42",
          SESSION_ID: "sess-1",
          ...overrides.extractValues,
        },
      },
      createdAt,
    );

  it("traces the most recent decision regardless of policy name", async () => {
    const result = await explain(undefined, {
      configPath: FULL_MANIFEST,
      last: true,
      sessionId: "sess-1",
      json: true,
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry({ policyName: "review-before-merge" }, "2026-04-30T10:00:00.000Z"),
          decisionEntry(
            { policyName: "dogfood-before-release", outcome: "allow", reason: "fresh dogfood" },
            "2026-04-30T13:00:00.000Z",
          ),
          decisionEntry(
            { policyName: "review-before-merge", outcome: "deny", reason: "older" },
            "2026-04-30T11:00:00.000Z",
          ),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.name).toBe("dogfood-before-release");
    expect(parsed.decision).toBe("allow");
    expect(parsed.reason).toBe("fresh dogfood");
    expect(parsed.evaluatedAt).toBe("2026-04-30T13:00:00.000Z");
    expect(parsed.triggerMatched.event).toBe("PreToolUse");
  });

  it("with --decision deny returns the most recent deny even when an allow is more recent", async () => {
    const result = await explain(undefined, {
      configPath: FULL_MANIFEST,
      last: true,
      decisionFilter: "deny",
      sessionId: "sess-1",
      json: true,
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry(
            { policyName: "review-before-merge", outcome: "deny", reason: "earlier deny" },
            "2026-04-30T10:00:00.000Z",
          ),
          decisionEntry(
            { policyName: "review-before-merge", outcome: "deny", reason: "later deny" },
            "2026-04-30T11:00:00.000Z",
          ),
          decisionEntry(
            { policyName: "review-before-merge", outcome: "allow", reason: "intervening allow" },
            "2026-04-30T12:00:00.000Z",
          ),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("later deny");
    expect(parsed.evaluatedAt).toBe("2026-04-30T11:00:00.000Z");
  });

  it("exits 1 with a friendly message when the ledger has no decisions", async () => {
    let caught: unknown;
    try {
      await explain(undefined, {
        configPath: FULL_MANIFEST,
        last: true,
        sessionId: "sess-empty",
        fetchLedger: async () => ({ kind: "ok", entries: [] }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/no recorded policy decisions for session `sess-empty`/);
  });

  it("exits 1 with a filter-aware message when --decision matches nothing", async () => {
    let caught: unknown;
    try {
      await explain(undefined, {
        configPath: FULL_MANIFEST,
        last: true,
        decisionFilter: "deny",
        sessionId: "sess-1",
        fetchLedger: async () => ({
          kind: "ok",
          entries: [
            decisionEntry(
              { policyName: "review-before-merge", outcome: "allow", reason: "all allows here" },
              "2026-04-30T10:00:00.000Z",
            ),
          ],
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/no recorded policy decisions with outcome `deny`/);
  });

  it("exits 1 when the audit log is unreachable", async () => {
    let caught: unknown;
    try {
      await explain(undefined, {
        configPath: FULL_MANIFEST,
        last: true,
        fetchLedger: async () => ({ kind: "degraded", reason: "no mcp" }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(1);
    expect(err.message).toMatch(/cannot read audit log: no mcp/);
  });

  it("renders an unknown-trigger placeholder when the policy is no longer declared", async () => {
    const result = await explain(undefined, {
      configPath: FULL_MANIFEST,
      last: true,
      sessionId: "sess-1",
      json: true,
      fetchLedger: async () => ({
        kind: "ok",
        entries: [
          decisionEntry(
            { policyName: "removed-policy", outcome: "deny", reason: "stale ledger row" },
            "2026-04-30T13:00:00.000Z",
          ),
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.name).toBe("removed-policy");
    expect(parsed.triggerMatched.event).toMatch(/policy not declared/);
  });
});

describe("explain — argument validation (without --last)", () => {
  it("throws EX_USAGE when neither <policy> nor --last is given", async () => {
    let caught: unknown;
    try {
      await explain(undefined, { configPath: FULL_MANIFEST });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
    expect(err.message).toMatch(/policy name is required/);
  });
});
