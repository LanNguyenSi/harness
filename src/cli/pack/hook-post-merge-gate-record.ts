// `harness pack hook post-merge-gate-record` — PostToolUse producer for
// the `post-merge-gate` policy pack.
//
// Receives Claude Code's PostToolUse event JSON on stdin. Fires only when
// the just-completed tool was Bash AND the command matched `gh pr merge`
// AND the merge is CONFIRMED by one of two contracts (see
// `resolveMergeConfirmation` in post-merge-gate-runtime.ts, "PAYLOAD
// REALITY" follow-up):
//
//   Contract A (original, unchanged): `tool_output.exit_code === 0`.
//   Contract B (2.1.218 payload reality): `tool_response` present with
//     `interrupted === false` AND `stdout`+`stderr` containing `gh pr
//     merge`'s own past-tense success sentence (all three merge methods).
//
// Contract A wins whenever it resolves to any definite verdict (success
// OR failure); Contract B is consulted only when Contract A's exit_code
// is entirely unresolvable. On a confirmed merge, records a
// `post-merge-gate:merged:<repo>:<branch>:<sha>` fact (plus PR number and
// timestamp, audit-only) to the evidence ledger via the same
// Trusted-Writer path `harness session-start branch-check` /
// `harness record *` use (`resolveManifestLedgerWriter` /
// `addLedgerFact`) — never an agent-issued `ledger_add`.
//
// `<sha>` is the LOCAL branch tip observed right after the tool ran:
// `gh pr merge` merges the PR on the remote side and does not itself move
// the local branch pointer, so this IS the exact commit that got merged
// (see post-merge-gate-runtime.ts's header for the full squash-fest
// rationale — no ancestry walk, no `git` subprocess).
//
// Every non-match / failure path is a no-op: wrong tool, non-matching
// command, neither contract confirms, an unresolvable git context, no
// session id, a manifest/ledger failure. `PostToolUse` is `blocking:false`
// by contract (see the pack's Hook entry) so none of these ever break the
// session; the only observable effect of a miss is that the blocker has
// no merged-tip fact to compare against for this particular merge.

import {
  buildMergedTagContent,
  GH_PR_MERGE_BASH_RE,
  PACK_NAME,
  resolveMergeConfirmation,
} from "../../policy-packs/builtin/post-merge-gate-runtime.js";
import { resolveGitContext } from "../../runtime/git-context.js";
import { resolveManifestLedgerWriter, type LedgerWriteFn } from "../../runtime/ledger-writer.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { checkHookPause, loadManifestOrInjected, readStdin } from "./hook-bootstrap.js";

const LEDGER_SOURCE = "harness-pack-hook-post-merge-gate-record";

export interface PackHookPostMergeGateRecordOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (PostToolUse). */
  stderr?: NodeJS.WritableStream;
  /** Override cwd resolution (test injection). Falls back to event.cwd then process.cwd(). */
  cwd?: string;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject a manifest (test). Bypasses loadManifest. */
  manifest?: Manifest;
  /** Override the harness.generated/ directory used by the pause check (test injection). */
  generatedDir?: string;
  /** Override "now" for the fact's `at:<iso>` audit timestamp (test injection). */
  now?: Date;
  /** Inject the ledger writer (test). */
  writeLedger?: LedgerWriteFn;
}

export interface PackHookPostMergeGateRecordResult {
  /** Always 0 — PostToolUse hooks must never break the session loop. */
  exitCode: number;
  /** Whether the merged-tag ledger fact was actually written. */
  wrote: boolean;
  /** Human-readable explanation, always populated (even on a write). */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
  /** Contract A (original hooks-doc shape: `{ stdout, stderr, exit_code }`). */
  tool_output?: unknown;
  /** Contract B (live 2.1.218 shape: `{ stdout, stderr, interrupted, isImage, noOutputExpected }`). */
  tool_response?: unknown;
}

