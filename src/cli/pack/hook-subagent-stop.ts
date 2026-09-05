// `harness pack hook subagent-stop` — remove the in-flight record a
// `subagent-start` invocation wrote for this `(session_id, agent_id)`
// pair (docs/decisions/2026-08-27-ug-auto-mode-approval.md "TTL, cwd,
// and subagents"). The subagent has finished; its copy of the parent's
// approval no longer has anything to authorize.
//
// Idempotent and never blocks: a missing record (never written, already
// cleared, or the parent never had approval to copy) is a no-op, same
// as `clearInflightRecord` itself. Every path resolves to exit 0 +
// stderr diagnostic.

import {
  clearInflightRecord,
  rejectMalformedAgentId,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { readStdin, resolveSubagentHookContext } from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";
const HOOK_LABEL = "harness pack hook: subagent-stop";

export interface PackHookSubagentStopOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
}

export interface PackHookSubagentStopResult {
  exitCode: number;
  /** Was clearInflightRecord actually invoked (ids valid, pack enabled)? */
  cleared: boolean;
  sessionId: string | null;
  agentId: string | null;
  /** Diagnostic line emitted to stderr. */
  diagnostic: string;
}

interface SubagentStopEventLite {
  session_id?: unknown;
  agent_id?: unknown;
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
  sessionId: string | null = null,
  agentId: string | null = null,
): PackHookSubagentStopResult {
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, cleared: false, sessionId, agentId, diagnostic };
}

export async function runPackHookSubagentStopCli(
  opts: PackHookSubagentStopOptions = {},
): Promise<PackHookSubagentStopResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin);
  let event: SubagentStopEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as SubagentStopEventLite;
  } catch {
    return noop(`${HOOK_LABEL}: malformed event JSON, skipping`, stderr);
  }

  const ctxResult = resolveSubagentHookContext(
    HOOK_LABEL,
    "subagent-stop",
    packName,
    event,
    rejectMalformedAgentId,
    { ...opts, stderr },
  );
  if (!ctxResult.ok) {
    return noop(ctxResult.diagnostic, stderr, ctxResult.sessionId, ctxResult.agentId);
  }
  const { sessionId, agentId, generatedDir } = ctxResult.context;

  clearInflightRecord(generatedDir, sessionId, agentId);
  const diagnostic = `${HOOK_LABEL}: cleared in-flight record for agent ${agentId}`;
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, cleared: true, sessionId, agentId, diagnostic };
}
