import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { exportManifest, __testables } from "../../src/cli/export.js";
import { parseManifest } from "../../src/schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-export-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("exportManifest — happy path", () => {
  it("emits YAML whose parseManifest round-trip matches the post-merge form", () => {
    const r = exportManifest({ configPath: FULL_MANIFEST });
    expect(r.wroteTo).toBeNull();
    expect(r.sanitized).toBe(false);
    const parsed = parseManifest(parseYaml(r.output));
    expect(parsed).toEqual(r.manifest);
  });

  it("--json emits JSON parseable by JSON.parse", () => {
    const r = exportManifest({ configPath: FULL_MANIFEST, json: true });
    const parsed = JSON.parse(r.output);
    expect(parsed.version).toBe(1);
    expect(parsed.tools.mcp).toBeInstanceOf(Array);
  });
});

describe("exportManifest — --sanitize", () => {
  it("redacts env values whose key looks credential-shaped", () => {
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  mcp:",
        "    - name: x",
        "      command: /usr/bin/true",
        "      env:",
        "        OPENAI_API_KEY: sk-real-secret",
        "        SLACK_TOKEN: xoxb-real",
        "        LOG_LEVEL: debug",
        "      health:",
        "        verb: ok",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.sanitized).toBe(true);
    expect(r.output).toContain("OPENAI_API_KEY: <REDACTED>");
    expect(r.output).toContain("SLACK_TOKEN: <REDACTED>");
    expect(r.output).toContain("LOG_LEVEL: debug");
    expect(r.output).toContain("# sanitised:");
  });

  it("does not redact harmless env keys (LOG_LEVEL, AGENT_TASKS_URL)", () => {
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  mcp:",
        "    - name: tasks",
        "      command: /usr/bin/true",
        "      env:",
        "        AGENT_TASKS_URL: https://example.com",
        "        LOG_LEVEL: info",
        "      health: { verb: ok }",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.output).toContain("AGENT_TASKS_URL: https://example.com");
    expect(r.output).toContain("LOG_LEVEL: info");
    expect(r.output).not.toContain("<REDACTED>");
  });

  it("does not redact env values whose values were never written (sanitiser is key-based)", () => {
    // value of LOG_LEVEL = "secret-looking-but-key-is-clean" stays.
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  mcp:",
        "    - name: x",
        "      command: /usr/bin/true",
        "      env:",
        "        LOG_LEVEL: aws_secret_1234",
        "      health: { verb: ok }",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.output).toContain("LOG_LEVEL: aws_secret_1234");
  });

  it("rewrites /home/<user>/... to ~/...", () => {
    const homeDir = os.homedir();
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      [
        "version: 1",
        "tools:",
        "  cli:",
        `    - name: foo`,
        `      binary: ${homeDir}/bin/foo`,
        "",
      ].join("\n"),
    );
    const r = exportManifest({ configPath: fixture, sanitize: true });
    expect(r.output).toContain("binary: ~/bin/foo");
    expect(r.output).not.toContain(homeDir);
  });
});

