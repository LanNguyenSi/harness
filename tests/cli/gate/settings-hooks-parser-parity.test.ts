// Parity of the one `hooks`-shape parser (`parseSettingsHooks`,
// src/cli/gate/snapshot.ts) through its callers, for every settings
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
//
// The two callers that used to walk `hooks` themselves (`gate disable` and
// `harness uninstall`, asserted per shape below) keep their own error class and
// their own wording (both add `; refusing to operate.` where `gate enable` does
// not), and they read an absent `hooks` key the way the parser defines it (no
// groups at all, which is all they ever made of it), so a shape is pinned
// against all of it: the exact refusal text, that the refusal writes nothing at
// all, and for the two shapes the parser reads what the caller then does and
// writes.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSettings } from "../../../src/cli/apply/generate-settings.js";
import { checkClaudeLiveHooks } from "../../../src/cli/doctor/hook-liveness.js";
import { gateDisable, GateDisableError } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";
import { expandPolicyPacks } from "../../../src/policy-packs/index.js";
import { loadManifest } from "../../../src/cli/loader.js";
import { uninstall, UninstallError } from "../../../src/cli/uninstall/index.js";
import type { ClaudeMcpExec } from "../../../src/io/claude-mcp.js";
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

// ---------------------------------------------------------------------------
// The two callers that used to walk `hooks` themselves: `gate disable` and
// `harness uninstall`. Both read the shape through the shared parser now, so
// both must keep producing their own refusal text per reason and keep refusing
// before their first write. Their absent-`hooks` case moves to the parser's
// rule: each verb used to turn an absent key into its own `hooks: null` and
// then read that as "no groups" at every use site (a `?? {}`, a
// `hooks === null` early return, `hooks !== null` loops no group enters), so
// each now takes the empty record the parser hands over for an absent key. The
// readable-shape cases below pin what that keeps from the outside: the listing,
// the "nothing matched" refusal, the settings file left unwritten with no
// backup and no snapshot, and the same write-back for a valid block.
// ---------------------------------------------------------------------------

/** A group both callers own (they remove it) and one they must leave in place. */
const OWNED_GROUP = {
  matcher: "Edit|Write",
  hooks: [{ type: "command", command: "harness pack hook pre-tool-use" }],
};
const FOREIGN_GROUP = { matcher: "Bash", hooks: [{ type: "command", command: "/foreign-hook" }] };

/** The `--matcher` that hits OWNED_GROUP alone. */
const MATCHER = "Edit|Write";

/**
 * A settings.json holding one operator key and `hooks` in this shape (ABSENT:
 * no `hooks` key at all), staged under a `<dir>/.claude/` layout so the same
 * staging serves both callers; the returned directory is that `.claude`
 * directory, which is what `harness uninstall` calls `homeDir`.
 */
function stageCallers(hooks: unknown): { homeDir: string; settingsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-hooks-parser-callers-"));
  dirs.push(dir);
  const homeDir = path.join(dir, ".claude");
  fs.mkdirSync(homeDir);
  const settingsPath = path.join(homeDir, "settings.json");
  const doc: Record<string, unknown> = { operatorAddedKey: 1 };
  if (hooks !== ABSENT) doc["hooks"] = hooks;
  fs.writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { homeDir, settingsPath };
}

/** The unreadable shapes, each with the event its refusal names (`object`: `hooks` itself is not an object). */
const BAD_CALLER_CASES: Array<[name: string, hooks: unknown, refuse: string]> = [
  ["hooks null", null, "object"],
  ["hooks an array", [{ matcher: "Bash", hooks: [] }], "object"],
  ["hooks a string", "nope", "object"],
  ["one event a string", { PreToolUse: "nope", SessionStart: [] }, "PreToolUse"],
  ["one event an object", { PreToolUse: { matcher: "Bash" } }, "PreToolUse"],
  ["one event null", { PreToolUse: null }, "PreToolUse"],
  [
    "a later event not an array after a valid one",
    { PreToolUse: [FOREIGN_GROUP], Stop: { matcher: "Bash" } },
    "Stop",
  ],
];

/** The two shapes the parser reads; ABSENT is the absent-`hooks` case, kept as its own case. */
const READABLE_CALLER_CASES: Array<[name: string, hooks: unknown]> = [
  ["hooks absent", ABSENT],
  ["valid groups", { PreToolUse: [FOREIGN_GROUP, OWNED_GROUP] }],
];

/** Both verbs add `; refusing to operate.` where `gate enable` does not. */
function callerRefusal(settingsPath: string, refuse: string): string {
  if (refuse === "object") {
    return `${settingsPath} \`hooks\` field is not an object; refusing to operate.`;
  }
  return `${settingsPath} \`hooks.${refuse}\` is not an array; refusing to operate.`;
}

/** The settings text both callers write back for the valid block: only the foreign group is kept. */
const KEPT_SETTINGS = `${JSON.stringify({ operatorAddedKey: 1, hooks: { PreToolUse: [FOREIGN_GROUP] } }, null, 2)}\n`;

/** A real `claude mcp remove` spawn here would mean the run left its tmp home. */
const mcpExecNever: ClaudeMcpExec = async () => {
  throw new Error("no claude mcp remove spawn is expected in these cases");
};

