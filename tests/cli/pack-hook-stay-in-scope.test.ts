import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../../src/schema/index.js";
import { writeSentinel } from "../../src/runtime/pause-sentinel.js";
import { parse as parseYaml } from "yaml";
import {
  runPackHookStayInScopeCli,
  STAY_IN_SCOPE_DISABLED_ENV,
  STAY_IN_SCOPE_LOG_ENV,
} from "../../src/cli/pack/hook-stay-in-scope.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stay-in-scope-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const config = {
  enabled: true,
  tools: ["mcp__demo_tasks__create", "mcp__demo_tasks__update"],
  label_markers: ["review-followup"],
  description_markers: ["Review follow-up:"],
  description_window: { marker: "## Context", contains: "review", max_chars: 80 },
  parent_reference_pattern: "Parent work: #([0-9]+)",
  parent_url_pattern: "https://example\\.test/[^\\s]+/work/[0-9]+",
  messages: {
    reminder: "Please decide whether this belongs in the current work item.",
    second_order: "This follow-up references another follow-up; keep the work together.",
  },
};

function manifest(stayInScope: unknown = config, enabled = true) {
  return parseManifest({ version: 1, policy_packs: [{ name: "understanding-before-execution", enabled, config: stayInScope === undefined ? {} : { stay_in_scope: stayInScope } }] });
}
function input(value: unknown): Readable { return Readable.from([JSON.stringify(value)]); }
function stderr(): { stream: Writable; value: () => string } {
  let value = "";
  return { stream: new Writable({ write(chunk, _encoding, callback) { value += String(chunk); callback(); } }), value: () => value };
}
function event(overrides: Record<string, unknown> = {}) {
  return { tool_name: "mcp__demo_tasks__create", tool_input: { labels: ["review-followup"], title: "Adjust wording", description: "Review follow-up: notes" }, tool_response: { task: { id: "task-1" } }, ...overrides };
}
function logPath(): string { return path.join(tmp, "reminders", "audit.jsonl"); }
function readRecord(): Record<string, unknown> { return JSON.parse(fs.readFileSync(logPath(), "utf8")); }

