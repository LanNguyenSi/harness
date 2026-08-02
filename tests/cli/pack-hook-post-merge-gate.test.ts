import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runPackHookPostMergeGateCli } from "../../src/cli/pack/hook-post-merge-gate.js";
import { runPackHookPostMergeGateRecordCli } from "../../src/cli/pack/hook-post-merge-gate-record.js";
import { MERGED_TAG_PREFIX } from "../../src/policy-packs/builtin/post-merge-gate-runtime.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function makeRepoFixture(name: string, branch: string, sha: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-hook-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  const refPath = path.join(repo, ".git", "refs", "heads", branch);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(refPath, `${sha}\n`);
  return repo;
}

function makeDetachedRepoFixture(name: string, sha: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-hook-detached-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `${sha}\n`);
  return repo;
}

function manifestWithPack(config: Record<string, unknown> = {}, enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "post-merge-gate", config, enabled }],
  });
}

function eventJson(
  over: Partial<{
    session_id: string;
    tool_name: string;
    cwd: string;
    tool_input: Record<string, unknown>;
  }> = {},
): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: over.session_id ?? "sess-1",
    tool_name: over.tool_name ?? "Bash",
    cwd: over.cwd ?? "/tmp",
    ...(over.tool_input !== undefined && { tool_input: over.tool_input }),
  });
}

function mergedEntry(repo: string, branch: string, sha: string, id = "1"): LedgerEntry {
  return {
    id,
    content: `${MERGED_TAG_PREFIX}:${repo}:${branch}:${sha} at:2026-07-23T00:00:00.000Z`,
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

const SHA_MERGED = "a".repeat(40);
const SHA_OTHER = "b".repeat(40);

// ---------------------------------------------------------------------------
// Self-lock table (03-decisions.md, re-pinned for task 19356be7): every
// command in the recovery vocabulary must ALWAYS pass as its own command,
// including when the ledger cannot be reached at all — the gate-eligibility
// classification runs BEFORE any manifest load or ledger query, and none of
// these verbs are curated mutations (verb disjointness). Innocent
// neighbours (the curated mutation list) must stay denied on the exact same
// fixture. Mirrors tests/cli/init-full-template-kill-switch-deny.test.ts's
// it.each pattern.
// ---------------------------------------------------------------------------

const ESCAPE_COMMANDS = [
  "git switch main",
  "git checkout main",
  "git pull --ff-only",
  "git fetch",
  "git branch -d feat/cool",
  "git branch -D feat/cool",
  "git stash list",
  "git stash show",
  "harness session-start branch-check",
  "npx harness pause",
  "/usr/local/bin/harness pause",
];

const CURATED_MUTATION_COMMANDS = [
  "git commit -am 'x'",
  "git add -A",
  "git push",
  "git merge main",
  "git rebase main",
  "git cherry-pick abc123",
  "git revert HEAD",
  "git reset --hard HEAD~1",
  "git stash pop",
  "git stash apply",
  "gh pr create",
  "gh pr merge",
];

describe("runPackHookPostMergeGateCli — escape self-lock table", () => {
  it.each(ESCAPE_COMMANDS)(
    "always allows escape command %s, even with a matching merged fact AND an unreachable ledger",
    async (cmd) => {
      const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
      let ledgerQueryCalls = 0;
      const result = await runPackHookPostMergeGateCli({
        stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: cmd } })),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: manifestWithPack(),
        ledgerQuery: async () => {
          ledgerQueryCalls += 1;
          return { degraded: "mcp connect refused" };
        },
      });
      expect(result.blocked).toBe(false);
      // The escape path never even reaches the ledger — pinned structurally,
      // not just by outcome (mirrors the kill-switch operator_only proof).
      expect(ledgerQueryCalls).toBe(0);
    },
  );

  it.each(ESCAPE_COMMANDS)(
    "allows escape command %s even when the manifest itself cannot be loaded",
    async (cmd) => {
      const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
      const result = await runPackHookPostMergeGateCli({
        stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: cmd } })),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        configPath: "/nonexistent/path/harness.yaml",
      });
      expect(result.blocked).toBe(false);
    },
  );

  it.each(CURATED_MUTATION_COMMANDS)(
    "innocent neighbour %s stays DENIED on the same fixture (escape must not over-match)",
    async (cmd) => {
      const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
      const { stream: out, output: outBuf } = captureStream();
      const result = await runPackHookPostMergeGateCli({
        stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: cmd } })),
        stdout: out,
        stderr: captureStream().stream,
        manifest: manifestWithPack(),
        ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
      });
      expect(result.blocked).toBe(true);
      expect(JSON.parse(outBuf()).decision).toBe("block");
    },
  );
});

