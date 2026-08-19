import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addJsonMcpServer,
  ensureMcpServers,
  getMcpServer,
  listMcpServers,
  manualRemoveLines,
  parseClaudeMcpListOutput,
  posixSingleQuote,
  removeMcpServer,
  resolveClaudeUserRegistryPath,
  resolveMcpConfigDirOverride,
  stripOwnedMcpServers,
  type ClaudeMcpExec,
  type ClaudeMcpExecResult,
} from "../../src/io/claude-mcp.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";

function ok(stdout: string): ClaudeMcpExecResult {
  return { code: 0, stdout, stderr: "", enoent: false, timedOut: false };
}
function fail(code: number, stderr: string): ClaudeMcpExecResult {
  return { code, stdout: "", stderr, enoent: false, timedOut: false };
}
function enoent(): ClaudeMcpExecResult {
  return { code: 127, stdout: "", stderr: "spawn claude ENOENT", enoent: true, timedOut: false };
}
function timeout(): ClaudeMcpExecResult {
  return { code: -1, stdout: "", stderr: "", enoent: false, timedOut: true };
}

describe("addJsonMcpServer", () => {
  it("returns added on exit 0", async () => {
    const exec: ClaudeMcpExec = async () => ok("Added stdio MCP server foo to user config");
    const r = await addJsonMcpServer("foo", { command: "bar" }, { exec });
    expect(r).toEqual({ status: "added", message: "Added stdio MCP server foo to user config", code: 0 });
  });

  it("returns already-exists on the documented exit 1 message", async () => {
    const exec: ClaudeMcpExec = async () =>
      fail(1, "MCP server foo already exists in user config");
    const r = await addJsonMcpServer("foo", { command: "bar" }, { exec });
    expect(r.status).toBe("already-exists");
    expect(r.code).toBe(1);
  });

  it("returns invalid-config on malformed JSON exit 1", async () => {
    const exec: ClaudeMcpExec = async () => fail(1, "Invalid configuration");
    const r = await addJsonMcpServer("foo", { command: "bar" }, { exec });
    expect(r.status).toBe("invalid-config");
  });

  it("returns error for an undocumented non-zero exit", async () => {
    const exec: ClaudeMcpExec = async () => fail(2, "something else broke");
    const r = await addJsonMcpServer("foo", { command: "bar" }, { exec });
    expect(r.status).toBe("error");
    expect(r.message).toBe("something else broke");
  });

  it("returns cli-missing on ENOENT", async () => {
    const exec: ClaudeMcpExec = async () => enoent();
    const r = await addJsonMcpServer("foo", { command: "bar" }, { exec });
    expect(r.status).toBe("cli-missing");
  });

  it("returns timeout when the call is killed after the deadline", async () => {
    const exec: ClaudeMcpExec = async () => timeout();
    const r = await addJsonMcpServer("foo", { command: "bar" }, { exec, timeoutMs: 5 });
    expect(r.status).toBe("timeout");
    expect(r.message).toContain("5ms");
  });

  it("omits empty args/env from the JSON payload handed to the CLI", async () => {
    let seenArgs: string[] = [];
    const exec: ClaudeMcpExec = async (args) => {
      seenArgs = args;
      return ok("added");
    };
    await addJsonMcpServer("foo", { command: "bar", args: [], env: {} }, { exec });
    const payload = JSON.parse(seenArgs[seenArgs.length - 1] ?? "{}");
    expect(payload).toEqual({ command: "bar" });
  });

  it("passes scope user and the server name as CLI args", async () => {
    let seenArgs: string[] = [];
    const exec: ClaudeMcpExec = async (args) => {
      seenArgs = args;
      return ok("added");
    };
    await addJsonMcpServer("foo", { command: "bar", args: ["--x"] }, { exec });
    expect(seenArgs.slice(0, 4)).toEqual(["mcp", "add-json", "--scope", "user"]);
    expect(seenArgs[4]).toBe("foo");
    expect(JSON.parse(seenArgs[5] ?? "{}")).toEqual({ command: "bar", args: ["--x"] });
  });
});

describe("removeMcpServer", () => {
  it("returns removed on exit 0", async () => {
    const exec: ClaudeMcpExec = async () => ok("");
    const r = await removeMcpServer("foo", { exec });
    expect(r.status).toBe("removed");
  });

  it("returns not-found on the documented exit 1 message", async () => {
    const exec: ClaudeMcpExec = async () =>
      fail(1, 'No MCP server named "foo" in user scope');
    const r = await removeMcpServer("foo", { exec });
    expect(r.status).toBe("not-found");
  });

  it("returns cli-missing on ENOENT", async () => {
    const exec: ClaudeMcpExec = async () => enoent();
    const r = await removeMcpServer("foo", { exec });
    expect(r.status).toBe("cli-missing");
  });

  it("returns timeout on timeout", async () => {
    const exec: ClaudeMcpExec = async () => timeout();
    const r = await removeMcpServer("foo", { exec });
    expect(r.status).toBe("timeout");
  });

  it("passes scope user and the server name as CLI args", async () => {
    let seenArgs: string[] = [];
    const exec: ClaudeMcpExec = async (args) => {
      seenArgs = args;
      return ok("");
    };
    await removeMcpServer("foo", { exec });
    expect(seenArgs).toEqual(["mcp", "remove", "--scope", "user", "foo"]);
  });
});

