import { describe, expect, it } from "vitest";
import { formatNextSteps } from "../../../src/cli/apply/next-steps.js";

describe("formatNextSteps", () => {
  it("default (no --target) recommends the user-global merge first and warns nothing is wired yet", () => {
    const s = formatNextSteps({
      generatedSettingsPath: "/abs/harness.generated/settings.json",
    });
    expect(s).toContain("Nothing is wired into Claude Code yet");
    expect(s).toContain("Recommended next step");
    // Recommended path appears before the alternatives header.
    const recIdx = s.indexOf("harness apply --target ~/.claude/settings.json --merge");
    const altIdx = s.indexOf("Alternatives:");
    expect(recIdx).toBeGreaterThan(-1);
    expect(altIdx).toBeGreaterThan(recIdx);
    expect(s).toContain("--settings /abs/harness.generated/settings.json");
    expect(s).toContain("--target .claude/settings.local.json --merge");
  });

  it("with targetPath collapses to a verify hint that includes --settings", () => {
    const s = formatNextSteps({
      generatedSettingsPath: "/abs/harness.generated/settings.json",
      targetPath: "/home/x/.claude/settings.local.json",
    });
    expect(s).toContain("wired into /home/x/.claude/settings.local.json");
    expect(s).toContain("verify: claude -p");
    // Non-canonical target paths aren't picked up by Claude Code's
    // settings discovery, so the verify line MUST include --settings.
    expect(s).toContain("--settings /home/x/.claude/settings.local.json");
    // Should NOT include the three-option block when wired up.
    expect(s).not.toContain("Next steps to wire into Claude Code:");
  });

  it("never hallucinates flags Claude Code doesn't have (regression)", () => {
    // The whole feature was motivated by an agent fabricating
    // `--output-dir` for `claude -p`. The hint must not mention it.
    const s1 = formatNextSteps({
      generatedSettingsPath: "/x/settings.json",
    });
    const s2 = formatNextSteps({
      generatedSettingsPath: "/x/settings.json",
      targetPath: "/y/settings.local.json",
    });
    expect(s1).not.toContain("--output-dir");
    expect(s2).not.toContain("--output-dir");
  });

  it("uses absolute paths so suggestions do not depend on cwd", () => {
    const s = formatNextSteps({ generatedSettingsPath: "/abs/x/settings.json" });
    expect(s).toContain("/abs/x/settings.json");
    expect(s).not.toMatch(/^\.\//m);
  });
});
