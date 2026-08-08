// `harness session-start stale-base-check` — SessionStart hook
// entrypoint, fourth sibling of `harness session-start preflight` /
// `branch-check` / `toolchain-parity`.
//
// Incident (task ea8becf5): a task branch was cut from a local `master`
// that had not been fetched in 4 days. The v0.42.0 release had already
// landed on `origin/master` 6h before the branch point. The resulting PR
// went straight to CONFLICTING and its CI never ran. Nothing surfaced the
// gap at the time it was still cheap to fix (before work landed on the
// branch), because:
//   - `harness preflight` checks the working TREE, never the remote.
//   - `harness session-start branch-check` reads `.git/HEAD` and a
//     protected-branch list; it has no notion of "is this branch's base
//     current".
//   - the post-merge-gate convention only ever fires AFTER a merge.
// And the obvious-looking fix is itself the trap this module exists to
// avoid: `git merge-base HEAD origin/master` LOOKS authoritative, but
// `origin/master` is a LOCAL, cached ref — exactly the ref that was 4
// days stale in the incident. Computing "how stale" from a stale ref
// answers a different question than the one that matters.
//
// --- WHERE this sits (task brief step 3) ---
// SessionStart companion, not a `preflight`-check addition and not a
// PreToolUse gate:
//   - `harness policy intercept` (the PreToolUse hot path, evaluated on
//     EVERY Bash/Edit/Write tool call — see runtime/intercept.ts) must
//     never do network I/O; a `git fetch` there would add real latency to
//     every single tool call for the life of the session. This module is
//     wired ONLY under `harness session-start ...` (this file lives in
//     src/cli/, which src/runtime/intercept.ts is structurally forbidden
//     from importing — enforced by .dependency-cruiser.cjs's
//     "runtime-no-upward-imports" rule, i.e. `npm run check:boundaries`
//     fails the build if that ever changes), so the one network call this
//     module makes can only ever happen once per SessionStart, never on
//     the hot path.
//   - `agent-preflight` (the external `preflight` binary
//     `session-start/index.ts` wraps) is a SEPARATE npm package; teaching
//     it to do remote checks is out of this task's scope (task brief
//     "Out of scope").
//   - A PreToolUse gate (`requires.ledger_tag`-style, like
//     `preflight-before-push`) was considered and REJECTED: every such
//     gate in this codebase fails CLOSED for a SECURITY invariant (an
//     absent/expired tag blocks the action). A stale base is a
//     time-loss problem, not a security problem — blocking on it would
//     violate the task's hard constraint ("Keine Aussperrung: ein
//     veralteter Base darf die Arbeit nicht verhindern") for zero
//     security benefit. A SessionStart producer's own contract
//     (`blocking:false`, always exit 0) makes the non-blocking posture
//     structural rather than a policy authors could get wrong later.
//
// --- SCHÄRFE (severity) chosen: WARNUNG, not Hinweis, not Block ---
//   - Block is impossible by construction here (see above) and would
//     directly violate the hard constraint anyway.
//   - A quiet Hinweis (a single low-key note easy to scroll past) risks
//     reproducing the founding incident's own failure mode almost
//     exactly: "nichts fiel auf" is the whole reason this task exists.
//   - So: a loud stderr WARNING line — same visibility tier as the two
//     existing loud-but-non-blocking SessionStart producers
//     (`toolchain-parity`'s drift lines, `preflight`'s not-ready
//     diagnostic) — naming the concrete commit count, how old the missing
//     work is, and the exact recovery command. Purely advisory: no
//     PreToolUse gate consumes the `stale-base:` ledger fact this writes
//     (same posture as `toolchain-parity:`, audit-trail only for
//     `harness audit`/forensics).
//
// --- Fetch cost / why opt-in (task brief: "inkl. Fetch-Kosten") ---
// `stale_base_check.enabled` defaults to `false` (schema:
// src/schema/stale-base-check.ts). An operator who has not asked for
// this pays ZERO extra session-start latency or network egress — the
// producer returns before touching `child_process` at all when
// unconfigured. Once enabled, the cost is bounded by
// `fetch_timeout_ms` (default 8000ms) per `git` subprocess call (at most
// three: fetch, rev-list, log — see `realCheckStaleBase` below), and the
// fetch itself is normally near-instant: `git fetch <remote>
// <defaultBranch>` only ever needs to transfer the commits this checkout
// doesn't already have. It always writes `FETCH_HEAD`; on a normal clone
// (whose configured `remote.<remote>.fetch` refspec matches the named
// branch) `git` ALSO refreshes the local `refs/remotes/<remote>/
// <defaultBranch>` tracking ref as a side effect — a welcome bonus (it
// self-heals the exact staleness the incident hit) but never something
// this module relies on or reads back: see below.
//
// --- The ref-staleness trap, closed ---
// The remote's default-branch NAME (e.g. "master") is resolved from the
// local `refs/remotes/origin/HEAD` file via `resolveOriginHeadBase` — that
// is safe to trust: a repo's default branch NAME essentially never
// changes after initial setup. What must NEVER be trusted is that same
// ref's SHA as a staleness signal — that is precisely what went stale in
// the incident. This module never READS a local `refs/remotes/<remote>/
// <defaultBranch>` sha for comparison (regardless of whether the fetch
// above happened to refresh it); the only sha it ever compares `branch`
// against is `FETCH_HEAD`, populated by a live `git fetch` performed
// THIS run.
//
// SessionStart contract, same as the three siblings: `blocking:false`.
// Every failure path (not configured, not a git repo, detached HEAD,
// default branch unresolved, `git` not on PATH, no remote configured, no
// credentials, offline/timeout, unparseable output, a ledger-write
// failure) logs one line to stderr and exits 0 — never blocking, never
// throwing (except the hermetic-spawn-guard violation under vitest
// without an injected `runCheck`, which — like the sibling producers —
// must propagate rather than be swallowed; see hermetic-spawn-guard.ts).

