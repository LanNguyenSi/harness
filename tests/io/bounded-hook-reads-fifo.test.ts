// A by-path read on a hook path must never block on a FIFO, a device or an
// oversized file past the hook's budget, which the runtime treats as an
// allow (task 323bd5b9, the class #639 closed for the gate markers).
//
// Every case runs the BUILT reader in a child process under a SIGKILL
// timeout, so a regression to a blocking read shows up as a killed child
// ("timedOut"), not as a hung test worker. Each FIFO case has a control case
// against a regular file through the same child, so a case cannot pass
// because the module path or export name was wrong.
//
// Needs dist/ (`npm run build` before `vitest`), like the other subprocess
// tests.

import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(REPO_ROOT, "dist");
const BOUND_MS = 10_000;
const SHA_NEW = "a".repeat(40);
const SHA_OLD = "b".repeat(40);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-hook-reads-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ChildRun {
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  /** The JSON the child printed, or undefined when it printed none. */
  value: unknown;
}

function runChild(script: string, args: string[]): ChildRun {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
    encoding: "utf8",
    timeout: BOUND_MS,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout ?? "";
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    value = undefined;
  }
  return {
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    ms: Date.now() - started,
    stdout,
    stderr: result.stderr ?? "",
    value,
  };
}

// Calls `<module>.<fn>(...JSON args)` in a child and prints
// `{ ok: <result> }` or `{ threw: { name, code } }`.
const CALL_SCRIPT = `
const [, modPath, fn, rawArgs] = process.argv;
const mod = await import(modPath);
const args = JSON.parse(rawArgs);
try {
  const out = await mod[fn](...args);
  process.stdout.write(JSON.stringify({ ok: out === undefined ? null : out }));
} catch (err) {
  process.stdout.write(JSON.stringify({ threw: { name: err && err.name, code: err && err.code } }));
}
`;

function callInChild(modRel: string, fn: string, args: unknown[]): ChildRun {
  return runChild(CALL_SCRIPT, [pathToFileURL(path.join(DIST, modRel)).href, fn, JSON.stringify(args)]);
}

function expectBounded(run: ChildRun): void {
  expect(run.timedOut).toBe(false);
  expect(run.ms).toBeLessThan(BOUND_MS);
}

function mkfifo(p: string): void {
  execFileSync("mkfifo", [p]);
}

/** A sparse regular file whose size is over `bytes`: only the size is big, no data is written. */
function sparseFile(p: string, bytes: number, head = ""): void {
  fs.writeFileSync(p, head);
  fs.truncateSync(p, bytes);
}

