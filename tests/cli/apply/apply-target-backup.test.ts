// `harness apply --target` backs up a target file it did not write itself
// to `<target>.bak.<timestamp>` (the gate's `backupPath` naming) before
// overwriting it, and skips the backup when the bytes on disk still match
// the `target` sha recorded in harness.lock (apply's own last write).
// Every case pins one input combination of the skip decision: record
// present and equal (no backup), present and different (backup), absent or
// unusable (backup), file absent (no backup), no change (no write, no
// backup), backup unwritable (abort before the target), dry-run (nothing),
// and a symlinked target (copy beside the link, never beside the file it
// leads to). The clock is injected with `now`, so the backup name is exact.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../../src/cli/apply/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import { LOCK_BASENAME } from "../../../src/io/harness-lock.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-target-backup-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeManifest(hookCommand = "/h.sh"): void {
  const manifest: Record<string, unknown> = {
    version: 1,
    tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
    memory: { directories: [] },
    hooks: [
      { name: "h", event: "SessionStart", command: hookCommand, blocking: false, budget_ms: 30000 },
    ],
    policies: [],
  };
  fs.writeFileSync(path.join(tmpHome, "harness.yaml"), yamlStringify(manifest));
}

const NOW = new Date("2026-11-13T08:00:00.000Z");
const STAMP = "2026-11-13T08-00-00.000Z";

function backupName(target: string): string {
  return `${target}.bak.${STAMP}`;
}

function backupNames(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes(".bak."));
}

function targetPath(): string {
  return path.join(tmpHome, "settings.local.json");
}

