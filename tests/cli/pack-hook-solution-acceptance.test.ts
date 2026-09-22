import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_LOCK_STALE_MS,
  NULL_VERDICT_NOTE_STATES,
  runPackHookSolutionAcceptanceCli,
  type NullVerdictNoteState,
} from "../../src/cli/pack/hook-solution-acceptance.js";
import { renderReconnectDenyParagraph } from "../../src/policy-packs/builtin/solution-acceptance-reconnect.js";
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

/**
 * `proper-lockfile`'s own on-disk lock target for an anchor path is
 * `<anchor>.lock` (a directory, `getLockFile` in `lib/lockfile.js`); the
 * anchor itself is `<verdict dir>/<id>.attempt-lock` (README "Attempt lock
 * anchor" row at `grounding-mcp-v0.12.0`).
 */
function attemptLockAnchor(verdictDir: string, id: string): string {
  return path.join(verdictDir, `${id}.attempt-lock`);
}

function attemptLockDir(verdictDir: string, id: string): string {
  return `${attemptLockAnchor(verdictDir, id)}.lock`;
}

/**
 * A LIVE attempt lock: the real anchor file, locked through
 * `proper-lockfile`'s own `lockSync` (the SAME call, with the SAME
 * `{ stale, realpath: false }` options, the hook's `readAttemptLockLiveness`
 * uses via `checkFileLock` to READ it) rather than a hand-built `.lock`
 * directory, so this fixture exercises the library's actual on-disk lock
 * state instead of a guess at its shape. Returns the release function;
 * callers push it onto `cleanups` so the lock is released even if the
 * test fails.
 */
function liveAttemptLock(verdictDir: string, id: string): () => void {
  const anchor = attemptLockAnchor(verdictDir, id);
  fs.writeFileSync(anchor, "", { mode: 0o600 });
  return lockfile.lockSync(anchor, { stale: ATTEMPT_LOCK_STALE_MS, realpath: false });
}

/**
 * A STALE attempt lock: mtime set past `ATTEMPT_LOCK_STALE_MS`, as if left
 * by a dead process. Unlike `liveAttemptLock` above, this stays a
 * hand-built `.lock` directory (`mkdir` + `utimes`) rather than going
 * through `lockSync`: the library always stamps a fresh "now" mtime on
 * acquisition and offers no public API to mint an already-stale one, so
 * simulating a lock a dead process left behind means constructing the
 * on-disk state directly (mirrored against `getLockFile`/`isLockStale` in
 * `lib/lockfile.js`) rather than acquiring and then back-dating it, which
 * would race the library's own mtime-precision probe.
 */
