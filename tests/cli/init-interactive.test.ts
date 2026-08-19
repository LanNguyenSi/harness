import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runInteractive as runInteractiveReal,
  type InteractivePrompts,
  type RunInteractiveOptions,
} from "../../src/cli/init/interactive.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";
import { signingKeyPathFor } from "../../src/runtime/approval-signing.js";
import { STUB_NPM_BIN_EXEC_WARN } from "../_helpers/npm-bin-exec.js";

// Stub for `npm prefix -g` (task npm-prefix-g-hermeticity-guard/T-004).
// Every call in this file goes through the `runInteractive` wrapper below
// instead of the SDK export directly, so init()'s post-write bin-resolution
// check (src/cli/doctor/npm-bin-path.ts) never spawns a real npm process.
// Real `npm prefix -g` returns `code: 0` plus a genuine prefix path, which
// resolves to status "ok" or "warn" depending on PATH — deliberately the
// "warn" stub variant (see tests/_helpers/npm-bin-exec.ts for why: a
// blanket `{ code: 1 }` "unknown" stub would shift binResolutionClean /
// binResolutionErrorCount assertions here).

// Thin wrapper so every one of this file's ~60 `runInteractive(...)` call
// sites gets `npmBinExec` injected without editing each one individually.
// A test that needs different npm behavior can still override it by setting
// its own `npmBinExec` in `opts` (spread after the default below).
function runInteractive(opts: RunInteractiveOptions = {}): ReturnType<typeof runInteractiveReal> {
  return runInteractiveReal({ npmBinExec: STUB_NPM_BIN_EXEC_WARN, ...opts });
}

// Helper: build a mock prompts pack that returns queued answers in order
// the wizard asks them. This is intentionally dumb — we match by prompt
// kind (select / confirm / input / checkbox), not by message string,
// because tying tests to copy means every wording tweak breaks them.
// The wizard's prompt order is documented in src/cli/init/interactive.ts.
function mockPrompts(queue: {
  select?: string[];
  confirm?: boolean[];
  input?: string[];
  checkbox?: string[][];
}): InteractivePrompts {
  const selectQ = [...(queue.select ?? [])];
  const confirmQ = [...(queue.confirm ?? [])];
  const inputQ = [...(queue.input ?? [])];
  const checkboxQ = [...(queue.checkbox ?? [])];
  return {
    select: (async () => {
      const v = selectQ.shift();
      if (v === undefined) throw new Error("mockPrompts: select queue empty");
      return v;
    }) as unknown as InteractivePrompts["select"],
    confirm: (async () => {
      const v = confirmQ.shift();
      // An exhausted confirm queue auto-declines (returns false). The
      // only prompt every non-custom flow now reaches WITHOUT an explicit
      // queued answer is the trailing orchestrator-workflow co-install
      // offer (added with the OW install-coupling). Defaulting it to "no"
      // keeps the pre-OW tests opt-out of OW without each needing a
      // redundant trailing `false`, and means no test spawns a real
      // `npx`. The OW-specific tests below queue the answer explicitly and
      // inject `owInitSpawn`. select/input/checkbox stay strict (throw on
      // empty) so a mis-ordered EARLIER prompt still fails loudly.
      if (v === undefined) return false;
      return v;
    }) as unknown as InteractivePrompts["confirm"],
    input: (async () => {
      const v = inputQ.shift();
      if (v === undefined) throw new Error("mockPrompts: input queue empty");
      return v;
    }) as unknown as InteractivePrompts["input"],
    checkbox: (async () => {
      const v = checkboxQ.shift();
      if (v === undefined) throw new Error("mockPrompts: checkbox queue empty");
      return v;
    }) as unknown as InteractivePrompts["checkbox"],
  };
}

function captureStreams(): { stdout: () => string; stderr: () => string; out: (s: string) => void; err: (s: string) => void } {
  let out = "";
  let err = "";
  return {
    stdout: () => out,
    stderr: () => err,
    out: (s: string) => {
      out += s;
    },
    err: (s: string) => {
      err += s;
    },
  };
}

// Stateful fake `claude` CLI: `add-json`/`remove` mutate a JSON file at
// `registryPath`, mirroring the real CLI's effect on
// `$CLAUDE_CONFIG_DIR/.claude.json` (here: `<tmpHome>/.claude.json`, per
// `resolveClaudeUserRegistryPath`'s precedence). This lets a second
// `ensureMcpServers` drift-check (or a second wizard run) see the servers
// a prior run "registered"/"removed" and correctly reconcile, without a
// real `claude` binary. Module-scope (not describe-local) so both the
// MCP-registration and MCP-removal-GC describe blocks below can share it.
function fakeClaudeCli(registryPath: string): {
  exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  function readRegistry(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  function writeRegistry(registry: Record<string, unknown>): void {
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  }
  const exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec = async (args) => {
    calls.push(args);
    if (args[0] === "mcp" && args[1] === "add-json") {
      const name = args[4]!;
      const spec = JSON.parse(args[5]!) as unknown;
      const registry = readRegistry();
      const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
      mcpServers[name] = spec;
      registry["mcpServers"] = mcpServers;
      writeRegistry(registry);
      return {
        code: 0,
        stdout: `Added stdio MCP server ${name} to user config\n`,
        stderr: "",
        enoent: false,
        timedOut: false,
      };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      const name = args[4]!;
      const registry = readRegistry();
      const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
      delete mcpServers[name];
      registry["mcpServers"] = mcpServers;
      writeRegistry(registry);
      return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
  };
  return { exec, calls };
}

function cliMissingExec(): import("../../src/io/claude-mcp.js").ClaudeMcpExec {
  return async () => ({
    code: 127,
    stdout: "",
    stderr: "spawn failed: ENOENT",
    enoent: true,
    timedOut: false,
  });
}

// `fakeDepsPath` points at a tmp directory containing executable stubs
// for every binary `dependenciesForProfile("full")` looks for. Tests
// that do not exercise the dependency-install flow pass
// `dependencyPathEnv: fakeDepsPath` to short-circuit the dep check
// (every dep reads as "already installed"), so the wizard never tries
// to run `npm i -g`.
//
// Without this, tests on CI (where the @lannguyensi/* binaries are NOT
// globally installed by `npm ci`) would fall through into the install
// prompt, consume a queued confirm meant for a later step, and spawn a
// real `npm i -g` that times out under the 5s vitest budget. See
// agent-tasks/69ef84cd for the regression incident.
let tmpHome: string;
let fakeDepsPath: string;
let savedHarnessHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wizard-"));
  fakeDepsPath = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wizard-deps-"));
  // The wizard resolves the harness home through `resolveHomeDir`, whose
  // `$HARNESS_HOME` tier outranks the `userHome`-based resolution these
  // tests rely on. Clear it so a CI env leak cannot redirect detect() /
  // init() away from the per-test tmp home.
  savedHarnessHome = process.env.HARNESS_HOME;
  delete process.env.HARNESS_HOME;
  for (const bin of [
    "memory-router-user-prompt-submit",
    "understanding-gate-claude-hook",
    "understanding-gate-claude-stop",
    "agent-tasks-mcp-bridge",
    "grounding-mcp",
    "preflight",
  ]) {
    const p = path.join(fakeDepsPath, bin);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeDepsPath, { recursive: true, force: true });
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
});