// Task 19356be7: DENY WINS over the escape vocabulary — the REVERSAL of
// the original escape-first binding decision, itself now the binding
// decision, pinned by the only shape that can distinguish the two
// orderings: a command that is BOTH escape and curated at once. Under
// escape-first every one of these chains skipped the gate entirely
// (`harness preflight && git push origin master` is the documented normal
// workflow spelling, not an edge case). These pins are the task's
// MUTATION PROBE: re-adding an `isEscapeCommand(command)` short-circuit
// ahead of the deny classification turns them red.
describe("runPackHookPostMergeGateCli — deny-wins precedence (task 19356be7 pinned decision table)", () => {
  // The four measured lines from the task description, verbatim, plus the
  // reversed chain order and a `;` spelling. Expected decision per line
  // under the chosen variant (deny-wins): BLOCKED whenever the tip
  // matches the recorded merged fact.
  it.each([
    "git push origin master",
    "git switch master && git push origin master",
    "git stash list && git push origin master",
    "harness preflight && git push origin master",
    "git commit -am x && git switch main",
    "harness preflight; git push origin master",
  ])("blocks %s on a merged tip — a chained escape verb no longer exempts the mutation", async (cmd) => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const { stream: out, output: outBuf } = captureStream();
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: cmd } })),
      stdout: out,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(true);
    expect(JSON.parse(outBuf()).decision).toBe("block");
  });

  // The deny message's own recommended recovery chain must stay free, and
  // must stay free STRUCTURALLY — allowed before the ledger is ever
  // consulted, even when a merged fact exists and the ledger would be
  // reachable. Lockout would be worse than the gap.
  it.each([
    "git switch master && git pull --ff-only",
    "git switch master && git pull --ff-only && git branch -d feat/cool",
    "git fetch origin && git switch master",
  ])("the documented recovery chain %s stays free without any ledger query", async (cmd) => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    let ledgerQueryCalls = 0;
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: cmd } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => {
        ledgerQueryCalls += 1;
        return [mergedEntry("svc", "feat/cool", SHA_MERGED)];
      },
    });
    expect(result.blocked).toBe(false);
    expect(ledgerQueryCalls).toBe(0);
  });

  // Deadlock guard (decision D2): the understanding gate demands exactly
  // this heredoc shape, so a report BODY mentioning mutation verbs as
  // text must never make the approve call gate-eligible. The body below
  // hits both a `\n`-anchored deny verb and a `&&`-anchored one.
  it("allows `harness approve understanding` with a quoted-heredoc report body that mentions git push, without any ledger query", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    let ledgerQueryCalls = 0;
    const command = [
      "harness approve understanding <<'UNDERSTANDING_REPORT'",
      "## Understanding Report",
      "",
      "Verification:",
      "git push origin master",
      "&& git commit -m x",
      "UNDERSTANDING_REPORT",
    ].join("\n");
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => {
        ledgerQueryCalls += 1;
        return [mergedEntry("svc", "feat/cool", SHA_MERGED)];
      },
    });
    expect(result.blocked).toBe(false);
    expect(ledgerQueryCalls).toBe(0);
  });

  // The stderr note is the only signal in operator logs that deny-scope
  // beat a chained recovery verb; without it, post-incident triage cannot
  // tell "plain mutation blocked" from "chained escape overridden".
  // Mutation-confirmed as previously uncovered (disabling the branch left
  // the suite green).
  it("logs the deny-wins note only when recovery vocabulary was actually present", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const run = async (command: string): Promise<string> => {
      const { stream: err, output: errOut } = captureStream();
      await runPackHookPostMergeGateCli({
        stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command } })),
        stdout: captureStream().stream,
        stderr: err,
        manifest: manifestWithPack(),
        ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
      });
      return errOut();
    };
    expect(await run("harness preflight && git push origin master")).toContain(
      "deny-scope wins (task 19356be7)",
    );
    expect(await run("git push origin master")).not.toContain("deny-scope wins");
  });

  // The strip is harness-scoped: a quoted heredoc body handed to a shell
  // interpreter REALLY executes (bash ground truth, decision D2) and must
  // stay blocked, exactly as it is today.
  it("still blocks a quoted heredoc whose consumer executes the body: bash <<'EOF' ... git push ... EOF", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_input: { command: "bash <<'EOF'\ngit push origin master\nEOF" },
        }),
      ),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(true);
  });
});