function staleAttemptLock(verdictDir: string, id: string): void {
  const dir = attemptLockDir(verdictDir, id);
  fs.mkdirSync(dir, { recursive: true });
  // The back-date is a LITERAL, deliberately not derived from
  // `ATTEMPT_LOCK_STALE_MS`: an age computed from the constant under test
  // stays stale under every mutation of it, so this fixture would survive
  // a widened window. At 90 s it is stale for the pinned 30 s window and
  // reads LIVE for any window widened past it, which is the half this
  // fixture discriminates; the narrowing half is pinned by the
  // `toBe(30_000)` assertion below.
  const old = new Date(Date.now() - 90_000);
  fs.utimesSync(dir, old, old);
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
  it.each([
    "task_finish",
    "task_submit_pr",
    "task_merge",
    "pull_requests_merge",
  ])("blocks each canonical default completion verb without a verdict: %s", async (verb) => {
    const { res, out } = await run({
      toolName: `mcp__agent-tasks__${verb}`,
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toContain(`agent-tasks ${verb}`);
  });

  it("honors an arbitrary configured completion verb", async () => {
    const customManifest = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "solution-acceptance",
          enabled: true,
          config: { protected_completion_tools: ["custom_close"] },
        },
      ],
    });
    const { res, out } = await run({
      toolName: "mcp__agent-tasks__custom_close",
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      manifest: customManifest,
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toContain("agent-tasks custom_close");
  });

  it("does not broaden canonical completion matching to MCP aliases", async () => {
    const { res } = await run({
      toolName: "mcp__agent-tasks__.task_finish",
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
    });
    expect(res.blocked).toBe(false);
  });

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

  describe("gate.verdict === null: three readings distinguished by the attempt-lock anchor", () => {
    // AC-001: `gate.verdict === null` used to be ambiguous between "never
    // evaluated", "an attempt is still running in the background", and "a
    // marker exists but could not be read or parsed": the SAME deny text
    // for all three. This hook now reads grounding-mcp's documented
    // attempt-lock anchor (`<verdict dir>/<id>.attempt-lock`, README table
    // row "Attempt lock anchor" at grounding-mcp-v0.12.0) to tell reading
    // (2) ("an attempt is live") apart from readings (1) and (3), and only
    // reading (2) gets the full reconnect-vs-retry paragraph; (1) and (3)
    // get their own short, reading-named line instead (docs/policy-packs/
    // solution-acceptance.md, "Agent-facing surface for the in-flight
    // case").

    it("reading (1) never-evaluated: no marker, no live attempt-lock, short text, no reconnect paragraph", async () => {
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: verdictDirWith(null) });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toMatch(/no solution-acceptance verdict recorded/);
      expect(reason).toContain('No verdict marker exists for "task-42"');
      // Genuinely not-live (an ordinary ENOENT: never locked at all), so the
      // note asserts what was actually observed, not "liveness could not be
      // determined" (that clause is reserved for the "unknown" case below).
      expect(reason).toMatch(/no attempt reads as currently live/);
      expect(reason).not.toMatch(/liveness could not be determined/);
      expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
      expect(reason).not.toMatch(/With grounding-mcp >= 0\.11\.0:/);
      expect(reason).not.toContain("attempt-lock anchor is held");
    });

    it("reading (3) unreadable-marker: a marker file exists but fails to parse, no live attempt-lock, short text, no reconnect paragraph", async () => {
      const dir = verdictDirWith(null);
      fs.writeFileSync(path.join(dir, `${TASK}.json`), "{not valid json");
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain('The verdict marker for "task-42" was read but is not a valid verdict record');
      // Genuinely not-live here too (no lock directory at all: ENOENT).
      expect(reason).toMatch(/no attempt reads as currently live/);
      expect(reason).not.toMatch(/liveness could not be determined/);
      expect(reason).not.toContain('No verdict marker exists for "task-42"');
      expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
      expect(reason).not.toMatch(/With grounding-mcp >= 0\.11\.0:/);
    });

    // Overlap fixture (priority): a LIVE attempt-lock
    // coexisting with a co-present, unparseable marker for the SAME id (an
    // earlier attempt's stale/corrupt leftover, or a marker write racing a
    // fresh attempt). `classifyNullVerdictReading` checks liveness FIRST, so
    // this must land on reading (2) with the full reconnect paragraph, not
    // reading (3)'s short "could not be read or parsed" line: reconnecting
    // to the live attempt is the actionable guidance in this overlap. A
    // mutant that reorders the check (marker presence before liveness)
    // survives every OTHER fixture in this file (none of them has both a
    // live lock and a marker at once) and is killed only here.
    it("reading (2) live-attempt takes priority over a co-present corrupt marker (overlap)", async () => {
      const dir = verdictDirWith(null);
      fs.writeFileSync(path.join(dir, `${TASK}.json`), "{not valid json");
      cleanups.push(liveAttemptLock(dir, TASK));
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain('A solution_evaluate attempt for "task-42" is still live');
      expect(reason).toMatch(/Reconnecting vs\. retrying/);
      // Reading (3)'s own short note must not ALSO appear: the paragraph's
      // own three-readings prose still names that reading, so this pins the
      // absence of reading (3)'s note specifically, not the substring
      // shared with the paragraph's boilerplate.
      expect(reason).not.toContain('The verdict marker for "task-42" was read but is not a valid verdict record');
      expect(reason).not.toContain('No verdict marker exists for "task-42"');
    });

    // Indeterminate liveness on reading (3): a
    // co-present unparseable marker, but the `.lock` path itself cannot be
    // statted at all (a self-referential symlink: `fs.statSync` throws
    // `ELOOP`, not `ENOENT`). `checkFileLock` must read this "unknown", and
    // the note must say liveness could not be determined, NOT assert no
    // attempt is live: an earlier version of this hook hardcoded absence
    // regardless of why the check failed (harness/799de976).
    it("indeterminate liveness (ELOOP) on reading (3): the note does not claim no attempt is live", async () => {
      const dir = verdictDirWith(null);
      fs.writeFileSync(path.join(dir, `${TASK}.json`), "{not valid json");
      const lockDir = attemptLockDir(dir, TASK);
      fs.symlinkSync(lockDir, lockDir);
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain('The verdict marker for "task-42" was read but is not a valid verdict record');
      expect(reason).toMatch(/liveness could not be determined/);
      expect(reason).not.toMatch(/no attempt reads as currently live/);
      expect(reason).not.toContain("is still live");
      expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
    });

    // Indeterminate liveness on reading (1) where ONLY the lock path is
    // unreadable: the verdict directory itself is fine and carries no
    // marker, while the `.lock` path is a self-referential symlink
    // (`fs.statSync` throws `ELOOP`). The note must name what could not be
    // read without attributing a cause it did not establish: an earlier
    // version said "the verdict directory could not be read", which is
    // false here (harness/799de976).
    it("indeterminate liveness on reading (1) with a readable verdict dir: the note attributes no cause", async () => {
      const dir = verdictDirWith(null);
      const lockDir = attemptLockDir(dir, TASK);
      fs.symlinkSync(lockDir, lockDir);
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toMatch(/liveness could not be determined/);
      expect(reason).not.toContain("the verdict directory could not be read");
      expect(reason).not.toContain('No verdict marker exists for "task-42"');
      expect(reason).not.toMatch(/no attempt reads as currently live/);
      expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
    });

    it("reading (2) live-attempt: a held (non-stale) attempt-lock, the full reconnect-vs-retry paragraph, plus the facts", async () => {
      const dir = verdictDirWith(null);
      cleanups.push(liveAttemptLock(dir, TASK));
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain('A solution_evaluate attempt for "task-42" is still live');
      expect(reason).toMatch(/attempt-lock anchor is held/);
      expect(reason).not.toContain('No verdict marker exists for "task-42"');
      // The producer-version qualifier: this reconnect lifecycle is verified
      // against grounding-mcp >= 0.11.0, not the pack's own (older) producer
      // floor (>= 0.3.2), so the deny must not assert it unconditionally.
      expect(reason).toMatch(/With grounding-mcp >= 0\.11\.0:/);
      expect(reason).toMatch(/no readable verdict marker/);
      // An earlier review finding (MEDIUM, tests): pin the reconnect paragraph
      // by asserting the hook's reason CONTAINS the shared module's own
      // rendered output verbatim, not by hand-restating its sentences as
      // separate substrings here (a hook-side copy that had drifted from
      // the module by one word still satisfied every hand-restated
      // substring below, so a copy survived). A byte-identical copy is
      // unobservable by construction and is not itself a probe; what this
      // containment assertion actually discriminates is a hook that stops
      // calling `renderReconnectDenyParagraph` and inlines its own text
      // instead (the call site patched to a literal copy differing by
      // one word no longer produces a `reason` that contains this exact
      // string).
      expect(reason).toContain(renderReconnectDenyParagraph(TASK));
    });

    // Stale-lock regression: a lock directory left by a
    // DEAD process (mtime past ATTEMPT_LOCK_STALE_MS, grounding-mcp's own
    // DEFAULT_ATTEMPT_LOCK_STALE_MS = 30_000, solution-attempt-log.ts:102 at
    // v0.12.0) must NOT read as live: otherwise a crashed attempt would
    // wedge every future denial behind "reconnect" guidance forever, since
    // nothing else ever clears a lock directory `proper-lockfile` left
    // behind.
    it("a STALE attempt-lock (past ATTEMPT_LOCK_STALE_MS) does not count as live", async () => {
      const dir = verdictDirWith(null);
      staleAttemptLock(dir, TASK);
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain('No verdict marker exists for "task-42"');
      expect(reason).not.toContain("is still live");
      expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
    });

    // Error-path regression: `checkFileLock`
    // (`src/io/lock.ts`) must read "unknown", not "live" and not silently
    // "not-live", when its underlying `checkSync` throws something other
    // than ENOENT. Pointing `verdictDir` at a REGULAR FILE forces this:
    // every path proper-lockfile's `check` joins onto it
    // (`<file>/<id>.attempt-lock.lock`) fails `stat` with ENOTDIR, not
    // ENOENT, and `lib/lockfile.js`'s `check` only swallows ENOENT
    // (rethrows everything else), so `checkSync` throws for real rather
    // than resolving "not locked". `readVerdict` and the marker-presence
    // probe both degrade to "missing" the same way (their shared
    // `lstatOrNull` catches every stat failure), so this lands on reading
    // (1)'s never-evaluated branch with an "unknown" liveness, exactly the
    // combination the softened wording above exists for: it must say
    // liveness could not be determined, not assert absence.
    it("an unreadable attempt-lock check (ENOTDIR) reads liveness as unknown, and the note does not assert absence", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-verdict-not-a-dir-"));
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
      const notADir = path.join(root, "verdict-dir-is-actually-a-file");
      fs.writeFileSync(notADir, "");
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: notADir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
      expect(reason).not.toContain("is still live");
      expect(reason).not.toMatch(/no attempt reads as currently live/);
      expect(reason).toMatch(/liveness could not be determined/);
      // Neither axis is established, so the note asserts neither.
      expect(reason).not.toContain('No verdict marker exists for "task-42"');
      expect(reason).not.toMatch(/has not \(yet\) been called/);
    });

    it("pins the stale window to the producer's documented default (30 s)", () => {
      // grounding-mcp-v0.12.0 solution-attempt-log.ts:102, DEFAULT_ATTEMPT_LOCK_STALE_MS.
      // A narrower window would read a live attempt (mtime refreshed every
      // stale/2 by proper-lockfile) as stale; the stale fixture above only
      // catches widenings.
      expect(ATTEMPT_LOCK_STALE_MS).toBe(30_000);
    });

    // `realpath: false` regression: making `liveAttemptLock` above acquire
    // the REAL anchor file (fixture-fidelity fix) means the anchor now
    // always exists in every other case here, so `realpath: true` v.
    // `false` stopped being observable through any of them (both resolve
    // the SAME path when the anchor is a plain file). The one case that
    // still discriminates is a SYMLINKED anchor: `checkFileLock`'s own doc
    // comment (`src/io/lock.ts`) says `realpath: false` checks the lock
    // path at its own literal path and stats its OWN `.lock` sibling
    // without following a symlink first. A fresh lock dir sits at the
    // symlink's own literal path here, not at its target's, so
    // `realpath: true` would resolve the symlink, find no `.lock` there
    // (ENOENT, ordinary "not locked"), and miss the live lock entirely.
    // Builds the lock through the REAL `proper-lockfile` acquisition
    // (`lockfile.lockSync`, the same call `liveAttemptLock` above makes)
    // rather than a hand-built `.lock` directory, so this exercises the
    // library's actual on-disk lock state at a symlinked anchor, not a
    // guess at its shape.
    it("a SYMLINKED attempt-lock anchor still reads its OWN (unresolved) lock, not its target's", async () => {
      const dir = verdictDirWith(null);
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "sa-anchor-target-"));
      cleanups.push(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
      const target = path.join(elsewhere, "unrelated-file");
      fs.writeFileSync(target, "");
      const anchor = path.join(dir, `${TASK}.attempt-lock`);
      fs.symlinkSync(target, anchor);
      cleanups.push(lockfile.lockSync(anchor, { stale: ATTEMPT_LOCK_STALE_MS, realpath: false }));
      const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: dir });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain('A solution_evaluate attempt for "task-42" is still live');
      expect(reason).toMatch(/attempt-lock anchor is held/);
    });
  });

  it("BLOCKS a not-ready verdict and surfaces the blockers", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { ready: false, blockers: ["2 tests failing"] }),
    });
    expect(res.blocked).toBe(true);
    const { reason } = JSON.parse(out) as { reason: string };
    expect(reason).toMatch(/not ready: 2 tests failing/);
    // A not-ready verdict means a run already completed and produced a
    // marker: there is no "is it still running" ambiguity here, so the
    // reconnect-vs-retry guidance does not apply.
    expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
  });

  it("BLOCKS a verdict recorded at a different HEAD (drift)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: OTHER, ready: true }),
    });
    expect(res.blocked).toBe(true);
    const { reason } = JSON.parse(out) as { reason: string };
    expect(reason).toMatch(/stale/);
    // Same rationale as the not-ready case: a stale verdict is a completed
    // run, not an in-flight one.
    expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
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

  it("does not carry the reconnect-vs-retry guidance on the manifest-load-failure failsafe deny", async () => {
    // Earlier review finding (LOW, tests): the reconnect paragraph must not
    // appear on the manifest-load-failure failsafe path either (blockJson's
    // `nullVerdictReading` parameter defaults to `null` there, same as the
    // no-verdict-id path). Force a real load failure (no injected manifest,
    // a `configPath` naming a file that does not exist) rather than
    // asserting against the default-parameter plumbing indirectly.
    const stdout = captureStream();
    const stderr = captureStream();
    const noManifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-hook-no-manifest-"));
    cleanups.push(() => fs.rmSync(noManifestDir, { recursive: true, force: true }));
    const res = await runPackHookSolutionAcceptanceCli({
      stdin: streamFrom(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: TASK_FINISH,
          cwd: repoAtHead(HEAD),
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      configPath: path.join(noManifestDir, "harness.yaml"),
      env: {},
    });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(stdout.output()).reason as string;
    expect(reason).toMatch(/manifest load failed/);
    expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
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
    // Earlier review finding (LOW, tests): the reconnect-vs-retry guidance
    // is gated on `nullVerdictReading` being `"live-attempt"`, and
    // `nullVerdictReading` defaults to `null` at every OTHER call site
    // (this one included, since there is no id to poll for yet), so the
    // paragraph must not appear here. Unpinned before this assertion:
    // flipping the default to `true` survived every existing test.
    expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
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

// State table for the agent-facing null-verdict note (harness/799de976).
// Invariant: every note state renders exactly one line, that line states
// only what the gate established, and no other state's line appears with
// it. The table is also the checklist for extending the classifier: the
// coverage test below iterates `NULL_VERDICT_NOTE_STATES` and fails when a
// member has no row here, and the renderer's own `Record` type fails the
// build when a member has no line. The review history that forced this
// (one defect class found in five consecutive rounds, each fix falsified
// by the next reachable state) is in the CHANGELOG entry for this task.
describe("null-verdict deny note: one exact line per reachable state", () => {
  const UNUSABLE_ID = 'The claimed id "." is not a usable verdict id: no verdict marker path and no attempt-lock path can be derived from it, so neither was read. Release the active claim carrying it (mcp__agent-tasks__task_abandon, or have the operator clear harness.generated/active-claim), claim the real task, then run solution_evaluate for it.';
  const NEVER_NOT_LIVE =
    'No verdict marker exists for "task-42"; no attempt reads as currently live: solution_evaluate has not (yet) been called for this id, or a prior call never got far enough to record one.';
  const NEVER_UNKNOWN =
    'No readable verdict marker for "task-42" and liveness could not be determined: run solution_evaluate for this id.';
  const INVALID_RECORD_NOT_LIVE =
    'The verdict marker for "task-42" was read but is not a valid verdict record; no attempt reads as currently live: re-run solution_evaluate to record a fresh one.';
  const INVALID_RECORD_UNKNOWN =
    'The verdict marker for "task-42" was read but is not a valid verdict record; liveness could not be determined: re-run solution_evaluate to record a fresh one.';
  const MARKER_SYMLINK =
    'The verdict marker path for "task-42" is a symlink, which this gate refuses to follow; no attempt reads as currently live: replace it with a marker recorded by solution_evaluate.';
  const MARKER_NOT_REGULAR =
    'The verdict marker path for "task-42" is not a regular file; no attempt reads as currently live: replace it with a marker recorded by solution_evaluate.';
  const MARKER_UNREADABLE =
    'The verdict marker for "task-42" could not be read; no attempt reads as currently live: re-run solution_evaluate to record a fresh one.';
  const LIVE = 'A solution_evaluate attempt for "task-42" is still live: its attempt-lock anchor is held.';
  const ALL_LINES = [
    UNUSABLE_ID,
    NEVER_NOT_LIVE,
    NEVER_UNKNOWN,
    INVALID_RECORD_NOT_LIVE,
    INVALID_RECORD_UNKNOWN,
    MARKER_SYMLINK,
    MARKER_NOT_REGULAR,
    MARKER_UNREADABLE,
    LIVE,
  ];

  /** A verdict dir whose `<id>.attempt-lock.lock` path cannot be statted (ELOOP). */
  function lockPathUnreadable(dir: string): string {
    const lockDir = attemptLockDir(dir, TASK);
    fs.symlinkSync(lockDir, lockDir);
    return dir;
  }

  const cases: Array<{
    state: string;
    noteState: NullVerdictNoteState;
    setup: () => { verdictDir: string; activeClaim?: string };
    expected: string;
  }> = [
    {
      state: "id not usable (active claim '.'), nothing read at all",
      noteState: "unusable-id",
      setup: () => ({ verdictDir: verdictDirWith(null), activeClaim: "." }),
      expected: UNUSABLE_ID,
    },
    {
      state: "reading (1) never-evaluated + liveness not-live",
      noteState: "never-evaluated",
      setup: () => ({ verdictDir: verdictDirWith(null) }),
      expected: NEVER_NOT_LIVE,
    },
    {
      state: "reading (1) never-evaluated + liveness unknown (ELOOP on the lock path only)",
      noteState: "never-evaluated",
      setup: () => ({ verdictDir: lockPathUnreadable(verdictDirWith(null)) }),
      expected: NEVER_UNKNOWN,
    },
    {
      state: "reading (1) never-evaluated + liveness unknown (ENOTDIR: the verdict dir is a file)",
      noteState: "never-evaluated",
      setup: () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-note-table-notdir-"));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
        const notADir = path.join(root, "verdict-dir-is-actually-a-file");
        fs.writeFileSync(notADir, "");
        return { verdictDir: notADir };
      },
      expected: NEVER_UNKNOWN,
    },
    {
      state: "reading (3) marker read but unparseable + liveness not-live",
      noteState: "marker-invalid-record",
      setup: () => {
        const dir = verdictDirWith(null);
        fs.writeFileSync(path.join(dir, `${TASK}.json`), "{not valid json");
        return { verdictDir: dir };
      },
      expected: INVALID_RECORD_NOT_LIVE,
    },
    {
      state: "reading (3) marker read but missing a required field + liveness not-live",
      noteState: "marker-invalid-record",
      setup: () => {
        const dir = verdictDirWith(null);
        // Parses fine, but `ready` is absent: the reader answers the SAME
        // kind as unparseable JSON, so both render one line, not two.
        fs.writeFileSync(path.join(dir, `${TASK}.json`), JSON.stringify({ id: TASK, head: HEAD }));
        return { verdictDir: dir };
      },
      expected: INVALID_RECORD_NOT_LIVE,
    },
    {
      state: "reading (3) marker path is a SYMLINK, refused by policy without being read + not-live",
      noteState: "marker-symlink",
      setup: () => {
        const dir = verdictDirWith(null);
        const target = path.join(dir, "real-marker.json");
        fs.writeFileSync(target, JSON.stringify({ id: TASK, head: HEAD, ready: true }));
        fs.symlinkSync(target, path.join(dir, `${TASK}.json`));
        return { verdictDir: dir };
      },
      expected: MARKER_SYMLINK,
    },
    {
      state: "reading (3) marker path is a DIRECTORY (not a regular file) + not-live",
      noteState: "marker-not-regular",
      setup: () => {
        const dir = verdictDirWith(null);
        fs.mkdirSync(path.join(dir, `${TASK}.json`));
        return { verdictDir: dir };
      },
      expected: MARKER_NOT_REGULAR,
    },
    {
      state: "reading (3) marker is a regular file the process may not read (EACCES) + not-live",
      noteState: "marker-unreadable",
      setup: () => {
        const dir = verdictDirWith(null);
        const marker = path.join(dir, `${TASK}.json`);
        fs.writeFileSync(marker, JSON.stringify({ id: TASK, head: HEAD, ready: true }));
        fs.chmodSync(marker, 0o000);
        // The enclosing directory stays writable, so the afterEach cleanup
        // removes the file regardless of its own mode.
        return { verdictDir: dir };
      },
      expected: MARKER_UNREADABLE,
    },
    {
      state: "reading (3) marker read but unparseable + liveness unknown (ELOOP)",
      noteState: "marker-invalid-record",
      setup: () => {
        const dir = verdictDirWith(null);
        fs.writeFileSync(path.join(dir, `${TASK}.json`), "{not valid json");
        return { verdictDir: lockPathUnreadable(dir) };
      },
      expected: INVALID_RECORD_UNKNOWN,
    },
    {
      state: "reading (2) a live attempt-lock is held",
      noteState: "live-attempt",
      setup: () => {
        const dir = verdictDirWith(null);
        cleanups.push(liveAttemptLock(dir, TASK));
        return { verdictDir: dir };
      },
      expected: LIVE,
    },
  ];

  for (const c of cases) {
    // The EACCES fixture cannot discriminate for a process that ignores
    // file modes; skipping is honest, silently passing would not be.
    const runCase = c.noteState === "marker-unreadable" && process.getuid?.() === 0 ? it.skip : it;
    runCase(`renders exactly one established line: ${c.state}`, async () => {
      const { verdictDir, activeClaim } = c.setup();
      const { res, out } = await run({
        cwd: repoAtHead(HEAD),
        verdictDir,
        ...(activeClaim !== undefined && { activeClaim }),
      });
      expect(res.blocked).toBe(true);
      const { reason } = JSON.parse(out) as { reason: string };
      expect(reason).toContain(c.expected);
      // No OTHER state's line may appear: the renderer emits the one line
      // for the state it classified, never a second one and never the
      // wrong one.
      for (const other of ALL_LINES.filter((l) => l !== c.expected)) {
        expect(reason).not.toContain(other);
      }
    });
  }

  // Coverage, the mechanism behind "the table is the checklist": a state
  // added to `NULL_VERDICT_NOTE_STATES` without a fixture here fails, so
  // extending the classifier cannot silently ship an unpinned line. The
  // renderer's own `Record<NullVerdictNoteState, ...>` covers the other
  // half at compile time (a state with no line fails the build).
  it("covers every declared note state with at least one fixture", () => {
    const covered = new Set(cases.map((c) => c.noteState));
    expect([...NULL_VERDICT_NOTE_STATES].filter((s) => !covered.has(s))).toEqual([]);
  });

  // The finding that motivated the table (round 5): with an unusable id
  // NOTHING is read and NO liveness is established, so the note must
  // claim neither. Asserted as absences on top of the exact line above,
  // so a re-worded line that reintroduces either claim cannot pass by
  // simply changing the expected constant in lockstep.
  it("the unusable-id line claims no read and no liveness result", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      activeClaim: ".",
    });
    expect(res.blocked).toBe(true);
    const { reason } = JSON.parse(out) as { reason: string };
    expect(reason).not.toContain("could not be read");
    expect(reason).not.toContain("liveness could not be determined");
    expect(reason).not.toContain("no attempt reads as currently live");
    // "run solution_evaluate for this id" is unactionable for an id
    // `sanitizeVerdictId` rejects: the remedy names a usable id instead.
    expect(reason).not.toContain("run solution_evaluate for this id");
    expect(reason).not.toMatch(/Reconnecting vs\. retrying/);
  });
});
