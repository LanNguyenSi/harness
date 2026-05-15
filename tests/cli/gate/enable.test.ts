import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateDisable } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";

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

  it("idempotent: re-running enable on an already-restored file is a no-op", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    gateEnable({ settingsPath });
    const second = gateEnable({ settingsPath });
    expect(second.mode).toBe("already-restored");
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
