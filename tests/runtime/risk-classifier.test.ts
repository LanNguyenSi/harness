import { describe, expect, it } from "vitest";
import {
  buildActionEnvelope,
  classifyRisk,
} from "../../src/runtime/index.js";
import type { ActionEnvelope, EnvelopeContext } from "../../src/runtime/index.js";
import type { ToolEvent } from "../../src/runtime/intercept.js";
import type { RiskClassifier } from "../../src/schema/index.js";

const CTX: EnvelopeContext = {
  cwd: "/work/repo",
  git: { repo: "repo", branch: "main", sha: "" },
  user: "agent",
  host: "host",
  now: new Date("2026-05-22T12:00:00.000Z"),
};

/** Build an envelope for a Bash command. */
function bashEnvelope(command: string): ActionEnvelope {
  const event: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
  return buildActionEnvelope(event, CTX);
}

const SHELL: RiskClassifier = {
  name: "dangerous-shell",
  tool: "Bash",
  patterns: [
    {
      pattern: "rm\\s+-rf\\s+/",
      categories: ["destructive", "data_loss"],
      severity: "critical",
    },
    {
      pattern: "DROP\\s+TABLE",
      categories: ["destructive", "data_loss"],
      severity: "high",
    },
    {
      pattern: "kubectl\\s+delete",
      categories: ["infrastructure_change"],
      severity: "medium",
    },
  ],
};

describe("classifyRisk — matching", () => {
  it("classifies a single-pattern hit", () => {
    const p = classifyRisk(bashEnvelope("rm -rf /var"), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("critical");
    expect(p.categories).toEqual(["data_loss", "destructive"]);
    expect(p.confidence).toBe("high");
    expect(p.reasons).toHaveLength(1);
    // The reason line is operator-facing; pin its format against drift.
    expect(p.reasons[0]).toMatch(
      /^classifier "dangerous-shell" pattern \/.+\/ matched: severity critical, categories \[/,
    );
  });

  it("skips a pattern whose regex does not compile (defensive guard)", () => {
    // A manifest that bypassed `harness validate` could carry an
    // unparseable pattern; the classifier must skip it, not throw.
    const broken: RiskClassifier = {
      name: "broken",
      tool: "Bash",
      patterns: [
        { pattern: "([unclosed", categories: ["destructive"], severity: "high" },
      ],
    };
    const p = classifyRisk(bashEnvelope("rm -rf /"), [broken]);
    expect(p.classified).toBe(false);
  });

  it("composes multiple matched patterns: highest severity wins, categories union", () => {
    // Matches both `rm -rf /` (critical) and `kubectl delete` (medium).
    const p = classifyRisk(
      bashEnvelope("rm -rf / && kubectl delete pod x"),
      [SHELL],
    );
    expect(p.severity).toBe("critical");
    expect(p.categories).toEqual([
      "data_loss",
      "destructive",
      "infrastructure_change",
    ]);
    expect(p.reasons).toHaveLength(2);
  });

  it("composes across multiple classifiers", () => {
    const extra: RiskClassifier = {
      name: "secrets",
      tool: "Bash",
      patterns: [
        { pattern: "cat .*\\.env", categories: ["credential_access"], severity: "high" },
      ],
    };
    const p = classifyRisk(bashEnvelope("cat prod.env && DROP TABLE x"), [
      SHELL,
      extra,
    ]);
    expect(p.severity).toBe("high");
    expect(p.categories).toEqual([
      "credential_access",
      "data_loss",
      "destructive",
    ]);
    expect(p.reasons).toHaveLength(2);
  });
});

describe("classifyRisk — reversibility", () => {
  it("is false when a matched category marks the action irreversible", () => {
    expect(classifyRisk(bashEnvelope("rm -rf /"), [SHELL]).reversible).toBe(false);
  });

  it("is true when classified but no category implies irreversibility", () => {
    const p = classifyRisk(bashEnvelope("kubectl delete pod x"), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.categories).toEqual(["infrastructure_change"]);
    expect(p.reversible).toBe(true);
  });

  it("is null when unclassified (reversibility unknown, not assumed)", () => {
    expect(classifyRisk(bashEnvelope("ls -la"), [SHELL]).reversible).toBeNull();
  });
});

describe("classifyRisk — unknown is not safe", () => {
  it("yields an unclassified profile, not a low/zero-risk one, on no match", () => {
    const p = classifyRisk(bashEnvelope("echo hello"), [SHELL]);
    expect(p.classified).toBe(false);
    expect(p.severity).toBeNull();
    expect(p.categories).toEqual([]);
    expect(p.confidence).toBe("low");
    expect(p.reasons[0]).toMatch(/no classifier pattern matched/);
  });

  it("reports when no classifier is declared for the tool at all", () => {
    const p = classifyRisk(bashEnvelope("rm -rf /"), []);
    expect(p.classified).toBe(false);
    expect(p.reasons[0]).toMatch(/no risk classifier is declared for tool "Bash"/);
  });

  it("does not apply a classifier whose tool does not match the envelope", () => {
    const writeClassifier: RiskClassifier = {
      name: "writes",
      tool: "Write",
      patterns: [{ pattern: ".*", categories: ["destructive"], severity: "high" }],
    };
    expect(classifyRisk(bashEnvelope("rm -rf /"), [writeClassifier]).classified).toBe(
      false,
    );
  });
});

describe("classifyRisk — subject extraction", () => {
  it("matches a shell alias tool against the command", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "shell",
      tool_input: { command: "rm -rf /" },
    } as ToolEvent;
    const p = classifyRisk(buildActionEnvelope(event, CTX), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("critical");
  });

  it("falls back to the serialized raw input for a non-command tool", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { script: "DROP TABLE orders" },
    } as ToolEvent;
    const p = classifyRisk(buildActionEnvelope(event, CTX), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("high");
  });
});

