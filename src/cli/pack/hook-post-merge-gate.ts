// `harness pack hook post-merge-gate` — PreToolUse blocker for the
// `post-merge-gate` policy pack.
//
// Receives Claude Code's PreToolUse event JSON on stdin and emits a
// `{ decision: "block" }` envelope when a CURATED history-mutating Bash
// command is about to run on a branch whose current tip exactly matches
// a merged-tip fact the producer recorded (see hook-post-merge-gate-record.ts).
//
// Evaluation order — deliberate, and pinned by the self-lock test suite:
//
//   1. Parse stdin. Malformed JSON, a non-Bash tool, or an empty command
//      all ALLOW immediately (nothing to classify).
//   2. Pause sentinel (operator kill-switch) — same convention as every
//      other pack hook.
//   3. ESCAPE ALLOWLIST — checked BEFORE manifest load, pack lookup, or
//      any ledger query. `git switch`/`checkout`/`pull`/`fetch`,
//      `git branch -d`/`-D`, `git stash list`/`show`, and any
//      `harness ...` command ALWAYS pass, unconditionally, with NO
//      dependency on whether the manifest or the ledger are reachable.
//      This is the recovery path the deny message itself recommends; it
//      must never be starved by an unrelated failure (the incident class
//      this guards against: a different gate once got blocked alongside
//      its own recovery command, and only the operator could unstick it).
//   4. CURATED MUTATION MATCH — commands outside the curated list
//      (git commit/add/push/merge/rebase/cherry-pick/revert/reset/
//      stash pop|apply, gh pr create/merge) pass through untouched.
//   5. Manifest load, pack-enabled check, git-context resolution
//      (detached HEAD / no-repo ALLOWS — nothing to compare), then the
//      ledger query.
//   6. DENY only when the current branch tip exactly matches a recorded
//      `post-merge-gate:merged:<repo>:<branch>:<sha>` fact.
//
// Fail posture: OPEN. A manifest-load failure or a degraded ledger both
// ALLOW (with a stderr warning) — the inverse of branch-protection's
// fail-closed contract. Without the ledger, "merged" and "not merged" are
// indistinguishable, and fail-closed here would block ordinary git
// history work on every branch whenever grounding-mcp hiccups. See
// post-merge-gate-runtime.ts's header for the full rationale.

import {
  isCuratedMutationCommand,
  isEscapeCommand,
  MERGED_TAG_PREFIX,
  mergedTagMatchKey,
  PACK_NAME,
  resolveDefaultBranchName,
} from "../../policy-packs/builtin/post-merge-gate-runtime.js";
import { queryLedgerByTag, type LedgerEntry } from "../../policies/index.js";
import { resolveGitContext } from "../../runtime/git-context.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import { POLICY_DECISION_TYPE } from "../../runtime/ledger-record.js";
import { type Manifest, type McpServer, type PolicyUx } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { checkHookPause, loadManifestOrInjected, parseConfigUx, readStdin } from "./hook-bootstrap.js";

const DEFAULT_BRANCH_PLACEHOLDER = "<default-branch>";

export interface PackHookPostMergeGateOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Override cwd resolution (test injection). Falls back to event.cwd then process.cwd(). */
  cwd?: string;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger query (test). */
  ledgerQuery?: (sessionId: string) => Promise<LedgerEntry[] | { degraded: string }>;
}

export interface PackHookPostMergeGateResult {
  exitCode: number;
  blocked: boolean;
  /** Diagnostic line emitted to stderr (always, even on allow). */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
}

function bashCommandOf(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const cmd = (toolInput as Record<string, unknown>)["command"];
  return typeof cmd === "string" ? cmd : "";
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

interface LedgerCheck {
  merged: boolean;
  matchedContent: string | null;
  degraded: string | null;
}

function evaluateEntries(entries: LedgerEntry[], matchKey: string): LedgerCheck {
  for (const e of entries) {
    // Skip policy_decision audit rows — a past DENIED decision this very
    // pack recorded would otherwise incidentally carry the match key in
    // its serialized payload, falsely satisfying itself. Same two-tier
    // filter branch-protection's blocker uses (type first, legacy
    // content-prefix backstop second).
    if (e.type === POLICY_DECISION_TYPE) continue;
    if (e.content.startsWith(`${POLICY_DECISION_TYPE}:`)) continue;
    if (e.content.includes(matchKey)) {
      return { merged: true, matchedContent: e.content, degraded: null };
    }
  }
  return { merged: false, matchedContent: null, degraded: null };
}

async function probeLedger(
  manifest: Manifest | null,
  sessionId: string,
  matchKey: string,
  opts: PackHookPostMergeGateOptions,
): Promise<LedgerCheck> {
  if (opts.ledgerQuery) {
    const r = await opts.ledgerQuery(sessionId);
    if ("degraded" in r) {
      return { merged: false, matchedContent: null, degraded: r.degraded };
    }
    return evaluateEntries(r, matchKey);
  }
  if (!manifest) {
    return { merged: false, matchedContent: null, degraded: "manifest unavailable" };
  }
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { merged: false, matchedContent: null, degraded: "grounding-mcp not declared in manifest" };
  }
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  const env = server.env ?? undefined;
  const timeoutMs = opts.ledgerTimeoutMs ?? server.health?.timeout_ms ?? 5_000;
  const result = await queryLedgerByTag({
    mcpCommand: command,
    ...(env && { mcpEnv: env }),
    sessionId,
    timeoutMs,
  });
  if (result.kind === "degraded") {
    return { merged: false, matchedContent: null, degraded: result.reason };
  }
  return evaluateEntries(result.entries, matchKey);
}

