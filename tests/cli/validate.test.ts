import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { validate } from "../../src/cli/validate/index.js";
import {
  __testables,
  checkPolicySelfAttestation,
  checkWorkflowGateWiring,
  createDefaultGitIgnoreProbe,
} from "../../src/cli/validate/checks.js";
import { spawnSync } from "node:child_process";
import { writeLock, type LockEntry } from "../../src/io/harness-lock.js";
import * as crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";
import {
  REVIEW_EVIDENCE_HOOK_BASH as REVIEW_EVIDENCE_HOOK_BASH_NAME,
  REVIEW_EVIDENCE_HOOK_MCP as REVIEW_EVIDENCE_HOOK_MCP_NAME,
} from "../../src/runtime/workflow-policies.js";

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
  // "cannot tell" — keeps unrelated tests hermetic: the knob-ignored check
  // skips instead of probing the developer's real cwd with git.
  gitIgnoreProbe: () => null,
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

describe("validate: checkWorkflowGateWiring (99f47307 Slice 1, AC4)", () => {
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

  // The two task-scoped merge-surface hooks (task 2699b476). A manifest
  // wiring ONLY `WIRED_HOOKS` above still enforces `pull_requests_merge` /
  // `gh pr merge`, but leaves `task_merge` / `task_finish (autoMerge)`
  // completely uncovered (review round 1, task 2699b476 round 2).
  const TASK_VERB_HOOKS = `  - name: require-review-evidence-task-merge
    event: PreToolUse
    match: "mcp__agent-tasks__task_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-task-finish
    event: PreToolUse
    match: "mcp__agent-tasks__task_finish"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;

  it("errors when spawn: required precedes a merge step but neither evidence hook is declared", () => {
    const home = writeFixture({ "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}hooks: []\n` });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship".*not wired/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("workflows");
    expect(hit?.message).toContain(REVIEW_EVIDENCE_HOOK_MCP_NAME);
    expect(hit?.message).toContain(REVIEW_EVIDENCE_HOOK_BASH_NAME);
  });

  it("errors when only ONE of the two evidence hooks is declared", () => {
    const partialHook = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${partialHook}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship".*not wired/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toContain(REVIEW_EVIDENCE_HOOK_BASH_NAME);
  });

  it("emits no ERROR diagnostic when both evidence hooks are declared", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const errorHit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship"/.test(d.message),
    );
    expect(errorHit).toBeUndefined();
  });

  // MEDIUM security (review round 1, task 2699b476 round 2): the original
  // pair alone (`WIRED_HOOKS`) still leaves `task_merge` and `task_finish
  // (autoMerge: true)` uncovered: a PR can merge through either verb with
  // no recorded review, and `validate` said nothing about it. This pins
  // the new `warning` naming both uncovered verbs and both missing hook
  // names.
  it("warns naming both task verbs when only the original evidence pair is declared", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && /workflow "ship"/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("workflows");
    expect(hit?.message).toContain("mcp__agent-tasks__task_merge");
    expect(hit?.message).toContain("mcp__agent-tasks__task_finish");
    expect(hit?.message).toContain("require-review-evidence-task-merge");
    expect(hit?.message).toContain("require-review-evidence-task-finish");
  });

  it("does not warn about the task verbs once all four evidence hooks are declared", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}${TASK_VERB_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => /workflow "ship"/.test(d.message));
    expect(hit).toBeUndefined();
  });

  // Pure-function pin (mutation-probe friendly, mirrors the M4 pattern
  // above): with the original pair wired and the task-verb hooks absent,
  // `checkWorkflowGateWiring` itself returns EXACTLY one diagnostic, the
  // new warning, independent of the aggregator/validate wiring.
  it("the pure check function returns exactly the one warning when only the original pair is wired", () => {
    const manifest = parseManifest(parseYaml(`version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}`));
    const diags = checkWorkflowGateWiring(manifest);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("warning");
    expect(diags[0]?.message).toContain("mcp__agent-tasks__task_merge");
    expect(diags[0]?.message).toContain("mcp__agent-tasks__task_finish");
  });

  it("emits no diagnostic when the review step is spawn: optional (no gate needed)", () => {
    const yaml = `version: 1\nreview_templates: {}\nworkflows:\n  - name: ship\n    steps:\n      - kind: branch\n      - kind: review_subagent\n        spawn: optional\n      - kind: merge\nhooks: []\n`;
    const home = writeFixture({ "harness.yaml": yaml });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => /workflow "ship"/.test(d.message));
    expect(hit).toBeUndefined();
  });

  // Mutation probe M4 (removing checkWorkflowGateWiring's registration from
  // runAssetChecks): calling the pure check function directly still finds
  // the error even if the aggregator stops wiring it in, so this test
  // discriminates "the check itself is broken" from "the check is no
  // longer registered", the latter would leave THIS assertion green while
  // the fixture-based ones above go red.
  it("the pure check function itself reports the same error independent of aggregator wiring", () => {
    const manifest = parseManifest(parseYaml(`version: 1\n${WORKFLOW_REQUIRED}hooks: []\n`));
    const diags = checkWorkflowGateWiring(manifest);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.path).toBe("workflows");
  });

  // F5 (review round 2): a hook declared under the RIGHT name but wired
  // to a surface that does not actually intercept the merge tool call
  // (here: a `match` that no longer names the merge verb) is just as
  // unenforced as a missing hook. The round-1 check only tested hook
  // NAME presence, so this fixture used to validate cleanly.
  //
  // Mutation probe (this round): removing the `isMergeGateHookProperlyWired`
  // condition from `checkWorkflowGateWiring` (falling back to name-only
  // presence) turns this test green-for-the-wrong-reason into failing —
  // it asserts an error IS present, so a mutant that stops checking the
  // trigger surface drops this diagnostic and the test goes red.
  it("errors when a hook carries the right name but the wrong match surface", () => {
    const wrongSurfaceHooks = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__some_other_tool"
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
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${wrongSurfaceHooks}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship".*not wired/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("not wired to intercept the merge gate surface");
    expect(hit?.message).toContain(REVIEW_EVIDENCE_HOOK_MCP_NAME);
  });

  // Same shape, but the surface is right and the COMMAND is wrong (not
  // `harness policy intercept` at all) — the exact "right name, wrong
  // command" case F5's brief names.
  it("errors when a hook carries the right name and surface but a command that isn't the policy-intercept engine", () => {
    const wrongCommandHooks = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: echo noop
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
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${wrongCommandHooks}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship".*not wired/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("not wired to intercept the merge gate surface");
  });
});

