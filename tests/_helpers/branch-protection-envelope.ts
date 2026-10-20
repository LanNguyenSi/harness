/**
 * The bytes the unchanged code wrote for a Claude Code branch-protection
 * block on an open stdout, captured from the base revision: the deny
 * envelope for a `Write` refused on `master` in `repo`, then one newline.
 * Shared by the tests that pin these exact bytes
 * (`pack-hook-pipe-delivery.test.ts`, `pack-hook-branch-protection.test.ts`).
 */
export const goldenEnvelope = (repo: string): string => {
  const where = JSON.stringify(repo).slice(1, -1);
  const reason = String.raw`branch-protection: refusing Write on protected branch \"master\" (checked in ${where}).\nCreate a feature branch first, then retry:\n  git checkout -b <feature>\nProtected branches: master, main, develop.`;
  return (
    String.raw`{"decision":"block","reason":"${reason}","hookSpecificOutput":{"hookEventName":"PreToolUse",` +
    String.raw`"permissionDecision":"deny","permissionDecisionReason":"${reason}"}}` +
    "\n"
  );
};