function blockJson(
  toolName: string,
  command: string,
  branch: string,
  defaultBranch: string,
  matchedContent: string,
  ux: PolicyUx | undefined,
  sessionId: string,
): string {
  let reasonText: string;
  if (ux) {
    reasonText = renderAgentFacing(ux, {
      BRANCH: branch,
      DEFAULT_BRANCH: defaultBranch,
      TOOL_NAME: toolName,
      SESSION_ID: sessionId,
    });
  } else {
    reasonText =
      `post-merge-gate: refusing ${toolName} ("${command}") on branch "${branch}" — ` +
      `its current tip was already merged (recorded: ${matchedContent}).\n` +
      `Further history-mutating commands on an already-merged branch usually mean stale local state.\n` +
      `\n` +
      `To proceed:\n` +
      `  git switch ${defaultBranch}\n` +
      `  git pull --ff-only\n` +
      `  git branch -d ${branch}   # optional cleanup\n` +
      `\n` +
      `If you have NEW work to continue on this branch (not leftover local state): make a commit first —` +
      ` this gate only fires while the branch tip still exactly matches the merged commit, so a new commit` +
      ` moves the tip and this check no longer applies.\n` +
      `\n` +
      `Escape hatches (always allowed, independent of this gate): git switch/checkout, git pull/fetch,` +
      ` git branch -d/-D, git stash list/show, and any \`harness ...\` command.`;
  }
  return JSON.stringify({
    decision: "block",
    reason: reasonText,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasonText,
    },
  });
}

export async function runPackHookPostMergeGateCli(
  opts: PackHookPostMergeGateOptions = {},
): Promise<PackHookPostMergeGateResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook post-merge-gate: ${msg}\n`);
  };

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    const diagnostic = "malformed event JSON, cannot classify; allowing";
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  // Pause sentinel — even this gate yields to an operator pause.
  if (checkHookPause(PACK_NAME, stderr, opts).paused) {
    const diagnostic = "harness paused; post-merge-gate allowing without evaluating.";
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";
  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();

  if (toolName !== "Bash") {
    const diagnostic = `${toolName} is not Bash; allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const command = bashCommandOf(event.tool_input);
  if (command === "") {
    const diagnostic = "no resolvable command text; allowing";
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  // ESCAPE ALLOWLIST — checked FIRST, unconditionally, before manifest
  // load, pack lookup, or any ledger query. See module header.
  if (isEscapeCommand(command)) {
    const diagnostic = `escape command matched; allowing regardless of ledger/manifest state`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  if (!isCuratedMutationCommand(command)) {
    const diagnostic = `command is not in the curated v1 deny-scope; allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  // Fail-open manifest load (opposite of branch-protection's fail-closed):
  // without the manifest we cannot tell if the pack is even enabled, and
  // this pack's whole posture is advisory, not a hard security boundary.
  let manifest: Manifest;
  try {
    ({ manifest } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    const diagnostic = `manifest load failed (${(err as Error).message}); post-merge-gate fails open, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const pack = manifest.policy_packs.find((p) => p.name === PACK_NAME);
  if (!pack) {
    const diagnostic = `pack "${PACK_NAME}" not declared in manifest, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }
  if (!pack.enabled) {
    const diagnostic = `pack "${PACK_NAME}" is enabled:false, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const { repo, branch, sha } = resolveGitContext(cwd);
  if (branch === "" || sha === "" || repo === "") {
    const diagnostic = `cannot resolve git context for ${cwd} (detached HEAD, outside a git work tree, or unresolvable sha); allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const configUx = parseConfigUx(
    (pack.config as Record<string, unknown>)["ux"],
    stderr,
    "harness pack hook post-merge-gate",
  );

  const matchKey = mergedTagMatchKey(repo, branch, sha);
  const check = await probeLedger(manifest, sessionId, matchKey, opts);

  if (check.degraded !== null) {
    const diagnostic = `ledger degraded (${check.degraded}); post-merge-gate fails open, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  if (!check.merged) {
    const diagnostic = `no recorded ${MERGED_TAG_PREFIX} fact for ${repo}:${branch} at tip ${sha.slice(0, 7)}; allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const defaultBranch = resolveDefaultBranchName(cwd) ?? DEFAULT_BRANCH_PLACEHOLDER;
  const diagnostic = `BLOCK — branch tip ${sha.slice(0, 7)} matches a recorded merged tip (${check.matchedContent ?? matchKey})`;
  note(diagnostic);
  stdout.write(
    `${blockJson(toolName, command, branch, defaultBranch, check.matchedContent ?? matchKey, configUx, sessionId)}\n`,
  );
  return { exitCode: 0, blocked: true, diagnostic };
}
