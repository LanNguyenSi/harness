// `harness doctor` advisory (task 0c6b2cb9): an explicit
// approval_lifecycle.expire_on_tool_match that lists task_finish but not
// task_merge never expires the approval on the review-then-merge path.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { checkExpireOnToolMatch } from "../../src/cli/doctor/expire-on-tool-match.js";
import { parseManifest } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

const FINISH = "mcp__agent-tasks__task_finish";
const MERGE = "mcp__agent-tasks__task_merge";

function packWith(config: Record<string, unknown>, enabled = true) {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", config, enabled }],
  });
}

const lifecycle = (approval_lifecycle: Record<string, unknown>) => packWith({ approval_lifecycle });

describe("checkExpireOnToolMatch: pure function", () => {
  it("warns when the explicit list has task_finish but not task_merge", () => {
    const w = checkExpireOnToolMatch(lifecycle({ expire_on_tool_match: [FINISH, "mcp__agent-tasks__task_abandon"] }));
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/lists task_finish but not task_merge/);
    expect(w?.detail.join(" ")).toContain(MERGE);
  });

  it("warns for a Claude Code dotted name variant of task_finish", () => {
    const w = checkExpireOnToolMatch(
      lifecycle({ expire_on_tool_match: ["mcp__agent-tasks__.task_finish"] }),
    );
    expect(w).toBeDefined();
  });

  it("silent for an absent approval_lifecycle block", () => {
    expect(checkExpireOnToolMatch(packWith({}))).toBeUndefined();
  });

  it("silent for a block without expire_on_tool_match", () => {
    expect(checkExpireOnToolMatch(lifecycle({ max_age: "4h" }))).toBeUndefined();
  });

  it("silent for mode: session, even with a list lacking task_merge", () => {
    expect(
      checkExpireOnToolMatch(lifecycle({ mode: "session", expire_on_tool_match: [FINISH] })),
    ).toBeUndefined();
  });

  it("silent when the list contains task_merge", () => {
    expect(checkExpireOnToolMatch(lifecycle({ expire_on_tool_match: [FINISH, MERGE] }))).toBeUndefined();
  });

  it("silent when the list contains a task_merge name variant", () => {
    expect(
      checkExpireOnToolMatch(
        lifecycle({ expire_on_tool_match: [FINISH, "mcp__agent-tasks__.task_merge"] }),
      ),
    ).toBeUndefined();
  });

  it("silent for an empty list and for a list without task_finish", () => {
    expect(checkExpireOnToolMatch(lifecycle({ expire_on_tool_match: [] }))).toBeUndefined();
    expect(
      checkExpireOnToolMatch(lifecycle({ expire_on_tool_match: ["mcp__agent-tasks__task_abandon"] })),
    ).toBeUndefined();
  });

  it("silent when the pack is disabled or not declared", () => {
    expect(
      checkExpireOnToolMatch(packWith({ approval_lifecycle: { expire_on_tool_match: [FINISH] } }, false)),
    ).toBeUndefined();
    expect(checkExpireOnToolMatch(parseManifest({ version: 1 }))).toBeUndefined();
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function makeHome(manifestYaml: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-expire-tool-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "harness.yaml"), manifestYaml, "utf8");
  return home;
}

function manifestYaml(configYaml: string): string {
  return `version: 1
hooks: []
policies: []
doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
${configYaml}
`;
}

function runDoctor(configYaml: string) {
  const home = makeHome(manifestYaml(configYaml));
  return doctor({
    configPath: path.join(home, "harness.yaml"),
    homeOverride: home,
    versionProbe: () => null,
    pathEnv: "",
    npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    envOverride: {},
  });
}

describe("harness doctor: expire_on_tool_match advisory wiring", () => {
  it("adds exactly one warning (never an error) and renders under Environment", async () => {
    const warn = await runDoctor(
      `      approval_lifecycle:\n        expire_on_tool_match: [${FINISH}]\n`,
    );
    const ok = await runDoctor(
      `      approval_lifecycle:\n        expire_on_tool_match: [${FINISH}, ${MERGE}]\n`,
    );
    expect(warn.ugExpireOnToolMatch).toBeDefined();
    expect(ok.ugExpireOnToolMatch).toBeUndefined();
    expect(warn.warningCount).toBe(ok.warningCount + 1);
    expect(warn.errorCount).toBe(ok.errorCount);
    const text = format(warn);
    expect(text).toMatch(/\nEnvironment\n/);
    expect(text).toContain("lists task_finish but not task_merge");
    expect(format(ok)).not.toContain("lists task_finish but not task_merge");
  });

  it("is silent for an absent block and for mode: session", async () => {
    const absent = await runDoctor(`      mode: grill_me\n`);
    const session = await runDoctor(
      `      approval_lifecycle:\n        mode: session\n        expire_on_tool_match: [${FINISH}]\n`,
    );
    expect(absent.ugExpireOnToolMatch).toBeUndefined();
    expect(session.ugExpireOnToolMatch).toBeUndefined();
  });
});
