// The branch-protection hook asks git for the branch (task a4d8adc5). These
// rows drive `runPackHookBranchProtectionCli` in process against real git in
// temporary repositories; the error rows inject the git runner so a timeout,
// a signal or a missing binary can be produced on any host.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { loadManifest } from "../../src/cli/loader.js";
import { GIT_READ_DEADLINE_MS, runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import { defaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { hasGitEntryAbove, readBranch, readBranchAt, readGitHead, type GitHeadAnswer, type GitHeadReader } from "../../src/runtime/git-branch.js";
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

function patchText(headers: string[]): string {
  return `*** Begin Patch\n${headers.map((h) => `${h}\n+x\n`).join("")}*** End Patch\n`;
}

type PatchShape = "input" | "patch" | "string" | "command" | "argv";

function patchEvent(cwd: string, headers: string[], shape: PatchShape = "input"): Record<string, unknown> {
  const body = patchText(headers);
  const toolInput =
    shape === "string" ? body : shape === "argv" ? { command: ["apply_patch", body] } : { [shape]: body };
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

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// The field Codex carries the patch text in is not pinned on a captured
// payload, so the hook reads header lines from every string of the event:
// any field of tool_input, an argv array, raw_input or input, and JSON text
// inside a string. The cwd here is a feature-branch checkout, so only the
// header can name the protected repository.
describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: apply_patch header lines are read from every string of the event, real git", () => {
  const into = (prod: string): string[] => [`*** Update File: ${path.join(prod, "src", "x.ts")}`];
  const event = (cwd: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    tool_name: "apply_patch",
    cwd,
    ...extra,
  });

  it.each<[string, (body: string) => Record<string, unknown>]>([
    ["tool_input.command as a string", (body) => ({ tool_input: { command: body } })],
    ["tool_input.command as an argv array", (body) => ({ tool_input: { command: ["apply_patch", body] } })],
    ["tool_input.command as a heredoc", (body) => ({ tool_input: { command: `apply_patch <<'EOF'\n${body}EOF\n` } })],
    ["a nested field of tool_input", (body) => ({ tool_input: { args: { patch_text: body } } })],
    ["JSON text inside a tool_input string", (body) => ({ tool_input: { arguments: JSON.stringify({ input: body }) } })],
    ["JSON array text inside a tool_input string", (body) => ({ tool_input: { arguments: JSON.stringify(["apply_patch", body]) } })],
    ["raw_input", (body) => ({ raw_input: { command: body } })],
    ["a top-level input string", (body) => ({ input: body })],
  ])("a patch into a checkout on master carried in %s is refused", async (_name, shape) => {
    const cwdRepo = makeRepo("feat/cwd");
    const prod = makeRepo("master");
    const run = await runHook(event(cwdRepo, shape(patchText(into(prod)))));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${prod} is protected (master, main, develop)`);
  });

  it("a patch carried in tool_input.command into a checkout on a feature branch, from a feature-branch cwd, is allowed and judged by the cwd and that checkout", async () => {
    const cwdRepo = makeRepo("feat/cwd");
    const feat = makeRepo("feat/x");
    const run = await runHook(event(cwdRepo, { tool_input: { command: ["apply_patch", patchText(into(feat))] } }));
    expect(run.blocked).toBe(false);
    expect(run.diagnostic).toBe(
      `cwd+patch ${cwdRepo}: branch "feat/cwd" is not in the protected list (master, main, develop); ` +
        `${feat}: branch "feat/x" is not in the protected list (master, main, develop); allowing`,
    );
  });

  it("a patch carried in tool_input.command into a checkout on a feature branch, from an event cwd on master, is refused (the as-written judgment takes the event cwd)", async () => {
    const cwdRepo = makeRepo("master");
    const feat = makeRepo("feat/x");
    const run = await runHook(event(cwdRepo, { tool_input: { command: ["apply_patch", patchText(into(feat))] } }));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${cwdRepo} is protected (master, main, develop)`);
  });

  it("relative header paths are also resolved against a per-call workdir: a patch whose workdir is a checkout on master is refused", async () => {
    const cwdRepo = makeRepo("feat/cwd");
    const prod = makeRepo("master");
    fs.mkdirSync(path.join(prod, "src"));
    const run = await runHook(
      event(cwdRepo, { tool_input: { command: ["apply_patch", patchText(["*** Update File: src/x.ts"])], workdir: prod } }),
    );
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${path.join(prod, "src")} is protected (master, main, develop)`);
  });

  it.each<[string, (prod: string, body: string) => Record<string, unknown>]>([
    ["a per-call workdir under raw_input", (prod, body) => ({ tool_input: { input: body }, raw_input: { workdir: prod } })],
    ["a per-call workdir under a top-level input object", (prod, body) => ({ tool_input: { command: body }, input: { workdir: prod } })],
    ["a per-call cwd under tool_input", (prod, body) => ({ tool_input: { input: body, cwd: prod } })],
    ["a per-call cwd under raw_input", (prod, body) => ({ tool_input: { input: body }, raw_input: { cwd: prod } })],
  ])("relative header paths are also resolved against %s: a patch whose per-call directory is a checkout on master is refused", async (_name, shape) => {
    const cwdRepo = makeRepo("feat/cwd");
    const prod = makeRepo("master");
    fs.mkdirSync(path.join(prod, "src"));
    for (const runtime of ["claude-code", "codex"]) {
      const run = await runHook(event(cwdRepo, shape(prod, patchText(["*** Update File: src/x.ts"]))), { runtime });
      expect(run.blocked).toBe(true);
      expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${path.join(prod, "src")} is protected (master, main, develop)`);
    }
  });

  it("a patch without a header and a per-call workdir on master is refused (the workdir is checked with the event cwd)", async () => {
    const cwdRepo = makeRepo("feat/cwd");
    const prod = makeRepo("master");
    const run = await runHook(event(cwdRepo, { tool_input: { command: "apply_patch", workdir: prod } }));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${prod} is protected (master, main, develop)`);
  });

  it("Codex: a patch carried in tool_input.command into a checkout on master exits 2 with the reason on stderr", async () => {
    const cwdRepo = makeRepo("feat/cwd");
    const prod = makeRepo("master");
    const run = await runHook(event(cwdRepo, { tool_input: { command: ["apply_patch", patchText(into(prod))] } }), {
      runtime: "codex",
    });
    expect(run).toMatchObject({ exitCode: 2, blocked: true, stdout: "" });
    expect(run.stderr).toContain('branch-protection: refusing apply_patch on protected branch "master"');
  });
});

// Paths are judged where they physically lead, as git (which changes into
// the directory) and the write itself resolve them: through symlinks, with
// `..` taken from the directory reached so far. A target that is itself a
// symlink is judged by its own directory and by the directory it leads to.
describe.skipIf(!GIT_AVAILABLE || process.platform === "win32")("branch-protection hook: paths are judged where they physically lead, real git", () => {
  /** A directory with no `.git` entry above it, or a visible skip. */
  const outsideDir = (ctx: { skip: (note?: string) => void }): string => {
    const dir = tmpDir("harness-bp-outside-");
    if (hasGitEntryAbove(dir)) ctx.skip(`${dir} has a .git entry above it on this host`);
    return dir;
  };
  const protectedSrc = (): { repo: string; src: string } => {
    const repo = makeRepo("master", { commit: true });
    const src = path.join(repo, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "real.ts"), "x\n");
    return { repo, src };
  };

  it("a Write through a directory symlink from outside every repository into a checkout on master is refused", async (ctx) => {
    const outside = outsideDir(ctx);
    const { src } = protectedSrc();
    fs.symlinkSync(src, path.join(outside, "link"));
    const run = await runHook(writeEvent(outside, path.join(outside, "link", "a.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${src} is protected (master, main, develop)`);
  });

  it("an Edit of a file symlink from outside every repository to a file in a checkout on master is refused", async (ctx) => {
    const outside = outsideDir(ctx);
    const { src } = protectedSrc();
    fs.symlinkSync(path.join(src, "real.ts"), path.join(outside, "file-link.ts"));
    const run = await runHook(writeEvent(outside, path.join(outside, "file-link.ts"), "Edit"));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${src} is protected (master, main, develop)`);
  });

  it("a Write to a dangling file symlink from outside every repository into a checkout on master is refused", async (ctx) => {
    const outside = outsideDir(ctx);
    const { src } = protectedSrc();
    fs.symlinkSync(path.join(src, "new.ts"), path.join(outside, "dangling.ts"));
    const run = await runHook(writeEvent(outside, path.join(outside, "dangling.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${src} is protected (master, main, develop)`);
  });

  it("a Write to a path that goes up from a symlink's target lands, and is refused, in the checkout on master", async (ctx) => {
    const outside = outsideDir(ctx);
    const { repo, src } = protectedSrc();
    fs.symlinkSync(src, path.join(outside, "link"));
    const run = await runHook(writeEvent(outside, `${outside}/link/../b.ts`));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
  });

  it("a relative target from an event cwd that is a symlink into a checkout on master is refused", async (ctx) => {
    const outside = outsideDir(ctx);
    const { src } = protectedSrc();
    fs.symlinkSync(src, path.join(outside, "link"));
    const run = await runHook(writeEvent(path.join(outside, "link"), "a.ts", "Edit"));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${src} is protected (master, main, develop)`);
  });

  it("a tool without a target path, from an event cwd that is a symlink to the root of a checkout on master, is refused", async (ctx) => {
    const outside = outsideDir(ctx);
    const { repo } = protectedSrc();
    fs.symlinkSync(repo, path.join(outside, "repo-link"));
    const run = await runHook({ tool_name: "Bash", cwd: path.join(outside, "repo-link"), tool_input: { command: "ls" } });
    expect(run.blocked).toBe(true);
    // The as-written judgment runs first: the presence walk meets the
    // checkout's `.git` through the link, and git there names master.
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${path.join(outside, "repo-link")} is protected (master, main, develop)`);
  });

  it("an apply_patch header through a directory symlink from outside every repository into a checkout on master is refused", async (ctx) => {
    const outside = outsideDir(ctx);
    const { src } = protectedSrc();
    fs.symlinkSync(src, path.join(outside, "link"));
    const run = await runHook(patchEvent(outside, ["*** Add File: link/new.ts"]), { runtime: "codex" });
    expect(run).toMatchObject({ exitCode: 2, blocked: true, stdout: "" });
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${src} is protected (master, main, develop)`);
  });

  it("a Write through a directory symlink in a checkout on master into a checkout on a feature branch is allowed (judged by the feature branch, as written and physically)", async () => {
    const { repo } = protectedSrc();
    const feat = makeRepo("feat/x");
    fs.symlinkSync(feat, path.join(repo, "to-feat"));
    const run = await runHook(writeEvent(repo, path.join(repo, "to-feat", "a.ts")));
    expect(run.blocked).toBe(false);
    expect(run.diagnostic).toBe(
      `target ${path.join(repo, "to-feat")}: branch "feat/x" is not in the protected list (master, main, develop); ` +
        `${feat}: branch "feat/x" is not in the protected list (master, main, develop); allowing`,
    );
  });

  it("a Write through a directory symlink in a checkout on master to a directory outside every repository is refused: git, run in the directory as written, cannot answer", async (ctx) => {
    const outside = outsideDir(ctx);
    const { repo } = protectedSrc();
    fs.symlinkSync(outside, path.join(repo, "to-outside"));
    for (const runtime of ["claude-code", "codex"]) {
      const run = await runHook(writeEvent(repo, path.join(repo, "to-outside", "a.ts")), { runtime });
      expect(run.blocked).toBe(true);
      expect(run.exitCode).toBe(runtime === "codex" ? 2 : 0);
      expect(run.diagnostic).toMatch(
        new RegExp(`^BLOCK: git could not report the branch of ${escapeRe(path.join(repo, "to-outside"))}: git exited 128: fatal: not a git repository`),
      );
    }
  });

  it("an Edit of a file symlink in a checkout on a feature branch to a file in a checkout on master is refused", async () => {
    const { src } = protectedSrc();
    const feat = makeRepo("feat/x");
    fs.symlinkSync(path.join(src, "real.ts"), path.join(feat, "link.ts"));
    const run = await runHook(writeEvent(feat, path.join(feat, "link.ts"), "Edit"));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${src} is protected (master, main, develop)`);
  });
});

