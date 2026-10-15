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
} from "../../src/cli/validate/checks.js";
import { spawnSync } from "node:child_process";
import { writeLock, type LockEntry } from "../../src/io/harness-lock.js";
import * as crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

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

  it("warns (does not error) when evidence-consuming policies declared but grounding-mcp is missing", () => {
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

describe("validate — policies[].trigger.path_match is not evaluated", () => {
  function manifestWithTrigger(triggerExtra: string): string {
    const home = writeFixture({ "harness.yaml": ``, "hooks/h.sh": "#!/bin/sh\nexit 0\n" });
    fs.chmodSync(path.join(home, "hooks", "h.sh"), 0o755);
    const yaml = `version: 1
hooks:
  - name: h
    event: PreToolUse
    command: ${path.join(home, "hooks", "h.sh")}
    blocking: false
policies:
  - name: guard-env-files
    description: test
    trigger:
      event: PreToolUse
      match: Edit
${triggerExtra}    operator_only: true
    hook: h
    enforcement: block
`;
    fs.writeFileSync(path.join(home, "harness.yaml"), yaml, "utf8");
    return home;
  }

  it("parses a manifest that sets it (the load must not fail) and reports a validate error naming the policy", () => {
    const home = manifestWithTrigger(`      path_match: '\\.env$'\n`);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    // The manifest parsed: only the lint reports it.
    expect(result.manifest).not.toBeNull();
    const hits = result.diagnostics.filter((d) => /path_match/.test(d.message));
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.severity).toBe("error");
    expect(hit?.path).toBe("policies[0].trigger.path_match");
    expect(hit?.message).toContain('policy "guard-env-files"');
    expect(hit?.message).toMatch(/does not evaluate/);
    expect(hit?.message).toMatch(/trigger\.bash_match/);
    expect(result.errorCount).toBe(1);
  });

  it("stays clean for the same policy without path_match", () => {
    const home = manifestWithTrigger(``);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.diagnostics.filter((d) => /path_match/.test(d.message))).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it("does not flag hook-level path_match (script-enforced documentation)", () => {
    const home = writeFixture({ "harness.yaml": ``, "hooks/h.sh": "#!/bin/sh\nexit 0\n" });
    fs.chmodSync(path.join(home, "hooks", "h.sh"), 0o755);
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks:
  - name: h
    event: PreToolUse
    match: Edit
    path_match: '**/*.env'
    command: ${path.join(home, "hooks", "h.sh")}
    blocking: false
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.diagnostics.filter((d) => /path_match/.test(d.message))).toEqual([]);
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
    const home = fixtureWithPacks([{ name: "branch-protection" }]);
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
      { name: "branch-protection", source: "path:./somewhere" },
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

  it("rejects a wrong-type `protected_branches` value on branch-protection", () => {
    const home = fixtureWithPacks([
      { name: "branch-protection", config: { protected_branches: "main" } },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const branchesError = result.diagnostics.find(
      (d) =>
        d.path === "policy_packs[0].config.protected_branches" &&
        d.severity === "error",
    );
    expect(branchesError).toBeDefined();
  });

  it("rejects a typo'd config key (strict mode)", () => {
    const home = fixtureWithPacks([
      {
        name: "branch-protection",
        config: { protected_brances: ["main"] },
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
        /protected_brances/.test(d.message),
    );
    expect(error).toBeDefined();
  });

  it("missing config keys are silent (no diagnostic)", () => {
    const home = fixtureWithPacks([{ name: "branch-protection" }]);
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
        name: "branch-protection",
        config: { protected_branches: "main" },
      },
      { name: "no-such-pack" },
    ]);
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    const configError = result.diagnostics.find(
      (d) =>
        d.path === "policy_packs[0].config.protected_branches" &&
        d.severity === "error",
    );
    const sourceError = result.diagnostics.find(
      (d) => d.path === "policy_packs[1].name" && d.severity === "error",
    );
    expect(configError).toBeDefined();
    expect(sourceError).toBeDefined();
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


describe("validate — internal helpers", () => {
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

  it("operator_only-only policies do not warn when grounding-mcp is absent", () => {
    const home = buildOperatorOnlyFixture();
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(result.errorCount).toBe(0);
    expect(
      result.diagnostics.find((d) => /grounding-mcp not wired/.test(d.message)),
    ).toBeUndefined();
  });

  it("mixed operator_only and evidence-consuming policies still warn without grounding-mcp", () => {
    const home = buildOperatorOnlyFixture();
    fs.appendFileSync(
      path.join(home, "harness.yaml"),
      `\n  - name: evidence-policy\n    description: consumes ledger evidence\n    trigger:\n      event: PreToolUse\n      match: Read\n    requires:\n      ledger_tag: "review:\${SESSION_ID}"\n    hook: gate-hook\n    enforcement: block\n`,
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.find((d) => /grounding-mcp not wired/.test(d.message)),
    ).toMatchObject({ severity: "warning", path: "policies" });
  });

  it("--strict does not turn the (absent) warning into an error for operator_only: true", () => {
    // operator_only policies consume no evidence, so they do not need
    // grounding-mcp. The assertion remains scoped to the self-attestation
    // diagnostic: it must be absent under --strict exactly as it is without it.
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

// The hook-budget-vs-ledger-timeout margin check went away with the policy
// engine. A hook whose command is still `harness policy intercept` is an
// ordinary hook command: its budget_ms is not compared with the
// grounding-mcp ledger timeout any more.
describe("validate — no hook-budget-vs-ledger-timeout margin check", () => {
  it("an undersized budget_ms on a blocking `harness policy intercept` hook raises no budget_ms diagnostic", () => {
    const home = writeFixture({
      "harness.yaml": `version: 1
tools:
  mcp:
    - name: grounding-mcp
      command: ["/usr/bin/true"]
      health:
        verb: ledger_summary
        timeout_ms: 5000
hooks:
  - name: review-before-merge-hook
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000
policies: []
`,
    });
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      ...NOOP_PROBES,
    });
    expect(
      result.diagnostics.filter((d) => d.path.startsWith("hooks[") && d.path.endsWith(".budget_ms")),
    ).toEqual([]);
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

describe("validate - tools.cli[] min_version prerelease (task db44ab46)", () => {
  // Task db44ab46 extends the hooks[] prerelease-rejection rule
  // (docs/decisions/2026-09-08-preflight-floors.md) to validate's
  // tools.cli[] check: a release candidate of the required binary must
  // not satisfy an equal-numeric min_version floor.
  function diagnosticFor(stdout: string) {
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
      min_version: "1.2.3"
      required: true
hooks: []
policies: []
`,
      "utf8",
    );
    const result = validate({
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      versionProbe: () => stdout,
      builtinRuntimeProbe: () => [],
    });
    return result.diagnostics.find((d) => d.path === "tools.cli[fake].min_version");
  }

  it("errors below_floor when the probed cli version is a dotted prerelease of min_version", () => {
    const hit = diagnosticFor("fake 1.2.3-rc.1");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toBe("installed version 1.2.3-rc.1 is less than required 1.2.3");
  });

  it("errors below_floor when the probed cli version is a dotless prerelease of min_version", () => {
    const hit = diagnosticFor("fake 1.2.3-beta");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toBe("installed version 1.2.3-beta is less than required 1.2.3");
  });

  it("still passes a real release meeting the floor (no regression)", () => {
    expect(diagnosticFor("fake 1.2.3")).toBeUndefined();
  });

  it("passes a higher-version prerelease with no diagnostic (numeric comparison is not a tie)", () => {
    expect(diagnosticFor("fake 1.2.4-rc.1")).toBeUndefined();
  });

  it("errors below_floor on a git-describe suffix at an equal-numeric floor (accepted cost)", () => {
    const hit = diagnosticFor("fake 1.2.3-4-gabc123");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toBe("installed version 1.2.3-4-gabc123 is less than required 1.2.3");
  });

  it("errors below_floor on a platform suffix at an equal-numeric floor (accepted cost)", () => {
    const hit = diagnosticFor("fake 1.2.3-linux-x64");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toBe("installed version 1.2.3-linux-x64 is less than required 1.2.3");
  });

  // Residual (task 62d9778c): pins the +build-is-not-a-prerelease claim
  // (docs/CLI.md) through this surface, not only through the
  // parseProbedVersion unit test.
  it("passes a +build metadata suffix at an equal-numeric floor (not a prerelease)", () => {
    expect(diagnosticFor("fake 1.2.3+build.7")).toBeUndefined();
  });
});
