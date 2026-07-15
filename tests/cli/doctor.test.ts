import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  doctor,
  NULL_GIT_IGNORE_PROBE,
  resolveGitIgnoreProbe,
} from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { VERSION } from "../../src/version.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

class FakeProbe implements McpProbe {
  constructor(private readonly outcomes: Record<string, McpProbeResult["outcome"]>) {}
  async call(server: McpServer): Promise<McpProbeResult> {
    return {
      name: server.name,
      outcome: this.outcomes[server.name] ?? { kind: "missing-verb" },
    };
  }
}

describe("doctor — Appendix D structure", () => {
  it("renders Manifest / Tools / Memory / Hooks / Policies / Summary sections in order", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read, Edit]
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "",
      // Stub npm bin probe so this test stays env-independent (the
      // real probe shells out to `npm prefix -g` and can drift the
      // section count based on whether npm is installed in CI).
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
    });
    const text = format(report);
    expect(text).toMatch(/Manifest\n/);
    expect(text).toMatch(/\nTools\n/);
    expect(text).toMatch(/\nMemory\n/);
    expect(text).toMatch(/\nHooks\n/);
    expect(text).toMatch(/\nPolicies\n/);
    expect(text).toMatch(/\nSummary\n/);
    expect(text.indexOf("Manifest")).toBeLessThan(text.indexOf("Tools"));
    expect(text.indexOf("Tools")).toBeLessThan(text.indexOf("Memory"));
    expect(text.indexOf("Memory")).toBeLessThan(text.indexOf("Hooks"));
    expect(text.indexOf("Hooks")).toBeLessThan(text.indexOf("Policies"));
    expect(text.indexOf("Policies")).toBeLessThan(text.indexOf("Summary"));
  });
});

describe("doctor — MCP probe surfacing", () => {
  it("renders broken MCP servers with the actual error message, not a generic label", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: codebase-oracle
      command: [/usr/bin/true]
      health:
        verb: oracle_list_repos
        timeout_ms: 1000
      enabled: true
`,
    });
    const probe = new FakeProbe({
      "codebase-oracle": {
        kind: "error",
        latencyMs: 412,
        message: "process exit 1: Cannot find module 'sqlite-vec'",
      },
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: probe,
      pathEnv: "",
    });
    const text = format(report);
    expect(text).toContain("codebase-oracle");
    expect(text).toContain("Cannot find module 'sqlite-vec'");
    expect(report.errorCount).toBe(1);
  });

  it("reports `unknown — no health verb declared` when health block is absent", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: bare-mcp
      command: [/usr/bin/true]
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      pathEnv: "",
    });
    expect(report.tools.mcp[0]?.outcome.kind).toBe("missing-verb");
    expect(format(report)).toContain("unknown — no health verb declared");
  });

  it("renders no-response distinct from FAILED and counts it as an error", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: agent-tasks
      command: [/usr/bin/true]
      health:
        verb: ping
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({
        "agent-tasks": { kind: "no-response", latencyMs: 12, phase: "initialize" },
      }),
      pathEnv: "",
    });
    expect(report.tools.mcp[0]?.outcome.kind).toBe("no-response");
    expect(report.errorCount).toBe(1);
    const text = format(report);
    expect(text).toContain("✗ agent-tasks  no JSON-RPC response (process exited cleanly during initialize)");
    expect(text).not.toContain("FAILED:");
  });

  it("emits a healthy line with the probe latency", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: alpha
      command: [/usr/bin/true]
      health:
        verb: ping
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({ alpha: { kind: "healthy", latencyMs: 89 } }),
      pathEnv: "",
    });
    expect(format(report)).toContain("✓ alpha  healthy in 89ms");
  });

  // Mutation test for task 7f8fb4bc (dogfood 2026-07-06): a declared MCP
  // whose binary is unresolvable used to crash the whole `doctor` run with
  // an unhandled 'error' event on the spawned ChildProcess ("Error: spawn
  // grounding-mcp ENOENT"). This exercises the REAL probe (no `mcpProbe`
  // stub) end-to-end through `doctor()` so a regression would manifest as
  // an unhandled rejection / process crash, not just a wrong assertion.
  it("survives a declared MCP whose binary is unresolvable (spawn ENOENT) and keeps probing the rest", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: ghost-mcp
      command: [definitely-not-a-real-binary-harness-7f8fb4bc]
      health:
        verb: ping
        timeout_ms: 2000
      enabled: true
    - name: alpha
      command: [/usr/bin/true]
      health:
        verb: ping
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new (class implements McpProbe {
        async call(server: McpServer): Promise<McpProbeResult> {
          if (server.name === "alpha") {
            return { name: "alpha", outcome: { kind: "healthy", latencyMs: 5 } };
          }
          // Exercise the real spawn-ENOENT path only for ghost-mcp.
          const { RealMcpProbe } = await import("../../src/probes/mcp.js");
          return new RealMcpProbe().call(server);
        }
      })(),
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
    });
    const ghost = report.tools.mcp.find((m) => m.name === "ghost-mcp");
    expect(ghost?.outcome.kind).toBe("error");
    if (ghost?.outcome.kind === "error") {
      expect(ghost.outcome.message).toMatch(/not found on PATH/);
      expect(ghost.outcome.enoent).toBe(true);
    }
    // doctor kept going: the second declared server still probed cleanly.
    const alpha = report.tools.mcp.find((m) => m.name === "alpha");
    expect(alpha?.outcome.kind).toBe("healthy");
    expect(report.errorCount).toBeGreaterThan(0);
    const text = format(report);
    expect(text).toMatch(/\d+ errors?\n/);
    expect(text).not.toMatch(/at ChildProcess/); // no stack trace leaked into the report
    expect(text).not.toMatch(/Unhandled/i);
  });

  it("attaches a PATH-shadow hint when the ENOENT binary exists under the npm global bin dir but is not on PATH", async () => {
    const npmBinDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-npmbin-"));
    cleanups.push(() => fs.rmSync(npmBinDirRoot, { recursive: true, force: true }));
    const npmBinDir = path.join(npmBinDirRoot, "bin");
    fs.mkdirSync(npmBinDir);
    const shadowed = path.join(npmBinDir, "grounding-mcp");
    fs.writeFileSync(shadowed, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(shadowed, 0o755);

    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: grounding-mcp
      command: [grounding-mcp]
      health:
        verb: ping
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({
        "grounding-mcp": {
          kind: "error",
          latencyMs: 3,
          message: "grounding-mcp not found on PATH (spawn ENOENT)",
          enoent: true,
        },
      }),
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 0, stdout: `${npmBinDirRoot}\n`, stderr: "" }),
    });
    const server = report.tools.mcp.find((m) => m.name === "grounding-mcp");
    expect(server?.outcome.kind).toBe("error");
    if (server?.outcome.kind === "error") {
      expect(server.outcome.pathHint).toContain(npmBinDir);
      expect(server.outcome.pathHint).toContain(`export PATH="${npmBinDir}:$PATH"`);
    }
    const text = format(report);
    expect(text).toContain(npmBinDir);
  });
});

describe("doctor — CLI PATH-shadow hint (task 7f8fb4bc)", () => {
  it("attaches a PATH-shadow hint when a required CLI binary exists under the npm global bin dir but is not on PATH", async () => {
    const npmBinDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-npmbin-cli-"));
    cleanups.push(() => fs.rmSync(npmBinDirRoot, { recursive: true, force: true }));
    const npmBinDir = path.join(npmBinDirRoot, "bin");
    fs.mkdirSync(npmBinDir);
    const shadowed = path.join(npmBinDir, "agent-preflight");
    fs.writeFileSync(shadowed, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(shadowed, 0o755);

    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  cli:
    - name: agent-preflight
      binary: agent-preflight
      required: true
  builtin:
    known: []
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 0, stdout: `${npmBinDirRoot}\n`, stderr: "" }),
    });
    const cli = report.tools.cli.find((c) => c.name === "agent-preflight");
    expect(cli?.status).toBe("error");
    expect(cli?.pathHint).toContain(npmBinDir);
    expect(cli?.pathHint).toContain(`export PATH="${npmBinDir}:$PATH"`);
    const text = format(report);
    expect(text).toContain(npmBinDir);
  });

  it("does not attach a hint when the binary genuinely is not installed anywhere", async () => {
    const npmBinDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-npmbin-cli-empty-"));
    cleanups.push(() => fs.rmSync(npmBinDirRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(npmBinDirRoot, "bin"));

    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  cli:
    - name: agent-preflight
      binary: agent-preflight
      required: true
  builtin:
    known: []
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 0, stdout: `${npmBinDirRoot}\n`, stderr: "" }),
    });
    const cli = report.tools.cli.find((c) => c.name === "agent-preflight");
    expect(cli?.status).toBe("error");
    expect(cli?.pathHint).toBeUndefined();
  });
});

describe("doctor — --shallow timing budget", () => {
  it("completes in under 100ms against an 8-MCP-server fixture (no real probes)", async () => {
    const mcpEntries = Array.from({ length: 8 }, (_, i) => `
    - name: server-${i}
      command: [/usr/bin/true]
      health:
        verb: ping
      enabled: true`).join("\n");
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:${mcpEntries}
`,
    });
    const start = performance.now();
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      pathEnv: "",
    });
    const elapsed = performance.now() - start;
    expect(report.tools.mcp).toHaveLength(8);
    expect(report.shallow).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("doctor — stale memory detection", () => {
  it("surfaces memory files older than retention.staleness_days", async () => {
    const home = makeFixture({
      "memory/dir/old.md": "# old\n",
      "memory/dir/fresh.md": "# fresh\n",
    });
    const oldPath = path.join(home, "memory/dir/old.md");
    const freshPath = path.join(home, "memory/dir/fresh.md");
    const now = new Date("2026-04-29T00:00:00Z");
    const oldTime = new Date("2025-09-01T00:00:00Z");
    const freshTime = new Date("2026-04-20T00:00:00Z");
    fs.utimesSync(oldPath, oldTime, oldTime);
    fs.utimesSync(freshPath, freshTime, freshTime);

    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks: []
policies: []
memory:
  directories:
    - path: ${path.join(home, "memory/dir")}
      scope: project
  retention:
    staleness_days: 30
`,
      "utf8",
    );
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      now,
      pathEnv: "",
    });
    const stalePaths = report.memory.staleMemories.map((m) => m.path);
    expect(stalePaths).toContain(oldPath);
    expect(stalePaths).not.toContain(freshPath);
    const text = format(report);
    expect(text).toContain("haven't been touched");
    expect(text).toContain("2025-09-01");
  });
});

describe("doctor — summary counts", () => {
  it("counts errors and warnings across sections", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: missing-hook
    event: SessionStart
    command: ${path.join("{{HOME}}", "no-such.sh")}
    blocking: false
policies: []
tools:
  mcp:
    - name: dead
      command: [/usr/bin/true]
      health:
        verb: x
      enabled: true
  cli:
    - name: optional-missing
      binary: this-cannot-exist-00000
      required: false
  builtin:
    known: []
`.replace("{{HOME}}", "${HOME}"),
    });
    const manifestPath = path.join(home, "harness.yaml");
    let contents = fs.readFileSync(manifestPath, "utf8");
    contents = contents.replace("${HOME}", home);
    fs.writeFileSync(manifestPath, contents, "utf8");

    const report = await doctor({
      configPath: manifestPath,
      homeOverride: home,
      mcpProbe: new FakeProbe({
        dead: { kind: "error", latencyMs: 50, message: "exit 1" },
      }),
      pathEnv: "/nonexistent",
      versionProbe: () => null,
    });
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toMatch(/\d+ errors?/);
    expect(text).toMatch(/\d+ warnings?/);
  });
});