describe("getMcpServer", () => {
  it("returns found on exit 0", async () => {
    const exec: ClaudeMcpExec = async () => ok("Scope: User\nStatus: connected");
    const r = await getMcpServer("foo", { exec });
    expect(r.status).toBe("found");
    expect(r.raw).toContain("connected");
  });

  it("returns not-found on exit 1", async () => {
    const exec: ClaudeMcpExec = async () => fail(1, "No such server");
    const r = await getMcpServer("foo", { exec });
    expect(r.status).toBe("not-found");
  });

  it("returns cli-missing on ENOENT", async () => {
    const exec: ClaudeMcpExec = async () => enoent();
    const r = await getMcpServer("foo", { exec });
    expect(r.status).toBe("cli-missing");
  });

  it("returns timeout on timeout", async () => {
    const exec: ClaudeMcpExec = async () => timeout();
    const r = await getMcpServer("foo", { exec });
    expect(r.status).toBe("timeout");
  });
});

describe("parseClaudeMcpListOutput", () => {
  it("parses a Connected entry", () => {
    const entries = parseClaudeMcpListOutput(
      "grounding-mcp: /usr/local/bin/grounding-mcp --stdio - ✔ Connected",
    );
    expect(entries).toEqual([
      {
        name: "grounding-mcp",
        command: "/usr/local/bin/grounding-mcp",
        args: ["--stdio"],
        status: "connected",
        statusText: "Connected",
      },
    ]);
  });

  it("parses a Failed to connect entry", () => {
    const entries = parseClaudeMcpListOutput("dead-server: /bin/dead - ✘ Failed to connect");
    expect(entries[0]).toMatchObject({ name: "dead-server", status: "failed", statusText: "Failed to connect" });
  });

  it("parses a foreign entry whose name contains a space and command is a URL", () => {
    const entries = parseClaudeMcpListOutput(
      "claude.ai Gmail: https://example.com/mcp - ! Needs authentication",
    );
    expect(entries).toEqual([
      {
        name: "claude.ai Gmail",
        command: "https://example.com/mcp",
        args: [],
        status: "needs-authentication",
        statusText: "Needs authentication",
      },
    ]);
  });

  it("parses multiple lines and skips blank/unmatched lines", () => {
    const entries = parseClaudeMcpListOutput(
      [
        "agent-tasks: /bin/agent-tasks - ✔ Connected",
        "",
        "not a matching line",
        "codebase-oracle: /bin/oracle --flag - ✘ Failed to connect",
      ].join("\n"),
    );
    expect(entries.map((e) => e.name)).toEqual(["agent-tasks", "codebase-oracle"]);
  });

  it("returns an empty array for empty stdout", () => {
    expect(parseClaudeMcpListOutput("")).toEqual([]);
  });
});

describe("listMcpServers", () => {
  it("returns ok with parsed servers on exit 0, even when a server is dead", async () => {
    const exec: ClaudeMcpExec = async () =>
      ok("a: /bin/a - ✔ Connected\nb: /bin/b - ✘ Failed to connect");
    const r = await listMcpServers({ exec });
    expect(r.status).toBe("ok");
    expect(r.servers).toHaveLength(2);
  });

  it("returns cli-missing on ENOENT", async () => {
    const exec: ClaudeMcpExec = async () => enoent();
    const r = await listMcpServers({ exec });
    expect(r.status).toBe("cli-missing");
  });

  it("returns timeout on timeout", async () => {
    const exec: ClaudeMcpExec = async () => timeout();
    const r = await listMcpServers({ exec });
    expect(r.status).toBe("timeout");
  });

  it("returns error on an unexpected non-zero exit", async () => {
    const exec: ClaudeMcpExec = async () => fail(3, "boom");
    const r = await listMcpServers({ exec });
    expect(r.status).toBe("error");
    expect(r.message).toBe("boom");
  });
});

describe("realClaudeMcpExec hermetic spawn guard (task 0d80e969)", () => {
  // Direct test on the primitive application: every exported verb here
  // defaults `opts.exec` to the module-private `realClaudeMcpExec`
  // (src/io/claude-mcp.ts), which calls `assertNoRealSpawnInTests` before
  // touching `child_process`. These calls give NO `exec` at all, so they
  // fall through to that real spawn path — under vitest it must refuse
  // instead of actually invoking `claude`. Non-inert: removing the
  // `assertNoRealSpawnInTests(...)` call at the top of `realClaudeMcpExec`
  // makes these reject on a real `spawn("claude", ...)` attempt instead
  // (ENOENT on a machine without the `claude` CLI, or an actual `claude
  // mcp list`/`add-json` call against the operator's real registry on a
  // machine that has it) — see this task's verification notes for what
  // was observed.
  it("listMcpServers with no injected exec refuses instead of spawning the real claude CLI", async () => {
    await expect(listMcpServers()).rejects.toThrow(HermeticSpawnViolationError);
    await expect(listMcpServers()).rejects.toThrow(/Refusing to spawn a REAL "claude mcp list"/);
  });

  it("addJsonMcpServer with no injected exec refuses instead of spawning the real claude CLI", async () => {
    await expect(addJsonMcpServer("foo", { command: "bar" })).rejects.toThrow(
      HermeticSpawnViolationError,
    );
    await expect(addJsonMcpServer("foo", { command: "bar" })).rejects.toThrow(
      /Refusing to spawn a REAL "claude mcp add-json"/,
    );
  });

  it("removeMcpServer with no injected exec refuses instead of spawning the real claude CLI", async () => {
    await expect(removeMcpServer("foo")).rejects.toThrow(HermeticSpawnViolationError);
    await expect(removeMcpServer("foo")).rejects.toThrow(/Refusing to spawn a REAL "claude mcp remove"/);
  });

  it("getMcpServer with no injected exec refuses instead of spawning the real claude CLI", async () => {
    await expect(getMcpServer("foo")).rejects.toThrow(HermeticSpawnViolationError);
    await expect(getMcpServer("foo")).rejects.toThrow(/Refusing to spawn a REAL "claude mcp get"/);
  });
});