describe("interactive wizard — Solo path", () => {
  it("writes a solo manifest, runs validate, returns validateClean (skip wiring)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
        ],
        checkbox: [
          [], // uncheck every runtime → skip wiring
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(result.validateClean).toBe(true);
    // Task 7f8fb4bc: Solo's tools.mcp/tools.cli are empty (memory-router
    // lives under memory.router, outside this check's scope), so the
    // bin-resolution check is clean regardless of PATH.
    expect(result.binResolutionClean).toBe(true);
    expect(result.apply).toBeUndefined();
    expect(result.applies).toEqual([]);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    expect(cap.stderr()).toMatch(/Environment probe/);
    expect(cap.stderr()).toMatch(/harness validate: 0 error/);
    // When the operator unchecks all runtimes, the manifest-only
    // follow-up command MUST be the merge-into-settings.json incantation
    // (not the bare `apply --runtime claude-code` that only writes to
    // harness.generated/ and confuses fresh users).
    expect(cap.stderr()).toContain("harness apply --target");
    expect(cap.stderr()).toContain("--merge");
    // The skip-fallback must also surface the codex manual path so a
    // Codex-only operator who reads the skip message knows how to wire.
    expect(cap.stderr()).toContain("harness apply --runtime codex");
    // Hallucination regression guard from the original test: the wizard
    // must NOT suggest `--runtime claude` shorthand (the real flag value
    // is `claude-code`; the bare `claude` shorthand falls back at runtime
    // with a warning and reads as wrong to operators).
    expect(cap.stderr()).not.toContain("--runtime claude\n");
    expect(cap.stderr()).not.toContain("--runtime claude ");
  });

  it("auto-runs the merge-apply when the operator selects claude-code", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
        ],
        checkbox: [
          ["claude-code"],
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toHaveLength(1);
    expect(result.applies?.[0]?.runtime).toBe("claude-code");
    expect(result.applies?.[0]?.apply?.targetWritten).toBe(true);
    // Legacy `apply` shorthand still set for claude-code wiring.
    expect(result.apply).toBeDefined();
    expect(result.apply?.targetWritten).toBe(true);
    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    expect(result.apply?.targetPath).toBe(settingsPath);
    expect(fs.existsSync(settingsPath)).toBe(true);
    // Verify the merge actually projected the harness-owned shape — not
    // just that a file exists at the path. Future refactors that break
    // the projection without breaking the existence check still trip
    // this assertion.
    const wired = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(wired.hooks).toBeDefined();
    expect(cap.stderr()).toContain("wired into");
    expect(cap.stderr()).toContain("verify: claude -p");
    expect(cap.stderr()).not.toContain("--runtime claude\n");
  });

  it("wire-now reports success when settings.json is already in sync (700636f4 regression)", async () => {
    // The init wire-now false-negative: an idempotent merge (the merged
    // content is byte-identical to the existing settings.json, so apply
    // writes nothing) returns `targetWritten: false`. The old wire-now
    // branch read `!targetWritten` as "not wired" and printed
    // "Wire-now did not write ... Retry manually", sending the operator
    // into a loop of redundant `harness apply` commands. It must instead
    // report the runtime as wired.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const runOnce = async (
      forceOverwrite: boolean,
    ): Promise<{ result: Awaited<ReturnType<typeof runInteractive>>; stderr: string }> => {
      const cap = captureStreams();
      const result = await runInteractive({
        homeDir: tmpHome,
        dependencyPathEnv: fakeDepsPath,
        forceOverwrite,
        prompts: mockPrompts({
          select: ["solo"],
          input: ["~/.claude/projects/{project}/memory"],
          confirm: [true],
          checkbox: [["claude-code"]],
        }),
        stdout: cap.out,
        stderr: cap.err,
      });
      return { result, stderr: cap.stderr() };
    };
    // First run wires settings.json from scratch.
    const first = await runOnce(false);
    expect(first.result.applies?.[0]?.apply?.targetWritten).toBe(true);
    // Second run: manifest + settings.json are already in sync, so
    // wire-now's merge is an idempotent no-op.
    const second = await runOnce(true);
    const secondApply = second.result.applies?.[0]?.apply;
    expect(secondApply?.targetWritten).toBe(false);
    expect(secondApply?.targetInSync).toBe(true);
    expect(second.stderr).toContain("wired into");
    expect(second.stderr).toContain("(already in sync)");
    expect(second.stderr).not.toContain("Wire-now did not write");
  });

  it("wire-now bypasses stale-snapshot drift (agent-tasks/df68b3e6 regression)", async () => {
    // The bug this guards: a pre-existing `~/.claude/harness.generated/settings.json`
    // (from a prior harness version, or any state where the .last-apply
    // snapshot is missing/stale) caused the wire-now apply to return
    // drift-refuse silently. targetWritten stayed false, no "wired into"
    // message printed, no error thrown — the operator saw the codex
    // section of the wire output and concluded everything was fine,
    // while settings.json never received the new pack hooks (this was
    // the v0.17.2 dogfood incident: branch-protection landed in
    // FULL_TEMPLATE but never wired into the operator's settings.json).
    //
    // Fix: init's wireRuntime passes overwriteDrift + auto-confirm so
    // the canonical "wire this freshly written manifest" intent always
    // lands, regardless of pre-existing harness.generated state. Drift
    // safeguards are appropriate for ad-hoc `harness apply`, not for
    // init's start-from-scratch path.
    fs.mkdirSync(path.join(tmpHome, ".claude", "harness.generated"), { recursive: true });
    // Seed a stale generated/settings.json with content that won't
    // match the about-to-be-written manifest. Without the fix, the
    // missing .last-apply snapshot makes this look like full-file
    // drift and apply refuses to overwrite.
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "harness.generated", "settings.json"),
      JSON.stringify({ hooks: { Stale: [{ hooks: [] }] } }, null, 2),
    );
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies?.[0]?.runtime).toBe("claude-code");
    // The load-bearing assertion: targetWritten is true even though
    // there was pre-existing drift in harness.generated/settings.json.
    expect(result.applies?.[0]?.apply?.targetWritten).toBe(true);
    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const wired = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(wired.hooks).toBeDefined();
    // And no "Stale" hooks survive — the merge used the freshly-applied
    // generated/settings.json, not the stale one we seeded.
    expect(JSON.stringify(wired.hooks)).not.toContain("Stale");
    expect(cap.stderr()).toContain("wired into");
  });

  it("recovers gracefully when the wire-now merge throws (permission denied / malformed target)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // Pre-create the target as unreadable JSON: apply --merge throws
    // when the existing file is not valid JSON. The wizard must catch
    // that, print a recovery hint, and still return validateClean.
    fs.writeFileSync(path.join(tmpHome, ".claude", "settings.json"), "not-json{");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
        ],
        checkbox: [
          ["claude-code"], // wire-now will fail inside apply
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toHaveLength(1);
    expect(result.applies?.[0]?.runtime).toBe("claude-code");
    expect(result.applies?.[0]?.apply).toBeUndefined();
    expect(result.applies?.[0]?.recoveryHint).toMatch(/harness apply --target .* --merge/);
    expect(result.apply).toBeUndefined();
    expect(cap.stderr()).toMatch(/Failed to wire/);
    expect(cap.stderr()).toMatch(/harness apply --target .* --merge/);
  });
});

describe("interactive wizard — MCP registration + settings.json migration (task init-mcp-wiring-claude-code/T-002)", () => {
  it("registers manifest MCP servers via the claude CLI (not settings.json) and cleans up a dead settings.json mcpServers block", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // Legacy state: a dead mcpServers block in settings.json carrying both
    // harness-owned names (from a pre-T-002 harness version) and a
    // foreign, operator-added entry.
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          mcpServers: {
            "agent-tasks": { command: "old-agent-tasks" },
            "grounding-mcp": { command: "old-grounding" },
            "my-own-server": { command: "mine" },
          },
        },
        null,
        2,
      ),
    );
    const registryPath = path.join(tmpHome, ".claude.json");
    const { exec, calls } = fakeClaudeCli(registryPath);
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: exec,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        // task 83d8d03a: detect() now reads the EFFECTIVE registry
        // (~/.claude.json), not the dead settings.json block seeded
        // above. The registry doesn't exist yet at wizard-start, so
        // agent-tasks reads as "not yet wired" and the "Team profile ...
        // proceed?" confirm fires first, then the write confirmation.
        confirm: [true, true],
        checkbox: [["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    expect(outcome?.runtime).toBe("claude-code");

    // Ensure: both manifest servers added via the claude CLI (never a
    // settings.json write).
    const ensureNames = outcome?.mcpEnsure?.results.map((r) => r.name).sort();
    expect(ensureNames).toEqual(["agent-tasks", "grounding-mcp"]);
    expect(
      outcome?.mcpEnsure?.results.every((r) => r.action === "add" && r.add?.status === "added"),
    ).toBe(true);
    const addCalls = calls.filter((c) => c[1] === "add-json");
    expect(addCalls.map((c) => c[4]).sort()).toEqual(["agent-tasks", "grounding-mcp"]);
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    expect(registry.mcpServers["agent-tasks"]).toEqual({ command: "agent-tasks-mcp-bridge" });
    expect(registry.mcpServers["grounding-mcp"]?.command).toBe("grounding-mcp");
    expect(registry.mcpServers["grounding-mcp"]?.env?.["EVIDENCE_LEDGER_DB"]).toContain(
      ".evidence-ledger/ledger.db",
    );
    // task 03a917fd/H1b: same real-registration path also carries
    // SOLUTION_VERDICT_SIGNING_KEY now (loadDesiredMcpServers ->
    // projectSigningKeyEnv), an absolute path to the harness's own
    // approval-signing key under the SAME generatedDir apply() itself
    // used for this run (outcome.apply.generatedDir).
    expect(outcome?.apply?.generatedDir).toBeDefined();
    expect(registry.mcpServers["grounding-mcp"]?.env?.["SOLUTION_VERDICT_SIGNING_KEY"]).toBe(
      signingKeyPathFor(outcome!.apply!.generatedDir),
    );

    // Migration: harness-owned names stripped from the dead settings.json
    // block; the foreign entry survives untouched.
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(settings.mcpServers).toEqual({ "my-own-server": { command: "mine" } });
    expect(outcome?.mcpMigrationRemovedNames?.slice().sort()).toEqual([
      "agent-tasks",
      "grounding-mcp",
    ]);
    expect(cap.stderr()).toContain("registered 2 MCP server(s) with the claude CLI");
    expect(cap.stderr()).toContain("removed 2 dead mcpServers entries");
  });

  it("second init run is fully idempotent: no further claude CLI calls, no settings.json write", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const registryPath = path.join(tmpHome, ".claude.json");
    const runOnce = async (forceOverwrite: boolean, confirms: boolean[]): Promise<{ stderr: string; calls: string[][] }> => {
      // A fresh fake per run, but pointed at the SAME on-disk registry
      // file, so state persists across runs exactly like the real CLI
      // persisting to `~/.claude.json` would.
      const { exec: runExec, calls } = fakeClaudeCli(registryPath);
      const cap = captureStreams();
      await runInteractive({
        homeDir: tmpHome,
        dependencyPathEnv: fakeDepsPath,
        forceOverwrite,
        mcpExec: runExec,
        authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
        prompts: mockPrompts({
          select: ["team"],
          // Each run must queue EXACTLY the confirms its flow consumes so
          // the trailing OW co-install offer always hits a dry queue
          // (auto-decline — see the mockPrompts contract above). A
          // leftover `true` here reaches that offer and spawns a real
          // `npx orchestrator-workflow init`.
          confirm: confirms,
          checkbox: [["claude-code"]],
          input: ["~/.claude/projects/{project}/memory"],
        }),
        stdout: cap.out,
        stderr: cap.err,
      });
      return { stderr: cap.stderr(), calls };
    };

    // Run 1: registry doesn't exist yet, so detect() (task 83d8d03a:
    // registry-aware) reads agent-tasks as "not yet wired" — the "Team
    // profile ... proceed?" confirm fires, then the write confirmation.
    const first = await runOnce(false, [true, true]);
    expect(first.calls.filter((c) => c[1] === "add-json")).toHaveLength(2);
    expect(first.stderr).toContain("registered 2 MCP server(s)");

    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    const settingsBeforeSecondRun = fs.readFileSync(settingsPath, "utf8");
    const registryBeforeSecondRun = fs.readFileSync(registryPath, "utf8");

    // Run 2: the registry now holds both servers, so detect() reads
    // agent-tasks as wired and the proceed confirm does NOT fire — only
    // the write confirmation consumes an answer. Queueing a second
    // `true` here would leak into the OW co-install offer (real npx
    // spawn; >5s on cold CI runners — run 29798137418).
    const second = await runOnce(true, [true]);
    // Ensure sees both servers already correctly registered (identical
    // spec on disk in the registry file) — zero exec calls at all.
    expect(second.calls).toHaveLength(0);
    expect(second.stderr).not.toContain("registered");
    expect(second.stderr).not.toContain("removed");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(settingsBeforeSecondRun);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(registryBeforeSecondRun);
  });

  it("claude CLI missing: warns, prints manual add-json commands, continues without failing, and skips the settings.json migration", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "old" } } }, null, 2),
    );
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: cliMissingExec(),
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        // task 83d8d03a: detect() reads the effective registry
        // (~/.claude.json), not the dead settings.json block seeded
        // above, so agent-tasks reads as "not yet wired" and the "Team
        // profile ... proceed?" confirm fires first, then the write
        // confirmation.
        confirm: [true, true],
        checkbox: [["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    // No hard fail: the wizard still completes and reports the runtime.
    expect(outcome?.runtime).toBe("claude-code");
    expect(outcome?.mcpEnsure?.results.every((r) => r.add?.status === "cli-missing")).toBe(true);
    expect(cap.stderr()).toContain("claude` CLI is not on PATH");
    expect(cap.stderr()).toContain("claude mcp add-json --scope user agent-tasks");
    expect(cap.stderr()).toContain("claude mcp add-json --scope user grounding-mcp");
    // Migration did not run: the dead block is untouched (D-002).
    expect(outcome?.mcpMigrationRemovedNames).toBeUndefined();
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(settings.mcpServers).toEqual({ "agent-tasks": { command: "old" } });
  });

  it("no runtimes selected: prints manual claude mcp add-json fallback commands for the manifest's MCP servers", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.applies).toEqual([]);
    expect(cap.stderr()).toContain("claude-code hooks: harness apply --target");
    expect(cap.stderr()).toContain("claude mcp add-json --scope user agent-tasks");
    expect(cap.stderr()).toContain("claude mcp add-json --scope user grounding-mcp");
  });
});

