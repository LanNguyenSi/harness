import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { OPAQUE_TARGET_REASON, type LedgerClient, type PolicyDecision } from "../../src/runtime/intercept.js";
import { parseManifest, type Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Task 7d4abf84: a command that names a nested repository through any
// directory-changing shape is attributed to that repository or fails
// closed; no shape falls back to the working directory's evidence alone.
// Every shape the task names runs through `runInterceptCli` with the real
// FULL_TEMPLATE triggers of the four per-repo policies, from an outer
// repository with nested repositories under `vendor/`, under `block` and
// under `warn`. Two-sided pins at the end keep the forms that run in the
// working directory cwd-only.

const PER_REPO_POLICIES = [
  "preflight-before-investigation",
  "preflight-before-push",
  "review-before-merge-bash",
  "review-subagent-before-pr-create-bash",
] as const;
type PolicyName = (typeof PER_REPO_POLICIES)[number];

function templatePolicies(enforcement: "block" | "warn"): Policy[] {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  return PER_REPO_POLICIES.map((name) => {
    const policy = parsed.policies.find((p) => p.name === name);
    if (policy === undefined) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
    return { ...policy, enforcement } as Policy;
  });
}

const POLICIES = { block: templatePolicies("block"), warn: templatePolicies("warn") };

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

function ledgerWith(tags: readonly string[]): LedgerClient {
  const entries = tags.map((tag, i) => ({
    id: `e${i}`,
    content: `${tag} - evidence`,
    createdAt: new Date().toISOString(),
  }));
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

// Nested repository name -> its branch. Branch names are distinct and none
// is a prefix of another, because a ledger entry satisfies a tag it merely
// contains.
const NESTED: Record<string, string> = {
  libplain: "br01",
  libok: "br02",
  "lib sp": "br03",
  "lib;semi": "br04",
  "lib|pipe": "br05",
  "lib&&amp": "br06",
  "lib(paren": "br07",
  "lib\nnl": "br08",
  "lib`x`y": "br09",
  "lib;`x`y": "br10",
};
const OUTER_NAME = "outer-repo";
const OUTER_BRANCH = "main";

/** The ledger tag a policy demands for a repository (name, branch). */
function tagFor(policy: PolicyName, repo: string, branch: string): string {
  switch (policy) {
    case "preflight-before-investigation":
      return `preflight:${repo}`;
    case "preflight-before-push":
      return `preflight:${branch}`;
    case "review-before-merge-bash":
      return `review:${branch}`;
    case "review-subagent-before-pr-create-bash":
      return `review-subagent:${branch}`;
  }
}

function outerTag(policy: PolicyName): string {
  return tagFor(policy, OUTER_NAME, OUTER_BRANCH);
}

function nestedTag(policy: PolicyName, name: string): string {
  return tagFor(policy, name, NESTED[name]!);
}

function tagsOfRepos(repos: Array<[string, string]>): string[] {
  return repos.flatMap(([repo, branch]) => PER_REPO_POLICIES.map((p) => tagFor(p, repo, branch)));
}

const OUTER_ONLY = tagsOfRepos([[OUTER_NAME, OUTER_BRANCH]]);
const EVERY_TAG = tagsOfRepos([[OUTER_NAME, OUTER_BRANCH], ...Object.entries(NESTED), ["side", "brside"]]);

let root = "";
let outer = "";

function makeRepo(dir: string, branch: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-7d4abf84-")));
  outer = path.join(root, OUTER_NAME);
  makeRepo(outer, OUTER_BRANCH);
  for (const [name, branch] of Object.entries(NESTED)) makeRepo(path.join(outer, "vendor", name), branch);
  // A repository outside the outer one, reached through a symlink below it.
  makeRepo(path.join(root, "side"), "brside");
  fs.mkdirSync(path.join(root, "side", "deep"), { recursive: true });
  fs.symlinkSync(path.join(root, "side", "deep"), path.join(outer, "vendor", "sidelink"));
});

afterAll(() => {
  if (root.length > 0) fs.rmSync(root, { recursive: true, force: true });
});

async function run(command: string, tags: readonly string[], enforcement: "block" | "warn" = "block") {
  return runAt(outer, command, tags, enforcement);
}

async function runAt(cwd: string, command: string, tags: readonly string[], enforcement: "block" | "warn" = "block") {
  return runInterceptCli({
    stdin: Readable.from([
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        session_id: "sess-7d4abf84",
        cwd,
      }),
    ]),
    stdout: sink(),
    stderr: sink(),
    manifest: makeManifest({ policies: POLICIES[enforcement] }),
    ledger: ledgerWith(tags),
  });
}

