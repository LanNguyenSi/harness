import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { validate } from "../../src/cli/validate/index.js";
import { __testables } from "../../src/cli/validate/checks.js";
import { writeLock, type LockEntry } from "../../src/io/harness-lock.js";
import * as crypto from "node:crypto";

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

describe("validate: --check-lock", () => {
  // Helper builds a minimal valid manifest + a single locked hook script,
  // then writes harness.lock with the script's actual sha256. The caller
  // can then mutate the file or skip the lock entirely to drive each branch.
  function buildLockedFixture(): { home: string; hookPath: string; lockPath: string } {
    const home = writeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: locked
    event: SessionStart
    command: ${path.join("{{HOME}}", "hooks", "locked.sh")}
    blocking: false
policies: []
tools:
  builtin:
    known: [Read]
`.replace("{{HOME}}", "${HOME_TOKEN}"),
      "hooks/locked.sh": "#!/bin/sh\necho locked\n",
    });
    fs.chmodSync(path.join(home, "hooks", "locked.sh"), 0o755);
    const manifestPath = path.join(home, "harness.yaml");
    fs.writeFileSync(
      manifestPath,
      fs.readFileSync(manifestPath, "utf8").replace("${HOME_TOKEN}", home),
      "utf8",
    );
    const hookPath = path.join(home, "hooks", "locked.sh");
    return { home, hookPath, lockPath: path.join(home, "harness.lock") };
  }

  function writeLockFor(lockPath: string, hookPath: string, sha: string): void {
    const entries: LockEntry[] = [{ kind: "asset", path: hookPath, sha256: sha }];
    writeLock(lockPath, entries);
  }

  function sha256OfFile(p: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  }

  it("emits an info-warning when the lock file is absent", () => {
    const { home } = buildLockedFixture();
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      checkLock: true,
      ...NOOP_PROBES,
    });
    expect(result.warningCount).toBe(1);
    expect(result.diagnostics.some((d) => /no lock file/i.test(d.message))).toBe(true);
  });

  it("emits zero diagnostics when the lock matches the on-disk content", () => {
    const { home, hookPath, lockPath } = buildLockedFixture();
    writeLockFor(lockPath, hookPath, sha256OfFile(hookPath));
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      checkLock: true,
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("warns when a locked file's content has drifted on disk", () => {
    const { home, hookPath, lockPath } = buildLockedFixture();
    const originalSha = sha256OfFile(hookPath);
    writeLockFor(lockPath, hookPath, originalSha);
    fs.writeFileSync(hookPath, "#!/bin/sh\necho TAMPERED\n", "utf8");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      checkLock: true,
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(1);
    expect(result.diagnostics.some((d) => /asset modified/i.test(d.message))).toBe(true);
  });

  it("with --strict --check-lock, drift is promoted to an error", () => {
    const { home, hookPath, lockPath } = buildLockedFixture();
    writeLockFor(lockPath, hookPath, sha256OfFile(hookPath));
    fs.writeFileSync(hookPath, "#!/bin/sh\necho changed\n", "utf8");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      checkLock: true,
      strict: true,
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.some((d) => /asset modified/i.test(d.message))).toBe(true);
  });

  it("without --check-lock, validate ignores the lock file entirely", () => {
    const { home, hookPath, lockPath } = buildLockedFixture();
    writeLockFor(lockPath, hookPath, sha256OfFile(hookPath));
    fs.writeFileSync(hookPath, "#!/bin/sh\necho TAMPERED\n", "utf8");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.warningCount).toBe(0);
  });
});

describe("validate — policy_packs (Phase 6 #2)", () => {
  function fixtureWithPacks(packs: unknown): string {
    const yaml = `version: 1\npolicy_packs: ${JSON.stringify(packs)}\n`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("clean fixture: a known-builtin enabled pack produces no policy_packs diagnostics", () => {
    const home = fixtureWithPacks([{ name: "understanding-before-execution" }]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const packDiags = result.diagnostics.filter((d) => d.path.startsWith("policy_packs["));
    expect(packDiags).toEqual([]);
  });

  it("rejects an enabled pack with an unknown source", () => {
    const home = fixtureWithPacks([
      { name: "understanding-before-execution", source: "path:./somewhere" },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const sourceError = result.diagnostics.find(
      (d) => d.path === "policy_packs[0].source" && d.severity === "error",
    );
    expect(sourceError).toBeDefined();
    expect(sourceError?.message).toMatch(/only "builtin" resolves/);
  });

  it("rejects an enabled pack with an unknown builtin name", () => {
    const home = fixtureWithPacks([{ name: "no-such-pack" }]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const nameError = result.diagnostics.find(
      (d) => d.path === "policy_packs[0].name" && d.severity === "error",
    );
    expect(nameError).toBeDefined();
    expect(nameError?.message).toMatch(/not a known builtin pack/);
  });

  it("does not flag an enabled:false pack with a bogus source or name", () => {
    const home = fixtureWithPacks([
      { name: "no-such-pack", source: "git:https://x.git", enabled: false },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const packDiags = result.diagnostics.filter((d) => d.path.startsWith("policy_packs["));
    expect(packDiags).toEqual([]);
  });

  // Per-pack config schema validation (task d78fb3c7). Validate runs each
  // builtin pack's registered `configSchema` and turns rejections into
  // Diagnostics. The shared helper in `src/policy-packs/config-check.ts`
  // has its own unit tests; this section is the validate-CLI contract:
  // are the diagnostics surfaced with the right `path` and severity?

  it("rejects a typo'd `mode` value on understanding-before-execution", () => {
    const home = fixtureWithPacks([
      { name: "understanding-before-execution", config: { mode: "fastConfirm" } },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const modeError = result.diagnostics.find(
      (d) =>
        d.path === "policy_packs[0].config.mode" && d.severity === "error",
    );
    expect(modeError).toBeDefined();
  });

  it("rejects a typo'd config key (strict mode)", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        config: { permision_profile: "safe-start" },
      },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const error = result.diagnostics.find(
      (d) =>
        d.path === "policy_packs[0].config" &&
        d.severity === "error" &&
        /permision_profile/.test(d.message),
    );
    expect(error).toBeDefined();
  });

  it("missing config keys are silent (no diagnostic)", () => {
    const home = fixtureWithPacks([{ name: "understanding-before-execution" }]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const configDiags = result.diagnostics.filter((d) =>
      d.path.startsWith("policy_packs[0].config"),
    );
    expect(configDiags).toEqual([]);
  });

  it("emits both source and config diagnostics in one run", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        config: { mode: "fastConfirm" },
      },
      { name: "no-such-pack" },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const configError = result.diagnostics.find(
      (d) => d.path === "policy_packs[0].config.mode" && d.severity === "error",
    );
    const sourceError = result.diagnostics.find(
      (d) => d.path === "policy_packs[1].name" && d.severity === "error",
    );
    expect(configError).toBeDefined();
    expect(sourceError).toBeDefined();
  });
});

describe("validate — checkSolutionAcceptanceProducer", () => {
  function fixtureWithSolutionAcceptance(opts: {
    withGroundingMcp: boolean;
    verdictDirOverride?: string;
  }): string {
    let mcpBlock = "";
    if (opts.withGroundingMcp) {
      const envBlock = opts.verdictDirOverride
        ? `\n      env:\n        SOLUTION_VERDICT_DIR: "${opts.verdictDirOverride}"`
        : "";
      mcpBlock = `tools:\n  mcp:\n    - name: grounding-mcp\n      command: ["/usr/bin/true"]${envBlock}\n`;
    }
    const yaml = `version: 1\n${mcpBlock}policy_packs:\n  - name: solution-acceptance\n    source: builtin\n    enabled: true\n`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("errors (condition #1) when solution-acceptance enabled but grounding-mcp absent", () => {
    const home = fixtureWithSolutionAcceptance({ withGroundingMcp: false });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(1);
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "error" &&
        /grounding-mcp is not wired/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policy_packs");
  });

  it("emits no warning when grounding-mcp is wired with no SOLUTION_VERDICT_DIR override", () => {
    const home = fixtureWithSolutionAcceptance({ withGroundingMcp: true });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const solutionWarning = result.diagnostics.find(
      (d) =>
        /SOLUTION_VERDICT_DIR|gate would always deny|verdict.*dir/i.test(d.message),
    );
    expect(solutionWarning).toBeUndefined();
  });

  it("emits NO warning when grounding-mcp has a non-default SOLUTION_VERDICT_DIR (apply now projects it)", () => {
    const home = fixtureWithSolutionAcceptance({
      withGroundingMcp: true,
      verdictDirOverride: "/custom/verdict/dir",
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const splitDirWarning = result.diagnostics.find(
      (d) =>
        /SOLUTION_VERDICT_DIR|gate would always deny|verdict.*dir/i.test(d.message),
    );
    expect(splitDirWarning).toBeUndefined();
  });

  it("warns when grounding-mcp has a RELATIVE SOLUTION_VERDICT_DIR (projection cannot reconcile cwd)", () => {
    const home = fixtureWithSolutionAcceptance({
      withGroundingMcp: true,
      verdictDirOverride: "relative/verdict/dir",
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" && /relative SOLUTION_VERDICT_DIR/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("tools.mcp");
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

describe("validate — M7 checkPolicyRiskWithoutEnvScope", () => {
  // Helper builds a minimal harness.yaml with a single policy whose `when:`
  // block is controlled by the caller. All fixtures share the same hook
  // to satisfy the dangling-hook check.
  function buildRiskScopeFixture(whenBlock: string): string {
    const yaml = `version: 1
hooks:
  - name: risk-gate
    event: PreToolUse
    command: /bin/true
    blocking: false
policies:
  - name: gate-test
    description: test policy
    trigger:
      event: PreToolUse
      match: Bash
${whenBlock}    requires:
      ledger_tag: "risk-approved:\${SESSION_ID}"
    hook: risk-gate
    enforcement: block
`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("warns when a policy has risk.severity_at_least with no environment.name scope", () => {
    // Mutation guard: remove the checkPolicyRiskWithoutEnvScope call from
    // runAssetChecks (or the function body) and this test goes red.
    const home = buildRiskScopeFixture("    when:\n      risk.severity_at_least: high\n");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /fail-closed.*unclassified|unclassified.*environment\.name/i.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policies[0]");
    expect(hit?.message).toContain("environment.name");
    expect(hit?.message).toContain("docs/risk-gate.md");
  });

  it("warns when a policy has risk.category_in with no environment.name scope", () => {
    const home = buildRiskScopeFixture(
      "    when:\n      risk.category_in: [destructive]\n",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /environment\.name/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policies[0]");
  });

  it("warns when a policy has action.reversible with no environment.name scope", () => {
    const home = buildRiskScopeFixture(
      "    when:\n      action.reversible: false\n",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /environment\.name/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policies[0]");
  });

  it("does NOT warn when risk.severity_at_least is paired with environment.name (negative control)", () => {
    // Mutation guard: remove the `hasEnvNameScope` guard from
    // checkPolicyRiskWithoutEnvScope and this test goes red (the warning
    // would fire even when environment.name is present).
    const home = buildRiskScopeFixture(
      "    when:\n      risk.severity_at_least: high\n      environment.name: production\n",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /environment\.name/.test(d.message) &&
        /fail-closed|unclassified/.test(d.message),
    );
    expect(hit).toBeUndefined();
  });

  it("does NOT warn when the when: block contains only environment.name (no risk clause)", () => {
    // environment.name alone never triggers the unclassified fallback.
    const home = buildRiskScopeFixture(
      "    when:\n      environment.name: production\n",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /fail-closed|unclassified/.test(d.message),
    );
    expect(hit).toBeUndefined();
  });

  it("does NOT warn for a policy with no when: block at all", () => {
    // A Phase-4 policy with no when: has no risk clauses to lint.
    const home = writeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: h
    event: PreToolUse
    command: /bin/true
    blocking: false
policies:
  - name: plain-policy
    description: test
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "review:\${SESSION_ID}"
    hook: h
    enforcement: block
`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /fail-closed|unclassified/.test(d.message),
    );
    expect(hit).toBeUndefined();
  });
});

describe("validate — --json", () => {
  it("registers the --json flag on the validate command", () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === "validate");
    expect(cmd?.options.map((o) => o.long)).toContain("--json");
  });

  it("emits a parseable JSON report with diagnostics + counts on stdout", async () => {
    const home = writeFixture({ "harness.yaml": "version: 1\n" });
    let out = "";
    let err = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    });
    await program.parseAsync(
      ["validate", "--config", path.join(home, "harness.yaml"), "--json"],
      { from: "user" },
    );
    const parsed = JSON.parse(out) as {
      diagnostics: unknown[];
      errorCount: number;
      warningCount: number;
    };
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
    expect(parsed.errorCount).toBe(0);
    expect(typeof parsed.warningCount).toBe("number");
    // No prose mixed into the machine-readable stream.
    expect(out.trim().startsWith("{")).toBe(true);
    expect(err).toBe("");
  });
});
