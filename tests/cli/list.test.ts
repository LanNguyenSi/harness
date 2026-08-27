import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { list } from "../../src/cli/list.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

describe("list — categories", () => {
  it("lists mcp servers from the reference manifest", () => {
    const r = list("mcp", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual([
      "codebase-oracle",
      "agent-tasks",
      "grounding-mcp",
    ]);
    expect(r.output).toMatch(/^name/);
  });

  it("lists cli tools", () => {
    const r = list("cli", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual(["git-batch", "gh", "ledger"]);
  });

  it("lists skills with required flag", () => {
    const r = list("skills", { configPath: FULL_MANIFEST });
    expect(r.rows).toEqual([
      { name: "simplify", required: false },
      { name: "init", required: false },
      { name: "review", required: false },
      { name: "security-review", required: false },
    ]);
  });

  it("lists hook entries", () => {
    const r = list("hooks", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual([
      "git-preflight",
      "require-review-evidence",
      "require-review-evidence-bash",
      "require-dogfood-evidence",
      "require-preflight-evidence",
      "require-review-subagent-evidence",
      "require-review-subagent-evidence-bash",
      "require-preflight-push-evidence",
      "deny-kill-switch-bash",
      "deny-session-env-strip-bash",
      "deny-sentinel-write-bash",
      "risk-gate",
    ]);
    const head = r.rows[0]!;
    expect(head.event).toBe("SessionStart");
    expect(head.blocking).toBe("false");
  });

  it("lists policies", () => {
    const r = list("policies", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual([
      "review-before-merge",
      "review-before-merge-bash",
      "dogfood-before-release",
      "two-reviewers-required",
      "preflight-before-investigation",
      "review-subagent-before-pr-create",
      "review-subagent-before-pr-create-bash",
      "preflight-before-push",
      "gate-prod-destructive",
      "gate-prod-destructive-approval",
      "gate-dev-unsafe-deletion",
      "deny-kill-switch-bypass",
      "deny-session-env-strip",
      "deny-pause-sentinel-forgery",
    ]);
    expect(r.rows[0]!.enforcement).toBe("block");
    // F7 (review round 2, 99f47307 Slice 1): every policy in this fixture
    // is hand-authored under `policies:` (its `workflows:` entries dedupe
    // against them, round-1 behaviour, see workflow-policies.test.ts), so
    // none of these rows carries the "(derived from workflows[])" marker.
    for (const row of r.rows) {
      expect(row.provenance).toBe("");
    }
  });

  it("marks a workflows[]-derived policy with the provenance marker (F7)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-list-derived-"));
    try {
      const manifestPath = path.join(home, "harness.yaml");
      fs.writeFileSync(
        manifestPath,
        `version: 1
review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
policies: []
`,
        "utf8",
      );
      const r = list("policies", { configPath: manifestPath });
      const derived = r.rows.find((row) => row.name === "workflow:ship:review-before-merge");
      expect(derived).toBeDefined();
      expect(derived?.provenance).toBe("(derived from workflows[])");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("lists memory directories", () => {
    const r = list("memories", { configPath: FULL_MANIFEST });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]).toHaveProperty("path");
    expect(r.rows[0]).toHaveProperty("scope");
  });
});

describe("list — --filter", () => {
  it("returns only entries whose name contains the filter substring (case-insensitive)", () => {
    const r = list("mcp", { configPath: FULL_MANIFEST, filter: "ORACLE" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.name).toBe("codebase-oracle");
  });

  it("returns empty when filter matches nothing", () => {
    const r = list("policies", { configPath: FULL_MANIFEST, filter: "nope" });
    expect(r.rows).toHaveLength(0);
    expect(r.output).toMatch(/no entries|^\[\]/);
  });
});

describe("list — --json", () => {
  it("emits a parseable JSON array with no leading prose", () => {
    const r = list("policies", { configPath: FULL_MANIFEST, json: true });
    const trimmed = r.output.trim();
    expect(trimmed.startsWith("[")).toBe(true);
    const parsed = JSON.parse(trimmed);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("enforcement");
  });
});
