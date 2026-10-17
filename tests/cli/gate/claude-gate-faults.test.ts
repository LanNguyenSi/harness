import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EX_FAIL } from "../../../src/cli/exit-codes.js";
import { gateDisable, GateDisableError } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";
import { run } from "../../../src/cli/index.js";
import { liveSnapshotNames, retiredSnapshotNames, supersededSnapshotNames } from "../../_helpers/claude-gate-legacy.js";

// The Claude gate's writes go through atomicWriteFile. Every write is
// reported to `fault.onWrite` before it happens; a hook that throws makes
// that write fail, the way a full disk or a killed process would, and the
// recorded order pins backup -> snapshot -> settings.json. Every retire
// (the rename to *.restored.json) is reported to `fault.onRetire` the same
// way, so a rename refused by the filesystem can be simulated.
const fault = vi.hoisted(() => ({
  onWrite: null as null | ((filePath: string, content: string) => void),
  onRetire: null as null | ((snapPath: string) => void),
}));

vi.mock("../../../src/cli/gate/snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/gate/snapshot.js")>();
  return {
    ...actual,
    retireSnapshot: (snapPath: string) => {
      fault.onRetire?.(snapPath);
      return actual.retireSnapshot(snapPath);
    },
    supersedeSnapshot: (snapPath: string) => {
      fault.onRetire?.(snapPath);
      return actual.supersedeSnapshot(snapPath);
    },
  };
});

/** What a directory the user cannot write to answers to the rename. */
function renameRefused(snapPath: string): never {
  const err = new Error(`EACCES: permission denied, rename '${snapPath}'`) as NodeJS.ErrnoException;
  err.code = "EACCES";
  throw err;
}

vi.mock("../../../src/io/atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/io/atomic-write.js")>();
  return {
    ...actual,
    atomicWriteFile: (filePath: string, content: string, ...rest: unknown[]) => {
      fault.onWrite?.(filePath, content);
      return (actual.atomicWriteFile as (...a: unknown[]) => void)(filePath, content, ...rest);
    },
  };
});

let tmp: string;
let settingsPath: string;

const T1 = new Date("2026-01-01T00:00:01.000Z");
const T2 = new Date("2026-01-01T00:00:02.000Z");
const T3 = new Date("2026-01-01T00:00:03.000Z");

function kindOf(filePath: string): "backup" | "snapshot" | "settings" | "other" {
  const name = path.basename(filePath);
  if (name.includes(".bak.")) return "backup";
  if (name.startsWith("harness.gate-disable.")) return "snapshot";
  if (name === "settings.json") return "settings";
  return "other";
}

function matchers(): string[] {
  const hooks = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, Array<{ matcher: string }>> }).hooks;
  return (hooks?.["PreToolUse"] ?? []).map((g) => g.matcher);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-claude-gate-faults-"));
  settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
            { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
            { matcher: "Task", hooks: [{ command: "task-hook" }] },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
});

afterEach(() => {
  fault.onWrite = null;
  fault.onRetire = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gateDisable: write order", () => {
  it("writes the backup, then the snapshot, then settings.json on a fresh disable", () => {
    const order: string[] = [];
    fault.onWrite = (p) => order.push(kindOf(p));
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    expect(order).toEqual(["backup", "snapshot", "settings"]);
  });

  it("writes the backup, then the merged snapshot, then settings.json on a merge", () => {
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const order: string[] = [];
    fault.onWrite = (p) => order.push(kindOf(p));
    const r = gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    expect(r.mode === "remove" && r.merged).toBe(true);
    expect(order).toEqual(["backup", "snapshot", "settings"]);
  });

  it("leaves the file untouched when the snapshot write fails (nothing mutated without its way back)", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "snapshot") throw new Error("disk full");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 })).toThrow(/disk full/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("changes neither the file nor the snapshot when the backup write fails on a merge", () => {
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const file = fs.readFileSync(settingsPath, "utf8");
    const snap = liveSnapshotNames(settingsPath);
    const snapBody = fs.readFileSync(path.join(tmp, snap[0] ?? ""), "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "backup") throw new Error("disk full");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Bash", now: T2 })).toThrow(/disk full/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(file);
    expect(fs.readFileSync(path.join(tmp, snap[0] ?? ""), "utf8")).toBe(snapBody);
  });
});

