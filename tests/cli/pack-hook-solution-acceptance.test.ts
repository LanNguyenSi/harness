import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookSolutionAcceptanceCli } from "../../src/cli/pack/hook-solution-acceptance.js";
import { signVerdict, type Verdict } from "../../src/policy-packs/builtin/solution-acceptance-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const HEAD = "f30767afdc14013a48cd0c024a82213f2f63855a";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const TASK = "task-42";

// Shared operator-side signing key location for the whole file
// (harness/c7c3f606). `run()` injects this as `opts.generatedDir` and
// `verdictDirWith` signs against it, so the ALLOW-path tests below exercise
// a verdict that actually passes signature verification, not just the
// ready/HEAD logic. See the "production resolution path" describe block
// for the ONE place this must instead be `<home>/harness.generated` (the
// hook resolves generatedDir from `homeDir` there, not from an injected
// opt), matching `resolveGeneratedDir`.
let generatedDir: string;
beforeEach(() => {
  generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-hook-signing-"));
  cleanups.push(() => fs.rmSync(generatedDir, { recursive: true, force: true }));
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

/** A temp git work tree whose HEAD resolves to `sha`. */
function repoAtHead(sha: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-gate-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/work\n");
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "work"), `${sha}\n`);
  return repo;
}

/**
 * Writes a SIGNED verdict marker (harness/c7c3f606), signed against `signDir`
 * (defaults to the shared `generatedDir` — override for the "production
 * resolution path" block, which resolves its own generatedDir from
 * `homeDir`). Signing is the default here because this file's job is
 * mostly to pin the ready/HEAD gate DECISION, not signing itself — the
 * dedicated forged/unsigned tests below opt OUT via `unsigned: true`.
 */
function verdictDirWith(
  id: string | null,
  opts: Partial<Verdict> & { unsigned?: boolean } = {},
  signDir: string = generatedDir,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-verdicts-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (id !== null) {
    const { unsigned, ...v } = opts;
    const full: Verdict = {
      id,
      head: HEAD,
      ready: true,
      confidence: 0.9,
      blockers: [],
      timestamp: "2026-05-30T00:00:00.000Z",
      source: "preflight",
      ...v,
    };
    const body = unsigned ? full : signVerdict(signDir, full);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
  }
  return dir;
}

function manifest(enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "solution-acceptance", enabled, config: {} }],
  });
}

const TASK_FINISH = "mcp__agent-tasks__task_finish";

async function run(over: {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  cwd: string;
  verdictDir: string;
  activeClaim?: string | null;
  manifest?: Manifest;
  env?: NodeJS.ProcessEnv;
  /** Override the injected generatedDir (default: the shared per-test signing dir). */
  generatedDir?: string;
}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const res = await runPackHookSolutionAcceptanceCli({
    stdin: streamFrom(
      JSON.stringify({
        session_id: "sess-1",
        tool_name: over.toolName ?? TASK_FINISH,
        cwd: over.cwd,
        ...(over.toolInput !== undefined && { tool_input: over.toolInput }),
      }),
    ),
    stdout: stdout.stream,
    stderr: stderr.stream,
    cwd: over.cwd,
    verdictDir: over.verdictDir,
    activeClaim: over.activeClaim !== undefined ? over.activeClaim : TASK,
    manifest: over.manifest ?? manifest(),
    // harness/c7c3f606: evaluateGate needs generatedDir to verify the
    // verdict's signature (a SEPARATE dir from harness.generated/'s
    // active-claim resolution, which this same option also feeds).
    generatedDir: over.generatedDir ?? generatedDir,
    // Hermetic: no SOLUTION_VERDICT_ID unless a case opts in, so the env knob
    // never leaks in from the runner's real environment.
    env: over.env ?? {},
  });
  return { res, out: stdout.output(), err: stderr.output() };
}