describe.skipIf(process.platform === "win32")("git-context: by-path git file reads are bounded and non-blocking", () => {
  function makeRepo(opts: { branch?: string; loose?: string | null; packed?: string | null } = {}): string {
    const branch = opts.branch ?? "main";
    const repo = path.join(tmp, "repo");
    const gitDir = path.join(repo, ".git");
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    if (opts.loose !== null) {
      fs.writeFileSync(path.join(gitDir, "refs", "heads", branch), `${opts.loose ?? SHA_NEW}\n`);
    }
    if (opts.packed !== null && opts.packed !== undefined) {
      fs.writeFileSync(path.join(gitDir, "packed-refs"), opts.packed);
    }
    return repo;
  }
  const resolve = (repo: string): ChildRun => callInChild("runtime/git-context.js", "resolveGitContext", [repo]);
  const packedFor = (sha: string, branch = "main"): string => `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/${branch}\n`;

  it("control: a regular loose ref resolves", () => {
    const run = resolve(makeRepo());
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "repo", branch: "main", sha: SHA_NEW } });
  });

  it("a FIFO at the loose ref returns within the bound, with the sha unknown and the path reported", () => {
    const repo = makeRepo({ loose: null });
    mkfifo(path.join(repo, ".git", "refs", "heads", "main"));
    const run = resolve(repo);
    expectBounded(run);
    expect(run.value).toEqual({
      ok: { repo: "repo", branch: "main", sha: "", refused: ["refs/heads/main"] },
    });
  });

  it("a FIFO at the loose ref does NOT fall back to the older tip in packed-refs", () => {
    const repo = makeRepo({ loose: null, packed: packedFor(SHA_OLD) });
    mkfifo(path.join(repo, ".git", "refs", "heads", "main"));
    const run = resolve(repo);
    expectBounded(run);
    expect(run.value).toEqual({
      ok: { repo: "repo", branch: "main", sha: "", refused: ["refs/heads/main"] },
    });
  });

  it("control: a missing loose ref still falls back to packed-refs", () => {
    const run = resolve(makeRepo({ loose: null, packed: packedFor(SHA_OLD) }));
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "repo", branch: "main", sha: SHA_OLD } });
  });

  it("a FIFO at packed-refs returns within the bound", () => {
    const repo = makeRepo({ loose: null });
    mkfifo(path.join(repo, ".git", "packed-refs"));
    const run = resolve(repo);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "repo", branch: "main", sha: "", refused: ["packed-refs"] } });
  });

  it("an oversized packed-refs (sparse, over the cap) is refused without a read", () => {
    const repo = makeRepo({ loose: null });
    sparseFile(path.join(repo, ".git", "packed-refs"), 33 * 1024 * 1024, packedFor(SHA_OLD));
    const run = resolve(repo);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "repo", branch: "main", sha: "", refused: ["packed-refs"] } });
  });

  it("a legitimately large packed-refs (over the 1 MiB marker cap) still resolves", () => {
    const filler = Array.from({ length: 40_000 }, (_, i) => `${"c".repeat(40)} refs/tags/t${i}`).join("\n");
    expect(filler.length).toBeGreaterThan(1024 * 1024);
    const repo = makeRepo({ loose: null, packed: `${filler}\n${SHA_OLD} refs/heads/main\n` });
    const run = resolve(repo);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "repo", branch: "main", sha: SHA_OLD } });
  });

  it("a FIFO at HEAD returns within the bound with branch and sha unknown and HEAD reported", () => {
    const repo = makeRepo();
    fs.rmSync(path.join(repo, ".git", "HEAD"));
    mkfifo(path.join(repo, ".git", "HEAD"));
    // The repository is still a repository (a HEAD that is present but not a
    // regular file is reported, never read as "outside a work tree").
    const run = resolve(repo);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "repo", branch: "", sha: "", refused: ["HEAD"] } });
  });

  it("a FIFO at HEAD in a linked-worktree gitdir is reported as refused", () => {
    const main = path.join(tmp, "main-repo");
    fs.mkdirSync(path.join(main, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    const wtGit = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGit, { recursive: true });
    mkfifo(path.join(wtGit, "HEAD"));
    const worktree = path.join(tmp, "wt");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${wtGit}\n`);
    const run = resolve(worktree);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "wt", branch: "", sha: "", refused: ["HEAD"] } });
  });

  it("a FIFO at commondir returns within the bound and is reported", () => {
    const main = path.join(tmp, "main-repo");
    fs.mkdirSync(path.join(main, ".git", "refs", "heads"), { recursive: true });
    const wtGit = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/main\n");
    mkfifo(path.join(wtGit, "commondir"));
    const worktree = path.join(tmp, "wt");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${wtGit}\n`);
    const run = resolve(worktree);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "wt", branch: "main", sha: "", refused: ["commondir"] } });
  });

  it("an oversized .git pointer file returns within the bound with the path reported", () => {
    const worktree = path.join(tmp, "wt");
    fs.mkdirSync(worktree);
    sparseFile(path.join(worktree, ".git"), 2 * 1024 * 1024, "gitdir: /nowhere\n");
    const run = resolve(worktree);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { repo: "wt", branch: "", sha: "", refused: [".git"] } });
  });

  it("control: resolveOriginHeadBase reads a regular loose symref", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/trunk\n");
    const run = callInChild("runtime/git-context.js", "resolveOriginHeadBase", [path.join(repo, ".git")]);
    expectBounded(run);
    expect(run.value).toEqual({ ok: "trunk" });
  });

  it("a FIFO at refs/remotes/origin/HEAD returns null within the bound, no packed-refs fallback", () => {
    const repo = makeRepo({
      packed: `# pack-refs\n${SHA_OLD} refs/remotes/origin/HEAD\n${SHA_OLD} refs/remotes/origin/stale\n`,
    });
    fs.mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
    mkfifo(path.join(repo, ".git", "refs", "remotes", "origin", "HEAD"));
    const run = callInChild("runtime/git-context.js", "resolveOriginHeadBase", [path.join(repo, ".git")]);
    expectBounded(run);
    expect(run.value).toEqual({ ok: null });
  });

  it("a FIFO at packed-refs makes resolveOriginHeadBase return null within the bound", () => {
    const repo = makeRepo();
    mkfifo(path.join(repo, ".git", "packed-refs"));
    const run = callInChild("runtime/git-context.js", "resolveOriginHeadBase", [path.join(repo, ".git")]);
    expectBounded(run);
    expect(run.value).toEqual({ ok: null });
  });

  it("resolveCommonDir returns the gitdir unchanged for a FIFO commondir", () => {
    const gitDir = path.join(tmp, "gitdir");
    fs.mkdirSync(gitDir);
    mkfifo(path.join(gitDir, "commondir"));
    const run = callInChild("runtime/git-context.js", "resolveCommonDir", [gitDir]);
    expectBounded(run);
    expect(run.value).toEqual({ ok: gitDir });
  });
});