describe.each(BAD_CALLER_CASES)("gate disable refuses %s", (_name, hooks, refuse) => {
  it("with its own message, on the listing run and the removing one, having written nothing", () => {
    const { homeDir, settingsPath } = stageCallers(hooks);
    const before = fs.readFileSync(settingsPath, "utf8");
    for (const opts of [{ settingsPath }, { settingsPath, matcher: MATCHER }]) {
      let message = "";
      try {
        gateDisable(opts);
      } catch (err) {
        expect(err).toBeInstanceOf(GateDisableError);
        message = (err as Error).message;
      }
      expect(message).toBe(callerRefusal(settingsPath, refuse));
    }
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(fs.readdirSync(homeDir)).toEqual(["settings.json"]);
  });
});

describe.each(READABLE_CALLER_CASES)("gate disable reads %s", (_name, hooks) => {
  it("as no group for absent hooks, and as both groups of a valid block", () => {
    const { settingsPath } = stageCallers(hooks);
    const r = gateDisable({ settingsPath });
    if (r.mode !== "list") throw new Error(`expected the listing, got ${r.mode}`);
    expect(r.candidates).toEqual(
      hooks === ABSENT
        ? []
        : [
            { event: "PreToolUse", index: 0, matcher: "Bash", description: "/foreign-hook" },
            {
              event: "PreToolUse",
              index: 1,
              matcher: "Edit|Write",
              description: "harness pack hook pre-tool-use",
            },
          ],
    );
  });

  it("so a removal writes back the untouched foreign group, or finds nothing to remove", () => {
    const { homeDir, settingsPath } = stageCallers(hooks);
    const before = fs.readFileSync(settingsPath, "utf8");
    if (hooks === ABSENT) {
      // Absent `hooks` is never a bad shape: the run reaches its own
      // "nothing matched" refusal and writes nothing at all.
      let message = "";
      try {
        gateDisable({ settingsPath, matcher: MATCHER });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("no hook groups matched matcher substring");
      expect(message).not.toContain("field is not an object");
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
      expect(fs.readdirSync(homeDir)).toEqual(["settings.json"]);
      return;
    }
    const r = gateDisable({ settingsPath, matcher: MATCHER });
    if (r.mode !== "remove") throw new Error(`expected the removal, got ${r.mode}`);
    // The parser hands over copies of the group arrays, and each caller builds
    // its own kept array: what lands back on disk is the untouched foreign
    // group, byte for byte, beside the operator's own key.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(KEPT_SETTINGS);
    expect(fs.existsSync(r.backupPath)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(r.snapshotPath, "utf8")) as {
      removed: Array<{ event: string; index: number; group: unknown }>;
    };
    expect(snap.removed).toEqual([{ event: "PreToolUse", index: 1, group: OWNED_GROUP, step: 0 }]);
  });
});

describe.each(BAD_CALLER_CASES)("harness uninstall refuses %s", (_name, hooks, refuse) => {
  it("with its own message, having written nothing", async () => {
    const { homeDir, settingsPath } = stageCallers(hooks);
    const before = fs.readFileSync(settingsPath, "utf8");
    await expect(uninstall({ homeDir, settingsPath, mcpExec: mcpExecNever })).rejects.toThrow(
      UninstallError,
    );
    let message = "";
    try {
      await uninstall({ homeDir, settingsPath, apply: true, mcpExec: mcpExecNever });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(callerRefusal(settingsPath, refuse));
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(fs.readdirSync(homeDir)).toEqual(["settings.json"]);
  });
});

describe.each(READABLE_CALLER_CASES)("harness uninstall reads %s", (_name, hooks) => {
  it("as nothing of ours for absent hooks, and as the harness group of a valid block", async () => {
    const { homeDir, settingsPath } = stageCallers(hooks);
    const listed = await uninstall({ homeDir, settingsPath, mcpExec: mcpExecNever });
    if (listed.mode !== "list") throw new Error(`expected the listing, got ${listed.mode}`);
    expect(listed.inventory.hookGroups).toEqual(
      hooks === ABSENT
        ? []
        : [
            {
              event: "PreToolUse",
              index: 1,
              matcher: "Edit|Write",
              description: "harness pack hook pre-tool-use",
            },
          ],
    );
  });

  it("so an apply rewrites only the valid block, and has nothing to rewrite for absent hooks", async () => {
    const { homeDir, settingsPath } = stageCallers(hooks);
    const before = fs.readFileSync(settingsPath, "utf8");
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: mcpExecNever,
    });
    if (r.mode !== "apply") throw new Error(`expected the apply, got ${r.mode}`);
    if (hooks === ABSENT) {
      expect(r.backupPath).toBeNull();
      expect(r.snapshotPath).toBeNull();
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
      expect(fs.readdirSync(homeDir)).toEqual(["settings.json"]);
      return;
    }
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(KEPT_SETTINGS);
    if (r.backupPath === null || r.snapshotPath === null) throw new Error("expected backup + snapshot");
    const snap = JSON.parse(fs.readFileSync(r.snapshotPath, "utf8")) as {
      removedHookGroups: Array<{ event: string; index: number; group: unknown }>;
    };
    expect(snap.removedHookGroups).toEqual([
      { event: "PreToolUse", index: 1, group: OWNED_GROUP },
    ]);
  });
});