describe("runPackHookPostMergeGateCli — allow paths", () => {
  it("allows when no merged fact matches the current tip", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows read-only git commands unconditionally (outside curated scope)", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git status" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows a non-Bash tool", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_name: "Write" })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows when the pack is enabled:false", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack({}, false),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows when the pack is not declared in the manifest at all", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: parseManifest({ version: 1 }),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });
});

describe("runPackHookPostMergeGateCli — deny path", () => {
  it("denies a curated mutation command when the tip matches, naming branch + default branch + escape commands", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const { stream: out, output: outBuf } = captureStream();
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: out,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toContain('branch "feat/cool"');
    expect(envelope.reason).toContain("git switch");
    expect(envelope.reason).toContain("git pull --ff-only");
    expect(envelope.reason).toContain("git branch -d feat/cool");
    // No remote in this fixture — default branch degrades to the placeholder.
    expect(envelope.reason).toContain("<default-branch>");
  });

  it("renders the agent-facing ux shape when config.ux is declared", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const UX = {
      cannot: "You cannot run ${TOOL_NAME} on branch ${BRANCH} yet — its current tip was already merged.",
      required: ["a branch tip that is not already merged"],
      run: ["git switch ${DEFAULT_BRANCH}", "git pull --ff-only", "git branch -d ${BRANCH}"],
    };
    const { stream: out, output: outBuf } = captureStream();
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: out,
      stderr: captureStream().stream,
      manifest: manifestWithPack({ ux: UX }),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).toContain("You cannot run Bash on branch feat/cool yet");
    expect(envelope.reason).toContain("git switch <default-branch>");
    expect(envelope.reason).not.toContain("post-merge-gate: refusing");
  });
});

describe("runPackHookPostMergeGateCli — edge cases (never deny)", () => {
  it("allows on a detached HEAD", async () => {
    const repo = makeDetachedRepoFixture("svc", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows outside a git work tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-hook-noGit-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: root, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows a repo with no remote (default-branch resolution unavailable, but no fact matches)", async () => {
    // makeRepoFixture never creates refs/remotes/origin/HEAD — this
    // fixture already models "no remote". Confirms the missing remote
    // does not itself cause a false deny.
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git push" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows when new commits moved the tip past the recorded merged sha", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_OTHER);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      // The recorded fact is for the OLD (pre-continuation) tip.
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });

  it("allows a recycled branch name whose tip differs from the recorded merged tip", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_OTHER);
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git push" } })),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [mergedEntry("svc", "feat/cool", SHA_MERGED)],
    });
    expect(result.blocked).toBe(false);
  });
});

