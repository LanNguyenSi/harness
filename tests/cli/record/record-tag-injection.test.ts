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
import { addGitDirSkeleton } from "../../_helpers/git-dir-fixture.js";

// Task 237cc609: the record verbs write their fact as space-separated tag
// text and the gates match tags by substring, so a flag value carrying
// whitespace or `<namespace>:` text would plant a second tag. Ref-like and
// id-like values (--branch, --base, --task, --pr, dogfood --session) are
// refused on any ':' or ASCII whitespace; free text is refused only for a
// recognised `<namespace>:` glued to a following non-whitespace character.

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
  addGitDirSkeleton(path.join(repo, ".git"));
  fs.writeFileSync(ref, "abcdef0123456789abcdef0123456789abcdef01\n");
  return repo;
}

/** A repo whose HEAD file is written directly, so the branch name need not be a valid ref. */
function makeRepoWithHeadBranch(branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-inj-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  addGitDirSkeleton(path.join(repo, ".git"));
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
const NBSP = String.fromCharCode(0xa0);
const ASCII_WHITESPACE: Array<[string, string]> = [
  ["tab", "\t"],
  ["carriage return", "\r"],
  ["line feed", "\n"],
  ["vertical tab", "\v"],
  ["form feed", "\f"],
];
const CUSTOM_TAGS = ["clean-check:master", "xclean-check:master", "feat/deploy-ready:prod"];
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
    for (const [label, ws] of ASCII_WHITESPACE) {
      it(`${verb}: ${label} inside the name`, async () => {
        const { result, writes } = await call(verb, { branch: `feat${ws}x` });
        expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
        expect(result.reason).toContain("--branch");
        expect(result.reason).toContain("whitespace");
        expect(writes).toEqual([]);
      });
    }
    it(`${verb}: tag text glued into the name (no whitespace)`, async () => {
      const { result, writes } = await call(verb, { branch: TAGGED_BRANCH });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--branch");
      expect(result.reason).toContain("':'");
      expect(writes).toEqual([]);
    });
    for (const injected of CUSTOM_TAGS) {
      it(`${verb}: custom namespace ${injected}`, async () => {
        const { result, writes } = await call(verb, { branch: injected });
        expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
        expect(result.reason).toContain("--branch");
        expect(writes).toEqual([]);
      });
    }
    it(`${verb}: a bare ':' is refused`, async () => {
      const { result } = await call(verb, { branch: "a:b" });
      expect(result.exitCode).toBe(EX_USAGE);
      expect(result.reason).toContain("--branch");
      expect(result.reason).toContain("':'");
    });
    it(`${verb}: Unicode whitespace without ':' stays accepted`, async () => {
      const name = `feat${NBSP}x`;
      const { result, writes } = await call(verb, { branch: name });
      expect(result).toMatchObject({ exitCode: 0, wrote: true, branch: name });
      expect(writes[0]).toContain(`${verb}:${name}`);
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

  for (const verb of ["review", "review-subagent"] as const) {
    for (const head of ["feat x", "x review-subagent:master", "xreview-subagent:master", "a:b"]) {
      it(`${verb}: a branch resolved from git (no --branch) is refused: ${JSON.stringify(head)}`, async () => {
        const { result, writes } = await call(verb, { cwd: makeRepoWithHeadBranch(head) });
        expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
        expect(result.reason).toContain("--branch");
        expect(writes).toEqual([]);
      });
    }
    it(`${verb}: a git-resolved branch with Unicode whitespace and no ':' stays accepted`, async () => {
      const { result } = await call(verb, { cwd: makeRepoWithHeadBranch(`feat${NBSP}x`) });
      expect(result).toMatchObject({ exitCode: 0, wrote: true });
    });
  }
});

describe("--base rejects ':' and whitespace", () => {
  const bad: Array<[string, string]> = [
    ["whitespace-separated injected tag", "x review-subagent:master"],
    ["tab-separated injected tag", "x\tdogfood:sess"],
    ["glued tag text", "xreview-subagent:master"],
    ["embedded tag text", "origin/review:master"],
    ["custom namespace", "clean-check:master"],
    ["plain whitespace", "ma ster"],
  ];
  for (const [label, base] of bad) {
    it(`record review: ${label}`, async () => {
      const { result, writes } = await call("review", { base });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--base");
      expect(writes).toEqual([]);
    });
  }
  // No --base flag: the base comes from refs/remotes/origin/HEAD, and that
  // resolved value is checked the same way as the flag.
  for (const target of ["x review-subagent:master", "a:b", "ma ster"]) {
    it(`record review: a base resolved from origin/HEAD (no --base) is refused: ${JSON.stringify(target)}`, async () => {
      const repo = makeRepo("feature/x");
      const originDir = path.join(repo, ".git", "refs", "remotes", "origin");
      fs.mkdirSync(originDir, { recursive: true });
      fs.writeFileSync(path.join(originDir, "HEAD"), `ref: refs/remotes/origin/${target}\n`);
      const { result, writes } = await call("review", { cwd: repo });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--base");
      expect(writes).toEqual([]);
    });
  }
  it("record review: an ordinary base resolved from origin/HEAD is accepted", async () => {
    const repo = makeRepo("feature/x");
    const originDir = path.join(repo, ".git", "refs", "remotes", "origin");
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, "HEAD"), "ref: refs/remotes/origin/main\n");
    const { result, writes } = await call("review", { cwd: repo });
    expect(result).toMatchObject({ exitCode: 0, wrote: true });
    expect(writes[0]).toContain("review:main");
  });
  for (const base of ["main", "origin/main", "release/1.2.3", "user/some_name-2.x"]) {
    it(`record review: still accepts ${base}`, async () => {
      const { result, writes } = await call("review", { base });
      expect(result).toMatchObject({ exitCode: 0, wrote: true });
      expect(writes[0]).toContain(`review:${base}`);
    });
  }
});