// F2 (review round 2, 99f47307 Slice 1): `apply` (via `loadManifest`) and
// `validate` (via `loadMergedRaw` + `parseManifest`) used to see DIFFERENT
// effective policy sets for the identical on-disk manifest — a workflow
// requiring the merge gate, with both evidence hooks wired but no
// hand-authored policies and no grounding-mcp, validated with "0 errors"
// while `apply --dry-run` refused ("policies declared but grounding-mcp
// not wired"). `validate` now folds workflows[]-derived policies in via
// `withDerivedPolicies` (same function `loadManifest` uses) BEFORE
// running the asset checks, so `checkPolicyGroundingMcp` sees them too.
//
// Mutation probe M2 (this round): removing the `withDerivedPolicies` call
// from `src/cli/validate/index.ts` (reverting to the bare `parseManifest`
// result) turns this test red — `manifest.policies` goes back to empty,
// `checkPolicyGroundingMcp` short-circuits on `policies.length === 0`, and
// the grounding-mcp warning disappears.
describe("validate: workflows[]-derived policies participate in checkPolicyGroundingMcp (F2, review round 2)", () => {
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

  it("validate warns 'grounding-mcp not wired' for a manifest whose ONLY policies are workflow-derived", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}policies: []\n`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && d.message.includes("grounding-mcp not wired"),
    );
    expect(hit).toBeDefined();
  });

  it("no grounding-mcp warning when the workflow does not require a merge gate (no policies at all, derived or not)", () => {
    const optionalWorkflow = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: optional
        template: t1
      - kind: merge
`;
    const home = writeFixture({
      "harness.yaml": `version: 1\n${optionalWorkflow}${WIRED_HOOKS}policies: []\n`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && d.message.includes("grounding-mcp not wired"),
    );
    expect(hit).toBeUndefined();
  });
});