describe("realClaudeMcpExec — real spawn CLAUDE_CONFIG_DIR alignment (batch19/T-005-R2, review round 2, Fix 1 — task fb3e4dce)", () => {
  // The hermetic-spawn tests above prove `realClaudeMcpExec` REFUSES a real
  // spawn under vitest by default — necessary, but not sufficient: every
  // OTHER test in this file injects a fake `exec`, so the actual
  // `configDir` -> `CLAUDE_CONFIG_DIR` env-passing line inside
  // `realClaudeMcpExec` (src/io/claude-mcp.ts) could be deleted or
  // corrupted and the full suite would stay green (the HIGH finding this
  // fixes). Pinned here via ONE real spawn, using the suite's documented
  // per-site escape hatch `HARNESS_ALLOW_REAL_SPAWN=1`
  // (src/runtime/hermetic-spawn-guard.ts; precedent:
  // tests/cli/session-start/stale-base-check.test.ts's
  // `withRealSpawnAllowed`), against a throwaway `claude` SHIM this test
  // itself writes under `os.tmpdir()` — never the real Claude Code CLI,
  // never the operator's real `~/.claude.json`. The shim also lives under
  // `os.tmpdir()`, so the suite-wide hermetic-spawn-allowlist backstop
  // (tests/_helpers/hermetic-spawn-allowlist.ts, D3 "a fixture the calling
  // test itself created under os.tmpdir()") would independently let it
  // through even without the escape hatch.
  let dir: string;
  let claudeBin: string;
  let seenFile: string;
  let savedPath: string | undefined;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-real-spawn-"));
    claudeBin = path.join(dir, "claude");
    seenFile = path.join(dir, "seen-config-dir.txt");
    // Writes whatever CLAUDE_CONFIG_DIR it actually received (or a
    // sentinel when unset) to `seenFile`, then reports an ordinary
    // add-json success so `addJsonMcpServer` doesn't need to special-case
    // the shim's output shape.
    fs.writeFileSync(
      claudeBin,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(seenFile)}, process.env.CLAUDE_CONFIG_DIR ?? "\\0UNSET\\0");`,
        "process.stdout.write('Added stdio MCP server real-spawn-test to user config');",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(claudeBin, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `HARNESS_ALLOW_REAL_SPAWN=1` is `realClaudeMcpExec`'s (and the
   * suite-wide hermetic-spawn-allowlist's) documented escape hatch for a
   * test that deliberately exercises the real spawn path end-to-end.
   * Mirrors `withRealSpawnAllowed` in
   * tests/cli/session-start/stale-base-check.test.ts. Scoped with
   * try/finally so a thrown assertion still restores the prior value.
   */
  async function withRealSpawnAllowed<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.HARNESS_ALLOW_REAL_SPAWN;
    process.env.HARNESS_ALLOW_REAL_SPAWN = "1";
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.HARNESS_ALLOW_REAL_SPAWN;
      else process.env.HARNESS_ALLOW_REAL_SPAWN = prev;
    }
  }

  it("an explicit configDir wins over the parent process's own CLAUDE_CONFIG_DIR (real spawn, no injected exec)", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/parent-process-own-value-must-not-leak";
    const override = path.join(dir, "override-config-dir");
    const r = await withRealSpawnAllowed(() =>
      addJsonMcpServer("real-spawn-test", { command: "bar" }, { configDir: override }),
    );
    expect(r.status).toBe("added");
    expect(fs.readFileSync(seenFile, "utf8")).toBe(override);
  });

  it("negative control: with NO configDir given, the real spawn inherits the parent's own CLAUDE_CONFIG_DIR verbatim (no override injected)", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/parent-process-own-value-should-be-inherited";
    const r = await withRealSpawnAllowed(() =>
      addJsonMcpServer("real-spawn-test", { command: "bar" }),
    );
    expect(r.status).toBe("added");
    expect(fs.readFileSync(seenFile, "utf8")).toBe(
      "/parent-process-own-value-should-be-inherited",
    );
  });
});

describe("resolveClaudeUserRegistryPath", () => {
  it("uses CLAUDE_CONFIG_DIR when set", () => {
    const p = resolveClaudeUserRegistryPath({ env: { CLAUDE_CONFIG_DIR: "/tmp/cfgdir" } });
    expect(p).toBe(path.join("/tmp/cfgdir", ".claude.json"));
  });

  it("falls back to ~/.claude.json derived from homeDir when unset", () => {
    const p = resolveClaudeUserRegistryPath({ homeDir: "/home/lan/.claude", env: {} });
    expect(p).toBe("/home/lan/.claude.json");
  });

  it("defaults homeDir to os.homedir()/.claude when neither is given", () => {
    const p = resolveClaudeUserRegistryPath({ env: {} });
    expect(p).toBe(path.join(os.homedir(), ".claude.json"));
  });
});

describe("ensureMcpServers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-ensure-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registryPath(): string {
    return path.join(tmpDir, ".claude.json");
  }

  function writeRegistry(obj: unknown): void {
    fs.writeFileSync(registryPath(), JSON.stringify(obj), "utf8");
  }

  it("adds a server missing from the registry (no registry file yet = empty state)", async () => {
    const calls: string[] = [];
    const exec: ClaudeMcpExec = async (args) => {
      calls.push(args.join(" "));
      return ok("added");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar", args: ["--x"] } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([{ name: "foo", action: "add", add: { status: "added", message: "added", code: 0 } }]);
    expect(calls).toEqual(["mcp add-json --scope user foo {\"command\":\"bar\",\"args\":[\"--x\"]}"]);
  });

  it("is a no-op with ZERO exec calls when the registry already matches (args default [] tolerated)", async () => {
    writeRegistry({ mcpServers: { foo: { command: "bar" } } });
    let execCalls = 0;
    const exec: ClaudeMcpExec = async () => {
      execCalls++;
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar", args: [] } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([{ name: "foo", action: "noop" }]);
    expect(execCalls).toBe(0);
  });

  it("is a no-op when env matches regardless of key order", async () => {
    writeRegistry({ mcpServers: { foo: { command: "bar", env: { B: "2", A: "1" } } } });
    let execCalls = 0;
    const exec: ClaudeMcpExec = async () => {
      execCalls++;
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar", env: { A: "1", B: "2" } } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([{ name: "foo", action: "noop" }]);
    expect(execCalls).toBe(0);
  });

  it("replaces (remove then add-json) on drift", async () => {
    writeRegistry({ mcpServers: { foo: { command: "old-binary" } } });
    const calls: string[] = [];
    const exec: ClaudeMcpExec = async (args) => {
      calls.push(args[0] === "mcp" ? `${args[0]} ${args[1]}` : args.join(" "));
      if (args[1] === "remove") return ok("");
      return ok("added");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "new-binary" } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([
      {
        name: "foo",
        action: "replace",
        remove: { status: "removed", message: "", code: 0 },
        add: { status: "added", message: "added", code: 0 },
      },
    ]);
    expect(calls).toEqual(["mcp remove", "mcp add-json"]);
  });

  it("stops after remove when remove fails for a reason other than not-found (does not call add-json)", async () => {
    writeRegistry({ mcpServers: { foo: { command: "old-binary" } } });
    let addCalled = false;
    const exec: ClaudeMcpExec = async (args) => {
      if (args[1] === "remove") return enoent();
      addCalled = true;
      return ok("added");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "new-binary" } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([
      { name: "foo", action: "replace", remove: { status: "cli-missing", message: "claude CLI not found on PATH", code: 127 } },
    ]);
    expect(addCalled).toBe(false);
  });

  it("skips every desired server (no exec calls) when the registry file is malformed JSON", async () => {
    fs.writeFileSync(registryPath(), "{not json", "utf8");
    let execCalls = 0;
    const exec: ClaudeMcpExec = async () => {
      execCalls++;
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar" } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.action).toBe("skipped");
    expect(r.results[0]?.reason).toContain("not valid JSON");
    expect(execCalls).toBe(0);
  });

  it("ignores foreign entries and never reads projects.<path>.mcpServers", async () => {
    writeRegistry({
      mcpServers: { unrelated: { command: "keep-me" } },
      projects: { "/some/path": { mcpServers: { foo: { command: "should-be-ignored" } } } },
    });
    const exec: ClaudeMcpExec = async () => ok("added");
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar" } },
      exec,
      registryPath: registryPath(),
    });
    // `foo` is absent from the TOP-LEVEL mcpServers (the projects.*.foo
    // entry must not satisfy it), so it's added, not treated as a match.
    expect(r.results).toEqual([{ name: "foo", action: "add", add: { status: "added", message: "added", code: 0 } }]);
  });
});

describe("ensureMcpServers CLAUDE_CONFIG_DIR alignment (batch19/T-005, Finding 2 — task fb3e4dce)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-configdir-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads configDir === dirname(registryPath) to exec for a NON-DEFAULT home, matching the drift-read directory", async () => {
    // A non-default Claude Code home, the way `wireClaudeMcp` passes
    // `homeDir: claudeHomeDir` (`path.dirname(o.claudeSettingsPath)`,
    // derived from harness's own `--home` override) — NOT
    // `os.homedir()/.claude`. Before this fix, `realClaudeMcpExec` spawned
    // with no explicit env at all, so a real `claude` CLI invoked this way
    // would mutate/read `~/.claude.json` (the OS default) instead of the
    // file `ensureMcpServers` actually compared `desired` against here —
    // exactly the divergence this test pins.
    const nonDefaultHome = path.join(tmpDir, "custom-harness-home", ".claude");
    fs.mkdirSync(nonDefaultHome, { recursive: true });
    const seenConfigDirs: (string | undefined)[] = [];
    const exec: ClaudeMcpExec = async (_args, _timeoutMs, configDir) => {
      seenConfigDirs.push(configDir);
      return ok("added");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar" } },
      exec,
      homeDir: nonDefaultHome,
    });
    const expectedRegistryPath = resolveClaudeUserRegistryPath({ homeDir: nonDefaultHome, env: {} });
    expect(r.registryPath).toBe(expectedRegistryPath);
    // The exact directory `ensureMcpServers` read `mcpServers` from for
    // the drift comparison, NOT `os.homedir()` (which the pre-fix code
    // would have implicitly fallen back to via plain `process.env`
    // inheritance).
    expect(path.dirname(expectedRegistryPath)).not.toBe(os.homedir());
    expect(seenConfigDirs).toEqual([path.dirname(expectedRegistryPath)]);
  });

  it("threads the SAME configDir to add-json, remove, AND get across a replace + already-exists-verify sequence", async () => {
    // Exercises all three verbs `ensureMcpServers` can call in one pass
    // (remove -> add-json -> get, the already-exists-verify branch) and
    // asserts every one of them saw the identical configDir — the
    // real-CLI-spawn/drift-read alignment must hold for every verb, not
    // just a fresh add.
    const nonDefaultHome = path.join(tmpDir, "another-home", ".claude");
    fs.mkdirSync(nonDefaultHome, { recursive: true });
    const registryFile = path.join(path.dirname(nonDefaultHome), ".claude.json");
    fs.writeFileSync(registryFile, JSON.stringify({ mcpServers: { foo: { command: "old-binary" } } }), "utf8");
    const seenConfigDirs: (string | undefined)[] = [];
    const exec: ClaudeMcpExec = async (args, _timeoutMs, configDir) => {
      seenConfigDirs.push(configDir);
      if (args[1] === "remove") return ok("");
      if (args[1] === "add-json") return fail(1, "MCP server foo already exists in user config");
      if (args[1] === "get") return ok("foo:\n  Scope: User config\n  Status: ✘ Failed to connect");
      return ok("");
    };
    await ensureMcpServers({
      desired: { foo: { command: "new-binary" } },
      exec,
      homeDir: nonDefaultHome,
    });
    const expectedConfigDir = path.dirname(
      resolveClaudeUserRegistryPath({ homeDir: nonDefaultHome, env: {} }),
    );
    expect(seenConfigDirs).toEqual([expectedConfigDir, expectedConfigDir, expectedConfigDir]);
  });
});

describe("resolveMcpConfigDirOverride (batch19/T-005-R2, review round 2, Fix 2 — task fb3e4dce)", () => {
  // Pure-function coverage of the decision logic `ensureMcpServers` and
  // uninstall's `removeRegisteredMcpServers` both call. Deliberately NOT
  // exercised through `ensureMcpServers` for the pure-default case: doing
  // so would require leaving `homeDir`/`registryPath`/`env` all at their
  // real defaults, which would read the OPERATOR'S REAL `~/.claude.json`
  // — exactly what this task's assignment forbids testing against. This
  // function has no file I/O at all, so it's safe to call directly with a
  // real (but harmless) `os.homedir()`.

  it("returns undefined for the pure default resolution (no CLAUDE_CONFIG_DIR, no homeDir/registryPath override) — the R2 correction", () => {
    // R1 returned `path.dirname(registryPath)` here unconditionally, which
    // on this exact path is `os.homedir()` itself (registryPath is
    // `~/.claude.json`, directly under HOME) — NOT `~/.claude`, the CLI's
    // own actual default CLAUDE_CONFIG_DIR. `undefined` is the corrected,
    // genuinely-a-no-op answer.
    expect(resolveMcpConfigDirOverride({ env: {} })).toBeUndefined();
  });

  it("passes an effective CLAUDE_CONFIG_DIR straight through", () => {
    expect(resolveMcpConfigDirOverride({ env: { CLAUDE_CONFIG_DIR: "/tmp/cfgdir" } })).toBe(
      "/tmp/cfgdir",
    );
  });

  it("an empty-string CLAUDE_CONFIG_DIR does not count as set (falls through to the homeDir/default check, matching resolveClaudeUserRegistryPath)", () => {
    expect(resolveMcpConfigDirOverride({ env: { CLAUDE_CONFIG_DIR: "" } })).toBeUndefined();
  });

  it("returns dirname(homeDir) when homeDir differs from the OS default", () => {
    expect(resolveMcpConfigDirOverride({ homeDir: "/tmp/custom-home/.claude", env: {} })).toBe(
      "/tmp/custom-home",
    );
  });

  it("returns undefined when an explicit homeDir happens to equal the OS default (still no override in play)", () => {
    const osDefault = path.join(os.homedir(), ".claude");
    expect(resolveMcpConfigDirOverride({ homeDir: osDefault, env: {} })).toBeUndefined();
  });

  it("an explicit registryPath override always wins, even alongside a homeDir override", () => {
    expect(
      resolveMcpConfigDirOverride({
        registryPath: "/tmp/explicit-registry/.claude.json",
        homeDir: "/tmp/custom-home/.claude",
        env: {},
      }),
    ).toBe("/tmp/explicit-registry");
  });

  it("CLAUDE_CONFIG_DIR in env takes precedence over a homeDir override (matches resolveClaudeUserRegistryPath's own precedence)", () => {
    expect(
      resolveMcpConfigDirOverride({
        homeDir: "/tmp/custom-home/.claude",
        env: { CLAUDE_CONFIG_DIR: "/tmp/cfgdir" },
      }),
    ).toBe("/tmp/cfgdir");
  });
});

describe("ensureMcpServers already-exists verification (batch19/T-005, Finding 3 — task fb3e4dce)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-already-exists-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registryPath(): string {
    return path.join(tmpDir, ".claude.json");
  }

  function writeRegistry(obj: unknown): void {
    fs.writeFileSync(registryPath(), JSON.stringify(obj), "utf8");
  }

  it("a MATCHING already-exists (confirmed via claude mcp get + a fresh registry re-read) is surfaced as verifiedAlreadyExists.matches=true", async () => {
    // The registry file `ensureMcpServers` reads BEFORE calling add-json
    // has no `foo` yet (current === undefined, so it takes the add-json
    // branch) — but the live CLI reports "already exists", and by the
    // time it does, the file actually DOES contain `foo` with a spec
    // identical to `desired.foo` (simulating a registration this run's
    // own earlier file-read snapshot raced ahead of / didn't see).
    writeRegistry({ mcpServers: {} });
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = async (args) => {
      calls.push(args);
      if (args[1] === "add-json") {
        writeRegistry({ mcpServers: { foo: { command: "bar", args: ["--x"] } } });
        return fail(1, "MCP server foo already exists in user config");
      }
      if (args[1] === "get") {
        return ok("foo:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected");
      }
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar", args: ["--x"] } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([
      {
        name: "foo",
        action: "add",
        add: { status: "already-exists", message: "MCP server foo already exists in user config", code: 1 },
        verifiedAlreadyExists: { getStatus: "found", matches: true },
      },
    ]);
    expect(calls.map((a) => a.slice(0, 2).join(" "))).toEqual(["mcp add-json", "mcp get"]);
  });

  it("a MISMATCHED already-exists (get finds it, but the live spec differs) keeps verifiedAlreadyExists.matches=false — prior conservative outcome preserved", async () => {
    writeRegistry({ mcpServers: {} });
    const exec: ClaudeMcpExec = async (args) => {
      if (args[1] === "add-json") {
        // Live registry actually holds a DIFFERENT command than `desired`.
        writeRegistry({ mcpServers: { foo: { command: "someone-elses-binary" } } });
        return fail(1, "MCP server foo already exists in user config");
      }
      if (args[1] === "get") {
        return ok("foo:\n  Scope: User config\n  Status: ✔ Connected");
      }
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar" } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results).toEqual([
      {
        name: "foo",
        action: "add",
        add: { status: "already-exists", message: "MCP server foo already exists in user config", code: 1 },
        verifiedAlreadyExists: { getStatus: "found", matches: false },
      },
    ]);
  });

  it("already-exists whose verification `claude mcp get` itself can't find the server keeps matches=false (getStatus not-found)", async () => {
    writeRegistry({ mcpServers: {} });
    const exec: ClaudeMcpExec = async (args) => {
      if (args[1] === "add-json") return fail(1, "MCP server foo already exists in user config");
      if (args[1] === "get") return fail(1, "No such server");
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar" } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results[0]?.verifiedAlreadyExists).toEqual({ getStatus: "not-found", matches: false });
  });

  it("a TIMED-OUT verification `claude mcp get` still falls back to the file check, and a match counts as verified (batch19/T-005-R2, Fix 4 — task fb3e4dce)", async () => {
    // R1 treated any getStatus other than "found" as a reason to leave
    // matches=false, WITHOUT even consulting the file — so a `get` call
    // that merely timed out (inconclusive, not a positive "absent") could
    // silently override a genuinely File-verified match. Fixed: only a
    // real "not-found" skips the file check; "found" and inconclusive
    // (timeout/cli-missing) both fall through to it.
    writeRegistry({ mcpServers: {} });
    const exec: ClaudeMcpExec = async (args) => {
      if (args[1] === "add-json") {
        // Simulates a registration this run's own earlier file-read
        // snapshot raced ahead of, same setup as the MATCHING test above.
        writeRegistry({ mcpServers: { foo: { command: "bar", args: ["--x"] } } });
        return fail(1, "MCP server foo already exists in user config");
      }
      if (args[1] === "get") return timeout();
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar", args: ["--x"] } },
      exec,
      registryPath: registryPath(),
    });
    expect(r.results[0]?.verifiedAlreadyExists).toEqual({ getStatus: "timeout", matches: true });
  });

  it("a plain \"added\" outcome never triggers a get call and never carries verifiedAlreadyExists", async () => {
    let getCalled = false;
    const exec: ClaudeMcpExec = async (args) => {
      if (args[1] === "get") getCalled = true;
      return ok("added");
    };
    const r = await ensureMcpServers({
      desired: { foo: { command: "bar" } },
      exec,
      registryPath: registryPath(),
    });
    expect(getCalled).toBe(false);
    expect(r.results[0]).not.toHaveProperty("verifiedAlreadyExists");
  });
});

describe("ensureMcpServers gc option (task 363a6de0, MCP-removal GC)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-gc-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registryPath(): string {
    return path.join(tmpDir, ".claude.json");
  }

  function writeRegistry(obj: unknown): void {
    fs.writeFileSync(registryPath(), JSON.stringify(obj), "utf8");
  }

  it("removes an owned, registered, no-longer-desired server (remove branch, exact command)", async () => {
    writeRegistry({ mcpServers: { "stale-owned": { command: "old-bin" } } });
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = async (args) => {
      calls.push(args);
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: {},
      exec,
      registryPath: registryPath(),
      gc: { ownedNames: ["stale-owned"] },
    });
    expect(r.gc?.results).toEqual([
      { name: "stale-owned", action: "removed", remove: { status: "removed", message: "", code: 0 } },
    ]);
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "stale-owned"]]);
  });

  it("leaves a foreign (non-owned) registered server untouched (ownership boundary)", async () => {
    writeRegistry({ mcpServers: { "foreign-server": { command: "someone-elses-bin" } } });
    let execCalls = 0;
    const exec: ClaudeMcpExec = async () => {
      execCalls++;
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: {},
      exec,
      registryPath: registryPath(),
      gc: { ownedNames: ["some-other-owned-name"] },
    });
    expect(r.gc?.results).toEqual([]);
    expect(execCalls).toBe(0);
  });

  it("does not GC an owned name still present in desired, even if its registered content drifted (operator-hotfix protection)", async () => {
    writeRegistry({ mcpServers: { "agent-tasks": { command: "operator-hotfix-bin" } } });
    const calls: string[][] = [];
    const exec: ClaudeMcpExec = async (args) => {
      calls.push(args);
      if (args[1] === "remove") return ok("");
      return ok("added");
    };
    const r = await ensureMcpServers({
      desired: { "agent-tasks": { command: "bridge-bin" } },
      exec,
      registryPath: registryPath(),
      gc: { ownedNames: ["agent-tasks"] },
    });
    // Main loop resyncs the drifted entry via its normal replace path...
    expect(r.results).toEqual([
      {
        name: "agent-tasks",
        action: "replace",
        remove: { status: "removed", message: "", code: 0 },
        add: { status: "added", message: "added", code: 0 },
      },
    ]);
    // ...and GC sees zero candidates: `agent-tasks` is owned but ALSO in
    // `desired`, so the desired-membership check excludes it before
    // ownership is even considered — no separate content check needed.
    expect(r.gc?.results).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("is fully idempotent: GC removes once, a second run against the resulting registry makes zero exec calls", async () => {
    writeRegistry({ mcpServers: { "stale-owned": { command: "old-bin" } } });
    function statefulRemoveExec(calls: string[][]): ClaudeMcpExec {
      return async (args) => {
        calls.push(args);
        if (args[0] === "mcp" && args[1] === "remove") {
          const registry = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Record<string, unknown>;
          const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
          delete mcpServers[args[4]!];
          registry["mcpServers"] = mcpServers;
          fs.writeFileSync(registryPath(), JSON.stringify(registry));
        }
        return ok("");
      };
    }

    const firstCalls: string[][] = [];
    const r1 = await ensureMcpServers({
      desired: {},
      exec: statefulRemoveExec(firstCalls),
      registryPath: registryPath(),
      gc: { ownedNames: ["stale-owned"] },
    });
    expect(r1.gc?.results.map((g) => g.name)).toEqual(["stale-owned"]);
    expect(firstCalls).toEqual([["mcp", "remove", "--scope", "user", "stale-owned"]]);

    const secondCalls: string[][] = [];
    const r2 = await ensureMcpServers({
      desired: {},
      exec: statefulRemoveExec(secondCalls),
      registryPath: registryPath(),
      gc: { ownedNames: ["stale-owned"] },
    });
    expect(r2.gc?.results).toEqual([]);
    expect(secondCalls).toHaveLength(0);
  });

  it("skips GC entirely (no remove attempted) when the registry can't be read safely, and surfaces the error", async () => {
    fs.writeFileSync(registryPath(), "{not json", "utf8");
    let execCalls = 0;
    const exec: ClaudeMcpExec = async () => {
      execCalls++;
      return ok("");
    };
    const r = await ensureMcpServers({
      desired: {},
      exec,
      registryPath: registryPath(),
      gc: { ownedNames: ["stale-owned"] },
    });
    expect(r.gc?.results).toEqual([]);
    expect(r.gc?.registryReadError).toContain("not valid JSON");
    expect(execCalls).toBe(0);
  });

  it("cli-missing on remove: reported as skipped with a reason, not a hard failure", async () => {
    writeRegistry({ mcpServers: { "stale-owned": { command: "old-bin" } } });
    const exec: ClaudeMcpExec = async () => enoent();
    const r = await ensureMcpServers({
      desired: {},
      exec,
      registryPath: registryPath(),
      gc: { ownedNames: ["stale-owned"] },
    });
    expect(r.gc?.results).toEqual([
      {
        name: "stale-owned",
        action: "skipped",
        remove: { status: "cli-missing", message: "claude CLI not found on PATH", code: 127 },
        reason: "claude CLI not found on PATH",
      },
    ]);
    // The caller (wireClaudeMcp) builds the copy-pasteable fallback from
    // exactly these skipped names.
    expect(manualRemoveLines(r.gc!.results.map((g) => g.name))).toEqual([
      "claude mcp remove --scope user 'stale-owned'",
    ]);
  });

  it("without opts.gc, a stale owned entry is left alone and gc is undefined (unchanged pre-GC behavior)", async () => {
    writeRegistry({ mcpServers: { "stale-owned": { command: "old-bin" } } });
    let execCalls = 0;
    const exec: ClaudeMcpExec = async () => {
      execCalls++;
      return ok("");
    };
    const r = await ensureMcpServers({ desired: {}, exec, registryPath: registryPath() });
    expect(r.gc).toBeUndefined();
    expect(execCalls).toBe(0);
  });
});

describe("manualRemoveLines", () => {
  it("builds one sorted, quoted `claude mcp remove` line per name", () => {
    expect(manualRemoveLines(["b-server", "a-server"])).toEqual([
      "claude mcp remove --scope user 'a-server'",
      "claude mcp remove --scope user 'b-server'",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(manualRemoveLines([])).toEqual([]);
  });
});

describe("stripOwnedMcpServers", () => {
  it("removes an only-owned block entirely and preserves other keys", () => {
    const settings = { env: { FOO: "1" }, mcpServers: { "agent-tasks": { command: "a" }, "grounding-mcp": { command: "g" } } };
    const r = stripOwnedMcpServers(settings, ["agent-tasks", "grounding-mcp"]);
    expect(r.settings).toEqual({ env: { FOO: "1" } });
    expect(r.removedNames).toEqual(["agent-tasks", "grounding-mcp"]);
  });

  it("removes only owned names from a mixed block, keeps foreign entries", () => {
    const settings = {
      mcpServers: {
        "agent-tasks": { command: "a" },
        "operator-own": { command: "mine" },
      },
    };
    const r = stripOwnedMcpServers(settings, ["agent-tasks", "grounding-mcp"]);
    expect(r.settings).toEqual({ mcpServers: { "operator-own": { command: "mine" } } });
    expect(r.removedNames).toEqual(["agent-tasks"]);
  });

  it("is a no-op when mcpServers is absent", () => {
    const settings = { hooks: {}, env: { X: "1" } };
    const r = stripOwnedMcpServers(settings, ["agent-tasks"]);
    expect(r.settings).toBe(settings);
    expect(r.removedNames).toEqual([]);
  });

  it("is a no-op when mcpServers is present but not an object", () => {
    const settings = { mcpServers: ["corrupt"] };
    const r = stripOwnedMcpServers(settings, ["agent-tasks"]);
    expect(r.settings).toBe(settings);
    expect(r.removedNames).toEqual([]);
  });

  it("is a no-op when none of the owned names are present", () => {
    const settings = { mcpServers: { "operator-own": { command: "mine" } } };
    const r = stripOwnedMcpServers(settings, ["agent-tasks"]);
    expect(r.settings).toEqual({ mcpServers: { "operator-own": { command: "mine" } } });
    expect(r.removedNames).toEqual([]);
  });

  it("preserves the position and order of all other top-level keys", () => {
    const settings = { a: 1, mcpServers: { owned: { command: "x" } }, b: 2, c: 3 };
    const r = stripOwnedMcpServers(settings, ["owned"]);
    expect(Object.keys(r.settings)).toEqual(["a", "b", "c"]);
    expect(r.settings).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("leaves an untouched settings object byte-identical when nothing is removed", () => {
    const settings = { hooks: { x: 1 }, mcpServers: { foreign: { command: "f" } }, permissions: { allow: ["y"] } };
    const before = JSON.stringify(settings);
    const r = stripOwnedMcpServers(settings, ["agent-tasks"]);
    expect(JSON.stringify(r.settings)).toBe(before);
  });
});

describe("posixSingleQuote", () => {
  it("wraps a quote-free value in single quotes", () => {
    expect(posixSingleQuote('{"command":"grounding-mcp"}')).toBe(`'{"command":"grounding-mcp"}'`);
  });

  it("escapes an embedded single quote so the token stays shell-safe", () => {
    // A home path with an apostrophe reaches here via EVIDENCE_LEDGER_DB.
    const json = JSON.stringify({ env: { EVIDENCE_LEDGER_DB: "/Users/O'Brien/ledger.db" } });
    const quoted = posixSingleQuote(json);
    // Every apostrophe becomes the POSIX close-escape-reopen sequence '\''.
    expect(quoted).toBe(`'{"env":{"EVIDENCE_LEDGER_DB":"/Users/O'\\''Brien/ledger.db"}}'`);
    // And the token is balanced: it opens and closes with a single quote.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});
