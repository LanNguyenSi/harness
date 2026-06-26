// Unit tests for the three exported functions from
// src/runtime/tool-name-aliases.ts.
//
// All three functions are pure (no I/O, no async), so no home-dir override
// or subprocess is needed.

import { describe, expect, it } from "vitest";
import {
  expandCodexHookMatchPattern,
  expandToolNameAliases,
  extractShellCommand,
} from "../../src/runtime/tool-name-aliases.js";

// ── expandToolNameAliases ─────────────────────────────────────────────────────

describe("expandToolNameAliases — shell aliases", () => {
  it("an unrecognised tool name returns only itself", () => {
    expect(expandToolNameAliases("Read")).toEqual(["Read"]);
    expect(expandToolNameAliases("Write")).toEqual(["Write"]);
    expect(expandToolNameAliases("SomeFutureTool")).toEqual(["SomeFutureTool"]);
  });

  it("Bash expands to all four shell aliases", () => {
    const aliases = expandToolNameAliases("Bash");
    expect(aliases).toContain("Bash");
    expect(aliases).toContain("shell");
    expect(aliases).toContain("exec_command");
    expect(aliases).toContain("functions.exec_command");
    expect(aliases).toHaveLength(4);
  });

  it("shell expands to all four shell aliases (cross-alias symmetry)", () => {
    const aliases = expandToolNameAliases("shell");
    expect(aliases).toContain("Bash");
    expect(aliases).toContain("shell");
    expect(aliases).toContain("exec_command");
    expect(aliases).toContain("functions.exec_command");
  });

  it("exec_command expands to all four shell aliases", () => {
    expect(expandToolNameAliases("exec_command")).toContain("Bash");
    expect(expandToolNameAliases("exec_command")).toContain("functions.exec_command");
  });

  it("functions.exec_command expands to all four shell aliases", () => {
    const aliases = expandToolNameAliases("functions.exec_command");
    expect(aliases).toContain("Bash");
    expect(aliases).toContain("shell");
    expect(aliases).toContain("exec_command");
    expect(aliases).toContain("functions.exec_command");
  });
});

describe("expandToolNameAliases — MCP name variants", () => {
  it("mcp__server__tool expands to the double-underscore and dot variants with hyphen/underscore swaps", () => {
    const aliases = expandToolNameAliases("mcp__agent-tasks__pull_requests_merge");
    // Original form
    expect(aliases).toContain("mcp__agent-tasks__pull_requests_merge");
    // hyphen → underscore in server segment
    expect(aliases).toContain("mcp__agent_tasks__pull_requests_merge");
    // dot variant (original server)
    expect(aliases).toContain("mcp__agent-tasks__.pull_requests_merge");
    // dot variant (underscore server)
    expect(aliases).toContain("mcp__agent_tasks__.pull_requests_merge");
  });

  it("mcp__server__tool with underscore server expands to include the hyphen variant", () => {
    const aliases = expandToolNameAliases("mcp__my_server__my_tool");
    expect(aliases).toContain("mcp__my_server__my_tool");
    expect(aliases).toContain("mcp__my-server__my_tool"); // underscore → hyphen
    expect(aliases).toContain("mcp__my_server__.my_tool");
    expect(aliases).toContain("mcp__my-server__.my_tool");
  });

  it("the dot-prefix MCP variant mcp__server__.tool is normalised to both forms", () => {
    // Dot-prefix form as input: server is 'my-server', tool is 'my_tool'
    const aliases = expandToolNameAliases("mcp__my-server__.my_tool");
    expect(aliases).toContain("mcp__my-server__my_tool");
    expect(aliases).toContain("mcp__my-server__.my_tool");
    expect(aliases).toContain("mcp__my_server__my_tool");
    expect(aliases).toContain("mcp__my_server__.my_tool");
  });

  it("a plain mcp-prefixed name with neither __ nor . double-separator is not expanded (returned as-is)", () => {
    // This does not match any MCP regex, so it is treated as a plain tool.
    expect(expandToolNameAliases("mcp_invalid")).toEqual(["mcp_invalid"]);
  });

  it("result contains no duplicates regardless of input form", () => {
    const aliases = expandToolNameAliases("mcp__server__tool");
    const unique = new Set(aliases);
    expect(unique.size).toBe(aliases.length);
  });
});

// ── expandCodexHookMatchPattern ───────────────────────────────────────────────

describe("expandCodexHookMatchPattern — passthrough on special chars", () => {
  it("returns the string unchanged when a token contains a special character", () => {
    expect(expandCodexHookMatchPattern("my-tool(")).toBe("my-tool(");
    expect(expandCodexHookMatchPattern("*")).toBe("*");
    expect(expandCodexHookMatchPattern("tool with space")).toBe("tool with space");
  });

  it("returns unchanged when any segment in a pipe-list has special chars", () => {
    // "Bash" is simple, but "foo(bar" trips the guard → whole string returned unchanged
    expect(expandCodexHookMatchPattern("Bash|foo(bar")).toBe("Bash|foo(bar");
  });
});

