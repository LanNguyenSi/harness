import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateDisable } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";
import { sha256Hex } from "../../../src/cli/gate/snapshot.js";
import {
  downgradeToVersion1,
  liveSnapshotNames,
  retiredSnapshotNames,
  writeLegacyChain,
} from "../../_helpers/claude-gate-legacy.js";

let tmp: string;
let settingsPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-enable-"));
  settingsPath = path.join(tmp, "settings.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(obj: Record<string, unknown>): void {
  fs.writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

function readSettingsHooks(): Record<string, unknown> {
  const obj = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  return (obj["hooks"] as Record<string, unknown>) ?? {};
}

describe("gateEnable — happy path", () => {
  it("restores the removed group from the latest snapshot", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "intercept" }] },
          { matcher: "Edit|Write|Bash", hooks: [{ command: "blocker" }] },
        ],
      },
    });
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Edit|Write|Bash" });
    // Sanity: the blocker is gone.
    expect(fs.readFileSync(settingsPath, "utf8")).not.toContain("Edit|Write|Bash");

    const result = gateEnable({ settingsPath });
    expect(result.mode).toBe("restored");
    if (result.mode !== "restored") return;
    expect(result.restoredCount).toBe(1);
    // After restore the file should match the original byte-for-byte.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("re-inserts at the original index even when other groups have already shifted", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "A", hooks: [{ command: "a" }] },
          { matcher: "MID", hooks: [{ command: "m" }] },
          { matcher: "B", hooks: [{ command: "b" }] },
        ],
      },
    });
    gateDisable({ settingsPath, matcher: "MID" });
    const result = gateEnable({ settingsPath });
    expect(result.mode).toBe("restored");
    const after = readSettingsHooks();
    const pre = after["PreToolUse"] as Array<{ matcher: string }>;
    expect(pre.map((g) => g.matcher)).toEqual(["A", "MID", "B"]);
  });

  it("re-running enable after a restore finds nothing live and leaves the file alone", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    gateEnable({ settingsPath });
    const restored = fs.readFileSync(settingsPath, "utf8");
    const second = gateEnable({ settingsPath });
    expect(second.mode).toBe("no-snapshots");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(restored);
  });
});

describe("gateEnable — no snapshots", () => {
  it("returns the no-snapshots mode without writing when nothing is staged", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    const original = fs.readFileSync(settingsPath, "utf8");
    const result = gateEnable({ settingsPath });
    expect(result.mode).toBe("no-snapshots");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });
});

describe("gateEnable — drift refusal", () => {
  it("refuses when settings.json has been edited since the disable", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    // Operator hand-edits the file between disable and enable.
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    after["operatorAddedKey"] = "preserve me";
    fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
    expect(() => gateEnable({ settingsPath })).toThrow(GateEnableError);
    expect(() => gateEnable({ settingsPath })).toThrow(/edited since the snapshot/);
    // Operator's hand-edit survived.
    const stillThere = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(stillThere["operatorAddedKey"]).toBe("preserve me");
  });

  it("--force restores anyway, preserving any operator-added top-level keys", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    after["operatorAddedKey"] = "preserve me";
    fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
    const result = gateEnable({ settingsPath, force: true });
    expect(result.mode).toBe("restored");
    const final = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    // The hook came back, AND the operator-added key survived because
    // restore only touches `hooks`, not other top-level keys.
    expect(final["operatorAddedKey"]).toBe("preserve me");
    const hooks = final["hooks"] as Record<string, unknown>;
    expect((hooks["PreToolUse"] as unknown[]).length).toBe(1);
  });
});

describe("gateEnable — refuses to operate on malformed settings", () => {
  it("throws on unreadable JSON", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    fs.writeFileSync(settingsPath, "{ broken json");
    expect(() => gateEnable({ settingsPath })).toThrow(/not valid JSON/);
  });

  it("throws on a non-object root", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    fs.writeFileSync(settingsPath, "[]");
    expect(() => gateEnable({ settingsPath })).toThrow(/not a JSON object/);
  });
});

const T1 = new Date("2026-01-01T00:00:01.000Z");
const T2 = new Date("2026-01-01T00:00:02.000Z");
const T3 = new Date("2026-01-01T00:00:03.000Z");

function matchersOf(event = "PreToolUse"): string[] {
  return ((readSettingsHooks()[event] ?? []) as Array<{ matcher: string }>).map((g) => g.matcher);
}

function twoGroupSettings(): string {
  writeSettings({
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
        { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
      ],
    },
  });
  return fs.readFileSync(settingsPath, "utf8");
}

