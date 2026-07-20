// `harness record {review,review-subagent,dogfood}` — operator/agent-
// driven evidence-ledger producers for the review-before-merge,
// review-subagent-before-pr-create, and dogfood-before-release gate
// families (see src/cli/init/templates.ts for the exact policy
// definitions and tag shapes these verbs feed).
//
// Unlike `harness session-start preflight` (a SessionStart hook that
// MUST exit 0 on every path so it never breaks the session loop), the
// `record` verbs are INTERACTIVE: an agent or operator invokes them
// deliberately to attach a review verdict / dogfood summary to the
// ledger. A failure here (unreachable ledger, no git context, an empty
// summary) is a real error the caller needs to see and react to, so
// every verb exits non-zero with a clear stderr message on failure
// instead of degrading silently. Each verb still returns a structured
// `RecordResult` (not just a thrown error) so both paths are testable
// without spawning a process — same "degrade-with-reason" convention
// `runSessionStartPreflight` uses.
//
// Composition mirrors session-start/index.ts: build the ledger write
// via the manifest's declared `grounding-mcp` server (through the
// shared `resolveManifestLedgerWriter` — see runtime/ledger-writer.ts),
// resolve branch via `resolveGitContext` (the SAME function the
// preflight-before-* gates use) and session via `resolveReadSessionId`,
// with `--branch` / `--session` as explicit overrides. No new JSON-RPC
// or subprocess code: every ledger write goes through the existing
// `addLedgerFact` primitive.

import * as fs from "node:fs";
import * as path from "node:path";
import { findGitEntry, resolveGitContext } from "../../runtime/git-context.js";
import { resolveManifestLedgerWriter, type LedgerWriteFn } from "../../runtime/ledger-writer.js";
import {
  resolveReadSessionId,
  type ResolveReadSessionOptions,
} from "../../runtime/session-id.js";
import type { Manifest } from "../../schema/index.js";
import { EX_FAIL, EX_USAGE } from "../exit-codes.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const LEDGER_SOURCE_REVIEW = "harness-record-review";
const LEDGER_SOURCE_REVIEW_SUBAGENT = "harness-record-review-subagent";
const LEDGER_SOURCE_DOGFOOD = "harness-record-dogfood";

/** Options shared by every `record` verb. */
export interface RecordCommonOptions extends LoaderOptions {
  /** Working directory used for git-context resolution. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.stderr`. Warnings and error reasons land here. */
  stderr?: NodeJS.WritableStream;
  /** Explicit session id (overrides env + transcript discovery). */
  session?: string;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /**
   * Inject the read-path session resolver (test seam). Production uses
   * `resolveReadSessionId` from `runtime/session-id`, the same
   * precedence chain `harness audit` / `harness explain --trace` use.
   */
  resolveSession?: (explicit: string | undefined, opts: ResolveReadSessionOptions) => string;
  /** Inject the ledger writer (test seam). */
  writeLedger?: LedgerWriteFn;
}

/** Structured outcome of a `record` verb — testable without spawning a process. */
export interface RecordResult {
  /** 0 on success; EX_USAGE (64) for a bad argument, EX_FAIL (1) for a runtime failure. */
  exitCode: number;
  /** Whether the ledger fact was actually written. */
  wrote: boolean;
  /** The exact content string written (or that would have been written); "" on early validation failure. */
  content: string;
  /** Resolved session id ("" only when validation failed before session resolution). */
  sessionId: string;
  /** Resolved branch tag ("" when the verb does not use one, or resolution failed). */
  branch: string;
  /** Human-readable explanation of a non-write outcome. */
  reason?: string;
}

function resolveSession(opts: RecordCommonOptions): string {
  const resolve = opts.resolveSession ?? resolveReadSessionId;
  return resolve(opts.session, {});
}