describe.skipIf(process.platform === "win32")("runtime state files: a FIFO at the path reads as absent, within the bound", () => {
  it("pause sentinel: a FIFO is NOT a pause (gates stay armed); a regular sentinel is", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, ".harness-paused"),
      JSON.stringify({ pausedAt: "2026-10-06T00:00:00.000Z", expiresAt: null, reason: null, pausedBy: null }),
    );
    const control = callInChild("runtime/pause-sentinel.js", "readSentinel", [dir]);
    expectBounded(control);
    expect((control.value as { ok: { kind: string } }).ok.kind).toBe("active");

    fs.rmSync(path.join(dir, ".harness-paused"));
    mkfifo(path.join(dir, ".harness-paused"));
    const run = callInChild("runtime/pause-sentinel.js", "readSentinel", [dir]);
    expectBounded(run);
    expect(run.value).toEqual({ ok: { kind: "absent" } });
  });

  it("pause sentinel: a VALID sentinel padded past the 1 MiB cap is not a pause either, while the same one under the cap is", () => {
    // A sparse file of zeros is malformed JSON, so it would read as absent
    // even with no size cap. Trailing whitespace keeps the JSON valid: only
    // the cap separates "active" from "absent" here.
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    const sentinel = JSON.stringify({ pausedAt: "2026-10-06T00:00:00.000Z", expiresAt: null, reason: null, pausedBy: null });
    fs.writeFileSync(path.join(dir, ".harness-paused"), `${sentinel}${" ".repeat(1024 * 1024 - sentinel.length - 1)}\n`);
    expect(fs.statSync(path.join(dir, ".harness-paused")).size).toBe(1024 * 1024);
    const atCap = callInChild("runtime/pause-sentinel.js", "readSentinel", [dir]);
    expectBounded(atCap);
    expect((atCap.value as { ok: { kind: string } }).ok.kind).toBe("active");

    fs.writeFileSync(path.join(dir, ".harness-paused"), `${sentinel}${" ".repeat(1024 * 1024 + 16)}\n`);
    const over = callInChild("runtime/pause-sentinel.js", "readSentinel", [dir]);
    expectBounded(over);
    expect(over.value).toEqual({ ok: { kind: "absent" } });
  });

  it("pending approval: a FIFO reads as no staged session id", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".pending-approval"), "sess-1\n");
    const control = callInChild("runtime/pending-approval.js", "readPendingApproval", [dir]);
    expectBounded(control);
    expect(control.value).toEqual({ ok: "sess-1" });

    fs.rmSync(path.join(dir, ".pending-approval"));
    mkfifo(path.join(dir, ".pending-approval"));
    const run = callInChild("runtime/pending-approval.js", "readPendingApproval", [dir]);
    expectBounded(run);
    expect(run.value).toEqual({ ok: null });
  });

  it("active claim: a FIFO reads as refused, not as no claim", () => {
    const mod = "policy-packs/builtin/understanding-before-execution/active-claim.js";
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "active-claim"), "task-123\n");
    const control = callInChild(mod, "readActiveClaim", [dir]);
    expectBounded(control);
    expect(control.value).toEqual({ ok: { kind: "claim", taskId: "task-123" } });

    fs.rmSync(path.join(dir, "active-claim"));
    mkfifo(path.join(dir, "active-claim"));
    const run = callInChild(mod, "readActiveClaim", [dir]);
    expectBounded(run);
    expect(run.value).toMatchObject({ ok: { kind: "refused" } });
  });

  it("kubeconfig: a FIFO reads as an unknown context; a regular file resolves", () => {
    const cfg = path.join(tmp, "kubeconfig");
    fs.writeFileSync(
      cfg,
      "current-context: prod\ncontexts:\n  - name: prod\n    context: { namespace: payments }\n",
    );
    const control = callInChild("runtime/kube-context.js", "resolveKubeContext", [{ kubeconfigPath: cfg }]);
    expectBounded(control);
    expect(control.value).toEqual({ ok: { context: "prod", namespace: "payments" } });

    fs.rmSync(cfg);
    mkfifo(cfg);
    const run = callInChild("runtime/kube-context.js", "resolveKubeContext", [{ kubeconfigPath: cfg }]);
    expectBounded(run);
    expect(run.value).toMatchObject({ ok: { context: "", namespace: "", unreadable: expect.stringContaining("not a regular file") } });
  });
});

