// Phase 7 — render the policy `producers:` list into the deny-envelope
// reason. The schema (src/schema/policies.ts ProducerSchema) allows three
// kinds: bash / mcp / ask. Each is one concrete way for the agent to
// produce the ledger evidence that would unblock the gate.
//
// The renderer keeps the engine itself neutral on producer choice
// (policies opt in by declaring `producers:`; absent producers means no
// hint appended, same as today). When present, every entry's `${VAR}`
// templates are substituted against the same extract.values map the
// ledger_tag was resolved with, so the rendered text reflects the
// exact context the agent just hit.
//
// At-least-one-mcp is enforced at schema-validate time, so by the time
// the engine renders, the list is guaranteed to carry an ungated MCP
// recovery path (relevant when the agent is in a Bash lockout).

import type { Producer } from "../schema/index.js";
import { substituteTemplate } from "./extract.js";

function substituteAll(
  template: string,
  values: Record<string, string>,
): string {
  // Best-effort substitution: unresolved ${VARS} are left literal so the
  // agent can still read what was expected (vs. silently dropping). The
  // schema validator already guarantees ledger_tag's vars are declared;
  // producer fields are free-form text and may reference any of the
  // resolved values, so a stray ${UNKNOWN} stays visible.
  return substituteTemplate(template, values).result;
}

function renderOne(p: Producer, values: Record<string, string>): string {
  switch (p.kind) {
    case "bash":
      return `[bash] \`${substituteAll(p.command, values)}\` — ${substituteAll(p.description, values)}`;
    case "mcp":
      return `[mcp]  ${p.verb} example=${substituteAll(p.example, values)} — ${substituteAll(p.description, values)}`;
    case "ask":
      return `[ask]  \`${substituteAll(p.command, values)}\` — ${substituteAll(p.description, values)}`;
    default: {
      // exhaustive guard: TS narrows ProducerSchema's discriminated union;
      // a future kind that forgets to update this switch trips the compiler.
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

/**
 * Render the policy's producers list into a multi-line block suitable
 * for appending to a deny envelope's `reason`. Returns the empty string
 * when the list is undefined or empty, so callers can concat unconditionally.
 *
 * Format:
 *   To produce this tag:
 *     1. [kind] <one-line summary> — <description>
 *     2. ...
 */
export function renderProducers(
  producers: Producer[] | undefined,
  values: Record<string, string>,
): string {
  if (!producers || producers.length === 0) return "";
  const lines = producers.map((p, i) => `  ${i + 1}. ${renderOne(p, values)}`);
  return `\nTo produce this tag:\n${lines.join("\n")}`;
}