import { execFile } from "node:child_process";
import {
  findGitEntry,
  resolveCommonDir,
  resolveGitContext,
  resolveOriginHeadBase,
} from "../../runtime/git-context.js";
import { assertNoRealSpawnInTests } from "../../runtime/hermetic-spawn-guard.js";
import { resolveManifestLedgerWriter } from "../../runtime/ledger-writer.js";
import {
  resolveReadSessionId,
  type ResolveReadSessionOptions,
} from "../../runtime/session-id.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import { formatSnapshotAge } from "./toolchain-parity.js";

const FALLBACK_SESSION = "default";
const LEDGER_SOURCE = "harness-session-start-stale-base-check";
const DEFAULT_REMOTE = "origin";
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

interface SessionStartEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------
// The live check: fetch + ahead/behind + (when behind) the newest
// missing commit's sha/date. Injectable — see runCheck below.
// ---------------------------------------------------------------------

export interface StaleBaseCheckArgs {
  cwd: string;
  remote: string;
  defaultBranch: string;
  branch: string;
  timeoutMs: number;
}

export type StaleBaseCheckResult =
  | {
      ok: true;
      /** Commits on `branch` not reachable from the live remote tip. */
      aheadCount: number;
      /** Commits on the live remote tip not reachable from `branch` — the staleness signal. */
      behindCount: number;
      /** Only set when `behindCount > 0`: the live remote tip's own sha. */
      remoteSha?: string;
      /** Only set when `behindCount > 0`: ISO commit date of the live remote tip. */
      latestRemoteCommitIso?: string;
    }
  | { ok: false; reason: string };

interface ExecGitResult {
  ok: boolean;
  stdout: string;
  reason: string;
}

/**
 * Run one `git <args>` in `cwd`, classifying the common failure shapes
 * (missing binary / timeout / non-zero exit) the same way the sibling
 * producers' subprocess wrappers do (`spawnPreflight` in
 * session-start/index.ts, `realNpmGlobalsSpawn` in toolchain-parity.ts).
 * Never rejects.
 */
function execGit(args: string[], cwd: string, timeoutMs: number): Promise<ExecGitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const text = (stdout ?? "").toString().trim();
        if (!err) {
          resolve({ ok: true, stdout: text, reason: "" });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") {
          resolve({ ok: false, stdout: "", reason: "`git` not on PATH" });
          return;
        }
        if (e.killed) {
          resolve({
            ok: false,
            stdout: "",
            reason: `\`git ${args.join(" ")}\` timed out after ${timeoutMs}ms (remote unreachable or very slow)`,
          });
          return;
        }
        const stderrText = (stderr ?? "").toString().trim().split("\n")[0] ?? "";
        const capped = stderrText.length > 200 ? `${stderrText.slice(0, 199)}…` : stderrText;
        resolve({
          ok: false,
          stdout: "",
          reason: `\`git ${args.join(" ")}\` failed${capped ? `: ${capped}` : ` (exit ${e.code ?? "?"})`}`,
        });
      },
    );
  });
}

