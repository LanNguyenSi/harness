import { describe, expect, it } from "vitest";
import { renderProducers } from "../../src/policies/producers.js";
import type { Producer } from "../../src/schema/index.js";

describe("renderProducers", () => {
  it("returns empty string when producers is undefined", () => {
    expect(renderProducers(undefined, { REPO: "harness" })).toBe("");
  });

  it("returns empty string when producers is empty array", () => {
    expect(renderProducers([], { REPO: "harness" })).toBe("");
  });

  it("renders bash + mcp producers with ${VAR} substituted", () => {
    const producers: Producer[] = [
      {
        kind: "bash",
        command: "harness session-start preflight",
        description: "Standard producer; writes preflight:${REPO} on ready:true.",
      },
      {
        kind: "mcp",
        verb: "mcp__agent-grounding__ledger_add",
        example: '{type:"fact", content:"preflight:${REPO}"}',
        description: "Ungated recovery path.",
      },
    ];
    const out = renderProducers(producers, { REPO: "harness" });
    expect(out).toContain("To produce this tag:");
    expect(out).toContain("1. [bash] `harness session-start preflight`");
    expect(out).toContain("Standard producer; writes preflight:harness on ready:true.");
    expect(out).toContain("2. [mcp]  mcp__agent-grounding__ledger_add");
    expect(out).toContain('example={type:"fact", content:"preflight:harness"}');
    expect(out).toContain("Ungated recovery path.");
  });

  it("renders ask producers distinctly", () => {
    const producers: Producer[] = [
      {
        kind: "ask",
        command: "harness approve understanding",
        description: "Bare command, no pipes. Operator approval IS the gate satisfaction.",
      },
      {
        kind: "mcp",
        verb: "mcp__agent-grounding__ledger_add",
        example: '{content:"understanding-approved:${SESSION_ID}"}',
        description: "Audit-only fallback (post-v0.14.0 the marker file is the gate signal).",
      },
    ];
    const out = renderProducers(producers, { SESSION_ID: "abc-123" });
    expect(out).toContain("1. [ask]  `harness approve understanding`");
    expect(out).toContain("understanding-approved:abc-123");
  });

  it("leaves unresolved ${VAR} literal (best-effort substitution)", () => {
    const producers: Producer[] = [
      {
        kind: "mcp",
        verb: "mcp__x__write",
        example: "${UNKNOWN_VAR}",
        description: "no UNKNOWN_VAR in context",
      },
    ];
    const out = renderProducers(producers, { REPO: "harness" });
    // unresolved ${VARS} are left literal so the agent sees what was
    // expected, instead of silently disappearing
    expect(out).toContain("${UNKNOWN_VAR}");
  });
});