describe("doctor — full reference manifest header line", () => {
  it("includes the manifest path, version, and shallow tag when --shallow is set", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      pathEnv: "",
    });
    const text = format(report);
    expect(text).toMatch(new RegExp(`^harness ${VERSION.replace(/\./g, "\\.")}`));
    expect(text).toContain(`(version 1) [shallow]`);
  });
});

describe("doctor — policy producer-gap check (task ce50df99)", () => {
  // alpha: block + within, no hook produces `alpha:` → GAP
  // beta:  block + within, `produce-beta` hook produces `beta:` → no gap
  // gamma: block, NO within → no gap (one-time tag, satisfied by workflow)
  // delta: `warn` enforcement + within, no producer → no gap (not block)
  // epsilon: block + within; the ONLY hook whose command contains
  //          `epsilon` is epsilon's own consumer hook, which the
  //          `h.name !== policy.hook` exclusion must skip → GAP
  // zeta:  block + within, leading-colon tag `:zeta` → empty prefix,
  //        must not vacuously match every hook → GAP
  // eta:   block + within, NO automatic producer hook, but the policy
  //        itself declares a `producers:` array (task f97e152f) →
  //        the schema-blessed manual recovery path counts as documented
  //        producer → NO GAP (suppression refinement)
  const MANIFEST = `version: 1
tools:
  builtin:
    known: [Read, Edit, Bash]
hooks:
  - name: consume-alpha
    event: PreToolUse
    match: Bash
    command: harness policy intercept
    blocking: hard
  - name: consume-beta
    event: PreToolUse
    match: Bash
    command: harness policy intercept
    blocking: hard
  - name: produce-beta
    event: SessionStart
    command: beta-runner --emit
    blocking: soft
  - name: consume-gamma
    event: PreToolUse
    match: Bash
    command: harness policy intercept
    blocking: hard
  - name: consume-delta
    event: PreToolUse
    match: Bash
    command: harness policy intercept
    blocking: hard
  - name: epsilon-policy-runner
    event: PreToolUse
    match: Bash
    command: harness policy intercept --pack epsilon
    blocking: hard
  - name: consume-zeta
    event: PreToolUse
    match: Bash
    command: harness policy intercept
    blocking: hard
  - name: consume-eta
    event: PreToolUse
    match: Bash
    command: harness policy intercept
    blocking: hard
policies:
  - name: alpha-gate
    description: gated on a freshness-windowed alpha tag with no producer
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "alpha:\${REPO}"
      within: 1h
    hook: consume-alpha
    enforcement: block
  - name: beta-gate
    description: gated on beta, but a SessionStart hook produces it
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "beta:\${REPO}"
      within: 1h
    hook: consume-beta
    enforcement: block
  - name: gamma-gate
    description: block policy with no within window
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "gamma:\${REPO}"
    hook: consume-gamma
    enforcement: block
  - name: delta-gate
    description: warn-enforcement policy with a within window
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "delta:\${REPO}"
      within: 1h
    hook: consume-delta
    enforcement: warn
  - name: epsilon-gate
    description: its own consumer hook command names the prefix, but must not self-satisfy
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "epsilon:\${REPO}"
      within: 1h
    hook: epsilon-policy-runner
    enforcement: block
  - name: zeta-gate
    description: leading-colon tag yields an empty prefix
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: ":zeta"
      within: 1h
    hook: consume-zeta
    enforcement: block
  - name: eta-gate
    description: block + within, no automatic producer, but documents a manual producer in producers[]
    trigger:
      event: PreToolUse
      match: Bash
    requires:
      ledger_tag: "eta:\${REPO}"
      within: 1h
    hook: consume-eta
    enforcement: block
    producers:
      - kind: mcp
        verb: mcp__agent-grounding__ledger_add
        example: '{type:"fact", content:"eta:\${REPO} (operator-driven smoke summary)"}'
        description: Document what was exercised so the gate has an auditable manual recovery path.
`;

  async function run() {
    const home = makeFixture({ "harness.yaml": MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "",
      // Stub npm bin probe to the silent "unknown" branch (non-zero
      // exit) so the new check (task 4ddd78ed) does not add an
      // env-dependent warning to the count assertion below. The real
      // probe is covered by its own test file with all three branches.
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
    });
    return report;
  }

  it("flags a block policy whose within-gated tag has no producer hook", async () => {
    const report = await run();
    const alpha = report.policies.find((p) => p.name === "alpha-gate");
    expect(alpha?.producerGap).toEqual({ ledgerTag: "alpha:${REPO}", within: "1h" });
  });

  it("does not flag a policy whose tag IS produced by a manifest hook", async () => {
    const report = await run();
    const beta = report.policies.find((p) => p.name === "beta-gate");
    expect(beta?.producerGap).toBeUndefined();
  });

  it("does not flag a block policy without a within window", async () => {
    const report = await run();
    const gamma = report.policies.find((p) => p.name === "gamma-gate");
    expect(gamma?.producerGap).toBeUndefined();
  });

  it("does not flag a warn-enforcement policy even with a within window", async () => {
    const report = await run();
    const delta = report.policies.find((p) => p.name === "delta-gate");
    expect(delta?.producerGap).toBeUndefined();
  });

  it("excludes the policy's own consumer hook from producer detection", async () => {
    const report = await run();
    const epsilon = report.policies.find((p) => p.name === "epsilon-gate");
    // epsilon-policy-runner is epsilon-gate's `hook:` (the consumer) AND
    // its command literally contains `epsilon`. It must not count as the
    // producer of `epsilon:` — the `h.name !== policy.hook` exclusion is
    // what keeps this a gap; drop that clause and this test fails.
    expect(epsilon?.producerGap).toEqual({
      ledgerTag: "epsilon:${REPO}",
      within: "1h",
    });
  });

  it("does not let a leading-colon (empty-prefix) tag vacuously match every hook", async () => {
    const report = await run();
    const zeta = report.policies.find((p) => p.name === "zeta-gate");
    // `:zeta` has an empty prefix; a naive `command.includes("")` would
    // match every hook and silently suppress the gap. It must still flag.
    expect(zeta?.producerGap).toEqual({ ledgerTag: ":zeta", within: "1h" });
  });

  it("does not flag a policy that declares a non-empty producers[] array (task f97e152f)", async () => {
    const report = await run();
    const eta = report.policies.find((p) => p.name === "eta-gate");
    // eta-gate has NO automatic producer hook but DOES declare a
    // producers[] entry. The producers field IS the schema-blessed
    // manual recovery path (the agent sees it in the deny envelope),
    // so doctor must not flag a gap that doesn't exist from the
    // agent's perspective. Drop the `p.producers === undefined || ...`
    // clause in buildPolicies and this test fails.
    expect(eta?.producerGap).toBeUndefined();
  });

  it("counts each producer gap as a warning and renders the ⚠ line", async () => {
    const report = await run();
    const gaps = report.policies.filter((p) => p.producerGap);
    expect(gaps.map((p) => p.name).sort()).toEqual([
      "alpha-gate",
      "epsilon-gate",
      "zeta-gate",
    ]);
    // This fixture declares no `memory:` block, which on its own yields
    // exactly one warning ("no memory router declared"). The three
    // producer gaps push the total to 4 — proving each gap is counted.
    expect(report.warningCount).toBe(4);
    const text = format(report);
    expect(text).toContain(
      "⚠ alpha-gate  requires fresh `alpha:${REPO}` (within 1h) but no manifest hook produces it",
    );
    expect(text).toContain("add a producer hook (e.g. a SessionStart runner)");
    // Refinement (task f97e152f): warning text now also names the
    // schema-blessed manual recovery path so operators do not assume
    // the only way out is a SessionStart hook.
    expect(text).toContain("OR document the manual recovery path in the policy's `producers:` array");
    expect(text).toContain("✓ beta-gate");
    expect(text).toContain("✓ gamma-gate");
    // eta-gate is the producers-suppression case: must render as ✓
    // (no ⚠ line) even though it has within + no automatic producer.
    expect(text).toContain("✓ eta-gate");
    expect(text).not.toMatch(/⚠ eta-gate/);
  });
});