function bashCommandOf(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const cmd = (toolInput as Record<string, unknown>)["command"];
  return typeof cmd === "string" ? cmd : "";
}

export async function runPackHookPostMergeGateRecordCli(
  opts: PackHookPostMergeGateRecordOptions = {},
): Promise<PackHookPostMergeGateRecordResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook post-merge-gate-record: ${msg}\n`);
  };

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    const diagnostic = "malformed event JSON, skipping";
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  // Pause sentinel — mirrors every other pack hook's operator kill-switch.
  if (checkHookPause(PACK_NAME, stderr, opts, opts.generatedDir).paused) {
    const diagnostic = "harness paused; post-merge-gate-record skipping without evaluating.";
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (toolName !== "Bash") {
    const diagnostic = `tool ${toolName || "(unknown)"} is not Bash, skipping`;
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  const command = bashCommandOf(event.tool_input);
  if (!command || !GH_PR_MERGE_BASH_RE.test(command)) {
    const diagnostic = "command did not match gh pr merge, skipping";
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  // The confirmed-success gate: neither contract confirming — including
  // any unresolvable / unexpected payload shape on either — writes NO
  // fact. Fail-safe against a false "merged" record, which would be a
  // self-lock in the wrong direction (03-decisions.md). See
  // resolveMergeConfirmation's own doc comment for the dual-contract /
  // "Contract A wins" ordering decision.
  const confirmation = resolveMergeConfirmation(event.tool_output, event.tool_response, command);
  if (!confirmation.confirmed) {
    const diagnostic = `not a confirmed merge success (${confirmation.reason}); skipping (no fact written)`;
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();
  const { repo, branch, sha } = resolveGitContext(cwd);
  if (repo === "" || branch === "" || sha === "") {
    const diagnostic =
      `cannot resolve git context for ${cwd} ` +
      `(repo=${JSON.stringify(repo)} branch=${JSON.stringify(branch)} sha=${JSON.stringify(sha)}); ` +
      `skipping (no fact written)`;
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  const sessionId =
    (typeof event.session_id === "string" && event.session_id.length > 0
      ? event.session_id
      : undefined) ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  if (sessionId === "") {
    const diagnostic =
      "no session_id resolvable from stdin or $CLAUDE_CODE_SESSION_ID/$CLAUDE_SESSION_ID; skipping (no fact written)";
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }

  // PR number: resolveMergeConfirmation already applied the binding
  // resolution order (command-first, gh-success-sentence fallback only
  // for Contract B; Contract A stays command-only, unchanged).
  const whenIso = (opts.now ?? new Date()).toISOString();
  const content = buildMergedTagContent({ repo, branch, sha, pr: confirmation.pr, whenIso });

  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    let manifest: Manifest;
    try {
      ({ manifest } = loadManifestOrInjected(opts, opts.manifest));
    } catch (err) {
      const diagnostic = `manifest load failed (${(err as Error).message}); skipping (no fact written)`;
      note(diagnostic);
      return { exitCode: 0, wrote: false, diagnostic };
    }
    const resolved = resolveManifestLedgerWriter(manifest, {
      ...(opts.ledgerTimeoutMs !== undefined ? { ledgerTimeoutMs: opts.ledgerTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      const diagnostic = `${resolved.reason}; cannot record ${content}`;
      note(diagnostic);
      return { exitCode: 0, wrote: false, diagnostic };
    }
    writeLedger = resolved.write;
  }

  const result = await writeLedger({ sessionId, content, source: LEDGER_SOURCE });
  if (!result.ok) {
    const diagnostic = `ledger write failed: ${result.reason ?? "unknown error"}`;
    note(diagnostic);
    return { exitCode: 0, wrote: false, diagnostic };
  }
  const diagnostic = `recorded ${content} for session ${sessionId}`;
  note(diagnostic);
  return { exitCode: 0, wrote: true, diagnostic };
}