/**
 * The real, network-touching implementation. Guarded by
 * `assertNoRealSpawnInTests` (see that module's doc) so an un-injected
 * test can never accidentally exercise a real `git fetch` — every test in
 * this module's suite either injects `runCheck` or opts into the real
 * path via the documented `HARNESS_ALLOW_REAL_SPAWN=1` escape hatch
 * against a local fixture repo (never a real network host).
 *
 * Sequence: `git fetch --no-tags <remote> <defaultBranch>` (always writes
 * FETCH_HEAD; may also refresh the local remote-tracking ref as a normal
 * git side effect — see the module header), then `git rev-list
 * --left-right --count <branch>...FETCH_HEAD` for the ahead/behind counts,
 * then — only when behind > 0, since that is the only case the caller's
 * message needs it — `git log -1 --format=%H%x09%cI FETCH_HEAD` for the
 * live remote tip's sha + committer date. Comparison is always against
 * `FETCH_HEAD` (this run's live result), never a cached tracking ref.
 */
function realCheckStaleBase(args: StaleBaseCheckArgs): Promise<StaleBaseCheckResult> {
  assertNoRealSpawnInTests(
    "git fetch (stale-base-check)",
    "Inject a fake `runCheck` (SessionStartStaleBaseCheckOptions.runCheck), or opt into the " +
      "real path against a LOCAL fixture repo via HARNESS_ALLOW_REAL_SPAWN=1 for a dedicated " +
      "real-git plumbing test — never exercise this against a real network host in a test.",
  );
  const { cwd, remote, defaultBranch, branch, timeoutMs } = args;
  return (async (): Promise<StaleBaseCheckResult> => {
    const fetch = await execGit(["fetch", "--no-tags", "--", remote, defaultBranch], cwd, timeoutMs);
    if (!fetch.ok) return { ok: false, reason: fetch.reason };

    const counts = await execGit(
      ["rev-list", "--left-right", "--count", `${branch}...FETCH_HEAD`],
      cwd,
      timeoutMs,
    );
    if (!counts.ok) return { ok: false, reason: counts.reason };
    const parts = counts.stdout.split(/\s+/).filter((p) => p.length > 0);
    const aheadCount = Number.parseInt(parts[0] ?? "", 10);
    const behindCount = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(aheadCount) || !Number.isFinite(behindCount)) {
      return { ok: false, reason: `\`git rev-list --left-right --count\` produced unparseable output: "${counts.stdout}"` };
    }
    if (behindCount === 0) return { ok: true, aheadCount, behindCount };

    const log = await execGit(["log", "-1", "--format=%H%x09%cI", "FETCH_HEAD"], cwd, timeoutMs);
    if (!log.ok) {
      // The counts themselves are still good evidence — degrade the
      // extra detail, not the whole result.
      return { ok: true, aheadCount, behindCount };
    }
    const [remoteSha, latestRemoteCommitIso] = log.stdout.split("\t");
    return {
      ok: true,
      aheadCount,
      behindCount,
      ...(remoteSha ? { remoteSha } : {}),
      ...(latestRemoteCommitIso ? { latestRemoteCommitIso } : {}),
    };
  })();
}

// ---------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------

export interface SessionStartStaleBaseCheckOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (SessionStart). */
  stderr?: NodeJS.WritableStream;
  /** Explicit session id (overrides every other source). */
  session?: string;
  /** Override the cwd resolution (test injection). Falls back to event.cwd then process.cwd(). */
  cwd?: string;
  /** Override "now" for deterministic age-formatting tests. */
  now?: Date;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject a manifest (tests). Bypasses loadManifest. */
  manifest?: Manifest;
  /** Inject the ledger writer (tests). */
  writeLedger?: (args: {
    sessionId: string;
    content: string;
    source: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** Inject the read-path session resolver (env + transcript discovery). Test seam. */
  resolveSession?: (explicit: string | undefined, opts: ResolveReadSessionOptions) => string;
  /** Inject the live check (tests) — see realCheckStaleBase's doc. */
  runCheck?: (args: StaleBaseCheckArgs) => Promise<StaleBaseCheckResult>;
}

export interface SessionStartStaleBaseCheckResult {
  /** Always 0 — a SessionStart hook must never break the session loop. */
  exitCode: number;
  /** Whether the `stale-base:` ledger fact was written. */
  wrote: boolean;
  /** Resolved repo name. */
  repo: string;
  /** Resolved branch ("" if detached or outside a repo). */
  branch: string;
  /** Commits the branch's base is behind the live remote default, when the check ran. */
  behindCount?: number;
  /** Resolved session id. */
  sessionId: string;
  sessionSource: "flag" | "stdin" | "env" | "transcript" | "default";
  /** Human-readable explanation of a non-write outcome, for diagnostics. */
  reason?: string;
}

export async function runSessionStartStaleBaseCheck(
  opts: SessionStartStaleBaseCheckOptions = {},
): Promise<SessionStartStaleBaseCheckResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const now = opts.now ?? new Date();
  const note = (msg: string): void => {
    stderr.write(`harness session-start stale-base-check: ${msg}\n`);
  };
  const done = (
    wrote: boolean,
    repo: string,
    branch: string,
    sessionId: string,
    sessionSource: SessionStartStaleBaseCheckResult["sessionSource"],
    reason?: string,
    behindCount?: number,
  ): SessionStartStaleBaseCheckResult => ({
    exitCode: 0,
    wrote,
    repo,
    branch,
    sessionId,
    sessionSource,
    ...(behindCount !== undefined && { behindCount }),
    ...(reason !== undefined && { reason }),
  });

  let event: SessionStartEvent;
  try {
    event = JSON.parse((await readStdin(stdin)).trim() || "{}") as SessionStartEvent;
  } catch (err) {
    const reason = `malformed event JSON: ${(err as Error).message}`;
    note(reason);
    return done(false, "", "", FALLBACK_SESSION, "default", reason);
  }

  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();

  const explicit =
    typeof opts.session === "string" && opts.session.length > 0
      ? opts.session
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? event.session_id
        : undefined;
  const resolveSession = opts.resolveSession ?? resolveReadSessionId;
  const sessionId = resolveSession(explicit, {});
  const sessionSource: SessionStartStaleBaseCheckResult["sessionSource"] =
    typeof opts.session === "string" && opts.session.length > 0
      ? "flag"
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? "stdin"
        : sessionId === FALLBACK_SESSION
          ? "default"
          : (typeof process.env.CLAUDE_CODE_SESSION_ID === "string" &&
              process.env.CLAUDE_CODE_SESSION_ID === sessionId) ||
              (typeof process.env.CLAUDE_SESSION_ID === "string" &&
                process.env.CLAUDE_SESSION_ID === sessionId)
            ? "env"
            : "transcript";

  let manifest: Manifest;
  if (opts.manifest) {
    manifest = opts.manifest;
  } else {
    try {
      manifest = loadManifest(opts).manifest;
    } catch (err) {
      const reason = `manifest load failed: ${(err as Error).message}`;
      note(reason);
      return done(false, "", "", sessionId, sessionSource, reason);
    }
  }

  const config = manifest.stale_base_check;
  if (!config.enabled) {
    const reason =
      "not configured (add `stale_base_check: { enabled: true }` to harness.yaml); skipping — no network touched";
    note(reason);
    return done(false, "", "", sessionId, sessionSource, reason);
  }

  const { repo, branch } = resolveGitContext(cwd);
  if (repo === "") {
    const reason = `cwd is not inside a git work tree (${cwd}); nothing to check`;
    note(reason);
    return done(false, "", "", sessionId, sessionSource, reason);
  }
  if (branch === "") {
    const reason = "detached HEAD (or unreadable HEAD) — no branch to check a base for";
    note(reason);
    return done(false, repo, "", sessionId, sessionSource, reason);
  }

  const remote = config.remote ?? DEFAULT_REMOTE;
  const timeoutMs = config.fetch_timeout_ms ?? DEFAULT_FETCH_TIMEOUT_MS;

  let defaultBranch = config.default_branch;
  if (!defaultBranch) {
    // NOTE: `resolveOriginHeadBase` reads `refs/remotes/origin/HEAD`
    // specifically (hardcoded "origin" — see runtime/git-context.ts), not
    // `refs/remotes/<remote>/HEAD`. For the overwhelming common case
    // (`remote` left at its "origin" default) this is exactly right. A
    // manifest that configures a NON-"origin" `remote` without also
    // setting `default_branch` explicitly will fail this auto-resolution
    // and fall into the "could not be resolved" degrade path below —
    // fail-open (skip, no fact written), never a wrong/misleading result,
    // so this is a completeness gap, not a correctness risk.
    const gitDir = findGitEntry(cwd)?.gitDir;
    defaultBranch = gitDir ? (resolveOriginHeadBase(resolveCommonDir(gitDir)) ?? undefined) : undefined;
  }
  if (!defaultBranch) {
    const reason =
      `default branch could not be resolved (checked \`stale_base_check.default_branch\` and ` +
      `refs/remotes/${remote}/HEAD / packed-refs); skipping. Set \`stale_base_check.default_branch\` ` +
      "explicitly to fix this.";
    note(reason);
    return done(false, repo, branch, sessionId, sessionSource, reason);
  }

  if (branch === defaultBranch) {
    const reason = `on ${defaultBranch} itself; nothing to compare a base against`;
    note(reason);
    return done(false, repo, branch, sessionId, sessionSource, reason);
  }

  const runCheck = opts.runCheck ?? realCheckStaleBase;
  const result = await runCheck({ cwd, remote, defaultBranch, branch, timeoutMs });
  if (!result.ok) {
    // Fail-open by construction (task hard constraint): every reason here
    // — no remote configured, no credentials, offline, timeout, git
    // missing — degrades to "no fact written", never a thrown error and
    // never a block. A stale base costs time, not safety.
    note(`${result.reason} — degrading cleanly (not blocking; the base-staleness check is advisory-only)`);
    return done(false, repo, branch, sessionId, sessionSource, result.reason);
  }

  const remoteRef = `${remote}/${defaultBranch}`;
  if (result.behindCount === 0) {
    note(`base is current with ${remoteRef} (live check via \`git fetch\`)`);
  } else {
    const ageSuffix = result.latestRemoteCommitIso
      ? ` (newest missing commit landed ${formatSnapshotAge(
          Math.max(0, now.getTime() - Date.parse(result.latestRemoteCommitIso)),
        )} ago, ${result.latestRemoteCommitIso})`
      : "";
    const aheadSuffix = result.aheadCount > 0 ? `; this branch itself is ${result.aheadCount} commit(s) ahead of that base` : "";
    note(
      `WARNING: this branch's base is ${result.behindCount} commit(s) behind ${remoteRef}${ageSuffix}${aheadSuffix}. ` +
        `This is a LIVE check (a real \`git fetch\`, not the local ${remoteRef} ref, which may itself be stale). ` +
        `Recommended before continuing: \`git fetch ${remote} && git rebase ${remoteRef}\` (or merge) — ` +
        "otherwise this PR risks landing CONFLICTING with CI never running (the incident this check exists to catch).",
    );
  }

  const content =
    result.behindCount === 0
      ? `stale-base:${repo}:${branch} ok base:${remoteRef}`
      : `stale-base:${repo}:${branch} behind:${result.behindCount} ahead:${result.aheadCount} base:${remoteRef}` +
        (result.remoteSha ? ` remote_sha:${result.remoteSha}` : "");

  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    const resolved = resolveManifestLedgerWriter(manifest, {
      ...(opts.ledgerTimeoutMs !== undefined ? { ledgerTimeoutMs: opts.ledgerTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      const reason = `${resolved.reason}; cannot record ${content}`;
      note(reason);
      return done(false, repo, branch, sessionId, sessionSource, reason, result.behindCount);
    }
    writeLedger = resolved.write;
  }

  const written = await writeLedger({ sessionId, content, source: LEDGER_SOURCE });
  if (!written.ok) {
    const reason = `ledger write failed: ${written.reason ?? "unknown error"}`;
    note(reason);
    return done(false, repo, branch, sessionId, sessionSource, reason, result.behindCount);
  }
  note(`recorded ${content} for session ${sessionId}`);
  if (sessionSource === "default") {
    note(
      "WARNING: session resolved to the literal \"default\". This tag is audit-only (no gate consumes " +
        "stale-base: yet), but pipe SessionStart event JSON on stdin, export $CLAUDE_SESSION_ID, or pass " +
        "--session <id> for manual / scripted use to keep the audit trail useful.",
    );
  }
  return done(true, repo, branch, sessionId, sessionSource, undefined, result.behindCount);
}
