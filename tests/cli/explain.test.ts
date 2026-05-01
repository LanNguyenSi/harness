import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { explain } from "../../src/cli/explain.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  encodeLedgerContent,
  payloadFromDecision,
} from "../../src/runtime/ledger-record.js";
import type { PolicyDecision } from "../../src/runtime/intercept.js";

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
  function decisionEntry(
    overrides: Partial<PolicyDecision> & Pick<PolicyDecision, "policyName">,
    createdAt: string,
  ) {
    const decision: PolicyDecision = {
      enforcement: "block",
      outcome: "deny",
      reason: "no matching ledger entry for tag `review:42`",
      extractValues: { PR_NUMBER: "42", SESSION_ID: "sess-1" },
      ledgerTag: "review:42",
      requiresEval: { matchedCount: 0, reason: "no matching ledger entry for tag `review:42`" },
      evaluatedAt: createdAt,
      ...overrides,
    };
    return {
      id: createdAt,
      content: encodeLedgerContent(payloadFromDecision(decision)),
      source: "harness-policy-intercept",
      createdAt,
    };
  }

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