// F1 (review round 2): a hand-authored policy sharing a derived gate's
// trigger surface + ledger_tag but weaker than it (enforcement: warn, or
// when:-scoped) no longer suppresses the derived block gate, but the
// overlap is worth flagging so an operator does not mistake the weaker
// policy for the only gate on the surface.
describe("validate: checkWorkflowGateWeakOverlap (F1, review round 2)", () => {
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

  const WEAK_OVERLAP_POLICY = `policies:
  - name: two-reviewers-required
    description: Warn-level companion sharing review-before-merge's exact surface + tag.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
      count:
        min: 2
    hook: require-review-evidence
    enforcement: warn
`;

  it("warns when a weaker hand policy shares the derived gate's surface", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${WEAK_OVERLAP_POLICY}${WIRED_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        /derives a block gate on/.test(d.message) &&
        d.message.includes("two-reviewers-required"),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("enforcement: warn");
    // The derived block gate itself is still there (F1's whole point):
    // no error diagnostic for this workflow, since the gate IS enforced.
    const errorHit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship"/.test(d.message),
    );
    expect(errorHit).toBeUndefined();
  });

  it("no weak-overlap warning when the hand policy is at least as strong (round-1 dedupe case)", () => {
    const strongPolicy = `policies:
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
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${strongPolicy}${WIRED_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => /derives a block gate on/.test(d.message));
    expect(hit).toBeUndefined();
  });
});

// F6 (review round 2): a workflow with BOTH a merge step and a required
// review_subagent step, but the review comes AFTER the merge — no gate is
// derived (workflowRequiresMergeGate only looks for review-then-merge),
// and previously nothing said so. Warn instead of silently doing nothing.
describe("validate: checkWorkflowMergeBeforeReview (F6, review round 2)", () => {
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

  it("warns when a required review step comes AFTER the merge step", () => {
    const reversedWorkflow = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: merge
      - kind: review_subagent
        spawn: required
        template: t1
`;
    const home = writeFixture({
      "harness.yaml": `version: 1\n${reversedWorkflow}${WIRED_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && /declares a required review step after its merge step/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("workflows");
    // No gate is derived for this ordering, so no error either.
    const errorHit = result.diagnostics.find(
      (d) => d.severity === "error" && /workflow "ship"/.test(d.message),
    );
    expect(errorHit).toBeUndefined();
  });

  it("does not warn for the normal review-then-merge ordering", () => {
    const normalWorkflow = `review_templates:
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
    const home = writeFixture({
      "harness.yaml": `version: 1\n${normalWorkflow}${WIRED_HOOKS}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) =>
      /declares a required review step after its merge step/.test(d.message),
    );
    expect(hit).toBeUndefined();
  });
});

describe("validate — friendly version-mismatch diagnostic (task 50a94127)", () => {
  it("prints upgrade guidance instead of the bare zod literal error", () => {
    const home = writeFixture({ "harness.yaml": "version: 2\n" });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBeGreaterThan(0);
    const hit = result.diagnostics.find(
      (d) => d.path === "version" && /this CLI supports manifest version 1/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toMatch(/your manifest declares version 2/);
    expect(hit?.message).not.toMatch(/Invalid literal/);
  });
});

describe("validate — checkSolutionAcceptanceKnobIgnored", () => {
  // grounding-mcp is wired in every fixture so the producer check stays
  // silent and the assertions isolate the knob-ignored diagnostic.
  function fixtureWithPack(enabled: boolean): string {
    const yaml =
      `version: 1\n` +
      `tools:\n  mcp:\n    - name: grounding-mcp\n      command: ["/usr/bin/true"]\n` +
      `policy_packs:\n  - name: solution-acceptance\n    source: builtin\n    enabled: ${enabled}\n`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("warns when the pack is enabled and the knob path is git-ignored", () => {
    const home = fixtureWithPack(true);
    const probed: string[] = [];
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
      gitIgnoreProbe: (relPath: string) => {
        probed.push(relPath);
        return true;
      },
    });
    expect(probed).toEqual([".ai/solution-acceptance.json"]);
    expect(result.errorCount).toBe(0);
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && /knob .* is git-ignored/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policy_packs");
    expect(hit?.message).toMatch(/fresh clone or git worktree/);
    expect(hit?.message).toMatch(/Narrow the ignore to \.ai\/runs\//);
  });

  it("emits no warning when the knob path is not ignored (must-pass control)", () => {
    const home = fixtureWithPack(true);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
      gitIgnoreProbe: () => false,
    });
    expect(result.warningCount).toBe(0);
    expect(result.errorCount).toBe(0);
  });

  it("skips when the probe cannot tell (non-repo cwd / git unavailable)", () => {
    const home = fixtureWithPack(true);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
      gitIgnoreProbe: () => null,
    });
    expect(result.warningCount).toBe(0);
  });

  it("skips when the pack is disabled even if the knob path is ignored", () => {
    const home = fixtureWithPack(false);
    const probed: string[] = [];
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
      gitIgnoreProbe: (relPath: string) => {
        probed.push(relPath);
        return true;
      },
    });
    expect(probed).toEqual([]);
    expect(result.warningCount).toBe(0);
  });
});

describe("validate — createDefaultGitIgnoreProbe (real git)", () => {
  function makeRepo(gitignore: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-checkignore-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    if (gitignore !== null) {
      fs.writeFileSync(path.join(dir, ".gitignore"), gitignore, "utf8");
    }
    return dir;
  }

  it("maps git check-ignore exit codes to true / false / null", () => {
    const ignoringRepo = makeRepo(".ai/\n");
    expect(
      createDefaultGitIgnoreProbe(ignoringRepo)(".ai/solution-acceptance.json"),
    ).toBe(true);

    const cleanRepo = makeRepo(".ai/runs/\n");
    expect(
      createDefaultGitIgnoreProbe(cleanRepo)(".ai/solution-acceptance.json"),
    ).toBe(false);

    // GIT_CEILING_DIRECTORIES keeps the assertion hermetic: without it,
    // git would walk up from tmpdir and could find an enclosing repo on
    // machines whose TMPDIR sits inside a checkout.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "harness-nonrepo-"));
    cleanups.push(() => fs.rmSync(nonRepo, { recursive: true, force: true }));
    const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(nonRepo);
    try {
      expect(
        createDefaultGitIgnoreProbe(nonRepo)(".ai/solution-acceptance.json"),
      ).toBe(null);
    } finally {
      if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    }
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
    command: /usr/bin/true
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
    command: /usr/bin/true
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

describe("validate — checkSafeDeletionRootsSyntax (task d03af8f6, review round 2, LOW (a))", () => {
  function buildSafeRootsFixture(roots: string): string {
    const yaml = `version: 1
hooks:
  - name: h
    event: PreToolUse
    command: /usr/bin/true
    blocking: false
risk:
  safe_deletion_roots:
${roots}
`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("warns on a non-absolute risk.safe_deletion_roots entry", () => {
    const home = buildSafeRootsFixture("    - scratch");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && /not an absolute path/i.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("risk.safe_deletion_roots[0]");
  });

  it("warns on a risk.safe_deletion_roots entry containing $ or ~", () => {
    const home = buildSafeRootsFixture('    - "/tmp/$SCRATCH"');
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && /never expands|LITERAL/i.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("risk.safe_deletion_roots[0]");
  });

  it("does NOT warn on a well-formed absolute risk.safe_deletion_roots entry (negative control)", () => {
    const home = buildSafeRootsFixture("    - /tmp");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find((d) => d.path === "risk.safe_deletion_roots[0]");
    expect(hit).toBeUndefined();
  });
});

describe("validate — checkPolicySelfAttestation (task 43b107f2)", () => {
  // A block policy's requires.ledger_tag is satisfiable by any ledger
  // writer, including the gated agent. The check warns ONLY when no
  // producers: documents the intended evidence flow; a declared producer
  // (even an agent-executable one — the process-gate pattern the templates
  // ship) is a visible trust decision and stays warning-free.
  function buildPolicyFixture(producersBlock: string, enforcement = "block"): string {
    const yaml = `version: 1
hooks:
  - name: gate-hook
    event: PreToolUse
    command: /usr/bin/true
    blocking: false
policies:
  - name: gate-test
    description: test policy
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "review:\${SESSION_ID}"
    hook: gate-hook
    enforcement: ${enforcement}
${producersBlock}`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("warns when a block policy declares no producers (undocumented evidence source)", () => {
    // Mutation guard: removing checkPolicySelfAttestation from
    // runAssetChecks turns this red.
    const home = buildPolicyFixture("");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "warning" && /any ledger writer/i.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.path).toBe("policies[0]");
    expect(hit?.message).toContain("advisory against the agent");
    expect(hit?.message).toContain("writing-custom-policies.md");
  });

  it("does not warn when the policy documents its flow with an agent producer (process gate)", () => {
    const home = buildPolicyFixture(
      "    producers:\n" +
        "      - kind: mcp\n" +
        "        verb: mcp__grounding-mcp__ledger_add\n" +
        "        example: '{sessionId:\"s\", type:\"fact\", content:\"review:x\"}'\n" +
        "        description: process gate — agent records the review verdict\n",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /any ledger writer/i.test(d.message)),
    ).toBeUndefined();
  });

  it("does not warn for an ask+mcp producer block policy (the enforcing pattern)", () => {
    const home = buildPolicyFixture(
      "    producers:\n" +
        "      - kind: ask\n" +
        "        command: harness approve risk\n" +
        "        description: operator approves from their own shell\n" +
        "      - kind: mcp\n" +
        "        verb: mcp__grounding-mcp__ledger_add\n" +
        "        example: '{sessionId:\"s\", type:\"fact\", content:\"review:x\"}'\n" +
        "        description: recovery path\n",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /any ledger writer/i.test(d.message)),
    ).toBeUndefined();
  });

  it("does not warn for producer-less require_approval policies (operator verb is the canonical path)", () => {
    const home = buildPolicyFixture("", "require_approval");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /any ledger writer/i.test(d.message)),
    ).toBeUndefined();
  });

  it("does not warn for warn-enforcement policies (advisory by declaration)", () => {
    const home = buildPolicyFixture("", "warn");
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /any ledger writer/i.test(d.message)),
    ).toBeUndefined();
  });

  // task 2cc73f55: operator_only: true is the unconditional operator-only
  // deny — correct-by-construction, no self-satisfiable requires: to leave
  // undocumented. Neither the plain warning NOR --strict's promotion to an
  // error should fire for it.
  function buildOperatorOnlyFixture(): string {
    const yaml = `version: 1
hooks:
  - name: gate-hook
    event: PreToolUse
    command: /usr/bin/true
    blocking: false
policies:
  - name: gate-test
    description: test policy
    trigger:
      event: PreToolUse
      match: Bash
    operator_only: true
    hook: gate-hook
    enforcement: block`;
    return writeFixture({ "harness.yaml": yaml });
  }

  it("does not warn for an operator_only: true policy with no producers (correct-by-construction)", () => {
    const home = buildOperatorOnlyFixture();
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /any ledger writer/i.test(d.message)),
    ).toBeUndefined();
  });

  it("--strict does not turn the (absent) warning into an error for operator_only: true", () => {
    // Note: this fixture (like its siblings above) wires no grounding-mcp,
    // so it always trips the unrelated "policies declared but
    // grounding-mcp not wired" hard error regardless of operator_only —
    // that check is orthogonal to self-attestation. The assertion here is
    // scoped to the self-attestation diagnostic specifically: it must be
    // absent under --strict exactly as it is without it.
    const home = buildOperatorOnlyFixture();
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      strict: true,
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /any ledger writer/i.test(d.message)),
    ).toBeUndefined();
  });

  // Direct regression guard (reviewer follow-up, task 2cc73f55): drives
  // checkPolicySelfAttestation itself against the REAL shipped FULL_TEMPLATE
  // manifest, bypassing validate()'s unrelated diagnostics (grounding-mcp
  // wiring, lock drift, etc.) entirely. FULL_TEMPLATE's three migrated
  // deny-* kill-switch policies (operator_only: true, no producers:) must
  // produce ZERO self-attestation diagnostics; a future edit that
  // reintroduces a bare requires:-based block policy with no producers:,
  // or that regresses the operator_only skip in checkPolicySelfAttestation,
  // fails this directly instead of only being caught indirectly through
  // `harness validate --strict`.
  it("returns zero diagnostics for the real FULL_TEMPLATE manifest", () => {
    const manifest = parseManifest(parseYaml(FULL_TEMPLATE));
    expect(checkPolicySelfAttestation(manifest)).toEqual([]);
  });
});

// checkHookBudgetLedgerMargin (task d20a7e0c, follow-up to f1aea826/
// 7bf47554): a blocking, ledger-consulting hook whose budget_ms cannot
// clear the derived worst-case ledger round-trip (requiredHookBudgetMs
// in src/cli/policy/intercept.ts) can get killed by the runtime's outer
// hook timeout before it writes its fail-closed verdict — silently
// turning a deny into an allow. AC1: an inconsistent fixture reports the
// gap with BOTH numbers (budget_ms and the ledger's health.timeout_ms)
// in the message text. AC2: a consistent fixture stays silent.
describe("validate — checkHookBudgetLedgerMargin (task d20a7e0c)", () => {
  function fixtureWithGroundingMcp(opts: {
    timeoutMs?: number;
    hooksYaml?: string;
    policyPacksYaml?: string;
  }): string {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const yaml = `version: 1
tools:
  mcp:
    - name: grounding-mcp
      command: ["/usr/bin/true"]
      health:
        verb: ledger_summary
        timeout_ms: ${timeoutMs}
${opts.hooksYaml ?? "hooks: []\n"}${opts.policyPacksYaml ?? ""}policies: []
`;
    return writeFixture({ "harness.yaml": yaml });
  }

  function marginDiags(diagnostics: Array<{ path: string; message: string; severity: string }>) {
    return diagnostics.filter((d) => d.path.endsWith(".budget_ms") && d.path.startsWith("hooks["));
  }

  const DIRECT_HOOK = (budgetMs: number, command = "harness policy intercept"): string =>
    `hooks:
  - name: review-before-merge-hook
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: ${command}
    blocking: hard
    budget_ms: ${budgetMs}
`;

  it("AC1: an inconsistent budget_ms/timeout_ms fixture reports the gap with BOTH numbers in the text", () => {
    const home = fixtureWithGroundingMcp({ timeoutMs: 5000, hooksYaml: DIRECT_HOOK(5000) });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hits = marginDiags(result.diagnostics);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("error");
    expect(hits[0]?.path).toBe("hooks[review-before-merge-hook].budget_ms");
    // Both numbers named: the hook's own (undersized) budget_ms and the
    // ledger's health.timeout_ms it must clear a multiple of.
    expect(hits[0]?.message).toContain("budget_ms=5000");
    expect(hits[0]?.message).toContain("health.timeout_ms=5000ms");
    // The derived requirement (2*5000 + 3*auditRetryTimeoutMs(5000) =
    // 10000 + 3*1250 = 13750) is also named so the operator knows the
    // target, not just that today's value is wrong.
    expect(hits[0]?.message).toContain("13750");
  });

  it("AC2: a consistent fixture (shipped 15000ms default at the shipped 5000ms ledger timeout) stays silent", () => {
    const home = fixtureWithGroundingMcp({ timeoutMs: 5000, hooksYaml: DIRECT_HOOK(15000) });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toEqual([]);
  });

  it("matcher fix: a node-path invocation of the subcommand is still classified and checked", () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 5000,
      hooksYaml: DIRECT_HOOK(1000, "node /opt/harness/dist/cli/index.js policy intercept"),
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toHaveLength(1);
  });

  it("matcher fix: an env-prefixed invocation with a trailing --hook flag is still classified and checked", () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 5000,
      hooksYaml: DIRECT_HOOK(1000, "FOO=bar harness policy intercept --hook review-before-merge-hook"),
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toHaveLength(1);
  });

  // Fix round 1, finding 3 (review 2026-08-09): a shell metacharacter
  // glued directly onto the subcommand with no whitespace — a chained
  // `; next-command` or a wrapping double quote from `sh -c "..."` — used
  // to under-match under the whitespace-or-end-only trailing boundary.
  it("matcher fix: a semicolon-chained invocation (`...intercept; echo done`) is still classified and checked", () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 5000,
      hooksYaml: DIRECT_HOOK(1000, "harness policy intercept; echo done"),
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toHaveLength(1);
  });

  it('matcher fix: a quote-wrapped invocation (`sh -c "...intercept"`) is still classified and checked', () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 5000,
      hooksYaml: DIRECT_HOOK(1000, 'sh -c "harness policy intercept"'),
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toHaveLength(1);
  });

  it("an unrelated command (not `policy intercept`) with a low budget_ms is not flagged", () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 5000,
      hooksYaml: DIRECT_HOOK(100, "/usr/bin/some-other-tool"),
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toEqual([]);
  });

  it("a non-hard blocking hook with a low budget_ms is not flagged", () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 5000,
      hooksYaml: `hooks:
  - name: soft-policy-hook
    event: PreToolUse
    match: "Bash"
    command: harness policy intercept
    blocking: soft
    budget_ms: 100
`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toEqual([]);
  });

  it("no grounding-mcp wired: not flagged even at an obviously-undersized budget_ms", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1
${DIRECT_HOOK(100)}policies: []
`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(marginDiags(result.diagnostics)).toEqual([]);
  });

  it("generic over packs: an enabled branch-protection pack's blocker is checked WITHOUT any hooks[] entry, and flags when a raised ledger timeout outgrows the shipped pack budget", () => {
    // Shipped pack budget is 15000ms (task 7bf47554), which clears the
    // default 5000ms ledger's 13750ms requirement — but NOT a manifest
    // that raises tools.mcp.grounding-mcp.health.timeout_ms without
    // raising the pack's own (fixed, non-manifest-configurable)
    // budget_ms in lockstep: required = 2*10000 + 3*2500 = 27500ms > 15000.
    const home = fixtureWithGroundingMcp({
      timeoutMs: 10000,
      policyPacksYaml: `policy_packs:
  - name: branch-protection
    source: builtin
    enabled: true
`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hits = marginDiags(result.diagnostics);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.path.includes("policy-pack:branch-protection"))).toBe(true);
  });

  it("negative control: an enabled solution-acceptance pack is NOT flagged even under the same raised ledger timeout (file-marker based, no ledger round-trip)", () => {
    const home = fixtureWithGroundingMcp({
      timeoutMs: 10000,
      policyPacksYaml: `policy_packs:
  - name: solution-acceptance
    source: builtin
    enabled: true
`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hits = marginDiags(result.diagnostics);
    expect(hits.some((h) => h.path.includes("solution-acceptance"))).toBe(false);
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

// Review round 3 (99f47307 Slice 1): F1 black-box reproduction (the full
// template plus a qualifying workflow warned about a derived policy that a
// strong hand-authored policy had suppressed) and the new derived-name
// collision check.
describe("validate: workflow checks on the derived view (review round 3)", () => {
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

  it("F1: FULL_TEMPLATE plus a qualifying workflow yields zero workflow diagnostics", () => {
    const home = writeFixture({ "harness.yaml": `${FULL_TEMPLATE}\n${WORKFLOW_REQUIRED}` });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.diagnostics.filter((d) => d.path === "workflows")).toEqual([]);
    // And the derived view carries no workflow:* policy: the template's
    // own review-before-merge(-bash) pair stands in for both surfaces.
    expect(result.manifest?.policies.filter((p) => p.name.startsWith("workflow:"))).toEqual([]);
  });

  it("errors when a hand-authored policy name collides with a derived policy name on a different surface", () => {
    const wiredHooks = `hooks:
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
    const colliding = `policies:
  - name: workflow:ship:review-before-merge
    description: Same name as the derived gate, different surface.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "git push"
    requires:
      ledger_tag: "review:done"
    hook: require-review-evidence-bash
    enforcement: block
`;
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${colliding}${wiredHooks}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "error" && /collides with the policy of the same name/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("workflow:ship:review-before-merge");
    // Fail-safe: the derived gate is still there (two entries share the name).
    expect(
      result.manifest?.policies.filter((p) => p.name === "workflow:ship:review-before-merge"),
    ).toHaveLength(2);
  });

  // F3 (review round 3 follow-up, 99f47307 Slice 1): the collision check
  // fires on a NAME match regardless of surface. The test above only
  // covers the different-surface case; this one is the same-surface case
  // (also caught by checkWorkflowGateWeakOverlap, since a same-surface,
  // weaker hand policy is an overlap too), and pins the corrected message
  // wording: "it does not stand in for the derived gate", not the old
  // "it does not intercept the same surface" (which was false here).
  it("errors when a hand-authored policy name collides with a derived policy name on the SAME surface", () => {
    const wiredHooks = `hooks:
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
    const sameSurfaceColliding = `policies:
  - name: workflow:ship:review-before-merge
    description: Same name as the derived gate, same surface, weaker enforcement.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: warn
`;
    const home = writeFixture({
      "harness.yaml": `version: 1\n${WORKFLOW_REQUIRED}${sameSurfaceColliding}${wiredHooks}`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const hit = result.diagnostics.find(
      (d) => d.severity === "error" && /collides with the policy of the same name/.test(d.message),
    );
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("does not stand in for the derived gate");
    expect(hit?.message).not.toContain("does not intercept the same surface");
    // Fail-safe: the derived gate is still there (two entries share the name).
    expect(
      result.manifest?.policies.filter((p) => p.name === "workflow:ship:review-before-merge"),
    ).toHaveLength(2);
  });
});