describe.skipIf(process.platform === "win32")("approval signing key: a FIFO at the key path throws, never blocks, never regenerates", () => {
  const MOD = "runtime/approval-signing.js";

  it("control: a regular key is returned; an absent key is created", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    const created = callInChild(MOD, "getOrCreateSigningKey", [dir]);
    expectBounded(created);
    expect((created.value as { ok: { created: boolean } }).ok.created).toBe(true);
    const again = callInChild(MOD, "getOrCreateSigningKey", [dir]);
    expectBounded(again);
    expect((again.value as { ok: { created: boolean } }).ok.created).toBe(false);
  });

  it("a FIFO at the key path throws within the bound and is left in place", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    const keyPath = path.join(dir, ".approval-signing.key");
    mkfifo(keyPath);
    const run = callInChild(MOD, "getOrCreateSigningKey", [dir]);
    expectBounded(run);
    expect(run.value).toEqual({ threw: { name: "BoundedReadError", code: "E_NOT_REGULAR" } });
    expect(fs.lstatSync(keyPath).isFIFO()).toBe(true);
  });

  it("an oversized key file throws within the bound", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    sparseFile(path.join(dir, ".approval-signing.key"), 2 * 1024 * 1024, "x".repeat(64));
    const run = callInChild(MOD, "getOrCreateSigningKey", [dir]);
    expectBounded(run);
    expect(run.value).toEqual({ threw: { name: "BoundedReadError", code: "E_UNREADABLE" } });
  });
});

describe.skipIf(process.platform === "win32")("manifest loader: a FIFO at a manifest path fails the load within the bound", () => {
  it("control: a regular manifest loads", () => {
    const cfg = path.join(tmp, "harness.yaml");
    fs.writeFileSync(cfg, "version: 1\n");
    const run = callInChild("cli/loader.js", "loadMergedRaw", [{ configPath: cfg, homeDir: path.join(tmp, "home") }]);
    expectBounded(run);
    expect((run.value as { ok: { mergedRaw: unknown } }).ok.mergedRaw).toEqual({ version: 1 });
  });

  it("a FIFO at the base manifest path throws an exit error within the bound", () => {
    const cfg = path.join(tmp, "harness.yaml");
    mkfifo(cfg);
    const run = callInChild("cli/loader.js", "loadMergedRaw", [{ configPath: cfg, homeDir: path.join(tmp, "home") }]);
    expectBounded(run);
    expect((run.value as { threw: { name: string } }).threw.name).toBe("HarnessExitError");
  });

  it("a FIFO at a machine override layer throws within the bound", () => {
    const cfg = path.join(tmp, "harness.yaml");
    fs.writeFileSync(cfg, "version: 1\n");
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, "machines"), { recursive: true });
    // `default` is always among the candidate layer names.
    const candidates = callInChild("overrides/machines.js", "machineOverrideCandidates", [
      callInChild("overrides/machines.js", "resolveMachineDiscriminators", [{}]).value
        ? (callInChild("overrides/machines.js", "resolveMachineDiscriminators", [{}]).value as { ok: unknown }).ok
        : {},
    ]);
    const names = (candidates.value as { ok: string[] }).ok;
    expect(names.length).toBeGreaterThan(0);
    mkfifo(path.join(home, "machines", `${names[0]}.harness.overrides.yaml`));
    const run = callInChild("cli/loader.js", "loadMergedRaw", [{ configPath: cfg, homeDir: home }]);
    expectBounded(run);
    expect((run.value as { threw: { name: string } }).threw.name).toBe("HarnessExitError");
  });
});

