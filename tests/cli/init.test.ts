import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { init } from "../../src/cli/init/index.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { validateBeforeWrite } from "../../src/io/validate-before-write.js";
import { validate } from "../../src/cli/validate/index.js";

let tmpHome: string;
let manifestPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-init-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("init — minimal template", () => {
  it("writes a manifest at <homeDir>/harness.yaml when configPath is omitted", async () => {
    const r = await init({ homeDir: tmpHome });
    expect(r.path).toBe(manifestPath);
    expect(r.template).toBe("minimal");
    expect(r.overwrote).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it("the minimal manifest passes harness validate immediately", async () => {
    await init({ homeDir: tmpHome });
    const result = validate({ configPath: manifestPath });
    expect(result.errorCount).toBe(0);
  });

  it("contains the version: 1 header and an explanatory comment block", async () => {
    await init({ homeDir: tmpHome });
    const yaml = fs.readFileSync(manifestPath, "utf8");
    expect(yaml).toMatch(/^version: 1$/m);
    expect(yaml).toContain("# Bootstrapped by `harness init --template minimal`");
  });

  it("defaults to the minimal template when no flag is passed", async () => {
    const r = await init({ homeDir: tmpHome });
    expect(r.template).toBe("minimal");
  });
});

describe("init — full template", () => {
  it("writes a manifest pre-populated with Appendix A example values", async () => {
    const r = await init({ homeDir: tmpHome, template: "full" });
    expect(r.template).toBe("full");
    const yaml = fs.readFileSync(manifestPath, "utf8");
    // Parse to YAML so substring matches against comment prose cannot
    // create false-greens. Earlier the test asserted on bare strings
    // like "codebase-oracle"; once those entries moved into comments
    // the assertion stayed green for the wrong reason.
    const parsed = parseYaml(yaml) as {
      tools?: { mcp?: { name: string }[] };
      hooks?: { name: string }[];
      policies?: { name: string }[];
    };
    const mcpNames = parsed.tools?.mcp?.map((m) => m.name) ?? [];
    const hookNames = parsed.hooks?.map((h) => h.name) ?? [];
    const policyNames = parsed.policies?.map((p) => p.name) ?? [];
    // MCP servers the Full default ships. codebase-oracle is
    // intentionally NOT in the chain: it is a useful standalone MCP
    // but an opinionated workflow add-on rather than infrastructure
    // harness itself depends on. Operators add it manually via
    // `harness add mcp codebase-oracle --command codebase-oracle,mcp`.
    expect(mcpNames).toContain("agent-tasks");
    expect(mcpNames).toContain("grounding-mcp");
    expect(mcpNames).not.toContain("codebase-oracle");
    // Hooks: PreToolUse policy gates route through the bundled
    // `harness policy intercept` engine, plus the `git-preflight`
    // SessionStart producer (`harness session-start preflight`), which
    // is the write side that satisfies the preflight-before-* policies.
    // The `-bash` variants cover the gh-cli surface alongside the
    // agent-tasks MCP surface (task 7eed0bb2).
    expect(hookNames).toContain("require-review-evidence");
    expect(hookNames).toContain("require-review-evidence-bash");
    expect(hookNames).toContain("require-dogfood-evidence");
    expect(hookNames).toContain("require-preflight-evidence");
    expect(hookNames).toContain("require-review-subagent-evidence");
    expect(hookNames).toContain("require-review-subagent-evidence-bash");
    expect(hookNames).toContain("require-preflight-push-evidence");
    expect(hookNames).toContain("git-preflight");
    // The reference policies that drive those hooks. `two-reviewers-required`
    // is a warn-level companion to review-before-merge, sharing the same hook;
    // see docs/examples/full-manifest.yaml for the canonical definition.
    // The `-bash` variants are the tool-agnostic parallels of the MCP
    // policies for operators on the gh-cli workflow (task 7eed0bb2).
    expect(policyNames).toContain("review-before-merge");
    expect(policyNames).toContain("review-before-merge-bash");
    expect(policyNames).toContain("dogfood-before-release");
    expect(policyNames).toContain("two-reviewers-required");
    expect(policyNames).toContain("preflight-before-investigation");
    expect(policyNames).toContain("review-subagent-before-pr-create");
    expect(policyNames).toContain("review-subagent-before-pr-create-bash");
    expect(policyNames).toContain("preflight-before-push");
  });


  it("the full template parses as a schema-valid manifest", async () => {
    await init({ homeDir: tmpHome, template: "full" });
    // Schema-level only: full-template paths reference the developer machine
    // that authored Appendix A, so file-existence checks may warn/error on
    // a fresh install. The manifest itself must parse cleanly.
    const yaml = fs.readFileSync(manifestPath, "utf8");
    const r = validateBeforeWrite(parseYaml(yaml));
    expect(r.ok).toBe(true);
  });

  it("no MCP env entry carries a literal `~/` path (agent-tasks/42d224a6 regression)", async () => {
    // Background: better-sqlite3 (and node's fs primitives) open literal
    // tilde paths as cwd-relative, not $HOME-relative. The harness used
    // to wire `env: { EVIDENCE_LEDGER_DB: "~/.evidence-ledger/ledger.db" }`
    // on the grounding-mcp entry; this produced cwd-relative rogue DBs
    // scattered across the operator's filesystem and silently broke the
    // approve/gate round-trip (approve wrote to one rogue DB, gate read
    // from another). Lock the contract here: no template ever ships an
    // env value beginning with `~/`. Use absolute paths or omit the env
    // entirely (the bundled defaults use os.homedir() at startup).
    for (const template of ["solo", "team", "full"] as const) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `tilde-${template}-`));
      try {
        await init({ homeDir: tmp, template });
        const yaml = fs.readFileSync(path.join(tmp, "harness.yaml"), "utf8");
        const parsed = parseYaml(yaml) as {
          tools?: { mcp?: { name: string; env?: Record<string, string> }[] };
        };
        for (const m of parsed.tools?.mcp ?? []) {
          for (const [key, value] of Object.entries(m.env ?? {})) {
            expect(
              value.startsWith("~/"),
              `${template} template: tools.mcp.${m.name}.env.${key} = ${value}`,
            ).toBe(false);
          }
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});

describe("init — solo profile", () => {
  it("writes a manifest with memory-router + understanding-before-execution pack", async () => {
    const r = await init({ homeDir: tmpHome, template: "solo" });
    expect(r.template).toBe("solo");
    const yaml = fs.readFileSync(manifestPath, "utf8");
    expect(yaml).toContain("memory-router");
    expect(yaml).toContain("understanding-before-execution");
    expect(yaml).toContain("mode: grill_me");
    // Solo intentionally does NOT wire agent-tasks or the merge policy.
    // The comment header may name "agent-tasks" in a negation ("No
    // agent-tasks loop") so we check the structural keys, not the
    // raw string.
    expect(yaml).not.toMatch(/^\s*- name: agent-tasks/m);
    expect(yaml).not.toMatch(/^\s*- name: review-before-merge/m);
  });

  it("the solo template passes harness validate cleanly (0 errors, 0 warnings)", async () => {
    await init({ homeDir: tmpHome, template: "solo" });
    const v = validate({ configPath: manifestPath });
    expect(v.errorCount).toBe(0);
    expect(v.warningCount).toBe(0);
  });
});

describe("init — team profile", () => {
  it("writes a manifest with solo content plus agent-tasks + review-before-merge", async () => {
    const r = await init({ homeDir: tmpHome, template: "team" });
    expect(r.template).toBe("team");
    const yaml = fs.readFileSync(manifestPath, "utf8");
    expect(yaml).toContain("memory-router");
    expect(yaml).toContain("understanding-before-execution");
    expect(yaml).toContain("agent-tasks");
    expect(yaml).toContain("grounding-mcp");
    expect(yaml).toContain("review-before-merge");
    expect(yaml).toContain("mcp__agent-tasks__pull_requests_merge");
    // Hook command uses the built-in CLI verb, not a placeholder shell script.
    expect(yaml).toContain("command: harness policy intercept");
  });

  it("the team template passes harness validate cleanly (0 errors, 0 warnings)", async () => {
    await init({ homeDir: tmpHome, template: "team" });
    const v = validate({ configPath: manifestPath });
    expect(v.errorCount).toBe(0);
    expect(v.warningCount).toBe(0);
  });

  it("wires grounding-mcp so the review-before-merge policy does not degrade to warn-mode", async () => {
    // Memory `feedback_harness_policies_warn_mode`: a manifest with
    // policies: that doesn't declare grounding-mcp in tools.mcp silently
    // lets all policies through. The team profile must include
    // grounding-mcp explicitly to honour the gate.
    await init({ homeDir: tmpHome, template: "team" });
    const v = validate({ configPath: manifestPath });
    const hasPolicyWarning = v.diagnostics.some(
      (d) =>
        d.severity === "warning" &&
        d.message.includes("grounding-mcp not wired"),
    );
    expect(hasPolicyWarning).toBe(false);
  });
});

describe("init — refuse on existing without --force", () => {
  it("throws HarnessExitError naming the existing path", async () => {
    fs.writeFileSync(manifestPath, "version: 1\n");
    await expect(init({ homeDir: tmpHome })).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringContaining(manifestPath),
    });
  });

  it("does not overwrite the existing file", async () => {
    fs.writeFileSync(manifestPath, "intact: true\n");
    try {
      await init({ homeDir: tmpHome });
    } catch (e) {
      // expected
      if (!(e instanceof HarnessExitError)) throw e;
    }
    expect(fs.readFileSync(manifestPath, "utf8")).toBe("intact: true\n");
  });
});

describe("init — --force overwrites", () => {
  it("overwrites and emits an `(overwriting ...)` message on stderr", async () => {
    fs.writeFileSync(manifestPath, "old: yes\n");
    const r = await init({ homeDir: tmpHome, force: true });
    expect(r.overwrote).toBe(true);
    expect(r.stderr).toContain(`overwriting existing manifest at ${manifestPath}`);
    expect(fs.readFileSync(manifestPath, "utf8")).toContain("version: 1");
  });
});

describe("init — next-steps hint", () => {
  it("prints validate / describe / doctor invocations on stdout", async () => {
    const r = await init({ homeDir: tmpHome });
    expect(r.stdout).toContain("Next steps:");
    expect(r.stdout).toContain("harness validate");
    expect(r.stdout).toContain("harness describe");
    expect(r.stdout).toContain("harness doctor");
  });

  it("includes the resolved target path in each next-steps invocation", async () => {
    const r = await init({ homeDir: tmpHome });
    expect(r.stdout).toContain(`--config ${manifestPath}`);
  });
});

describe("init — explicit configPath", () => {
  it("writes to the given configPath when provided", async () => {
    const target = path.join(tmpHome, "subdir/harness.yaml");
    const r = await init({ configPath: target });
    expect(r.path).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});

// Task 7f8fb4bc: `init` surfaces unresolved MCP/CLI binaries right after
// writing the manifest, instead of leaving the operator to discover them
// via a later `harness doctor` run (or worse, the old ENOENT crash).
describe("init — bin-resolution check (task 7f8fb4bc)", () => {
  it("surfaces an unresolved MCP binary on stderr without throwing, and reports a non-zero count", async () => {
    const content = `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: ghost-mcp
      command: [definitely-not-a-real-binary-harness-7f8fb4bc]
      health:
        verb: ping
      enabled: true
  builtin:
    known: []
`;
    const r = await init({
      homeDir: tmpHome,
      content,
      contentLabel: "custom",
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
    });
    expect(r.binResolutionErrorCount).toBe(1);
    expect(r.stderr).toContain("ghost-mcp");
    expect(r.stderr).toContain("not found on PATH");
  });

  it("reports zero when every declared MCP binary resolves", async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-init-binres-"));
    const bin = path.join(binDir, "present-mcp");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    const content = `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: present-mcp
      command: [present-mcp]
      health:
        verb: ping
      enabled: true
  builtin:
    known: []
`;
    const r = await init({
      homeDir: tmpHome,
      content,
      contentLabel: "custom",
      pathEnv: binDir,
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
    });
    expect(r.binResolutionErrorCount).toBe(0);
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("attaches a PATH-shadow hint when the binary exists under the npm global bin dir but is not on PATH", async () => {
    const npmBinDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-init-npmbin-"));
    const npmBinDir = path.join(npmBinDirRoot, "bin");
    fs.mkdirSync(npmBinDir);
    const shadowed = path.join(npmBinDir, "grounding-mcp");
    fs.writeFileSync(shadowed, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(shadowed, 0o755);
    const content = `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: grounding-mcp
      command: [grounding-mcp]
      health:
        verb: ping
      enabled: true
  builtin:
    known: []
`;
    const r = await init({
      homeDir: tmpHome,
      content,
      contentLabel: "custom",
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 0, stdout: `${npmBinDirRoot}\n`, stderr: "" }),
    });
    expect(r.binResolutionErrorCount).toBe(1);
    expect(r.stderr).toContain(npmBinDir);
    expect(r.stderr).toContain(`export PATH="${npmBinDir}:$PATH"`);
    fs.rmSync(npmBinDirRoot, { recursive: true, force: true });
  });
});
