// Tests for the claude-code MCP registration health check (task
// init-mcp-wiring-claude-code/T-003). Verifies the section gating, the
// per-server status mapping against a parsed `claude mcp list` output
// (all five status paths + the CLI-missing / timeout degrade paths), and
// the dead settings.json `mcpServers` block warning. Every test injects
// `claudeMcpExec` (and, where relevant, `npmBinExec`) so no real `claude`
// / `npm` CLI is ever spawned — see `src/cli/doctor/claude-mcp.ts` for
// the injectable-exec convention this mirrors.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import type { ClaudeMcpExec } from "../../src/io/claude-mcp.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-claude-mcp-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

// Stubbed npm-bin probe so every test in this file stays fully hermetic
// (mirrors doctor.test.ts's "Appendix D structure" stub).
const STUB_NPM_BIN_EXEC = async () => ({ code: 1, stdout: "", stderr: "stub" });

function execWithStdout(stdout: string): ClaudeMcpExec {
  return async () => ({ code: 0, stdout, stderr: "", enoent: false, timedOut: false });
}

function execCliMissing(): ClaudeMcpExec {
  return async () => ({ code: 127, stdout: "", stderr: "", enoent: true, timedOut: false });
}

function execTimeout(): ClaudeMcpExec {
  return async () => ({ code: -1, stdout: "", stderr: "", enoent: false, timedOut: true });
}

function execThrowsIfCalled(): ClaudeMcpExec {
  return async () => {
    throw new Error("claude mcp list must not be spawned in this test");
  };
}

function manifestWithMcp(entries: string): string {
  return `version: 1
hooks: []
policies: []
doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
tools:
  mcp:
${entries}
  builtin:
    known: [Read]
`;
}