describe("runPackHookPostMergeGateCli — fail-open posture", () => {
  it("allows (with a stderr warning) when the manifest cannot be loaded", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const { stream: err, output: errOut } = captureStream();
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: err,
      configPath: "/nonexistent/path/harness.yaml",
    });
    expect(result.blocked).toBe(false);
    expect(errOut()).toMatch(/manifest load failed/);
    expect(errOut()).toMatch(/fails open/);
  });

  it("allows (with a stderr warning) when the ledger is degraded", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA_MERGED);
    const { stream: err, output: errOut } = captureStream();
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_input: { command: "git commit -am x" } })),
      stdout: captureStream().stream,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => ({ degraded: "mcp connect refused" }),
    });
    expect(result.blocked).toBe(false);
    expect(errOut()).toMatch(/ledger degraded.*mcp connect refused/);
    expect(errOut()).toMatch(/fails open/);
  });

  it("allows on malformed event JSON", async () => {
    const result = await runPackHookPostMergeGateCli({
      stdin: streamFrom("{not json"),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
    });
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Squash-merge E2E (task AC): a real local bare repo + real git squash
// merge, driving the producer then the blocker against genuine git
// plumbing — not hand-typed .git/HEAD fixtures. Proves the whole
// tip-sha-match design against real git behaviour: `gh pr merge` (here,
// simulated by a SEPARATE integrator clone squash-merging and pushing)
// never touches the original checkout's local branch pointer.
// ---------------------------------------------------------------------------

function gitConfig(dir: string): void {
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

function gitRevParse(dir: string, ref = "HEAD"): string {
  return execFileSync("git", ["rev-parse", ref], { cwd: dir, encoding: "utf8" }).trim();
}

describe("squash-merge end-to-end (real git, local bare repo)", () => {
  it(
    "records the fact on merge, denies further mutation, and the recommended escape recovers to the default branch with no further deny",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-e2e-"));
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

      // 1. A local bare "origin".
      const bareDir = path.join(root, "origin.git");
      fs.mkdirSync(bareDir);
      execFileSync("git", ["init", "--bare", "-q", "-b", "main"], { cwd: bareDir });

      // 2. The agent's checkout: seed main, then cut + push a feature branch.
      const featDir = path.join(root, "feat-checkout");
      fs.mkdirSync(featDir);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: featDir });
      gitConfig(featDir);
      execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: featDir });
      fs.writeFileSync(path.join(featDir, "README.md"), "hello\n");
      gitCommitAll(featDir, "init");
      execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: featDir });

      execFileSync("git", ["checkout", "-q", "-b", "feat/thing"], { cwd: featDir });
      fs.writeFileSync(path.join(featDir, "feature.txt"), "feature work\n");
      gitCommitAll(featDir, "feature work");
      execFileSync("git", ["push", "-q", "-u", "origin", "feat/thing"], { cwd: featDir });
      const featTipSha = gitRevParse(featDir);

      // 3. Simulate `gh pr merge --squash`'s REMOTE-side effect via a
      // SEPARATE integrator clone: main gets a new squash commit. The
      // original featDir checkout above is left completely untouched —
      // exactly like a real `gh pr merge` API call.
      const integratorDir = path.join(root, "integrator");
      execFileSync("git", ["clone", "-q", bareDir, integratorDir]);
      gitConfig(integratorDir);
      execFileSync("git", ["fetch", "-q", "origin", "feat/thing"], { cwd: integratorDir });
      execFileSync("git", ["merge", "-q", "--squash", "origin/feat/thing"], { cwd: integratorDir });
      execFileSync("git", ["commit", "-q", "-m", "feature work (#1)"], { cwd: integratorDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: integratorDir });

      // featDir's own branch pointer is unchanged.
      expect(gitRevParse(featDir)).toBe(featTipSha);

      // 4. Producer: record the merged fact from featDir, right after the
      // (simulated) `gh pr merge --squash` succeeded.
      const ledgerEntries: LedgerEntry[] = [];
      let ledgerId = 0;
      const producerResult = await runPackHookPostMergeGateRecordCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PostToolUse",
            session_id: "sess-e2e",
            tool_name: "Bash",
            cwd: featDir,
            tool_input: { command: "gh pr merge --squash" },
            tool_output: { exit_code: 0, stdout: "Merged", stderr: "" },
          }),
        ),
        stderr: captureStream().stream,
        manifest: manifestWithPack(),
        writeLedger: async (args) => {
          ledgerId += 1;
          ledgerEntries.push({
            id: String(ledgerId),
            content: args.content,
            createdAt: new Date().toISOString(),
          });
          return { ok: true };
        },
      });
      expect(producerResult.wrote).toBe(true);
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0]?.content).toContain(
        `${MERGED_TAG_PREFIX}:feat-checkout:feat/thing:${featTipSha}`,
      );

      // 5. Blocker: still on feat/thing at featTipSha — a curated
      // mutation command must now DENY.
      const denyResult = await runPackHookPostMergeGateCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "sess-e2e",
            tool_name: "Bash",
            cwd: featDir,
            tool_input: { command: "git commit -am 'oops still on feat/thing'" },
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: manifestWithPack(),
        ledgerQuery: async () => ledgerEntries,
      });
      expect(denyResult.blocked).toBe(true);

      // 6. The escape command allows immediately, without needing the
      // ledger at all — then ACTUALLY run the recommended recovery for
      // real: switch to main and fast-forward pull.
      const escapeResult = await runPackHookPostMergeGateCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "sess-e2e",
            tool_name: "Bash",
            cwd: featDir,
            tool_input: { command: "git switch main" },
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: manifestWithPack(),
        ledgerQuery: async () => ledgerEntries,
      });
      expect(escapeResult.blocked).toBe(false);

      execFileSync("git", ["switch", "-q", "main"], { cwd: featDir });
      execFileSync("git", ["pull", "-q", "--ff-only"], { cwd: featDir });
      const newMainSha = gitRevParse(featDir);
      expect(newMainSha).not.toBe(featTipSha);

      // 7. Now on the default branch, at a tip that was never recorded
      // as merged: a curated mutation command is NOT denied — the
      // recovery loop closes with no further deny.
      const afterRecoveryResult = await runPackHookPostMergeGateCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "sess-e2e",
            tool_name: "Bash",
            cwd: featDir,
            tool_input: { command: "git commit --allow-empty -m 'new work on main'" },
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: manifestWithPack(),
        ledgerQuery: async () => ledgerEntries,
      });
      expect(afterRecoveryResult.blocked).toBe(false);
    },
    30_000,
  );
});
