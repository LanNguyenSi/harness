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
}

export function formatNextSteps(ctx: NextStepsContext): string {
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