describe("completion-gate — decision matrix", () => {
  it("ALLOWS a completion verb when a ready verdict exists at the current HEAD", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: true }),
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("BLOCKS when no verdict exists", async () => {
    const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: verdictDirWith(null) });
    expect(res.blocked).toBe(true);
    const env = JSON.parse(out);
    expect(env.decision).toBe("block");
    expect(env.reason).toMatch(/no solution-acceptance verdict/);
  });

  it("BLOCKS a not-ready verdict and surfaces the blockers", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { ready: false, blockers: ["2 tests failing"] }),
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/not ready: 2 tests failing/);
  });

  it("BLOCKS a verdict recorded at a different HEAD (drift)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: OTHER, ready: true }),
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/stale/);
  });

  it("the deny names the full convergence recipe (commit-first + both push-gates)", async () => {
    // Regression for the #2/#9/#58/#71 livelock: after a reviewer amendment the
    // agent commits (HEAD moves), the verdict goes stale, and the deny must
    // name the WHOLE recipe — commit if dirty, then run solution_evaluate AND
    // refresh `harness preflight` at the same HEAD — not just one step. A deny
    // that names only `solution_evaluate` is what made the agent satisfy one
    // push-gate, retry, hit the other, and churn.
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: OTHER, ready: true }),
    });
    expect(res.blocked).toBe(true);
    const { reason } = JSON.parse(out) as { reason: string };
    expect(reason).toMatch(/COMMIT first/);
    expect(reason).toMatch(/solution_evaluate/);
    expect(reason).toMatch(/harness preflight/);
  });

  it("BLOCKS when the current HEAD is unresolvable (not a git work tree)", async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sa-nonrepo-"));
    cleanups.push(() => fs.rmSync(nonRepo, { recursive: true, force: true }));
    const { res } = await run({ cwd: nonRepo, verdictDir: verdictDirWith(TASK, { head: HEAD }) });
    expect(res.blocked).toBe(true);
  });

  it("BLOCKS (fail-closed) when there is no active-claim task id", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD }),
      activeClaim: null,
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/no active-claim/);
  });

  it("keys the verdict on the active-claim id, not the session id", async () => {
    // The marker is written for "other-task" but the active claim is TASK,
    // so the gate must look up TASK (find nothing) and BLOCK.
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith("other-task", { head: HEAD }),
      activeClaim: TASK,
    });
    expect(res.blocked).toBe(true);
  });
});

describe("completion-gate — signature verification end-to-end (harness/c7c3f606, fail-closed)", () => {
  it("BLOCKS an UNSIGNED verdict (ready, at HEAD) with a distinct forged/unsigned reason", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: true, unsigned: true }),
    });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(out).reason as string;
    expect(reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    expect(reason).not.toMatch(/no solution-acceptance verdict recorded/);
  });

  // Regression (AC #3): a marker hand-written WITHOUT the signing key, as a
  // forge via a write primitive the write-guard hook does not enumerate,
  // must not satisfy the completion-gate even with perfectly plausible
  // ready/head fields.
  it("BLOCKS a hand-written marker without a signature (forgery regression)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-verdicts-forged-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(dir, `${TASK}.json`),
      JSON.stringify({
        id: TASK,
        head: HEAD,
        ready: true,
        confidence: 1,
        blockers: [],
        timestamp: new Date().toISOString(),
        source: "attacker",
      }),
    );
    const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
  });

  // Mutation-verification: tamper ONE byte of an otherwise-valid signature
  // and confirm the completion-gate blocks through the real hook entrypoint.
  it("BLOCKS a validly-signed verdict with one tampered signature byte", async () => {
    const dir = verdictDirWith(TASK, { head: HEAD, ready: true });
    // Confirm the untampered marker allows first, so the assertion below is
    // attributable to the tamper, not to some other break.
    const before = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
    expect(before.res.blocked).toBe(false);
    const markerPath = path.join(dir, `${TASK}.json`);
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { signature: string };
    const original = raw.signature;
    const flippedChar = original[0] === "0" ? "1" : "0";
    raw.signature = flippedChar + original.slice(1);
    fs.writeFileSync(markerPath, JSON.stringify(raw));
    const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
  });

  // Regression (review R1 HIGH, harness/c7c3f606 fix-round-2), exercised
  // through the real hook entrypoint: a VERBATIM byte-for-byte copy of a
  // validly-signed verdict onto a SECOND task's marker path must not
  // satisfy that second task's completion gate. Before this fix, the
  // markerId used to verify the signature was derived from the marker
  // BODY's `id` field (unchanged by a plain file copy) rather than the
  // active-claim task id the hook is actually checking, so this exact copy
  // passed verification and ALLOWED "task-other" to finish on "task-42"'s
  // verdict.
  it("BLOCKS a VERBATIM file copy of a signed verdict onto a different task's marker path (cross-id replay)", async () => {
    const dir = verdictDirWith(TASK, { head: HEAD, ready: true });
    const bytes = fs.readFileSync(path.join(dir, `${TASK}.json`));
    const OTHER_TASK = "task-other";
    fs.writeFileSync(path.join(dir, `${OTHER_TASK}.json`), bytes);
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: dir,
      activeClaim: OTHER_TASK,
    });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(out).reason as string;
    expect(reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    // Also confirmed at the STDERR diagnostic / operator-facing audit tag.
    expect(res.diagnostic).toMatch(/\[audit: forged\/unsigned verdict marker rejected\]/);
  });

  // The forged-audit tag is specific to `forged: true` denials — a routine
  // "no verdict" block must not carry it, so the tag stays a reliable
  // signal an operator can grep for.
  it("does NOT carry the forged-audit tag on a routine no-verdict BLOCK", async () => {
    const { res } = await run({ cwd: repoAtHead(HEAD), verdictDir: verdictDirWith(null) });
    expect(res.blocked).toBe(true);
    expect(res.diagnostic).not.toMatch(/\[audit: forged/);
  });

  // Negative control (review R2, finding 2c): the forged-audit tag must
  // also stay ABSENT on the other two routine denial paths — "not ready"
  // and "stale head" — not just "no verdict" (already pinned above). Both
  // read a perfectly well-formed, VALIDLY-SIGNED verdict; the reason they
  // deny has nothing to do with forgery.
  it("does NOT carry the forged-audit tag on a routine not-ready BLOCK", async () => {
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: false, blockers: ["1 test failing"] }),
    });
    expect(res.blocked).toBe(true);
    expect(res.diagnostic).not.toMatch(/\[audit: forged/);
  });

  it("does NOT carry the forged-audit tag on a routine stale-head BLOCK", async () => {
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: OTHER, ready: true }),
    });
    expect(res.blocked).toBe(true);
    expect(res.diagnostic).not.toMatch(/\[audit: forged/);
  });

  // Regression (review R2 MED, harness/c7c3f606 fix-round-2b, audit finding
  // A8), exercised through the real hook entrypoint: a verdict that DOES
  // carry a valid `alg`/`signature` pair but whose `timestamp` reads blank
  // must be classified forged:true (STDERR audit tag present), not silently
  // read as "legitimately malformed, not forged" the way a genuinely
  // unsigned marker is. `allowed` was already false before this fix — this
  // pins the AUDIT classification, not the block itself.
  it("BLOCKS a SIGNED verdict with a blanked timestamp, WITH the forged-audit tag present", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: true, timestamp: "" }),
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    expect(res.diagnostic).toMatch(/\[audit: forged\/unsigned verdict marker rejected\]/);
  });

  // Regression (review R2, finding 2b), exercised through the real hook
  // entrypoint: a verdict whose signature genuinely verifies for the
  // active-claim task id (the marker sits at that task's own path, signed
  // against that same id), but whose BODY `id` field was mutated to a
  // DIFFERENT string post-signing (the signed payload does not cover `id`
  // itself, so this leaves the signature valid) must still be rejected —
  // the belt-and-braces `verdict.id !== id` check in `evaluateGate` — with
  // the forged-audit tag present end to end.
  it("BLOCKS on verdict.id !== active-claim id even though the signature still verifies, WITH the forged-audit tag", async () => {
    const dir = verdictDirWith(TASK, { head: HEAD, ready: true });
    const markerPath = path.join(dir, `${TASK}.json`);
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Verdict;
    raw.id = "someone-else"; // mutate ONLY id post-signing; signature untouched
    fs.writeFileSync(markerPath, JSON.stringify(raw));
    const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir, activeClaim: TASK });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(out).reason as string;
    expect(reason).toMatch(/forged\/unsigned solution-acceptance verdict rejected/);
    expect(reason).toMatch(/cross-id replay/);
    expect(res.diagnostic).toMatch(/\[audit: forged\/unsigned verdict marker rejected\]/);
  });
});

