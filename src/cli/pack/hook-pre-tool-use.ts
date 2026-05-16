// Phase 6 #4 — `harness pack hook pre-tool-use [--pack <name>]` runtime verb.
//
// PreToolUse blocker for pack-driven gates. Wired by the
// understanding-before-execution pack's hook contribution; receives the
// Claude Code event JSON on stdin, consults the two approval sources
// (evidence ledger via grounding-mcp, persisted JSON report under
// `.understanding-gate/reports/`), emits a `{decision: "block"}` JSON to
// stdout when neither source has approved.
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

import {
  queryLedgerByTag,
  type LedgerEntry,
} from "../../policies/index.js";
import { renderProducers } from "../../policies/producers.js";
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
import {
  ProducerSchema,
  type Manifest,
  type McpServer,
  type Producer,
} from "../../schema/index.js";
import { z } from "zod";
import { loadManifest, type LoaderOptions } from "../loader.js";
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

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", (err) => reject(err));
  });
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

function blockJson(
  toolName: string,
  reason: string,
  producers: Producer[] | undefined,
  sessionId: string,
): string {
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
  const reasonText = `Understanding Gate: ${reason}. Tool: ${toolName}. ${suffix}\n${schemaHint}${producersBlock}`;
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

function isEscapeCommand(command: string): boolean {
  // The operator-approval command `harness approve ...`. The Understanding
  // Gate must not hard-deny it: a `deny` gives no interactive prompt, so
  // denying the very command that records the operator's approval makes the
  // gate un-recoverable from inside the session. Deliberately strict: the
  // command must BE a `harness approve` invocation, with no shell chaining,
  // substitution, or redirection, so the allowlist cannot be used to smuggle
  // other work past the gate.
  const trimmed = command.trim();
  if (/[;&|\n<>]/.test(trimmed)) return false;
  if (trimmed.includes("`") || trimmed.includes("$(")) return false;
  return /^harness\s+approve\b/.test(trimmed);
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
  // policy intercept's failure mode).
  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    /* allow on malformed input */
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";
  const rawCommand =
    event.tool_input && typeof event.tool_input === "object"
      ? (event.tool_input as { command?: unknown }).command
      : undefined;
  const commandStr = typeof rawCommand === "string" ? rawCommand : "";

  // Load manifest (or use injection). Bail to allow on any failure so a
  // missing harness install never bricks the session. The resolved
  // manifest path feeds the harness.generated/ lookup below; an injected
  // manifest has no path, so the staging write is skipped in that case
  // (tests inject `generatedDir` directly instead).
  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    if (opts.manifest) {
      manifest = opts.manifest;
    } else {
      const loaded = loadManifest(opts);
      manifest = loaded.manifest;
      manifestPath = loaded.resolved.base;
    }
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
      'harness pack hook: no session_id resolvable from input or $CLAUDE_SESSION_ID, allowing.';
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
  if (generatedDir !== undefined) {
    const marker = checkApprovalMarker(generatedDir, sessionId);
    if (marker.matched) {
      const diagnostic = `harness pack hook: ${marker.detail}, allowing.`;
      stderr.write(`${diagnostic}\n`);
      return {
        exitCode: 0,
        blocked: false,
        approvalCheck: { approved: true, source: "marker", detail: marker.detail },
        diagnostic,
      };
    }
  }

  // Source 2: persisted report. Operator-authored (the agent's Stop
  // hook only writes `pending`; flipping to `approved` requires the
  // operator-side rewrite path in `harness approve understanding`),
  // and the agent has no Edit / Write / Bash path to forge it.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const report = checkPersistedReport(reportsDir, sessionId);
  if (report.approved) {
    const diagnostic = `harness pack hook: ${report.detail}, allowing.`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      blocked: false,
      approvalCheck: { approved: true, source: "persisted-report", detail: report.detail },
      diagnostic,
    };
  }

  // Audit-only ledger probe: the ledger row is still recorded by
  // `harness approve understanding`, and we surface its presence in
  // the diagnostic so an operator chasing a flapping gate can see the
  // historic trail. The result intentionally does NOT influence the
  // allow/block decision.
  const ledger = await checkLedger(manifest, sessionId, opts);

  // Neither operator source approved.
  const reason = generatedDir !== undefined
    ? `no approval marker for session ${sessionId}; ${report.detail}; ${ledger.detail}`
    : `generatedDir not resolvable (test/injection path); ${report.detail}; ${ledger.detail}`;

  // Stage the session id so `harness approve`, run from the operator's
  // shell where $CLAUDE_SESSION_ID is unset, can resolve it without
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
  stdout.write(
    `${blockJson(toolName, "no approved Understanding Report for this session", configProducers, sessionId)}\n`,
  );
  return {
    exitCode: 0,
    blocked: true,
    approvalCheck: { approved: false, source: "none", detail: reason },
    diagnostic,
  };
}