const HAND_EDITED = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, env: { KEEP: "1" } },
  null,
  2,
)}\n`;

describe("apply --target pre-overwrite backup", () => {
  it("hand-edited target: backup holds the old bytes at <target>.bak.<timestamp>, target gets the merge, the result names the backup", async () => {
    writeManifest();
    const target = targetPath();
    const first = await apply({ homeDir: tmpHome, target });
    expect(first.targetWritten).toBe(true);
    // Created: there was nothing on disk to protect.
    expect(first.targetBackupPath).toBeUndefined();
    const generatedBytes = fs.readFileSync(target, "utf8");

    const edited = JSON.parse(generatedBytes) as Record<string, unknown>;
    const groups = (edited["hooks"] as Record<string, unknown[]>)["SessionStart"] as unknown[];
    groups.push({ hooks: [{ type: "command", command: "echo mine" }] });
    const handBytes = `${JSON.stringify(edited, null, 2)}\n`;
    fs.writeFileSync(target, handBytes);
    fs.chmodSync(target, 0o640);

    const r = await apply({ homeDir: tmpHome, target, merge: true, now: NOW });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(true);
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(handBytes);
    // The copy keeps the target's own mode, like the Codex install backup.
    expect(fs.statSync(backupName(target)).mode & 0o777).toBe(0o640);
    // The merge replaces `hooks` (the hand-added group is gone) and keeps
    // the generated hooks: the file is back to the manifest's projection.
    const written = fs.readFileSync(target, "utf8");
    expect(JSON.parse(written)["hooks"]).toEqual(JSON.parse(generatedBytes)["hooks"]);
    expect(written).not.toContain("echo mine");
    expect(backupNames(tmpHome)).toEqual([path.basename(backupName(target))]);
  });

  it("target equal to its recorded sha: overwritten without a backup (--force included)", async () => {
    writeManifest("/h1.sh");
    const target = targetPath();
    await apply({ homeDir: tmpHome, target });
    // The only change since the first write is the manifest: the file on
    // disk is still exactly what the recorded target sha hashes.
    writeManifest("/h2.sh");
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetWritten).toBe(true);
    expect(r.targetBackupPath).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toContain("/h2.sh");
    expect(backupNames(tmpHome)).toEqual([]);
  });

  it("hand-created target with no record at all: byte-for-byte backup before the --force overwrite", async () => {
    writeManifest();
    const target = targetPath();
    // Not valid round-trippable UTF-8 text: a backup taken through a string
    // would corrupt it, so this pins the byte-for-byte copy.
    const handBytes = Buffer.concat([
      Buffer.from('{"env":{"MINE":"1"}}\n', "utf8"),
      Buffer.from([0xff, 0xfe]),
    ]);
    fs.writeFileSync(target, handBytes);

    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetWritten).toBe(true);
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(Buffer.compare(fs.readFileSync(backupName(target)), handBytes)).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toContain("/h.sh");
  });

  it("lock without a target entry is no record: backup", async () => {
    writeManifest();
    await apply({ homeDir: tmpHome });
    expect(fs.existsSync(path.join(tmpHome, LOCK_BASENAME))).toBe(true);
    const target = targetPath();
    fs.writeFileSync(target, HAND_EDITED);
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(HAND_EDITED);
  });

  it("corrupt record (a target sha that can never match): backup", async () => {
    writeManifest("/h1.sh");
    const target = targetPath();
    await apply({ homeDir: tmpHome, target });
    const genBytes = fs.readFileSync(target, "utf8");
    const lockFile = path.join(tmpHome, LOCK_BASENAME);
    const entries = fs
      .readFileSync(lockFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.some((e) => e["kind"] === "target")).toBe(true);
    for (const e of entries) {
      if (e["kind"] === "target") e["sha256"] = "f".repeat(64);
    }
    fs.writeFileSync(lockFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

    writeManifest("/h2.sh");
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(genBytes);
  });

  it("target absent: created, no backup, no targetBackupPath (subdirectories included)", async () => {
    writeManifest();
    const target = path.join(tmpHome, "sub", "dir", "settings.local.json");
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetWritten).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(r.targetBackupPath).toBeUndefined();
    expect(backupNames(path.dirname(target))).toEqual([]);
  });

  it("re-apply with no change to the target: no write, no backup", async () => {
    writeManifest();
    const target = targetPath();
    await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.outcome).toBe("no-changes");
    expect(r.targetWritten).toBe(false);
    expect(r.targetBackupPath).toBeUndefined();
    expect(backupNames(tmpHome)).toEqual([]);
  });

  it("backup path occupied by a directory: apply errors naming the backup path, the target is not touched", async () => {
    writeManifest();
    const target = targetPath();
    fs.writeFileSync(target, HAND_EDITED);
    fs.mkdirSync(backupName(target));
    let err: unknown;
    try {
      await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessExitError);
    expect((err as Error).message).toContain(backupName(target));
    expect((err as Error).message).toContain(target);
    expect(fs.readFileSync(target, "utf8")).toBe(HAND_EDITED);
    expect(fs.statSync(backupName(target)).isDirectory()).toBe(true);
    // The apply stopped before the lock write: nothing else of the target's
    // write phase happened either.
    expect(fs.existsSync(path.join(tmpHome, LOCK_BASENAME))).toBe(false);
  });

  it("a symlink planted at the backup path is refused, never written through", async () => {
    writeManifest();
    const target = targetPath();
    fs.writeFileSync(target, HAND_EDITED);
    const victim = path.join(tmpHome, "victim.json");
    fs.writeFileSync(victim, "victim");
    fs.symlinkSync(victim, backupName(target));
    let err: unknown;
    try {
      await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessExitError);
    expect((err as Error).message).toContain(backupName(target));
    expect(fs.readFileSync(victim, "utf8")).toBe("victim");
    expect(fs.lstatSync(backupName(target)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(HAND_EDITED);
  });

  it("dry-run: no backup and no write", async () => {
    writeManifest();
    const target = targetPath();
    fs.writeFileSync(target, HAND_EDITED);
    const r = await apply({ homeDir: tmpHome, target, force: true, dryRun: true, now: NOW });
    expect(r.outcome).toBe("would-apply");
    expect(r.targetWritten).toBe(false);
    expect(r.targetBackupPath).toBeUndefined();
    expect(backupNames(tmpHome)).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(HAND_EDITED);
  });

  it("symlinked target: the copy sits beside the link with the file's old bytes, and nothing lands beside the file it leads to", async () => {
    writeManifest();
    const dotfilesDir = path.join(tmpHome, "dotfiles");
    fs.mkdirSync(dotfilesDir, { recursive: true });
    const real = path.join(dotfilesDir, "settings.json");
    fs.writeFileSync(real, HAND_EDITED);
    const target = targetPath();
    fs.symlinkSync(real, target);

    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetWritten).toBe(true);
    expect(r.targetBackupPath).toBe(backupName(target));
    // A fresh regular file beside the requested path (the Codex install's
    // posture for a symlinked config), holding the real file's current
    // bytes - the exact content the write replaced.
    expect(fs.lstatSync(backupName(target)).isFile()).toBe(true);
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(HAND_EDITED);
    expect(fs.readdirSync(dotfilesDir)).toEqual(["settings.json"]);
    expect(fs.readFileSync(real, "utf8")).toBe(HAND_EDITED);
    // The target write itself is unchanged behaviour: the atomic rename
    // replaces the link with the generated regular file.
    expect(fs.lstatSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("/h.sh");
  });
});