describe("gateDisable: the settings.json write fails after the snapshot was written", () => {
  it("merge path: rolls the live snapshot back to its pre-merge body, rethrows, and a retry restores the original", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    const snapFile = path.join(tmp, name ?? "");
    const premerge = fs.readFileSync(snapFile, "utf8");
    const afterFirst = fs.readFileSync(settingsPath, "utf8");

    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Bash", now: T2 })).toThrow(/write failed/);
    fault.onWrite = null;
    expect(fs.readFileSync(snapFile, "utf8")).toBe(premerge);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(afterFirst);

    // Retry: merges once, so one enable brings back each group exactly once.
    const retry = gateDisable({ settingsPath, matcher: "Bash", now: T3 });
    expect(retry.mode === "remove" && retry.merged).toBe(true);
    const on = gateEnable({ settingsPath });
    expect(on.mode).toBe("restored");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(matchers()).toEqual(["Write|Edit", "Bash", "Task"]);
  });

  it("merge path, rollback fails too: both errors and the way out are reported and enable restores without --force and without duplicates", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    let snapshotWrites = 0;
    fault.onWrite = (p) => {
      if (kindOf(p) === "snapshot") {
        snapshotWrites += 1;
        if (snapshotWrites > 1) throw new Error("rollback failed");
      }
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    let thrown: unknown;
    try {
      gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    } catch (err) {
      thrown = err;
    }
    fault.onWrite = null;
    expect(thrown).toBeInstanceOf(GateDisableError);
    const message = (thrown as Error).message;
    expect(message).toContain(`cannot write ${settingsPath}: write failed`);
    expect(message).toContain(`the snapshot ${path.join(tmp, name ?? "")}, already merged, could not be put back (rollback failed)`);
    expect(message).toContain(`Run \`harness gate enable --settings ${settingsPath}\``);
    // The merged snapshot stayed, the file is still the first disable's state.
    expect(matchers()).toEqual(["Bash", "Task"]);

    const on = gateEnable({ settingsPath });
    expect(on.mode).toBe("restored");
    if (on.mode !== "restored") return;
    expect(on.restoredCount).toBe(1);
    expect(on.alreadyBack).toEqual(['PreToolUse matcher="Bash"']);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(matchers()).toEqual(["Write|Edit", "Bash", "Task"]);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("fresh path: the snapshot stays, enable only retires it, and a retried disable starts a new one", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 })).toThrow(/write failed/);
    fault.onWrite = null;
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);

    // A retried disable finds the live snapshot spent (file at its pre-disable state) and retires it.
    const retry = gateDisable({ settingsPath, matcher: "Write|Edit", now: T2 });
    if (retry.mode !== "remove") throw new Error("expected remove");
    expect(retry.merged).toBe(false);
    expect(retry.retired).toHaveLength(1);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(1);
    gateEnable({ settingsPath });
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });
});