describe("doctor — policy pack declared-but-not-live check", () => {
  // expandPolicyPacks silently skips a pack whose `source:` is
  // unrecognised or whose builtin name doesn't resolve — its hooks
  // never reach the runtime, so the gate is inert. The operator
  // believes the pack is wired (it's in `policy_packs[]`) but it's a
  // no-op. Doctor must flag the gap as an error so the misconfig is
  // impossible to miss.

  it("flags a pack with an unknown source as declared-but-not-live", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: marketplace-that-does-not-exist-yet
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.unresolved).toHaveLength(1);
    expect(report.policyPacks.unresolved[0]).toMatchObject({
      name: "understanding-before-execution",
      reason: "unknown_source",
      source: "marketplace-that-does-not-exist-yet",
    });
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("✗ understanding-before-execution");
    expect(text).toContain('source "marketplace-that-does-not-exist-yet" is not recognised');
    expect(text).toContain("declared but not live");
  });

  it("flags a builtin pack whose name doesn't resolve", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-executon
    source: builtin
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.unresolved).toHaveLength(1);
    expect(report.policyPacks.unresolved[0]).toMatchObject({
      name: "understanding-before-executon",
      reason: "unknown_builtin_name",
    });
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("✗ understanding-before-executon");
    expect(text).toContain("not a known builtin pack name");
  });

  it("stays silent when every declared pack resolves", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.unresolved).toHaveLength(0);
    expect(format(report)).not.toContain("Policy Packs");
  });

  it("ignores disabled packs — they aren't expected to be live", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-executon
    source: builtin
    enabled: false
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.unresolved).toHaveLength(0);
  });

  // Per-pack config schema (task d78fb3c7). Doctor mirrors validate's
  // per-pack `configSchema` check so the gap is caught at health-check
  // time even when an operator skips `harness validate` between edits.

  it("flags a config key/value rejected by the pack's schema", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: fastConfirm
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.configIssues).toHaveLength(1);
    expect(report.policyPacks.configIssues[0]).toMatchObject({
      name: "understanding-before-execution",
      configPath: "mode",
    });
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("✗ understanding-before-execution.config.mode");
    expect(text).toContain("rejected by the pack's config schema");
  });

  it("flags a typo'd top-level config key (strict mode)", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      permision_profile: safe-start
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.configIssues).toHaveLength(1);
    expect(report.policyPacks.configIssues[0]?.message).toMatch(
      /permision_profile/,
    );
  });

  it("stays silent when every declared pack's config is clean", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: fast_confirm
      permission_profile: safe-start
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.unresolved).toHaveLength(0);
    expect(report.policyPacks.configIssues).toHaveLength(0);
    expect(format(report)).not.toContain("Policy Packs");
  });

  // Per-pack min_version floor (task bd154095). Mirrors the hook-level
  // version-probe contract: warn-not-error, counts toward warningCount.

  it("flags a pack-level min_version above the installed bin (below_floor)", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    min_version: 0.99.0
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
      versionProbe: () => "understanding-gate 0.3.1",
    });
    expect(report.policyPacks.versionGaps).toHaveLength(1);
    expect(report.policyPacks.versionGaps[0]).toMatchObject({
      name: "understanding-before-execution",
      declaredMinVersion: "0.99.0",
      actualVersion: "0.3.1",
    });
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    expect(report.errorCount).toBe(0);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("⚠ understanding-before-execution.min_version");
    expect(text).toContain("0.3.1");
    expect(text).toContain("0.99.0");
    expect(text).toContain("degraded mode");
  });

  it("stays silent when the installed bin meets the declared floor", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    min_version: 0.3.0
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
      versionProbe: () => "understanding-gate 0.3.1",
    });
    expect(report.policyPacks.versionGaps).toHaveLength(0);
    expect(format(report)).not.toContain("Policy Packs");
  });

  it("missing min_version stays silent regardless of probe", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
      versionProbe: () => null,
    });
    expect(report.policyPacks.versionGaps).toHaveLength(0);
  });

  it("flags no_probe_registered when an operator declares a floor for a probe-less pack", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: branch-protection
    source: builtin
    min_version: 1.0.0
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.versionGaps).toHaveLength(1);
    expect(report.policyPacks.versionGaps[0]?.message).toMatch(
      /no version probe registered/,
    );
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
  });
});

