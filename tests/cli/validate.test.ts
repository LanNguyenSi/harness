import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validate } from "../../src/cli/validate/index.js";
import { __testables } from "../../src/cli/validate/checks.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const EXAMPLES = path.join(REPO_ROOT, "docs", "examples");
const INVALID = path.join(EXAMPLES, "invalid");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-validate-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
};

describe("validate — schema-level diagnostics on invalid fixtures", () => {
  const cases = [
    { file: "01-unknown-version.yaml", pattern: /version/i },
    { file: "02-unknown-toplevel-key.yaml", pattern: /unrecognized|foo/i },
    { file: "03-policy-undeclared-variable.yaml", pattern: /PR_NUMBER/ },
    { file: "04-policy-dangling-hook.yaml", pattern: /nonexistent-hook/ },
    { file: "05-bad-extract-grammar.yaml", pattern: /extract|toolArgs/i },
    { file: "06-bad-within-duration.yaml", pattern: /duration/i },
    { file: "07-count-min-zero.yaml", pattern: /count/i },
    { file: "08-duplicate-mcp-name.yaml", pattern: /duplicate/i },
    { file: "09-skills-required-not-enabled.yaml", pattern: /required.*subset.*enabled/i },
    { file: "10-memory-default-not-allowed.yaml", pattern: /default.*allowed/i },
    { file: "11-bad-blocking-enum.yaml", pattern: /blocking|invalid/i },
    { file: "12-missing-version.yaml", pattern: /version/i },
  ];
  for (const c of cases) {
    it(`reports an error for ${c.file}`, () => {
      const result = validate({
        configPath: path.join(INVALID, c.file),
        ...NOOP_PROBES,
      });
      expect(result.errorCount).toBeGreaterThan(0);
      expect(
        result.diagnostics.some((d) => c.pattern.test(`${d.path}: ${d.message}`)),
      ).toBe(true);
    });
  }
});

