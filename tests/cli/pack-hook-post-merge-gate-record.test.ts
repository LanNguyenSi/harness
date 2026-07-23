import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runPackHookPostMergeGateRecordCli } from "../../src/cli/pack/hook-post-merge-gate-record.js";
import { MERGED_TAG_PREFIX } from "../../src/policy-packs/builtin/post-merge-gate-runtime.js";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-record-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  const refPath = path.join(repo, ".git", "refs", "heads", branch);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(refPath, `${sha}\n`);
  return repo;
}

const SHA = "a".repeat(40);

function eventJson(
  over: Partial<{
    session_id: string;
    tool_name: string;
    cwd: string;
    tool_input: Record<string, unknown>;
    tool_output: unknown;
    tool_response: unknown;
  }> = {},
): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: over.session_id ?? "sess-1",
    tool_name: over.tool_name ?? "Bash",
    cwd: over.cwd ?? "/tmp",
    tool_input: over.tool_input ?? { command: "gh pr merge" },
    ...(over.tool_output !== undefined && { tool_output: over.tool_output }),
    ...(over.tool_response !== undefined && { tool_response: over.tool_response }),
  });
}

/**
 * A real 2.1.218-shaped Contract-B response for the given gh success
 * sentence. Text lands on `stderr` — `gh`'s success line goes through its
 * `infof` helper, which writes to STDERR, not stdout (verified against
 * gh v2.94.0 pkg/cmd/pr/merge/merge.go:369-376). `stdout` stays empty, the
 * realistic shape for a `gh pr merge` Bash result.
 */
function ghSuccessResponse(sentence: string): Record<string, unknown> {
  return { stdout: "", stderr: `✓ ${sentence}\n`, interrupted: false, isImage: false, noOutputExpected: false };
}

function manifestNoPolicyPacks(): Manifest {
  return parseManifest({ version: 1 });
}

// ---------------------------------------------------------------------------
// Golden fixture — drift guard against the real 2.1.218 payload shape.
// Captured live via `claude -p --settings` with a dump-hook (19/19
// PostToolUse events fired, all `tool_response`-shaped, 0 `tool_output`).
// If a future Claude Code version renames a field this hook depends on,
// this test's key assertions fail loud instead of the producer silently
// degrading to a permanent no-op.
// ---------------------------------------------------------------------------

describe("golden fixture — drift guard against the real 2.1.218 payload", () => {
  const fixturePath = path.join(
    __dirname,
    "..",
    "fixtures",
    "post-merge-gate",
    "real-posttooluse-payload-2.1.218.json",
  );
  const REQUIRED_TOP_LEVEL_KEYS = ["session_id", "cwd", "tool_name", "tool_input", "tool_response"];
  const REQUIRED_TOOL_RESPONSE_KEYS = ["stdout", "stderr", "interrupted"];

  it("the real payload carries every field the hook depends on", () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    for (const key of REQUIRED_TOP_LEVEL_KEYS) {
      expect(raw, `missing top-level key ${key}`).toHaveProperty(key);
    }
    expect(raw).not.toHaveProperty("tool_output");
    const toolResponse = raw["tool_response"] as Record<string, unknown>;
    for (const key of REQUIRED_TOOL_RESPONSE_KEYS) {
      expect(toolResponse, `missing tool_response key ${key}`).toHaveProperty(key);
    }
    expect(toolResponse["interrupted"]).toBe(false);
  });

  it("the real payload, replayed verbatim, is a benign no-op (its command is not gh pr merge)", async () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(JSON.stringify(raw)),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/did not match gh pr merge/);
  });

  it("the real payload's OWN shape, with a REAL gh success sentence appended to stderr, DOES confirm via Contract B", async () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let written: { content: string } | undefined;
    const replayed = {
      ...raw,
      cwd: repo,
      tool_input: { command: "gh pr merge", description: "Merge PR" },
      tool_response: {
        ...(raw["tool_response"] as Record<string, unknown>),
        stdout: "",
        // gh's success line goes through `infof` — its stderr channel
        // (gh v2.94.0 pkg/cmd/pr/merge/merge.go:369-376) — with the repo
        // fullname glued to `#<n>`.
        stderr: "✓ Squashed and merged pull request LanNguyenSi/agent-memory#99 (Add feature)",
      },
    };
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(JSON.stringify(replayed)),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(written?.content).toContain(`${MERGED_TAG_PREFIX}:svc:feat/cool:${SHA}`);
    expect(written?.content).toContain("pr:99");
  });
});

describe("runPackHookPostMergeGateRecordCli — Contract A: writes on confirmed exit_code success", () => {
  it("writes the merged fact when exit_code is exactly 0", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const { stream: err } = captureStream();
    let written: { sessionId: string; content: string; source: string } | undefined;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 0, stdout: "merged", stderr: "" } })),
      stderr: err,
      manifest: manifestNoPolicyPacks(),
      now: new Date("2026-07-23T00:00:00.000Z"),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(written).toBeDefined();
    expect(written?.content).toContain(`${MERGED_TAG_PREFIX}:svc:feat/cool:${SHA}`);
    expect(written?.content).toContain("at:2026-07-23T00:00:00.000Z");
    expect(written?.sessionId).toBe("sess-1");
  });

  it("extracts the PR number when present in the command", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let written: { content: string } | undefined;
    await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_input: { command: "gh pr merge --squash 42" },
          tool_output: { exit_code: 0 },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(written?.content).toContain("pr:42");
  });
});

