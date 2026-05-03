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
  return [
    "",
    "Next steps to wire into Claude Code:",
    `  • One-shot:    claude -p "..." --settings ${ctx.generatedSettingsPath}`,
    `  • Project:     harness apply --target .claude/settings.local.json`,
    `  • User-global: harness apply --target ~/.claude/settings.json --merge`,
    "",
  ].join("\n");
}
