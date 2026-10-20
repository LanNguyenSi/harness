// Parity of the one `hooks`-shape parser (`parseSettingsHooks`,
// src/cli/gate/snapshot.ts) through its two callers, for every settings
// shape: a live `gate disable` snapshot sits beside each staged settings.json
// and the file is then edited, so the readable shapes land in the state a
// plain `harness gate enable` refuses without `--force`.
//
// The gate side: `gate enable` reads the file and refuses an unreadable shape
// with one of its two exact messages, and refuses an edited readable one with
// the edited-settings message (the parse ran first, so its message is what a
// bad shape must produce).
//
// The doctor side (the caller that read the same walk as `settingsHooksOf`,
// null for any bad shape): the warning for the gate-disabled hook names
// `--force` only when the gate can read the file and refuses it; an unreadable
// shape marks nothing, so the warning keeps the plain `harness gate enable`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSettings } from "../../../src/cli/apply/generate-settings.js";
import { checkClaudeLiveHooks } from "../../../src/cli/doctor/hook-liveness.js";
import { gateDisable } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";
import { expandPolicyPacks } from "../../../src/policy-packs/index.js";
import { loadManifest } from "../../../src/cli/loader.js";
import type { Manifest } from "../../../src/schema/index.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const MANIFEST_YAML = `version: 1
hooks:
  - name: branch-guard
    event: PreToolUse
    match: "Write|Edit"
    command: guard-bin check
    blocking: hard
    budget_ms: 5000
  - name: session-start
    event: SessionStart
    command: session-bin start
    blocking: false
    budget_ms: 5000
policies: []
`;

interface Staged {
  dir: string;
  manifest: Manifest;
  settingsPath: string;
}

/** The manifest's generated Claude hooks installed, then `Write|Edit` gate-disabled: one live snapshot. */
function stage(): Staged {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-hooks-parser-parity-"));
  dirs.push(dir);
  const configPath = path.join(dir, "harness.yaml");
  fs.writeFileSync(configPath, MANIFEST_YAML);
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir);
  const settingsPath = path.join(claudeDir, "settings.json");
  const manifest = loadManifest({ configPath }).manifest;
  const settings = generateSettings({
    ...manifest,
    hooks: [...manifest.hooks, ...expandPolicyPacks(manifest, "claude-code").hooks],
  }) as unknown as Record<string, unknown>;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  gateDisable({ settingsPath, matcher: "Write|Edit" });
  return { dir, manifest, settingsPath };
}

/** REPLACE_WITH means the file carries no `hooks` key at all. */
const ABSENT = Symbol("absent");

/**
 * The installed disabled file rewritten with `hooks` in this shape, plus a
 * top-level edit: a shape the parser reads is an edited readable file (the
 * plain enable refuses with `--force`), a shape it refuses is the refusal.
 */
function reshape(s: Staged, hooks: unknown): void {
  const doc = JSON.parse(fs.readFileSync(s.settingsPath, "utf8")) as Record<string, unknown>;
  doc["operatorAddedKey"] = 1;
  if (hooks === ABSENT) delete doc["hooks"];
  else doc["hooks"] = hooks;
  fs.writeFileSync(s.settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
}

/** null: the parser reads the shape; "object": hooks itself is not an object; a name: that event's value is not an array. */
const CASES: Array<[name: string, hooks: unknown, refuse: string | null]> = [
  ["hooks absent", ABSENT, null],
  ["hooks null", null, "object"],
  ["hooks a string", "nope", "object"],
  ["hooks an array", [{ matcher: "Bash", hooks: [] }], "object"],
  ["one event a string", { PreToolUse: "nope" }, "PreToolUse"],
  ["one event an object", { PreToolUse: { matcher: "Bash" } }, "PreToolUse"],
  ["one event null", { PreToolUse: null }, "PreToolUse"],
  [
    "a later event not an array after a valid one",
    { SessionStart: [{ hooks: [{ type: "command", command: "session-bin start" }] }], Stop: "nope" },
    "Stop",
  ],
  [
    "valid groups",
    { SessionStart: [{ hooks: [{ type: "command", command: "session-bin start" }] }] },
    null,
  ],
];

/** The exact refusal message for an unreadable shape; null for a readable one (the edited-settings refusal). */
function expectedRefusal(settingsPath: string, refuse: string): string {
  if (refuse === "object") return `${settingsPath} \`hooks\` field is not an object.`;
  return `${settingsPath} \`hooks.${refuse}\` is not an array; refusing to operate.`;
}

describe.each(CASES)("hooks parser parity: %s", (_name, hooks, refuse) => {
  it("gate enable reads the shape or refuses with its exact message", () => {
    const s = stage();
    reshape(s, hooks);
    expect(() => gateEnable({ settingsPath: s.settingsPath })).toThrow(GateEnableError);
    let message = "";
    try {
      gateEnable({ settingsPath: s.settingsPath });
    } catch (err) {
      message = (err as Error).message;
    }
    if (refuse === null) expect(message).toMatch(/has been edited since the snapshot was taken/);
    else expect(message).toBe(expectedRefusal(s.settingsPath, refuse));
  });

  it("the doctor warning names --force exactly when the shape is readable", () => {
    const s = stage();
    reshape(s, hooks);
    const report = checkClaudeLiveHooks(s.manifest, s.settingsPath, { gateDefaultPath: s.settingsPath });
    const message = report.entries.find((e) => e.kind === "disabled")!.message;
    if (refuse === null) {
      expect(message).toContain("run `harness gate enable --force` to put it back");
      expect(message).toContain("was edited since the disable");
    } else {
      // The null path this caller takes for an unreadable shape: nothing is
      // marked, so the warning keeps the plain command it kept before.
      expect(message).toContain("run `harness gate enable` to put it back");
      expect(message).not.toContain("--force");
    }
  });
});