describe("interactive wizard — already-exists gate (batch19/T-005, Finding 3 — task fb3e4dce)", () => {
  // Bespoke fake CLI (not the shared `fakeClaudeCli` helper): for
  // `alreadyExistsName`, `add-json` reports the documented "already
  // exists" outcome instead of "added" — simulating a registration
  // `ensureMcpServers`'s own earlier registry-file read didn't see (the
  // exact condition Finding 3 fixes) — while every OTHER desired name
  // (here: the sibling manifest MCP server) goes through the ordinary
  // add-json path. `matchingSpec: true` persists a spec-IDENTICAL entry to
  // the registry file as a side effect of the "already exists" branch
  // (simulating that the live CLI genuinely already has it correctly
  // registered); `matchingSpec: false` persists a DIFFERENT command,
  // simulating a genuine drift the verification must not paper over.
  function fakeClaudeCliWithAlreadyExists(
    registryPath: string,
    alreadyExistsName: string,
    matchingSpec: boolean,
  ): { exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec; calls: string[][] } {
    const calls: string[][] = [];
    function readRegistry(): Record<string, unknown> {
      try {
        return JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    function writeRegistry(registry: Record<string, unknown>): void {
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    }
    const exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec = async (args) => {
      calls.push(args);
      if (args[0] === "mcp" && args[1] === "add-json") {
        const name = args[4]!;
        const spec = JSON.parse(args[5]!) as Record<string, unknown>;
        if (name === alreadyExistsName) {
          const registry = readRegistry();
          const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
          mcpServers[name] = matchingSpec ? spec : { command: "someone-elses-binary" };
          registry["mcpServers"] = mcpServers;
          writeRegistry(registry);
          return {
            code: 1,
            stdout: "",
            stderr: `MCP server ${name} already exists in user config`,
            enoent: false,
            timedOut: false,
          };
        }
        const registry = readRegistry();
        const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
        mcpServers[name] = spec;
        registry["mcpServers"] = mcpServers;
        writeRegistry(registry);
        return {
          code: 0,
          stdout: `Added stdio MCP server ${name} to user config\n`,
          stderr: "",
          enoent: false,
          timedOut: false,
        };
      }
      if (args[0] === "mcp" && args[1] === "get") {
        const name = args[2]!;
        const registry = readRegistry();
        const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
        if (mcpServers[name] !== undefined) {
          return {
            code: 0,
            stdout: `${name}:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n`,
            stderr: "",
            enoent: false,
            timedOut: false,
          };
        }
        return { code: 1, stdout: "", stderr: `No MCP server named "${name}"`, enoent: false, timedOut: false };
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        const name = args[4]!;
        const registry = readRegistry();
        const mcpServers = (registry["mcpServers"] as Record<string, unknown>) ?? {};
        delete mcpServers[name];
        registry["mcpServers"] = mcpServers;
        writeRegistry(registry);
        return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
      }
      return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
    };
    return { exec, calls };
  }

  /**
   * The verb sequence (in call order) `calls` recorded for a single
   * server `name` — `add-json` matches on `args[4]`, `get` on `args[2]`
   * (their respective name-argument positions). Used to pin Finding 5
   * (batch19/T-005-R2, review round 2, task fb3e4dce): `mcp get` must
   * follow `mcp add-json` ONLY for the already-exists name, never for an
   * ordinary sibling that just gets added.
   */
  function verbSequenceForName(calls: string[][], name: string): string[] {
    return calls
      .filter((c) => (c[1] === "add-json" && c[4] === name) || (c[1] === "get" && c[2] === name))
      .map((c) => c[1]!);
  }

  it("a VERIFIED-MATCHING already-exists counts as success: allOk holds, the dead settings.json mcpServers block is still migrated, and no failure warning prints", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "old-agent-tasks" } } }, null, 2),
    );
    const registryPath = path.join(tmpHome, ".claude.json");
    const { exec, calls } = fakeClaudeCliWithAlreadyExists(registryPath, "agent-tasks", true);
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: exec,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    const agentTasksResult = outcome?.mcpEnsure?.results.find((r) => r.name === "agent-tasks");
    expect(agentTasksResult?.add?.status).toBe("already-exists");
    expect(agentTasksResult?.verifiedAlreadyExists).toEqual({ getStatus: "found", matches: true });

    // Migration still ran (D-002 gate held despite the "already exists"
    // add-json outcome) — the dead settings.json entry is stripped.
    expect(outcome?.mcpMigrationRemovedNames).toEqual(["agent-tasks"]);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(settings.mcpServers).toBeUndefined();
    expect(cap.stderr()).not.toContain("Registering one or more MCP servers");
    expect(cap.stderr()).not.toContain("claude` CLI is not on PATH");

    // Finding 5 (R2): `mcp get` follows `mcp add-json` ONLY for the
    // already-exists name (agent-tasks); every sibling desired name (the
    // "team" profile's other manifest MCP server(s)) only ever sees a
    // plain `add-json` — nothing in `fakeClaudeCliWithAlreadyExists`'s
    // `calls` was previously asserted on at all.
    expect(verbSequenceForName(calls, "agent-tasks")).toEqual(["add-json", "get"]);
    const siblingNames = new Set(
      calls.filter((c) => c[1] === "add-json" && c[4] !== "agent-tasks").map((c) => c[4]!),
    );
    expect(siblingNames.size).toBeGreaterThan(0);
    for (const name of siblingNames) {
      expect(verbSequenceForName(calls, name)).toEqual(["add-json"]);
    }

    // Finding 6 (R2): the success message is split by what actually
    // happened this run — "registered" for freshly add-json'd names,
    // "confirmed ... already registered" for the verified-already-exists
    // one. Before this fix both buckets were reported as "registered",
    // falsely implying agent-tasks was freshly registered by this run.
    const allResults = outcome?.mcpEnsure?.results ?? [];
    const freshlyRegisteredNames = allResults
      .filter((r) => r.add?.status === "added")
      .map((r) => r.name);
    const confirmedNames = allResults
      .filter((r) => r.verifiedAlreadyExists?.matches === true)
      .map((r) => r.name);
    expect(confirmedNames).toEqual(["agent-tasks"]);
    expect(freshlyRegisteredNames.length).toBeGreaterThan(0);
    expect(cap.stderr()).toContain(
      `registered ${freshlyRegisteredNames.length} MCP server(s) with the claude CLI (user scope): ${freshlyRegisteredNames.join(", ")}`,
    );
    expect(cap.stderr()).toContain(
      `confirmed ${confirmedNames.length} MCP server(s) already registered with the claude CLI (user scope): ${confirmedNames.join(", ")}`,
    );
  });

  it("a VERIFIED-MISMATCHED already-exists keeps the prior conservative behavior: allOk fails, migration is skipped, and the failure warning prints", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "old-agent-tasks" } } }, null, 2),
    );
    const registryPath = path.join(tmpHome, ".claude.json");
    const { exec, calls } = fakeClaudeCliWithAlreadyExists(registryPath, "agent-tasks", false);
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: exec,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    const agentTasksResult = outcome?.mcpEnsure?.results.find((r) => r.name === "agent-tasks");
    expect(agentTasksResult?.add?.status).toBe("already-exists");
    expect(agentTasksResult?.verifiedAlreadyExists).toEqual({ getStatus: "found", matches: false });

    // Migration did NOT run (D-002: prior conservative behavior held) —
    // the dead settings.json entry survives untouched.
    expect(outcome?.mcpMigrationRemovedNames).toBeUndefined();
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(settings.mcpServers).toEqual({ "agent-tasks": { command: "old-agent-tasks" } });
    expect(cap.stderr()).toContain("Registering one or more MCP servers with the `claude` CLI failed:");
    expect(cap.stderr()).toContain("agent-tasks: MCP server agent-tasks already exists in user config");

    // Finding 5 (R2): same verb-order pin as the matching-spec test above
    // — `get` follows `add-json` ONLY for the already-exists name, even
    // on the mismatched-spec/failure path.
    expect(verbSequenceForName(calls, "agent-tasks")).toEqual(["add-json", "get"]);
    const siblingNames = new Set(
      calls.filter((c) => c[1] === "add-json" && c[4] !== "agent-tasks").map((c) => c[4]!),
    );
    expect(siblingNames.size).toBeGreaterThan(0);
    for (const name of siblingNames) {
      expect(verbSequenceForName(calls, name)).toEqual(["add-json"]);
    }
  });
});

