import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_MS,
  buildMcpServers,
  buildMemoryRouterHook,
  generateSettings,
  generateSettingsWithWarnings,
} from "../../../src/cli/apply/generate-settings.js";
import { manifestProjection, parseSettingsHooks } from "../../../src/cli/adopt/derive.js";
import { parseManifest, type Manifest, type McpServer } from "../../../src/schema/index.js";

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
    expect(bashGroup?.hooks.map((h) => h.timeout).sort()).toEqual([1000, 5000]);
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
      { hooks: [{ type: "command", command: "/hooks/git-preflight.sh", timeout: 30000 }] },
    ]);

    // PreToolUse has 2 matchers, sorted ascending: "Bash" before "mcp__..."
    expect(out.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "/hooks/dogfood.sh", timeout: 2000 }],
      },
      {
        matcher: "mcp__agent-tasks__pull_requests_merge",
        hooks: [{ type: "command", command: "/hooks/review.sh", timeout: 2000 }],
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
          { type: "command", command: "/cmd-a.sh", timeout: 30000 },
          { type: "command", command: "/cmd-b.sh", timeout: 30000 },
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
      { hooks: [{ type: "command", command: "/s.sh", timeout: 30000 }] },
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
      timeout: DEFAULT_BUDGET_MS,
    });
    expect(out.hooks.Stop?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: "/c.sh",
      timeout: 5000,
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
    const inner = out.hooks.PreToolUse[0]?.hooks[0];
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
    expect(out.hooks.SessionStart[0]).not.toHaveProperty("matcher");
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
    expect(out.withenv.env).toEqual({ TOKEN: "x" });
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

describe("generateSettings + mcpServers integration", () => {
  it("emits mcpServers alongside hooks when manifest has enabled MCPs", () => {
    const m = manifestOf(
      [
        { name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 },
      ],
      [
        { name: "grounding-mcp", command: "node /opt/grounding/server.js" },
        { name: "search-mcp", command: ["python", "-m", "search.server"], enabled: false },
      ],
    );
    const out = generateSettings(m);
    expect(out.mcpServers).toBeDefined();
    expect(out.mcpServers?.["grounding-mcp"]).toEqual({
      command: "node",
      args: ["/opt/grounding/server.js"],
    });
    expect(out.mcpServers?.["search-mcp"]).toBeUndefined();
  });

  it("omits the mcpServers key entirely when no enabled MCPs are configured", () => {
    const m = manifestOf(
      [{ name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 }],
      [{ name: "off", command: "node x.js", enabled: false }],
    );
    const out = generateSettings(m);
    expect(out).not.toHaveProperty("mcpServers");
  });

  it("generateSettingsWithWarnings surfaces buildMcpServers warnings", () => {
    const m = manifestOf(
      [{ name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 }],
      [{ name: "ghost", command: "   ", enabled: true }],
    );
    const r = generateSettingsWithWarnings(m);
    expect(r.warnings).toContain("tools.mcp.ghost: empty command, skipping");
    expect(r.root).not.toHaveProperty("mcpServers");
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
      { type: "command", command: "memory-router-user-prompt-submit", timeout: 5000 },
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