// Every path is also judged as written: made absolute against the event cwd
// with `.` and `..` resolved on the text, symlinks left in place, and the
// hook refuses when either judgment refuses. Here `lnk` sits in a checkout
// on master and leads to a directory outside every repository: written as
// `<checkout>/lnk/../f.ts`, the path names the checkout on master.
describe.skipIf(!GIT_AVAILABLE || process.platform === "win32")("branch-protection hook: paths are judged as written too, real git", () => {
  const RUNTIMES = ["claude-code", "codex"];
  const layout = (ctx: { skip: (note?: string) => void }, branch = "master"): string => {
    const outside = tmpDir("harness-bp-outside-");
    if (hasGitEntryAbove(outside)) ctx.skip(`${outside} has a .git entry above it on this host`);
    fs.mkdirSync(path.join(outside, "sub"));
    const repo = makeRepo(branch, { commit: true });
    fs.symlinkSync(path.join(outside, "sub"), path.join(repo, "lnk"));
    return repo;
  };
  const expectRefusedAsWritten = (run: Run, runtime: string, repo: string): void => {
    expect(run.blocked).toBe(true);
    expect(run.exitCode).toBe(runtime === "codex" ? 2 : 0);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
  };

  it.for(RUNTIMES)("%s: a Write to <checkout on master>/lnk/../f.ts, with lnk leading outside every repository, is refused", async (runtime, ctx) => {
    const repo = layout(ctx);
    const run = await runHook(writeEvent(repo, `${repo}/lnk/../f.ts`), { runtime });
    expectRefusedAsWritten(run, runtime, repo);
  });

  it.for(RUNTIMES)("%s: an Edit of the relative path lnk/../f.ts from a cwd on master, with lnk leading outside every repository, is refused", async (runtime, ctx) => {
    const repo = layout(ctx);
    const run = await runHook(writeEvent(repo, "lnk/../f.ts", "Edit"), { runtime });
    expectRefusedAsWritten(run, runtime, repo);
  });

  it.for(RUNTIMES)("%s: an apply_patch header lnk/../f.ts from a cwd on master, with lnk leading outside every repository, is refused", async (runtime, ctx) => {
    const repo = layout(ctx);
    const run = await runHook(patchEvent(repo, ["*** Update File: lnk/../f.ts"]), { runtime });
    expectRefusedAsWritten(run, runtime, repo);
  });

  it.for(RUNTIMES)("%s: an apply_patch header <checkout on master>/lnk/../new.ts, with lnk leading outside every repository, is refused", async (runtime, ctx) => {
    const repo = layout(ctx);
    const run = await runHook(patchEvent(repo, [`*** Add File: ${repo}/lnk/../new.ts`]), { runtime });
    expectRefusedAsWritten(run, runtime, repo);
  });

  it.for(RUNTIMES)("%s: a tool without a target path, from the event cwd <checkout on master>/lnk/.., is refused", async (runtime, ctx) => {
    const repo = layout(ctx);
    const run = await runHook({ tool_name: "Bash", cwd: `${repo}/lnk/..`, tool_input: { command: "ls" } }, { runtime });
    expectRefusedAsWritten(run, runtime, repo);
  });

  it("a Write to <checkout on a feature branch>/lnk/../f.ts, with lnk leading outside every repository, is allowed (both judgments allow)", async (ctx) => {
    const repo = layout(ctx, "feat/x");
    const run = await runHook(writeEvent(repo, `${repo}/lnk/../f.ts`));
    expect(run.blocked).toBe(false);
    expect(run.diagnostic).toMatch(new RegExp(`^target ${escapeRe(repo)}: branch "feat/x" is not in the protected list .*: outside any git repository; allowing$`));
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

  it.skipIf(!GIT_AVAILABLE)("a manifest that still names the removed post-merge-gate pack (listed first) loads with one warning and still refuses on a protected branch", async () => {
    const repo = makeRepo("master");
    const dir = tmpDir("harness-bp-manifest-");
    const cfg = path.join(dir, "harness.yaml");
    fs.writeFileSync(
      cfg,
      [
        "version: 1",
        "hooks: []",
        "policies: []",
        "policy_packs:",
        "  - name: post-merge-gate",
        "    source: builtin",
        "    enabled: true",
        "    config:",
        "      protected_branches: [release]",
        "  - name: branch-protection",
        "    source: builtin",
        "    enabled: true",
        "",
      ].join("\n"),
    );
    expect(loadManifest({ configPath: cfg }).warnings.map((w) => w.path)).toEqual(["policy_packs[0]"]);
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { configPath: cfg });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
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
    [
      "exit 1 with nothing on stdout but text on stderr",
      {
        kind: "exited",
        code: 1,
        stdout: "",
        stderr: "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)\n",
      },
      "git exited 1: xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)",
    ],
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

  it("an exit 1 with nothing on stdout and nothing on stderr is a detached HEAD and allows", async () => {
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

  it("the bound counts from the hook's start: a slow stdin leaves git no time and the call is refused", async () => {
    const dir = dirWithGit();
    const reader = vi.fn<GitHeadReader>(async () => ({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" }));
    const late = new PassThrough();
    setTimeout(() => late.end(JSON.stringify(writeEvent(dir, path.join(dir, "x.ts")))), 200);
    const out = capture();
    const err = capture();
    const result = await runPackHookBranchProtectionCli({
      stdin: late,
      stdout: out.stream,
      stderr: err.stream,
      manifest: manifestWithPack(),
      gitReader: reader,
      gitDeadlineMs: 150,
    });
    expect(result.blocked).toBe(true);
    expect(result.diagnostic).toMatch(/the hook passed its 150 ms bound/);
    expect(reader).not.toHaveBeenCalled();
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
    expect(run.diagnostic).toMatch(/the hook passed its 120 ms bound/);
    expect(reader.mock.calls.length).toBeLessThan(3);
    // Each call is bounded by what is left of the shared bound.
    for (const call of reader.mock.calls) expect(call[1]).toBeLessThanOrEqual(120);
  });

  it("resolving the paths is bounded too: once the bound passes while the paths are resolved, the call is refused", async () => {
    const dir = dirWithGit();
    let deep = dir;
    for (let i = 0; i < 10; i += 1) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    const rel = path.relative(dir, deep);
    const headers = Array.from({ length: 300 }, (_, i) => `*** Update File: ${rel}/f${i}.ts`);
    const reader = vi.fn<GitHeadReader>(async () => ({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" }));
    // A clock that moves one millisecond per reading: every step of the
    // resolution reads it, so the bound passes while the paths are resolved.
    let tick = 0;
    const run = await runHook(patchEvent(dir, headers, "command"), { gitReader: reader, gitDeadlineMs: 1000, now: () => tick++ });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe("BLOCK: the paths of the tool call were not resolved: the hook passed its 1000 ms bound");
    // git was asked only about the as-written judgment's directory (the event cwd).
    expect(reader.mock.calls.map((c) => c[0])).toEqual([dir]);
  });
});

describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: a patch with thousands of header lines stays within the bound, real git", () => {
  const largePatch = (repo: string): Record<string, unknown> => {
    let deep = repo;
    for (let i = 0; i < 20; i += 1) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    const rel = path.relative(repo, deep);
    const body = patchText(Array.from({ length: 6000 }, (_, i) => `*** Update File: ${rel}/f${i}.ts`));
    // The same patch in two fields: an argv array and raw_input.
    return { tool_name: "apply_patch", cwd: repo, tool_input: { command: ["apply_patch", body] }, raw_input: { command: body } };
  };

  it.each(["claude-code", "codex"])("%s: 6000 header lines into a checkout on master are refused within the 3000 ms bound", async (runtime) => {
    const repo = makeRepo("master");
    const event = largePatch(repo);
    const started = Date.now();
    const run = await runHook(event, { runtime });
    const elapsed = Date.now() - started;
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${repo} is protected (master, main, develop)`);
    expect(elapsed).toBeLessThan(GIT_READ_DEADLINE_MS);
  });

  it("6000 header lines into a checkout on a feature branch are resolved and judged within the 3000 ms bound (allowed)", async () => {
    const repo = makeRepo("feat/x");
    const event = largePatch(repo);
    const started = Date.now();
    const run = await runHook(event);
    const elapsed = Date.now() - started;
    expect(run.blocked, run.diagnostic).toBe(false);
    expect(elapsed).toBeLessThan(GIT_READ_DEADLINE_MS);
  });
});

// Every reader outcome against every tool shape, in both runtimes: the
// verdict depends on the outcome alone, never on the shape, and every error
// refuses. `dirs` counts the directories git is asked about on an allow:
// the as-written judgment's and the physical judgment's, each once (a patch
// carried in tool_input.command is not read by the as-written judgment,
// which takes the event cwd for it).
describe("branch-protection hook: the decision table (injected runner)", () => {
  const branchAnswer = (name: string): GitHeadAnswer => ({ kind: "exited", code: 0, stdout: `refs/heads/${name}\n`, stderr: "" });
  const OUTCOMES: Array<{ name: string; answer: GitHeadAnswer | "outside"; refuses: boolean }> = [
    { name: "a protected branch", answer: branchAnswer("main"), refuses: true },
    { name: "a protected branch in another case", answer: branchAnswer("DEVELOP"), refuses: true },
    { name: "a non-protected branch", answer: branchAnswer("feat/x"), refuses: false },
    { name: "a detached HEAD", answer: { kind: "exited", code: 1, stdout: "", stderr: "" }, refuses: false },
    { name: "a fatal exit", answer: { kind: "exited", code: 128, stdout: "", stderr: "fatal: no\n" }, refuses: true },
    { name: "exit 1 with output", answer: { kind: "exited", code: 1, stdout: "x\n", stderr: "" }, refuses: true },
    {
      name: "exit 1 with text on stderr only",
      answer: { kind: "exited", code: 1, stdout: "", stderr: "xcrun: error: invalid active developer path\n" },
      refuses: true,
    },
    { name: "an exit-0 answer naming a tag", answer: { kind: "exited", code: 0, stdout: "refs/tags/v1\n", stderr: "" }, refuses: true },
    { name: "a signal", answer: { kind: "signaled", signal: "SIGKILL", stderr: "" }, refuses: true },
    { name: "a timeout", answer: { kind: "timed-out", timeoutMs: 2000, stderr: "" }, refuses: true },
    { name: "output past the cap", answer: { kind: "oversized", stderr: "" }, refuses: true },
    { name: "git missing", answer: { kind: "spawn-failed", code: "ENOENT" }, refuses: true },
    { name: "outside every repository", answer: "outside", refuses: false },
  ];
  const SHAPES: Array<{ name: string; event: (dir: string) => Record<string, unknown>; dirs: number }> = [
    { name: "Write", event: (d) => writeEvent(d, path.join(d, "x.ts"), "Write"), dirs: 1 },
    { name: "Edit", event: (d) => writeEvent(d, path.join(d, "x.ts"), "Edit"), dirs: 1 },
    { name: "MultiEdit", event: (d) => writeEvent(d, path.join(d, "x.ts"), "MultiEdit"), dirs: 1 },
    { name: "NotebookEdit", event: (d) => writeEvent(d, path.join(d, "x.ipynb"), "NotebookEdit"), dirs: 1 },
    { name: "apply_patch without a header", event: (d) => ({ tool_name: "apply_patch", cwd: d, tool_input: { input: "nothing" } }), dirs: 1 },
    { name: "apply_patch with one header", event: (d) => patchEvent(d, ["*** Add File: a/x.ts"]), dirs: 1 },
    { name: "apply_patch with several headers", event: (d) => patchEvent(d, ["*** Add File: a/x.ts", "*** Update File: b/y.ts"]), dirs: 2 },
    { name: "apply_patch with one header under tool_input.command", event: (d) => patchEvent(d, ["*** Add File: a/x.ts"], "command"), dirs: 2 },
    {
      name: "apply_patch with several headers in a tool_input.command argv array",
      event: (d) => patchEvent(d, ["*** Add File: a/x.ts", "*** Update File: b/y.ts"], "argv"),
      dirs: 3,
    },
    { name: "Bash (no target path)", event: (d) => ({ tool_name: "Bash", cwd: d, tool_input: { command: "ls" } }), dirs: 1 },
  ];
  const rows = SHAPES.flatMap((shape) => OUTCOMES.map((outcome) => ({ shape, outcome })));
  // The outside rows need a temporary directory with no `.git` above it;
  // on a host whose temp directory sits inside a repository they are
  // skipped visibly.
  const TMP_HAS_REPO_ABOVE = hasGitEntryAbove(fs.realpathSync(os.tmpdir()));

  describe.each(["claude-code", "codex"])("%s", (runtime) => {
    const inside = rows.filter((r) => r.outcome.answer !== "outside");
    const outside = rows.filter((r) => r.outcome.answer === "outside");
    const runRow = async ({ shape, outcome }: (typeof rows)[number]): Promise<void> => {
      const dir = tmpDir("harness-bp-table-");
      fs.mkdirSync(path.join(dir, "a"));
      fs.mkdirSync(path.join(dir, "b"));
      if (outcome.answer !== "outside") fs.mkdirSync(path.join(dir, ".git"));
      const answerFor = outcome.answer;
      const reader = vi.fn<GitHeadReader>(async () =>
        answerFor === "outside" ? branchAnswer("master") : answerFor,
      );
      const run = await runHook(shape.event(dir), { runtime, gitReader: reader });
      expect(run.blocked).toBe(outcome.refuses);
      if (runtime === "codex") {
        expect(run.exitCode).toBe(outcome.refuses ? 2 : 0);
        expect(run.stdout).toBe("");
      } else {
        expect(run.exitCode).toBe(0);
        if (outcome.refuses) expect(envelope(run).decision).toBe("block");
        else expect(run.stdout).toBe("");
      }
      if (outcome.answer === "outside") expect(reader).not.toHaveBeenCalled();
      else expect(reader).toHaveBeenCalledTimes(outcome.refuses ? 1 : shape.dirs);
    };
    it.each(inside.map((r) => [`${r.shape.name} x ${r.outcome.name}`, r] as const))("%s", async (_label, row) => runRow(row));
    describe.skipIf(TMP_HAS_REPO_ABOVE)("outside every repository", () => {
      it.each(outside.map((r) => [`${r.shape.name} x ${r.outcome.name}`, r] as const))("%s", async (_label, row) => runRow(row));
    });
  });

  it.each([
    ["an error", { kind: "exited", code: 128, stdout: "", stderr: "fatal: no\n" } as GitHeadAnswer],
    ["a protected branch", branchAnswer("master")],
  ])("several headers: a later directory with %s refuses after an earlier one passed", async (_name, second) => {
    const dir = tmpDir("harness-bp-table-");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirSync(path.join(dir, "a"));
    fs.mkdirSync(path.join(dir, "b"));
    const reader = vi.fn<GitHeadReader>(async (d) => (d === path.join(dir, "a") ? branchAnswer("feat/x") : second));
    const run = await runHook(patchEvent(dir, ["*** Add File: a/x.ts", "*** Update File: b/y.ts"]), { gitReader: reader });
    expect(reader.mock.calls.map((c) => c[0])).toEqual([path.join(dir, "a"), path.join(dir, "b")]);
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toContain(path.join(dir, "b"));
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

// A detached HEAD is git exiting 1 with nothing on stdout and nothing on
// stderr (`symbolic-ref -q` prints nothing then). An exit 1 that writes to
// stderr is something else failing, a wrapper in front of git for example,
// and refuses like every other error.
describe.skipIf(!GIT_AVAILABLE || process.platform === "win32")("branch-protection hook: a git that exits 1 with a message refuses, real runner", () => {
  const standInGit = (): void => {
    const bin = tmpDir("harness-bp-fake-git-");
    fs.writeFileSync(
      path.join(bin, "git"),
      '#!/bin/sh\necho "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    setEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
  };

  it.each(["claude-code", "codex"])("%s: a Write into a checkout on main with a stand-in git (stderr text, exit 1) on PATH is refused", async (runtime) => {
    const repo = makeRepo("main");
    standInGit();
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")), { runtime });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(
      `BLOCK: git could not report the branch of ${repo}: git exited 1: xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)`,
    );
    if (runtime === "codex") expect(run).toMatchObject({ exitCode: 2, stdout: "" });
    else expect(envelope(run).decision).toBe("block");
  });

  const XCRUN_SHIM = process.platform === "darwin" && fs.existsSync("/usr/bin/xcrun") && fs.existsSync("/usr/bin/git");
  it.skipIf(!XCRUN_SHIM)("macOS: the /usr/bin/git shim failing for a missing developer directory refuses a Write into a checkout on main", async () => {
    const repo = makeRepo("main");
    setEnv("PATH", "/usr/bin:/bin");
    setEnv("DEVELOPER_DIR", path.join(tmpDir("harness-bp-devdir-"), "missing"));
    const run = await runHook(writeEvent(repo, path.join(repo, "x.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toMatch(/^BLOCK: git could not report the branch of .*: git exited 1: xcrun: error: /);
  });
});

// The presence walk counts a `.git` it cannot examine (an lstat failing
// for another reason than a missing path) as present, so git is asked; git
// cannot answer for that directory either, and the hook refuses.
describe.skipIf(!GIT_AVAILABLE || process.platform === "win32" || process.getuid?.() === 0)("branch-protection hook: a directory whose .git cannot be examined", () => {
  it("a Write into a directory that cannot be searched is refused with git's own message", async (ctx) => {
    const root = tmpDir("harness-bp-locked-");
    if (hasGitEntryAbove(root)) ctx.skip(`${root} has a .git entry above it on this host`);
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o600);
    cleanups.push(() => fs.chmodSync(locked, 0o755));
    const run = await runHook(writeEvent(root, path.join(locked, "x.ts")));
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toMatch(new RegExp(`^BLOCK: git could not report the branch of ${locked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: git exited 128: fatal: `));
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

// Each input of each judgment, pinned on its own: in every row below exactly
// one of the two judgments refuses and the other allows, so the verdict rests
// on that one judgment and that one input. Two links make a path name one
// checkout as written and the other physically: `<checkout on master>/lnk`
// leads into a feature checkout (so `<checkout on master>/lnk/..` is the
// checkout on master as written and the feature checkout physically), and
// `<feature checkout>/lnk` leads into the checkout on master (the other way
// round). Each row first asks git, run plainly in every directory of both
// judgments, what it answers there, so the row shows which judgment refuses
// and that the other one allows; then it runs the hook.
describe.skipIf(!GIT_AVAILABLE || process.platform === "win32")("branch-protection hook: rows where exactly one judgment refuses, real git", () => {
  interface Layout {
    /** A checkout on master; `lnk` in it leads to `<feat>/sub`. */
    prot: string;
    /** A checkout on feat/x; `lnk` in it leads to `<prot>/src`, `link.ts` and `link.ipynb` to files there. */
    feat: string;
  }
  const layout = (): Layout => {
    const prot = makeRepo("master");
    const feat = makeRepo("feat/x");
    fs.mkdirSync(path.join(prot, "src"));
    fs.writeFileSync(path.join(prot, "src", "real.ts"), "x\n");
    fs.writeFileSync(path.join(prot, "src", "real.ipynb"), "{}\n");
    fs.mkdirSync(path.join(feat, "sub"));
    fs.symlinkSync(path.join(feat, "sub"), path.join(prot, "lnk"));
    fs.symlinkSync(path.join(prot, "src"), path.join(feat, "lnk"));
    fs.symlinkSync(path.join(prot, "src", "real.ts"), path.join(feat, "link.ts"));
    fs.symlinkSync(path.join(prot, "src", "real.ipynb"), path.join(feat, "link.ipynb"));
    return { prot, feat };
  };

  type Judgment = "as written" | "physically";
  interface Row {
    name: string;
    refuses: Judgment;
    event: (l: Layout) => Record<string, unknown>;
    /** The directories the as-written judgment asks git about. */
    asWritten: (l: Layout) => string[];
    /** The directories the physical judgment asks git about. */
    physical: (l: Layout) => string[];
    /** The directory the refusal names. */
    refusedIn: (l: Layout) => string;
  }
  /** Refused as written in the checkout on master, allowed physically in the feature checkout. */
  const asWrittenRow = (name: string, event: Row["event"]): Row => ({
    name,
    refuses: "as written",
    event,
    asWritten: (l) => [l.prot],
    physical: (l) => [l.feat],
    refusedIn: (l) => l.prot,
  });
  /** Allowed as written in the feature checkout, refused physically in `refusedIn`. */
  const physicalRow = (name: string, event: Row["event"], physical: Row["physical"], refusedIn: Row["refusedIn"]): Row => ({
    name,
    refuses: "physically",
    event,
    asWritten: (l) => [l.feat],
    physical,
    refusedIn,
  });
  const apply = (cwd: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    tool_name: "apply_patch",
    cwd,
    ...extra,
  });
  /** `<checkout on master>/lnk/../<name>`: the checkout on master as written, the feature checkout physically. */
  const viaProt = (l: Layout, name: string): string => `${l.prot}/lnk/../${name}`;
  /** `<feature checkout>/lnk/../<name>`: the feature checkout as written, the checkout on master physically. */
  const viaFeat = (l: Layout, name: string): string => `${l.feat}/lnk/../${name}`;
  /** A patch whose one header names `<checkout on master>/x.ts`. */
  const intoProt = (l: Layout): string => patchText([`*** Update File: ${path.join(l.prot, "x.ts")}`]);
  const onlyProt = (l: Layout): string[] => [l.prot];
  const featAndProtSrc = (l: Layout): string[] => [l.feat, path.join(l.prot, "src")];
  const protSrc = (l: Layout): string => path.join(l.prot, "src");

  const ROWS: Row[] = [
    // Refused as written, allowed physically.
    asWrittenRow("a Write to <checkout on master>/lnk/../f.ts from a feature-branch cwd is refused", (l) => writeEvent(l.feat, viaProt(l, "f.ts"), "Write")),
    asWrittenRow("an Edit of <checkout on master>/lnk/../f.ts from a feature-branch cwd is refused", (l) => writeEvent(l.feat, viaProt(l, "f.ts"), "Edit")),
    asWrittenRow("a MultiEdit of <checkout on master>/lnk/../f.ts from a feature-branch cwd is refused", (l) => writeEvent(l.feat, viaProt(l, "f.ts"), "MultiEdit")),
    asWrittenRow("a NotebookEdit of <checkout on master>/lnk/../n.ipynb from a feature-branch cwd is refused", (l) => writeEvent(l.feat, viaProt(l, "n.ipynb"), "NotebookEdit")),
    asWrittenRow("an apply_patch header <checkout on master>/lnk/../p.ts in tool_input.patch, from a feature-branch cwd, is refused", (l) => patchEvent(l.feat, [`*** Add File: ${viaProt(l, "p.ts")}`], "patch")),
    asWrittenRow("an apply_patch header <checkout on master>/lnk/../p.ts in tool_input.input, from a feature-branch cwd, is refused", (l) => patchEvent(l.feat, [`*** Add File: ${viaProt(l, "p.ts")}`], "input")),
    asWrittenRow("an apply_patch header <checkout on master>/lnk/../p.ts in a string tool_input, from a feature-branch cwd, is refused", (l) => patchEvent(l.feat, [`*** Add File: ${viaProt(l, "p.ts")}`], "string")),
    asWrittenRow("a tool without a target path from the event cwd <checkout on master>/lnk/.. is refused", (l) => ({ tool_name: "Bash", cwd: `${l.prot}/lnk/..`, tool_input: { command: "ls" } })),
    asWrittenRow("an apply_patch without a header from the event cwd <checkout on master>/lnk/.. is refused", (l) => apply(`${l.prot}/lnk/..`, { tool_input: { input: "no headers here" } })),
    asWrittenRow("an apply_patch whose header into the feature checkout sits in tool_input.command, from the event cwd <checkout on master>/lnk/.., is refused", (l) => apply(`${l.prot}/lnk/..`, { tool_input: { command: patchText([`*** Update File: ${path.join(l.feat, "x.ts")}`]) } })),
    // Allowed as written, refused physically.
    physicalRow("a Write to <feature checkout>/lnk/../f.ts is refused", (l) => writeEvent(l.feat, viaFeat(l, "f.ts"), "Write"), onlyProt, (l) => l.prot),
    physicalRow("an Edit of <feature checkout>/lnk/../f.ts is refused", (l) => writeEvent(l.feat, viaFeat(l, "f.ts"), "Edit"), onlyProt, (l) => l.prot),
    physicalRow("a MultiEdit of <feature checkout>/lnk/../f.ts is refused", (l) => writeEvent(l.feat, viaFeat(l, "f.ts"), "MultiEdit"), onlyProt, (l) => l.prot),
    physicalRow("a NotebookEdit of <feature checkout>/lnk/../n.ipynb is refused", (l) => writeEvent(l.feat, viaFeat(l, "n.ipynb"), "NotebookEdit"), onlyProt, (l) => l.prot),
    physicalRow("a Write to a file symlink in the feature checkout leading into the checkout on master is refused", (l) => writeEvent(l.feat, path.join(l.feat, "link.ts"), "Write"), featAndProtSrc, protSrc),
    physicalRow("an Edit of a file symlink in the feature checkout leading into the checkout on master is refused", (l) => writeEvent(l.feat, path.join(l.feat, "link.ts"), "Edit"), featAndProtSrc, protSrc),
    physicalRow("a MultiEdit of a file symlink in the feature checkout leading into the checkout on master is refused", (l) => writeEvent(l.feat, path.join(l.feat, "link.ts"), "MultiEdit"), featAndProtSrc, protSrc),
    physicalRow("a NotebookEdit of a notebook symlink in the feature checkout leading into the checkout on master is refused", (l) => writeEvent(l.feat, path.join(l.feat, "link.ipynb"), "NotebookEdit"), featAndProtSrc, protSrc),
    physicalRow("an apply_patch header into the checkout on master in tool_input.command, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { command: intoProt(l) } }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch header into the checkout on master in a tool_input.command argv array, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { command: ["apply_patch", intoProt(l)] } }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch header into the checkout on master in a nested field of tool_input, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { args: { patch_text: intoProt(l) } } }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch header into the checkout on master in raw_input, from a feature-branch cwd, is refused", (l) => apply(l.feat, { raw_input: { command: intoProt(l) } }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch header into the checkout on master in a top-level input string, from a feature-branch cwd, is refused", (l) => apply(l.feat, { input: intoProt(l) }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch header into the checkout on master in JSON object text inside a tool_input string, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { arguments: JSON.stringify({ input: intoProt(l) }) } }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch header into the checkout on master in JSON array text inside a tool_input string, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { arguments: JSON.stringify(["apply_patch", intoProt(l)]) } }), onlyProt, (l) => l.prot),
    physicalRow("a relative apply_patch header src/x.ts with a per-call workdir on the checkout on master, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { input: patchText(["*** Update File: src/x.ts"]), workdir: l.prot } }), featAndProtSrc, protSrc),
    physicalRow("a relative apply_patch header src/x.ts with a per-call cwd on the checkout on master, from a feature-branch cwd, is refused", (l) => apply(l.feat, { tool_input: { input: patchText(["*** Update File: src/x.ts"]), cwd: l.prot } }), featAndProtSrc, protSrc),
    physicalRow("a tool without a target path from the event cwd <feature checkout>/lnk/.. is refused", (l) => ({ tool_name: "Bash", cwd: `${l.feat}/lnk/..`, tool_input: { command: "ls" } }), onlyProt, (l) => l.prot),
    physicalRow("an apply_patch without a header from the event cwd <feature checkout>/lnk/.. is refused", (l) => apply(`${l.feat}/lnk/..`, { tool_input: { input: "no headers here" } }), onlyProt, (l) => l.prot),
    physicalRow("a relative apply_patch header x.ts in tool_input.command from the event cwd <feature checkout>/lnk/.. is refused", (l) => apply(`${l.feat}/lnk/..`, { tool_input: { command: patchText(["*** Update File: x.ts"]) } }), onlyProt, (l) => l.prot),
  ];

  /** What git, run plainly in each directory, answers: in the directory as given, or in its physical directory. */
  const gitAnswers = async (dirs: string[], judgment: Judgment): Promise<string[]> => {
    const out: string[] = [];
    for (const dir of dirs) {
      const read = judgment === "physically" ? await readBranch(dir) : await readBranchAt(dir);
      out.push(read.kind === "branch" ? read.name : read.kind === "error" ? `error: ${read.detail}` : read.kind);
    }
    return out;
  };

  const cases = ROWS.flatMap((row) => (["claude-code", "codex"] as const).map((runtime) => [`${runtime}: ${row.name} (${row.refuses} only)`, row, runtime] as const));
  it.each(cases)("%s", async (_label, row, runtime) => {
    const l = layout();
    const asWritten = await gitAnswers(row.asWritten(l), "as written");
    const physical = await gitAnswers(row.physical(l), "physically");
    const [refusing, allowing] = row.refuses === "as written" ? [asWritten, physical] : [physical, asWritten];
    expect(refusing).toContain("master");
    expect(allowing.length).toBeGreaterThan(0);
    for (const answer of allowing) expect(answer).toBe("feat/x");

    const run = await runHook(row.event(l), { runtime });
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: branch "master" of ${row.refusedIn(l)} is protected (master, main, develop)`);
    if (runtime === "codex") {
      expect(run).toMatchObject({ exitCode: 2, stdout: "" });
      expect(run.stderr).toContain('on protected branch "master"');
    } else {
      expect(run.exitCode).toBe(0);
      expect(envelope(run).decision).toBe("block");
    }
  });
});

// The bound covers each judgment's path resolution on its own: an injected
// clock that moves one millisecond per reading passes the bound while one
// judgment resolves its paths, and the call is refused before git is asked
// about anything. A reader that throws or rejects refuses as well.
describe("branch-protection hook: the bound in each judgment, and a failing reader (injected clock and runner)", () => {
  const RUNTIMES = ["claude-code", "codex"] as const;
  const BOUND_DETAIL = "the paths of the tool call were not resolved: the hook passed its 1000 ms bound";
  /** 300 header paths, each ten missing directories deep under `base`. */
  const deepHeaders = (base: string): string[] =>
    Array.from({ length: 300 }, (_, i) => `*** Update File: ${base}m${i}/d1/d2/d3/d4/d5/d6/d7/d8/d9/f.ts`);
  const expectRefused = (run: Run, runtime: string, toolName: string, detail: string): void => {
    expect(run.blocked).toBe(true);
    expect(run.diagnostic).toBe(`BLOCK: ${detail}`);
    const text = `branch-protection: refusing ${toolName}: ${detail}.`;
    if (runtime === "codex") {
      expect(run).toMatchObject({ exitCode: 2, stdout: "" });
      expect(run.stderr).toContain(text);
    } else {
      expect(run.exitCode).toBe(0);
      expect(envelope(run).reason).toBe(text);
    }
  };

  it.each(RUNTIMES)("%s: the bound passing while the as-written paths are resolved (headers in tool_input.input) refuses before git is asked", async (runtime) => {
    const dir = tmpDir("harness-bp-bound-");
    fs.mkdirSync(path.join(dir, ".git"));
    const reader = vi.fn<GitHeadReader>(async () => ({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" }));
    let tick = 0;
    const run = await runHook(patchEvent(dir, deepHeaders(""), "input"), { runtime, gitReader: reader, gitDeadlineMs: 1000, now: () => tick++ });
    expectRefused(run, runtime, "apply_patch", BOUND_DETAIL);
    expect(reader).not.toHaveBeenCalled();
  });

  it.for(RUNTIMES)("%s: the bound passing while the physical paths are resolved (headers in tool_input.command, cwd outside every repository) refuses before git is asked", async (runtime, ctx) => {
    const outside = tmpDir("harness-bp-outside-");
    if (hasGitEntryAbove(outside)) ctx.skip(`${outside} has a .git entry above it on this host`);
    const target = tmpDir("harness-bp-bound-");
    fs.mkdirSync(path.join(target, ".git"));
    const reader = vi.fn<GitHeadReader>(async () => ({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" }));
    let tick = 0;
    const run = await runHook(patchEvent(outside, deepHeaders(`${target}/`), "command"), {
      runtime,
      gitReader: reader,
      gitDeadlineMs: 1000,
      now: () => tick++,
    });
    expectRefused(run, runtime, "apply_patch", BOUND_DETAIL);
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(
    RUNTIMES.flatMap((runtime) => [
      [runtime, "throws", () => {
        throw new Error("the git reader failed");
      }],
      [runtime, "rejects", async () => {
        throw new Error("the git reader failed");
      }],
    ] as const),
  )("%s: a Write is refused when the git reader %s", async (runtime, _how, fail) => {
    const dir = tmpDir("harness-bp-reader-");
    fs.mkdirSync(path.join(dir, ".git"));
    const reader = vi.fn<GitHeadReader>(fail);
    const run = await runHook(writeEvent(dir, path.join(dir, "x.ts")), { runtime, gitReader: reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expectRefused(run, runtime, "Write", "the tool call could not be judged (the git reader failed)");
  });
});

// A directory of the physical judgment is resolved again right before git
// is asked about it; one that can no longer be resolved then (removed while
// git answered for an earlier directory of the same call) refuses. The real
// git runs behind a reader that removes the second directory while git
// answers for the first.
describe.skipIf(!GIT_AVAILABLE)("branch-protection hook: a directory that can no longer be resolved when it is judged, real git", () => {
  it.each(["claude-code", "codex"] as const)("%s: an apply_patch into two directories of a feature checkout is refused when the second one is removed while git answers for the first", async (runtime) => {
    const repo = makeRepo("feat/x");
    const a = path.join(repo, "a");
    const b = path.join(repo, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const reader = vi.fn<GitHeadReader>(async (dir, timeoutMs) => {
      if (dir === a) fs.rmSync(b, { recursive: true, force: true });
      return readGitHead(dir, timeoutMs);
    });
    // The headers sit in tool_input.command, so the as-written judgment
    // takes the event cwd and the physical judgment takes a, then b.
    const run = await runHook(patchEvent(repo, ["*** Add File: a/x.ts", "*** Update File: b/y.ts"], "command"), { runtime, gitReader: reader });
    expect(reader.mock.calls.map((c) => c[0])).toEqual([repo, a]);
    expect(run.blocked).toBe(true);
    const detail = "the directory could not be resolved (ENOENT)";
    expect(run.diagnostic).toBe(`BLOCK: git could not report the branch of ${b}: ${detail}`);
    if (runtime === "codex") {
      expect(run).toMatchObject({ exitCode: 2, stdout: "" });
      expect(run.stderr).toContain(`branch-protection: refusing apply_patch: git could not report the branch of ${b} (${detail}).`);
    } else {
      expect(run.exitCode).toBe(0);
      expect(envelope(run).reason).toBe(`branch-protection: refusing apply_patch: git could not report the branch of ${b} (${detail}).`);
    }
  });
});
