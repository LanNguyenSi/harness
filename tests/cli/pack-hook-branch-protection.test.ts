// The branch-protection hook asks git for the branch (task a4d8adc5). These
// rows drive `runPackHookBranchProtectionCli` in process against real git in
// temporary repositories; the error rows inject the git runner so a timeout,
// a signal or a missing binary can be produced on any host.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { loadManifest } from "../../src/cli/loader.js";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import { defaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { hasGitEntryAbove, type GitHeadAnswer, type GitHeadReader } from "../../src/runtime/git-branch.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

/** Set an environment variable for the rest of the current test. */
function setEnv(key: string, value: string | undefined): void {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  cleanups.push(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fixture git: no global or system config and none of the variables that
// point git elsewhere, so fixtures look the same on every host.
const fixtureEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(fixtureEnv)) if (key.startsWith("GIT_")) delete fixtureEnv[key];
Object.assign(fixtureEnv, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: fixtureEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A real repository checked out on `branch` (unborn unless `commit`). */
function makeRepo(branch: string, opts: { commit?: boolean } = {}): string {
  const repo = path.join(tmpDir("harness-bp-repo-"), "repo");
  fs.mkdirSync(repo);
  git(repo, "-c", `init.defaultBranch=${branch}`, "init", "-q");
  if (opts.commit === true) {
    fs.writeFileSync(path.join(repo, "f"), "x\n");
    git(repo, "add", "f");
    git(repo, "commit", "-qm", "c");
  }
  return repo;
}

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function capture(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function manifestWithPack(config: Record<string, unknown> = {}, enabled = true): Manifest {
  return parseManifest({ version: 1, policy_packs: [{ name: "branch-protection", config, enabled }] });
}

interface Run {
  exitCode: number;
  blocked: boolean;
  diagnostic: string;
  stdout: string;
  stderr: string;
}

async function runHook(
  event: Record<string, unknown> | string,
  opts: Omit<Parameters<typeof runPackHookBranchProtectionCli>[0] & object, "stdin" | "stdout" | "stderr"> = {},
): Promise<Run> {
  const out = capture();
  const err = capture();
  const result = await runPackHookBranchProtectionCli({
    stdin: streamFrom(typeof event === "string" ? event : JSON.stringify(event)),
    stdout: out.stream,
    stderr: err.stream,
    ...(opts.manifest === undefined && opts.configPath === undefined ? { manifest: manifestWithPack() } : {}),
    ...opts,
  });
  return { ...result, stdout: out.output(), stderr: err.output() };
}

function writeEvent(cwd: string, file: string, tool = "Write"): Record<string, unknown> {
  const input = tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file, content: "x" };
  return { hook_event_name: "PreToolUse", session_id: "sess-1", tool_name: tool, cwd, tool_input: input };
}

function patchEvent(cwd: string, headers: string[], shape: "input" | "patch" | "string" = "input"): Record<string, unknown> {
  const body = `*** Begin Patch\n${headers.map((h) => `${h}\n+x\n`).join("")}*** End Patch\n`;
  const toolInput = shape === "string" ? body : { [shape]: body };
  return { hook_event_name: "PreToolUse", session_id: "sess-1", tool_name: "apply_patch", cwd, tool_input: toolInput };
}

/** The Claude Code deny envelope on stdout, parsed; fails when absent. */
function envelope(run: Run): { decision: string; reason: string; hookSpecificOutput: Record<string, string> } {
  expect(run.stdout.endsWith("\n")).toBe(true);
  expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(run.stdout);
}

/** The agent-facing text names only the feature-branch escape. */
function expectNoDisableRecipe(text: string): void {
  expect(text).not.toMatch(/gate\s+(disable|enable)|\bpause\b|enabled:\s*false|harness approve|session-start|ledger/i);
}

function answer(a: GitHeadAnswer): GitHeadReader {
  return vi.fn(async () => a);
}

describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: protected branches, real git", () => {
  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])("%s into a checkout on master is refused", async (tool) => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "src.txt"), tool));
    expect(run.blocked).toBe(true);
    expect(run.exitCode).toBe(0);
    const env = envelope(run);
    expect(env.decision).toBe("block");
    expect(env.reason).toContain(`refusing ${tool} on protected branch "master"`);
    expect(env.reason).toContain("git checkout -b <feature>");
    expectNoDisableRecipe(env.reason);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
  });

  it.each([
    ["patch", "input"],
    ["patch", "patch"],
    ["patch", "string"],
  ] as const)("apply_patch with one header (tool_input.%s as %s) into a checkout on main is refused", async (_k, shape) => {
    const repo = makeRepo("main");
    const run = await runHook(patchEvent(repo, ["*** Add File: src/new.ts"], shape));
    expect(run.blocked).toBe(true);
    expect(envelope(run).reason).toContain('refusing apply_patch on protected branch "main"');
  });

  it("apply_patch with several headers is refused when any of them lands on a protected branch", async () => {
    const cwdRepo = makeRepo("feat/a");
    const other = makeRepo("feat/b");
    const prod = makeRepo("develop");
    const run = await runHook(
      patchEvent(cwdRepo, [
        "*** Update File: src/a.ts",
        `*** Add File: ${path.join(other, "b.ts")}`,
        `*** Delete File: ${path.join(prod, "gone.ts")}`,
      ]),
    );
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "develop" of ${prod} is protected (master, main, develop)`);
  });

  it("apply_patch: a `*** Move to:` header is checked too", async () => {
    const cwdRepo = makeRepo("feat/a");
    const prod = makeRepo("master");
    const run = await runHook(
      patchEvent(cwdRepo, ["*** Update File: src/a.ts", `*** Move to: ${path.join(prod, "moved.ts")}`]),
    );
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toContain(`of ${prod} is protected`);
  });

  it("apply_patch headers decide, not the event cwd: a patch into a protected repository from a feature-branch cwd is refused", async () => {
    const cwdRepo = makeRepo("feat/cwd");
    const prod = makeRepo("master");
    const run = await runHook(patchEvent(cwdRepo, [`*** Update File: ${path.join(prod, "x.ts")}`]));
    expect(run.blocked).toBe(true);
  });

  it("apply_patch with several headers, all on non-protected branches, is allowed and checks each directory", async () => {
    const a = makeRepo("feat/a");
    const b = makeRepo("feat/b");
    const run = await runHook(
      patchEvent(a, ["*** Add File: one.ts", "*** Update File: two.ts", `*** Add File: ${path.join(b, "three.ts")}`]),
    );
    expect(run.blocked).toBe(false);
    expect(run.stdout).toBe("");
    expect(run.diagnostic).toBe(
      `patch ${a}: branch "feat/a" is not in the protected list (master, main, develop); ` +
        `${b}: branch "feat/b" is not in the protected list (master, main, develop); allowing`,
    );
  });

  it("apply_patch without a header falls back to the event cwd", async () => {
    const repo = makeRepo("master");
    const run = await runHook({ tool_name: "apply_patch", cwd: repo, tool_input: { input: "no headers here" } });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toContain(`of ${repo} is protected`);
  });

  it.each(["Master", "MAIN", "Develop"])("a case variant of a protected name (%s) is refused", async (branch) => {
    const repo = makeRepo(branch);
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")));
    expect(run.blocked).toBe(true);
    expect(envelope(run).reason).toContain(`protected branch "${branch}"`);
  });

  it("a new file in a directory that does not exist yet, in a checkout on master, is refused as the protected branch", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "new", "deeper", "x.ts")));
    expect(run.blocked).toBe(true);
    // Judged by git in the nearest existing directory, not as a git error.
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
  });

  it("a new file in a directory that does not exist yet, in a checkout on a feature branch, is allowed", async () => {
    const repo = makeRepo("feat/x");
    const run = await runHook(writeEvent(repo, path.join(repo, "new", "deeper", "x.ts")));
    expect(run.blocked).toBe(false);
    expect(run.diagnostic).toBe(
      `target ${repo}: branch "feat/x" is not in the protected list (master, main, develop); allowing`,
    );
  });

  it("a target in another repository is judged by that repository (protected target, feature-branch cwd)", async () => {
    const cwdRepo = makeRepo("feat/cool");
    const prod = makeRepo("master");
    const run = await runHook(writeEvent(cwdRepo, path.join(prod, "src", "index.ts"), "Edit"));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${prod} is protected (master, main, develop)`);
  });

  it("a target in another repository is judged by that repository (feature target, protected cwd)", async () => {
    const cwdRepo = makeRepo("master");
    const feat = makeRepo("feat/cool");
    const run = await runHook(writeEvent(cwdRepo, path.join(feat, "src", "index.ts"), "Edit"));
    expect(run.blocked).toBe(false);
    expect(run.stdout).toBe("");
  });

  it("a relative file_path resolves against the event cwd", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, "./src/index.ts"));
    expect(run.blocked).toBe(true);
  });

  it("a tool without a target path is judged by the event cwd", async () => {
    const repo = makeRepo("main");
    const run = await runHook({ tool_name: "Bash", cwd: repo, tool_input: { command: "ls" } });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toContain(`of ${repo} is protected`);
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: allowed outcomes, real git", () => {
  it("a checkout on a non-protected branch is allowed", async () => {
    const repo = makeRepo("feat/cool");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")));
    expect(run).toMatchObject({ blocked: false, exitCode: 0, stdout: "" });
    expect(run.diagnostic).toMatch(/branch "feat\/cool" is not in the protected list/);
  });

  it("a detached HEAD is allowed", async () => {
    const repo = makeRepo("master", { commit: true });
    git(repo, "checkout", "-q", "--detach");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")));
    expect(run).toMatchObject({ blocked: false, exitCode: 0, stdout: "" });
    expect(run.diagnostic).toBe(`target ${repo}: detached HEAD; allowing`);
  });

  it("a path outside every repository is allowed without spawning git", async (ctx) => {
    const outside = tmpDir("harness-bp-outside-");
    if (hasGitEntryAbove(outside)) ctx.skip(`${outside} has a .git entry above it on this host`);
    const reader = vi.fn<GitHeadReader>(async () => ({ kind: "exited", code: 0, stdout: "refs/heads/master\n", stderr: "" }));
    const protectedCwd = makeRepo("master");
    const run = await runHook(writeEvent(protectedCwd, path.join(outside, "memory", "note.md")), {
      manifest: manifestWithPack(),
      gitReader: reader,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(run).toMatchObject({ blocked: false, exitCode: 0, stdout: "" });
    expect(run.diagnostic).toBe(`target ${outside}: outside any git repository; allowing`);
  });

  it("the pack disabled allows", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { manifest: manifestWithPack({}, false) });
    expect(run).toMatchObject({ blocked: false, stdout: "" });
    expect(run.diagnostic).toMatch(/enabled:false/);
  });

  it("the pack not declared allows", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { manifest: parseManifest({ version: 1 }) });
    expect(run).toMatchObject({ blocked: false, stdout: "" });
    expect(run.diagnostic).toMatch(/not declared in manifest/);
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: config", () => {
  it("protected_branches overrides the default list", async () => {
    const release = makeRepo("release");
    const master = makeRepo("master");
    const manifest = manifestWithPack({ protected_branches: ["release"] });
    const refused = await runHook(writeEvent(release, path.join(release, "x.ts")), { manifest });
    expect(refused.blocked).toBe(true);
    expect(envelope(refused).reason).toContain("Protected branches: release.");
    const allowed = await runHook(writeEvent(master, path.join(master, "x.ts")), { manifest });
    expect(allowed.blocked).toBe(false);
  });

  it("config.ux renders the agent-facing block with the branch substituted", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { manifest: manifestWithPack({ ux: defaultUx() }) });
    const expected = [
      "You cannot edit files on protected branch master yet.",
      "",
      "Required:",
      "- a checkout of a non-protected branch (current `master` is protected)",
      "",
      "Run:",
      "  git checkout -b feat/<your-task>",
    ].join("\n");
    const env = envelope(run);
    expect(env.reason).toBe(expected);
    expect(env.hookSpecificOutput.permissionDecisionReason).toBe(expected);
    expectNoDisableRecipe(env.reason);
  });

  it("a malformed config.ux falls back to the default text, with a stderr note", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), {
      manifest: manifestWithPack({ ux: { cannot: "x", required: [], run: ["y"] } }),
    });
    expect(run.stderr).toContain("harness pack hook branch-protection: config.ux ignored (");
    expect(envelope(run).reason).toContain("branch-protection: refusing Write");
  });
});