describe("exportManifest — -o <file>", () => {
  it("writes to the file atomically and exits with empty stdout output is ignored when wroteTo is set", () => {
    const target = path.join(tmpDir, "exported.yaml");
    const r = exportManifest({ configPath: FULL_MANIFEST, outputPath: target });
    expect(r.wroteTo).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    const parsed = parseManifest(parseYaml(fs.readFileSync(target, "utf8")));
    expect(parsed.version).toBe(1);
  });

  it("creates the parent directory if missing (atomicWriteFile contract)", () => {
    const target = path.join(tmpDir, "nested/sub/exported.yaml");
    exportManifest({ configPath: FULL_MANIFEST, outputPath: target });
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("sanitize — pure helpers", () => {
  it("isInsideEnvBlock matches only the immediate-parent env case", () => {
    expect(__testables.isInsideEnvBlock(["tools", "mcp", 0, "env"])).toBe(true);
    expect(__testables.isInsideEnvBlock(["tools", "env", "name"])).toBe(false);
    expect(__testables.isInsideEnvBlock([])).toBe(false);
  });

  it("rewriteHomePath is a no-op when homeDir is empty or root", () => {
    expect(__testables.rewriteHomePath("/foo", "")).toBe("/foo");
    expect(__testables.rewriteHomePath("/foo", "/")).toBe("/foo");
  });

  it("rewriteHomePath does not partial-match a longer username (homedir prefix collision)", () => {
    expect(__testables.rewriteHomePath("/home/landscape/project/x.ts", "/home/lan")).toBe(
      "/home/landscape/project/x.ts",
    );
    // exact match and trailing-slash forms still rewrite
    expect(__testables.rewriteHomePath("/home/lan/x", "/home/lan")).toBe("~/x");
    expect(__testables.rewriteHomePath("/home/lan", "/home/lan")).toBe("~");
  });

  it("SECRET_KEY_PATTERN matches the documented suffixes only", () => {
    const re = __testables.SECRET_KEY_PATTERN;
    expect(re.test("OPENAI_API_KEY")).toBe(true);
    expect(re.test("SLACK_TOKEN")).toBe(true);
    expect(re.test("MY_SECRET")).toBe(true);
    expect(re.test("DB_PASSWORD")).toBe(true);
    expect(re.test("KEY")).toBe(true);
    expect(re.test("LOG_LEVEL")).toBe(false);
    expect(re.test("AGENT_TASKS_URL")).toBe(false);
  });
});

// F7 (review round 2, 99f47307 Slice 1): `harness export` loads via
// `loadManifest`, which folds `workflows[]`-derived policies into
// `manifest.policies` (F2). Exporting them verbatim would round-trip a
// COMPUTED policy back in as though the operator hand-authored it under
// `policies:` — the next `harness apply` would then see it as a
// hand-authored (and, under F1, at-least-as-strong) policy that dedupes
// against the derivation, masking provenance. `exportManifest` filters
// them back out via `isDerivedPolicy`.
describe("exportManifest — workflows[]-derived policies are excluded (F7)", () => {
  const WORKFLOW_REQUIRED = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
`;

  const WIRED_HOOKS = `hooks:
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
`;

  // Mutation probe M5 (this round): removing the `isDerivedPolicy` filter
  // from `exportManifest` (src/cli/export.ts) turns this test red — the
  // two `workflow:ship:review-before-merge[-bash]` policy names would
  // reappear in `r.output`/`r.manifest.policies`.
  it("does not include workflow:<name>:review-before-merge[-bash] in the exported output", () => {
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(fixture, `version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}`, "utf8");
    const r = exportManifest({ configPath: fixture, json: true });
    expect(r.output).not.toContain("workflow:ship:review-before-merge");
    const parsed = JSON.parse(r.output) as { policies: Array<{ name: string }> };
    expect(parsed.policies.find((p) => p.name.startsWith("workflow:"))).toBeUndefined();
    // r.manifest must match what was actually emitted (existing
    // round-trip contract, "happy path" describe block above) — the
    // filtered view, not the loaded-with-derived-policies one.
    expect(r.manifest.policies.find((p) => p.name.startsWith("workflow:"))).toBeUndefined();
  });

  it("still includes a hand-authored policy sharing the same surface (round-1 dedupe case)", () => {
    const handPolicy = `policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block
`;
    const fixture = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(
      fixture,
      `version: 1\n${WORKFLOW_REQUIRED}${handPolicy}${WIRED_HOOKS}`,
      "utf8",
    );
    const r = exportManifest({ configPath: fixture, json: true });
    const parsed = JSON.parse(r.output) as { policies: Array<{ name: string }> };
    expect(parsed.policies.find((p) => p.name === "review-before-merge")).toBeDefined();
  });
});