describe("validate — happy path on a clean fixture", () => {
  function buildHappyFixture(): string {
    const home = writeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: git-preflight
    event: SessionStart
    command: ${path.join("{{HOME}}", "hooks", "git-preflight.sh")}
    blocking: false
policies: []
tools:
  builtin:
    known: [Read, Edit, Write, Bash]
`.replace("{{HOME}}", "${HOME_TOKEN}"),
      "hooks/git-preflight.sh": "#!/bin/sh\necho hi\n",
    });
    fs.chmodSync(path.join(home, "hooks", "git-preflight.sh"), 0o755);
    const manifestPath = path.join(home, "harness.yaml");
    let contents = fs.readFileSync(manifestPath, "utf8");
    contents = contents.replace("${HOME_TOKEN}", home);
    fs.writeFileSync(manifestPath, contents, "utf8");
    return home;
  }

  it("returns zero errors when every asset exists and the manifest is valid", () => {
    const home = buildHappyFixture();
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      builtinRuntimeProbe: () => ["Read", "Edit", "Write", "Bash"],
      versionProbe: () => null,
    });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });
});

describe("validate — asset checks", () => {
  it("flags a hook command pointing at a non-executable file as an error with the exact path", () => {
    const home = writeFixture({
      "hooks/no-exec.sh": "#!/bin/sh\n",
    });
    const hookPath = path.join(home, "hooks", "no-exec.sh");
    fs.chmodSync(hookPath, 0o644);
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks:
  - name: no-exec
    event: SessionStart
    command: ${hookPath}
    blocking: false
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "hooks[no-exec].command");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/not executable/);
    expect(hit?.message).toContain(hookPath);
  });

  it("flags a hook command pointing at a missing path", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks:
  - name: missing
    event: SessionStart
    command: ${path.join(home, "no-such.sh")}
    blocking: false
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.diagnostics.some((d) => /path does not exist/.test(d.message))).toBe(true);
  });

  it("flags an mcp command first-arg that does not exist on disk", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  mcp:
    - name: ghost
      command: [${path.join(home, "ghost.js")}]
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.mcp[ghost].command");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/path does not exist/);
  });

  it("emits a warning for an optional cli binary not found on PATH", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  cli:
    - name: ghost
      binary: this-binary-cannot-exist-12345
      required: false
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      pathEnv: "/nonexistent",
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.cli[ghost].binary");
    expect(hit?.severity).toBe("warning");
  });

  it("escalates a missing required cli binary to error", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  cli:
    - name: ghost
      binary: this-binary-cannot-exist-12345
      required: true
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      pathEnv: "/nonexistent",
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.cli[ghost].binary");
    expect(hit?.severity).toBe("error");
  });

  it("compares cli min_version against a probed version and errors on stale installs", () => {
    const home = writeFixture({});
    const binPath = path.join(home, "bin", "fake");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  cli:
    - name: fake
      binary: ${binPath}
      min_version: "2.0.0"
      required: true
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      versionProbe: () => "fake 1.5.3",
      builtinRuntimeProbe: () => [],
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.cli[fake].min_version");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/1\.5\.3.*2\.0\.0/);
  });

  it("emits a builtin drift warning when the runtime advertises a builtin not in the manifest", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  builtin:
    known: [Read, Edit]
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      builtinRuntimeProbe: () => ["Read", "Edit", "Write"],
      versionProbe: () => null,
    });
    const hit = result.diagnostics.find((d) => /Write/.test(d.message));
    expect(hit?.severity).toBe("warning");
  });

  it("does not warn when manifest covers more than the runtime advertises (one-sided drift check)", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  builtin:
    known: [Read, Edit, Write, Bash, Agent]
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      builtinRuntimeProbe: () => ["Read", "Edit", "Write"],
      versionProbe: () => null,
    });
    expect(result.diagnostics.filter((d) => d.path === "tools.builtin.known")).toEqual([]);
  });

  it("requires SKILL.md to exist for skills.required entries", () => {
    const home = writeFixture({
      "skills/simplify/SKILL.md": "# simplify\n",
    });
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  skills:
    enabled: [simplify, ghost]
    required: [simplify, ghost]
    source_dirs:
      - ${path.join(home, "skills")}
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.skills.required[ghost]");
    expect(hit?.severity).toBe("error");
    const ok = result.diagnostics.find((d) => d.path === "tools.skills.required[simplify]");
    expect(ok).toBeUndefined();
  });
});

describe("validate — extra coverage for asset checks", () => {
  it("emits a probe-failed warning when versionProbe returns null", () => {
    const home = writeFixture({});
    const binPath = path.join(home, "bin", "fake");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  cli:
    - name: fake
      binary: ${binPath}
      min_version: "1.0.0"
      required: true
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      versionProbe: () => null,
      builtinRuntimeProbe: () => [],
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.cli[fake].min_version");
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toMatch(/version probe failed/);
  });

  it("home-expands tilde-rooted source_dirs when locating SKILL.md", () => {
    const home = writeFixture({
      "skills/simplify/SKILL.md": "# simplify\n",
    });
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  skills:
    enabled: [simplify]
    required: [simplify]
    source_dirs:
      - ~/skills
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
  });

  it("emits a parse warning when version_command output has no version-shaped substring", () => {
    const home = writeFixture({});
    const binPath = path.join(home, "bin", "fake");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  cli:
    - name: fake
      binary: ${binPath}
      min_version: "1.0.0"
      required: true
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      versionProbe: () => "no version here",
      builtinRuntimeProbe: () => [],
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.cli[fake].min_version");
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toMatch(/could not parse/);
  });

  it("flags a hook command that resolves to a directory", () => {
    const home = writeFixture({});
    const dirPath = path.join(home, "hooks", "is-a-dir");
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks:
  - name: dir-hook
    event: SessionStart
    command: ${dirPath}
    blocking: false
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "hooks[dir-hook].command");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/not a regular file/);
  });
});

describe("validate — --strict promotes warnings to errors", () => {
  it("promotes a non-required missing cli to error under --strict", () => {
    const home = writeFixture({});
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
tools:
  cli:
    - name: optional
      binary: this-binary-cannot-exist-99999
      required: false
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      strict: true,
      pathEnv: "/nonexistent",
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "tools.cli[optional].binary");
    expect(hit?.severity).toBe("error");
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.warningCount).toBe(0);
  });
});

describe("validate — Phase 4 policy lints", () => {
  function manifestWithPolicy(opts: {
    within?: string;
    countMin?: number;
    extract?: Record<string, string>;
    ledgerTag?: string;
    withGroundingMcp?: boolean;
  }): string {
    const home = writeFixture({
      "harness.yaml": ``,
      "hooks/h.sh": "#!/bin/sh\nexit 0\n",
    });
    fs.chmodSync(path.join(home, "hooks", "h.sh"), 0o755);
    const extractBlock = opts.extract
      ? `      extract:\n${Object.entries(opts.extract)
          .map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`)
          .join("\n")}\n`
      : "";
    const withinBlock = opts.within !== undefined ? `      within: ${opts.within}\n` : "";
    const countBlock =
      opts.countMin !== undefined
        ? `      count:\n        min: ${opts.countMin}\n`
        : "";
    const ledgerTag = opts.ledgerTag ?? "review:${SESSION_ID}";
    const mcpBlock = opts.withGroundingMcp
      ? `tools:\n  mcp:\n    - name: grounding-mcp\n      command: ["/usr/bin/true"]\n`
      : "";
    const yaml = `version: 1
${mcpBlock}hooks:
  - name: h
    event: PreToolUse
    command: ${path.join(home, "hooks", "h.sh")}
    blocking: false
policies:
  - name: p
    description: test
    trigger:
      event: PreToolUse
${extractBlock}    requires:
      ledger_tag: "${ledgerTag}"
${withinBlock}${countBlock}    hook: h
    enforcement: block
`;
    fs.writeFileSync(path.join(home, "harness.yaml"), yaml, "utf8");
    return home;
  }

  it("rejects within: yesterday with the invalid-duration message", () => {
    const home = manifestWithPolicy({ within: "yesterday" });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBeGreaterThan(0);
    expect(
      result.diagnostics.some((d) =>
        /invalid duration "yesterday"/.test(`${d.path}: ${d.message}`),
      ),
    ).toBe(true);
  });

  it.each(["24h", "PT1H", "86400s"])("accepts within: %s", (val) => {
    const home = manifestWithPolicy({ within: val, withGroundingMcp: true });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
  });

  it("rejects count.min: 0 with the no-op message", () => {
    const home = manifestWithPolicy({ countMin: 0 });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBeGreaterThan(0);
    expect(
      result.diagnostics.some((d) =>
        /count\.min: 0 is a no-op/.test(d.message),
      ),
    ).toBe(true);
  });

  it("warns (does not error) when policies declared but grounding-mcp is missing", () => {
    const home = manifestWithPolicy({ withGroundingMcp: false });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /grounding-mcp not wired/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policies");
  });

  it("does not warn when grounding-mcp is wired", () => {
    const home = manifestWithPolicy({ withGroundingMcp: true });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.some((d) => /grounding-mcp not wired/.test(d.message)),
    ).toBe(false);
  });

  it("rejects an extract expression that uses a function call", () => {
    const home = manifestWithPolicy({
      extract: { FOO: "toolArgs.foo()" },
      ledgerTag: "x:${FOO}",
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBeGreaterThan(0);
    expect(
      result.diagnostics.some((d) => /function calls not allowed/.test(d.message)),
    ).toBe(true);
  });

  it("rejects ${UNDECLARED} variable references in ledger_tag", () => {
    const home = manifestWithPolicy({
      ledgerTag: "review:${PR_NUMBER}",
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBeGreaterThan(0);
    expect(
      result.diagnostics.some((d) =>
        /no matching trigger\.extract entry was declared/.test(d.message),
      ),
    ).toBe(true);
  });

  it("accepts a manifest with policies + grounding-mcp + a valid extract", () => {
    const home = manifestWithPolicy({
      withGroundingMcp: true,
      extract: { PR_NUMBER: "toolArgs.prNumber" },
      ledgerTag: "review:${PR_NUMBER}",
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
  });
});

describe("validate — internal helpers", () => {
  it("compareVersions handles dotted numeric versions", () => {
    expect(__testables.compareVersions("1.2.3", "1.2.0")).toBe(1);
    expect(__testables.compareVersions("1.2.0", "1.2.3")).toBe(-1);
    expect(__testables.compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(__testables.compareVersions("0.10.0", "0.2.0")).toBe(1);
  });

  it("expandHome resolves ~ and ~/ prefixes", () => {
    expect(__testables.expandHome("~", "/home/x")).toBe("/home/x");
    expect(__testables.expandHome("~/foo/bar", "/home/x")).toBe("/home/x/foo/bar");
    expect(__testables.expandHome("/abs/path", "/home/x")).toBe("/abs/path");
    expect(__testables.expandHome("relative/x", "/home/x")).toBe("relative/x");
  });

  it("isRootedPath recognises absolute and tilde-rooted paths", () => {
    expect(__testables.isRootedPath("/abs")).toBe(true);
    expect(__testables.isRootedPath("~")).toBe(true);
    expect(__testables.isRootedPath("~/x")).toBe(true);
    expect(__testables.isRootedPath("npx")).toBe(false);
    expect(__testables.isRootedPath("./relative")).toBe(false);
  });
});