describe("branch-protection hook: the manifest", () => {
  it("a manifest that does not load refuses", async () => {
    const run = await runHook(writeEvent("/tmp", "/tmp/x.ts"), { configPath: "/nonexistent/path/harness.yaml" });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toMatch(/^BLOCK: the harness manifest could not be loaded \(.*\); refusing on failsafe$/);
    expect(envelope(run).reason).toMatch(/^branch-protection: refusing Write: the harness manifest could not be loaded/);
  });

  it("a manifest that fails the schema refuses", async () => {
    const dir = tmpDir("harness-bp-manifest-");
    const cfg = path.join(dir, "harness.yaml");
    fs.writeFileSync(cfg, "version: 1\nnot_a_key: true\npolicy_packs:\n  - name: branch-protection\n");
    const run = await runHook(writeEvent(dir, path.join(dir, "x.ts")), { configPath: cfg });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toMatch(/not_a_key/);
  });

  it.skipIf(!GIT_AVAILABLE)("a live-shaped manifest carrying the two removed grounding keys loads with two warnings and still refuses on a protected branch", async () => {
    const repo = makeRepo("master");
    const dir = tmpDir("harness-bp-manifest-");
    const cfg = path.join(dir, "harness.yaml");
    fs.writeFileSync(
      cfg,
      [
        "version: 1",
        "grounding:",
        "  session:",
        "    auto_start: true",
        '    id_format: "gs-{repo}-{rand:8}"',
        "  evidence_ledger:",
        "    path: ~/.evidence-ledger/ledger.db",
        "    retention_days: 90",
        "  policies_source: ~/.claude/harness.d/policies/claim-gate.yaml",
        "tools:",
        "  mcp:",
        "    - name: grounding-mcp",
        "      command: [grounding-mcp]",
        "      health:",
        "        verb: ledger_status",
        "        timeout_ms: 5000",
        "      enabled: true",
        "hooks: []",
        "policies: []",
        "policy_packs:",
        "  - name: branch-protection",
        "    source: builtin",
        "    enabled: true",
        "    config:",
        "      ux:",
        '        cannot: "You cannot edit files on protected branch ${BRANCH} yet."',
        "        required:",
        '          - "a checkout of a non-protected branch (current `${BRANCH}` is protected)"',
        "        run:",
        '          - "git checkout -b feat/<your-task>"',
        '          - "harness session-start branch-check"',
        "",
      ].join("\n"),
    );
    expect(loadManifest({ configPath: cfg }).warnings.map((w) => w.path)).toEqual([
      "grounding.evidence_ledger.retention_days",
      "grounding.policies_source",
    ]);
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { configPath: cfg });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
    expect(envelope(run).reason).toMatch(/^You cannot edit files on protected branch master yet\./);
  });
});