// ---------------------------------------------------------------------------
// Contract B (payload-reality follow-up, 2026-07): live verification against
// a real Claude Code 2.1.218 install found the PostToolUse Bash payload
// carries NO `tool_output` field at all — only `tool_response`, shaped
// `{ stdout, stderr, interrupted, isImage, noOutputExpected }` (see
// tests/fixtures/post-merge-gate/real-posttooluse-payload-2.1.218.json for
// the verbatim capture). These tests drive the full CLI (not just the
// runtime unit) against gh's REAL success-sentence shape, verified against
// the installed gh v2.94.0 (pkg/cmd/pr/merge/merge.go:369-376): the repo
// fullname sits between "pull request" and the PR number, glued to `#`
// with no space (`owner/repo#<n>`, not `#<n>`), and the sentence itself
// goes through `infof` — gh's STDERR channel.
// ---------------------------------------------------------------------------

describe("runPackHookPostMergeGateRecordCli — Contract B: writes on a confirmed gh success sentence (2.1.218 reality)", () => {
  it.each([
    ["Squashed and merged", "Squashed and merged pull request LanNguyenSi/agent-memory#99 (Add feature)"],
    ["Rebased and merged", "Rebased and merged pull request LanNguyenSi/agent-memory#99 (Add feature)"],
    ["Merged", "Merged pull request LanNguyenSi/agent-memory#99 (Add feature)"],
  ])(
    "writes the merged fact for the REAL %s success sentence (owner/repo#n), with the correct repo:branch:sha + pr",
    async (_label, sentence) => {
      const repo = makeRepoFixture("svc", "feat/cool", SHA);
      let written: { sessionId: string; content: string; source: string } | undefined;
      const result = await runPackHookPostMergeGateRecordCli({
        stdin: streamFrom(
          eventJson({
            cwd: repo,
            tool_input: { command: "gh pr merge" },
            tool_response: ghSuccessResponse(sentence),
          }),
        ),
        stderr: captureStream().stream,
        manifest: manifestNoPolicyPacks(),
        now: new Date("2026-07-23T00:00:00.000Z"),
        writeLedger: async (args) => {
          written = args;
          return { ok: true };
        },
      });
      expect(result.wrote).toBe(true);
      expect(written?.content).toContain(`${MERGED_TAG_PREFIX}:svc:feat/cool:${SHA}`);
      // No PR number in the command itself — falls back to the success
      // sentence's own capture.
      expect(written?.content).toContain("pr:99");
      expect(written?.content).toContain("at:2026-07-23T00:00:00.000Z");
    },
  );

  // Doc-shape / future-gh-version tolerance (bare `#<n>`, no fullname) —
  // NOT gh's actual current wording, kept as a second parametrized
  // variant since the matcher accepts it defensively at no extra
  // matching-surface cost (see GH_MERGE_SUCCESS_RE's doc comment).
  it.each([
    ["Squashed and merged", "Squashed and merged pull request #99 (Add feature)"],
    ["Rebased and merged", "Rebased and merged pull request #99 (Add feature)"],
    ["Merged", "Merged pull request #99 (Add feature)"],
  ])(
    "also writes the merged fact for the doc-shape %s success sentence (bare #n, no fullname)",
    async (_label, sentence) => {
      const repo = makeRepoFixture("svc", "feat/cool", SHA);
      let written: { content: string } | undefined;
      const result = await runPackHookPostMergeGateRecordCli({
        stdin: streamFrom(
          eventJson({
            cwd: repo,
            tool_input: { command: "gh pr merge" },
            tool_response: ghSuccessResponse(sentence),
          }),
        ),
        stderr: captureStream().stream,
        manifest: manifestNoPolicyPacks(),
        writeLedger: async (args) => {
          written = args;
          return { ok: true };
        },
      });
      expect(result.wrote).toBe(true);
      expect(written?.content).toContain(`${MERGED_TAG_PREFIX}:svc:feat/cool:${SHA}`);
      expect(written?.content).toContain("pr:99");
    },
  );

  it("prefers the PR number from the command over the success-sentence capture", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let written: { content: string } | undefined;
    await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_input: { command: "gh pr merge 7" },
          tool_response: ghSuccessResponse("Merged pull request LanNguyenSi/agent-memory#99 (Add feature)"),
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(written?.content).toContain("pr:7");
    expect(written?.content).not.toContain("pr:99");
  });
});