describe("a retire the filesystem refuses", () => {
  async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: ["gate", ...argv, "--settings", settingsPath],
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    return { code, stdout, stderr };
  }

  it("disable: a spent snapshot that cannot be retired stops the disable before it writes, naming the snapshot and the way out", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    // Restored by hand from the backup: the snapshot is spent.
    fs.writeFileSync(settingsPath, original);
    const files = fs.readdirSync(tmp).sort();
    fault.onRetire = renameRefused;
    const r = await cli("disable", "--matcher", "Bash");
    expect(r.code).toBe(EX_FAIL);
    expect(r.stderr).toContain(`the live gate snapshot ${path.join(tmp, name ?? "")} is spent`);
    expect(r.stderr).toContain("EACCES");
    expect(r.stderr).toContain("Move it out of the directory by hand");
    expect(r.stderr).toContain(`${settingsPath} was not changed`);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(fs.readdirSync(tmp).sort()).toEqual(files);
  });

  it("disable: a refusal whose walked-past spent snapshot cannot be retired names that snapshot", () => {
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    fs.writeFileSync(settingsPath, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] }, { matcher: "Bash", hooks: [{ command: "bash-hook" }] }, { matcher: "Task", hooks: [{ command: "task-hook" }] }] }, model: "x" }, null, 2)}\n`);
    // An older live snapshot (an earlier release's) still names a missing group.
    const older = path.join(tmp, "harness.gate-disable.2025-12-31T00-00-00.000Z.json");
    const body = JSON.parse(fs.readFileSync(path.join(tmp, name ?? ""), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(older, JSON.stringify({ ...body, createdAt: "2025-12-31T00:00:00.000Z", removed: [{ event: "PreToolUse", index: 0, group: { matcher: "Stop", hooks: [] } }] }));
    fault.onRetire = renameRefused;
    expect(() => gateDisable({ settingsPath, matcher: "Task", now: T2 })).toThrow(GateDisableError);
    expect(() => gateDisable({ settingsPath, matcher: "Task", now: T2 })).toThrow(`the live gate snapshot ${path.join(tmp, name ?? "")} is spent`);
  });

  it("enable: a retire that fails after the write says the groups were restored and names the snapshot to move aside", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    fault.onRetire = renameRefused;
    const r = await cli("enable");
    expect(r.code).toBe(EX_FAIL);
    expect(r.stderr).toContain(`restored 1 hook group(s) into ${settingsPath}, but cannot retire the snapshot ${path.join(tmp, name ?? "")}`);
    expect(r.stderr).toContain("Move it out of the directory by hand");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);

    // Left live, it is harmless: the next enable finds the file at its pre-disable state and only retires it.
    fault.onRetire = null;
    const again = await cli("enable");
    expect(again.code).toBe(0);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("enable: a retire that fails with the file at its pre-disable state names the snapshot", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    fs.writeFileSync(settingsPath, original);
    fault.onRetire = renameRefused;
    expect(() => gateEnable({ settingsPath })).toThrow(GateEnableError);
    expect(() => gateEnable({ settingsPath })).toThrow(`${settingsPath} needed no write, but cannot retire the snapshot`);
  });

  it("enable: a retire that fails with every group back names the snapshot", () => {
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] }; model?: string };
    edited.hooks.PreToolUse.push({ matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] });
    edited.model = "x";
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    fault.onRetire = renameRefused;
    expect(() => gateEnable({ settingsPath })).toThrow(GateEnableError);
    expect(() => gateEnable({ settingsPath })).toThrow(/needed no write, but cannot retire the snapshot .*EACCES/);
  });
});

describe("a settings path that is a symlink: the write the filesystem refuses", () => {
  let link: string;

  /** What a directory the user cannot write to answers to the open of a temp file. */
  function readOnly(code = "EACCES"): never {
    const err = new Error(`${code}: write refused, open`) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  }

  beforeEach(() => {
    link = path.join(tmp, "link.json");
    fs.symlinkSync(settingsPath, link);
  });

  it("the snapshot write: the settings file and the snapshots stay as they were, the message says which backup was left", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "snapshot") readOnly();
    };
    let message = "";
    try {
      gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 });
    } catch (err) {
      expect(err).toBeInstanceOf(GateDisableError);
      message = (err as Error).message;
    }
    expect(message).toContain(`${link} is a symlink to ${settingsPath}`);
    expect(message).toMatch(/The backup .*\.bak\..* was written; .*link\.json and the snapshots were not changed\./);
    expect(message).toContain(`harness gate disable --matcher 'Write|Edit' --settings ${link}\` again`);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("the settings write after a fresh snapshot: the message says the file is unchanged and the snapshot is retired by a later gate call", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") readOnly();
    };
    let message = "";
    try {
      gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 });
    } catch (err) {
      expect(err).toBeInstanceOf(GateDisableError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/was not changed \(the backup .* was written, and the snapshot .* which a later gate call retires\)\./);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    fault.onWrite = null;
    // The snapshot describes a removal that did not happen: the retry retires it as spent and starts a fresh one.
    const retry = gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T2 });
    expect(retry.mode === "remove" && retry.retired).toHaveLength(1);
  });

  it("the settings write on a merge: the snapshot is put back and the message does not claim a leftover snapshot", () => {
    gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    const premerge = fs.readFileSync(path.join(tmp, name ?? ""), "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") readOnly();
    };
    let message = "";
    try {
      gateDisable({ settingsPath: link, matcher: "Bash", now: T2 });
    } catch (err) {
      expect(err).toBeInstanceOf(GateDisableError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/was not changed \(the backup .* was written\)\./);
    expect(message).not.toContain("which a later gate call retires");
    expect(fs.readFileSync(path.join(tmp, name ?? ""), "utf8")).toBe(premerge);
  });

  it("the backup write: nothing was changed, and a failure that is not a permission refusal is rethrown as it is", () => {
    fault.onWrite = (p) => {
      if (kindOf(p) === "backup") readOnly();
    };
    expect(() => gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 })).toThrow(/Nothing was changed\./);
    fault.onWrite = (p) => {
      if (kindOf(p) === "backup") throw new Error("disk full");
    };
    expect(() => gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 })).toThrow(/^disk full$/);
  });

  it.each(["EACCES", "EPERM", "EROFS"])("%s on the backup write is a refusal naming the link; ENOSPC is not", (code) => {
    fault.onWrite = (p) => {
      if (kindOf(p) === "backup") readOnly(code);
    };
    expect(() => gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 })).toThrow(
      new RegExp(`cannot be written \\(${code}\\)`),
    );
    fault.onWrite = (p) => {
      if (kindOf(p) === "backup") readOnly("ENOSPC");
    };
    expect(() => gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 })).toThrow(/^ENOSPC: write refused/);
  });

  it("an enable whose settings write is refused names the link, keeps the snapshot live and passes --force on", () => {
    gateDisable({ settingsPath: link, matcher: "Write|Edit", now: T1 });
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") readOnly();
    };
    expect(() => gateEnable({ settingsPath: link })).toThrow(/run `harness gate enable --settings .*link\.json` again/);
    expect(() => gateEnable({ settingsPath: link, force: true })).toThrow(/harness gate enable --force --settings .*link\.json/);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    // A write that fails for another reason is rethrown as it is.
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") throw new Error("disk full");
    };
    expect(() => gateEnable({ settingsPath: link })).toThrow(/^disk full$/);
  });
});

