import { describe, expect, it } from "vitest";
import {
  RESTART_HINT_HOOKS,
  RESTART_HINT_MCP,
  RESTART_HINT_MEMORY_ROUTER,
  emitRestartHints,
} from "../../src/io/restart-hints.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

function manifest(overrides: Partial<Record<string, unknown>> = {}): Manifest {
  return parseManifest({
    version: 1,
    tools: {
      mcp: [
        { name: "oracle", command: ["node", "/x/oracle.js"] },
      ],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: {
      directories: [],
      router: { command: ["node", "/x/router.js"], enabled: true },
    },
    hooks: [
      {
        name: "git-preflight",
        event: "SessionStart",
        command: "/hooks/git-preflight.sh",
        blocking: false,
        budget_ms: 30000,
        description: "preflight on session start",
      },
    ],
    policies: [],
    ...overrides,
  });
}

describe("emitRestartHints", () => {
  it("returns empty list when only hook descriptions changed", () => {
    const prev = manifest();
    const next = manifest({
      hooks: [
        {
          name: "git-preflight",
          event: "SessionStart",
          command: "/hooks/git-preflight.sh",
          blocking: false,
          budget_ms: 30000,
          description: "rewritten description",
        },
      ],
    });
    expect(emitRestartHints(prev, next)).toEqual([]);
  });

  it("emits the MCP hint when an mcp[] entry's command changes", () => {
    const prev = manifest();
    const next = manifest({
      tools: {
        mcp: [{ name: "oracle", command: ["node", "/x/oracle-v2.js"] }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    expect(emitRestartHints(prev, next)).toContain(RESTART_HINT_MCP);
  });

  it("emits the MCP hint when a new mcp[] entry is added", () => {
    const prev = manifest();
    const next = manifest({
      tools: {
        mcp: [
          { name: "oracle", command: ["node", "/x/oracle.js"] },
          { name: "tasks", command: ["node", "/x/tasks.js"] },
        ],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    expect(emitRestartHints(prev, next)).toContain(RESTART_HINT_MCP);
  });

  it("emits the memory-router hint when memory.router.command changes", () => {
    const prev = manifest();
    const next = manifest({
      memory: {
        directories: [],
        router: { command: ["node", "/x/router-v2.js"], enabled: true },
      },
    });
    expect(emitRestartHints(prev, next)).toContain(RESTART_HINT_MEMORY_ROUTER);
  });

  it("emits the memory-router hint when the router is removed entirely", () => {
    const prev = manifest();
    const next = manifest({
      memory: { directories: [] },
    });
    expect(emitRestartHints(prev, next)).toContain(RESTART_HINT_MEMORY_ROUTER);
  });

  it("emits the hooks hint when a hook's blocking level changes", () => {
    const prev = manifest();
    const next = manifest({
      hooks: [
        {
          name: "git-preflight",
          event: "SessionStart",
          command: "/hooks/git-preflight.sh",
          blocking: "soft",
          budget_ms: 30000,
          description: "preflight on session start",
        },
      ],
    });
    expect(emitRestartHints(prev, next)).toEqual([RESTART_HINT_HOOKS]);
  });

  it("emits multiple hints when several pillars change at once", () => {
    const prev = manifest();
    const next = manifest({
      tools: {
        mcp: [{ name: "oracle", command: ["node", "/x/oracle-v2.js"] }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      memory: {
        directories: [],
        router: { command: ["node", "/x/router-v2.js"], enabled: true },
      },
      hooks: [
        {
          name: "git-preflight",
          event: "SessionStart",
          command: "/hooks/git-preflight.sh",
          blocking: "hard",
          budget_ms: 30000,
        },
      ],
    });
    const hints = emitRestartHints(prev, next);
    expect(hints).toContain(RESTART_HINT_MCP);
    expect(hints).toContain(RESTART_HINT_MEMORY_ROUTER);
    expect(hints).toContain(RESTART_HINT_HOOKS);
    expect(hints).toHaveLength(3);
  });

  it("returns empty list when manifests are deep-equal", () => {
    expect(emitRestartHints(manifest(), manifest())).toEqual([]);
  });

  it("ignores key ordering inside mcp env objects (canonicalisation)", () => {
    const prev = parseManifest({
      version: 1,
      tools: {
        mcp: [{ name: "oracle", command: ["node", "/x/oracle.js"], env: { A: "1", B: "2" } }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      memory: { directories: [] },
      hooks: [],
      policies: [],
    });
    const next = parseManifest({
      version: 1,
      tools: {
        mcp: [{ name: "oracle", command: ["node", "/x/oracle.js"], env: { B: "2", A: "1" } }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      memory: { directories: [] },
      hooks: [],
      policies: [],
    });
    expect(emitRestartHints(prev, next)).toEqual([]);
  });
});
