import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EX_USAGE } from "../../../src/cli/exit-codes.js";
import { run } from "../../../src/cli/index.js";
import {
  runRecordDogfood,
  runRecordReview,
  runRecordReviewSubagent,
} from "../../../src/cli/record/index.js";

// Task 237cc609: the record verbs write their fact as space-separated tag
// text and the gates match tags by substring, so a flag value carrying
// whitespace or `<namespace>:` text would plant a second tag.

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function sink(): NodeJS.WritableStream {
  return new Writable({ write: (_c, _e, cb) => cb() });
}

function makeRepo(branch = "main"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-inj-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const ref = path.join(repo, ".git", "refs", "heads", ...branch.split("/"));
  fs.mkdirSync(path.dirname(ref), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(ref, "abcdef0123456789abcdef0123456789abcdef01\n");
  return repo;
}

type Verb = "review" | "review-subagent" | "dogfood";

/** Run a verb with overrides; returns the result and every ledger write. */
async function call(verb: Verb, over: Record<string, string | undefined>) {
  const writes: string[] = [];
  const base = {
    cwd: makeRepo("feature/x"),
    stderr: sink(),
    resolveSession: () => "sess-inj",
    writeLedger: async (a: { content: string }) => {
      writes.push(a.content);
      return { ok: true as const };
    },
  };
  let result;
  if (verb === "review") {
    result = await runRecordReview({ ...base, pr: "42", summary: "ok", ...over } as never);
  } else if (verb === "review-subagent") {
    result = await runRecordReviewSubagent({ ...base, task: "t1", verdict: "ok", ...over } as never);
  } else {
    result = await runRecordDogfood({ ...base, summary: "ok", ...over } as never);
  }
  return { result, writes };
}

const WHITESPACE_BRANCH = "x review-subagent:master";
const TAGGED_BRANCH = "xreview-subagent:master";
const TAG_FORMS = [
  "review:master",
  "review-subagent:master",
  "dogfood:abc",
  "preflight:repo",
  "risk-approved:x",
  "risk-override:x",
];

describe("--branch rejects whitespace and embedded tag text", () => {
  for (const verb of ["review", "review-subagent"] as const) {
    it(`${verb}: whitespace-separated injected tag`, async () => {
      const { result, writes } = await call(verb, { branch: WHITESPACE_BRANCH });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--branch");
      expect(result.reason).toContain("whitespace");
      expect(writes).toEqual([]);
    });
    it(`${verb}: tag text glued into the name (no whitespace)`, async () => {
      const { result, writes } = await call(verb, { branch: TAGGED_BRANCH });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--branch");
      expect(result.reason).toContain("ledger tag text");
      expect(writes).toEqual([]);
    });
    for (const tag of TAG_FORMS) {
      it(`${verb}: embedded ${tag}`, async () => {
        const { result, writes } = await call(verb, { branch: `feat/${tag}` });
        expect(result.exitCode).toBe(EX_USAGE);
        expect(result.reason).toContain("--branch");
        expect(writes).toEqual([]);
      });
    }
    for (const name of [
      "feature/x",
      "fix/237cc609-record-tag-injection",
      "release/1.2.3",
      "user/some_name-2.x",
      "main",
      "v1.0.0",
    ]) {
      it(`${verb}: still accepts ${name}`, async () => {
        const { result, writes } = await call(verb, { branch: name });
        expect(result).toMatchObject({ exitCode: 0, wrote: true, branch: name });
        expect(writes[0]).toContain(`${verb}:${name}`);
      });
    }
  }

  it("a branch resolved from git (no --branch) is accepted when ordinary", async () => {
    const { result } = await call("review", {});
    expect(result).toMatchObject({ exitCode: 0, branch: "feature/x" });
  });
});

describe("--task rejects whitespace and embedded tag text", () => {
  for (const verb of ["review", "review-subagent"] as const) {
    it(`${verb}: whitespace-separated injected tag`, async () => {
      const { result, writes } = await call(verb, { task: "t1 review-subagent:master" });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--task");
      expect(result.reason).toContain("whitespace");
      expect(writes).toEqual([]);
    });
    it(`${verb}: tag text glued into the id`, async () => {
      const { result, writes } = await call(verb, { task: "t1review-subagent:master" });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--task");
      expect(result.reason).toContain("ledger tag text");
      expect(writes).toEqual([]);
    });
    for (const tag of TAG_FORMS) {
      it(`${verb}: embedded ${tag}`, async () => {
        const { result } = await call(verb, { task: `t1-${tag}` });
        expect(result.exitCode).toBe(EX_USAGE);
        expect(result.reason).toContain("--task");
      });
    }
    it(`${verb}: still accepts a uuid-like id`, async () => {
      const { result } = await call(verb, { task: "237cc609-1234-4abc-8def-0123456789ab" });
      expect(result).toMatchObject({ exitCode: 0, wrote: true });
    });
  }
});

describe("--pr rejects whitespace and embedded tag text", () => {
  it("whitespace-separated injected tag", async () => {
    const { result, writes } = await call("review", { pr: "42 review-subagent:master" });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("--pr");
    expect(writes).toEqual([]);
  });
  it("glued tag text", async () => {
    const { result } = await call("review", { pr: "42dogfood:abc" });
    expect(result.exitCode).toBe(EX_USAGE);
    expect(result.reason).toContain("--pr");
  });
});

describe("--verdict and summaries stay free text but reject tag tokens", () => {
  it("review-subagent --verdict with a tag token is rejected", async () => {
    const { result, writes } = await call("review-subagent", { verdict: "ok review-subagent:master" });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("--verdict");
    expect(writes).toEqual([]);
  });
  it("review-subagent --verdict with a glued tag token is rejected", async () => {
    const { result } = await call("review-subagent", { verdict: "okreview:master" });
    expect(result.exitCode).toBe(EX_USAGE);
    expect(result.reason).toContain("--verdict");
  });
  it("review-subagent optional summary with a tag token is rejected", async () => {
    const { result, writes } = await call("review-subagent", { summary: "see review-subagent:master" });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("summary");
    expect(writes).toEqual([]);
  });
  it("review summary with a tag token is rejected", async () => {
    const { result, writes } = await call("review", { summary: "fine review-subagent:master" });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("summary");
    expect(writes).toEqual([]);
  });
  it("dogfood summary with a tag token is rejected", async () => {
    const { result, writes } = await call("dogfood", { summary: "smoke dogfood:other-session" });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("summary");
    expect(writes).toEqual([]);
  });
  it("ordinary free text with spaces, colons and dashes is kept verbatim", async () => {
    const verdict = "approved: two nits (non-blocking) - see the review of foo";
    const { result, writes } = await call("review-subagent", { verdict, summary: "note: checked edges" });
    expect(result).toMatchObject({ exitCode: 0, wrote: true });
    expect(writes[0]).toContain(`verdict:${verdict} ${String.fromCharCode(0x2014)} note: checked edges`);
    const r = await call("review", { summary: "reviewed: all good, no review needed" });
    expect(r.result.exitCode).toBe(0);
  });
});

describe("CLI wiring exits 64 naming the flag", () => {
  async function exec(argv: string[]) {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    try {
      const code = await run({ argv, stdout: () => {}, stderr: () => {} });
      return { code, stderr: chunks.join("") };
    } finally {
      spy.mockRestore();
    }
  }

  it("record review-subagent --branch with an injected tag", async () => {
    const r = await exec(["record", "review-subagent", "--task", "t1", "--verdict", "ok", "--branch", WHITESPACE_BRANCH]);
    expect(r.code).toBe(EX_USAGE);
    expect(r.stderr).toContain("--branch");
  });
  it("record review summary with an injected tag", async () => {
    const r = await exec(["record", "review", "ok review-subagent:master", "--pr", "1", "--branch", "feature/x"]);
    expect(r.code).toBe(EX_USAGE);
    expect(r.stderr).toContain("summary");
  });
});
