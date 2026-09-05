// `harness pack hook subagent-start` — write an in-flight record for a
// newly-started Agent-tool subagent (docs/decisions/2026-08-27-ug-auto-
// mode-approval.md "TTL, cwd, and subagents").
//
// SubagentStart fires on the PARENT session's `session_id` (subagents
// share it, they never get one of their own); Claude Code additionally
// carries `agent_id` and `agent_type` on this event. This hook consults
// the same operator-approval authority the PreToolUse blocker does
// (`checkOperatorApprovalMarkers`) and, only when it matches, copies
// that approval into a signed in-flight record keyed by
// `(session_id, agent_id)` — see inflight-records.ts's module header
// for why this is a COPY of authority already granted, never a new
// grant. When the parent holds no valid approval at spawn time, nothing
// is written and the subagent gets no record to present later.
//
// Never blocks: this hook has no gating role of its own (a later slice
// teaches the PreToolUse blocker to consult the record it produces
// here). Every error and refusal path resolves to exit 0 + stderr
// diagnostic, mirroring every other hook in this pack.

import {
  checkOperatorApprovalMarkers,
  rejectMalformedAgentId,
  writeInflightRecord,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  pickString,
  readStdin,
  resolveSubagentHookContext,
} from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";
const HOOK_LABEL = "harness pack hook: subagent-start";

export interface PackHookSubagentStartOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
  /** Override the issue timestamp for deterministic tests. */
  now?: Date;
}

export interface PackHookSubagentStartResult {
  exitCode: number;
  /** Was an in-flight record actually written? */
  recordWritten: boolean;
  sessionId: string | null;
  agentId: string | null;
  /** Diagnostic line emitted to stderr. */
  diagnostic: string;
}

interface SubagentStartEventLite {
  session_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
  sessionId: string | null = null,
  agentId: string | null = null,
): PackHookSubagentStartResult {
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, recordWritten: false, sessionId, agentId, diagnostic };
}

export async function runPackHookSubagentStartCli(
  opts: PackHookSubagentStartOptions = {},
): Promise<PackHookSubagentStartResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin);
  let event: SubagentStartEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as SubagentStartEventLite;
  } catch {
    return noop(`${HOOK_LABEL}: malformed event JSON, skipping`, stderr);
  }

  // Pause sentinel checked before anything else, ids resolved, then pack
  // context resolved — same as every other hook in this pack.
  const ctxResult = resolveSubagentHookContext(
    HOOK_LABEL,
    "subagent-start",
    packName,
    event,
    rejectMalformedAgentId,
    { ...opts, stderr },
  );
  if (!ctxResult.ok) {
    return noop(ctxResult.diagnostic, stderr, ctxResult.sessionId, ctxResult.agentId);
  }
  const { sessionId, agentId, declared, generatedDir } = ctxResult.context;
  const agentType = pickString(event.agent_type) ?? "unknown";

  const approval = checkOperatorApprovalMarkers(
    generatedDir,
    sessionId,
    declared.config,
    stderr,
  );
  if (!approval.matched) {
    const diagnostic = `${HOOK_LABEL}: parent session ${sessionId} holds no valid approval; no in-flight record for agent ${agentId}`;
    stderr.write(`${diagnostic}\n`);
    return { exitCode: 0, recordWritten: false, sessionId, agentId, diagnostic };
  }

  const writeOpts: Parameters<typeof writeInflightRecord>[0] = {
    generatedDir,
    sessionId,
    agentId,
    agentType,
    parent: approval,
  };
  if (opts.now) writeOpts.now = opts.now;
  const result = writeInflightRecord(writeOpts);
  if (!result.ok) {
    return noop(
      `${HOOK_LABEL}: writeInflightRecord failed for agent ${agentId} (${result.reason}: ${result.detail})`,
      stderr,
      sessionId,
      agentId,
    );
  }

  const diagnostic = `${HOOK_LABEL}: wrote in-flight record for agent ${agentId} (parent=${approval.source})`;
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, recordWritten: true, sessionId, agentId, diagnostic };
}