describe("doctor — policy pack ux/producers drift check (task 68b9ad9c)", () => {
  // Motivation: the understanding-gate deny message is entirely driven by
  // config.ux when the operator has declared one. The init templates
  // taught a new heredoc submission form (agent-tasks/e48e3b45), but that
  // fix only reaches manifests generated AFTER the fix — an
  // already-installed manifest's config.ux stays on the old wording
  // until something re-seeds it. This check is the "something noticed"
  // half of the fix (harness pack reseed is the "something fixed it"
  // half).

  const STALE_UX_MANIFEST = `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: grill_me
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Run \`harness approve understanding\` once you have produced and confirmed an Understanding Report."
`;

  it("flags a manifest whose ux.run still teaches the pre-fix bare-command wording", async () => {
    const home = makeFixture({ "harness.yaml": STALE_UX_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(1);
    expect(report.policyPacks.uxDrift[0]).toMatchObject({
      name: "understanding-before-execution",
      fields: ["ux"],
    });
    expect(report.policyPacks.uxDrift[0]?.message).toMatch(/harness pack reseed/);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("⚠ understanding-before-execution.config.ux");
  });

  it("stays silent when config.ux already matches the shipped template", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: grill_me
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)"
          - "Run \`harness approve understanding\` with the report attached as a quoted heredoc (harness approve understanding <<'UNDERSTANDING_REPORT' ...report... UNDERSTANDING_REPORT) so it is persisted for audit, then approve the prompt; the heredoc is the only extra shell shape the gate allows (no pipes, chaining, or other redirection)"
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(0);
    expect(format(report)).not.toContain("Policy Packs");
  });

  it("compares against the mode-appropriate shipped default, not a hardcoded mode", async () => {
    // `strict` mode's canonical `required:` line differs from
    // `grill_me`'s (understandingApprovalRequirement). A manifest on
    // strict mode with the strict-appropriate ux must NOT be flagged just
    // because it differs from grill_me's wording.
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: strict
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "a human-approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)"
          - "Run \`harness approve understanding\` with the report attached as a quoted heredoc (harness approve understanding <<'UNDERSTANDING_REPORT' ...report... UNDERSTANDING_REPORT) so it is persisted for audit, then approve the prompt; the heredoc is the only extra shell shape the gate allows (no pipes, chaining, or other redirection)"
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(0);
  });

  it("does not flag a manifest with no config.ux at all (missing is a distinct, out-of-scope gap)", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: understanding-before-execution
    source: builtin
    config:
      mode: grill_me
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(0);
  });

  it("disabled packs are not checked", async () => {
    const home = makeFixture({ "harness.yaml": STALE_UX_MANIFEST.replace(
      "source: builtin\n",
      "source: builtin\n    enabled: false\n",
    ) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(0);
  });

  it("flags branch-protection's stale ux the same way", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: branch-protection
    source: builtin
    config:
      ux:
        cannot: "branch-protection: refusing edit on protected branch."
        required:
          - "a non-protected branch"
        run:
          - "git checkout -b feat/x"
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(1);
    expect(report.policyPacks.uxDrift[0]?.name).toBe("branch-protection");
  });

  it("solution-acceptance has no registered shipped default, so its ux is never flagged (even enabled)", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
    enabled: true
    config:
      ux:
        cannot: "whatever custom text"
        required:
          - "whatever"
        run:
          - "whatever"
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.policyPacks.uxDrift).toHaveLength(0);
  });
});