describe("gateEnable: applied snapshots are retired", () => {
  it("renames the applied snapshot to *.restored.json, keeps its content and never applies it again", () => {
    const original = twoGroupSettings();
    const d = gateDisable({ settingsPath, matcher: "Bash", now: T1 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const snapContent = fs.readFileSync(d.snapshotPath, "utf8");

    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("restored");
    if (r.mode !== "restored") return;
    expect(r.snapshotPath).toBe(d.snapshotPath.replace(/\.json$/, ".restored.json"));
    expect(fs.readFileSync(r.snapshotPath, "utf8")).toBe(snapContent);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(1);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);

    // The operator removes the group by hand later; the spent snapshot must not bring it back.
    writeSettings({ hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] }] } });
    const handEdited = fs.readFileSync(settingsPath, "utf8");
    expect(gateEnable({ settingsPath }).mode).toBe("no-snapshots");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(handEdited);
  });

  it("retires a snapshot whose pre-disable state the file already matches, without writing", () => {
    const original = twoGroupSettings();
    const d = gateDisable({ settingsPath, matcher: "Bash", now: T1 });
    if (d.mode !== "remove") throw new Error("expected remove");
    // The operator put the file back by hand from the backup.
    fs.copyFileSync(d.backupPath, settingsPath);
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("already-restored");
    if (r.mode !== "already-restored") return;
    expect(r.remaining).toEqual([]);
    expect(r.snapshotPath).toMatch(/\.restored\.json$/);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(gateEnable({ settingsPath }).mode).toBe("no-snapshots");
  });

  it("a refused restore leaves the snapshot live", () => {
    twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Bash", now: T1 });
    const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    edited["operatorAddedKey"] = 1;
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    expect(() => gateEnable({ settingsPath })).toThrow(/edited since the snapshot/);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    expect(retiredSnapshotNames(settingsPath)).toEqual([]);
  });
});

describe("gateEnable: a file written in another layout", () => {
  it("restores every group into a file that was not 2-space JSON: same content, the layout is the gate's", () => {
    const groups = [
      { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
      { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
    ];
    fs.writeFileSync(settingsPath, `${JSON.stringify({ hooks: { PreToolUse: groups } }, null, 4)}\n`);
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("restored");
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({ hooks: { PreToolUse: groups } });
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("restores an event the disable emptied as a new last event: same content, key order may change", () => {
    const stop = [{ matcher: "stop", hooks: [{ command: "s" }] }];
    const pre = [{ matcher: "Bash", hooks: [{ command: "b" }] }];
    writeSettings({ hooks: { Stop: stop, PreToolUse: pre } });
    gateDisable({ settingsPath, matcher: "stop", now: T1 });
    gateEnable({ settingsPath });
    const final = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: Record<string, unknown> };
    expect(final.hooks).toEqual({ Stop: stop, PreToolUse: pre });
    expect(Object.keys(final.hooks)).toEqual(["PreToolUse", "Stop"]);
  });
});

describe("gateEnable: two disables, one enable", () => {
  it("restores both groups byte for byte and exits clean; no all-clear while a group is missing", () => {
    const original = twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    expect(matchersOf()).toEqual([]);

    const first = gateEnable({ settingsPath });
    expect(first.mode).toBe("restored");
    if (first.mode !== "restored") return;
    expect(first.restoredCount).toBe(2);
    expect(first.remaining).toEqual([]);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);

    // The second enable the old code needed (and answered "already matches" to) has nothing left to say.
    const second = gateEnable({ settingsPath });
    expect(second.mode).toBe("no-snapshots");
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);
  });

  it("restores in place whatever order the groups were disabled in (index shifts across steps)", () => {
    // g4 stays: an event that loses every group is re-created at the end of
    // `hooks` on restore, which would change the key order and hide this check.
    const groups = ["g0", "g1", "g2", "g3", "g4"].map((m) => ({ matcher: m, hooks: [{ command: m }] }));
    const perms: string[][] = [];
    const permute = (rest: string[], acc: string[]): void => {
      if (rest.length === 0) {
        perms.push(acc);
        return;
      }
      rest.forEach((m, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, m]));
    };
    permute(["g0", "g1", "g2", "g3"], []);
    expect(perms).toHaveLength(24);
    for (const order of perms) {
      writeSettings({ hooks: { PreToolUse: groups, Stop: [{ matcher: "stop", hooks: [{ command: "s" }] }] } });
      const original = fs.readFileSync(settingsPath, "utf8");
      order.forEach((m, i) =>
        gateDisable({ settingsPath, matcher: m, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }),
      );
      const r = gateEnable({ settingsPath });
      expect(r.mode).toBe("restored");
      expect(fs.readFileSync(settingsPath, "utf8"), `order ${order.join(",")}`).toBe(original);
      for (const f of fs.readdirSync(tmp)) {
        if (f.startsWith("harness.gate-disable.")) fs.rmSync(path.join(tmp, f));
      }
    }
  });

  it("restores in place several groups one disable took out of two events", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "A-x", hooks: [{ command: "ax" }] },
          { matcher: "B", hooks: [{ command: "b" }] },
          { matcher: "A-y", hooks: [{ command: "ay" }] },
          { matcher: "C", hooks: [{ command: "c" }] },
        ],
        Stop: [
          { matcher: "S", hooks: [{ command: "s" }] },
          { matcher: "A-z", hooks: [{ command: "az" }] },
        ],
      },
    });
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "A-", now: T1 });
    expect(matchersOf()).toEqual(["B", "C"]);
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("restored");
    if (r.mode !== "restored") return;
    expect(r.restoredCount).toBe(3);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("restores across events when a later step empties an event", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "a" }] },
          { matcher: "Write|Edit", hooks: [{ command: "b" }] },
        ],
        Stop: [{ matcher: "stop", hooks: [{ command: "s" }] }],
      },
    });
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "stop", now: T1 });
    gateDisable({ settingsPath, matcher: "Write", now: T2 });
    gateDisable({ settingsPath, matcher: "Bash", now: T3 });
    expect(readSettingsHooks()).toEqual({});
    gateEnable({ settingsPath });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(JSON.parse(original));
  });
});

