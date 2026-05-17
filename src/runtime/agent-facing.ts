// Agent-facing block message renderer.
//
// Translates a policy's `ux:` declaration into the plain-language form
// the agent sees on block. The internal model (session IDs, ledger
// entries, attestations, provenance chains, policy DAGs) is unchanged
// and continues to feed the audit ledger; this module is concerned
// only with the user-facing surface.
//
// Output shape, verbatim:
//
//   You cannot investigate this repository yet.
//
//   Required:
//   - verified repository preflight
//
//   Run:
//     harness preflight
//
// Three sections every time: state (what's blocked), requirement
// (what's missing, in plain words, never "ledger entry for tag X"),
// remedy (the exact command). Each list item gets a `- ` prefix in
// `Required:` and a two-space indent under `Run:` so the eye lands on
// the command as something to type.
//
// `${VAR}` references in any of the three fields resolve against the
// same extract.values map the ledger_tag was substituted with, plus
// the builtins (SESSION_ID / REPO / BRANCH / TOOL_NAME / CWD).
// Unresolved vars are left literal so the agent can still read what
// was expected (mirrors renderProducers' best-effort substitution).

import { substituteTemplate } from "../policies/extract.js";
import type { PolicyUx } from "../schema/index.js";

export interface AgentFacingBlock {
  cannot: string;
  required: string[];
  run: string[];
}

export function buildAgentFacingBlock(
  ux: PolicyUx,
  values: Record<string, string>,
): AgentFacingBlock {
  const sub = (s: string): string => substituteTemplate(s, values).result;
  return {
    cannot: sub(ux.cannot),
    required: ux.required.map(sub),
    run: ux.run.map(sub),
  };
}

export function formatAgentFacingMessage(block: AgentFacingBlock): string {
  const requiredLines = block.required.map((r) => `- ${r}`).join("\n");
  const runLines = block.run.map((r) => `  ${r}`).join("\n");
  return `${block.cannot}\n\nRequired:\n${requiredLines}\n\nRun:\n${runLines}`;
}

export function renderAgentFacing(
  ux: PolicyUx,
  values: Record<string, string>,
): string {
  return formatAgentFacingMessage(buildAgentFacingBlock(ux, values));
}