describe("doctor — solution-acceptance producer checks", () => {
  // These tests verify that doctor surfaces the same two deadlock
  // misconfigurations that `harness validate` already surfaces via
  // `checkSolutionAcceptanceProducer` (single source of truth).

  it("errors when solution-acceptance is enabled but grounding-mcp is absent", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(1);
    expect(report.policyPacks.solutionAcceptance[0]).toMatchObject({
      severity: "error",
      path: "policy_packs",
    });
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("✗ policy_packs");
    expect(text).toContain("grounding-mcp");
  });

  it("warns when grounding-mcp has a relative SOLUTION_VERDICT_DIR", async () => {
    // Baseline: an identical fixture but with an ABSOLUTE dir, which emits
    // no solution-acceptance warning. The minimal fixture independently
    // emits other warnings (e.g. a missing memory router), so a bare
    // `warningCount >= 1` would pass even if the countDiagnostics warning
    // tally were dropped. Assert the +1 delta against the baseline instead
    // so removing that tally turns this test red.
    const baselineHome = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
tools:
  mcp:
    - name: grounding-mcp
      command: [/usr/bin/true]
      env:
        SOLUTION_VERDICT_DIR: /absolute/path/to/verdicts
      enabled: true
`,
    });
    const baseline = await doctor({
      configPath: path.join(baselineHome, "harness.yaml"),
      homeOverride: baselineHome,
      shallow: true,
    });
    expect(baseline.policyPacks.solutionAcceptance).toHaveLength(0);

    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
tools:
  mcp:
    - name: grounding-mcp
      command: [/usr/bin/true]
      env:
        SOLUTION_VERDICT_DIR: ./relative/path
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(1);
    expect(report.policyPacks.solutionAcceptance[0]).toMatchObject({
      severity: "warning",
      path: "tools.mcp",
    });
    // The relative-dir variant differs from the absolute-dir baseline by
    // exactly the one solution-acceptance warning; the home-derived and
    // cwd-derived warnings are identical across both runs, so the tally
    // contributes exactly +1.
    expect(report.warningCount).toBe(baseline.warningCount + 1);
    expect(report.errorCount).toBe(0);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("⚠ tools.mcp");
    expect(text).toContain("SOLUTION_VERDICT_DIR");
  });

  it("is silent when the pack is disabled", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
    enabled: false
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(0);
  });

  it("is silent when grounding-mcp is present with no SOLUTION_VERDICT_DIR override", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
tools:
  mcp:
    - name: grounding-mcp
      command: [/usr/bin/true]
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(0);
    expect(format(report)).not.toContain("Policy Packs");
  });

  it("is silent when grounding-mcp has an absolute SOLUTION_VERDICT_DIR", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
tools:
  mcp:
    - name: grounding-mcp
      command: [/usr/bin/true]
      env:
        SOLUTION_VERDICT_DIR: /absolute/path/to/verdicts
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(0);
    expect(format(report)).not.toContain("Policy Packs");
  });
});

describe("doctor — solution-acceptance knob-ignored check (task 24f6ceb9)", () => {
  // Parity with `harness validate`'s checkSolutionAcceptanceKnobIgnored
  // (single source of truth); the diagnostic lands in the same
  // `policyPacks.solutionAcceptance` array as the producer checks, so
  // counting and rendering are inherited.
  const PACK_WITH_PRODUCER = `version: 1
hooks: []
policies: []
policy_packs:
  - name: solution-acceptance
    source: builtin
tools:
  mcp:
    - name: grounding-mcp
      command: [/usr/bin/true]
      enabled: true
`;

  it("warns when the knob path is git-ignored (explicit probe wins over shallow)", async () => {
    const baselineHome = makeFixture({ "harness.yaml": PACK_WITH_PRODUCER });
    const baseline = await doctor({
      configPath: path.join(baselineHome, "harness.yaml"),
      homeOverride: baselineHome,
      shallow: true,
      gitIgnoreProbe: () => false,
    });
    expect(baseline.policyPacks.solutionAcceptance).toHaveLength(0);

    const home = makeFixture({ "harness.yaml": PACK_WITH_PRODUCER });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      gitIgnoreProbe: () => true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(1);
    expect(report.policyPacks.solutionAcceptance[0]).toMatchObject({
      severity: "warning",
      path: "policy_packs",
    });
    // Probe-true differs from the probe-false baseline by exactly this
    // one warning (same tally-delta pattern as the relative-dir test).
    expect(report.warningCount).toBe(baseline.warningCount + 1);
    expect(report.errorCount).toBe(0);
    const text = format(report);
    expect(text).toContain("Policy Packs");
    expect(text).toContain("⚠ policy_packs");
    expect(text).toContain("git-ignored");
  });

  it("skips the probe entirely in shallow runs without an explicit probe", async () => {
    const home = makeFixture({ "harness.yaml": PACK_WITH_PRODUCER });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.policyPacks.solutionAcceptance).toHaveLength(0);
  });

  // The doctor-level shallow test above cannot distinguish "no spawn"
  // from "spawned and answered false" (this repo does not ignore the
  // knob), so the no-spawn contract is pinned by identity on the
  // resolver instead of mocking node:child_process (review finding on
  // task 24f6ceb9).
  it("resolveGitIgnoreProbe: explicit probe > shallow sentinel > real probe", () => {
    expect(resolveGitIgnoreProbe({ shallow: true })).toBe(NULL_GIT_IGNORE_PROBE);
    expect(resolveGitIgnoreProbe({})).not.toBe(NULL_GIT_IGNORE_PROBE);
    const explicit = () => true as const;
    expect(resolveGitIgnoreProbe({ shallow: true, gitIgnoreProbe: explicit })).toBe(
      explicit,
    );
    expect(NULL_GIT_IGNORE_PROBE(".ai/solution-acceptance.json")).toBe(null);
  });
});

describe("doctor — npm global-bin PATH check (task 4ddd78ed)", () => {
  const MIN_MANIFEST = `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read, Edit]
`;

  it("renders the warning section when npm bin dir is not on PATH", async () => {
    const home = makeFixture({ "harness.yaml": MIN_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({
        code: 0,
        stdout: "/home/lan/.nvm/versions/node/v22.22.0\n",
        stderr: "",
      }),
    });
    expect(report.npmGlobalBin?.status).toBe("warn");
    expect(report.npmGlobalBin?.binDir).toBe(
      "/home/lan/.nvm/versions/node/v22.22.0/bin",
    );
    const text = format(report);
    expect(text).toMatch(/\nEnvironment\n/);
    expect(text).toContain(
      "⚠ npm global bin (/home/lan/.nvm/versions/node/v22.22.0/bin) is not on PATH",
    );
    expect(text).toContain(
      `export PATH="/home/lan/.nvm/versions/node/v22.22.0/bin:$PATH"`,
    );
  });

  it("renders no Environment section when npm bin dir IS on PATH (no noise)", async () => {
    const home = makeFixture({ "harness.yaml": MIN_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "/usr/bin" + path.delimiter + "/usr/local/bin",
      npmBinExec: async () => ({ code: 0, stdout: "/usr/local\n", stderr: "" }),
    });
    expect(report.npmGlobalBin?.status).toBe("ok");
    const text = format(report);
    expect(text).not.toMatch(/\nEnvironment\n/);
    expect(text).not.toMatch(/⚠ npm global bin/);
  });

  it("stays silent on the unknown branch (npm missing / errored)", async () => {
    const home = makeFixture({ "harness.yaml": MIN_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 127, stdout: "", stderr: "command not found" }),
    });
    expect(report.npmGlobalBin?.status).toBe("unknown");
    const text = format(report);
    expect(text).not.toMatch(/\nEnvironment\n/);
  });

  it("skips the npm-bin probe entirely under --shallow (no field on report)", async () => {
    const home = makeFixture({ "harness.yaml": MIN_MANIFEST });
    let probeCalled = false;
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "/usr/bin",
      shallow: true,
      npmBinExec: async () => {
        probeCalled = true;
        return { code: 0, stdout: "/should/not/be/called\n", stderr: "" };
      },
    });
    // Shallow contract: the npm-bin probe must not spawn, and the
    // report field must be absent (not just "unknown").
    expect(probeCalled).toBe(false);
    expect(report.npmGlobalBin).toBeUndefined();
    const text = format(report);
    expect(text).not.toMatch(/\nEnvironment\n/);
  });

  it("warns roll into warningCount", async () => {
    const home = makeFixture({ "harness.yaml": MIN_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "/usr/bin",
      npmBinExec: async () => ({ code: 0, stdout: "/opt/node\n", stderr: "" }),
    });
    // The minimal manifest also misses memory.router (+1 warning); the
    // npm-bin warn adds another. We assert the npm one is included by
    // checking that the count exceeds the no-npm-warn baseline.
    expect(report.warningCount).toBeGreaterThanOrEqual(2);
  });
});

describe("doctor — MCP min_version", () => {
  function buildManifest(mcpBlock: string): string {
    return `version: 1
hooks: []
policies: []
tools:
  mcp:
${mcpBlock}
  builtin:
    known: []
`;
  }

  it("emits no entry for MCP servers without min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    - name: bare
      command: [/usr/bin/true]`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({ bare: { kind: "missing-verb" } }),
      versionProbe: () => "v0.1.0\n",
      pathEnv: "",
    });
    expect(report.tools.mcpVersions).toEqual([]);
  });

  it("emits ok when the probed version meets min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    - name: ok-mcp
      command: [my-mcp-bin]
      min_version: "0.5.0"`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({ "ok-mcp": { kind: "missing-verb" } }),
      versionProbe: (cmd) => (cmd[0] === "my-mcp-bin" ? "my-mcp-bin v0.6.1\n" : null),
      pathEnv: "",
    });
    expect(report.tools.mcpVersions).toEqual([
      { name: "ok-mcp", status: "ok", message: "v0.6.1 ≥ 0.5.0" },
    ]);
    // The fixture has no `memory:` block, so a baseline "no memory
    // router declared" warning is expected; assert no version-check
    // warning surfaced on top of it.
    const versionWarnings = report.tools.mcpVersions.filter((v) => v.status === "warn").length;
    expect(versionWarnings).toBe(0);
  });

  it("emits warn (not error) and counts when the probed version is below min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    - name: stale-mcp
      command: [stale-bin]
      min_version: "0.5.0"`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({ "stale-mcp": { kind: "missing-verb" } }),
      versionProbe: () => "stale-bin v0.2.0\n",
      pathEnv: "",
    });
    expect(report.tools.mcpVersions).toEqual([
      {
        name: "stale-mcp",
        status: "warn",
        message: "outdated: installed v0.2.0 < required 0.5.0",
      },
    ]);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("outdated: installed v0.2.0 < required 0.5.0");
  });

  it("skips disabled servers even when min_version is set", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    - name: skipped
      command: [skipped-bin]
      enabled: false
      min_version: "9.9.9"`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => {
        throw new Error("versionProbe must not be invoked for a disabled server");
      },
      pathEnv: "",
    });
    expect(report.tools.mcpVersions).toEqual([]);
  });

  it("warns when the version probe fails or returns no parseable version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    - name: probe-fail
      command: [missing-bin]
      min_version: "0.1.0"
    - name: garbled
      command: [garbled-bin]
      min_version: "0.1.0"`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({
        "probe-fail": { kind: "missing-verb" },
        garbled: { kind: "missing-verb" },
      }),
      versionProbe: (cmd) => (cmd[0] === "garbled-bin" ? "no number in here\n" : null),
      pathEnv: "",
    });
    const byName = Object.fromEntries(report.tools.mcpVersions.map((v) => [v.name, v]));
    expect(byName["probe-fail"]?.status).toBe("warn");
    expect(byName["probe-fail"]?.message).toMatch(/version probe failed/);
    expect(byName.garbled?.status).toBe("warn");
    expect(byName.garbled?.message).toMatch(/could not parse a version/);
  });

  it("honours an explicit version_command override", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    - name: custom
      command: [custom-bin]
      min_version: "1.0.0"
      version_command: [custom-bin, "--print-version"]`),
    });
    let received: readonly string[] | null = null;
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({ custom: { kind: "missing-verb" } }),
      versionProbe: (cmd) => {
        received = cmd;
        return "1.2.3\n";
      },
      pathEnv: "",
    });
    expect(received).toEqual(["custom-bin", "--print-version"]);
    expect(report.tools.mcpVersions[0]?.status).toBe("ok");
  });
});

describe("doctor — hooks[] min_version", () => {
  function buildManifest(hooks: string): string {
    return `version: 1
hooks:
${hooks}
policies: []
tools:
  builtin:
    known: []
`;
  }

  it("emits no version line for hooks without min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`  - name: bare-hook
    event: SessionStart
    command: /usr/bin/true
    blocking: false`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => "v9.9.9\n",
      pathEnv: "",
    });
    expect(report.hooks[0]?.version).toBeUndefined();
  });

  it("warns when the probed hook version is below min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`  - name: stale-hook
    event: SessionStart
    command: /usr/bin/true
    blocking: false
    min_version: "0.5.0"
    version_command: [my-hook-bin, "--version"]`),
    });
    let received: readonly string[] | null = null;
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: (cmd) => {
        received = cmd;
        return "my-hook-bin v0.2.0\n";
      },
      pathEnv: "",
    });
    expect(received).toEqual(["my-hook-bin", "--version"]);
    expect(report.hooks[0]?.version).toEqual({
      status: "warn",
      message: "outdated: installed v0.2.0 < required 0.5.0",
    });
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("⚠ version: outdated: installed v0.2.0 < required 0.5.0");
  });

  it("emits ok when the probed hook version meets min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`  - name: ok-hook
    event: SessionStart
    command: /usr/bin/true
    blocking: false
    min_version: "0.5.0"
    version_command: [my-hook-bin, "--version"]`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => "my-hook-bin v0.6.0\n",
      pathEnv: "",
    });
    expect(report.hooks[0]?.version).toEqual({
      status: "ok",
      message: "v0.6.0 ≥ 0.5.0",
    });
  });

  it("rejects min_version without version_command at schema-validation time", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`  - name: bad-hook
    event: SessionStart
    command: /usr/bin/true
    blocking: false
    min_version: "0.5.0"`),
    });
    await expect(
      doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        mcpProbe: new FakeProbe({}),
        versionProbe: () => null,
        pathEnv: "",
      }),
    ).rejects.toThrow(/version_command/);
  });
});

describe("doctor — memory.router min_version", () => {
  function buildManifest(routerBlock: string): string {
    return `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: []
memory:
  router:
${routerBlock}
`;
  }

  it("emits no routerVersion entry when min_version is absent", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    command: [/usr/bin/true]`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => "v0.9.0\n",
      pathEnv: "",
    });
    expect(report.memory.routerVersion).toBeUndefined();
  });

  it("warns when the probed router version is below min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    command: [/usr/bin/true]
    min_version: "0.5.0"
    version_command: ["/usr/bin/true", "--version"]`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => "router v0.1.0\n",
      pathEnv: "",
    });
    expect(report.memory.routerVersion).toEqual({
      status: "warn",
      message: "outdated: installed v0.1.0 < required 0.5.0",
    });
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("⚠ version: outdated: installed v0.1.0 < required 0.5.0");
  });

  it("emits ok when the probed router version meets min_version", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    command: [/usr/bin/true]
    min_version: "0.5.0"
    version_command: ["/usr/bin/true", "--version"]`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => "router v0.6.0\n",
      pathEnv: "",
    });
    expect(report.memory.routerVersion).toEqual({
      status: "ok",
      message: "v0.6.0 ≥ 0.5.0",
    });
  });

  it("skips the router version check when the router executable is missing", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(`    command: [/this/does/not/exist/router]
    min_version: "0.5.0"
    version_command: ["/this/does/not/exist/router", "--version"]`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => {
        throw new Error("versionProbe must not be invoked when the router executable is missing");
      },
      pathEnv: "",
    });
    expect(report.memory.routerVersion).toBeUndefined();
  });
});

