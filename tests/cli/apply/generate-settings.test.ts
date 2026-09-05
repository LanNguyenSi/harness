import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_MS,
  buildMcpServers,
  buildMemoryRouterHook,
  generateSettings,
  generateSettingsWithWarnings,
  hookTimeoutSeconds,
} from "../../../src/cli/apply/generate-settings.js";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import { manifestProjection, parseSettingsHooks } from "../../../src/cli/adopt/derive.js";
import { parseManifest, type Hook, type Manifest, type McpServer } from "../../../src/schema/index.js";
import { signingKeyPathFor } from "../../../src/runtime/approval-signing.js";

function manifestOf(hooks: unknown[], mcp: unknown[] = []): Manifest {
  return parseManifest({
    version: 1,
    tools: { mcp, cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
    memory: { directories: [] },
    hooks,
    policies: [],
  });
}

describe("generateSettings", () => {
  it("returns { hooks: {} } for an empty manifest (not undefined, not missing)", () => {
    const out = generateSettings(manifestOf([]));
    expect(out).toEqual({ hooks: {} });
  });

  it("intentionally drops path_match and bash_match (hook-script enforced, not wiring)", () => {
    // ARCHITECTURE Appendix A canonical pattern (e.g. require-preflight-evidence
    // with bash_match) shows these filters are enforced inside the referenced
    // hook script, not by settings.json. We assert current behaviour so a
    // future contributor sees a failing test if they add wrapping logic.
    const m = manifestOf([
      {
        name: "h",
        event: "PreToolUse",
        match: "Bash",
        bash_match: "^git (status|log|diff|branch)",
        path_match: "**/*.ts",
        command: "/hooks/preflight.sh",
        blocking: "hard",
        budget_ms: 1000,
      },
    ]);
    const out = generateSettings(m);
    const inner = out.hooks.PreToolUse?.[0]?.hooks[0];
    expect(inner).toBeDefined();
    expect(inner).not.toHaveProperty("path_match");
    expect(inner).not.toHaveProperty("bash_match");
    expect(out.hooks.PreToolUse?.[0]).not.toHaveProperty("path_match");
    expect(out.hooks.PreToolUse?.[0]).not.toHaveProperty("bash_match");
    // The hook still appears in settings.json (matcher = "Bash") so Claude
    // Code fires the script; the script filters internally.
    expect(out.hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(inner?.command).toBe("/hooks/preflight.sh");
  });

  it("preserves regex metacharacters in `match` unchanged (no escaping/normalisation)", () => {
    const m = manifestOf([
      {
        name: "h",
        event: "PreToolUse",
        match: "mcp__agent-tasks__.*|Bash",
        command: "/h.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.PreToolUse?.[0]?.matcher).toBe("mcp__agent-tasks__.*|Bash");
  });

  it("preserves backslashes in `match` (regex escapes survive JSON serialisation)", () => {
    const m = manifestOf([
      {
        name: "h",
        event: "PreToolUse",
        match: "Bash\\b|Edit\\b",
        command: "/h.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    const matcher = out.hooks.PreToolUse?.[0]?.matcher;
    expect(matcher).toBe("Bash\\b|Edit\\b");
    // Round-trip through JSON to confirm escapes survive serialisation.
    expect(JSON.parse(JSON.stringify(out)).hooks.PreToolUse[0].matcher).toBe("Bash\\b|Edit\\b");
  });

  it("multiple events × multiple matchers produce sorted, group-stable output", () => {
    const m = manifestOf([
      {
        name: "z",
        event: "Stop",
        command: "/z.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "pa",
        event: "PreToolUse",
        match: "Edit",
        command: "/pa.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "pb",
        event: "PreToolUse",
        match: "Bash",
        command: "/pb.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "pc",
        event: "PreToolUse",
        match: "Bash",
        command: "/pa.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "s",
        event: "SessionStart",
        command: "/s.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(Object.keys(out.hooks)).toEqual(["PreToolUse", "SessionStart", "Stop"]);
    // PreToolUse: matcher "Bash" sorts before "Edit"; within "Bash", commands
    // "/pa.sh" sorts before "/pb.sh".
    const preToolUse = out.hooks.PreToolUse ?? [];
    expect(preToolUse[0]?.matcher).toBe("Bash");
    expect(preToolUse[0]?.hooks.map((h) => h.command)).toEqual(["/pa.sh", "/pb.sh"]);
    expect(preToolUse[1]?.matcher).toBe("Edit");
  });

  it("dedupes identical (command, timeout) pairs inside one matcher group", () => {
    // The full template wires every PreToolUse policy to the same
    // `harness policy intercept` engine; several of those share the
    // Bash matcher. Claude Code spawns each entry in hooks[] for the
    // same event, so emitting duplicates burns CPU on identical
    // ledger queries. Lock the dedupe contract: identical
    // (command, timeout) tuples collapse to one entry per group.
    const m = manifestOf([
      {
        name: "dogfood",
        event: "PreToolUse",
        match: "Bash",
        bash_match: "^(npm publish|git tag v.*)",
        command: "harness policy intercept",
        blocking: "hard",
        budget_ms: 2000,
      },
      {
        name: "preflight-read",
        event: "PreToolUse",
        match: "Bash",
        bash_match: "^git (status|log|diff|branch)",
        command: "harness policy intercept",
        blocking: "hard",
        budget_ms: 2000,
      },
      {
        name: "preflight-push",
        event: "PreToolUse",
        match: "Bash",
        bash_match: "^git push",
        command: "harness policy intercept",
        blocking: "hard",
        budget_ms: 2000,
      },
    ]);
    const out = generateSettings(m);
    const bashGroup = out.hooks.PreToolUse?.find((g) => g.matcher === "Bash");
    expect(bashGroup).toBeDefined();
    expect(bashGroup?.hooks).toHaveLength(1);
    expect(bashGroup?.hooks[0]?.command).toBe("harness policy intercept");
  });

  it("does NOT dedupe across distinct timeouts (different policies, different budgets)", () => {
    // Same matcher + same command but different timeout means the
    // operator wanted distinct enforcement budgets; we must NOT collapse.
    const m = manifestOf([
      {
        name: "fast",
        event: "PreToolUse",
        match: "Bash",
        command: "harness policy intercept",
        blocking: "hard",
        budget_ms: 1000,
      },
      {
        name: "slow",
        event: "PreToolUse",
        match: "Bash",
        command: "harness policy intercept",
        blocking: "hard",
        budget_ms: 5000,
      },
    ]);
    const out = generateSettings(m);
    const bashGroup = out.hooks.PreToolUse?.find((g) => g.matcher === "Bash");
    expect(bashGroup?.hooks).toHaveLength(2);
    // budget_ms 1000 -> ceil(1000/1000)=1, floored to the policy-intercept
    // minimum of 2s; budget_ms 5000 -> ceil(5000/1000)=5. Still distinct.
    expect(bashGroup?.hooks.map((h) => h.timeout).sort()).toEqual([2, 5]);
  });

  it("emits one event key per distinct event with the right matcher/command tuples", () => {
    const m = manifestOf([
      {
        name: "git-preflight",
        event: "SessionStart",
        command: "/hooks/git-preflight.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "review",
        event: "PreToolUse",
        match: "mcp__agent-tasks__pull_requests_merge",
        command: "/hooks/review.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
      {
        name: "dogfood",
        event: "PreToolUse",
        match: "Bash",
        command: "/hooks/dogfood.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
    ]);
    const out = generateSettings(m);
    expect(Object.keys(out.hooks)).toEqual(["PreToolUse", "SessionStart"]);

    expect(out.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "/hooks/git-preflight.sh", timeout: 30 }] },
    ]);

    // PreToolUse has 2 matchers, sorted ascending: "Bash" before "mcp__..."
    expect(out.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "/hooks/dogfood.sh", timeout: 2 }],
      },
      {
        matcher: "mcp__agent-tasks__pull_requests_merge",
        hooks: [{ type: "command", command: "/hooks/review.sh", timeout: 2 }],
      },
    ]);
  });

  it("groups hooks under the same event+match together (one group, multiple inner hooks)", () => {
    const m = manifestOf([
      {
        name: "h1",
        event: "PreToolUse",
        match: "Bash",
        command: "/cmd-b.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "h2",
        event: "PreToolUse",
        match: "Bash",
        command: "/cmd-a.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "/cmd-a.sh", timeout: 30 },
          { type: "command", command: "/cmd-b.sh", timeout: 30 },
        ],
      },
    ]);
  });

  it("hooks without a `match` produce a group without a `matcher` field", () => {
    const m = manifestOf([
      {
        name: "session",
        event: "SessionStart",
        command: "/s.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "/s.sh", timeout: 30 }] },
    ]);
    expect(out.hooks.SessionStart?.[0]).not.toHaveProperty("matcher");
  });

  it("always emits `timeout` (the manifest budget_ms is the source of truth, no implicit-default optimisation)", () => {
    const m = manifestOf([
      {
        name: "default-budget",
        event: "SessionStart",
        command: "/d.sh",
        blocking: false,
        budget_ms: DEFAULT_BUDGET_MS,
      },
      {
        name: "custom-budget",
        event: "Stop",
        command: "/c.sh",
        blocking: false,
        budget_ms: 5000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SessionStart?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: "/d.sh",
      timeout: DEFAULT_BUDGET_MS / 1000,
    });
    expect(out.hooks.Stop?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: "/c.sh",
      timeout: 5,
    });
  });

  it("does NOT emit `blocking` (harness-internal field)", () => {
    const m = manifestOf([
      {
        name: "hard",
        event: "PreToolUse",
        match: "Bash",
        command: "/h.sh",
        blocking: "hard",
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    const inner = out.hooks.PreToolUse?.[0]?.hooks[0];
    expect(inner).toBeDefined();
    expect(inner).not.toHaveProperty("blocking");
  });

  it("output is deterministic across runs (byte-equivalent JSON)", () => {
    const m = manifestOf([
      {
        name: "h-z",
        event: "PreToolUse",
        match: "Bash",
        command: "/z.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "h-a",
        event: "PreToolUse",
        match: "Bash",
        command: "/a.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "h-m",
        event: "Stop",
        command: "/m.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const a = JSON.stringify(generateSettings(m));
    const b = JSON.stringify(generateSettings(m));
    expect(a).toBe(b);
  });

  it("event keys are sorted ascending in the output object", () => {
    const m = manifestOf([
      {
        name: "z",
        event: "Stop",
        command: "/z.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "a",
        event: "PreToolUse",
        match: "Bash",
        command: "/a.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "m",
        event: "SessionStart",
        command: "/m.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(Object.keys(out.hooks)).toEqual(["PreToolUse", "SessionStart", "Stop"]);
  });

  it("round-trips through parseSettingsHooks back to manifestProjection", () => {
    const m = manifestOf([
      {
        name: "git-preflight",
        event: "SessionStart",
        command: "/hooks/git-preflight.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "review",
        event: "PreToolUse",
        match: "mcp__agent-tasks__pull_requests_merge",
        command: "/hooks/review.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
      {
        name: "dogfood",
        event: "PreToolUse",
        match: "Bash",
        command: "/hooks/dogfood.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
    ]);
    const settings = generateSettings(m);
    const reparsed = parseSettingsHooks(settings).map((d) => ({
      event: d.event,
      command: d.command,
      ...(d.match !== undefined ? { match: d.match } : {}),
    }));
    const expected = manifestProjection(m);

    // Sort both sides by the same composite key to make order-insensitive.
    const sortKey = (h: { event: string; command: string; match?: string }) =>
      `${h.event}\x00${h.command}\x00${h.match ?? ""}`;
    expect([...reparsed].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
  });

  it("output is JSON.stringify-able and JSON.parse round-trips byte-equivalent", () => {
    const m = manifestOf([
      {
        name: "h",
        event: "SessionStart",
        command: "/h.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const settings = generateSettings(m);
    const serialized = JSON.stringify(settings);
    expect(JSON.parse(serialized)).toEqual(settings);
  });

  it("a hook with empty-string explicit `match` is treated as 'no matcher'", () => {
    // Schema rejects empty-string match (min 1), so we exercise this via the
    // already-default no-match path rather than a malformed input. This test
    // doc'd to verify the empty-string bucket key is "no matcher" semantics.
    const m = manifestOf([
      {
        name: "h",
        event: "SessionStart",
        command: "/h.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SessionStart).toHaveLength(1);
    expect(out.hooks.SessionStart?.[0]).not.toHaveProperty("matcher");
  });

  it("accepts a SubagentStart hook and renders it into hooks.SubagentStart (task 496660c5)", () => {
    const m = manifestOf([
      {
        name: "h",
        event: "SubagentStart",
        command: "harness pack hook subagent-start",
        blocking: false,
        budget_ms: 2000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SubagentStart).toHaveLength(1);
    expect(out.hooks.SubagentStart?.[0]?.hooks[0]?.command).toBe(
      "harness pack hook subagent-start",
    );
    expect(out.hooks.SubagentStart?.[0]).not.toHaveProperty("matcher");
  });
});

// task 7bf47554: Claude Code's settings.json hook `timeout` is documented
// in SECONDS (https://code.claude.com/docs/en/hooks, "Seconds before
// canceling"), not milliseconds like the manifest's `budget_ms`. Before
// this fix `toSettingsCommand` emitted `h.budget_ms` unconverted, so every
// Claude-hook kill-timer was 1000x too large (a 1000-2000ms template
// budget silently became a 1000-2000 SECOND, 16-33 minute, Claude Code
// timeout). These tests pin the corrected conversion and its parity with
// the (already-correct) Codex projection.
describe("hookTimeoutSeconds (Claude-hook-timeout-was-1000x, task 7bf47554)", () => {
  function hook(budget_ms: number, command = "/hooks/h.sh"): Hook {
    return {
      name: "h",
      event: "PreToolUse",
      command,
      blocking: false,
      budget_ms,
    };
  }

  it("converts budget_ms=10000 to timeout=10 seconds (acceptance criterion 1)", () => {
    expect(hookTimeoutSeconds(hook(10_000))).toBe(10);
  });

  it("converts budget_ms=1000 to timeout=1 second", () => {
    expect(hookTimeoutSeconds(hook(1_000))).toBe(1);
  });

  it("floors `harness policy intercept` hooks at 2 seconds even for a tiny budget_ms", () => {
    expect(hookTimeoutSeconds(hook(1, "harness policy intercept"))).toBe(2);
    expect(hookTimeoutSeconds(hook(1_000, "harness policy intercept"))).toBe(2);
  });

  it("floors non-policy-intercept hooks at 1 second even for a sub-second budget_ms", () => {
    expect(hookTimeoutSeconds(hook(1))).toBe(1);
  });

  it("rounds up a non-multiple-of-1000 budget_ms (ceil, never truncates to 0)", () => {
    expect(hookTimeoutSeconds(hook(1500))).toBe(2);
    expect(hookTimeoutSeconds(hook(2001))).toBe(3);
  });

  it("this test goes RED under the pre-fix 1:1 (ms-as-seconds) behaviour", () => {
    // Mutation probe (not a normal regression pin): simulates reverting
    // hookTimeoutSeconds to the original `h.budget_ms` passthrough bug.
    // If this assertion could pass under `naiveOneToOne`, the test above
    // would not actually be catching the unit bug.
    const naiveOneToOne = (h: Hook): number => h.budget_ms;
    expect(naiveOneToOne(hook(10_000))).not.toBe(hookTimeoutSeconds(hook(10_000)));
    expect(hookTimeoutSeconds(hook(10_000))).toBe(10);
  });

  it("generateSettings and generateCodexConfig emit the identical seconds value for the same hook (acceptance criterion 3)", () => {
    const cases: { budget_ms: number; command: string }[] = [
      { budget_ms: 10_000, command: "/hooks/plain.sh" },
      { budget_ms: 1_000, command: "/hooks/plain.sh" },
      { budget_ms: 1_500, command: "/hooks/plain.sh" },
      { budget_ms: 1, command: "harness policy intercept" },
      { budget_ms: 2_000, command: "harness policy intercept" },
      { budget_ms: DEFAULT_BUDGET_MS, command: "/hooks/plain.sh" },
    ];
    for (const { budget_ms, command } of cases) {
      const m = parseManifest({
        version: 1,
        tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
        memory: { directories: [] },
        hooks: [
          { name: "cmp", event: "SessionStart", command, blocking: false, budget_ms },
        ],
        policies: [],
      });
      const settingsTimeout = generateSettings(m).hooks.SessionStart?.[0]?.hooks[0]?.timeout;
      const { content } = generateCodexConfig(m);
      const codexMatch = content.match(/timeout = (\d+)/);
      expect(codexMatch).not.toBeNull();
      const codexTimeout = Number(codexMatch![1]);
      expect(settingsTimeout).toBe(codexTimeout);
      expect(settingsTimeout).toBe(hookTimeoutSeconds(hook(budget_ms, command)));
    }
  });
});

describe("buildMcpServers", () => {
  function mcp(...entries: Partial<McpServer>[]): McpServer[] {
    return entries.map((e) => ({ enabled: true, ...e }) as McpServer);
  }

  it("translates a string-command entry into command + args", () => {
    const w: string[] = [];
    const out = buildMcpServers(
      mcp({ name: "g", command: "node /opt/server.js --port 3000" }),
      w,
    );
    expect(out).toEqual({
      g: { command: "node", args: ["/opt/server.js", "--port", "3000"] },
    });
    expect(w).toEqual([]);
  });

  it("translates an array-command entry preserving token boundaries", () => {
    const w: string[] = [];
    const out = buildMcpServers(
      mcp({ name: "g", command: ["node", "/opt/path with space.js"] }),
      w,
    );
    expect(out).toEqual({
      g: { command: "node", args: ["/opt/path with space.js"] },
    });
  });

  it("preserves env when present, omits when empty/undefined", () => {
    const w: string[] = [];
    const out = buildMcpServers(
      mcp(
        { name: "withenv", command: "node a.js", env: { TOKEN: "x" } },
        { name: "noenv", command: "node b.js" },
      ),
      w,
    );
    expect(out.withenv?.env).toEqual({ TOKEN: "x" });
    expect(out.noenv).not.toHaveProperty("env");
  });

  it("omits args when command has only a single token", () => {
    const w: string[] = [];
    const out = buildMcpServers(mcp({ name: "single", command: "lone-binary" }), w);
    expect(out.single).toEqual({ command: "lone-binary" });
    expect(out.single).not.toHaveProperty("args");
  });

  it("drops disabled entries", () => {
    const w: string[] = [];
    const out = buildMcpServers(
      mcp(
        { name: "on", command: "node a.js" },
        { name: "off", command: "node b.js", enabled: false },
      ),
      w,
    );
    expect(Object.keys(out)).toEqual(["on"]);
  });

  it("emits server names in stable lexical order", () => {
    const w: string[] = [];
    const out = buildMcpServers(
      mcp(
        { name: "zulu", command: "z" },
        { name: "alpha", command: "a" },
        { name: "mike", command: "m" },
      ),
      w,
    );
    expect(Object.keys(out)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("warns and skips entries whose command splits to nothing", () => {
    // The schema rejects min(1) strings, but " " (whitespace-only) survives
    // .min(1) and would trim to nothing. Defensive surface for that case.
    const entries = [
      { name: "ghost", command: "   ", enabled: true },
    ] as McpServer[];
    const w: string[] = [];
    const out = buildMcpServers(entries, w);
    expect(out).toEqual({});
    expect(w).toContain("tools.mcp.ghost: empty command, skipping");
  });

  it("warns when an env value starts with a literal `~/` (cwd-relative trap)", () => {
    // Regression for agent-tasks/42d224a6: a manifest with
    // `env: { EVIDENCE_LEDGER_DB: "~/.evidence-ledger/ledger.db" }`
    // silently created rogue ledger DBs under
    // <cwd>/~/.evidence-ledger/ledger.db because better-sqlite3
    // opens the literal-tilde path as cwd-relative, not $HOME-relative.
    // The warning steers operators at an absolute path or no env at all.
    const w: string[] = [];
    const entries = [
      {
        name: "g",
        command: "grounding-mcp",
        env: { EVIDENCE_LEDGER_DB: "~/.evidence-ledger/ledger.db" },
        enabled: true,
      },
    ] as McpServer[];
    const out = buildMcpServers(entries, w);
    // The env is still written to settings.json verbatim (the operator
    // may have a reason for it); the warning is informational.
    expect(out.g?.env).toEqual({ EVIDENCE_LEDGER_DB: "~/.evidence-ledger/ledger.db" });
    expect(w.some((m) => m.includes("starts with a literal ~"))).toBe(true);
    expect(w.some((m) => m.includes("tools.mcp.g.env.EVIDENCE_LEDGER_DB"))).toBe(true);
  });

  it("does NOT warn when an env value is an absolute path", () => {
    const w: string[] = [];
    const entries = [
      {
        name: "g",
        command: "grounding-mcp",
        env: { EVIDENCE_LEDGER_DB: "/home/operator/.evidence-ledger/ledger.db" },
        enabled: true,
      },
    ] as McpServer[];
    buildMcpServers(entries, w);
    expect(w.some((m) => m.includes("starts with a literal ~"))).toBe(false);
  });
});

// T-002 (init-mcp-wiring-claude-code): Claude Code never read the
// settings.json `mcpServers` block at runtime, so it is no longer part of
// the settings.json projection (`root`) at all. The manifest's tools.mcp[]
// servers are still translated into the Claude Code server-spec shape —
// they now feed the `claude mcp` CLI Ensure path instead (io/claude-mcp.ts)
// — and surface as the sibling `mcpServers` field on
// `generateSettingsWithWarnings`'s result.
describe("generateSettings + mcpServers integration", () => {
  it("computes mcpServers for the Ensure path without projecting them into settings.json", () => {
    const m = manifestOf(
      [
        { name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 },
      ],
      [
        { name: "grounding-mcp", command: "node /opt/grounding/server.js" },
        { name: "search-mcp", command: ["python", "-m", "search.server"], enabled: false },
      ],
    );
    const r = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(r.root).not.toHaveProperty("mcpServers");
    expect(r.mcpServers["grounding-mcp"]).toEqual({
      command: "node",
      args: ["/opt/grounding/server.js"],
      // task 129e1b94: grounding.evidence_ledger.path (schema default here)
      // is projected as the env grounding-mcp's ledger-bridge reads.
      env: { EVIDENCE_LEDGER_DB: "/home/op/.evidence-ledger/ledger.db" },
    });
    expect(r.mcpServers["search-mcp"]).toBeUndefined();
  });

  it("omits the mcpServers key entirely from settings.json regardless of enabled MCPs", () => {
    const m = manifestOf(
      [{ name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 }],
      [{ name: "off", command: "node x.js", enabled: false }],
    );
    const out = generateSettings(m);
    expect(out).not.toHaveProperty("mcpServers");
  });

  it("generateSettingsWithWarnings surfaces buildMcpServers warnings and an empty mcpServers map", () => {
    const m = manifestOf(
      [{ name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 }],
      [{ name: "ghost", command: "   ", enabled: true }],
    );
    const r = generateSettingsWithWarnings(m);
    expect(r.warnings).toContain("tools.mcp.ghost: empty command, skipping");
    expect(r.root).not.toHaveProperty("mcpServers");
    expect(r.mcpServers).toEqual({});
  });
});

describe("generateSettings — memory.router projection (PR #203)", () => {
  function manifestWithRouter(router: unknown, hooks: unknown[] = []): Manifest {
    return parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [], router },
      hooks,
      policies: [],
    });
  }

  it("projects memory.router into a UserPromptSubmit hook when enabled (default)", () => {
    // Pre-#203 the router was declared in the manifest but never written
    // into settings.json. The wizard's "(already installed)" check on the
    // binary made the silent unwiring particularly hard to diagnose; an
    // operator could ship the harness for months without ever exercising
    // per-prompt memory augmentation.
    const m = manifestWithRouter({
      command: ["memory-router-user-prompt-submit"],
    });
    const out = generateSettings(m);
    expect(out.hooks.UserPromptSubmit).toHaveLength(1);
    const group = out.hooks.UserPromptSubmit?.[0];
    expect(group).toBeDefined();
    expect(group?.matcher).toBeUndefined();
    expect(group?.hooks).toEqual([
      { type: "command", command: "memory-router-user-prompt-submit", timeout: 5 },
    ]);
  });

  it("omits memory.router when enabled:false", () => {
    const m = manifestWithRouter({
      command: ["memory-router-user-prompt-submit"],
      enabled: false,
    });
    const out = generateSettings(m);
    expect(out.hooks).not.toHaveProperty("UserPromptSubmit");
  });

  it("omits memory.router when memory.router is undefined", () => {
    const out = generateSettings(
      parseManifest({
        version: 1,
        tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
        memory: { directories: [] },
        hooks: [],
        policies: [],
      }),
    );
    expect(out.hooks).not.toHaveProperty("UserPromptSubmit");
  });

  it("co-exists with another UserPromptSubmit hook (gate + router both fire, alphabetical order)", () => {
    // Real-world Full profile: both understanding-gate-claude-hook AND
    // memory-router-user-prompt-submit declare UserPromptSubmit. They
    // share a matcher group (no `match` field on either) and Claude Code
    // spawns both per prompt. Alphabetical sort by command places the
    // router before the gate, but both fire.
    const m = manifestWithRouter(
      { command: ["memory-router-user-prompt-submit"] },
      [
        {
          name: "ug:user-prompt-submit",
          event: "UserPromptSubmit",
          command: "understanding-gate-claude-hook",
          blocking: false,
          budget_ms: 5000,
        },
      ],
    );
    const out = generateSettings(m);
    expect(out.hooks.UserPromptSubmit).toHaveLength(1);
    const inner = out.hooks.UserPromptSubmit?.[0]?.hooks ?? [];
    expect(inner).toHaveLength(2);
    expect(inner[0]?.command).toBe("memory-router-user-prompt-submit");
    expect(inner[1]?.command).toBe("understanding-gate-claude-hook");
  });

  it("forwards min_version and version_command to the synthetic hook (both-or-neither)", () => {
    // harness doctor's version-floor probe is wired via Hook.min_version
    // / version_command. Pre-#203 this was lost (the router never became
    // a Hook). The synthetic projection must carry both when set so
    // `harness doctor` continues to surface a floor warning if the
    // installed router lags the declared min_version.
    const m = manifestWithRouter({
      command: ["memory-router-user-prompt-submit"],
      min_version: "0.3.0",
      version_command: ["memory-router-user-prompt-submit", "--version"],
    });
    // The settings.json projection deliberately strips min_version /
    // version_command (they are doctor-side metadata not consumed by
    // Claude Code), so we verify forwarding by going one level deeper:
    // the synthetic Hook the helper produces is the doctor's input, and
    // its presence in the byEvent map is the contract. Cross-checking
    // via the lock-file projection would couple this test to harness-lock
    // internals; instead we re-import the helper directly.
    const hook = buildMemoryRouterHook(m);
    if (hook === null) throw new Error("expected non-null hook");
    expect(hook.min_version).toBe("0.3.0");
    expect(hook.version_command).toEqual([
      "memory-router-user-prompt-submit",
      "--version",
    ]);
  });

  it("does not forward min_version when version_command is absent (HookSchema invariant)", () => {
    // The schema constructed via parseManifest enforces min_version /
    // version_command both-or-neither at the Hook level; the router
    // schema does not co-validate, so a router declaration with only
    // min_version is parseable. The helper must NOT carry a half-set
    // pair forward (would fail Hook schema downstream / mislead doctor).
    const m = manifestWithRouter({
      command: ["memory-router-user-prompt-submit"],
      min_version: "0.3.0",
    });
    const hook = buildMemoryRouterHook(m);
    if (hook === null) throw new Error("expected non-null hook");
    expect(hook.min_version).toBeUndefined();
    expect(hook.version_command).toBeUndefined();
  });

  it("joins multi-token command arrays with a single space", () => {
    // The schema is `command: string[]` (min 1) for forward-compat. A
    // multi-token form like `["node", "/opt/router.js"]` joins to one
    // shell string Claude Code spawns. Single-bin form is the common
    // case and joins to itself.
    const m = manifestWithRouter({
      command: ["node", "/opt/router/dist/cli.js", "--mode", "augment"],
    });
    const out = generateSettings(m);
    const inner = out.hooks.UserPromptSubmit?.[0]?.hooks[0];
    expect(inner?.command).toBe("node /opt/router/dist/cli.js --mode augment");
  });
});

// task 129e1b94 (harness-review-2026-07-01/grounding-decorative): the
// `grounding:` section CONFIGURES the grounding-mcp entry instead of being
// a decorative namesake. `evidence_ledger.path` is projected as the
// EVIDENCE_LEDGER_DB env — the variable grounding-mcp's ledger-bridge
// actually reads. These tests are the removal-pin the task's acceptance
// criteria demand: deleting projectGroundingEnv turns them red.
//
// T-002 (init-mcp-wiring-claude-code): the projection's OUTPUT moved from
// `root.mcpServers` to the sibling `mcpServers` field (settings.json no
// longer carries mcpServers at all — see the describe block above), but
// projectGroundingEnv itself is unchanged and still feeds these assertions
// via that sibling field, so the removal-pin still holds.
describe("generateSettings — grounding: projection (task 129e1b94)", () => {
  const GROUNDING_MCP = {
    name: "grounding-mcp",
    command: ["node", "/opt/grounding-mcp/dist/server.js"],
    enabled: true,
  };

  it("projects grounding.evidence_ledger.path as EVIDENCE_LEDGER_DB, ~-expanded", () => {
    const m = parseManifest({
      version: 1,
      grounding: { evidence_ledger: { path: "~/.evidence-ledger/ledger.db" } },
      tools: { mcp: [GROUNDING_MCP], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [],
      policies: [],
    });
    const { root, warnings, mcpServers } = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(root).not.toHaveProperty("mcpServers");
    expect(mcpServers["grounding-mcp"]?.env?.EVIDENCE_LEDGER_DB).toBe(
      "/home/op/.evidence-ledger/ledger.db",
    );
    // Absolute after expansion — the literal-tilde child-process footgun
    // (agent-tasks/42d224a6) must not re-enter through the projection.
    expect(
      mcpServers["grounding-mcp"]?.env?.EVIDENCE_LEDGER_DB?.startsWith("~"),
    ).toBe(false);
    void warnings;
  });

  it("projects the schema default even when the manifest omits grounding: entirely", () => {
    const m = manifestOf([], [GROUNDING_MCP]);
    const { mcpServers } = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(mcpServers["grounding-mcp"]?.env?.EVIDENCE_LEDGER_DB).toBe(
      "/home/op/.evidence-ledger/ledger.db",
    );
  });

  it("an operator env override on the entry wins over the manifest path", () => {
    const m = manifestOf([], [
      { ...GROUNDING_MCP, env: { EVIDENCE_LEDGER_DB: "/custom/ledger.db" } },
    ]);
    const { mcpServers } = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(mcpServers["grounding-mcp"]?.env?.EVIDENCE_LEDGER_DB).toBe(
      "/custom/ledger.db",
    );
  });

  it("does not project onto other servers or invent a grounding-mcp entry", () => {
    const m = manifestOf([], [
      { name: "agent-tasks", command: ["node", "/opt/agent-tasks/mcp.js"], enabled: true },
    ]);
    const { mcpServers } = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(mcpServers["agent-tasks"]?.env).toBeUndefined();
    expect(mcpServers["grounding-mcp"]).toBeUndefined();
  });

  it("treats an empty-string operator override as absent (projection replaces it)", () => {
    const m = manifestOf([], [
      { ...GROUNDING_MCP, env: { EVIDENCE_LEDGER_DB: "" } },
    ]);
    const { mcpServers } = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(mcpServers["grounding-mcp"]?.env?.EVIDENCE_LEDGER_DB).toBe(
      "/home/op/.evidence-ledger/ledger.db",
    );
  });

  it("keeps a custom absolute path verbatim", () => {
    const m = parseManifest({
      version: 1,
      grounding: { evidence_ledger: { path: "/var/lib/ledger/ledger.db" } },
      tools: { mcp: [GROUNDING_MCP], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [],
      policies: [],
    });
    const { mcpServers } = generateSettingsWithWarnings(m, { homeDir: "/home/op" });
    expect(mcpServers["grounding-mcp"]?.env?.EVIDENCE_LEDGER_DB).toBe(
      "/var/lib/ledger/ledger.db",
    );
  });
});

// task 03a917fd/H1 (agent-grounding 9b6c4beb comment 2, Option 2): the
// harness's own approval-signing key path
// (`<generatedDir>/.approval-signing.key`, `signingKeyPathFor`) is
// projected as the `SOLUTION_VERDICT_SIGNING_KEY` env on the grounding-mcp
// entry, exactly mirroring the `EVIDENCE_LEDGER_DB` projection above. Only
// the PATH is projected, never key bytes; the producer (grounding-mcp
// >= 0.8.0) reads this var primarily and throws on a non-absolute value.
describe("generateSettings — SOLUTION_VERDICT_SIGNING_KEY projection (task 03a917fd/H1)", () => {
  const GROUNDING_MCP = {
    name: "grounding-mcp",
    command: ["node", "/opt/grounding-mcp/dist/server.js"],
    enabled: true,
  };
  const GENERATED_DIR = "/home/op/.harness/harness.generated";

  it("projects signingKeyPathFor(generatedDir) as SOLUTION_VERDICT_SIGNING_KEY, absolute, no tilde", () => {
    const m = manifestOf([], [GROUNDING_MCP]);
    const { root, mcpServers } = generateSettingsWithWarnings(m, {
      generatedDir: GENERATED_DIR,
    });
    expect(root).not.toHaveProperty("mcpServers");
    const projected = mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY;
    expect(projected).toBe(signingKeyPathFor(GENERATED_DIR));
    expect(projected).toBe("/home/op/.harness/harness.generated/.approval-signing.key");
    // Absolute, no literal tilde — the producer throws on a non-absolute
    // value (agent-grounding 9b6c4beb comment 2).
    expect(typeof projected).toBe("string");
    expect(path.isAbsolute(projected as string)).toBe(true);
    expect((projected as string).startsWith("~")).toBe(false);
  });

  it("never projects key MATERIAL, only the path string", () => {
    // No key file exists at GENERATED_DIR in this test (nothing creates
    // one); the projection is pure path arithmetic and must never read
    // or embed file contents.
    const m = manifestOf([], [GROUNDING_MCP]);
    const { mcpServers } = generateSettingsWithWarnings(m, {
      generatedDir: GENERATED_DIR,
    });
    const projected = mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY;
    expect(projected).toBe(
      path.join(GENERATED_DIR, ".approval-signing.key"),
    );
  });

  it("an operator env override on the entry wins over the projected path", () => {
    const m = manifestOf([], [
      { ...GROUNDING_MCP, env: { SOLUTION_VERDICT_SIGNING_KEY: "/custom/signing.key" } },
    ]);
    const { mcpServers } = generateSettingsWithWarnings(m, {
      generatedDir: GENERATED_DIR,
    });
    expect(mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY).toBe(
      "/custom/signing.key",
    );
  });

  it("treats an empty-string operator override as absent (projection replaces it)", () => {
    const m = manifestOf([], [
      { ...GROUNDING_MCP, env: { SOLUTION_VERDICT_SIGNING_KEY: "" } },
    ]);
    const { mcpServers } = generateSettingsWithWarnings(m, {
      generatedDir: GENERATED_DIR,
    });
    expect(mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY).toBe(
      signingKeyPathFor(GENERATED_DIR),
    );
  });

  it("without a grounding-mcp entry: no crash, no var", () => {
    const m = manifestOf([], [
      { name: "agent-tasks", command: ["node", "/opt/agent-tasks/mcp.js"], enabled: true },
    ]);
    expect(() =>
      generateSettingsWithWarnings(m, { generatedDir: GENERATED_DIR }),
    ).not.toThrow();
    const { mcpServers } = generateSettingsWithWarnings(m, {
      generatedDir: GENERATED_DIR,
    });
    expect(mcpServers["agent-tasks"]?.env).toBeUndefined();
    expect(mcpServers["grounding-mcp"]).toBeUndefined();
  });

  it("without generatedDir: no crash, no var, even with a grounding-mcp entry", () => {
    const m = manifestOf([], [GROUNDING_MCP]);
    expect(() => generateSettingsWithWarnings(m)).not.toThrow();
    const { mcpServers } = generateSettingsWithWarnings(m);
    expect(mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY).toBeUndefined();
  });

  it("does not project onto other servers (selective to grounding-mcp only)", () => {
    const m = manifestOf([], [
      GROUNDING_MCP,
      { name: "agent-tasks", command: ["node", "/opt/agent-tasks/mcp.js"], enabled: true },
    ]);
    const { mcpServers } = generateSettingsWithWarnings(m, {
      generatedDir: GENERATED_DIR,
    });
    expect(mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY).toBe(
      signingKeyPathFor(GENERATED_DIR),
    );
    expect(mcpServers["agent-tasks"]?.env?.SOLUTION_VERDICT_SIGNING_KEY).toBeUndefined();
  });

  // Review round H1, Finding 1: `generatedDir` is normalized at the
  // projection boundary (expandHome + path.resolve, mirroring
  // `groundingLedgerEnvValue`'s idiom for EVIDENCE_LEDGER_DB) instead of
  // being rejected. A relative or literal-tilde `generatedDir` must still
  // project an ABSOLUTE, tilde-free SOLUTION_VERDICT_SIGNING_KEY, since
  // grounding-mcp throws on a non-absolute value.
  it("normalizes a RELATIVE generatedDir to an absolute path (Finding 1)", () => {
    const m = manifestOf([], [GROUNDING_MCP]);
    const relative = "relative/harness.generated";
    const { mcpServers } = generateSettingsWithWarnings(m, { generatedDir: relative });
    const projected = mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY;
    expect(typeof projected).toBe("string");
    expect(path.isAbsolute(projected as string)).toBe(true);
    expect((projected as string).startsWith("~")).toBe(false);
    expect(projected).toBe(signingKeyPathFor(path.resolve(relative)));
  });

  it("normalizes a LITERAL-TILDE generatedDir to an absolute path (Finding 1)", () => {
    const m = manifestOf([], [GROUNDING_MCP]);
    const { mcpServers } = generateSettingsWithWarnings(m, {
      homeDir: "/home/op",
      generatedDir: "~/my-harness/harness.generated",
    });
    const projected = mcpServers["grounding-mcp"]?.env?.SOLUTION_VERDICT_SIGNING_KEY;
    expect(typeof projected).toBe("string");
    expect(path.isAbsolute(projected as string)).toBe(true);
    expect((projected as string).startsWith("~")).toBe(false);
    expect(projected).toBe(
      signingKeyPathFor("/home/op/my-harness/harness.generated"),
    );
  });
});