describe("doctor — claude-code MCP registration section gating", () => {
  it("omits the section when tools.mcp is empty", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read]
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
      claudeMcpExec: execThrowsIfCalled(),
    });
    expect(report.claudeMcp).toBeUndefined();
    expect(format(report)).not.toContain("Claude Code MCP Registration");
  });

  it("includes the section (with zero entries, no live spawn) when every declared server is disabled", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: off-server\n      command: [/usr/bin/true]\n      enabled: false`,
      ),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
      claudeMcpExec: execThrowsIfCalled(),
    });
    expect(report.claudeMcp).toBeDefined();
    expect(report.claudeMcp?.listStatus).toBe("ok");
    expect(report.claudeMcp?.entries).toEqual([]);
    expect(format(report)).toContain("Claude Code MCP Registration");
  });

  it("skips the live probe under --shallow without spawning claudeMcpExec", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      pathEnv: "",
      claudeMcpExec: execThrowsIfCalled(),
    });
    expect(report.claudeMcp?.listStatus).toBe("skipped");
    expect(report.claudeMcp?.entries).toEqual([]);
    expect(report.errorCount).toBe(0);
  });
});

describe("doctor — claude-code MCP per-server status mapping", () => {
  it("maps Connected / Failed to connect / Needs authentication / not-in-list correctly", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        [
          "    - name: ok-server\n      command: [/usr/bin/true]\n      enabled: true",
          "    - name: failed-server\n      command: [/usr/bin/true]\n      enabled: true",
          "    - name: warn-auth-server\n      command: [/usr/bin/true]\n      enabled: true",
          "    - name: missing-server\n      command: [/usr/bin/true]\n      enabled: true",
        ].join("\n"),
      ),
    });
    const listStdout = [
      "ok-server: /usr/bin/true - ✔ Connected",
      "failed-server: /usr/bin/true - ✘ Failed to connect",
      "warn-auth-server: /usr/bin/true - ! Needs authentication",
      // A foreign entry the manifest never declared — must be ignored, not
      // mistaken for one of the desired servers.
      "claude.ai Gmail: https://example.invalid/mcp - ! Needs authentication",
    ].join("\n");
    const doctorOpts = {
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
    };
    const report = await doctor({ ...doctorOpts, claudeMcpExec: execWithStdout(listStdout) });
    const c = report.claudeMcp;
    expect(c?.listStatus).toBe("ok");
    const byName = new Map((c?.entries ?? []).map((e) => [e.name, e]));
    expect(byName.get("ok-server")?.status).toBe("ok");
    expect(byName.get("failed-server")?.status).toBe("error");
    expect(byName.get("warn-auth-server")?.status).toBe("warn");
    expect(byName.get("missing-server")?.status).toBe("error");
    expect(byName.get("missing-server")?.message).toMatch(/harness init/);
    // Only the four manifest-declared names, never the foreign Gmail line.
    expect([...byName.keys()].sort()).toEqual([
      "failed-server",
      "missing-server",
      "ok-server",
      "warn-auth-server",
    ]);

    // Baseline against an all-Connected list output isolates exactly what
    // THIS claudeMcp section contributes, independent of unrelated
    // baseline diagnostics this fixture happens to carry (e.g. "no memory
    // router declared" always contributes one warning).
    const baseline = await doctor({
      ...doctorOpts,
      claudeMcpExec: execWithStdout(
        [
          "ok-server: /usr/bin/true - ✔ Connected",
          "failed-server: /usr/bin/true - ✔ Connected",
          "warn-auth-server: /usr/bin/true - ✔ Connected",
          "missing-server: /usr/bin/true - ✔ Connected",
        ].join("\n"),
      ),
    });
    // Two error-status entries (failed-server, missing-server), one warn
    // (warn-auth-server); ok-server contributes nothing.
    expect(report.errorCount - baseline.errorCount).toBe(2);
    expect(report.warningCount - baseline.warningCount).toBe(1);

    const text = format(report);
    expect(text).toContain("Claude Code MCP Registration");
    expect(text).toContain("✓ ok-server");
    expect(text).toContain("✗ failed-server");
    expect(text).toContain("⚠ warn-auth-server");
    expect(text).toContain("✗ missing-server");
  });

  it("cli-missing degrades to a non-error, non-warning skip", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
    });
    const doctorOpts = {
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
    };
    const baseline = await doctor({
      ...doctorOpts,
      claudeMcpExec: execWithStdout("alpha: /usr/bin/true - ✔ Connected"),
    });
    const report = await doctor({ ...doctorOpts, claudeMcpExec: execCliMissing() });
    expect(report.claudeMcp?.listStatus).toBe("cli-missing");
    expect(report.claudeMcp?.entries).toEqual([]);
    expect(report.claudeMcp?.warnings).toEqual([]);
    // cli-missing must not shift either count from the all-Connected baseline.
    expect(report.errorCount - baseline.errorCount).toBe(0);
    expect(report.warningCount - baseline.warningCount).toBe(0);
    expect(format(report)).toContain("claude CLI not found on PATH");
  });

  it("timeout degrades to a warning (not an error)", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
    });
    const doctorOpts = {
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
    };
    const baseline = await doctor({
      ...doctorOpts,
      claudeMcpExec: execWithStdout("alpha: /usr/bin/true - ✔ Connected"),
    });
    const report = await doctor({ ...doctorOpts, claudeMcpExec: execTimeout() });
    expect(report.claudeMcp?.listStatus).toBe("timeout");
    expect(report.claudeMcp?.entries).toEqual([]);
    expect(report.claudeMcp?.warnings).toHaveLength(1);
    // Timeout must not become an error, but IS a warning (unlike cli-missing).
    expect(report.errorCount - baseline.errorCount).toBe(0);
    expect(report.warningCount - baseline.warningCount).toBe(1);
    expect(format(report)).toContain("could not verify claude-code MCP registration");
  });
});

describe("doctor — dead settings.json mcpServers block", () => {
  it("warns with a migration hint when a harness-owned name is still in the dead block", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
      ".claude/settings.json": JSON.stringify({
        mcpServers: {
          alpha: { command: "/usr/bin/true" },
          "some-foreign-tool": { command: "/usr/local/bin/foreign" },
        },
      }),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
      claudeMcpExec: execWithStdout("alpha: /usr/bin/true - ✔ Connected"),
    });
    expect(report.claudeMcp?.deadSettingsBlockNames).toEqual(["alpha"]);
    expect(
      report.claudeMcp?.warnings.some(
        (w) => w.includes("alpha") && w.includes("harness init --interactive"),
      ),
    ).toBe(true);
    expect(format(report)).toContain("dead `mcpServers` block");
  });

  it("does not warn when the dead block only has foreign entries", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
      ".claude/settings.json": JSON.stringify({
        mcpServers: {
          "some-foreign-tool": { command: "/usr/local/bin/foreign" },
        },
      }),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
      claudeMcpExec: execWithStdout("alpha: /usr/bin/true - ✔ Connected"),
    });
    expect(report.claudeMcp?.deadSettingsBlockNames).toEqual([]);
    expect(
      report.claudeMcp?.warnings.some((w) => w.includes("dead")),
    ).toBe(false);
  });

  it("does not warn when there is no settings.json at all", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC,
      claudeMcpExec: execWithStdout("alpha: /usr/bin/true - ✔ Connected"),
    });
    expect(report.claudeMcp?.deadSettingsBlockNames).toEqual([]);
  });
});

describe("doctor — hermetic spawn guard, claude-mcp path (task 0d80e969)", () => {
  it("an enabled MCP server with NO injected claudeMcpExec fails hard instead of silently spawning the real claude CLI", async () => {
    // Chain meta-test (review finding, task 0d80e969): pins the property
    // this task's implementer verified by inspection but never pinned in
    // a test — that doctor()'s call chain down to `realClaudeMcpExec` has
    // NO swallowing catch anywhere. `buildClaudeMcpRegistration`
    // (src/cli/doctor/claude-mcp.ts) awaits `listMcpServers` with no
    // try/catch, and `doctor()` (src/cli/doctor/index.ts) has no
    // try/catch anywhere in its body either. Unlike the wizard's
    // wireClaudeMcp path (see tests/cli/init-interactive.test.ts's
    // hermetic-guard describe block), there is no catch here at all to
    // find, so this is a simpler propagation proof: the violation must
    // reach the caller completely unmodified.
    //
    // Deliberately does NOT inject `claudeMcpExec`, does NOT pass
    // `shallow`, and declares an ENABLED tools.mcp[] entry so the live
    // `claude mcp list` probe actually fires and falls through to the
    // real `realClaudeMcpExec()`.
    const home = makeFixture({
      "harness.yaml": manifestWithMcp(
        `    - name: alpha\n      command: [/usr/bin/true]\n      enabled: true`,
      ),
    });
    await expect(
      doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        pathEnv: "",
        npmBinExec: STUB_NPM_BIN_EXEC,
        // Deliberately NOT injecting claudeMcpExec.
      }),
    ).rejects.toThrow(HermeticSpawnViolationError);
  });
});
