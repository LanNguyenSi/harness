// Phase 6 #6 — `harness pack hook codex-pre-tool-use` runtime verb.
//
// Codex variant of the Claude Code blocker (`hook-pre-tool-use.ts`).
// Same approval logic (ledger + persisted-report, either approves), but
// a different I/O contract:
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

import { queryLedgerByTag, type LedgerEntry } from "../../policies/index.js";
import {
  checkApprovalMarker,
  checkPersistedReport,
  defaultReportsDir,
  matchLedgerEntries,
  type ApprovalCheckResult,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  resolveGeneratedDir,
  writePendingApproval,
} from "../../runtime/pending-approval.js";
import { extractShellCommand } from "../../runtime/tool-name-aliases.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import { PolicyUxSchema, type Manifest, type McpServer, type PolicyUx } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { isReadOnlyBashPipeline } from "../../runtime/read-only-bash.js";
import { renderReportSchemaHint } from "./understanding-report-schema-hint.js";
import {
  checkHookPause,
  loadManifestOrInjected,
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
  // One Codex-native synonym tolerated: some integrations pass
  // `tool` instead of `tool_name`. We deliberately do NOT alias
  // `event.id` to session_id — `id` in most event-bus shapes is the
  // event/message id, not the session id, and silently resolving to
  // the wrong identifier would only show up as a misleading
  // diagnostic on a fail-block path.
  tool?: unknown;
}

function parseConfigUx(
  raw: unknown,
  stderr: NodeJS.WritableStream,
): PolicyUx | undefined {
  if (raw === undefined) return undefined;
  const result = PolicyUxSchema.safeParse(raw);
  if (!result.success) {
    stderr.write(
      `harness pack hook codex: config.ux ignored (${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")})\n`,
    );
    return undefined;
  }
  return result.data;
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

const CODEX_SHELL_TOOLS: ReadonlySet<string> = new Set([
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
  if (generatedDir !== undefined) {
    const marker = checkApprovalMarker(generatedDir, sessionId);
    if (marker.matched) {
      return allowResult(marker.detail, "marker", stderr);
    }
  }

  // Source 2: persisted report.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const report = checkPersistedReport(reportsDir, sessionId);
  if (report.approved) {
    return allowResult(report.detail, "persisted-report", stderr);
  }

  // Audit-only ledger probe.
  const ledger = await checkLedger(manifest, sessionId, opts);

  // Exception: read-only shell commands. Codex's documented hook
  // envelope carries tool args in `raw_input`; if that field is absent
  // or unclassifiable, fall through to the block path (fail-closed).
  const commandStr = extractCodexShellCommand(event.raw_input);
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
  const reason = generatedDir !== undefined
    ? `no approval marker for session ${sessionId}; ${report.detail}; ${ledger.detail}`
    : `generatedDir not resolvable (test/injection path); ${report.detail}; ${ledger.detail}`;
  // When the pack config declares `ux:`, the agent-facing block becomes
  // the plain-language shape and the legacy schemaHint text is
  // suppressed. The engine-vocabulary `reason` still lands in stderr
  // (operator audit surface, not agent surface) so a flapping gate
  // remains diagnosable.
  const configUx = parseConfigUx(
    (declared.config as Record<string, unknown>)["ux"],
    stderr,
  );
  const agentFacing = configUx
    ? renderAgentFacing(configUx, { SESSION_ID: sessionId, TOOL_NAME: toolName })
    : `Run \`harness approve understanding\` once you have produced and confirmed an Understanding Report.\n${renderReportSchemaHint()}`;
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