describe("a merge that moves the snapshot beside the file a settings link leads to", () => {
  let aPath: string;
  let bPath: string;
  let oldSnap: string;

  /** A snapshot beside a/settings.json taken while it was a regular file, which a link to b/settings.json then replaced. */
  beforeEach(() => {
    const aDir = path.join(tmp, "a");
    const bDir = path.join(tmp, "b");
    fs.mkdirSync(aDir);
    fs.mkdirSync(bDir);
    aPath = path.join(aDir, "settings.json");
    bPath = path.join(bDir, "settings.json");
    fs.renameSync(settingsPath, aPath);
    gateDisable({ settingsPath: aPath, matcher: "Write|Edit", now: T1 });
    oldSnap = path.join(aDir, liveSnapshotNames(aPath)[0] ?? "");
    fs.renameSync(aPath, bPath);
    fs.symlinkSync(bPath, aPath);
  });

  it("a settings write that fails removes the copy and leaves the earlier snapshot live and untouched", () => {
    const body = fs.readFileSync(oldSnap, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    expect(() => gateDisable({ settingsPath: aPath, matcher: "Bash", now: T2 })).toThrow(/write failed/);
    expect(liveSnapshotNames(bPath)).toEqual([]);
    expect(fs.readFileSync(oldSnap, "utf8")).toBe(body);
    expect(supersededSnapshotNames(aPath)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))(
    "a copy that cannot be removed after the failed write is reported with the way out",
    () => {
      fault.onWrite = (p) => {
        if (kindOf(p) === "settings") {
          fs.chmodSync(path.dirname(bPath), 0o555);
          throw new Error("write failed");
        }
      };
      try {
        expect(() => gateDisable({ settingsPath: aPath, matcher: "Bash", now: T2 })).toThrow(/could not be put back/);
      } finally {
        fs.chmodSync(path.dirname(bPath), 0o755);
      }
    },
  );

  it("an earlier snapshot that cannot be retired after the write is named, with what was done", () => {
    fault.onRetire = renameRefused;
    let message = "";
    try {
      gateDisable({ settingsPath: aPath, matcher: "Bash", now: T2 });
    } catch (err) {
      expect(err).toBeInstanceOf(GateDisableError);
      message = (err as Error).message;
    }
    expect(message).toContain(`removed 1 hook group(s) from ${aPath} and merged the live snapshot into`);
    expect(message).toContain(`cannot retire the earlier snapshot ${oldSnap}`);
    expect(message).toContain("EACCES");
    expect(message).toContain("rename it to *.superseded.json");
    const hooks = (JSON.parse(fs.readFileSync(bPath, "utf8")) as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks;
    expect(hooks.PreToolUse.map((g) => g.matcher)).toEqual(["Task"]);
  });
});