describe("runPackHookPostMergeGateRecordCli — Contract B: no fact on any non-confirming tool_response", () => {
  it.each([
    // REAL wordings, verified against the installed gh v2.94.0 (same
    // source file as the success sentence).
    [
      "gh --auto pending text (real wording)",
      "✓ Pull request owner/repo#99 will be automatically merged via squash when all requirements are met\n",
    ],
    ["already-merged warning (real wording, warnf/! icon)", "! Pull request owner/repo#99 was already merged\n"],
    // Broader negative-class checks (not gh's exact current CLI wording,
    // but the same reversed-word-order / no-past-tense-verb class).
    ["already-merged GraphQL error shape", "GraphQL: Pull request Foo/Bar#99 is already merged (mergePullRequest)\n"],
    ["not-mergeable error text", "X Pull request #99 is not mergeable: the merge commit could not be cleanly created.\n"],
    ["empty output", ""],
  ])("writes nothing for %s", async (_label, text) => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_response: { stdout: "", stderr: text, interrupted: false, isImage: false, noOutputExpected: false },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when interrupted is true, even with an otherwise-matching success sentence", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_response: {
            stdout: "",
            stderr: "✓ Merged pull request owner/repo#99 (Add feature)\n",
            interrupted: true,
            isImage: false,
            noOutputExpected: false,
          },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when both stdout and stderr are empty", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });
});

// Binding ordering decision (coordinator follow-up): Contract A wins
// whenever it resolves to ANY definite verdict. Pinned at the full-CLI
// level (the runtime unit test pins the same decision at
// resolveMergeConfirmation() in isolation).
describe("runPackHookPostMergeGateRecordCli — both contracts present: Contract A wins", () => {
  it("exit_code 0 AND a matching gh success text: writes using Contract A's PR resolution (command-only, no text fallback)", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let written: { content: string } | undefined;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_input: { command: "gh pr merge" }, // no PR number in the command
          tool_output: { exit_code: 0 },
          tool_response: ghSuccessResponse("Merged pull request LanNguyenSi/agent-memory#99 (Add feature)"),
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    // Contract A's own (unchanged) PR resolution is command-only — the
    // Contract-B text-fallback must NOT leak into an exit_code-confirmed
    // write, even though tool_response is also present and matching.
    expect(written?.content).not.toContain("pr:99");
    expect(written?.content).toContain(`${MERGED_TAG_PREFIX}:svc:feat/cool:${SHA}`);
  });

  it("non-zero exit_code AND a matching gh success text: writes nothing (Contract A's failure wins)", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_output: { exit_code: 1 },
          tool_response: ghSuccessResponse("Merged pull request LanNguyenSi/agent-memory#99 (Add feature)"),
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/Contract A reports failure; Contract B not consulted/);
  });
});

describe("runPackHookPostMergeGateRecordCli — no fact on anything but confirmed success", () => {
  it("writes nothing when exit_code is non-zero", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 1, stderr: "conflict" } })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/not a confirmed merge success/);
    expect(result.diagnostic).toMatch(/Contract A reports failure; Contract B not consulted/);
  });

  it("writes nothing when tool_output has an unexpected/unknown shape and no tool_response is present", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_output: { exitCode: 0 /* wrong key name */ } }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(
      /no confirming tool_output\.exit_code \(Contract A\) and no matching gh merge success text in tool_response \(Contract B\)/,
    );
  });

  // A tool_response that carries an exit_code-shaped sibling field (as if
  // someone hand-crafted a hybrid payload) is NOT a Contract-B shape: the
  // matcher only ever reads stdout/stderr/interrupted from tool_response,
  // never an exit_code key inside it. Without a real `interrupted: false`
  // field and a matching gh success sentence, it must still write nothing.
  it("writes nothing when tool_response carries an exit_code-shaped sibling field instead of the real Contract-B shape", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_response: { exit_code: 0, stdout: "Merged", stderr: "" },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when tool_output is entirely absent", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-1",
        tool_name: "Bash",
        cwd: repo,
        tool_input: { command: "gh pr merge" },
      })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when the command did not match gh pr merge", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_input: { command: "gh pr create" }, tool_output: { exit_code: 0 } }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when the tool is not Bash", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_name: "Write", tool_output: { exit_code: 0 } }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when malformed event JSON is piped", async () => {
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom("{not json"),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when the git context is unresolvable (outside a git work tree)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-record-noGit-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: root, tool_output: { exit_code: 0 } })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/cannot resolve git context/);
  });

  it("writes nothing when no session id is resolvable", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const savedEnv = process.env.CLAUDE_SESSION_ID;
    const savedCodeEnv = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnv;
      if (savedCodeEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = savedCodeEnv;
    });
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: repo,
        tool_input: { command: "gh pr merge" },
        tool_output: { exit_code: 0 },
      })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/no session_id resolvable/);
  });

  it("writes nothing (fails open, no throw) when the manifest fails to load", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 0 } })),
      stderr: captureStream().stream,
      configPath: "/nonexistent/path/harness.yaml",
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.diagnostic).toMatch(/manifest load failed/);
  });

  it("writes nothing (no throw) when the ledger write fails", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 0 } })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => ({ ok: false, reason: "mcp connect refused" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.diagnostic).toMatch(/mcp connect refused/);
  });
});
