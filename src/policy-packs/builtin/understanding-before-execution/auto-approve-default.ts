// Canonical shipped default for `auto_approve` (D-004, task 8f637efd,
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Amendment: install
// default"). One source of truth for the exact shape and wording that
// three surfaces need to agree on byte-for-byte:
//
//   - `harness init` (FULL_TEMPLATE, SOLO_TEMPLATE, TEAM_TEMPLATE): the
//     block a fresh manifest ships with.
//   - `harness pack upgrade understanding-before-execution`: the block
//     it inserts into an existing manifest that predates this default.
//   - `harness doctor`'s "bypassPermissions observed, auto_approve
//     missing" finding: the snippet it prints as the remediation.
//
// Keeping these as one importable source (rather than three hand-synced
// literals) means a future wording or shape change cannot land in one
// surface without the other two, the same failure class task 68b9ad9c
// fixed for `config.ux` / `config.producers` via `defaultUx()` /
// `defaultProducers()` in the sibling `understanding-before-execution.ts`.
//
// Rationale for shipping this ACTIVE (not commented out) by default:
// under `bypassPermissions` the permission system is off by the
// operator's own launch choice (`--dangerously-skip-permissions` /
// `--permission-mode bypassPermissions`); a human approval prompt there
// is exactly the friction that mode exists to remove. `require_report:
// true` is unchanged (it is the only schema-valid value), and every
// template that carries this block also ships `mode: grill_me`, so the
// report the auto path consumes was actually checked, not merely
// present. The opt-in stays a visible, deletable config key: an
// existing install is never changed silently, only through the
// explicit `pack upgrade` verb.

import { CLAUDE_CODE_HARNESS } from "./auto-approve.js";

/** `auto_approve.when` value this default ships. */
export const AUTO_APPROVE_DEFAULT_WHEN: readonly string[] = ["bypassPermissions"];

/** `auto_approve.harnesses` value this default ships. */
export const AUTO_APPROVE_DEFAULT_HARNESSES: readonly string[] = [CLAUDE_CODE_HARNESS];

export interface AutoApproveDefaultConfig {
  when: string[];
  harnesses: string[];
  require_report: true;
}

/**
 * The parsed-YAML shape of the shipped default, for structural equality
 * assertions against a template's parsed `config.auto_approve` (mirrors
 * how `defaultUx()` / `defaultProducers()` are consumed by
 * `tests/cli/init-templates-ux-parity.test.ts`).
 */
export function defaultAutoApproveConfig(): AutoApproveDefaultConfig {
  return {
    when: [...AUTO_APPROVE_DEFAULT_WHEN],
    harnesses: [...AUTO_APPROVE_DEFAULT_HARNESSES],
    require_report: true,
  };
}

/**
 * Explanatory comment lines rendered above the `auto_approve:` mapping,
 * WITHOUT the leading `# ` marker or indentation: callers supply both,
 * since the same lines render at different indents in `harness init`
 * templates vs. the `pack upgrade` text-level insertion. Deliberately
 * short: what the block does, that `bypassPermissions` is the
 * operator's own launch choice, and that deleting the block restores
 * the manual prompt.
 */
export const AUTO_APPROVE_COMMENT_LINES: readonly string[] = [
  "auto_approve (shipped default): a session started with",
  "bypassPermissions gets its Understanding Report approved by the",
  "hook's signed auto path instead of a human `harness approve",
  "understanding` prompt; the report itself stays mandatory.",
  "bypassPermissions is the operator's own launch choice",
  "(--dangerously-skip-permissions / --permission-mode",
  "bypassPermissions). Delete this block to restore the manual prompt.",
];

/**
 * Render the full snippet (comment block + `auto_approve:` mapping) so
 * that `auto_approve:` itself sits at `indent` spaces, matching the
 * indentation of its sibling `config:` keys (`mode:`,
 * `approval_lifecycle:`, ...). Each line is independently indented, no
 * trailing newline, so callers can join it directly into a YAML
 * document with no further reformatting.
 */
export function renderAutoApproveSnippet(indent: number): string {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  const lines: string[] = [];
  for (const c of AUTO_APPROVE_COMMENT_LINES) lines.push(`${pad}# ${c}`);
  lines.push(`${pad}auto_approve:`);
  lines.push(`${childPad}when: [${AUTO_APPROVE_DEFAULT_WHEN.join(", ")}]`);
  lines.push(`${childPad}harnesses: [${AUTO_APPROVE_DEFAULT_HARNESSES.join(", ")}]`);
  lines.push(`${childPad}require_report: true`);
  return lines.join("\n");
}
