// Phase 6 #6 — `harness pack hook codex-pre-tool-use` runtime verb.
//
// Codex variant of the Claude Code blocker (`hook-pre-tool-use.ts`).
// Same approval logic (signed marker only; report + ledger are evidence,
// task 7402301d), but a different I/O contract:
//
//   stdin  : JSON envelope shaped as `{ session_id, tool_name,
//            raw_input, event }` — harness's published wire format that
//            the Codex CLI integration is wrapped to emit. The
//            integration is documented in
//            `docs/policy-packs/understanding-before-execution.md`
//            "Adapter notes / Codex".
//   stdout : block reason on stderr; allow path is silent on stdout.
//   exit   : 0 on allow, 2 on block. Codex's blocking convention is
//            non-zero exit (the JSON-decision shape Claude Code reads
//            is not part of Codex's hook contract today).
//
// Failure mode mirrors the Claude blocker: any error in load / parse /
// ledger / report scan resolves to ALLOW (exit 0, silent diagnostic on
// stderr). The package's optional standalone blocker remains a safety
// net for solo users; the harness blocker is strictly more powerful.

import * as path from "node:path";
import { queryLedgerByTag, type LedgerEntry } from "../../policies/index.js";
import {
  checkOperatorApprovalMarkers,
  checkPersistedReport,
  defaultReportsDir,
  matchLedgerEntries,
  type ApprovalCheckResult,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { findLatestParseError, renderMalformedSectionsNotice } from "../approve/understanding.js";
import { CODEX_HARNESS } from "../../policy-packs/builtin/understanding-before-execution/auto-approve.js";
import {
  attemptAutoApproval,
  AUTO_APPROVE_LEDGER_SOURCE_CODEX,
} from "./auto-approve-path.js";
import {
  resolveGeneratedDir,
  writePendingApproval,
} from "../../runtime/pending-approval.js";
import { resolveManifestLedgerWriter, type LedgerWriteFn } from "../../runtime/ledger-writer.js";
import { extractShellCommand } from "../../runtime/tool-name-aliases.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import { type Manifest, type McpServer } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { isReadOnlyBashPipeline } from "../../runtime/read-only-bash.js";
import { isRecoveryGitCommit } from "../../runtime/recovery-git-commit.js";
import { renderReportSchemaHint } from "./understanding-report-schema-hint.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  parseConfigUx,
  pickString,
  readStdin,
} from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";
const EXIT_BLOCK = 2;

export interface PackHookCodexPreToolUseOptions extends LoaderOptions {
  /** Pack name to evaluate. Defaults to understanding-before-execution. */
  pack?: string;
  /** Override report directory (test injection). */
  reportsDir?: string;
  /** Override harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Override timeout per ledger call. */
  ledgerTimeoutMs?: number;
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Inject an alternate manifest (test). */
  manifest?: Manifest;
  /** Inject a fake ledger query (test). */
  ledgerQuery?: (sessionId: string) => Promise<LedgerEntry[] | { degraded: string }>;
  /**
   * Inject the audit-only ledger WRITER that the auto-approval path
   * records its fact through (test injection). Mirrors the Claude
   * hook's option of the same name. Absent, the writer is resolved from
   * the manifest, lazily, and only on a call that already passed the
   * opt-in, `harnesses` and `when` checks.
   */
  writeLedger?: LedgerWriteFn;
}

export interface PackHookCodexPreToolUseResult {
  exitCode: number;
  blocked: boolean;
  approvalCheck: ApprovalCheckResult;
  /** Diagnostic line emitted to stderr (always; even on allow). */
  diagnostic: string;
}

interface CodexEventEnvelope {
  session_id?: unknown;
  tool_name?: unknown;
  raw_input?: unknown;
  // Real Codex sends tool arguments as `tool_input` (live capture,
  // Codex 0.150.1: the PreToolUse payload is shape-identical to Claude
  // Code's). `raw_input` above is harness's older published portable
  // shape, still accepted for shims built against it. The two exemptions
  // read both fields through `resolveCodexExemptionCommand` below, which
  // starts from the shared `resolveToolInput` (hook-bootstrap.ts)
  // precedence the sibling Codex PostToolUse hooks use and then applies
  // the two extra fail-closed rules a GATE decision needs.
  tool_input?: unknown;
  // Payload `permission_mode` (slice 1's `auto_approve.when` is an
  // allowlist over these literals) and `transcript_path` (the auto
  // path's session-consistency input on Codex, which carries no
  // session-id environment variable at all). Both stay `unknown`: the
  // auto path does every type check itself, fail-closed.
  permission_mode?: unknown;
  transcript_path?: unknown;
  // One Codex-native synonym tolerated: some integrations pass
  // `tool` instead of `tool_name`. We deliberately do NOT alias
  // `event.id` to session_id — `id` in most event-bus shapes is the
  // event/message id, not the session id, and silently resolving to
  // the wrong identifier would only show up as a misleading
  // diagnostic on a fail-block path.
  tool?: unknown;
}