describe("gateEnable: --force", () => {
  function editedAfterDisable(): void {
    twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    edited["operatorAddedKey"] = "preserve me";
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
  }

  it("a repeated --force cannot duplicate a group: the first retires the snapshot, the second finds none", () => {
    editedAfterDisable();
    const first = gateEnable({ settingsPath, force: true });
    expect(first.mode).toBe("restored");
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);
    const afterFirst = fs.readFileSync(settingsPath, "utf8");
    const second = gateEnable({ settingsPath, force: true });
    expect(second.mode).toBe("no-snapshots");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(afterFirst);
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);
  });

  it("takes a group with the same event and matcher but other content as back, names both commands, and never splices a second copy", () => {
    editedAfterDisable();
    // The group came back in a changed form (say an apply re-rendered it).
    const handEdited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] } };
    handEdited.hooks.PreToolUse.push({ matcher: "Write|Edit", hooks: [{ command: "branch-protection --changed" }] });
    fs.writeFileSync(settingsPath, `${JSON.stringify(handEdited, null, 2)}\n`);
    const before = fs.readFileSync(settingsPath, "utf8");
    const r = gateEnable({ settingsPath, force: true });
    expect(r.mode).toBe("already-restored");
    if (r.mode !== "already-restored") return;
    expect(r.alreadyBack).toEqual([]);
    expect(r.accepted).toEqual([
      'PreToolUse matcher="Write|Edit": the snapshot\'s group runs `branch-protection`, the file\'s group runs `branch-protection --changed`',
    ]);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(matchersOf()).toEqual(["Bash", "Write|Edit"]);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(1);
  });

  it("without --force refuses on such a group, names both commands and --force, and keeps the snapshot live", () => {
    editedAfterDisable();
    const handEdited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] } };
    handEdited.hooks.PreToolUse.push({ matcher: "Write|Edit", hooks: [{ command: "branch-protection --changed" }] });
    fs.writeFileSync(settingsPath, `${JSON.stringify(handEdited, null, 2)}\n`);
    const before = fs.readFileSync(settingsPath, "utf8");
    let message = "";
    try {
      gateEnable({ settingsPath });
    } catch (err) {
      expect(err).toBeInstanceOf(GateEnableError);
      message = (err as Error).message;
    }
    expect(message).toContain("`branch-protection`");
    expect(message).toContain("`branch-protection --changed`");
    expect(message).toContain("does not count as back");
    expect(message).toContain("harness gate enable --force");
    expect(message).not.toContain("more hook group(s) it removed are missing");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
  });

  it("restores what is still missing and skips what is back when only some groups came back by hand", () => {
    twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    const edited = {
      operatorAddedKey: 1,
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "bash-hook --by-hand" }] }] },
    };
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    expect(() => gateEnable({ settingsPath })).toThrow(
      /1 more hook group\(s\) it removed are missing \(PreToolUse matcher="Write\|Edit" running `branch-protection`\)/,
    );
    const r = gateEnable({ settingsPath, force: true });
    expect(r.mode).toBe("restored");
    if (r.mode !== "restored") return;
    expect(r.restoredCount).toBe(1);
    expect(r.alreadyBack).toEqual([]);
    expect(r.accepted).toEqual([
      'PreToolUse matcher="Bash": the snapshot\'s group runs `bash-hook`, the file\'s group runs `bash-hook --by-hand`',
    ]);
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(gateEnable({ settingsPath, force: true }).mode).toBe("no-snapshots");
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);
  });

  it("a refusal names the missing groups, the snapshot, the backup and the way out", () => {
    editedAfterDisable();
    let message = "";
    try {
      gateEnable({ settingsPath });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('PreToolUse matcher="Write|Edit"');
    expect(message).toContain("stays live");
    expect(message).toContain(".bak.");
    expect(message).toContain("harness gate enable --force");
  });

  it("keeps operator edits and restores every merged group", () => {
    twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    const edited = { operatorAddedKey: "preserve me", hooks: { Stop: [{ matcher: "stop", hooks: [{ command: "s" }] }] } };
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const r = gateEnable({ settingsPath, force: true });
    expect(r.mode).toBe("restored");
    const final = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(final["operatorAddedKey"]).toBe("preserve me");
    expect(matchersOf()).toEqual(["Write|Edit", "Bash"]);
    expect(matchersOf("Stop")).toEqual(["stop"]);
  });
});