describe("pack hook stay-in-scope", () => {
  it("uses configured literals, parent URL precedence, and exact configured message", async () => {
    const out = stderr();
    const result = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: ["REVIEW-FOLLOWUP"], title: "Adjust wording", description: "Parent work: #42 https://example.test/acme/work/42" } })), stderr: out.stream, now: new Date("2026-01-01T00:00:00.000Z") });
    expect(result).toMatchObject({ exitCode: 0, matched: true, matchedRule: "label", secondOrder: true, logged: true });
    expect(out.value()).toContain("[stay-in-scope: SECOND-ORDER] follow-up created from review context task=task-1. This follow-up references another follow-up; keep the work together.");
    expect(readRecord()).toMatchObject({ taskId: "task-1", parentPrUrl: "https://example.test/acme/work/42", matchedRule: "label", secondOrder: true });
  });

  it("emits the exact normal configured message", async () => {
    const out = stderr();
    const result = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: ["review-followup"], description: "ordinary" } })), stderr: out.stream });
    expect(result).toMatchObject({ matched: true, secondOrder: false });
    expect(out.value()).toContain("[stay-in-scope] follow-up created from review context task=task-1. Please decide whether this belongs in the current work item.");
  });

  it("uses explicit-marker then configured window precedence", async () => {
    const explicit = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: [], description: "Review follow-up: ## Context review" } })), stderr: stderr().stream });
    expect(explicit.matchedRule).toBe("explicit-marker");
    const window = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: [], description: "## Context this is from a review" } })), stderr: stderr().stream });
    expect(window.matchedRule).toBe("hintergrund-marker");
  });

  it("uses literal case rules and the first UTF-16 window boundary", async () => {
    const literalMiss = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: [], description: "review follow-up:" } })), stderr: stderr().stream });
    expect(literalMiss.matched).toBe(false);
    const firstWindowMiss = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: [], description: `## Context ${"😀".repeat(38)} review\n## Context review` } })), stderr: stderr().stream });
    expect(firstWindowMiss.matched).toBe(false);
  });

  it("accepts Codex tool aliases and wire-format aliases", async () => {
    const result = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input({ tool: "mcp__demo_tasks__.create", raw_input: { labels: ["review-followup"], description: "body" } }), stderr: stderr().stream });
    expect(result.matched).toBe(true);
  });

  it.each([
    ["absent", {}],
    ["disabled", { enabled: false }],
    ["invalid", { enabled: true, tools: ["bad|name"] }],
  ])("no-ops for %s current configuration", async (_name, stayInScope) => {
    const result = await runPackHookStayInScopeCli({ manifest: manifest(stayInScope), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event()), stderr: stderr().stream });
    expect(result).toMatchObject({ exitCode: 0, matched: false, logged: false });
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it("no-ops for absent and disabled packs", async () => {
    const absent = parseManifest({ version: 1 });
    const disabled = parseManifest({ version: 1, policy_packs: [{ name: "understanding-before-execution", enabled: false, config: { stay_in_scope: config } }] });
    for (const current of [absent, disabled]) {
      const result = await runPackHookStayInScopeCli({ manifest: current, generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event()), stderr: stderr().stream });
      expect(result).toMatchObject({ exitCode: 0, matched: false, logged: false });
    }
  });

  it.each([null, [], "not an event"])('keeps enabled hooks soft for non-object event envelopes: %j', async (body) => {
    const result = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(body), stderr: stderr().stream });
    expect(result).toMatchObject({ exitCode: 0, matched: false, logged: false });
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it("honors an enabled-to-disabled merged override after a hook was generated", async () => {
    const configPath = path.join(tmp, "harness.yaml");
    const projectDir = path.join(tmp, "projects", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, policy_packs: [{ name: "understanding-before-execution", config: { stay_in_scope: config } }] }));
    fs.writeFileSync(path.join(projectDir, "harness.overrides.yaml"), JSON.stringify({ policy_packs: [{ name: "understanding-before-execution", config: { stay_in_scope: { enabled: false } } }] }));
    const result = await runPackHookStayInScopeCli({ configPath, homeDir: tmp, project: "demo", generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event()), stderr: stderr().stream });
    expect(result.matched).toBe(false);
  });

  it("reloads current config from disk and turns a stale hook into a no-op", async () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, `version: 1\npolicy_packs:\n  - name: understanding-before-execution\n    config:\n      stay_in_scope:\n        enabled: false\n`);
    const result = await runPackHookStayInScopeCli({ configPath, generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event()), stderr: stderr().stream });
    expect(result).toMatchObject({ exitCode: 0, matched: false });
  });

  it("uses tool_input and response task IDs before raw_input and direct response IDs", async () => {
    const result = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input({ tool_name: "mcp__demo_tasks__create", tool_input: { taskId: "input-id", labels: ["review-followup"] }, raw_input: { taskId: "raw-id", labels: [] }, tool_response: { id: "direct-id", task: { id: "wrapped-id" } } }), stderr: stderr().stream });
    expect(result.matched).toBe(true);
    expect(readRecord().taskId).toBe("input-id");
  });

  it("keeps payload precedence and response fallbacks soft for invalid shapes", async () => {
    const responseFallback = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input({ tool_name: "mcp__demo_tasks__create", tool_input: { labels: ["review-followup"] }, tool_response: { task: { id: 7 }, id: "direct-id" } }), stderr: stderr().stream });
    expect(responseFallback).toMatchObject({ matched: true, logged: true });
    expect(readRecord().taskId).toBe("direct-id");
    fs.rmSync(logPath());

    const invalidPreferredPayload = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input({ tool_name: "mcp__demo_tasks__create", tool_input: [], raw_input: { labels: ["review-followup"] }, tool_response: [] }), stderr: stderr().stream });
    expect(invalidPreferredPayload).toMatchObject({ exitCode: 0, matched: false, logged: false });
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it("skips invalid numeric captures and finds the first nonempty configured URL", async () => {
    const custom = { ...config, parent_reference_pattern: "Parent: #([^ ]+)", parent_url_pattern: "^|https://example[.]test/[^ ]+" };
    const result = await runPackHookStayInScopeCli({ manifest: manifest(custom), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: input(event({ tool_input: { labels: ["review-followup"], description: "Parent: #１２ https://example.test/work/7" } })), stderr: stderr().stream });
    expect(result).toMatchObject({ matched: true, secondOrder: false });
    expect(readRecord().parentPrUrl).toBe("https://example.test/work/7");
  });

  it("keeps pause, environment disable, log precedence, malformed input, and audit failure soft", async () => {
    const generatedDir = path.join(tmp, "generated");
    writeSentinel(generatedDir, { pausedAt: new Date().toISOString(), expiresAt: null, reason: null, pausedBy: null });
    const pauseOut = stderr();
    const paused = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir, logPath: logPath(), env: { [STAY_IN_SCOPE_DISABLED_ENV]: "1" }, stdin: input(event()), stderr: pauseOut.stream });
    expect(paused).toMatchObject({ exitCode: 0, matched: false, logged: false });
    expect(pauseOut.value()).toContain("harness paused");
    fs.rmSync(path.join(generatedDir, ".harness-paused"));
    const disabledOut = stderr();
    const disabled = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir, logPath: logPath(), env: { [STAY_IN_SCOPE_DISABLED_ENV]: "1" }, stdin: input(event()), stderr: disabledOut.stream });
    expect(disabled).toMatchObject({ exitCode: 0, matched: false, logged: false });
    expect(disabledOut.value()).not.toContain("follow-up created");
    expect(fs.existsSync(logPath())).toBe(false);
    const envLog = path.join(tmp, "from-env.jsonl");
    const fromEnv = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), env: { [STAY_IN_SCOPE_LOG_ENV]: envLog }, stdin: input(event()), stderr: stderr().stream });
    expect(fromEnv.logPath).toBe(envLog);
    const explicit = path.join(tmp, "explicit.jsonl");
    const explicitResult = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: explicit, env: { [STAY_IN_SCOPE_LOG_ENV]: envLog }, stdin: input(event()), stderr: stderr().stream });
    expect(explicitResult.logPath).toBe(explicit);
    const malformed = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: logPath(), env: {}, stdin: Readable.from(["{"]), stderr: stderr().stream });
    expect(malformed.exitCode).toBe(0);
    const failure = await runPackHookStayInScopeCli({ manifest: manifest(), generatedDir: path.join(tmp, "generated"), logPath: tmp, env: {}, stdin: input(event()), stderr: stderr().stream });
    expect(failure).toMatchObject({ exitCode: 0, matched: true, logged: false, logPath: null });
  });

  it("parses the documented URL pattern as a matching JavaScript expression", () => {
    const docs = fs.readFileSync(path.join(process.cwd(), "docs/policy-packs/understanding-before-execution.md"), "utf8");
    const yaml = docs.match(/```yaml\n(stay_in_scope:[\s\S]*?)\n```/)?.[1];
    expect(yaml).toBeDefined();
    const parsed = parseYaml(yaml!) as { stay_in_scope: { parent_url_pattern: string } };
    expect(new RegExp(parsed.stay_in_scope.parent_url_pattern).test("https://example.test/work/7")).toBe(true);
  });
});