/**
 * Write one ledger fact via the manifest's declared `grounding-mcp`
 * server (or the injected `opts.writeLedger` test seam). Mirrors the
 * manifest-wiring block `runSessionStartPreflight` uses, factored
 * through the shared `resolveManifestLedgerWriter` helper.
 */
async function writeLedgerFact(
  opts: RecordCommonOptions,
  sessionId: string,
  source: string,
  content: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    let manifest: Manifest;
    try {
      manifest = loadManifest(opts).manifest;
    } catch (err) {
      return { ok: false, reason: `manifest load failed: ${(err as Error).message}` };
    }
    const resolved = resolveManifestLedgerWriter(manifest, {
      ...(opts.ledgerTimeoutMs !== undefined ? { ledgerTimeoutMs: opts.ledgerTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      return { ok: false, reason: `${resolved.reason}; cannot record ${source} tag` };
    }
    writeLedger = resolved.write;
  }
  const result = await writeLedger({ sessionId, content, source });
  if (!result.ok) {
    return { ok: false, reason: `ledger write failed: ${result.reason ?? "unknown error"}` };
  }
  return { ok: true };
}

/**
 * Shared setup every verb runs first: a `note()` sink prefixed with the
 * verb's own name (so stderr lines are attributable when several verbs
 * run in a script), the resolved cwd, and the resolved session id.
 * Session id is resolved this early because `record dogfood`'s content
 * embeds it directly (`dogfood:${sessionId}`).
 */
function initRecordVerb(
  opts: RecordCommonOptions,
  verbName: string,
): { note: (msg: string) => void; cwd: string; sessionId: string } {
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness record ${verbName}: ${msg}\n`);
  };
  return { note, cwd: opts.cwd ?? process.cwd(), sessionId: resolveSession(opts) };
}

/**
 * Trim `value` and refuse it if empty (a required flag / positional
 * argument left blank). Returns the ready-to-`return`ed EX_USAGE
 * `RecordResult` on failure so callers do not repeat that construction
 * — shared by every "--pr / --task / --verdict / summary must not be
 * empty" check across the three verbs.
 */
function requireNonEmpty(
  value: string | undefined,
  flagLabel: string,
  sessionId: string,
  note: (msg: string) => void,
): { ok: true; value: string } | { ok: false; result: RecordResult } {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    const reason = `${flagLabel} must not be empty`;
    note(reason);
    return {
      ok: false,
      result: { exitCode: EX_USAGE, wrote: false, content: "", sessionId, branch: "", reason },
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Resolve the branch tag `review` and `review-subagent` both require:
 * explicit `--branch` wins, otherwise `resolveGitContext(cwd)` (the SAME
 * function the preflight-before-* gates use). Returns the ready-to-
 * `return`ed failure `RecordResult` on the shared "cannot resolve any
 * branch" degrade path so callers do not repeat that construction.
 */
function resolveRequiredBranch(
  cwd: string,
  explicitBranch: string | undefined,
  sessionId: string,
  note: (msg: string) => void,
): { ok: true; branch: string } | { ok: false; result: RecordResult } {
  const gitContext = resolveGitContext(cwd);
  const branch = (explicitBranch ?? "").trim() || gitContext.branch;
  if (branch.length === 0) {
    const reason =
      "no branch resolvable (cwd is not inside a git work tree, or HEAD is detached); pass --branch <name>";
    note(reason);
    return {
      ok: false,
      result: { exitCode: EX_FAIL, wrote: false, content: "", sessionId, branch: "", reason },
    };
  }
  return { ok: true, branch };
}

/**
 * Shared tail every verb runs last: write the fact, translate a failure
 * into the degrade-with-reason `RecordResult` shape, or report success.
 */
async function finishRecordWrite(
  opts: RecordCommonOptions,
  sessionId: string,
  branch: string,
  source: string,
  content: string,
  note: (msg: string) => void,
): Promise<RecordResult> {
  const written = await writeLedgerFact(opts, sessionId, source, content);
  if (!written.ok) {
    note(written.reason);
    return { exitCode: EX_FAIL, wrote: false, content, sessionId, branch, reason: written.reason };
  }
  return { exitCode: 0, wrote: true, content, sessionId, branch };
}

// ---------------------------------------------------------------------------
// Base-branch resolution for `record review` (--base flag > origin/HEAD
// filesystem fallback > omit with a loud stderr warning). No `gh`
// shell-out: everything is read straight off the `.git` directory,
// reusing runtime/git-context.ts's exported `findGitEntry` walk instead
// of re-implementing it.
// ---------------------------------------------------------------------------

// `.git/refs/remotes/origin/HEAD` on a normal clone: a symbolic ref
// pointing at the remote's default branch.
const ORIGIN_HEAD_REF_RE = /^ref:\s*refs\/remotes\/origin\/(.+)$/;
// A loose ref sha is exactly 40 lowercase hex chars (same as git-context.ts).
const SHA_RE = /^[0-9a-f]{40}$/;
const ORIGIN_HEAD_REF_PATH = "refs/remotes/origin/HEAD";
const ORIGIN_REMOTE_PREFIX = "refs/remotes/origin/";

/**
 * Resolve the remote's default branch name from `<gitDir>/refs/remotes/
 * origin/HEAD`. Loose symbolic ref first (the normal shape: `ref: refs/
 * remotes/origin/<name>`, written by `git clone` / `git remote set-head
 * origin -a`). When that loose file is absent, falls back to
 * `packed-refs`: some git versions / tooling pack `refs/remotes/origin/
 * HEAD` as a plain `<sha> <ref>` entry instead of a symref, which loses
 * the branch NAME directly — recovered here by matching that sha
 * against another packed `refs/remotes/origin/<name>` entry that shares
 * it (mirrors the loose-then-packed shape `resolveBranchSha` uses in
 * git-context.ts, adapted since packed-refs has no symref concept).
 * Returns null when neither source resolves a name.
 */
function resolveOriginHeadBase(gitDir: string): string | null {
  try {
    const raw = fs
      .readFileSync(path.join(gitDir, "refs", "remotes", "origin", "HEAD"), "utf8")
      .trim();
    const match = ORIGIN_HEAD_REF_RE.exec(raw);
    if (match) return match[1]!.trim();
  } catch {
    /* loose symref missing — try packed-refs */
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    let headSha: string | null = null;
    const entries: Array<{ sha: string; ref: string }> = [];
    for (const rawLine of packed.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
      const parts = line.split(/\s+/);
      const sha = parts[0];
      const ref = parts[1];
      if (!sha || !ref || !SHA_RE.test(sha)) continue;
      if (ref === ORIGIN_HEAD_REF_PATH) headSha = sha;
      else entries.push({ sha, ref });
    }
    if (headSha) {
      const match = entries.find(
        (e) => e.sha === headSha && e.ref.startsWith(ORIGIN_REMOTE_PREFIX),
      );
      if (match) return match.ref.slice(ORIGIN_REMOTE_PREFIX.length);
    }
  } catch {
    /* packed-refs missing too — caller treats null as "unresolvable" */
  }
  return null;
}

/**
 * Resolve the base branch for `record review`: explicit `--base` wins,
 * then the origin/HEAD filesystem fallback, then omission with a loud
 * stderr warning (never a silent gap — the operator needs to know the
 * `review:<base>` tag did not land).
 */
function resolveBase(
  cwd: string,
  explicitBase: string | undefined,
  note: (msg: string) => void,
): string | undefined {
  const flag = (explicitBase ?? "").trim();
  if (flag.length > 0) return flag;
  const gitDir = findGitEntry(cwd)?.gitDir;
  if (gitDir) {
    const base = resolveOriginHeadBase(gitDir);
    if (base) return base;
  }
  note(
    "no --base given and origin/HEAD could not be resolved (checked " +
      "refs/remotes/origin/HEAD and packed-refs); omitting the review:<base> tag. " +
      "Pass --base <branch> to record it explicitly.",
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// harness record review
// ---------------------------------------------------------------------------

export interface RecordReviewOptions extends RecordCommonOptions {
  /** PR number (or identifier) — required, non-empty. */
  pr: string;
  /** Explicit base-branch override; see resolveBase() for the fallback chain. */
  base?: string;
  /** Explicit branch override (otherwise resolved via resolveGitContext(cwd)). */
  branch?: string;
  /** Free-form review summary — required, non-empty. */
  summary: string;
}

export async function runRecordReview(opts: RecordReviewOptions): Promise<RecordResult> {
  const { note, cwd, sessionId } = initRecordVerb(opts, "review");

  const summaryResult = requireNonEmpty(opts.summary, "summary", sessionId, note);
  if (!summaryResult.ok) return summaryResult.result;
  const summary = summaryResult.value;

  const prResult = requireNonEmpty(opts.pr, "--pr", sessionId, note);
  if (!prResult.ok) return prResult.result;
  const pr = prResult.value;

  const branchResult = resolveRequiredBranch(cwd, opts.branch, sessionId, note);
  if (!branchResult.ok) return branchResult.result;
  const branch = branchResult.branch;

  const base = resolveBase(cwd, opts.base, note);
  const content = `review:${pr} review:${branch}${base ? ` review:${base}` : ""} — ${summary}`;

  return finishRecordWrite(opts, sessionId, branch, LEDGER_SOURCE_REVIEW, content, note);
}

// ---------------------------------------------------------------------------
// harness record review-subagent
// ---------------------------------------------------------------------------

export interface RecordReviewSubagentOptions extends RecordCommonOptions {
  /** agent-tasks task id — required, non-empty. */
  task: string;
  /** Reviewer verdict — required, non-empty. */
  verdict: string;
  /** Explicit branch override (otherwise resolved via resolveGitContext(cwd)). */
  branch?: string;
  /** Optional free-form summary appended after the verdict. */
  summary?: string;
}

export async function runRecordReviewSubagent(
  opts: RecordReviewSubagentOptions,
): Promise<RecordResult> {
  const { note, cwd, sessionId } = initRecordVerb(opts, "review-subagent");

  const taskResult = requireNonEmpty(opts.task, "--task", sessionId, note);
  if (!taskResult.ok) return taskResult.result;
  const task = taskResult.value;

  const verdictResult = requireNonEmpty(opts.verdict, "--verdict", sessionId, note);
  if (!verdictResult.ok) return verdictResult.result;
  const verdict = verdictResult.value;

  const branchResult = resolveRequiredBranch(cwd, opts.branch, sessionId, note);
  if (!branchResult.ok) return branchResult.result;
  const branch = branchResult.branch;

  const summary = typeof opts.summary === "string" ? opts.summary.trim() : "";
  const content = `review-subagent:${task} review-subagent:${branch} verdict:${verdict}${
    summary.length > 0 ? ` — ${summary}` : ""
  }`;

  return finishRecordWrite(opts, sessionId, branch, LEDGER_SOURCE_REVIEW_SUBAGENT, content, note);
}

// ---------------------------------------------------------------------------
// harness record dogfood
// ---------------------------------------------------------------------------

export interface RecordDogfoodOptions extends RecordCommonOptions {
  /** End-to-end smoke summary — required, non-empty. */
  summary: string;
}

export async function runRecordDogfood(opts: RecordDogfoodOptions): Promise<RecordResult> {
  const { note, sessionId } = initRecordVerb(opts, "dogfood");

  const summaryResult = requireNonEmpty(opts.summary, "summary", sessionId, note);
  if (!summaryResult.ok) return summaryResult.result;
  const summary = summaryResult.value;

  const content = `dogfood:${sessionId} — ${summary}`;

  return finishRecordWrite(opts, sessionId, "", LEDGER_SOURCE_DOGFOOD, content, note);
}