describe("expandCodexHookMatchPattern — expansion", () => {
  it("single Bash token expands to a pipe-separated list of all shell aliases", () => {
    const result = expandCodexHookMatchPattern("Bash");
    const parts = result.split("|");
    expect(parts).toContain("Bash");
    expect(parts).toContain("shell");
    expect(parts).toContain("exec_command");
    expect(parts).toContain("functions.exec_command");
  });

  it("a plain unrecognised tool returns only itself (idempotent)", () => {
    expect(expandCodexHookMatchPattern("Read")).toBe("Read");
    expect(expandCodexHookMatchPattern("MyTool")).toBe("MyTool");
  });

  it("pipe-separated tokens each get expanded and merged into a deduplicated result", () => {
    // "Bash|shell" — both expand to the same 4 aliases, deduplicated → 4 items
    const result = expandCodexHookMatchPattern("Bash|shell");
    const parts = result.split("|");
    const unique = new Set(parts);
    expect(unique.size).toBe(parts.length); // no duplicates
    expect(parts).toContain("Bash");
    expect(parts).toContain("shell");
  });

  it("a pipe pattern mixing shell and non-shell tools merges all aliases", () => {
    const result = expandCodexHookMatchPattern("Bash|Read");
    const parts = result.split("|");
    expect(parts).toContain("Bash");
    expect(parts).toContain("shell");
    expect(parts).toContain("exec_command");
    expect(parts).toContain("Read");
  });

  it("an MCP tool name in a pipe list expands to its server hyphen/underscore variants", () => {
    const result = expandCodexHookMatchPattern("mcp__my-server__my_tool");
    const parts = result.split("|");
    expect(parts).toContain("mcp__my-server__my_tool");
    expect(parts).toContain("mcp__my_server__my_tool");
  });
});

// ── extractShellCommand ───────────────────────────────────────────────────────

describe("extractShellCommand", () => {
  it("returns null for an empty event object", () => {
    expect(extractShellCommand({})).toBeNull();
  });

  it("returns null when no candidate field has a command/cmd key", () => {
    expect(extractShellCommand({ tool_input: { other: "value" } })).toBeNull();
  });

  it("extracts command from tool_input.command", () => {
    expect(
      extractShellCommand({ tool_input: { command: "git status" } }),
    ).toBe("git status");
  });

  it("extracts cmd from tool_input.cmd (Codex alias)", () => {
    expect(
      extractShellCommand({ tool_input: { cmd: "ls -la" } }),
    ).toBe("ls -la");
  });

  it("extracts command from raw_input.command", () => {
    expect(
      extractShellCommand({ raw_input: { command: "npm test" } }),
    ).toBe("npm test");
  });

  it("extracts cmd from raw_input.cmd", () => {
    expect(
      extractShellCommand({ raw_input: { cmd: "cargo build" } }),
    ).toBe("cargo build");
  });

  it("extracts command from input.command", () => {
    expect(
      extractShellCommand({ input: { command: "make" } }),
    ).toBe("make");
  });

  it("extracts cmd from input.cmd", () => {
    expect(
      extractShellCommand({ input: { cmd: "pytest" } }),
    ).toBe("pytest");
  });

  it("prefers tool_input over raw_input over input", () => {
    expect(
      extractShellCommand({
        tool_input: { command: "first" },
        raw_input: { command: "second" },
        input: { command: "third" },
      }),
    ).toBe("first");
  });

  it("falls through to raw_input when tool_input has no command field", () => {
    expect(
      extractShellCommand({
        tool_input: { other: "x" },
        raw_input: { command: "second" },
        input: { command: "third" },
      }),
    ).toBe("second");
  });

  it("falls through to input when neither tool_input nor raw_input has a command field", () => {
    expect(
      extractShellCommand({
        tool_input: { other: "x" },
        raw_input: { other: "y" },
        input: { command: "third" },
      }),
    ).toBe("third");
  });

  it("returns null when command value is not a string", () => {
    expect(extractShellCommand({ tool_input: { command: 42 } })).toBeNull();
    expect(extractShellCommand({ tool_input: { command: null } })).toBeNull();
    expect(extractShellCommand({ tool_input: { command: ["arr"] } })).toBeNull();
  });

  it("returns null when candidate field is not an object (null / primitive)", () => {
    expect(extractShellCommand({ tool_input: null })).toBeNull();
    expect(extractShellCommand({ tool_input: "string" })).toBeNull();
    expect(extractShellCommand({ tool_input: 42 })).toBeNull();
  });

  it("cmd takes lower priority than command within the same candidate", () => {
    // Within tool_input, command wins over cmd when both are present
    expect(
      extractShellCommand({ tool_input: { command: "git log", cmd: "git diff" } }),
    ).toBe("git log");
  });
});