function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

// Exported so sibling Codex hooks (e.g. hook-codex-post-tool-use.ts) that
// need the same "is this tool call shell-equivalent" test share one
// definition instead of re-declaring the alias list (task a1348c89).
export const CODEX_SHELL_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "shell",
  "exec_command",
  "functions.exec_command",
]);

function extractCodexShellCommand(rawInput: unknown): string | null {
  if (rawInput && typeof rawInput === "object") {
    const args = rawInput as { command?: unknown; cmd?: unknown };
    if (
      typeof args.command === "string" &&
      typeof args.cmd === "string" &&
      args.command.trim() !== args.cmd.trim()
    ) {
      return null;
    }
  }
  const command = extractShellCommand({ raw_input: rawInput });
  if (command !== null) return command;
  return typeof rawInput === "string" ? rawInput : null;
}

/**
 * The command the two EXEMPTIONS below (read-only Bash, recovery
 * `git commit`) are allowed to act on, or `null` when the payload does
 * not pin one down. Deliberately stricter than the shared
 * `resolveToolInput` (hook-bootstrap.ts), which stays as it is: its
 * other callers are PostToolUse observers whose worst case is a missed
 * observation, whereas here the classified command decides whether a
 * gated call is exempted (reviewer round-1 finding on slice 2). Two
 * differences, both fail-closed:
 *
 *   - `tool_input: null` is treated as ABSENT and falls back to
 *     `raw_input`, instead of shadowing it. `resolveToolInput` tests
 *     `!== undefined`, so a payload carrying an explicit null
 *     `tool_input` plus a real `raw_input` would otherwise classify to
 *     nothing.
 *   - When BOTH fields carry a command and they DISAGREE, this returns
 *     `null` rather than picking one. Otherwise a payload could pair a
 *     read-only `ls` in the preferred field with `rm -rf ...` in the
 *     other and be exempted on the harmless one while the runtime runs
 *     whichever field it itself reads.
 *
 * `null` is never an allow: both call sites fall through to the block
 * path, and the auto-approval attempt below does not read this at all.
 */
function resolveCodexExemptionCommand(event: CodexEventEnvelope): string | null {
  const toolInput = event.tool_input ?? undefined;
  const rawInput = event.raw_input ?? undefined;
  if (toolInput !== undefined && rawInput !== undefined) {
    const fromToolInput = extractCodexShellCommand(toolInput);
    const fromRawInput = extractCodexShellCommand(rawInput);
    if (fromToolInput === null || fromRawInput === null) return null;
    if (fromToolInput.trim() !== fromRawInput.trim()) return null;
    return fromToolInput;
  }
  if (toolInput !== undefined) return extractCodexShellCommand(toolInput);
  if (rawInput !== undefined) return extractCodexShellCommand(rawInput);
  return null;
}

async function checkLedger(
  manifest: Manifest,
  sessionId: string,
  opts: PackHookCodexPreToolUseOptions,
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

function allowResult(
  detail: string,
  source: ApprovalCheckResult["source"],
  stderr: NodeJS.WritableStream,
): PackHookCodexPreToolUseResult {
  const diagnostic = `harness pack hook codex: ${detail}, allowing.`;
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    blocked: false,
    approvalCheck: { approved: true, source, detail },
    diagnostic,
  };
}

