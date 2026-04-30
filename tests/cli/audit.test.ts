import { describe, expect, it } from "vitest";
import { audit } from "../../src/cli/audit.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  encodeLedgerContent,
  payloadFromDecision,
} from "../../src/runtime/ledger-record.js";
import type { PolicyDecision } from "../../src/runtime/intercept.js";

const NOW = new Date("2026-04-30T12:00:00.000Z");

function decisionEntry(
  overrides: Partial<PolicyDecision> & Pick<PolicyDecision, "policyName">,
  createdAt: string,
) {
  const decision: PolicyDecision = {
    enforcement: "block",
    outcome: "deny",
    reason: "no matching ledger entry for tag `review:42`",
    extractValues: { PR_NUMBER: "42" },
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

const FIXTURE = [
  decisionEntry({ policyName: "review-before-merge", outcome: "deny", reason: "missing review" }, "2026-04-30T08:00:00.000Z"),
  decisionEntry({ policyName: "review-before-merge", outcome: "allow", reason: "1 matching entry" }, "2026-04-30T11:00:00.000Z"),
  decisionEntry({ policyName: "dogfood-before-release", outcome: "warn-degraded", reason: "ledger db missing" }, "2026-04-30T11:30:00.000Z"),
  decisionEntry({ policyName: "two-reviewers-required", outcome: "deny", reason: "1 of required 2 entries found" }, "2026-04-30T11:45:00.000Z"),
  // Unrelated entry that decodeLedgerContent ignores.
  {
    id: "unrelated",
    content: "review:42:approved",
    createdAt: "2026-04-30T11:00:00.000Z",
  },
];

const MANIFEST_PATH =
  // any valid manifest works since fetchLedger is injected.
  new URL("../../docs/examples/full-manifest.yaml", import.meta.url).pathname;

describe("audit — happy path", () => {
  it("lists every policy decision in the default 24h window with table output", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(4);
    const headerLine = result.output.split("\n", 1)[0]!;
    expect(headerLine).toMatch(/timestamp\s+policy\s+outcome\s+reason/);
    expect(result.output).toContain("review-before-merge");
    expect(result.output).toContain("dogfood-before-release");
    // Sorted ascending by timestamp.
    const idxFirst = result.output.indexOf("08:00");
    const idxLast = result.output.indexOf("11:45");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxLast).toBeGreaterThan(idxFirst);
  });

  it("emits parseable JSON under --json", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      json: true,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.decisions).toHaveLength(4);
    expect(parsed.decisions[0].name).toBe("review-before-merge");
  });
});

describe("audit — filters", () => {
  it("--since 1h drops entries older than 1h before now", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "1h",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    // Only the entries between 11:00 and 12:00 (i.e. 11:00, 11:30, 11:45).
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.every((d) => Date.parse(d.timestamp) >= NOW.getTime() - 60 * 60 * 1000)).toBe(true);
  });

  it("--policy filters to a single policy name", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      policy: "review-before-merge",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((d) => d.name === "review-before-merge")).toBe(true);
  });

  it("--outcome deny filters to denials only", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      outcome: "deny",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((d) => d.outcome === "deny")).toBe(true);
  });

  it("filters compose: --policy + --outcome + --since", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      policy: "review-before-merge",
      outcome: "allow",
      since: "2h",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
  });
});

describe("audit — empty window", () => {
  it("prints the documented empty-window message and exits 0", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "30m",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: [] }),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.output).toBe("no policy decisions in the last 30m\n");
  });
});

describe("audit — degraded ledger", () => {
  it("throws EX_UNAVAILABLE when the ledger client returns degraded", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        now: NOW,
        fetchLedger: async () => ({
          kind: "degraded",
          reason: "grounding-mcp not declared",
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(69);
    expect(err.message).toMatch(/ledger unreachable: grounding-mcp not declared/);
  });
});

describe("audit — input validation", () => {
  it("rejects a bad --since duration with EX_USAGE", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        since: "yesterday",
        fetchLedger: async () => ({ kind: "ok", entries: [] }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
  });

  it("rejects an invalid --outcome with EX_USAGE", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        outcome: "maybe" as never,
        fetchLedger: async () => ({ kind: "ok", entries: [] }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
  });
});