describe("doctor — Phase 7 #6 Risk Gate section", () => {
  const RISK_GATE_MANIFEST = `version: 1
hooks:
  - name: risk-gate
    event: PreToolUse
    command: /usr/bin/true
    blocking: false
risk:
  classifiers:
    - name: dangerous-shell
      tool: Bash
      patterns:
        - { pattern: 'terraform destroy', categories: [destructive], severity: critical }
environments:
  resolvers:
    - name: prod
      environment: production
      signals: { branch_patterns: [main] }
policies:
  - name: gate-prod-destructive
    description: gate destructive prod actions
    trigger: { event: PreToolUse, match: "Bash" }
    when: { environment.name: production }
    requires: { ledger_tag: "risk-approved:\${SESSION_ID}" }
    hook: risk-gate
    enforcement: require_approval
`;

  it("reports coherent wiring when classifiers, resolvers, and a when: policy are all present", async () => {
    const home = makeFixture({ "harness.yaml": RISK_GATE_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate).toEqual({
      classifiers: 1,
      resolvers: 1,
      whenPolicies: 1,
      warnings: [],
    });
    expect(format(report)).toContain("Risk Gate");
    expect(format(report)).toContain("1 classifier, 1 environment resolver, 1 policy with when:");
    expect(format(report)).toContain("✓ wiring coherent");
  });

  it("pluralizes the Risk Gate count line when 2+ policies declare when:", async () => {
    const twoWhenPolicies = RISK_GATE_MANIFEST.replace(
      "policies:\n  - name: gate-prod-destructive\n",
      "policies:\n  - name: gate-prod-destructive-2\n" +
        "    description: second when-policy to exercise plural rendering\n" +
        "    trigger: { event: PreToolUse, match: \"Bash\" }\n" +
        "    when: { environment.name: production }\n" +
        "    requires: { ledger_tag: \"risk-approved:${SESSION_ID}\" }\n" +
        "    hook: risk-gate\n" +
        "    enforcement: require_approval\n" +
        "  - name: gate-prod-destructive\n",
    );
    const home = makeFixture({ "harness.yaml": twoWhenPolicies });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate.whenPolicies).toBe(2);
    const formatted = format(report);
    expect(formatted).toContain("1 classifier, 1 environment resolver, 2 policies with when:");
    expect(formatted).toContain("✓ wiring coherent");
    expect(formatted).not.toContain("policy policies");
    expect(formatted).not.toContain("policys");
  });

  it("warns when a when: policy is declared but no classifier exists", async () => {
    const noClassifier = RISK_GATE_MANIFEST.replace(
      /risk:\n  classifiers:\n( {4}.*\n| {6,}.*\n)+/,
      "risk:\n  classifiers: []\n",
    );
    const home = makeFixture({ "harness.yaml": noClassifier });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate.classifiers).toBe(0);
    expect(report.riskGate.whenPolicies).toBe(1);
    expect(report.riskGate.warnings.length).toBeGreaterThan(0);
    expect(report.riskGate.warnings[0]).toMatch(/no `risk.classifiers/);
    // The coherence warning rolls into the doctor warning tally.
    expect(report.warningCount).toBeGreaterThan(0);
  });

  it("stays silent when the manifest configures no Risk Gate surface", async () => {
    const home = makeFixture({
      "harness.yaml": "version: 1\nhooks: []\npolicies: []\n",
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate).toEqual({
      classifiers: 0,
      resolvers: 0,
      whenPolicies: 0,
      warnings: [],
    });
    expect(format(report)).not.toContain("Risk Gate");
  });

  // Task f1df7c2d Bug B: per Phase 7 #5's "unknown is not safe" rule, an
  // unclassified envelope satisfies every risk-derived clause, so a
  // policy that gates on `risk.*` without `environment.name` fires on
  // EVERY Bash command. Warn the operator so the misconfiguration is
  // visible at doctor-time rather than at first-block-time.
  const RISK_UNSCOPED_MANIFEST = `version: 1
hooks:
  - name: risk-gate
    event: PreToolUse
    command: /usr/bin/true
    blocking: false
risk:
  classifiers:
    - name: dangerous-shell
      tool: Bash
      patterns:
        - { pattern: 'terraform destroy', categories: [destructive], severity: critical }
environments:
  resolvers:
    - name: prod
      environment: production
      signals: { branch_patterns: [main] }
policies:
  - name: gate-high-risk
    description: missing environment.name scope
    trigger: { event: PreToolUse, match: "Bash" }
    when: { risk.severity_at_least: high }
    requires: { ledger_tag: "risk-approved:\${SESSION_ID}" }
    hook: risk-gate
    enforcement: require_approval
`;

  it("warns when a policy gates on risk.* without an environment.name scope", async () => {
    const home = makeFixture({ "harness.yaml": RISK_UNSCOPED_MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate.warnings.some((w) => w.includes("gate-high-risk"))).toBe(true);
    expect(report.riskGate.warnings.some((w) => w.includes("environment.name"))).toBe(true);
    expect(report.warningCount).toBeGreaterThan(0);
  });

  it("does not warn when the same policy also carries environment.name", async () => {
    const scoped = RISK_UNSCOPED_MANIFEST.replace(
      "when: { risk.severity_at_least: high }",
      "when: { risk.severity_at_least: high, environment.name: production }",
    );
    const home = makeFixture({ "harness.yaml": scoped });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate.warnings.filter((w) => w.includes("gate-high-risk"))).toHaveLength(0);
  });

  it("warns when a policy gates on risk.category_in without an environment.name scope", async () => {
    const categoryUnscoped = RISK_UNSCOPED_MANIFEST.replace(
      "when: { risk.severity_at_least: high }",
      "when: { risk.category_in: [destructive] }",
    );
    const home = makeFixture({ "harness.yaml": categoryUnscoped });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate.warnings.some((w) => w.includes("gate-high-risk"))).toBe(true);
  });

  it("warns when a policy gates on action.reversible without an environment.name scope", async () => {
    // action.reversible also fails-closed to matched=true for an unclassified
    // action (when-eval.ts sets unclassifiedFallback=true on the reversible
    // arm, exactly like severity/category). Mutation guard: removing
    // action.reversible from the checkPolicyRiskWithoutEnvScope check would
    // make this test go red (no warning emitted).
    const reversibleUnscoped = RISK_UNSCOPED_MANIFEST.replace(
      "when: { risk.severity_at_least: high }",
      "when: { action.reversible: false }",
    );
    const home = makeFixture({ "harness.yaml": reversibleUnscoped });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(report.riskGate.warnings.some((w) => w.includes("gate-high-risk"))).toBe(true);
    expect(report.riskGate.warnings.some((w) => w.includes("environment.name"))).toBe(true);
  });

  it("does not warn on action.reversible when environment.name is also present (negative control)", async () => {
    // Mutation guard: removing the hasEnvNameScope guard from
    // checkPolicyRiskWithoutEnvScope would make this test go red (warning
    // would fire even with environment.name present).
    const reversibleScoped = RISK_UNSCOPED_MANIFEST.replace(
      "when: { risk.severity_at_least: high }",
      "when: { action.reversible: false, environment.name: production }",
    );
    const home = makeFixture({ "harness.yaml": reversibleScoped });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      shallow: true,
    });
    expect(
      report.riskGate.warnings.filter((w) => w.includes("gate-high-risk")),
    ).toHaveLength(0);
  });
});

// task 129e1b94: grounding wiring health. The section exists only when an
// enabled grounding-mcp entry is declared; it checks the EFFECTIVE
// evidence-ledger path (operator env override wins) for writability and
// surfaces override drift against grounding.evidence_ledger.path.
describe("doctor — grounding section (task 129e1b94)", () => {
  function groundingManifest(opts: { ledgerPath: string; env?: string }): string {
    const envLine = opts.env !== undefined ? `\n      env:\n        EVIDENCE_LEDGER_DB: ${opts.env}` : "";
    return `version: 1
grounding:
  evidence_ledger:
    path: ${opts.ledgerPath}
tools:
  mcp:
    - name: grounding-mcp
      command: [node, /opt/grounding-mcp/server.js]
      enabled: true${envLine}
  builtin:
    known: [Read, Edit, Bash]
hooks: []
policies: []
`;
  }

  it("reports a writable ledger path with no warnings", async () => {
    const home = makeFixture({});
    const ledgerPath = path.join(home, "ledger", "ledger.db");
    const manifest = groundingManifest({ ledgerPath });
    const fixture = makeFixture({ "harness.yaml": manifest });
    const report = await doctor({
      configPath: path.join(fixture, "harness.yaml"),
      shallow: true,
    });
    expect(report.grounding).toBeDefined();
    expect(report.grounding?.ledgerPath).toBe(ledgerPath);
    expect(report.grounding?.ledgerPathWritable).toBe(true);
    expect(report.grounding?.envOverride).toBeNull();
    expect(report.grounding?.warnings).toEqual([]);
    const formatted = format(report);
    expect(formatted).toContain("Grounding");
    expect(formatted).toContain("✓ ledger path writable");
  });

  it("omits the section entirely when no grounding-mcp entry is declared", async () => {
    const fixture = makeFixture({
      "harness.yaml": `version: 1
tools:
  builtin:
    known: [Read]
hooks: []
policies: []
`,
    });
    const report = await doctor({
      configPath: path.join(fixture, "harness.yaml"),
      shallow: true,
    });
    expect(report.grounding).toBeUndefined();
    expect(format(report)).not.toContain("Grounding");
  });

  it("warns when an operator env override diverges from grounding.evidence_ledger.path", async () => {
    const home = makeFixture({});
    const declared = path.join(home, "a", "ledger.db");
    const override = path.join(home, "b", "other.db");
    const fixture = makeFixture({
      "harness.yaml": groundingManifest({ ledgerPath: declared, env: override }),
    });
    const report = await doctor({
      configPath: path.join(fixture, "harness.yaml"),
      shallow: true,
    });
    expect(report.grounding?.envOverride).toBe(override);
    // The override is the effective path doctor checks.
    expect(report.grounding?.ledgerPath).toBe(override);
    expect(
      report.grounding?.warnings.some((w) =>
        w.includes("overrides grounding.evidence_ledger.path"),
      ),
    ).toBe(true);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
  });

  it("grounding warnings increment warningCount by exactly their own length", async () => {
    const home = makeFixture({});
    const declared = path.join(home, "a", "ledger.db");
    const override = path.join(home, "b", "other.db");
    const clean = await doctor({
      configPath: path.join(
        makeFixture({ "harness.yaml": groundingManifest({ ledgerPath: declared }) }),
        "harness.yaml",
      ),
      shallow: true,
    });
    const drifted = await doctor({
      configPath: path.join(
        makeFixture({
          "harness.yaml": groundingManifest({ ledgerPath: declared, env: override }),
        }),
        "harness.yaml",
      ),
      shallow: true,
    });
    expect(clean.grounding?.warnings).toEqual([]);
    expect(drifted.grounding?.warnings).toHaveLength(1);
    // Identical manifests except for the override, so the count delta IS
    // the grounding contribution — deleting the rollup in countDiagnostics
    // turns this red (reviewer mutation-coverage finding).
    expect(drifted.warningCount - clean.warningCount).toBe(
      drifted.grounding!.warnings.length,
    );
  });

  it("flags an unwritable ledger location (negative control)", async () => {
    // Skipped for root (root passes W_OK on read-only dirs).
    if (typeof process.geteuid === "function" && process.geteuid() === 0) return;
    const home = makeFixture({});
    const lockedDir = path.join(home, "locked");
    fs.mkdirSync(lockedDir);
    fs.chmodSync(lockedDir, 0o555);
    cleanups.push(() => {
      try {
        fs.chmodSync(lockedDir, 0o755);
      } catch {
        /* fixture dir already removed by an earlier cleanup */
      }
    });
    const ledgerPath = path.join(lockedDir, "nested", "ledger.db");
    const fixture = makeFixture({
      "harness.yaml": groundingManifest({ ledgerPath }),
    });
    const report = await doctor({
      configPath: path.join(fixture, "harness.yaml"),
      shallow: true,
    });
    expect(report.grounding?.ledgerPathWritable).toBe(false);
    expect(
      report.grounding?.warnings.some((w) => w.includes("not writable")),
    ).toBe(true);
  });
});