export async function runPackHookCodexPreToolUseCli(
  opts: PackHookCodexPreToolUseOptions = {},
): Promise<PackHookCodexPreToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  // Read stdin defensively. Bad JSON falls through to allow (matches
  // Claude blocker's failure mode) but emits a stderr diagnostic so
  // the degradation is loud — a silently-allowing gate manufactures
  // false confidence, which is the worst direction for a governance
  // hook to fail in.
  const raw = await readStdin(stdin);
  let event: CodexEventEnvelope = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as CodexEventEnvelope;
  } catch (err) {
    stderr.write(
      `harness pack hook (codex): malformed event JSON on stdin (${
        (err as Error).message
      }), allowing.\n`,
    );
  }

  const sessionId =
    pickString(event.session_id) ??
    process.env["CODEX_SESSION_ID"] ??
    process.env["CLAUDE_CODE_SESSION_ID"] ??
    process.env["CLAUDE_SESSION_ID"] ??
    "";
  const toolName = pickString(event.tool_name, event.tool) ?? "(unknown)";

  // Pause sentinel — honoured BEFORE manifest load so the lockout-recovery
  // flow (broken install) still respects an active pause.
  if (checkHookPause("codex-pre-tool-use", stderr, opts, opts.generatedDir).paused) {
    return allowResult("harness paused", "none", stderr);
  }

  // Load manifest (or use injection). Bail to allow on any failure so a
  // missing harness install never bricks the session.
  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    return allowResult(
      `manifest load failed (${(err as Error).message})`,
      "none",
      stderr,
    );
  }

  // Confirm the pack is enabled.
  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return allowResult(`pack "${packName}" not declared in manifest`, "none", stderr);
  }
  if (!declared.enabled) {
    return allowResult(`pack "${packName}" is enabled:false`, "none", stderr);
  }

  if (sessionId === "") {
    return allowResult(
      "no session_id resolvable from input or $CODEX_SESSION_ID/$CLAUDE_CODE_SESSION_ID/$CLAUDE_SESSION_ID",
      "none",
      stderr,
    );
  }

  // Resolve generatedDir up-front for the marker check.
  const generatedDir =
    opts.generatedDir ??
    (manifestPath !== undefined
      ? resolveGeneratedDir({
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          manifestPath,
        })
      : undefined);

  // Source 1: filesystem marker (agent-tasks/88ca4bb3). Same boundary
  // as the Claude blocker: operator-authored marker beats ledger
  // self-approval. Falls through to ledger-as-audit when generatedDir
  // is unresolvable (test injection without a manifest path).
  // Task-scoped (active-claim) marker first, session marker second,
  // both under the `approval_lifecycle` TTL — shared with the Claude
  // hook via `checkOperatorApprovalMarkers` (task e7c2ec3c; the bare
  // `checkApprovalMarker` call here previously ignored `max_age` and
  // task-scoping, so those knobs silently applied only to Claude).
  // `markerExpired` is hoisted so the recovery-git-commit exception
  // (task 6e888423) below can see it: true only when a REAL marker
  // existed for this session/task and aged past
  // `approval_lifecycle.max_age`, not when one was simply never written
  // or was cleared by a task-completion boundary tool. Mirrors the
  // Claude hook (hook-pre-tool-use.ts) so the two runtimes stay in
  // lockstep, same rationale as `checkOperatorApprovalMarkers` itself.
  let markerExpired = false;
  // True when checkOperatorApprovalMarkers found a marker FILE that failed
  // signature verification (harness/f9485cc7), mirroring the Claude hook.
  let markerForged = false;
  if (generatedDir !== undefined) {
    const markers = checkOperatorApprovalMarkers(
      generatedDir,
      sessionId,
      declared.config,
      stderr,
    );
    markerExpired = markers.expired;
    markerForged = markers.forged;
    if (markers.source !== "task") {
      // Trace the task-marker miss, mirroring the Claude hook, so an
      // operator debugging a Codex session sees the active-claim vs
      // marker mismatch rather than only the generic session miss.
      stderr.write(
        `harness pack hook codex: task-scoped check: ${markers.taskCheckDetail}\n`,
      );
    }
    if (markers.matched) {
      return allowResult(markers.detail, "marker", stderr);
    }
  }

  // Persisted-report EVIDENCE probe (task 7402301d), mirroring the Claude
  // hook: no longer an approval source. `report.detail` feeds the block
  // reason (with the distinct `unsigned persisted-report approval
  // rejected` phrase when the on-disk status says approved) and
  // `report.report === null` gates the parse-error lookup below. The
  // signed marker is the only APPROVAL source that opens the gate in
  // this hook too. The read-only-Bash and recovery-git-commit carve-outs
  // below are separate, independently-argued exemptions, not a second
  // approval source.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const report = checkPersistedReport(reportsDir, sessionId);

  // Audit-only ledger probe.
  const ledger = await checkLedger(manifest, sessionId, opts);

  // Exception: read-only shell commands. Real Codex carries tool args in
  // `tool_input`, harness's older published envelope in `raw_input`;
  // `resolveCodexExemptionCommand` reads both (before this, a real Codex
  // payload's command was invisible here and every read-only `ls` hit
  // the block). If neither field carries a classifiable command — a
  // conflicting `command`/`cmd` pair, or two fields naming DIFFERENT
  // commands — this stays `null` and the call falls through to the block
  // path (fail-closed); see that function for the full argument.
  const commandStr = resolveCodexExemptionCommand(event);
  if (
    commandStr !== null &&
    CODEX_SHELL_TOOLS.has(toolName) &&
    isReadOnlyBashPipeline(commandStr)
  ) {
    const diagnostic = `harness pack hook codex: read-only Bash command, allowing without an approved report (\`${commandStr.trim()}\`)`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "none", detail: diagnostic },
      diagnostic,
    };
  }

  // Exception: the narrow recovery-git-commit shape (task 6e888423).
  // Mirrors the Claude hook's exemption exactly (see hook-pre-tool-use.ts
  // for the full safety argument): gated on BOTH `markerExpired` (a real
  // operator approval existed for this session/task and merely aged out
  // — not "never approved", not "cleared by a task-completion boundary")
  // and `isRecoveryGitCommit` (a bare, unchained `git commit` that
  // cannot smuggle other work or new file content).
  if (
    commandStr !== null &&
    CODEX_SHELL_TOOLS.has(toolName) &&
    markerExpired &&
    isRecoveryGitCommit(commandStr)
  ) {
    const diagnostic = `harness pack hook codex: recovery-commit exemption — approval for session ${sessionId} had expired, but this session/task WAS previously approved; allowing the bare \`git commit\` to record already-approved work (\`${commandStr.trim()}\`). A fresh Understanding Report is still required for any new Edit/Write/Bash.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "recovery-commit", detail: diagnostic },
      diagnostic,
    };
  }

  // Step 9: the operator-opt-in auto-approval attempt (slice 2 of
  // docs/decisions/2026-08-27-ug-auto-mode-approval.md, agent-tasks/
  // 57058364). The SAME `attemptAutoApproval` the Claude hook calls, at
  // the same place in the decision order: last, on a call that the
  // marker check (source 1) and both exemptions above have already
  // declined — i.e. exactly a call that would otherwise reach the final
  // block. So a read-only `ls` or a recovery `git commit` mints nothing,
  // and `max_age` starts counting from the call that actually needed an
  // approval. Arguments carry everything that is Codex-specific:
  // `harness: CODEX_HARNESS` (the minted `approvedBy` reads
  // `auto-mode:codex:<mode>`, so an audit can tell the runtimes apart),
  // the transcript-path session-consistency check (a Codex hook process
  // carries no session-id environment variable for the Claude variant to
  // compare against), and this hook's own ledger `source` and stderr
  // label.
  //
  // Sharing the body does NOT share the opt-in: the attempt declines
  // unless the operator listed `codex` in `auto_approve.harnesses`,
  // which an `auto_approve` block written before this hook existed does
  // not (an absent key means Claude Code only).
  //
  // It never returns an allow of its own: the allow below comes from the
  // auto path's own re-run of `checkOperatorApprovalMarkers`, the same
  // authority source 1 consults, and is reported through this hook's
  // ordinary `allowResult` with `source: "marker"`. Any failure falls
  // through to the block with `markerExpired` / `markerForged` intact.
  //
  // Placed BEFORE the `.pending-approval` staging write below on
  // purpose: a successful auto-approval must not leave this session id
  // staged for a later arg-less `harness approve understanding` to
  // resolve to.
  //
  // The ledger writer resolves lazily, exactly like the Claude hook: the
  // thunk runs only after the auto path's own opt-in and `when` checks
  // both pass, so an ordinary gated Codex call never resolves one.
  const resolveAutoLedger = (): { write: LedgerWriteFn | null; reason?: string } => {
    if (opts.writeLedger) return { write: opts.writeLedger };
    const resolved = resolveManifestLedgerWriter(manifest, {
      ...(opts.ledgerTimeoutMs !== undefined ? { ledgerTimeoutMs: opts.ledgerTimeoutMs } : {}),
    });
    return resolved.ok ? { write: resolved.write } : { write: null, reason: resolved.reason };
  };
  const auto = await attemptAutoApproval({
    generatedDir,
    sessionId,
    payloadSessionId: event.session_id,
    permissionMode: event.permission_mode,
    harness: CODEX_HARNESS,
    // This hook's own verb on the audit-only ledger fact and its own
    // stderr prefix, so neither an audit row nor a diagnostic line
    // attributes a Codex decision to the Claude Code hook.
    ledgerSource: AUTO_APPROVE_LEDGER_SOURCE_CODEX,
    label: "harness pack hook codex",
    sessionConsistency: { kind: "transcript-path", transcriptPath: event.transcript_path },
    packConfig: declared.config,
    reportsDir,
    markerForged,
    stderr,
    resolveLedger: resolveAutoLedger,
  });
  if (auto.approved) {
    return allowResult(auto.detail, "marker", stderr);
  }

  // Stage the session id so `harness approve understanding`, run from
  // the operator's shell where none of $CODEX_SESSION_ID,
  // $CLAUDE_CODE_SESSION_ID or $CLAUDE_SESSION_ID is set, can resolve it without scraping logs or
  // grepping transcript dirs. Mirrors the Claude blocker's symmetric
  // staging (hook-pre-tool-use.ts) so arg-less approval after a Codex
  // PreToolUse block has the same shape. Best-effort: a staging-write
  // failure must not escalate a gate block into a hook error.
  if (generatedDir !== undefined) {
    try {
      writePendingApproval(generatedDir, sessionId);
    } catch {
      /* best-effort; the block below proceeds regardless */
    }
  }

  // Neither operator source approved. Codex blocks via non-zero exit
  // + stderr reason; there is no JSON-decision wire to write to stdout.
  // Mirrors the Claude hook's distinct forged-marker reason (harness/f9485cc7).
  const reason = generatedDir !== undefined
    ? markerForged
      ? `forged/unsigned marker rejected for session ${sessionId}; ${report.detail}; ${ledger.detail}`
      : `no approval marker for session ${sessionId}; ${report.detail}; ${ledger.detail}`
    : `generatedDir not resolvable (test/injection path); ${report.detail}; ${ledger.detail}`;
  // When the pack config declares `ux:`, the agent-facing block becomes
  // the plain-language shape and the legacy schemaHint text is
  // suppressed. The engine-vocabulary `reason` still lands in stderr
  // (operator audit surface, not agent surface) so a flapping gate
  // remains diagnosable.
  const configUx = parseConfigUx(
    (declared.config as Record<string, unknown>)["ux"],
    stderr,
    "harness pack hook codex",
  );
  let agentFacing = configUx
    ? renderAgentFacing(configUx, { SESSION_ID: sessionId, TOOL_NAME: toolName })
    : `Run \`harness approve understanding\` once you have produced and confirmed an Understanding Report.\n${renderReportSchemaHint()}`;
  // Best-effort lookup of the session's latest parse-error log (task
  // 823837fd, follow-up gate task 823837fd review), mirroring the Claude
  // hook (hook-pre-tool-use.ts): the standalone Stop hook / `harness
  // approve understanding` stdin-report path writes one to
  // `<reports-parent>/parse-errors/` when the agent's report failed to
  // parse. Gated on `report.report === null` (no persisted report at
  // all for this session): a report that WAS persisted but is merely
  // pending approval must not surface a stale parse-error from an
  // earlier, already-fixed attempt; mirrors the CLI's own gate (`if
  // (!latest)`, approve/understanding.ts). Moved here, right before the
  // block render and after every exemption early-return above, so the
  // lookup only runs on the path that actually renders it (pure code
  // motion from its previous location right after `checkPersistedReport`).
  const latestParseError =
    report.report === null
      ? findLatestParseError(path.join(path.dirname(reportsDir), "parse-errors"), sessionId)
      : null;
  // Name the malformed sections from that log, when it carries any:
  // shared with the Claude hook's identical append via
  // `renderMalformedSectionsNotice` (approve/understanding.ts) so the two
  // runtimes cannot drift apart byte-for-byte.
  const malformedNotice = renderMalformedSectionsNotice(
    latestParseError?.malformedSections ?? [],
  );
  if (malformedNotice) {
    agentFacing = `${agentFacing}\n\n${malformedNotice}`;
  }
  const diagnostic = configUx
    ? `harness pack hook codex: BLOCK: ${reason}.\n${agentFacing}`
    : `harness pack hook codex: BLOCK: ${reason}. Tool: ${toolName}. ${agentFacing}`;
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: EXIT_BLOCK,
    blocked: true,
    approvalCheck: { approved: false, source: "none", detail: reason },
    diagnostic,
  };
}