describe("interactive wizard — MCP-removal GC (task 363a6de0)", () => {
  // Both tests below force apply()'s `--merge` step to throw (invalid
  // existing settings.json — same trick the "recovers gracefully when the
  // wire-now merge throws" test above uses), landing wireRuntime in the
  // catch branch. wireClaudeMcp still runs there (it's independent of the
  // hooks/settings.json merge outcome) — and crucially, THIS run's
  // apply() throws before ever reaching its own `.last-apply` write
  // (apply.ts's merge-parse throw happens before `writeLastApply`), so a
  // `.last-apply` seeded beforehand (as if left by a PRIOR, successful
  // run) survives untouched for wireClaudeMcp's GC ownership build to
  // read. Both tests use the "solo" profile so the current manifest's own
  // `tools.mcp[]` is empty, isolating the GC behavior from the ordinary
  // add/replace path.

  it(".last-apply manifest snapshot: a name owned under a PRIOR manifest (absent from the current one) is still GC'd (D-107 snapshot union)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "settings.json"), "not-json{");

    const generatedDir = path.join(tmpHome, ".harness", "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, ".last-apply"),
      JSON.stringify({
        files: {},
        manifest: {
          sha256: "unused-in-test",
          content: JSON.stringify({
            tools: { mcp: [{ name: "legacy-only-mcp", command: "legacy-bin", enabled: true }] },
          }),
        },
      }),
    );

    const registryPath = path.join(tmpHome, ".claude.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ mcpServers: { "legacy-only-mcp": { command: "legacy-bin" } } }),
    );

    const calls: string[][] = [];
    const exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
    };

    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: exec,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    expect(outcome?.apply).toBeUndefined(); // apply() threw, caught by wireRuntime
    expect(outcome?.mcpEnsure?.gc?.results).toEqual([
      { name: "legacy-only-mcp", action: "removed", remove: { status: "removed", message: "", code: 0 } },
    ]);
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "legacy-only-mcp"]]);
    expect(cap.stderr()).toContain("deregistered 1 stale MCP server(s)");
    expect(cap.stderr()).toContain("legacy-only-mcp");
  });

  it("conservative fallback: without a .last-apply manifest snapshot, a registered-but-unowned name is left alone", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "settings.json"), "not-json{");
    // No .last-apply seeded at all this time — the conservative fallback
    // per D-107: without the snapshot, ownership is only the (here empty)
    // current manifest's names (DEFAULT_OWNED_MCP_SERVERS is no longer
    // part of GC eligibility at all — see the FIX-1 guard tests below),
    // so this name is indistinguishable from a foreign entry and is left
    // alone rather than guessed at.
    const registryPath = path.join(tmpHome, ".claude.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ mcpServers: { "legacy-only-mcp": { command: "legacy-bin" } } }),
    );

    let execCalls = 0;
    const exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec = async () => {
      execCalls++;
      return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
    };

    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: exec,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    expect(outcome?.mcpEnsure?.gc?.results).toEqual([]);
    expect(execCalls).toBe(0);
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registry.mcpServers).toEqual({ "legacy-only-mcp": { command: "legacy-bin" } });
  });

  it("corrupt .last-apply degrades to manifest-only ownership without crashing the wizard (FIX-4 double-throw guard)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const generatedDir = path.join(tmpHome, ".harness", "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    // Malformed JSON: readLastApply's own JSON.parse throws on this.
    // readPriorLastApply (src/cli/init/interactive.ts) must catch it and
    // degrade to null — D-107's conservative fallback — rather than let
    // the throw escape. Pins the Pass-1 double-throw crash path: apply()
    // ALSO reads `.last-apply` internally (apply.ts, unrelated to this
    // task) and throws on the SAME corrupt file; wireRuntime's own
    // try/catch already handles that first throw — this test's job is to
    // prove wireClaudeMcp's read of the SAME file doesn't throw a SECOND
    // time from inside the catch branch (which, pre-fix, had no outer
    // try to catch it and would crash the whole wizard).
    fs.writeFileSync(path.join(generatedDir, ".last-apply"), "{corrupt");

    const registryPath = path.join(tmpHome, ".claude.json");
    // A custom server that would ONLY be recognized as owned via a valid
    // snapshot (it's absent from the — here empty, solo — current
    // manifest). With the snapshot corrupt/unreadable, it must NOT be
    // removed: the conservative fallback, not a guess.
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ mcpServers: { "legacy-only-mcp": { command: "legacy-bin" } } }),
    );

    let execCalls = 0;
    const exec: import("../../src/io/claude-mcp.js").ClaudeMcpExec = async () => {
      execCalls++;
      return { code: 0, stdout: "", stderr: "", enoent: false, timedOut: false };
    };

    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: exec,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });

    // (a) No throw escapes to the wizard: it completes normally.
    expect(result.aborted).toBe(false);
    const outcome = result.applies?.[0];
    expect(outcome?.runtime).toBe("claude-code");
    // apply() itself ALSO reads `.last-apply` (apply.ts, pre-existing,
    // out of this task's scope) and throws on the same corrupt content —
    // wireRuntime's pre-existing try/catch handles that, landing here in
    // the catch-branch outcome shape (apply undefined, recoveryHint
    // set). The load-bearing assertion is what happens NEXT: wireClaudeMcp/
    // readPriorLastApply must not throw a SECOND time from inside that
    // catch branch.
    expect(outcome?.apply).toBeUndefined();
    expect(outcome?.recoveryHint).toBeDefined();

    // (b) GC degrades to manifest-only ownership: "legacy-only-mcp"
    // would only be owned via the (corrupt) snapshot, so it is left
    // alone — zero exec calls, not removed.
    expect(outcome?.mcpEnsure?.gc?.results).toEqual([]);
    expect(execCalls).toBe(0);
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registry.mcpServers).toEqual({ "legacy-only-mcp": { command: "legacy-bin" } });
  });

  it("FIX-1 guard (D-107 HIGH finding): a DEFAULT_OWNED-named server registered outside any manifest is never a GC candidate, even across a profile switch", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const registryPath = path.join(tmpHome, ".claude.json");
    // Simulate an operator-registered "codebase-oracle" that predates any
    // harness manifest on this machine — it shares a name with
    // DEFAULT_OWNED_MCP_SERVERS but is selected by NEITHER profile below.
    // Pre-D-107, unconditional DEFAULT_OWNED eligibility would have made
    // it a GC candidate the moment `desired` didn't include it.
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ mcpServers: { "codebase-oracle": { command: "manually-installed-oracle" } } }),
    );

    const run1Cli = fakeClaudeCli(registryPath);
    const cap1 = captureStreams();
    const run1 = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: run1Cli.exec,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap1.out,
      stderr: cap1.err,
    });
    expect(run1.aborted).toBe(false);
    const registryAfterRun1 = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    // team registers agent-tasks + grounding-mcp; codebase-oracle (never
    // in this or any manifest) is left exactly as the operator set it up.
    expect(registryAfterRun1.mcpServers?.["codebase-oracle"]).toEqual({
      command: "manually-installed-oracle",
    });

    // Profile switch: solo drops tools.mcp[] entirely — precisely the
    // scenario that would make a still-unconditionally-eligible
    // DEFAULT_OWNED_MCP_SERVERS entry look GC-able.
    const run2Cli = fakeClaudeCli(registryPath);
    const cap2 = captureStreams();
    const run2 = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      forceOverwrite: true,
      mcpExec: run2Cli.exec,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code"]],
      }),
      stdout: cap2.out,
      stderr: cap2.err,
    });
    expect(run2.aborted).toBe(false);
    const outcome2 = run2.applies?.[0];
    const gcNames2 = outcome2?.mcpEnsure?.gc?.results.map((r) => r.name) ?? [];
    expect(gcNames2).not.toContain("codebase-oracle");
    const registryAfterRun2 = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registryAfterRun2.mcpServers?.["codebase-oracle"]).toEqual({
      command: "manually-installed-oracle",
    });
  });

  it("apply-succeeds happy path: an MCP-only manifest edit still GC's the dropped custom server (no re-stamp occurs on an MCP-only edit; survival across a real re-stamp is proven by the combined-edit case below)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const registryPath = path.join(tmpHome, ".claude.json");

    const run1Cli = fakeClaudeCli(registryPath);
    const cap1 = captureStreams();
    const run1 = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: run1Cli.exec,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [["understanding-before-execution"], ["agent-tasks"], [], ["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
      }),
      stdout: cap1.out,
      stderr: cap1.err,
    });
    expect(run1.aborted).toBe(false);
    const registryAfterRun1 = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registryAfterRun1.mcpServers?.["agent-tasks"]).toBeDefined();

    // Run 2: SAME pack selection (no hook change) — only the MCP
    // selection drops agent-tasks. apply() SUCCEEDS this time (unlike
    // the catch-branch tests above). Dropping an MCP entry does NOT by
    // itself change settings.json/hooks content (mcpServers is no longer
    // projected there at all, post-T-002), so `.last-apply` is in fact
    // NOT re-stamped here — this case only proves the ordinary
    // apply-succeeds path still GC's correctly. Proving the snapshot
    // survives an ACTUAL re-stamp (FIX 2's real point) is the combined-
    // edit case below, which also changes a hook.
    const run2Cli = fakeClaudeCli(registryPath);
    const cap2 = captureStreams();
    const run2 = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      forceOverwrite: true,
      mcpExec: run2Cli.exec,
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [["understanding-before-execution"], [], [], ["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
      }),
      stdout: cap2.out,
      stderr: cap2.err,
    });
    expect(run2.aborted).toBe(false);
    const outcome2 = run2.applies?.[0];
    expect(outcome2?.apply).toBeDefined(); // apply() succeeded this run (not the catch branch)
    expect(outcome2?.mcpEnsure?.gc?.results).toEqual([
      { name: "agent-tasks", action: "removed", remove: { status: "removed", message: "", code: 0 } },
    ]);
    const registryAfterRun2 = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registryAfterRun2.mcpServers?.["agent-tasks"]).toBeUndefined();
    expect(cap2.stderr()).toContain("deregistered 1 stale MCP server(s)");
  });

  it("combined edit (MCP removal + a NEW pack/hook addition) still GC's the dropped custom server, even though apply() also re-stamps for the hook change", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const registryPath = path.join(tmpHome, ".claude.json");

    const run1Cli = fakeClaudeCli(registryPath);
    const cap1 = captureStreams();
    const run1 = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      mcpExec: run1Cli.exec,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [[], ["agent-tasks"], [], ["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
      }),
      stdout: cap1.out,
      stderr: cap1.err,
    });
    expect(run1.aborted).toBe(false);
    const registryAfterRun1 = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registryAfterRun1.mcpServers?.["agent-tasks"]).toBeDefined();
    const settingsBeforeRun2 = fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8");

    // Run 2: drop agent-tasks (MCP removal) AND add a brand-new pack
    // (hook change) in the SAME edit. apply() re-stamps `.last-apply`
    // for the hook change regardless of the GC question; the pre-apply
    // capture (FIX 2) must still see agent-tasks in the PRIOR snapshot.
    const run2Cli = fakeClaudeCli(registryPath);
    const cap2 = captureStreams();
    const run2 = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      forceOverwrite: true,
      mcpExec: run2Cli.exec,
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [["understanding-before-execution"], [], [], ["claude-code"]],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
      }),
      stdout: cap2.out,
      stderr: cap2.err,
    });
    expect(run2.aborted).toBe(false);
    const outcome2 = run2.applies?.[0];
    expect(outcome2?.apply?.targetWritten).toBe(true); // the hook change DID land (real re-stamp)
    const settingsAfterRun2 = fs.readFileSync(path.join(tmpHome, ".claude", "settings.json"), "utf8");
    expect(settingsAfterRun2).not.toBe(settingsBeforeRun2); // confirms a genuine hook-side change
    expect(outcome2?.mcpEnsure?.gc?.results).toEqual([
      { name: "agent-tasks", action: "removed", remove: { status: "removed", message: "", code: 0 } },
    ]);
    const registryAfterRun2 = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(registryAfterRun2.mcpServers?.["agent-tasks"]).toBeUndefined();
  });
});

