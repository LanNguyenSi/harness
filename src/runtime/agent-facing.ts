// Agent-facing block message renderer.
//
// Translates a policy pack's `config.ux` declaration (branch-protection) into
// the plain-language form the agent sees on block. This module is concerned
// only with the user-facing surface.
//
// Output shape, verbatim (the shipped branch-protection default `ux`,
// with `${BRANCH}` resolved to `main`):
//
//   You cannot edit files on protected branch main yet.
//
//   Required:
//   - a checkout of a non-protected branch (current `main` is protected)
//
//   Run:
//     git checkout -b feat/<your-task>
//
// Three sections every time: state (what's blocked), requirement
// (what's missing, in plain words, never "ledger entry for tag X"),
// remedy (the exact command). Each list item gets a `- ` prefix in
// `Required:` and a two-space indent under `Run:` so the eye lands on
// the command as something to type.
//
// `${VAR}` references in any of the three fields resolve against the values
// map the caller passes (the branch-protection hook supplies `BRANCH`).
// Unresolved vars are left literal so the agent can still read what was
// expected.

import type { PolicyUx } from "../schema/index.js";

const TEMPLATE_VAR_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export interface SubstituteTemplateResult {
  result: string;
  missing: string[];
}

/**
 * Replace each `${NAME}` in `template` with `values[NAME]`. A name without a
 * value stays literal and is listed in `missing`.
 */
export function substituteTemplate(
  template: string,
  values: Record<string, string>,
): SubstituteTemplateResult {
  const missing: string[] = [];
  const result = template.replace(TEMPLATE_VAR_RE, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name]!;
    }
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
  return { result, missing };
}

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