describe("classifyRisk — Phase 7 #6 ReDoS subject-length cap", () => {
  // The classifier runs operator-authored regexes on every PreToolUse
  // call; the match subject is capped at 16 KiB so catastrophic
  // backtracking cannot scale with an arbitrarily long tool input.
  const CAP = 16 * 1024;

  it("classifies a dangerous command whose head is within the cap", () => {
    // `rm -rf /` at the start, then a long benign tail past the cap.
    const command = `rm -rf /var ${"x".repeat(CAP * 2)}`;
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("critical");
  });

  it("does not match a pattern that falls entirely beyond the cap", () => {
    // The only dangerous token sits well past 16 KiB, so the capped
    // subject never sees it — the action is reported unclassified
    // (which the `when:` evaluator then treats as risk-bearing anyway).
    const command = `${"x".repeat(CAP + 100)} DROP TABLE orders`;
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(false);
  });
});

describe("classifyRisk — built-in benign harness floor", () => {
  it("recognizes a standalone benign harness command as low, not unclassified", () => {
    // No operator classifier at all: the built-in floor still applies so
    // the fail-close gate cannot deny `harness preflight` in production.
    const p = classifyRisk(bashEnvelope("harness preflight"), []);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("low");
    expect(p.categories).toEqual([]);
    expect(p.reversible).toBe(true);
    expect(p.confidence).toBe("high");
    expect(p.reasons[0]).toMatch(/built-in: benign harness meta-command/);
  });

  it.each([
    "harness doctor",
    "harness validate",
    "harness session-start preflight",
    "harness approve risk",
    "harness explain-policy gate-prod-destructive",
  ])("classifies the read-only / producer command %j as low", (command) => {
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("low");
  });

  it.each(["harness apply", "harness init", "harness remove mcp foo", "harness uninstall"])(
    "leaves the mutating command %j unclassified",
    (command) => {
      const p = classifyRisk(bashEnvelope(command), [SHELL]);
      expect(p.classified).toBe(false);
      expect(p.severity).toBeNull();
    },
  );

  it("lets a dangerous tail win over the floor (highest-severity-wins)", () => {
    // The built-in must NOT short-circuit: a dangerous tail still drives
    // the verdict to critical so the command stays blocked.
    const p = classifyRisk(bashEnvelope("harness preflight && rm -rf /var"), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("critical");
    expect(p.categories).toContain("destructive");
  });

  it("lets an operator classifier raise a harness command above the floor", () => {
    const strict: RiskClassifier = {
      name: "no-harness-approve",
      tool: "Bash",
      patterns: [
        {
          pattern: "harness\\s+approve",
          categories: ["privilege_escalation"],
          severity: "high",
        },
      ],
    };
    const p = classifyRisk(bashEnvelope("harness approve risk"), [strict]);
    expect(p.severity).toBe("high");
  });

  it("does not match an anchored harness command behind a cd prefix (fail-safe)", () => {
    // `cd /x && harness preflight` is not head-anchored, so it stays
    // unclassified rather than letting a prefix launder the command.
    const p = classifyRisk(bashEnvelope("cd /repo && harness preflight"), [SHELL]);
    expect(p.classified).toBe(false);
  });

  it("does not apply the floor to a non-shell tool whose input mentions harness", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "harness preflight" },
    } as ToolEvent;
    const p = classifyRisk(buildActionEnvelope(event, CTX), [SHELL]);
    expect(p.classified).toBe(false);
  });
});