describe("interactive wizard — Team path", () => {
  it("warns when agent-tasks is not detected but proceeds when operator confirms", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // proceed despite missing agent-tasks
          true, // confirm write
        ],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("team");
    expect(result.validateClean).toBe(true);
  });

  it("does NOT warn about agent-tasks when it is already wired in the Claude Code user-scope registry", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // task 83d8d03a: detect() reads the effective registry
    // (~/.claude.json), not the dead settings.json mcpServers block.
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "node", args: ["x.js"] } } }),
    );
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // write (no agent-tasks warning prompt)
        ],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("team");
  });

  it("reports binResolutionClean: false and a PATH-shadow-free hint when deps stay unresolved after a stubbed install (task 7f8fb4bc)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      // No binaries actually exist here; the stubbed installSpawn below
      // reports success without creating any files, so the wizard writes
      // the manifest with grounding-mcp / agent-tasks-mcp-bridge declared
      // but still unresolved on PATH — the scenario this task's doctor
      // fix and this init-time check both target.
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async () => ({ code: 0, stderr: "" }),
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // proceed despite missing agent-tasks in settings.json
          true, // accept the install prompt
          true, // confirm write
        ],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.binResolutionClean).toBe(false);
    expect(cap.stderr()).toContain("not found on PATH");
    expect(cap.stderr()).toContain("grounding-mcp");
    // Review finding F6 (task T-007): the title promises a "PATH-shadow-free
    // hint" but this file previously never asserted the PATH-shadow hint's
    // absence. It stays absent here because the stubbed npm prefix
    // (STUB_NPM_BIN_EXEC_WARN, top of file) resolves to a directory guaranteed
    // not to exist, so pathShadowHint's fs.existsSync check (src/cli/doctor/
    // index.ts) never fires.
    expect(cap.stderr()).not.toContain("export PATH=");
  });

  it("prints the agent-tasks coupling reminder after the manifest write", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    // Reminder must (a) name the bridge login recovery and (b) explicitly
    // call out the Solo fallback for non-agent-tasks workflows.
    expect(cap.stderr()).toContain("agent-tasks-mcp-bridge login");
    expect(cap.stderr()).toContain("--template solo");
  });

  it("does NOT print the agent-tasks coupling reminder for the Solo profile", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(cap.stderr()).not.toContain("agent-tasks-mcp-bridge login");
  });
});

