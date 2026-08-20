// Post-apply "Next steps" hint.
//
// Motivation: a fresh adopter who runs `harness apply` for the first time
// gets a one-line summary and is then on their own to figure out what to
// do with `harness.generated/`. Concrete failure mode (2026-05-03): an
// agent left a task note suggesting `claude -p ... --output-dir ...`, a
// hallucinated flag. Surfacing the actual wire-up incantations in the
// apply output prevents that class of fabrication.
//
// Pure function: takes the relevant subset of an ApplyResult, returns the
// hint text (or empty string when there's nothing to suggest). The CLI
// layer is responsible for deciding whether to print it (--quiet, --json,
// dry-run, etc).
//
// Runtime awareness (task f9d49e97; reviewer finding, batch18-R1, on
// f34eb233, verified PRE-EXISTING): this module used to ignore `--runtime`
// entirely and always emit the Claude Code settings.json-merge /
// `claude -p` block, even under `--runtime codex` and `--runtime opencode`
// -- both of which reject `--target` outright (apply.ts) and neither of
// which emits a settings.json, so both suggested commands were impossible
// under those runtimes. The codex/opencode hints below intentionally
// mirror the real wiring text already shipped in those runtimes' own
// generated-file banners (generate-codex-config.ts's HEADER,
// generate-opencode-config.ts's HEADER) instead of inventing new wording,
// so the two stay consistent if the banners change.

import type { Runtime } from "../../policy-packs/index.js";

export interface NextStepsContext {
  /** Set when --target was passed and the target file was actually written. */
  targetPath?: string;
  /** Path of harness.generated/settings.json (always present on a successful apply). */
  generatedSettingsPath: string;
  /**
   * True when the apply made on-disk changes. Used to soften the no-target
   * lede on re-runs where the generated files are already up to date and
   * the operator may have wired a target on a previous run, so claiming
   * "nothing is wired into Claude Code yet" would be a falsehood.
   */
  anyChanged?: boolean;
  /**
   * Adapter runtime selected via `--runtime`. Defaults to "claude-code"
   * (matches `DEFAULT_RUNTIME`) when omitted, so every pre-existing caller
   * that never set this field keeps getting the original Claude Code hint
   * unchanged.
   */
  runtime?: Runtime;
  /**
   * Path of harness.generated/codex/config.toml. Only read when
   * `runtime === "codex"`; falls back to the relative path (matching the
   * wording `harness apply --help` already uses) when omitted.
   */
  codexConfigPath?: string;
  /**
   * Path of harness.generated/opencode/opencode.json. Only read when
   * `runtime === "opencode"`; falls back to the relative path (matching
   * the wording `harness apply --help` already uses) when omitted.
   */
  opencodeConfigPath?: string;
}

function formatCodexNextSteps(ctx: NextStepsContext): string {
  const configPath = ctx.codexConfigPath ?? "harness.generated/codex/config.toml";
  const lede =
    ctx.anyChanged === false
      ? "Codex config is already up to date."
      : "Codex config generated. Nothing is installed into Codex yet.";
  // Mirrors generate-codex-config.ts's HEADER banner ("Install into
  // ~/.codex/config.toml with: harness apply --runtime codex --install"),
  // the same text `--codex-config <path>`'s --help already documents.
  return [
    "",
    lede,
    `  ${configPath}`,
    "",
    "Install the harness-managed hook block into ~/.codex/config.toml:",
    "  harness apply --runtime codex --install",
    "",
    "Override the install path with --codex-config <path>.",
    "",
  ].join("\n");
}

function formatOpencodeNextSteps(ctx: NextStepsContext): string {
  const configPath = ctx.opencodeConfigPath ?? "harness.generated/opencode/opencode.json";
  const lede =
    ctx.anyChanged === false
      ? "opencode config is already up to date."
      : "opencode config generated. Nothing is wired into opencode yet.";
  // Mirrors generate-opencode-config.ts's HEADER banner: harness never
  // installs this file automatically, so wiring it in is an operator
  // action, either point $OPENCODE_CONFIG at it or copy the "mcp" block
  // into an existing opencode.json / opencode.jsonc.
  return [
    "",
    lede,
    `  ${configPath}`,
    "",
    "harness does not install this file automatically. Wire it in yourself, either:",
    `  • point $OPENCODE_CONFIG at ${configPath}, or`,
    `  • copy the "mcp" block into your own opencode.json / opencode.jsonc`,
    "",
  ].join("\n");
}

export function formatNextSteps(ctx: NextStepsContext): string {
  if (ctx.runtime === "codex") {
    return formatCodexNextSteps(ctx);
  }
  if (ctx.runtime === "opencode") {
    return formatOpencodeNextSteps(ctx);
  }
  // runtime undefined (pre-existing callers) or explicit "claude-code":
  // original behavior, unchanged.
  if (ctx.targetPath) {
    // Always include `--settings ${targetPath}` in the verify line: Claude
    // Code only auto-discovers `.claude/settings*.json` and the user-global
    // path. For non-canonical targets (e.g. /tmp/foo.json), a bare
    // `claude -p` would silently skip the file and the verify would
    // misleadingly succeed.
    return [
      "",
      `wired into ${ctx.targetPath}`,
      `verify: claude -p "say hi" --settings ${ctx.targetPath} --output-format stream-json --include-hook-events`,
      "",
    ].join("\n");
  }
  // Recommended first, alternatives second. A bare `harness apply` only
  // writes to harness.generated/; nothing is wired until the user runs a
  // second command. Putting the user-global merge at the top, and
  // labelling it explicitly, prevents the "ran apply, nothing happened"
  // confusion. The two alternates stay for users who want a one-shot or
  // a project-scoped wiring.
  //
  // On no-op re-applies we soften the lede: the operator may already have
  // wired a target on a previous run, so claiming "nothing is wired" is a
  // potential falsehood. Keep the recommendation; drop the over-claim.
  const lede =
    ctx.anyChanged === false
      ? "Generated manifest is already up to date."
      : "Generated files written. Nothing is wired into Claude Code yet.";
  return [
    "",
    lede,
    "",
    "Recommended next step (wires into your user-global Claude settings):",
    `  harness apply --target ~/.claude/settings.json --merge`,
    "",
    "Alternatives:",
    `  • Project-scoped:  harness apply --target .claude/settings.local.json --merge`,
    `  • One-shot only:   claude -p "..." --settings ${ctx.generatedSettingsPath}`,
    "",
  ].join("\n");
}
