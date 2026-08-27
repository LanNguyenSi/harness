// Phase 6 #4 — `harness pack hook pre-tool-use [--pack <name>]` runtime verb.
//
// PreToolUse blocker for pack-driven gates. Wired by the
// understanding-before-execution pack's hook contribution; receives the
// Claude Code event JSON on stdin, consults the signed operator approval
// marker (the only approval authority; the persisted JSON report and the
// evidence ledger are audit evidence, task 7402301d), emits a
// `{decision: "block"}` JSON to stdout when no valid marker approves.
//
// Why a new CLI verb (vs reusing `harness policy intercept`): the
// existing intercept layer evaluates `policies[]` against `requires`,
// which is purely ledger-based. The Understanding Gate has a second
// source-of-truth (the persisted JSON report), and bolting a fallback
// into the requires evaluator would leak pack-specific semantics into
// the generic policy layer. This verb lives next to the pack instead.
//
// Failure mode: any error in load / parse / ledger / report scan
// resolves to ALLOW (exit 0, silent). The Understanding Gate is opt-in;
// turning a bug in this code into a session-wide tool block would be
// hostile. The npm package's own standalone blocker still runs as a
// secondary safety net for solo users, and `harness explain --trace`
// (Phase 4 #6) surfaces the runtime audit trail when configured.

import * as path from "node:path";
import {
  queryLedgerByTag,
  type LedgerEntry,
} from "../../policies/index.js";
import { renderProducers } from "../../policies/producers.js";
import {
  checkOperatorApprovalMarkers,
  checkPersistedReport,
  defaultReportsDir,
  matchLedgerEntries,
  type ApprovalCheckResult,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { findLatestParseError, renderMalformedSectionsNotice } from "../approve/understanding.js";
import {
  resolveGeneratedDir,
  writePendingApproval,
} from "../../runtime/pending-approval.js";
import { isReadOnlyBashPipeline } from "../../runtime/read-only-bash.js";
import { isRecoveryGitCommit } from "../../runtime/recovery-git-commit.js";
import {
  ProducerSchema,
  type Manifest,
  type McpServer,
  type PolicyUx,
  type Producer,
} from "../../schema/index.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import { z } from "zod";
import { isEscapeCommand } from "./approve-escape.js";
import { type LoaderOptions } from "../loader.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  parseConfigUx,
  readStdin,
} from "./hook-bootstrap.js";
import { renderReportSchemaHint } from "./understanding-report-schema-hint.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookPreToolUseOptions extends LoaderOptions {
  /** Pack name to evaluate. Defaults to understanding-before-execution. */
  pack?: string;
  /** Override report directory (test injection). */
  reportsDir?: string;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Override timeout per ledger call. */
  ledgerTimeoutMs?: number;
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Inject an alternate manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger query (test). */
  ledgerQuery?: (sessionId: string) => Promise<LedgerEntry[] | { degraded: string }>;
  /**
   * Override "now" for the pause-sentinel expiry check (test injection).
   * The lower layers (`checkPauseFromLoader`, `maybeAnnouncePause`,
   * `readSentinel`) already accept a `now`; this threads it through so a
   * test can drive pause auto-expiry off an injected clock instead of a
   * real-time sleep.
   */
  now?: Date;
}