describe("interactive wizard — agent-tasks auth probe (after install)", () => {
  it("skips the dialog and prints ✓ when the probe returns ok", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(cap.stderr()).toContain("token validated against the backend");
    // Must not have presented the dialog.
    expect(cap.stderr()).not.toContain("How would you like to configure agent-tasks auth?");
  });

  it("no_token + operator picks skip → reminder printed, wizard continues", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 1, stderr: "No token stored (keychain). Run 'login' first.\n" }),
      prompts: mockPrompts({
        select: ["team", "skip"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(cap.stderr()).toContain("Skipped auth setup");
    expect(cap.stderr()).toContain("agent-tasks-mcp-bridge login");
  });

  it("no_token + operator picks abort → wizard aborts with signup pointer, NO manifest written", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const manifestPath = path.join(tmpHome, ".harness", "harness.yaml");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 1, stderr: "No token stored (keychain). Run 'login' first.\n" }),
      prompts: mockPrompts({
        select: ["team", "abort"],
        confirm: [true],
        checkbox: [[]],
        input: [],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toContain("create an agent-tasks account first");
    expect(cap.stderr()).toContain("https://agent-tasks.opentriologue.ai");
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("no_token + login chosen, login spawn ok, re-probe ok → completion message", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    // First probe call reports no_token, second (after login) reports ok.
    let probeCalls = 0;
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          return { code: 1, stderr: "No token stored (keychain). Run 'login' first.\n" };
        }
        return { code: 0, stderr: "ok (store: keychain)\n" };
      },
      authLoginSpawn: async () => ({ code: 0 }),
      prompts: mockPrompts({
        select: ["team", "login"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(probeCalls).toBe(2);
    expect(cap.stderr()).toContain("login complete, token validates");
  });

  it("no_token + login chosen but login spawn fails → warning, wizard continues", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 1, stderr: "No token stored (keychain). Run 'login' first.\n" }),
      authLoginSpawn: async () => ({ code: 1 }),
      prompts: mockPrompts({
        select: ["team", "login"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(cap.stderr()).toContain("login` did not complete successfully");
  });

  it("validation_failed → informational warning, NO dialog, wizard continues", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({
        code: 1,
        stderr: "Token present (keychain) but validation failed: fetch failed\n",
      }),
      prompts: mockPrompts({
        select: ["team"],
        confirm: [true, true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(cap.stderr()).toContain("token is stored but the backend rejected it");
    expect(cap.stderr()).not.toContain("How would you like to configure agent-tasks auth?");
  });

  it("Solo profile does NOT trigger the auth probe at all", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    let probeCalled = false;
    await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => {
        probeCalled = true;
        return { code: 1, stderr: "No token stored\n" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(probeCalled).toBe(false);
  });
});

describe("interactive wizard — Custom path (task 31d2fbb5)", () => {
  it("aborts cleanly with no write when every checkbox is empty", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["custom"],
        // packs / mcps / policies all empty.
        checkbox: [[], [], []],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(result.profile).toBe("custom");
    expect(cap.stderr()).toMatch(/no components selected/);
    // Crucially: NO manifest landed on disk for an empty selection.
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(false);
  });

  it("composes a minimal-pick manifest that harness validate accepts (just the understanding pack)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["custom"],
        // packs: just understanding-before-execution; mcps: none; policies: none.
        checkbox: [
          ["understanding-before-execution"],
          [],
          [],
          [], // wire-now multiselect — skip wiring
        ],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true], // confirm write
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("custom");
    expect(result.init?.template).toBe("custom");
    expect(result.validateClean).toBe(true);
    const manifestPath = path.join(tmpHome, ".harness", "harness.yaml");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, "utf8");
    expect(content).toContain("Custom profile");
    expect(content).toContain("understanding-before-execution");
    // Minimal-pick manifest must NOT carry policies/MCPs the operator
    // didn't tick. Match the wiring shape (an MCP entry or a hook
    // bound to one) rather than the bare string "agent-tasks", since
    // the v0.18 approval_lifecycle defaults legitimately reference
    // `mcp__agent-tasks__*` tool-name patterns in the pack config
    // without wiring the MCP itself (agent-tasks/d8ee60ca).
    expect(content).not.toContain("agent-tasks-mcp-bridge");
    expect(content).not.toMatch(/^\s+- name: agent-tasks$/m);
    expect(content).not.toContain("review-before-merge");
  });

  it("composes a full-equivalent pick (every checkbox, with the three reference policies)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [
          ["understanding-before-execution"],
          ["agent-tasks", "grounding-mcp", "memory-router"],
          [
            "review-before-merge",
            "preflight-before-investigation",
            "review-subagent-before-pr-create",
          ],
          [], // wire-now skip
        ],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    const content = fs.readFileSync(
      path.join(tmpHome, ".harness", "harness.yaml"),
      "utf8",
    );
    expect(content).toContain("agent-tasks");
    expect(content).toContain("grounding-mcp");
    // memory-router is wired under memory.router, not tools.mcp[]; the
    // composer must NOT emit it as an MCP entry.
    expect(content).toContain("memory-router-user-prompt-submit");
    expect(content).toMatch(/router:\s*\n\s+command:\s*\n?\s*-\s+memory-router-user-prompt-submit/);
    expect(content).toContain("review-before-merge");
    expect(content).toContain("preflight-before-investigation");
    expect(content).toContain("review-subagent-before-pr-create");
    // No producer-coupling warnings since agent-tasks + grounding-mcp + pack are all selected.
    expect(cap.stderr()).not.toMatch(/composer warning/);
  });

  it("pre-checks MCPs whose names are already wired in the effective Claude Code registry", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // task 83d8d03a: pre-wire agent-tasks in the effective registry
    // (~/.claude.json), not the dead settings.json mcpServers block, so
    // detect() surfaces it.
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "node", args: ["x.js"] } } }),
    );
    let capturedMcpChoices: { value: string; checked: boolean }[] = [];
    const cap = captureStreams();
    const recordingCheckbox = (async (args: { choices: { value: string; checked?: boolean }[] }) => {
      // Capture the second checkbox call (MCPs); first is packs, third is policies.
      if (args.choices.some((c) => c.value === "agent-tasks")) {
        capturedMcpChoices = args.choices.map((c) => ({
          value: c.value,
          checked: c.checked === true,
        }));
      }
      // Empty selection for every checkbox keeps the wizard from proceeding past the abort guard.
      return [];
    }) as unknown as InteractivePrompts["checkbox"];
    const prompts: InteractivePrompts = {
      select: (async () => "custom") as unknown as InteractivePrompts["select"],
      confirm: (async () => false) as unknown as InteractivePrompts["confirm"],
      input: (async () => "~/.claude/projects/{project}/memory") as unknown as InteractivePrompts["input"],
      checkbox: recordingCheckbox,
    };
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts,
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true); // Empty selection → abort
    const at = capturedMcpChoices.find((c) => c.value === "agent-tasks");
    const gm = capturedMcpChoices.find((c) => c.value === "grounding-mcp");
    expect(at?.checked).toBe(true);
    expect(gm?.checked).toBe(false);
  });
});

describe("interactive wizard — overwrite guard", () => {
  it("aborts when an existing manifest is found and operator declines overwrite", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "version: 1\n# preserved\n");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({ confirm: [false] }), // decline overwrite
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/existing manifest left untouched/);
    // File untouched.
    expect(fs.readFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "utf8")).toContain("preserved");
  });

  it("proceeds when operator approves overwrite", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "version: 1\n# old\n");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [
          true, // overwrite
          true, // write
        ],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    const content = fs.readFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "utf8");
    expect(content).not.toContain("# old");
    expect(content).toContain("understanding-before-execution");
  });
});

describe("interactive wizard — overwrite guard at the harness home (harness/418cebd4)", () => {
  // Regression: pre-fix the wizard probed ~/.claude/harness.yaml while
  // init() resolved the manifest through resolveHomeDir() to
  // ~/.harness/harness.yaml. On a v0.24.0-migrated install the wizard
  // never saw the existing manifest, never prompted to overwrite, and
  // passed force:false to init(), which then refused on the real file.
  // detect() now resolves the manifest through the same resolveHomeDir()
  // init() uses, so the two agree.
  it("detects an existing manifest under ~/.harness/ and the overwrite prompt guards it", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.mkdirSync(path.join(tmpHome, ".harness"));
    fs.writeFileSync(path.join(tmpHome, ".harness", "harness.yaml"), "version: 1\n# preserved\n");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({ confirm: [false] }), // decline overwrite
      stdout: cap.out,
      stderr: cap.err,
    });
    // Reaching the decline path proves detect() saw the ~/.harness/
    // manifest: pre-fix detection.manifest.exists was false and this
    // prompt never fired.
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/existing manifest left untouched/);
    expect(fs.readFileSync(path.join(tmpHome, ".harness", "harness.yaml"), "utf8")).toContain(
      "preserved",
    );
  });

  it("forceOverwrite skips the overwrite prompt and overwrites the ~/.harness/ manifest", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.mkdirSync(path.join(tmpHome, ".harness"));
    fs.writeFileSync(path.join(tmpHome, ".harness", "harness.yaml"), "version: 1\n# old\n");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      forceOverwrite: true,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        // No overwrite-confirm queued: forceOverwrite must skip that
        // prompt. The single `true` is the final "write harness.yaml?".
        confirm: [true],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    const content = fs.readFileSync(path.join(tmpHome, ".harness", "harness.yaml"), "utf8");
    expect(content).not.toContain("# old");
    expect(content).toContain("understanding-before-execution");
  });
});

describe("interactive wizard — no-detection path", () => {
  it("runs cleanly when no runtime config exists at all", async () => {
    // tmpHome is brand-new; neither .claude nor .codex exist.
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [
          true, // write
        ],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(cap.stderr()).toMatch(/claude-code\s+not found/);
    expect(cap.stderr()).toMatch(/codex\s+not found/);
  });
});

describe("interactive wizard — dependency install", () => {
  it("offers to install missing packages and continues on success", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const spawnCalls: string[][] = [];
    const result = await runInteractive({
      homeDir: tmpHome,
      // Empty PATH forces every dep to look missing.
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async (_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // accept the install prompt
          true, // write manifest
        ],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.slice(0, 2)).toEqual(["i", "-g"]);
    // The two missing solo packages must show up in the install args.
    expect(spawnCalls[0]).toContain("@lannguyensi/memory-router");
    expect(spawnCalls[0]).toContain("@lannguyensi/understanding-gate");
    expect(cap.stderr()).toMatch(/Installed 2 package\(s\) successfully/);
  });

  it("aborts and does NOT write the manifest when npm install fails", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async () => ({ code: 1, stderr: "npm ERR! EACCES\n" }),
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // accept install
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(result.profile).toBe("solo");
    expect(cap.stderr()).toMatch(/npm install exited 1/);
    expect(cap.stderr()).toMatch(/Manifest NOT written/);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(false);
  });

  it("aborts when the operator declines the install offer", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    let spawned = false;
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async () => {
        spawned = true;
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          false, // decline install
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(spawned).toBe(false);
    expect(cap.stderr()).toMatch(/dependencies missing and install declined/);
    expect(cap.stderr()).toMatch(/To install manually: npm i -g/);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(false);
  });
});

