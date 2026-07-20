// Shared manifest -> grounding-mcp ledger-writer wiring (task T-001,
// record-verbs).
//
// `harness session-start preflight` originally inlined this lookup
// (find the `grounding-mcp` MCP server entry in the manifest, split its
// `command` into an argv array, resolve a per-call timeout, and close
// over `addLedgerFact`). `harness record {review,review-subagent,
// dogfood}` needs the exact same wiring, so it is lifted here verbatim
// — behavior unchanged, just made reusable. `session-start/index.ts`
// now imports this instead of defining its own copies.

import { addLedgerFact, type AddLedgerFactResult } from "./ledger-add.js";
import type { Manifest, McpServer } from "../schema/index.js";

export interface LedgerWriteArgs {
  sessionId: string;
  content: string;
  source: string;
}

export type LedgerWriteFn = (args: LedgerWriteArgs) => Promise<AddLedgerFactResult>;

export function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

export function mcpCommandList(server: McpServer): string[] {
  return Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
}

/**
 * Resolve a `LedgerWriteFn` bound to the manifest's declared
 * `grounding-mcp` server, or `{ ok: false, reason }` when no such
 * server is declared. Callers that want a verb-specific tail on the
 * reason (e.g. "; cannot record preflight tag") append it themselves —
 * this function's message stays generic so it is reusable verbatim
 * across every producer.
 */
export function resolveManifestLedgerWriter(
  manifest: Manifest,
  opts: { ledgerTimeoutMs?: number } = {},
): { ok: true; write: LedgerWriteFn } | { ok: false; reason: string } {
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  const command = mcpCommandList(server);
  const env = server.env ?? undefined;
  const timeoutMs = opts.ledgerTimeoutMs ?? server.health?.timeout_ms ?? 5_000;
  return {
    ok: true,
    write: (args) =>
      addLedgerFact({
        mcpCommand: command,
        ...(env && { mcpEnv: env }),
        timeoutMs,
        ...args,
      }),
  };
}