describe("gateEnable: snapshots written by released versions (version 1)", () => {
  it("restores a single version 1 snapshot byte for byte and retires it", () => {
    const original = twoGroupSettings();
    const d = gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    if (d.mode !== "remove") throw new Error("expected remove");
    downgradeToVersion1(d.snapshotPath);
    const raw = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8")) as { version: number; removed: Array<{ step?: number }> };
    expect(raw.version).toBe(1);
    expect(raw.removed[0]?.step).toBeUndefined();
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("restored");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("with several live snapshots handles the newest per call, retires it and names how many remain", () => {
    const original = twoGroupSettings();
    const [first, second] = writeLegacyChain(
      settingsPath,
      { matcher: "Write|Edit", now: T1 },
      { matcher: "Bash", now: T2 },
    );
    expect(liveSnapshotNames(settingsPath)).toHaveLength(2);

    const one = gateEnable({ settingsPath });
    expect(one.mode).toBe("restored");
    if (one.mode !== "restored") return;
    expect(one.restoredCount).toBe(1);
    expect(one.remaining).toEqual([first]);
    expect(one.snapshotPath).toBe(second.replace(/\.json$/, ".restored.json"));
    expect(matchersOf()).toEqual(["Bash"]);

    const two = gateEnable({ settingsPath });
    expect(two.mode).toBe("restored");
    if (two.mode !== "restored") return;
    expect(two.remaining).toEqual([]);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(2);
  });

  it("a newest snapshot the file already matches is retired and the older one stays reported as live", () => {
    twoGroupSettings();
    const [first, second] = writeLegacyChain(
      settingsPath,
      { matcher: "Write|Edit", now: T1 },
      { matcher: "Bash", now: T2 },
    );
    const snap2 = JSON.parse(fs.readFileSync(second, "utf8")) as { settingsBeforeSha256: string };
    // Put the file back to the state before the second disable (only Bash left).
    writeSettings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "bash-hook" }] }] } });
    expect(sha256Hex(fs.readFileSync(settingsPath, "utf8"))).toBe(snap2.settingsBeforeSha256);
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("already-restored");
    if (r.mode !== "already-restored") return;
    expect(r.remaining).toEqual([first]);
    expect(liveSnapshotNames(settingsPath)).toEqual([path.basename(first)]);
  });
});