describe("interactive wizard — Full profile", () => {
  it("writes a self-contained full manifest with no external hook scripts", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // Task 7f8fb4bc: the post-write bin-resolution check also covers
    // tools.cli[], and Full declares `gh` (required) there. `gh` is not
    // one of the wizard's own installable deps (fakeDepsPath's normal
    // contents), so stub it in separately for this test's cleanliness
    // assertion.
    fs.writeFileSync(path.join(fakeDepsPath, "gh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(fakeDepsPath, "gh"), 0o755);
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["full"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // proceed despite missing agent-tasks in settings.json
          true, // write manifest
        ],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("full");
    // Task 7f8fb4bc: Full declares grounding-mcp + agent-tasks-mcp-bridge
    // under tools.mcp; fakeDepsPath stubs both as present, so the
    // bin-resolution check is clean.
    expect(result.binResolutionClean).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    const content = fs.readFileSync(path.join(tmpHome, ".harness", "harness.yaml"), "utf8");
    // Full template carries the additional reference policies that
    // Team does not ship.
    expect(content).toContain("review-before-merge");
    expect(content).toContain("dogfood-before-release");
    expect(content).toContain("preflight-before-investigation");
    // Regression guard: every hook in Full now uses the bundled
    // `harness policy intercept` engine. No hook's `command:` field
    // may reference an external .sh script.
    expect(content).not.toMatch(/^\s*command:.*\.sh\b/m);
    // The Glob + Grep builtins should be listed so doctor stops
    // emitting the spurious "runtime advertises X but manifest does not
    // list it" warnings.
    expect(content).toContain("Glob");
    expect(content).toContain("Grep");
  });

  it("prints the Full-specific reminder that mentions both MCP and gh-cli coverage", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      prompts: mockPrompts({
        select: ["full"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true, true],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    const err = cap.stderr();
    // Full ships review-before-merge-bash + review-subagent-before-pr-create-bash
    // (PR #188), so the reminder must explicitly state that gh-cli PR
    // calls are also gated, not just the agent-tasks MCP verbs.
    expect(err).toContain("agent-tasks-mcp-bridge login");
    expect(err).toContain("gh pr (merge|create)");
    expect(err).toContain("--template team");
    // The Team-only "review-merge gate only matches agent-tasks MCP tool
    // names today" sentence must NOT appear for Full.
    expect(err).not.toContain("only matches\n  agent-tasks MCP tool names today");
  });
});

describe("interactive wizard — runtime multiselect (task 696f7560)", () => {
  it("wires only codex when the operator picks codex", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["codex"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toHaveLength(1);
    expect(result.applies?.[0]?.runtime).toBe("codex");
    expect(result.applies?.[0]?.apply).toBeDefined();
    // Codex apply emits harness.generated/codex/config.toml, then
    // installs only the marked harness-owned block into the active
    // ~/.codex/config.toml.
    const codexGenerated = path.join(
      tmpHome,
      ".harness",
      "harness.generated",
      "codex",
      "config.toml",
    );
    expect(fs.existsSync(codexGenerated)).toBe(true);
    const activeCodexConfig = path.join(tmpHome, ".codex", "config.toml");
    expect(fs.existsSync(activeCodexConfig)).toBe(true);
    expect(fs.readFileSync(activeCodexConfig, "utf8")).toContain(
      "# BEGIN harness-managed codex hooks",
    );
    // Legacy `apply` field stays undefined when only codex is wired.
    expect(result.apply).toBeUndefined();
    expect(cap.stderr()).toContain("codex config generated at");
    expect(cap.stderr()).toContain("codex config installed into");
    // Claude Code's settings.json must NOT be touched when only codex is selected.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(false);
  });

  it("wires both runtimes in one run when the operator picks both", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code", "codex"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.applies).toHaveLength(2);
    expect(result.applies?.map((a) => a.runtime).sort()).toEqual(["claude-code", "codex"]);
    // Claude settings.json was wired AND the codex generated artefact exists.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpHome, ".harness", "harness.generated", "codex", "config.toml")),
    ).toBe(true);
    expect(result.apply).toBeDefined();
    expect(result.apply?.targetWritten).toBe(true);
    // Operator gets the lock-drift caveat (documented in apply.ts).
    expect(cap.stderr()).toMatch(/harness\.lock will reflect the last-applied runtime/);
  });

  it("uncheck-all skips wiring entirely and surfaces both manual fallback commands", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toEqual([]);
    expect(result.apply).toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    // No runtime file landed.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(false);
    expect(
      fs.existsSync(path.join(tmpHome, ".harness", "harness.generated", "codex", "config.toml")),
    ).toBe(false);
    expect(cap.stderr()).toContain("no runtimes selected");
    expect(cap.stderr()).toMatch(/harness apply --target .* --merge/);
    expect(cap.stderr()).toContain("harness apply --runtime codex");
  });

  it("Ctrl-C at the runtime checkbox aborts without touching wiring (manifest stays)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const exitErr = new Error("User force closed the prompt with 0 null");
    exitErr.name = "ExitPromptError";
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: {
        select: (async () => "solo") as unknown as InteractivePrompts["select"],
        confirm: (async () => true) as unknown as InteractivePrompts["confirm"],
        input: (async () => "~/.claude/projects/{project}/memory") as unknown as InteractivePrompts["input"],
        checkbox: (async () => {
          throw exitErr;
        }) as unknown as InteractivePrompts["checkbox"],
      },
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/Ctrl-C received/);
    // Manifest was already written before the runtime prompt — the
    // wizard does not roll it back; the abort contract is "no NEW
    // side effects after this prompt", and the manifest is the prior
    // step's output. Settings.json must NOT have been touched, though.
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(false);
  });
});

describe("interactive wizard — Ctrl-C", () => {
  it("treats an ExitPromptError from the prompt library as an abort, writes nothing", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const exitErr = new Error("User force closed the prompt with 0 null");
    exitErr.name = "ExitPromptError";
    const prompts: InteractivePrompts = {
      select: (async () => {
        throw exitErr;
      }) as unknown as InteractivePrompts["select"],
      confirm: (async () => true) as unknown as InteractivePrompts["confirm"],
      input: (async () => "ignored") as unknown as InteractivePrompts["input"],
      checkbox: (async () => []) as unknown as InteractivePrompts["checkbox"],
    };
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts,
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/Ctrl-C received/);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(false);
  });
});