export interface PackHookPreToolUseResult {
  exitCode: number;
  blocked: boolean;
  /**
   * True when the hook deferred to the operator's interactive permission
   * prompt (`permissionDecision: "ask"`) instead of hard-denying. Used for
   * the `harness approve` / `harness gate` escape commands so the operator's
   * go on the prompt IS the approval. Mutually exclusive with `blocked`.
   */
  asked?: boolean;
  approvalCheck: ApprovalCheckResult;
  /** Diagnostic line emitted to stderr (always; even on allow). */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

// The Claude Code "block" envelope. Mirrors the runtime/intercept.ts
// shape (PR #81): `decision: "block"` keeps legacy 2.0.x CLIs blocking,
// `hookSpecificOutput.permissionDecision: "deny"` is the Claude Code
// 2.1+ documented contract for PreToolUse. This hook is always wired to
// PreToolUse (the pack contributes only a PreToolUse hook), so the
// envelope is unconditional here — no event-kind branch like
// runtime/intercept.ts needs.
// Producers list from the pack's config (agent-tasks/25bced52). Same
// shape as the policy engine's `producers:` field, surfaced through the
// understanding-gate's separate deny path. The constraint differs from
// the policy engine: here we require at-least-one `ask` (the canonical
// unblock surface) rather than at-least-one `mcp`, because post-v0.14.0
// the gate signal is a filesystem marker and the mcp ledger_add path no
// longer satisfies the gate. Only the operator-approval (`ask`) or a
// shell from an un-hooked terminal can write the marker.
const ProducersConfigSchema = z
  .array(ProducerSchema)
  .min(1)
  .refine(
    (arr) => arr.some((p) => p.kind === "ask"),
    "understanding-gate config.producers must include at least one kind:ask entry (the canonical unblock surface)",
  );

function parseConfigProducers(
  raw: unknown,
  stderr: NodeJS.WritableStream,
): Producer[] | undefined {
  if (raw === undefined) return undefined;
  const result = ProducersConfigSchema.safeParse(raw);
  if (!result.success) {
    stderr.write(
      `harness pack hook: config.producers ignored (${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")})\n`,
    );
    return undefined;
  }
  return result.data;
}

// Agent-facing `ux:` block on the pack config (agent-tasks/e48e3b45):
// parsed via the shared `parseConfigUx` (hook-bootstrap.ts). When present,
// the deny envelope the agent sees becomes the plain-language
// `{ cannot, required, run }` shape and the legacy "Understanding Gate:
// no approved..." + schemaHint + producers vocabulary is suppressed.

function blockJson(
  toolName: string,
  reason: string,
  producers: Producer[] | undefined,
  ux: PolicyUx | undefined,
  sessionId: string,
  escapeHint?: string | null,
  malformedSections?: string[],
): string {
  // When the pack config declares `ux:`, the agent-facing surface
  // becomes the plain-language `{ cannot, required, run }` shape, and
  // the legacy schemaHint + producers block is suppressed (the ux
  // entries are now the canonical surface; mixing both would split
  // the agent's attention). Internal stuff (the `reason` argument's
  // engine vocabulary) still lands in stderr via the BLOCK diagnostic
  // for operator audit.
  let reasonText: string;
  if (ux) {
    reasonText = renderAgentFacing(ux, {
      SESSION_ID: sessionId,
      TOOL_NAME: toolName,
    });
  } else {
    // Legacy suffix kept unchanged so existing operators / docs that quote
    // the old surface still find the recognizable string. The producers
    // block (when configured) appends AFTER, so a reader's eye lands on
    // the structured recipe last. The schema-hint paragraph sits between
    // them: the agent reads the call-to-action first, then learns what
    // shape the report needs to take (without this, freeform prose
    // satisfies the marker write but silently fails the parser).
    const suffix = `Run \`harness approve understanding\` once you have produced and confirmed an Understanding Report.`;
    const schemaHint = renderReportSchemaHint();
    const producersBlock = renderProducers(producers, { SESSION_ID: sessionId });
    reasonText = `Understanding Gate: ${reason}. Tool: ${toolName}. ${suffix}\n${schemaHint}${producersBlock}`;
  }
  // Name the malformed sections from the session's own latest parse-error
  // log, when it carries any (task 823837fd, follow-up to 7e29e5d7): a
  // (list) heading that WAS present but whose body was prose instead of
  // markdown list items. Without this an agent whose report almost
  // parsed sees the same generic "no approved report" block as one that
  // never attempted a report at all. Appended after the ux/legacy
  // envelope (both are the "what to do" recipe; this is "what went wrong
  // last time") and before the escape hint (the most immediate
  // remediation, kept last). Sentence itself is shared with the Codex
  // hook via `renderMalformedSectionsNotice` (approve/understanding.ts)
  // so the two runtimes cannot drift apart byte-for-byte.
  const malformedNotice = renderMalformedSectionsNotice(malformedSections ?? []);
  if (malformedNotice) {
    reasonText = `${reasonText}\n\n${malformedNotice}`;
  }
  // A targeted remediation hint for an approve-like command that tripped the
  // escape matcher's metachar guard. Appended last so it reads after the
  // structured recipe regardless of which envelope (ux vs legacy) rendered.
  if (escapeHint) {
    reasonText = `${reasonText}\n\n${escapeHint}`;
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

// Codepoints in the STRUCTURALLY relevant part of the command (the whole
// command when there is no heredoc, otherwise only the intro line up to
// the first newline) that JS's generic `\s` class matches but bash does
// NOT treat as a blank separator here (task 623640a5 review, anti-lockout
// finding): every one of them glues onto the adjacent token instead of
// being stripped as insignificant whitespace, which is exactly what let a
// report heredoc's real delimiter (as bash reads it) diverge from the
// word isEscapeCommand extracts. Deliberately scoped to the intro line,
// not the heredoc BODY (review 2026-08-08 round 2): the body is free-form
// Understanding Report markdown, where an NBSP or em-space is ordinary,
// legitimate prose whitespace, not a matcher-defeating character, so
// naming one there would misattribute an independent block's cause to
// inert body text an agent never needs to touch. Scans the RAW intro line
// (not a `.trim()`'d copy, since trimming would silently eat a leading or
// trailing occurrence before it could be named). Returns the codepoints
// in `U+XXXX` form, ascending, deduplicated; empty when the intro line
// carries none.
function findNonBashBlankWhitespace(command: string): string[] {
  const nl = command.indexOf("\n");
  const introLine = nl === -1 ? command : command.slice(0, nl);
  const codepoints = new Set<number>();
  for (const ch of introLine) {
    if (ch === " " || ch === "\t") continue;
    if (/^\s$/.test(ch)) codepoints.add(ch.codePointAt(0)!);
  }
  return [...codepoints]
    .sort((a, b) => a - b)
    .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
}

// When a blocked Bash command clearly INTENDS to be the operator-approval
// escape (`harness approve ...`) but trips the deliberately strict
// isEscapeCommand matcher because it carries shell metacharacters (a pipe,
// chaining, redirection, or substitution) or a malformed report heredoc,
// it lands in the generic hard block with no clue that the command itself
// was almost the way out. The strictness is intentional (chaining could
// smuggle other work past the gate), so the fix is discoverability, not
// relaxation: surface a targeted hint naming the two accepted shapes.
// Returns null when the command is not approve-like or already qualifies
// as a clean escape.
function approveEscapeHint(toolName: string, command: string): string | null {
  if (toolName !== "Bash") return null;
  const trimmed = command.trim();
  // This `\s` is deliberately broader than isEscapeCommand's `[ \t]`-only
  // bash-blank matcher (task 623640a5 review): it only gates whether to
  // SHOW the discoverability hint, not whether to accept the command as
  // the escape, so being permissive here is safe. Do not narrow it to
  // `[ \t]` to "match" the matcher.
  if (!/^harness\s+approve\b/.test(trimmed)) return null;
  if (isEscapeCommand(trimmed)) return null;
  let hint =
    "This looks like a `harness approve` command, but it was blocked because it carries shell " +
    "metacharacters (a pipe, `;`/`&&`/`||` chaining, `<`/`>` redirection, or command substitution) " +
    "in the executable part, or a malformed report heredoc. Two shapes are accepted: " +
    "(1) bare: `harness approve understanding` with nothing else; " +
    "(2) with the Understanding Report attached for capture: " +
    "`harness approve understanding <<'UNDERSTANDING_REPORT'` followed by the report markdown and a " +
    "final line containing exactly `UNDERSTANDING_REPORT`, with nothing after it. " +
    "Re-run in one of those shapes, then approve the prompt.";
  // Anti-lockout (task 623640a5 review): an agent that emitted an
  // invisible or non-ASCII whitespace codepoint (e.g. a non-breaking
  // space) sees a command that reads as clean, so the generic hint above
  // gives it no signal that whitespace is the actual cause — it just
  // resends the same bytes and stays blocked. Name the offending
  // codepoint(s) explicitly whenever the command carries one.
  const invisible = findNonBashBlankWhitespace(command);
  if (invisible.length > 0) {
    const plural = invisible.length > 1;
    hint +=
      ` It also contains ${plural ? "invisible or non-ASCII whitespace characters" : "an invisible or non-ASCII whitespace character"} ` +
      `(${invisible.join(", ")}) where an ordinary space or tab was expected; bash does not treat ` +
      `${plural ? "them" : "it"} as a separator here. Replace ${plural ? "them" : "it"} with a real space or tab and re-run.`;
  }
  return hint;
}

// The Claude Code PreToolUse "ask" envelope: surface the normal interactive
// permission prompt. Per the hooks contract `permissionDecision: "ask"` is
// PreToolUse-only, and the legacy top-level `decision` field is omitted on
// purpose: a `decision: "block"` would hard-block legacy 2.0.x CLIs and
// defeat the ask.
function askJson(): string {
  const reason =
    "Understanding Gate: no approved Understanding Report yet. This is a " +
    "`harness approve` command (the operator-approval path). Approve this " +
    "prompt to record your go.";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  });
}

async function checkLedger(
  manifest: Manifest,
  sessionId: string,
  opts: PackHookPreToolUseOptions,
): Promise<{ matched: boolean; detail: string }> {
  if (opts.ledgerQuery) {
    const result = await opts.ledgerQuery(sessionId);
    if ("degraded" in result) {
      return { matched: false, detail: `ledger degraded (${result.degraded})` };
    }
    return matchLedgerEntries(result, sessionId);
  }
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { matched: false, detail: "grounding-mcp not declared in manifest" };
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
    return { matched: false, detail: `ledger degraded (${result.reason})` };
  }
  return matchLedgerEntries(result.entries, sessionId);
}