describe.skipIf(process.platform === "win32")("persisted reports: the plain listing reads through the bounded descriptor read", () => {
  const MOD = "policy-packs/builtin/understanding-before-execution/persisted-reports.js";
  const report = JSON.stringify({
    sessionId: "s1",
    approvalStatus: "pending",
    createdAt: "2026-10-06T00:00:00.000Z",
  });

  // No-regression controls: the directory listing already skipped anything
  // that is not a regular `*.json` entry before this change, so these two
  // cases pass on the base too. They pin that the converted by-path fallback
  // did not reintroduce a by-path read of such an entry.
  it("a FIFO named *.json is skipped within the bound and the regular report is listed", () => {
    const dir = path.join(tmp, "reports");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.json"), report);
    mkfifo(path.join(dir, "zz-fifo.json"));
    const run = callInChild(MOD, "listPersistedReports", [dir]);
    expectBounded(run);
    const listed = (run.value as { ok: Array<{ filePath: string; sessionId: string }> }).ok;
    expect(listed.map((r) => path.basename(r.filePath))).toEqual(["a.json"]);
  });

  it("a symlink to a FIFO named *.json is skipped within the bound", () => {
    const dir = path.join(tmp, "reports");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.json"), report);
    mkfifo(path.join(tmp, "target-fifo"));
    fs.symlinkSync(path.join(tmp, "target-fifo"), path.join(dir, "zz-link.json"));
    const run = callInChild(MOD, "listPersistedReports", [dir]);
    expectBounded(run);
    expect((run.value as { ok: unknown[] }).ok).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("transcript scan: a FIFO at the transcript path is unreadable at once", () => {
  const MOD = "cli/pack/transcript-report-scan.js";

  it("returns unreadable within the bound, without waiting out maxWaitMs", () => {
    const transcript = path.join(tmp, "transcript.jsonl");
    mkfifo(transcript);
    const run = callInChild(MOD, "scanTranscriptForReport", [
      { transcriptPath: transcript, sessionId: "s1", maxWaitMs: 4000, pollMs: 50 },
    ]);
    expectBounded(run);
    expect(run.ms).toBeLessThan(4000);
    expect((run.value as { ok: { found: boolean; reason: string } }).ok).toMatchObject({
      found: false,
      reason: "unreadable",
    });
  });

  it("a transcript with more unread bytes than the per-poll cap is unreadable at once, without a read", () => {
    const transcript = path.join(tmp, "huge.jsonl");
    sparseFile(transcript, 300 * 1024 * 1024, "{}\n");
    const run = callInChild(MOD, "scanTranscriptForReport", [
      { transcriptPath: transcript, sessionId: "s1", maxWaitMs: 4000, pollMs: 50 },
    ]);
    expectBounded(run);
    expect(run.ms).toBeLessThan(4000);
    expect((run.value as { ok: { found: boolean; reason: string } }).ok).toMatchObject({
      found: false,
      reason: "unreadable",
    });
  });

  it("a path that is not there is still a timeout, not unreadable (control)", () => {
    const run = callInChild(MOD, "scanTranscriptForReport", [
      { transcriptPath: path.join(tmp, "absent.jsonl"), sessionId: "s1", maxWaitMs: 100, pollMs: 50 },
    ]);
    expectBounded(run);
    expect((run.value as { ok: { reason: string } }).ok.reason).toBe("timeout");
  });
});

describe.skipIf(process.platform === "win32")("session-start readers: a FIFO is reported, never waited on", () => {
  it("OW-kit manifest.json: a FIFO is an error result; a missing file stays the silent {}", () => {
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(path.join(ws, ".ai", "workflow"), { recursive: true });
    const missing = callInChild("cli/session-start/toolchain-parity.js", "realReadOwKitVersion", [ws]);
    expectBounded(missing);
    expect(missing.value).toEqual({ ok: {} });

    mkfifo(path.join(ws, ".ai", "workflow", "manifest.json"));
    const run = callInChild("cli/session-start/toolchain-parity.js", "realReadOwKitVersion", [ws]);
    expectBounded(run);
    expect((run.value as { ok: { error: string } }).ok.error).toMatch(/cannot read .*not a regular file/);
  });

  it("Claude user registry: a FIFO is an error result; a missing file stays empty without an error", () => {
    const reg = path.join(tmp, ".claude.json");
    const missing = callInChild("io/claude-mcp.js", "readTopLevelMcpServers", [reg]);
    expectBounded(missing);
    expect(missing.value).toEqual({ ok: { servers: {}, error: null } });

    mkfifo(reg);
    const run = callInChild("io/claude-mcp.js", "readTopLevelMcpServers", [reg]);
    expectBounded(run);
    expect((run.value as { ok: { error: string } }).ok.error).toMatch(/cannot read .*not a regular file/);
  });

  // The two machine-state reads sit inside the producer itself; drive it with
  // every collector injected, a FIFO as this machine's own snapshot and as a
  // peer's.
  const PARITY_SCRIPT = `
const [, modPath, schemaPath, stateDir, ws] = process.argv;
const { Readable, Writable } = await import("node:stream");
const mod = await import(modPath);
const { parseManifest } = await import(schemaPath);
let err = "";
const stderr = new Writable({ write(c, _e, cb) { err += c; cb(); } });
const manifest = parseManifest({ version: 1, toolchain_parity: { enabled: true, machine_state_dir: stateDir, profile: "own", workspace_root: ws } });
const result = await mod.runSessionStartToolchainParity({
  stdin: Readable.from(["{}"]), stderr, manifest, session: "s1", now: new Date("2026-10-06T00:00:00Z"),
  runNodeVersion: async () => ({ ok: true, version: "v22.1.0" }),
  runNpmGlobals: async () => ({ ok: true, packages: {} }),
  readOwKitVersion: () => ({}), readMcpServerNames: () => ({ names: [] }),
  writeLedger: async () => ({ ok: true }),
});
process.stdout.write(JSON.stringify({ result, stderr: err }));
`;
  function runParity(stateDir: string): ChildRun {
    return runChild(PARITY_SCRIPT, [
      pathToFileURL(path.join(DIST, "cli/session-start/toolchain-parity.js")).href,
      pathToFileURL(path.join(DIST, "schema/index.js")).href,
      stateDir,
      tmp,
    ]);
  }

  it("a FIFO at a peer snapshot is noted as unreadable and skipped within the bound", () => {
    const state = path.join(tmp, "machine-state");
    fs.mkdirSync(state);
    mkfifo(path.join(state, "peer.json"));
    const run = runParity(state);
    expectBounded(run);
    const out = run.value as { stderr: string };
    expect(out.stderr).toMatch(/peer snapshot peer\.json unreadable: .*not a regular file/);
  });

  it("an oversized own snapshot file is noted by the collision check within the bound", () => {
    // Not a FIFO: the producer then WRITES its own snapshot to the same path
    // by name, and opening a FIFO for writing waits for a reader (a write,
    // not a read; see the change log). A sparse regular file exercises the
    // bounded collision-check read and survives the write that follows.
    const state = path.join(tmp, "machine-state");
    fs.mkdirSync(state);
    sparseFile(path.join(state, "own.json"), 2 * 1024 * 1024, "{}");
    const run = runParity(state);
    expectBounded(run);
    const out = run.value as { stderr: string };
    expect(out.stderr).toMatch(
      /could not check for a profile-name collision on own\.json: .*larger than the read cap/,
    );
  });
});