function decisionsOf(decisions: readonly PolicyDecision[], policy: PolicyName): PolicyDecision[] {
  return decisions.filter((d) => d.policyName === policy);
}

function isFailClosed(d: PolicyDecision): boolean {
  return d.reason === OPAQUE_TARGET_REASON;
}

type Expect =
  | { kind: "attr"; name: string; alsoDemands?: string[] }
  | { kind: "fail-closed" }
  | { kind: "cwd" };

interface Shape {
  label: string;
  /** The command for one gated verb (`git log`, `git push`, `gh pr merge 1`, ...). */
  command: (verb: string) => string;
  expect: Expect;
}

const P = "vendor/libplain";
const T = "'vendor/lib`x`y'";
const abs = (rel: string): string => path.join(outer, rel);

/** `git <verb>` shapes written with the verb after the git global options. */
const gitVerb = (opts: string) => (verb: string) => `git ${opts} ${verb.slice(4)}`;

const attr = (name: string, alsoDemands?: string[]): Expect =>
  alsoDemands === undefined ? { kind: "attr", name } : { kind: "attr", name, alsoDemands };
const FAIL: Expect = { kind: "fail-closed" };

const SHAPES: Shape[] = [
  // controls
  { label: "ctl:plain-cd", command: (g) => `cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "ctl:plain-C", command: gitVerb(`-C ${P}`), expect: attr("libplain") },
  { label: "ctl:no-dir", command: (g) => g, expect: { kind: "cwd" } },
  { label: "ctl:opaque-cd", command: (g) => `cd ${T} && ${g}`, expect: FAIL },
  // (a) plain-name shapes
  { label: "a:cd-P", command: (g) => `cd -P ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:cd-L", command: (g) => `cd -L ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:cd--", command: (g) => `cd -- ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:pushd", command: (g) => `pushd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:cd-redir-null", command: (g) => `cd ${P} >/dev/null && ${g}`, expect: attr("libplain") },
  { label: "a:cd-redir-2>&1", command: (g) => `cd ${P} 2>&1 && ${g}`, expect: attr("libplain") },
  { label: "a:redir-before-cd", command: (g) => `>/dev/null cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:brace-group", command: (g) => `{ cd ${P}; ${g}; }`, expect: attr("libplain") },
  { label: "a:builtin-cd", command: (g) => `builtin cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:command-cd", command: (g) => `command cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:time-cd", command: (g) => `time cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:time-p-cd", command: (g) => `time -p cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:eval-cd", command: (g) => `eval cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:eval-cd-quoted", command: (g) => `eval 'cd ${P}' && ${g}`, expect: attr("libplain") },
  { label: "a:CDPATH-inline", command: (g) => `CDPATH=vendor cd libplain && ${g}`, expect: FAIL },
  { label: "a:CDPATH-statement", command: (g) => `CDPATH=vendor; cd libplain && ${g}`, expect: FAIL },
  { label: "a:CDPATH-export", command: (g) => `export CDPATH=vendor && cd libplain && ${g}`, expect: FAIL },
  { label: "a:continuation-in-value", command: (g) => `cd vendor/lib\\\nplain && ${g}`, expect: attr("libplain") },
  { label: "a:continuation-before-op", command: (g) => `cd ${P} \\\n&& ${g}`, expect: attr("libplain") },
  { label: "a:continuation-in-git", command: (g) => `git -C ${P} \\\n${g.slice(4)}`, expect: attr("libplain") },
  { label: "a:double-C-rel-rel", command: gitVerb("-C vendor -C libplain"), expect: attr("libplain") },
  { label: "a:double-C-abs-rel", command: (g) => gitVerb(`-C ${abs("vendor")} -C libplain`)(g), expect: attr("libplain") },
  { label: "a:double-C-rel-abs", command: (g) => gitVerb(`-C vendor/libok -C ${abs(P)}`)(g), expect: attr("libplain") },
  { label: "a:double-C-other-plain", command: gitVerb("-C vendor/libok -C ../libplain"), expect: attr("libplain") },
  // `env` honours its last -C; the segment view still demands the first.
  { label: "a:env-double-C", command: (g) => `env -C vendor/libok -C ${P} ${g}`, expect: attr("libplain", ["libok"]) },
  {
    label: "a:env-double-C-chdir",
    command: (g) => `env --chdir=vendor/libok --chdir=${P} ${g}`,
    expect: attr("libplain", ["libok"]),
  },
  { label: "a:glob-star-cd", command: (g) => `cd vendor/libpl* && ${g}`, expect: FAIL },
  { label: "a:glob-q-C", command: gitVerb("-C vendor/libpl?in"), expect: FAIL },
  { label: "a:glob-class-cd", command: (g) => `cd vendor/[l]ibplain && ${g}`, expect: FAIL },
  { label: "a:glob-env-C", command: (g) => `env -C vendor/libpl* ${g}`, expect: FAIL },
  { label: "a:sq-cd", command: (g) => `cd '${P}' && ${g}`, expect: attr("libplain") },
  { label: "a:dq-cd", command: (g) => `cd "${P}" && ${g}`, expect: attr("libplain") },
  { label: "a:partial-q-cd", command: (g) => `cd vendor/'libplain' && ${g}`, expect: attr("libplain") },
  { label: "a:sq-C", command: gitVerb(`-C '${P}'`), expect: attr("libplain") },
  { label: "a:dq-C", command: gitVerb(`-C "${P}"`), expect: attr("libplain") },
  { label: "a:dq-abs-C", command: (g) => gitVerb(`-C "${abs(P)}"`)(g), expect: attr("libplain") },
  { label: "a:dq-env-C", command: (g) => `env -C "${P}" ${g}`, expect: attr("libplain") },
  { label: "a:dq-git-dir", command: gitVerb(`--git-dir="${P}/.git"`), expect: attr("libplain") },
  { label: "a:space-sq-cd", command: (g) => `cd 'vendor/lib sp' && ${g}`, expect: attr("lib sp") },
  { label: "a:space-dq-cd", command: (g) => `cd "vendor/lib sp" && ${g}`, expect: attr("lib sp") },
  { label: "a:space-bs-cd", command: (g) => `cd vendor/lib\\ sp && ${g}`, expect: attr("lib sp") },
  { label: "a:space-sq-C", command: gitVerb("-C 'vendor/lib sp'"), expect: attr("lib sp") },
  { label: "a:space-dq-C", command: gitVerb('-C "vendor/lib sp"'), expect: attr("lib sp") },
  { label: "a:space-sq-env-C", command: (g) => `env -C 'vendor/lib sp' ${g}`, expect: attr("lib sp") },
  { label: "a:space-git-dir", command: gitVerb("--git-dir='vendor/lib sp/.git'"), expect: attr("lib sp") },
  { label: "a:qopt-sq-C", command: gitVerb(`'-C' ${P}`), expect: attr("libplain") },
  { label: "a:qopt-dq-C", command: gitVerb(`"-C" ${P}`), expect: attr("libplain") },
  { label: "a:qopt-partial-C", command: gitVerb(`-''C ${P}`), expect: attr("libplain") },
  { label: "a:qopt-git-dir", command: gitVerb(`'--git-dir=${P}/.git'`), expect: attr("libplain") },
  { label: "a:qopt-env-C", command: (g) => `env '-C' ${P} ${g}`, expect: attr("libplain") },
  { label: "a:qopt-cd-word", command: (g) => `'cd' ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:bs-cd-word", command: (g) => `\\cd ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:partial-cd-word", command: (g) => `c''d ${P} && ${g}`, expect: attr("libplain") },
  { label: "a:zsh-chdir", command: (g) => `chdir ${P} && ${g}`, expect: attr("libplain") },
  // (b) opaque-basis propagation
  { label: "b:then-cd-P", command: (g) => `cd ${T} && cd -P sub && ${g}`, expect: FAIL },
  { label: "b:then-cd-L", command: (g) => `cd ${T} && cd -L sub && ${g}`, expect: FAIL },
  { label: "b:then-cd--", command: (g) => `cd ${T} && cd -- sub && ${g}`, expect: FAIL },
  { label: "b:then-pushd", command: (g) => `cd ${T} && pushd sub && ${g}`, expect: FAIL },
  { label: "b:then-cd-redir", command: (g) => `cd ${T} && cd sub >/dev/null && ${g}`, expect: FAIL },
  { label: "b:then-builtin-cd", command: (g) => `cd ${T} && builtin cd sub && ${g}`, expect: FAIL },
  { label: "b:then-eval-cd", command: (g) => `cd ${T} && eval cd sub && ${g}`, expect: FAIL },
  { label: "b:then-dq-cd", command: (g) => `cd ${T} && cd "sub" && ${g}`, expect: FAIL },
  { label: "b:then-sq-cd", command: (g) => `cd ${T} && cd 'sub' && ${g}`, expect: FAIL },
  { label: "b:then-cd-dot", command: (g) => `cd ${T} && cd . && ${g}`, expect: FAIL },
  { label: "b:cd-minus", command: (g) => `cd ${T} && cd sub && cd - && ${g}`, expect: FAIL },
  { label: "b:cd-minus-abs", command: (g) => `cd ${T} && cd /tmp && cd - && ${g}`, expect: FAIL },
  { label: "b:popd", command: (g) => `pushd ${T} && pushd /tmp && popd && ${g}`, expect: FAIL },
  { label: "b:or-true", command: (g) => `cd ${T} || true && ${g}`, expect: FAIL },
  { label: "b:or-chain", command: (g) => `cd ${T} || echo x && ${g}`, expect: FAIL },
  { label: "b:bs-cd-word", command: (g) => `\\cd ${T} && ${g}`, expect: FAIL },
  { label: "b:partial-cd-word", command: (g) => `c''d ${T} && ${g}`, expect: FAIL },
  { label: "b:partial-cd-word-dq", command: (g) => `"c"d ${T} && ${g}`, expect: FAIL },
  { label: "b:zsh-chdir", command: (g) => `chdir ${T} && ${g}`, expect: FAIL },
  { label: "b:then-relative-C", command: (g) => `cd ${T} && git -C sub ${g.slice(4)}`, expect: FAIL },
  {
    label: "b:then-dotdot-escaped-tick",
    command: (g) => `cd ${T} && cd .. && cd lib\\\`x\\\`y && ${g}`,
    expect: FAIL,
  },
  { label: "b:subst-then-cd-P", command: (g) => `cd \`echo vendor/libplain\` && cd -P sub && ${g}`, expect: FAIL },
  { label: "b:ansic-then-pushd", command: (g) => `cd $'vendor/libplain' && pushd sub && ${g}`, expect: FAIL },
  // (c) a quoted target the quote-blind splitter used to cut
  { label: "c:sq-semi-cd", command: (g) => `cd 'vendor/lib;semi' && ${g}`, expect: attr("lib;semi") },
  { label: "c:dq-semi-cd", command: (g) => `cd "vendor/lib;semi" && ${g}`, expect: attr("lib;semi") },
  { label: "c:sq-pipe-cd", command: (g) => `cd 'vendor/lib|pipe' && ${g}`, expect: attr("lib|pipe") },
  { label: "c:sq-amp-cd", command: (g) => `cd 'vendor/lib&&amp' && ${g}`, expect: attr("lib&&amp") },
  { label: "c:sq-paren-cd", command: (g) => `cd 'vendor/lib(paren' && ${g}`, expect: attr("lib(paren") },
  { label: "c:sq-newline-cd", command: (g) => `cd 'vendor/lib\nnl' && ${g}`, expect: FAIL },
  { label: "c:bs-semi-cd", command: (g) => `cd vendor/lib\\;semi && ${g}`, expect: attr("lib;semi") },
  { label: "c:sq-semi-C", command: gitVerb("-C 'vendor/lib;semi'"), expect: attr("lib;semi") },
  { label: "c:sq-pipe-C", command: gitVerb("-C 'vendor/lib|pipe'"), expect: attr("lib|pipe") },
  { label: "c:sq-paren-C", command: gitVerb("-C 'vendor/lib(paren'"), expect: attr("lib(paren") },
  { label: "c:sq-semi-env-C", command: (g) => `env -C 'vendor/lib;semi' ${g}`, expect: attr("lib;semi") },
  { label: "c:sq-semi-tick-cd", command: (g) => `cd 'vendor/lib;\`x\`y' && ${g}`, expect: FAIL },
  { label: "c:sq-semi-tick-C", command: gitVerb("-C 'vendor/lib;`x`y'"), expect: FAIL },
];

/** One `gh` shape per family, for the two `${BRANCH}` review policies. */
const GH_SHAPES: Shape[] = [
  { label: "gh a:sq-cd", command: (g) => `cd '${P}' && ${g}`, expect: attr("libplain") },
  { label: "gh a:space-sq-cd", command: (g) => `cd 'vendor/lib sp' && ${g}`, expect: attr("lib sp") },
  { label: "gh a:pushd", command: (g) => `pushd ${P} && ${g}`, expect: attr("libplain") },
  { label: "gh b:then-cd-P", command: (g) => `cd ${T} && cd -P sub && ${g}`, expect: FAIL },
  { label: "gh c:sq-semi-cd", command: (g) => `cd 'vendor/lib;semi' && ${g}`, expect: attr("lib;semi") },
];

const VERBS: Array<[string, PolicyName]> = [
  ["git log", "preflight-before-investigation"],
  ["git push", "preflight-before-push"],
];
const GH_VERBS: Array<[string, PolicyName]> = [
  ["gh pr merge 1", "review-before-merge-bash"],
  ["gh pr create --fill", "review-subagent-before-pr-create-bash"],
];

function cases(shapes: Shape[], verbs: Array<[string, PolicyName]>) {
  return shapes.flatMap((shape) => verbs.map(([verb, policy]) => ({ shape, verb, policy })));
}

const ALL_CASES = [...cases(SHAPES, VERBS), ...cases(GH_SHAPES, GH_VERBS)];

describe("runInterceptCli: every directory-changing shape is attributed or fails closed (task 7d4abf84)", () => {
  for (const enforcement of ["block", "warn"] as const) {
    const failedOutcome = enforcement === "block" ? "deny" : "warn";
    describe(`enforcement ${enforcement}`, () => {
      for (const { shape, verb, policy } of ALL_CASES) {
        const command = (): string => shape.command(verb);
        const title = `${shape.label} / ${verb}: ${JSON.stringify(shape.command(verb))}`;
        if (shape.expect.kind === "attr") {
          const name = shape.expect.name;
          const also = shape.expect.alsoDemands ?? [];
          it(`${title} demands the nested repository's evidence next to the outer one`, async () => {
            const demanded = [outerTag(policy), nestedTag(policy, name), ...also.map((n) => nestedTag(policy, n))];
            const outerOnly = await run(command(), OUTER_ONLY, enforcement);
            const own = decisionsOf(outerOnly.decisions, policy);
            expect(own.map((d) => d.ledgerTag).sort()).toEqual([...demanded].sort());
            expect(own.find((d) => d.ledgerTag === outerTag(policy))?.outcome).toBe("allow");
            expect(own.find((d) => d.ledgerTag === nestedTag(policy, name))?.outcome).toBe(failedOutcome);
            expect(own.some(isFailClosed)).toBe(false);
            expect(outerOnly.blocked).toBe(enforcement === "block");

            const satisfied = await run(
              command(),
              [...OUTER_ONLY, ...tagsOfRepos([name, ...also].map((n) => [n, NESTED[n]!] as [string, string]))],
              enforcement,
            );
            expect(decisionsOf(satisfied.decisions, policy).every((d) => d.outcome === "allow")).toBe(true);
            expect(satisfied.blocked).toBe(false);
          });
        } else if (shape.expect.kind === "fail-closed") {
          it(`${title} fails closed with every tag on record`, async () => {
            const result = await run(command(), EVERY_TAG, enforcement);
            const own = decisionsOf(result.decisions, policy);
            expect(own).toHaveLength(1);
            expect(own[0]!.reason).toBe(OPAQUE_TARGET_REASON);
            expect(own[0]!.outcome).toBe(failedOutcome);
            expect(result.blocked).toBe(enforcement === "block");
          });
        } else {
          it(`${title} is decided on the cwd evidence alone`, async () => {
            const result = await run(command(), OUTER_ONLY, enforcement);
            expect(decisionsOf(result.decisions, policy).map((d) => d.ledgerTag)).toEqual([outerTag(policy)]);
            expect(result.blocked).toBe(false);
          });
        }
      }
    });
  }
});

describe("runInterceptCli quote-aware attribution: two-sided pins", () => {
  const INVESTIGATION: PolicyName = "preflight-before-investigation";
  const PUSH: PolicyName = "preflight-before-push";

  async function tagsFor(command: string, policy: PolicyName): Promise<string[]> {
    const result = await run(command, OUTER_ONLY);
    return decisionsOf(result.decisions, policy)
      .map((d) => (isFailClosed(d) ? "(fail-closed)" : d.ledgerTag))
      .sort();
  }

  describe("a gated verb that runs in the working directory stays cwd-only", () => {
    for (const command of [
      `cd ${P} | git log`,
      `cd ${P} & git log`,
      `(cd ${P}) && git log`,
      `cd ${P} || git log`,
      `! cd ${P} && git log`,
      "git log --grep='`x`'",
      'cd "$(git rev-parse --show-toplevel)" && git status',
      // `command -v` / `-V` only look the name up: nothing changes directory.
      `command -v cd ${P} && git log`,
      `command -V cd ${P} && git log`,
    ]) {
      it(JSON.stringify(command), async () => {
        expect(await tagsFor(command, INVESTIGATION)).toEqual([outerTag(INVESTIGATION)]);
      });
    }

    it("a heredoc commit message with an apostrophe, then git push", async () => {
      const command = 'git commit -m "$(cat <<\'EOF\'\nIt\'s done\nEOF\n)" && git push';
      expect(await tagsFor(command, PUSH)).toEqual([outerTag(PUSH)]);
    });

    it("a boundary character inside a commit message does not make a model command match the push policy", async () => {
      // The raw arm matches `; git push` inside the quotes and reads it on
      // the cwd evidence, as before; the model must not add the -C target.
      expect(await tagsFor(`git -C ${P} commit -m 'x; git push'`, PUSH)).toEqual([outerTag(PUSH)]);
    });
  });

  it("a gated verb behind a cwd-only head spelling matches no policy (the matching arm is scoped)", async () => {
    const result = await run("! git log", OUTER_ONLY);
    expect(result.decisions).toHaveLength(0);
  });

  describe("named directories are attributed", () => {
    it("a heredoc with an apostrophe after a cd lexes: the push is attributed, not failed closed", async () => {
      const command = `cd ${P} && git commit -m "$(cat <<'EOF'\nIt's done\nEOF\n)" && git push`;
      expect(await tagsFor(command, PUSH)).toEqual([nestedTag(PUSH, "libplain"), outerTag(PUSH)].sort());
    });

    it("env -C a -C b still demands a (the segment view's floor), next to b", async () => {
      expect(await tagsFor(`env -C vendor/libok -C ${P} git log`, INVESTIGATION)).toEqual(
        [nestedTag(INVESTIGATION, "libok"), nestedTag(INVESTIGATION, "libplain"), outerTag(INVESTIGATION)].sort(),
      );
    });

    it("a known -C directory stays a candidate next to a value that may expand to nothing", async () => {
      expect(await tagsFor(`git -C ${P} -C "$EMPTY" log`, INVESTIGATION)).toEqual(
        [nestedTag(INVESTIGATION, "libplain"), outerTag(INVESTIGATION)].sort(),
      );
    });

    it("the last element of a pipeline may run in the current shell (zsh): its cd counts", async () => {
      // `cd -P`: the segment view does not attribute it, so only the model's
      // reading of the pipeline can demand the nested repository here.
      expect(await tagsFor(`echo | cd -P ${P} && git log`, INVESTIGATION)).toEqual(
        [nestedTag(INVESTIGATION, "libplain"), outerTag(INVESTIGATION)].sort(),
      );
    });

    it("a gated verb inside a command substitution is attributed to the directory it runs in", async () => {
      expect(await tagsFor(`echo "$(cd 'vendor/lib sp' && git log)"`, INVESTIGATION)).toEqual(
        [nestedTag(INVESTIGATION, "lib sp"), outerTag(INVESTIGATION)].sort(),
      );
    });

    it("a relative path after a known directory is composed (cd T && git -C sub)", async () => {
      expect(await tagsFor("cd vendor && git -C libplain log", INVESTIGATION)).toEqual(
        [nestedTag(INVESTIGATION, "libplain"), outerTag(INVESTIGATION)].sort(),
      );
      expect(await tagsFor("cd vendor && cd libplain && git log", INVESTIGATION)).toEqual(
        [nestedTag(INVESTIGATION, "libplain"), outerTag(INVESTIGATION)].sort(),
      );
    });
  });

  describe("logical and physical steps resolve like the shell and git do", () => {
    it("git -C link/.. leaves the symlink's target (physical): the repository there is demanded", async () => {
      expect(await tagsFor("git -C vendor/sidelink/.. log", INVESTIGATION)).toEqual(
        ["preflight:side", outerTag(INVESTIGATION)].sort(),
      );
    });

    it("cd -P link/.. is physical too", async () => {
      expect(await tagsFor("cd -P vendor/sidelink/.. && git log", INVESTIGATION)).toEqual(
        ["preflight:side", outerTag(INVESTIGATION)].sort(),
      );
    });

    it("a plain cd link/.. is logical: it stays in the outer repository", async () => {
      expect(await tagsFor("cd vendor/sidelink/.. && git log", INVESTIGATION)).toEqual([outerTag(INVESTIGATION)]);
    });
  });

  describe("bounds and the unlexable fallback fail closed", () => {
    it("a command the model cannot lex but bash runs, holding a cd, fails closed", async () => {
      const nested = `${"( ".repeat(9)}true${" )".repeat(9)}`;
      expect(await tagsFor(`${nested}; cd -P ${P} && git log`, INVESTIGATION)).toEqual(["(fail-closed)"]);
    });

    it("more possible directories than the model tracks fails closed", async () => {
      expect(await tagsFor("cd vendor/a; cd b; cd c; cd d; git log", INVESTIGATION)).toEqual(["(fail-closed)"]);
    });

    it("an unlexable command without a directory-changing word keeps the segment view's verdict", async () => {
      const result = await run("git log 'unterminated", OUTER_ONLY);
      expect(decisionsOf(result.decisions, INVESTIGATION).map((d) => d.ledgerTag)).toEqual([outerTag(INVESTIGATION)]);
    });
  });
});

describe("runInterceptCli quote-aware attribution: more two-sided pins", () => {
  const INVESTIGATION: PolicyName = "preflight-before-investigation";

  async function tagsAt(cwd: string, command: string, tags: readonly string[], policy: PolicyName = INVESTIGATION) {
    const result = await runAt(cwd, command, tags);
    return decisionsOf(result.decisions, policy)
      .map((d) => (isFailClosed(d) ? "(fail-closed)" : d.ledgerTag))
      .sort();
  }

  it("more repositories than the bound, reached only through the shell model, fail closed with the bounded decision", async () => {
    // `cd -P <dir>` is a reset in the segment view, which reads every
    // `git log` here as the working directory's: only the model names the
    // four nested repositories, and with the cwd that is one context past
    // the bound.
    const command = ["vendor/libplain", "vendor/libok", "vendor/lib sp", "vendor/lib;semi"]
      .map((rel) => `cd -P '${abs(rel)}' && git log`)
      .join("; ");
    for (const enforcement of ["block", "warn"] as const) {
      const result = await run(command, EVERY_TAG, enforcement);
      const own = decisionsOf(result.decisions, INVESTIGATION);
      expect(own).toHaveLength(1);
      expect(own[0]!.reason).toMatch(/names at least \d+ distinct repository targets/);
      expect(own[0]!.outcome).toBe(enforcement === "block" ? "deny" : "warn");
      expect(result.blocked).toBe(enforcement === "block");
    }
  });

  describe("a working directory that is a symlink: logical steps start from the path the shell has, physical ones from the real directory", () => {
    it("cd ../x from a symlinked working directory is logical: it lands next to the link, not next to its target", async () => {
      // The working directory is `vendor/sidelink` (a link to side/deep);
      // the shell's `$PWD` keeps the link, so `cd ../libplain` is
      // `vendor/libplain`. Resolved physically it would be side/libplain,
      // which names no repository of its own.
      const tags = await tagsAt(abs("vendor/sidelink"), "cd ../libplain && git log", OUTER_ONLY);
      expect(tags).toContain(nestedTag(INVESTIGATION, "libplain"));
      expect(tags).not.toContain("preflight:side");
    });

    it("git -C .. after a cd into a symlink is physical: the parent of the link's target", async () => {
      expect(await tagsAt(outer, "cd vendor/sidelink && git -C .. log", OUTER_ONLY)).toEqual(
        ["preflight:side", outerTag(INVESTIGATION)].sort(),
      );
    });
  });
});

describe("runInterceptCli quote-aware attribution: a working directory outside every repository", () => {
  // The cwd context of a directory outside every repository has a blank
  // ${REPO} / ${BRANCH}: the empty-identifier guard denies it without a
  // ledger query, and the gate leaves it out only next to a target that
  // resolved to a real repository. Where the segment view demands it, the
  // shell model's own target must not take its place: every verdict below
  // is the one the segment view alone reaches (the master build's).
  const INVESTIGATION: PolicyName = "preflight-before-investigation";
  const PUSH: PolicyName = "preflight-before-push";
  let plain = "";
  let side = "";

  beforeAll(() => {
    plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    side = path.join(root, "side");
    for (let dir = plain; ; dir = path.dirname(dir)) {
      for (const name of [".git", "HEAD"]) {
        expect(fs.existsSync(path.join(dir, name)), `${dir}/${name}`).toBe(false);
      }
      if (path.dirname(dir) === dir) break;
    }
  });

  const isBlankCwd = (d: PolicyDecision): boolean => d.extractValues.REPO === "";

  const KEEPS_BLANK_CWD: Array<[string, (a: string, b: string) => string, PolicyName]> = [
    ["an assignment glued to env -C by &", (a) => `A=x&env -C ${a} git log`, INVESTIGATION],
    ["a background job before env -C", (a) => `echo hi & env -C ${a} git log`, INVESTIGATION],
    ["a background job before nice git -C", (a) => `echo hi & nice git -C ${a} log`, INVESTIGATION],
    ["a push behind an assignment glued to env -C", (a) => `A=x&env -C ${a} git push`, PUSH],
    ["GIT_DIR naming another repository", (a, b) => `echo hi & GIT_DIR=${b}/.git env -C ${a} git log`, INVESTIGATION],
    // The cd may fail (the directory does not exist), so git may run here.
    ["a cd that may fail", (a) => `cd ${a}/missing; git log`, INVESTIGATION],
  ];

  for (const enforcement of ["block", "warn"] as const) {
    const failedOutcome = enforcement === "block" ? "deny" : "warn";
    describe(`enforcement ${enforcement}`, () => {
      for (const [label, make, policy] of KEEPS_BLANK_CWD) {
        it(`${label}: the blank cwd context is still demanded with every tag on record`, async () => {
          const result = await runAt(plain, make(outer, side), EVERY_TAG, enforcement);
          const own = decisionsOf(result.decisions, policy);
          expect(own.filter(isBlankCwd).map((d) => d.outcome)).toEqual([failedOutcome]);
          expect(result.blocked).toBe(enforcement === "block");
        });
      }

      for (const [label, command, policy] of [
        ["git -C <repo> log", (a: string) => `git -C ${a} log`, INVESTIGATION],
        ["cd <repo> && git push", (a: string) => `cd ${a} && git push`, PUSH],
        // The directory exists, so the cd cannot fail: git runs only there.
        ["cd <repo>; git push", (a: string) => `cd ${a}; git push`, PUSH],
      ] as Array<[string, (a: string) => string, PolicyName]>) {
        it(`${label}: the remedy the hint names is allowed on the repository's own evidence`, async () => {
          const result = await runAt(plain, command(outer), OUTER_ONLY, enforcement);
          const own = decisionsOf(result.decisions, policy);
          expect(own.map((d) => d.ledgerTag)).toEqual([outerTag(policy)]);
          expect(own.every((d) => d.outcome === "allow")).toBe(true);
          expect(result.blocked).toBe(false);
        });
      }
    });
  }
});

describe("runInterceptCli quote-aware attribution: a repository nested in a parent repository", () => {
  // The worktree layout `<parent>/wt/<child>`: a `cd` that certainly
  // succeeds has no failure branch, so `cd frontend; ...; cd ..` comes back
  // to the child and never reaches the parent. A `cd` that may fail keeps
  // its failure branch, and the parent is demanded where the shell can
  // really get there.
  const INVESTIGATION: PolicyName = "preflight-before-investigation";
  const CHILD = "child-repo";
  const CHILD_BRANCH = "brchild";
  let child = "";

  beforeAll(() => {
    const parent = path.join(root, "parent-repo");
    makeRepo(parent, "brparent");
    child = path.join(parent, "wt", CHILD);
    makeRepo(child, CHILD_BRANCH);
    fs.mkdirSync(path.join(child, "frontend"));
    fs.mkdirSync(path.join(child, "backend"));
  });

  const CHILD_TAGS = tagsOfRepos([[CHILD, CHILD_BRANCH]]);

  for (const enforcement of ["block", "warn"] as const) {
    describe(`enforcement ${enforcement}`, () => {
      for (const command of [
        "cd frontend; npm test; cd ..; git status",
        "cd frontend && npm test; cd ..; git status",
        "cd frontend; npm test; cd ..; cd backend; npm test; cd ..; git status",
        "cd frontend && npm test && cd .. && git status",
        "pushd frontend; npm test; popd; git status",
        "git status",
      ]) {
        it(`${JSON.stringify(command)} is decided on the child's evidence alone`, async () => {
          const result = await runAt(child, command, CHILD_TAGS, enforcement);
          const own = decisionsOf(result.decisions, INVESTIGATION);
          expect(own.map((d) => d.ledgerTag)).toEqual([`preflight:${CHILD}`]);
          expect(own[0]!.outcome).toBe("allow");
          expect(result.blocked).toBe(false);
        });
      }

      for (const command of ["cd missing; npm test; cd ..; git status", "cd ../.. && git status"]) {
        it(`${JSON.stringify(command)} can run in the parent: its evidence is demanded too`, async () => {
          const result = await runAt(child, command, CHILD_TAGS, enforcement);
          const own = decisionsOf(result.decisions, INVESTIGATION);
          expect(own.map((d) => d.ledgerTag).sort()).toEqual([`preflight:${CHILD}`, "preflight:parent-repo"].sort());
          expect(own.find((d) => d.ledgerTag === "preflight:parent-repo")?.outcome).toBe(
            enforcement === "block" ? "deny" : "warn",
          );
          expect(result.blocked).toBe(enforcement === "block");
        });
      }
    });
  }
});
