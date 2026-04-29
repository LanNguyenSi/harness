import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ManifestParseError, parseManifest } from "../src/schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const EXAMPLES_DIR = path.join(REPO_ROOT, "docs", "examples");
const INVALID_DIR = path.join(EXAMPLES_DIR, "invalid");

function loadYaml(p: string): unknown {
  return parseYaml(fs.readFileSync(p, "utf8"));
}

function expectIssueMatching(err: unknown, pattern: RegExp): void {
  expect(err).toBeInstanceOf(ManifestParseError);
  const issues = (err as ManifestParseError).issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
  expect(issues).toMatch(pattern);
}

describe("parseManifest — happy path", () => {
  it("parses the full reference manifest into a typed object", () => {
    const raw = loadYaml(path.join(EXAMPLES_DIR, "full-manifest.yaml"));
    const manifest = parseManifest(raw);
    expect(manifest.version).toBe(1);
    expect(manifest.tools.mcp).toHaveLength(2);
    expect(manifest.tools.mcp[0]?.name).toBe("codebase-oracle");
    expect(manifest.hooks).toHaveLength(4);
    expect(manifest.policies).toHaveLength(4);
    const reviewPolicy = manifest.policies.find((p) => p.name === "review-before-merge");
    expect(reviewPolicy?.requires.ledger_tag).toBe("review:${PR_NUMBER}");
    expect(reviewPolicy?.trigger.extract?.PR_NUMBER).toBe("toolArgs.prNumber");
  });

  it("applies defaults when optional sections are omitted", () => {
    const m = parseManifest({ version: 1 });
    expect(m.grounding.session.auto_start).toBe(true);
    expect(m.grounding.evidence_ledger.retention_days).toBe(90);
    expect(m.grounding.policies_source).toBeNull();
    expect(m.tools.mcp).toEqual([]);
    expect(m.tools.builtin.known).toEqual([]);
    expect(m.memory.retention.staleness_days).toBe(180);
    expect(m.memory.scopes.default).toBe("project");
    expect(m.hooks).toEqual([]);
    expect(m.policies).toEqual([]);
  });

  it("accepts a string command for tools.mcp[].command", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [{ name: "x", command: "node /tmp/x.js" }] },
    });
    expect(m.tools.mcp[0]?.command).toBe("node /tmp/x.js");
  });

  it("accepts ISO-8601 and shorthand within values", () => {
    for (const within of ["24h", "30m", "7d", "60s", "PT1H", "P1D"]) {
      const m = parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "x:${SESSION_ID}", within },
            hook: "h",
            enforcement: "block",
          },
        ],
      });
      expect(m.policies[0]?.requires.within).toBe(within);
    }
  });
});

describe("parseManifest — invalid fixtures", () => {
  const cases: Array<{ file: string; pattern: RegExp }> = [
    { file: "01-unknown-version.yaml", pattern: /version/i },
    { file: "02-unknown-toplevel-key.yaml", pattern: /unrecognized key|foo/i },
    { file: "03-policy-undeclared-variable.yaml", pattern: /PR_NUMBER/ },
    { file: "04-policy-dangling-hook.yaml", pattern: /nonexistent-hook/ },
    { file: "05-bad-extract-grammar.yaml", pattern: /extract expression|toolArgs/i },
    { file: "06-bad-within-duration.yaml", pattern: /duration/i },
    { file: "07-count-min-zero.yaml", pattern: /count/i },
    { file: "08-duplicate-mcp-name.yaml", pattern: /duplicate mcp/i },
    { file: "09-skills-required-not-enabled.yaml", pattern: /required.*subset.*enabled/i },
    { file: "10-memory-default-not-allowed.yaml", pattern: /default.*allowed/i },
    { file: "11-bad-blocking-enum.yaml", pattern: /blocking|invalid/i },
    { file: "12-missing-version.yaml", pattern: /version/i },
  ];

  for (const c of cases) {
    it(`rejects ${c.file}`, () => {
      const raw = loadYaml(path.join(INVALID_DIR, c.file));
      let caught: unknown;
      try {
        parseManifest(raw);
      } catch (e) {
        caught = e;
      }
      expect(caught, `expected ${c.file} to throw`).toBeDefined();
      expectIssueMatching(caught, c.pattern);
    });
  }
});

describe("parseManifest — requires shapes", () => {
  function buildPolicyManifest(requires: unknown): unknown {
    return {
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
      policies: [
        {
          name: "p",
          description: "d",
          trigger: { event: "PreToolUse" },
          requires,
          hook: "h",
          enforcement: "block",
        },
      ],
    };
  }

  it("accepts shape 1 (ledger_tag only)", () => {
    expect(() => parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}" }))).not.toThrow();
  });

  it("accepts shape 1 + within", () => {
    expect(() =>
      parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}", within: "24h" })),
    ).not.toThrow();
  });

  it("accepts shape 1 + count", () => {
    expect(() =>
      parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}", count: { min: 2 } })),
    ).not.toThrow();
  });

  it("accepts all three shapes composed together", () => {
    expect(() =>
      parseManifest(
        buildPolicyManifest({
          ledger_tag: "x:${SESSION_ID}",
          within: "PT1H",
          count: { exact: 1 },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects count.exact alongside count.min", () => {
    expect(() =>
      parseManifest(
        buildPolicyManifest({
          ledger_tag: "x:${SESSION_ID}",
          count: { min: 2, exact: 3 },
        }),
      ),
    ).toThrow(/exact.*min|count/i);
  });

  it("rejects count with no constraints declared", () => {
    expect(() =>
      parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}", count: {} })),
    ).toThrow(/count/i);
  });

  it("rejects count.min greater than count.max", () => {
    expect(() =>
      parseManifest(
        buildPolicyManifest({
          ledger_tag: "x:${SESSION_ID}",
          count: { min: 5, max: 2 },
        }),
      ),
    ).toThrow(/min.*<=.*max/i);
  });
});

describe("parseManifest — uniqueness checks", () => {
  it("rejects duplicate hook names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          { name: "h", event: "PreToolUse", command: "/bin/true", blocking: false },
          { name: "h", event: "PostToolUse", command: "/bin/true", blocking: false },
        ],
      }),
    ).toThrow(/duplicate hook/i);
  });

  it("rejects duplicate policy names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "x:${SESSION_ID}" },
            hook: "h",
            enforcement: "block",
          },
          {
            name: "p",
            description: "d2",
            trigger: { event: "PostToolUse" },
            requires: { ledger_tag: "y:${SESSION_ID}" },
            hook: "h",
            enforcement: "warn",
          },
        ],
      }),
    ).toThrow(/duplicate policy/i);
  });

  it("rejects duplicate cli tool names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        tools: {
          cli: [
            { name: "git-batch", binary: "git-batch" },
            { name: "git-batch", binary: "git-batch-other" },
          ],
        },
      }),
    ).toThrow(/duplicate cli/i);
  });
});
