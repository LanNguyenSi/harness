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

  it("runtime claude-code (explicit) matches the default (no runtime field) output byte-for-byte", () => {
    // Golden pin (task f9d49e97, acceptance criterion 1): runtime-aware
    // branching must not change a single byte of the claude-code hint.
    const base = { generatedSettingsPath: "/abs/harness.generated/settings.json" };
    const withoutRuntime = formatNextSteps(base);
    const withClaudeCode = formatNextSteps({ ...base, runtime: "claude-code" });
    expect(withClaudeCode).toBe(withoutRuntime);
    expect(withoutRuntime).toBe(
      [
        "",
        "Generated files written. Nothing is wired into Claude Code yet.",
        "",
        "Recommended next step (wires into your user-global Claude settings):",
        "  harness apply --target ~/.claude/settings.json --merge",
        "",
        "Alternatives:",
        "  • Project-scoped:  harness apply --target .claude/settings.local.json --merge",
        '  • One-shot only:   claude -p "..." --settings /abs/harness.generated/settings.json',
        "",
      ].join("\n"),
    );
  });

  it("runtime codex: no settings.json / --target recommendation, points at config.toml and --install instead", () => {
    const s = formatNextSteps({
      generatedSettingsPath: "/abs/harness.generated/settings.json",
      codexConfigPath: "/abs/harness.generated/codex/config.toml",
      runtime: "codex",
    });
    expect(s).toContain("/abs/harness.generated/codex/config.toml");
    expect(s).toContain("harness apply --runtime codex --install");
    expect(s).toContain("~/.codex/config.toml");
    expect(s).not.toContain("--target");
    expect(s).not.toContain("settings.json");
    expect(s).not.toContain("claude -p");
    expect(s).not.toContain("--merge");
  });

  it("runtime opencode: no settings.json / --target recommendation, points at $OPENCODE_CONFIG / mcp-block-copy instead", () => {
    const s = formatNextSteps({
      generatedSettingsPath: "/abs/harness.generated/settings.json",
      opencodeConfigPath: "/abs/harness.generated/opencode/opencode.json",
      runtime: "opencode",
    });
    expect(s).toContain("/abs/harness.generated/opencode/opencode.json");
    expect(s).toContain("$OPENCODE_CONFIG");
    expect(s).toContain("mcp");
    expect(s).not.toContain("--target");
    expect(s).not.toContain("settings.json");
    expect(s).not.toContain("claude -p");
    expect(s).not.toContain("--merge");
  });
});