describe("gateEnable: a file that matches neither state", () => {
  it("restores without --force when the groups still missing give exactly the pre-disable file", () => {
    const original = twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    // The operator put one group back by hand, in the form the snapshot has.
    writeSettings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "bash-hook" }] }] } });
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("restored");
    if (r.mode !== "restored") return;
    expect(r.restoredCount).toBe(1);
    expect(r.alreadyBack).toEqual(['PreToolUse matcher="Bash"']);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("only retires the snapshot when every group it names is back, even if the file was edited since", () => {
    twoGroupSettings();
    gateDisable({ settingsPath, matcher: "Bash", now: T1 });
    writeSettings({
      operatorAddedKey: "keep",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
          { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
        ],
      },
    });
    const before = fs.readFileSync(settingsPath, "utf8");
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("already-restored");
    if (r.mode !== "already-restored") return;
    expect(r.alreadyBack).toEqual(['PreToolUse matcher="Bash"']);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(1);
  });

  it("pairs a changed group with one snapshot entry only, under --force", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "one" }] },
          { matcher: "Bash", hooks: [{ command: "two" }] },
          { matcher: "Task", hooks: [{ command: "t" }] },
        ],
      },
    });
    gateDisable({ settingsPath, matcher: "Bash", now: T1 });
    // One of the two removed groups came back (re-rendered), the other did not.
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "one --v2" }] },
          { matcher: "Task", hooks: [{ command: "t" }] },
        ],
      },
    });
    const r = gateEnable({ settingsPath, force: true });
    expect(r.mode).toBe("restored");
    if (r.mode !== "restored") return;
    expect(r.restoredCount).toBe(1);
    expect(r.alreadyBack).toEqual([]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toContain("`one --v2`");
    expect(matchersOf()).toEqual(["Bash", "Bash", "Task"]);
  });
});

describe("gateEnable: snapshot identity", () => {
  it("finds a snapshot that recorded the settings path relative, from another working directory", () => {
    twoGroupSettings();
    const original = fs.readFileSync(settingsPath, "utf8");
    const cwd = process.cwd();
    const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-gate-other-cwd-"));
    try {
      process.chdir(tmp);
      const d = gateDisable({ settingsPath: "settings.json", matcher: "Write|Edit", now: T1 });
      if (d.mode !== "remove") throw new Error("expected remove");
      const recorded = (JSON.parse(fs.readFileSync(d.snapshotPath, "utf8")) as { settingsPath: string }).settingsPath;
      expect(path.isAbsolute(recorded)).toBe(true);
      process.chdir(other);
      const r = gateEnable({ settingsPath });
      expect(r.mode).toBe("restored");
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    } finally {
      process.chdir(cwd);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("finds a snapshot whose recorded path is relative (written by an earlier release)", () => {
    twoGroupSettings();
    const original = fs.readFileSync(settingsPath, "utf8");
    const d = gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8")) as Record<string, unknown>;
    snap["settingsPath"] = "settings.json";
    fs.writeFileSync(d.snapshotPath, JSON.stringify(snap));
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("restored");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("finds the snapshot when the settings directory is reached through a symlink", () => {
    twoGroupSettings();
    const original = fs.readFileSync(settingsPath, "utf8");
    const linkParent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-gate-link-"));
    const link = path.join(linkParent, "claude");
    try {
      fs.symlinkSync(tmp, link);
      const d = gateDisable({ settingsPath: path.join(link, "settings.json"), matcher: "Write|Edit", now: T1 });
      if (d.mode !== "remove") throw new Error("expected remove");
      const r = gateEnable({ settingsPath });
      expect(r.mode).toBe("restored");
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
      expect(liveSnapshotNames(settingsPath)).toEqual([]);
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("reports a snapshot for another settings file in the directory instead of skipping it silently", () => {
    twoGroupSettings();
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, null, 2)}\n`);
    const o = gateDisable({ settingsPath: other, matcher: "Bash", now: T1 });
    if (o.mode !== "remove") throw new Error("expected remove");
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("no-snapshots");
    expect(r.foreign).toEqual([
      { path: o.snapshotPath, settingsPath: other, settingsExists: true, settingsBackupPath: o.backupPath },
    ]);
  });
});

describe("gateEnable: which snapshots count", () => {
  it("fails on a live snapshot it cannot read instead of reporting nothing to restore", () => {
    twoGroupSettings();
    fs.writeFileSync(path.join(tmp, "harness.gate-disable.2026-01-01T00-00-00.000Z.json"), "{ broken");
    expect(() => gateEnable({ settingsPath })).toThrow(GateEnableError);
    expect(() => gateEnable({ settingsPath })).toThrow(/not valid JSON/);
  });

  it("names the unreadable snapshot and says to move it aside and run enable again", () => {
    twoGroupSettings();
    const bad = path.join(tmp, "harness.gate-disable.2026-01-01T00-00-00.000Z.json");
    fs.writeFileSync(bad, "{ broken");
    let message = "";
    try {
      gateEnable({ settingsPath });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`Move ${bad} aside`);
    expect(message).toContain("harness gate enable");
  });

  it("ignores a snapshot taken for another settings file in the same directory", () => {
    twoGroupSettings();
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, null, 2)}\n`);
    gateDisable({ settingsPath: other, matcher: "Bash", now: T1 });
    const before = fs.readFileSync(settingsPath, "utf8");
    expect(gateEnable({ settingsPath }).mode).toBe("no-snapshots");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
  });
});