describe("completion-gate — production resolution path (no injected manifest/claim)", () => {
  // Regression guard: in production the hook command is the bare
  // `harness pack hook solution-acceptance` (no --config), so generatedDir
  // and the active-claim id must resolve from the loaded manifest base, not
  // from opts.configPath. This test injects NEITHER manifest, generatedDir,
  // nor activeClaim — only a homeDir whose harness.generated/active-claim and
  // harness.yaml are on disk, exactly as `harness apply` would leave them.
  function makeHome(activeClaim: string | null): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sa-home-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      "version: 1\npolicy_packs:\n  - name: solution-acceptance\n    source: builtin\n    enabled: true\n",
    );
    const gen = path.join(home, "harness.generated");
    fs.mkdirSync(gen, { recursive: true });
    if (activeClaim !== null) fs.writeFileSync(path.join(gen, "active-claim"), `${activeClaim}\n`);
    return home;
  }

  async function runProd(home: string, verdictDir: string, cwd: string) {
    const stdout = captureStream();
    const stderr = captureStream();
    const res = await runPackHookSolutionAcceptanceCli({
      stdin: streamFrom(JSON.stringify({ session_id: "s", tool_name: TASK_FINISH, cwd })),
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd,
      verdictDir,
      homeDir: home,
      env: {},
    });
    return { res, out: stdout.output() };
  }

  it("ALLOWS when active-claim + a ready verdict resolve purely from the manifest base", async () => {
    // Sign against <home>/harness.generated: the SAME dir the hook resolves
    // internally from `homeDir` (resolveGeneratedDir), not the shared
    // per-test `generatedDir` this file otherwise defaults to.
    const home = makeHome(TASK);
    const { res, out } = await runProd(
      home,
      verdictDirWith(TASK, { head: HEAD, ready: true }, path.join(home, "harness.generated")),
      repoAtHead(HEAD),
    );
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("BLOCKS (fail-closed) when the manifest base resolves but no active-claim file exists", async () => {
    const { res, out } = await runProd(
      makeHome(null),
      verdictDirWith(TASK, { head: HEAD }),
      repoAtHead(HEAD),
    );
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/no active-claim/);
  });
});