describe("interactive wizard — orchestrator-workflow co-install offer (task S5)", () => {
  it("opt-in runs `npx orchestrator-workflow init --yes <repoDir>` via the injected spawn", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const owCalls: { cmd: string; args: string[] }[] = [];
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      owInitSpawn: async (cmd: string, args: string[]) => {
        owCalls.push({ cmd, args });
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
          true, // YES, set up orchestrator-workflow
        ],
        checkbox: [[]], // skip runtime wiring
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    // The spawn is invoked exactly once with the npx incantation and the
    // wizard's repo dir as the init target.
    expect(owCalls).toHaveLength(1);
    expect(owCalls[0]?.cmd).toBe("npx");
    expect(owCalls[0]?.args).toEqual([
      "orchestrator-workflow",
      "init",
      "--yes",
      "/tmp/the-repo-dir",
    ]);
    expect(cap.stderr()).toContain("orchestrator-workflow set up");
  });

  it("opt-out prints the run-gate warning and does NOT spawn", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    let spawned = false;
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      owInitSpawn: async () => {
        spawned = true;
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
          false, // NO, decline orchestrator-workflow
        ],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(spawned).toBe(false);
    // The decline warning explains the coupling and the manual recovery.
    expect(cap.stderr()).toContain("harness works best with orchestrator-workflow");
    expect(cap.stderr()).toContain(".ai/runs/ run files");
    expect(cap.stderr()).toContain("npx orchestrator-workflow init");
  });

  it("opt-in with a non-zero exit STILL succeeds (graceful warning, init not aborted)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      owInitSpawn: async () => ({ code: 1, stderr: "npx: not found\n" }),
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true, true],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    // OW is optional: a failed co-install must not flip the result to
    // aborted, and the harness manifest must remain written + validated.
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(result.validateClean).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    expect(cap.stderr()).toContain("orchestrator-workflow init exited 1");
    expect(cap.stderr()).toContain("npx orchestrator-workflow init");
  });

  it("opt-in where the spawn throws STILL succeeds (graceful warning, init not aborted)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      owInitSpawn: async () => {
        throw new Error("spawn ENOENT npx");
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true, true],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    expect(cap.stderr()).toContain("Could not run orchestrator-workflow init");
    expect(cap.stderr()).toContain("spawn ENOENT npx");
  });

  it("the Custom profile does NOT reach the orchestrator-workflow offer", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    let spawned = false;
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      owInitSpawn: async () => {
        spawned = true;
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [
          ["understanding-before-execution"], // packs
          [], // mcps
          [], // policies
          [], // wire-now skip
        ],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true], // confirm write only
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("custom");
    // Custom is intentionally excluded: no spawn, and neither the OW
    // success line nor the decline warning is printed.
    expect(spawned).toBe(false);
    expect(cap.stderr()).not.toContain("harness works best with orchestrator-workflow");
    expect(cap.stderr()).not.toContain("orchestrator-workflow set up");
  });

  it("Ctrl-C at the orchestrator-workflow offer is a graceful skip (init stays successful)", async () => {
    // Regression: the OW confirm is the wizard's LAST prompt and runs
    // AFTER the manifest is written + wired, inside runInteractive's shared
    // try/catch. Pre-fix a Ctrl-C here propagated to the outer handler,
    // which printed the FALSE "no manifest written" abort and returned
    // {aborted:true}, discarding the already-successful tailResult. OW is
    // optional, so a Ctrl-C at this trailing offer must be a graceful skip.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const exitErr = new Error("User force closed the prompt with 0 null");
    exitErr.name = "ExitPromptError";
    let confirmCalls = 0;
    let owSpawned = false;
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      owInitSpawn: async () => {
        owSpawned = true;
        return { code: 0, stderr: "" };
      },
      prompts: {
        select: (async () => "solo") as unknown as InteractivePrompts["select"],
        confirm: (async () => {
          confirmCalls += 1;
          // 1st confirm = "write harness.yaml?" → yes. 2nd confirm = the
          // trailing OW offer → simulate Ctrl-C.
          if (confirmCalls === 1) return true;
          throw exitErr;
        }) as unknown as InteractivePrompts["confirm"],
        input: (async () => "~/.claude/projects/{project}/memory") as unknown as InteractivePrompts["input"],
        checkbox: (async () => []) as unknown as InteractivePrompts["checkbox"],
      },
      stdout: cap.out,
      stderr: cap.err,
    });
    // The load-bearing assertions: a Ctrl-C at the OPTIONAL trailing offer
    // does NOT flip a successful init to aborted, and validateClean is
    // preserved (not discarded by the outer abort handler).
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(result.validateClean).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".harness", "harness.yaml"))).toBe(true);
    // The Ctrl-C aborts BEFORE the spawn, so OW never runs.
    expect(owSpawned).toBe(false);
    // The FALSE "no manifest written" abort line must NOT appear.
    expect(cap.stderr()).not.toContain("no manifest written");
    // Instead the graceful decline/skip warning is printed.
    expect(cap.stderr()).toContain("harness works best with orchestrator-workflow");
  });

  it("a non-solo profile (team) also reaches the OW offer and spawns on opt-in", async () => {
    // The OW offer lives on the shared non-custom tail, so every named
    // profile reaches it — not just Solo. Pin that for Team.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const owCalls: { cmd: string; args: string[] }[] = [];
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      repoDir: "/tmp/the-repo-dir",
      // Make the agent-tasks auth probe deterministic (ok) so no auth
      // dialog interleaves with the queued confirms.
      authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
      owInitSpawn: async (cmd: string, args: string[]) => {
        owCalls.push({ cmd, args });
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["team"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // proceed despite missing agent-tasks in settings.json
          true, // write manifest
          true, // YES, set up orchestrator-workflow
        ],
        checkbox: [[]], // skip runtime wiring
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("team");
    expect(result.validateClean).toBe(true);
    expect(owCalls).toHaveLength(1);
    expect(owCalls[0]?.cmd).toBe("npx");
    expect(owCalls[0]?.args).toEqual([
      "orchestrator-workflow",
      "init",
      "--yes",
      "/tmp/the-repo-dir",
    ]);
    expect(cap.stderr()).toContain("orchestrator-workflow set up");
  });
});

describe("interactive wizard — hermetic spawn guard (task 54739002)", () => {
  it("accepting the OW offer WITHOUT an injected owInitSpawn fails hard instead of silently spawning a real npx", async () => {
    // Meta-test for the hermetic-spawn guard (src/runtime/hermetic-spawn-guard.ts).
    // Deliberately does NOT inject `owInitSpawn`, so the offer falls
    // through to the real `realOwInitSpawn()`. This drives the FULL
    // runInteractive() -> offerOrchestratorWorkflow() path (not a direct
    // call to realOwInitSpawn) so it also proves the violation survives
    // offerOrchestratorWorkflow's try/catch around `run(...)`, which
    // otherwise degrades a thrown runner to a mere warning (see "opt-in
    // where the spawn throws STILL succeeds" above) — the exact catch
    // that would have swallowed a non-dedicated guard error and made
    // this guard silently toothless.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    await expect(
      runInteractive({
        homeDir: tmpHome,
        dependencyPathEnv: fakeDepsPath,
        repoDir: "/tmp/the-repo-dir",
        prompts: mockPrompts({
          select: ["solo"],
          input: ["~/.claude/projects/{project}/memory"],
          confirm: [
            true, // write manifest
            true, // YES, set up orchestrator-workflow (no owInitSpawn injected!)
          ],
          checkbox: [[]],
        }),
        stdout: cap.out,
        stderr: cap.err,
      }),
    ).rejects.toThrow(/Refusing to spawn a REAL "npx orchestrator-workflow init" process while running under vitest/);
  });

  it("a Team-profile run WITHOUT an injected authProbeSpawn fails hard instead of silently spawning the real bridge status probe", async () => {
    // Meta-test for the hermetic-spawn guard on realProbeSpawn
    // (src/cli/init/agent-tasks-auth.ts). Deliberately does NOT inject
    // `authProbeSpawn`, so ensureAgentTasksAuth's probe falls through to
    // the real `realProbeSpawn()`. Drives the FULL runInteractive() path
    // (not a direct call to realProbeSpawn/probeAgentTasksAuth) so it
    // also proves the violation survives all the way out of
    // runInteractive — ensureAgentTasksAuth and probeAgentTasksAuth have
    // no try/catch of their own around this call, and runInteractive's
    // outer catch explicitly re-throws a HermeticSpawnViolationError
    // rather than treating it like an ExitPromptError abort.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    await expect(
      runInteractive({
        homeDir: tmpHome,
        dependencyPathEnv: fakeDepsPath,
        // Deliberately NOT injecting authProbeSpawn.
        prompts: mockPrompts({
          select: ["team"],
          confirm: [
            true, // proceed despite missing agent-tasks in settings.json
            true, // confirm write
          ],
          checkbox: [[]],
          input: ["~/.claude/projects/{project}/memory"],
        }),
        stdout: cap.out,
        stderr: cap.err,
      }),
    ).rejects.toThrow(/Refusing to spawn a REAL "agent-tasks-mcp-bridge status" process while running under vitest/);
  });
});

describe("interactive wizard — hermetic spawn guard, claude-mcp path (task 0d80e969)", () => {
  it("wiring claude-code for a Team-profile manifest WITHOUT an injected mcpExec fails hard instead of silently spawning the real claude CLI", async () => {
    // Meta-test for the hermetic-spawn guard on realClaudeMcpExec
    // (src/io/claude-mcp.ts). Deliberately does NOT inject `mcpExec`, so
    // `wireClaudeMcp`'s `ensureMcpServers` call falls through to the real
    // `realClaudeMcpExec()`. Drives the FULL runInteractive() ->
    // wireRuntime() -> wireClaudeMcp() path (not a direct call into
    // io/claude-mcp.ts — that's covered separately in
    // tests/io/claude-mcp.test.ts) so it also proves the violation
    // survives the exact catch this task found unguarded: apply()
    // succeeds, wireClaudeMcp's FIRST call (inside wireRuntime's `try`,
    // src/cli/init/interactive.ts ~:374) throws, and wireRuntime's own
    // catch (the "Failed to wire ..." handler) must re-throw a
    // HermeticSpawnViolationError immediately rather than degrading it to
    // that warning and calling wireClaudeMcp a SECOND time (which would
    // both print a misleading message and double the guarded call).
    // runInteractive's outer catch (the top-level handler that otherwise
    // treats a caught error as either an `isAbortError` Ctrl-C or a
    // rethrow) then re-throws it again past every remaining intermediate
    // handler, same as the other two guarded call sites above.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    let caught: unknown;
    try {
      await runInteractive({
        homeDir: tmpHome,
        dependencyPathEnv: fakeDepsPath,
        authProbeSpawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
        // Deliberately NOT injecting mcpExec.
        prompts: mockPrompts({
          select: ["team"],
          confirm: [
            true, // proceed despite missing agent-tasks in settings.json
            true, // confirm write
          ],
          checkbox: [["claude-code"]],
          input: ["~/.claude/projects/{project}/memory"],
        }),
        stdout: cap.out,
        stderr: cap.err,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HermeticSpawnViolationError);
    // Deliberately not pinned to a specific verb (e.g. "add-json" for the
    // first `desired` entry in ensureMcpServers' current alphabetical
    // add/replace order): that's an internal implementation detail of
    // ensureMcpServers, not part of this guard's contract. If a future
    // change adds a pre-flight `list` call (or reorders `desired`), this
    // assertion must keep passing — the instanceof check above and the
    // "Failed to wire" negative assertion below already carry the actual
    // burden of proof.
    expect((caught as Error).message).toMatch(/Refusing to spawn a REAL "claude mcp /);
    // The catch-handling fix (wireRuntime's catch, src/cli/init/
    // interactive.ts) must re-throw the violation BEFORE printing this
    // degrade-to-warning message — its presence would mean the guard
    // error was swallowed as an ordinary apply failure and wireClaudeMcp
    // was invoked a second time.
    expect(cap.stderr()).not.toContain("Failed to wire");
  });
});