describe("dogfood --session rejects ':' and whitespace", () => {
  for (const session of ["s1 review-subagent:master", "s1review-subagent:master", "sess:other", "a b"]) {
    it(`refuses ${JSON.stringify(session)}`, async () => {
      const { result, writes } = await call("dogfood", { resolveSession: (() => session) as never });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--session");
      expect(writes).toEqual([]);
    });
  }
  for (const session of [" s1", "s1 ", "\ts1", "s1\n"]) {
    it(`refuses a padded session ${JSON.stringify(session)} instead of splitting content and target`, async () => {
      const { result, writes } = await call("dogfood", { resolveSession: (() => session) as never });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--session");
      expect(result.reason).toContain("leading or trailing whitespace");
      expect(writes).toEqual([]);
    });
  }
  it("still accepts a uuid session", async () => {
    const id = "0b6a1c1e-5d2f-4c1a-9a55-0123456789ab";
    const { result, writes } = await call("dogfood", { resolveSession: (() => id) as never });
    expect(result).toMatchObject({ exitCode: 0, wrote: true });
    expect(writes[0]).toContain(`dogfood:${id}`);
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
    it(`${verb}: tab inside the id`, async () => {
      const { result, writes } = await call(verb, { task: "t1\tx" });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--task");
      expect(writes).toEqual([]);
    });
    it(`${verb}: tag text glued into the id`, async () => {
      const { result, writes } = await call(verb, { task: "t1review-subagent:master" });
      expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
      expect(result.reason).toContain("--task");
      expect(result.reason).toContain("':'");
      expect(writes).toEqual([]);
    });
    it(`${verb}: custom namespace in the id`, async () => {
      const { result } = await call(verb, { task: "clean-check:master" });
      expect(result.exitCode).toBe(EX_USAGE);
      expect(result.reason).toContain("--task");
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
  for (const ns of ["review-subagent", "review", "dogfood", "preflight", "risk-approved", "risk-override"]) {
    for (const [verb, key] of [
      ["review-subagent", "verdict"],
      ["review-subagent", "summary"],
      ["review", "summary"],
      ["dogfood", "summary"],
    ] as const) {
      it(`${verb} ${key}: ${ns}:<value> is rejected, spaced and glued`, async () => {
        for (const text of [`ok ${ns}:master`, `ok${ns}:master`]) {
          const { result, writes } = await call(verb, { [key]: text });
          expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
          expect(writes).toEqual([]);
        }
      });
    }
  }
  for (const [verb, over] of [
    ["review-subagent", { verdict: "code-review: approved" }],
    ["review-subagent", { summary: "Self-review: LGTM" }],
    ["review", { summary: "review: looks fine" }],
    ["review", { summary: "preflight: green" }],
    ["dogfood", { summary: "preflight: green, dogfood: passed" }],
  ] as const) {
    it(`prose with a space after the colon is accepted: ${verb} ${JSON.stringify(over)}`, async () => {
      const { result } = await call(verb, over);
      expect(result).toMatchObject({ exitCode: 0, wrote: true });
    });
  }
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
  it("record review --base with an injected tag", async () => {
    const r = await exec(["record", "review", "ok", "--pr", "1", "--branch", "feature/x", "--base", "x review-subagent:master"]);
    expect(r.code).toBe(EX_USAGE);
    expect(r.stderr).toContain("--base");
  });
  it("record review summary with an injected tag", async () => {
    const r = await exec(["record", "review", "ok review-subagent:master", "--pr", "1", "--branch", "feature/x"]);
    expect(r.code).toBe(EX_USAGE);
    expect(r.stderr).toContain("summary");
  });
});