describe("completion-gate — scoping", () => {
  it("ALLOWS when the pack is disabled", async () => {
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      manifest: manifest(false),
    });
    expect(res.blocked).toBe(false);
  });

  it("ALLOWS a non-completion tool (Bash that is not push/merge)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      toolName: "Bash",
      toolInput: { command: "git status" },
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("GATES a `git push` Bash command (blocks with no verdict)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      toolName: "Bash",
      toolInput: { command: "git push origin work" },
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/no solution-acceptance verdict/);
  });

  it("GATES `gh pr merge` and ALLOWS it once a ready verdict is present", async () => {
    const dir = verdictDirWith(TASK, { head: HEAD, ready: true });
    const blocked = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      toolName: "Bash",
      toolInput: { command: "gh pr merge 7 --squash" },
    });
    expect(blocked.res.blocked).toBe(true);
    const allowed = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: dir,
      toolName: "Bash",
      toolInput: { command: "gh pr merge 7 --squash" },
    });
    expect(allowed.res.blocked).toBe(false);
  });
});

describe("completion-gate — solo / non-agent-tasks verdict id (SOLUTION_VERDICT_ID)", () => {
  const SOLO = "solo-verdict";

  it("ALLOWS via SOLUTION_VERDICT_ID when no active-claim but a ready verdict exists at HEAD", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: HEAD, ready: true }),
      activeClaim: null,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("HEAD-gates the env id: BLOCKS a stale verdict for the SOLUTION_VERDICT_ID", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: OTHER, ready: true }),
      activeClaim: null,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/stale/);
  });

  it("active-claim takes precedence over SOLUTION_VERDICT_ID (env cannot redirect a claimed task)", async () => {
    // The only verdict on disk is for the env id; the active claim is TASK.
    // Claim-first means the gate looks up TASK (finds nothing) and BLOCKS,
    // proving the env did NOT override the claim.
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: HEAD, ready: true }),
      activeClaim: TASK,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(true);
  });

  it("ALLOWS on the active-claim verdict even when SOLUTION_VERDICT_ID points elsewhere (env ignored when a claim resolves)", async () => {
    // Positive proof of claim-first: the claimed task TASK has a ready verdict
    // at HEAD; SOLUTION_VERDICT_ID names SOLO, which has NO verdict on disk. If
    // the env participated, the gate would block; it ALLOWS, so the claim won.
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: true }),
      activeClaim: TASK,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("BLOCKS (fail-closed) when SOLUTION_VERDICT_ID is malformed and there is no active-claim", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: HEAD, ready: true }),
      activeClaim: null,
      env: { SOLUTION_VERDICT_ID: ".." },
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/SOLUTION_VERDICT_ID/);
  });

  it("fail-closed message names both task_start and SOLUTION_VERDICT_ID when neither source resolves", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      activeClaim: null,
      env: {},
    });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(out).reason as string;
    expect(reason).toMatch(/no active-claim/);
    expect(reason).toMatch(/SOLUTION_VERDICT_ID/);
    expect(reason).toMatch(/task_start/);
  });

  it("distinguishes agent-tasks vs solo-session paths in the no-verdict-id deny message", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      activeClaim: null,
      env: {},
    });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(out).reason as string;
    // Mentions the agent-tasks path
    expect(reason).toMatch(/Agent-tasks workflow.*task_start.*post-done work.*separate task/);
    // Mentions the solo-session path with explicit Session-Start emphasis
    expect(reason).toMatch(/Solo \/ non-agent-tasks session.*Session-Start time.*not agent-sideeffect-settable/);
    // Does not suggest setting SOLUTION_VERDICT_ID as an agent-side action
    expect(reason).not.toMatch(/set SOLUTION_VERDICT_ID.*within/i);
  });
});

describe("completion-gate — malformed config.ux (task 19e293c6)", () => {
  it("warns with the solution-acceptance-prefixed line and still blocks", async () => {
    const { res, err } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      manifest: parseManifest({
        version: 1,
        policy_packs: [
          { name: "solution-acceptance", enabled: true, config: { ux: { cannot: 42 } } },
        ],
      }),
    });
    expect(res.blocked).toBe(true);
    // Full prefix pins the label->hook binding (task 19e293c6 review).
    expect(err).toContain("harness pack hook solution-acceptance: config.ux ignored (");
  });
});
