import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
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
`;

  async function run() {
    const home = makeFixture({ "harness.yaml": MANIFEST });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "",
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
    expect(text).toContain("✓ beta-gate");
    expect(text).toContain("✓ gamma-gate");
  });
});