describe("removed verbs", () => {
  it("`harness approve branch-protection` and `harness session-start branch-check` are no longer commands", () => {
    const program = buildProgram({ stdout: () => {}, stderr: () => {} });
    const sub = (name: string): string[] =>
      program.commands.find((c) => c.name() === name)?.commands.map((c) => c.name()) ?? [];
    expect(sub("approve")).not.toContain("branch-protection");
    expect(sub("approve").length).toBeGreaterThan(0);
    expect(sub("session-start")).not.toContain("branch-check");
    expect(sub("pack").length).toBeGreaterThan(0);
  });
});

describe("branch-protection hook: git errors refuse (injected runner)", () => {
  const dirWithGit = (): string => {
    const dir = tmpDir("harness-bp-inj-");
    fs.mkdirSync(path.join(dir, ".git"));
    return dir;
  };

  it.each<[string, GitHeadAnswer, string]>([
    ["a timeout", { kind: "timed-out", timeoutMs: 2000, stderr: "" }, "git did not answer within 2000 ms"],
    ["a missing git (ENOENT)", { kind: "spawn-failed", code: "ENOENT" }, "git could not be started (ENOENT)"],
    ["a signal", { kind: "signaled", signal: "SIGTERM", stderr: "" }, "git was killed by SIGTERM"],
    [
      "an exit-0 answer naming a tag",
      { kind: "exited", code: 0, stdout: "refs/tags/v1\n", stderr: "" },
      'unexpected output from git: "refs/tags/v1"',
    ],
    [
      "an exit-0 answer of another shape",
      { kind: "exited", code: 0, stdout: "refs/heads/feat/x\nmore\n", stderr: "" },
      'unexpected output from git: "refs/heads/feat/x"',
    ],
    [
      "an exit-0 answer with nothing on stdout",
      { kind: "exited", code: 0, stdout: "", stderr: "" },
      'unexpected output from git: ""',
    ],
    [
      "a fatal exit",
      {
        kind: "exited",
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      },
      "git exited 128: fatal: not a git repository (or any of the parent directories): .git",
    ],
    ["exit 1 with output", { kind: "exited", code: 1, stdout: "refs/heads/feat/x\n", stderr: "" }, "git exited 1"],
    ["output past the cap", { kind: "oversized", stderr: "" }, "git's output passed 4096 bytes"],
  ])("%s refuses with one fixed sentence naming what git said", async (_name, a, detail) => {
    const dir = dirWithGit();
    const reader = answer(a);
    const run = await runHook(writeEvent(dir, path.join(dir, "x.ts")), { gitReader: reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: git could not report the branch of ${dir}: ${detail}`);
    const env = envelope(run);
    expect(env.reason).toBe(`branch-protection: refusing Write: git could not report the branch of ${dir} (${detail}).`);
    expectNoDisableRecipe(env.reason);
  });

  it("the refusal carries git's first stderr line, control characters replaced, capped", async () => {
    const dir = dirWithGit();
    const long = `fatal: \u001b[31m${"y".repeat(400)}`;
    const run = await runHook(writeEvent(dir, path.join(dir, "x.ts")), {
      gitReader: answer({ kind: "exited", code: 128, stdout: "", stderr: `\n${long}\nsecond line\n` }),
    });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toContain("git exited 128: fatal: ?[31m");
    expect(run.diagnostic).not.toContain("second line");
    expect(run.diagnostic).not.toContain("\u001b");
    expect(run.diagnostic.endsWith("...")).toBe(true);
  });

  it("an exit 1 with nothing on stdout is a detached HEAD and allows", async () => {
    const dir = dirWithGit();
    const run = await runHook(writeEvent(dir, path.join(dir, "x.ts")), {
      gitReader: answer({ kind: "exited", code: 1, stdout: "", stderr: "" }),
    });
    expect(run).toMatchObject({ blocked: false, stdout: "" });
  });

  it("the reader is asked about the nearest existing directory, with the per-call bound", async () => {
    const dir = dirWithGit();
    const reader = vi.fn<GitHeadReader>(async () => ({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" }));
    await runHook(writeEvent(dir, path.join(dir, "a", "b", "x.ts")), { gitReader: reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]![0]).toBe(dir);
    expect(reader.mock.calls[0]![1]).toBeLessThanOrEqual(2000);
    expect(reader.mock.calls[0]![1]).toBeGreaterThan(0);
  });

  it("all target directories together are bounded: the rest is refused once the bound has passed", async () => {
    const dirs = [dirWithGit(), dirWithGit(), dirWithGit()];
    const reader = vi.fn<GitHeadReader>(
      () =>
        new Promise<GitHeadAnswer>((resolve) =>
          setTimeout(() => resolve({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" }), 80),
        ),
    );
    const run = await runHook(
      patchEvent(dirs[0]!, dirs.map((d) => `*** Add File: ${path.join(d, "x.ts")}`)),
      { gitReader: reader, gitDeadlineMs: 120 },
    );
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toMatch(/all target directories together passed the 120 ms bound/);
    expect(reader.mock.calls.length).toBeLessThan(3);
    // Each call is bounded by what is left of the shared bound.
    for (const call of reader.mock.calls) expect(call[1]).toBeLessThanOrEqual(120);
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: the hook's own environment does not steer git", () => {
  it.each(["GIT_DIR", "GIT_WORK_TREE"])("%s pointing at a protected repository does not refuse a feature-branch target", async (key) => {
    const feat = makeRepo("feat/x");
    const prod = makeRepo("master");
    setEnv(key, key === "GIT_DIR" ? path.join(prod, ".git") : prod);
    if (key === "GIT_WORK_TREE") setEnv("GIT_DIR", path.join(prod, ".git"));
    const run = await runHook(writeEvent(feat, path.join(feat, "x.ts")));
    expect(run.blocked).toBe(false);
    expect(run.diagnostic).toMatch(/branch "feat\/x" is not in the protected list/);
  });

  it("GIT_DIR pointing at a feature-branch repository does not allow a protected target", async () => {
    const feat = makeRepo("feat/x");
    const prod = makeRepo("main");
    setEnv("GIT_DIR", path.join(feat, ".git"));
    setEnv("GIT_WORK_TREE", feat);
    const run = await runHook(writeEvent(prod, path.join(prod, "x.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "main" of ${prod} is protected (master, main, develop)`);
  });

  it("no git on PATH refuses", async () => {
    const repo = makeRepo("feat/x");
    setEnv("PATH", tmpDir("harness-bp-empty-path-"));
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: git could not report the branch of ${repo}: git could not be started (ENOENT)`);
  });

  it("a .git entry git does not accept refuses with git's own first stderr line", async () => {
    const dir = tmpDir("harness-bp-badgit-");
    fs.writeFileSync(path.join(dir, ".git"), "not a gitdir pointer\n");
    const run = await runHook(writeEvent(dir, path.join(dir, "x.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toMatch(new RegExp(`^BLOCK: git could not report the branch of ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: git exited 128: fatal: `));
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: block contract per runtime", () => {
  it("Claude Code: a refusal is one JSON deny envelope on stdout and exit 0", async () => {
    const repo = makeRepo("master");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")));
    expect(run.exitCode).toBe(0);
    const env = envelope(run);
    expect(Object.keys(env).sort()).toEqual(["decision", "hookSpecificOutput", "reason"]);
    expect(env.decision).toBe("block");
    expect(env.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: env.reason,
    });
    expect(run.stderr).toContain(`harness pack hook branch-protection: BLOCK: branch "master"`);
  });

  it("Claude Code: an allow writes nothing on stdout and exits 0", async () => {
    const repo = makeRepo("feat/x");
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { runtime: "claude-code" });
    expect(run).toMatchObject({ exitCode: 0, blocked: false, stdout: "" });
  });

  it("Codex: a refusal exits 2 with the reason on stderr and nothing on stdout", async () => {
    const repo = makeRepo("master");
    const run = await runHook(patchEvent(repo, ["*** Update File: x.ts"]), { runtime: "codex" });
    expect(run.exitCode).toBe(2);
    expect(run.blocked).toBe(true);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain('branch-protection: refusing apply_patch on protected branch "master"');
    expect(run.stderr).toContain("git checkout -b <feature>");
    expectNoDisableRecipe(run.stderr.replace(/^harness pack hook branch-protection: .*$/m, ""));
  });

  it("Codex: a git error exits 2 with the fixed sentence on stderr", async () => {
    const dir = tmpDir("harness-bp-codex-");
    fs.mkdirSync(path.join(dir, ".git"));
    const run = await runHook(patchEvent(dir, ["*** Add File: x.ts"]), {
      runtime: "codex",
      gitReader: answer({ kind: "timed-out", timeoutMs: 2000, stderr: "" }),
    });
    expect(run).toMatchObject({ exitCode: 2, blocked: true, stdout: "" });
    expect(run.stderr).toContain(
      `branch-protection: refusing apply_patch: git could not report the branch of ${dir} (git did not answer within 2000 ms).`,
    );
  });

  it("Codex: an allow exits 0 with nothing on stdout", async () => {
    const repo = makeRepo("feat/x");
    const run = await runHook(patchEvent(repo, ["*** Update File: x.ts"]), { runtime: "codex" });
    expect(run).toMatchObject({ exitCode: 0, blocked: false, stdout: "" });
  });

  it("Codex: a manifest that does not load exits 2", async () => {
    const run = await runHook(patchEvent("/tmp", ["*** Update File: x.ts"]), {
      runtime: "codex",
      configPath: "/nonexistent/path/harness.yaml",
    });
    expect(run).toMatchObject({ exitCode: 2, blocked: true, stdout: "" });
    expect(run.stderr).toMatch(/branch-protection: refusing apply_patch: the harness manifest could not be loaded/);
  });

  it("an unknown runtime refuses with exit 2, which both runtimes read as a block", async () => {
    const run = await runHook(writeEvent("/tmp", "/tmp/x.ts"), { runtime: "opencode" });
    expect(run).toMatchObject({ exitCode: 2, blocked: true, stdout: "" });
    expect(run.stderr).toMatch(/unknown --runtime "opencode"/);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an empty event", ""],
    ["a JSON array", "[]"],
  ])("%s on stdin refuses in both runtimes", async (_name, raw) => {
    const claude = await runHook(raw);
    expect(claude.blocked).toBe(true);
    expect(envelope(claude).reason).toMatch(/the event on stdin is not a JSON object/);
    const codex = await runHook(raw, { runtime: "codex" });
    expect(codex).toMatchObject({ exitCode: 2, blocked: true, stdout: "" });
  });
});