export async function runPackHookPreToolUseCli(
  opts: PackHookPreToolUseOptions = {},
): Promise<PackHookPreToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  // Read stdin defensively. Bad JSON falls through to allow (matches
  // policy intercept's failure mode) but emits a stderr diagnostic so
  // the degradation is loud — a silently-allowing gate manufactures
  // false confidence, which is the worst direction for a governance
  // hook to fail in.
  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch (err) {
    stderr.write(
      `harness pack hook: malformed event JSON on stdin (${
        (err as Error).message
      }), allowing.\n`,
    );
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";
  const rawCommand =
    event.tool_input && typeof event.tool_input === "object"
      ? (event.tool_input as { command?: unknown }).command
      : undefined;
  const commandStr = typeof rawCommand === "string" ? rawCommand : "";

  // Pause sentinel — operator-only kill switch. Honoured BEFORE manifest
  // load so the lockout-recovery flow (where the manifest is exactly
  // what's broken) still respects an active pause.
  if (checkHookPause("pre-tool-use", stderr, opts, opts.generatedDir, opts.now).paused) {
    const diagnostic = "harness paused; pre-tool-use allowing without evaluating.";
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Load manifest (or use injection). Bail to allow on any failure so a
  // missing harness install never bricks the session. The resolved
  // manifest path feeds the harness.generated/ lookup below; an injected
  // manifest has no path, so the staging write is skipped in that case
  // (tests inject `generatedDir` directly instead).
  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    const diagnostic = `harness pack hook: manifest load failed (${
      (err as Error).message
    }), allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Confirm the pack is enabled. A pack that isn't even declared in the
  // manifest means the operator wired this hook directly into
  // settings.json without `harness apply` — odd but harmless; allow.
  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    const diagnostic = `harness pack hook: pack "${packName}" not declared in manifest, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }
  if (!declared.enabled) {
    const diagnostic = `harness pack hook: pack "${packName}" is enabled:false, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  if (sessionId === "") {
    const diagnostic =
      'harness pack hook: no session_id resolvable from input or $CLAUDE_CODE_SESSION_ID/$CLAUDE_SESSION_ID, allowing.';
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Resolve generatedDir up-front: marker check and pending-approval
  // staging both depend on it.
  const generatedDir =
    opts.generatedDir ??
    (manifestPath !== undefined
      ? resolveGeneratedDir({
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          manifestPath,
        })
      : undefined);

  // Source 1: filesystem marker (agent-tasks/88ca4bb3). Canonical for
  // harnessed sessions. The ledger check is no longer authoritative
  // because the agent has direct MCP access to the same ledger and
  // could self-approve; the marker file lives in harness.generated/
  // which Edit / Write / Bash are all gated from writing to. Bail to
  // ledger-as-audit only when generatedDir is unresolvable (injected
  // manifest without a resolved path: only happens in tests).
  //
  // `markerExpired` is hoisted out of the block below so the
  // recovery-git-commit exception (task 6e888423) further down can see
  // it: it is true only when a REAL marker existed for this
  // session/task and aged past `approval_lifecycle.max_age` — as
  // opposed to no marker ever existing, or one cleared by a
  // task-completion boundary tool. See understanding-before-execution-
  // runtime.ts's `OperatorMarkerApproval.expired` doc for the full
  // distinction.
  let markerExpired = false;
  // True when checkOperatorApprovalMarkers found a marker FILE that failed
  // signature verification (harness/f9485cc7) — missing/invalid signature,
  // wrong alg, or tampered payload — for either the task-scoped or
  // session-scoped check. Surfaced in the block reason below with a
  // distinct phrase from "no approval marker" so an operator/auditor can
  // tell a forgery attempt apart from the routine "never approved" case.
  let markerForged = false;
  if (generatedDir !== undefined) {
    // Source 1a/1b: task-scoped marker for the currently-claimed task
    // (harness/1ee26e77 + PR #198 correctness fix), then the
    // session-scoped marker (legacy / fallback), both under the
    // `approval_lifecycle` TTL. The resolution is shared with the Codex
    // hook (`checkOperatorApprovalMarkers`, task e7c2ec3c) so the two
    // runtimes cannot drift on lifecycle semantics again.
    const markers = checkOperatorApprovalMarkers(
      generatedDir,
      sessionId,
      declared.config,
      stderr,
    );
    markerExpired = markers.expired;
    markerForged = markers.forged;
    if (markers.source !== "task") {
      // Trace the task-marker miss to stderr so an operator chasing
      // "why isn't my approval working?" sees the active-claim vs marker
      // mismatch, not just the eventual generic session-marker miss.
      stderr.write(`harness pack hook: task-scoped check: ${markers.taskCheckDetail}\n`);
    }
    if (markers.matched) {
      const diagnostic = `harness pack hook: ${markers.detail}, allowing.`;
      stderr.write(`${diagnostic}\n`);
      return {
        exitCode: 0,
        blocked: false,
        approvalCheck: { approved: true, source: "marker", detail: markers.detail },
        diagnostic,
      };
    }
  }

  // Persisted-report EVIDENCE probe (task 7402301d). This used to be
  // "Source 2", an equal approval authority consulted right after a forged
  // marker was rejected, and it was unsigned: under the threat model that
  // motivated marker signing (harness/f9485cc7: a write primitive the
  // `Edit|Write|Bash` matcher does not cover) one unsigned JSON write
  // into the reports directory forged an approval, no session id or key
  // read needed. The report now contributes only to the block diagnostic
  // (`report.detail`, which carries the distinct `unsigned
  // persisted-report approval rejected` phrase when the on-disk status
  // says approved) and to the parse-error lookup gate below
  // (`report.report === null`). `PersistedReportEvidence` has no
  // `approved` field on purpose; the signed marker above is the only
  // allow path.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const report = checkPersistedReport(reportsDir, sessionId);

  // Audit-only ledger probe: the ledger row is still recorded by
  // `harness approve understanding`, and we surface its presence in
  // the diagnostic so an operator chasing a flapping gate can see the
  // historic trail. The result intentionally does NOT influence the
  // allow/block decision.
  const ledger = await checkLedger(manifest, sessionId, opts);

  // Neither operator source approved. When a marker FILE existed but
  // failed signature verification, use a distinct reason phrase
  // ("forged/unsigned marker rejected") instead of the routine "no
  // approval marker" — audit/operator surfaces can then tell an active
  // forgery attempt (or a pre-signing legacy marker) apart from a session
  // that simply never approved (harness/f9485cc7).
  const reason = generatedDir !== undefined
    ? markerForged
      ? `forged/unsigned marker rejected for session ${sessionId}; ${report.detail}; ${ledger.detail}`
      : `no approval marker for session ${sessionId}; ${report.detail}; ${ledger.detail}`
    : `generatedDir not resolvable (test/injection path); ${report.detail}; ${ledger.detail}`;

  // Stage the session id so `harness approve`, run from the operator's
  // shell where $CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID is unset, can resolve it without
  // guessing from transcript filenames. Covers both the ask and the
  // block branches below. Best-effort: a staging-write failure must not
  // escalate a gate block into a hook error.
  if (generatedDir !== undefined) {
    try {
      writePendingApproval(generatedDir, sessionId);
    } catch {
      /* best-effort; the ask / block below proceeds regardless */
    }
  }

  // Exception: read-only Bash commands. The pack hook matcher
  // necessarily covers `Bash` as a whole, but commands like
  // `git status`, `gh pr view`, `ls`, `cat` mutate nothing. Blocking
  // them behind a full Understanding Report cycle trains the agent
  // and operator to experience the gate as noise, which erodes its
  // credibility on the writes that actually matter. Pass the
  // classifier on Bash commands only; Edit and Write stay
  // hard-blocked regardless (the matcher's other arms reach the
  // same final block path below). Unclassifiable Bash falls through
  // to the block (fail-closed).
  if (toolName === "Bash" && isReadOnlyBashPipeline(commandStr)) {
    const diagnostic = `harness pack hook: read-only Bash command, allowing without an approved report (\`${commandStr.trim()}\`)`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Exception: the narrow recovery-git-commit shape (task 6e888423,
  // agent-grounding frictions #2/#9/#58/#71). `approval_lifecycle.max_age`
  // can age out the marker mid-task — e.g. during a long reviewer-
  // amendment loop — leaving the recovery `git commit` that consolidates
  // ALREADY-approved Edit/Write output into a new HEAD hard-blocked
  // behind an operator. Gated on BOTH conditions so this cannot become a
  // generic bypass: `markerExpired` proves a real operator approval
  // existed for this exact session/task and merely aged out (a marker
  // that is simply absent, or one a task-completion boundary tool just
  // cleared for a NEW task, leaves this false and the block below still
  // applies), and `isRecoveryGitCommit` proves the command is a bare,
  // unchained `git commit` that cannot smuggle other work or introduce
  // new file content — see src/runtime/recovery-git-commit.ts for the
  // full safety argument. Edit / Write / every other Bash shape remain
  // hard-gated regardless.
  if (toolName === "Bash" && markerExpired && isRecoveryGitCommit(commandStr)) {
    const diagnostic = `harness pack hook: recovery-commit exemption — approval for session ${sessionId} had expired, but this session/task WAS previously approved; allowing the bare \`git commit\` to record already-approved work (\`${commandStr.trim()}\`). A fresh Understanding Report is still required for any new Edit/Write/Bash.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "recovery-commit", detail: diagnostic },
      diagnostic,
    };
  }

  // Exception: the operator-approval command itself. Hard-denying
  // `harness approve understanding` is a catch-22: it is the very command
  // that records the operator's go, and a Bash `deny` gives no prompt to
  // approve. Defer it to the interactive permission prompt instead, so the
  // operator's go on that prompt IS the approval, and `harness approve
  // understanding` then writes the ledger tag that unblocks the session.
  if (toolName === "Bash" && isEscapeCommand(commandStr)) {
    const diagnostic = `harness pack hook: ASK: operator-approval command, deferring to the interactive permission prompt`;
    stderr.write(`${diagnostic}\n`);
    stdout.write(`${askJson()}\n`);
    return {
      exitCode: 0,
      blocked: false,
      asked: true,
      approvalCheck: { approved: false, source: "none", detail: reason },
      diagnostic,
    };
  }

  const diagnostic = `harness pack hook: BLOCK — ${reason}`;
  stderr.write(`${diagnostic}\n`);
  const configProducers = parseConfigProducers(
    (declared.config as Record<string, unknown>)["producers"],
    stderr,
  );
  const configUx = parseConfigUx(
    (declared.config as Record<string, unknown>)["ux"],
    stderr,
    "harness pack hook",
  );
  const escapeHint = approveEscapeHint(toolName, commandStr);
  // Best-effort lookup of the session's latest parse-error log (task
  // 823837fd, follow-up gate task 823837fd review): the standalone Stop
  // hook / `harness approve understanding` stdin-report path writes one
  // to `<reports-parent>/parse-errors/` when the agent's report failed to
  // parse. Reused here (findLatestParseError already swallows I/O
  // errors, same contract as the approve-time lookup) so a blocked agent
  // whose report almost parsed can be told WHICH sections were
  // malformed, not just "no approved report". Gated on `report.report
  // === null` (no persisted report at all for this session): a report
  // that WAS persisted but is merely pending approval must not surface a
  // stale parse-error from an earlier, already-fixed attempt; mirrors
  // the CLI's own gate (`if (!latest)`, approve/understanding.ts). Moved
  // here, right before the block render and after every exemption
  // early-return above, so the lookup only runs on the path that
  // actually renders it (pure code motion from its previous location
  // right after `checkPersistedReport`).
  const latestParseError =
    report.report === null
      ? findLatestParseError(path.join(path.dirname(reportsDir), "parse-errors"), sessionId)
      : null;
  stdout.write(
    `${blockJson(toolName, "no approved Understanding Report for this session", configProducers, configUx, sessionId, escapeHint, latestParseError?.malformedSections)}\n`,
  );
  return {
    exitCode: 0,
    blocked: true,
    approvalCheck: { approved: false, source: "none", detail: reason },
    diagnostic,
  };
}
