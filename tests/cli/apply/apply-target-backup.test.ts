// `harness apply --target` backs up an existing target it is about to
// change to `<target>.bak.<timestamp>` (the gate's `backupPath` naming),
// before anything is written, and never consults harness.lock for a skip:
// the lock's `target` sha is a drift baseline a plain apply re-hashes from
// disk, so an equal sha proves nothing about hand edits. Every case pins
// one branch: hand-edited target (backup), a target a previous apply wrote
// that a plain apply re-baselined and a hand edit then changed (backup;
// the reviewer's sequence A, the case the removed sha skip lost), a target
// a previous apply wrote with only the manifest since changed (backup), a
// hand-created target (byte-for-byte backup), a lock without a target
// entry (backup), file absent (no backup), no change (no write, no
// backup), backup unwritable on a first apply and on a non-first apply
// (abort before anything is written, retryable), dry-run (nothing), and a
// symlinked target (copy beside the link, never beside the file it leads
// to). The clock is injected with `now`, so the backup name is exact.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../../src/cli/apply/index.js";
import { buildProgram } from "../../../src/cli/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import { LAST_APPLY_BASENAME } from "../../../src/io/last-apply.js";
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

/** A byte-for-byte snapshot of everything under `harness.generated/`,
 * for asserting an aborted apply left the tree exactly as it was. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

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

  it("sequence A: a target apply wrote, a hand edit, a plain apply re-baselining the lock, then apply --target --merge: the hand edit still gets backed up", async () => {
    // The lock's target sha is a drift baseline, not a record of what
    // apply wrote: the plain apply in the middle re-hashes the
    // hand-edited on-disk target into the lock, so a sha-equals-bytes
    // skip would make the final apply overwrite the hand edit without a
    // copy. There is no skip: the hand bytes are backed up.
    writeManifest("/h1.sh");
    const target = targetPath();
    await apply({ homeDir: tmpHome, target });
    const generatedBytes = fs.readFileSync(target, "utf8");

    const edited = JSON.parse(generatedBytes) as Record<string, unknown>;
    const groups = (edited["hooks"] as Record<string, unknown[]>)["SessionStart"] as unknown[];
    groups.push({ hooks: [{ type: "command", command: "echo mine" }] });
    const handBytes = `${JSON.stringify(edited, null, 2)}\n`;
    fs.writeFileSync(target, handBytes);

    // Plain apply (no --target): rewrites harness.generated/ and carries
    // the lock's target entry re-hashed from the hand-edited file.
    writeManifest("/h2.sh");
    const plain = await apply({ homeDir: tmpHome });
    expect(plain.outcome).toBe("applied");

    // The lock now hashes exactly the hand-edited bytes.
    const lockLine = fs
      .readFileSync(path.join(tmpHome, LOCK_BASENAME), "utf8")
      .split("\n")
      .map((l) => (l.trim() === "" ? null : (JSON.parse(l) as Record<string, unknown>)))
      .find((e) => e !== null && e["kind"] === "target");
    expect(lockLine).toBeDefined();
    const crypto = await import("node:crypto");
    expect(lockLine?.["sha256"]).toBe(
      crypto.createHash("sha256").update(handBytes).digest("hex"),
    );

    const r = await apply({ homeDir: tmpHome, target, merge: true, now: NOW });
    expect(r.targetWritten).toBe(true);
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(handBytes);
    expect(fs.readFileSync(target, "utf8")).not.toContain("echo mine");
  });

  it("target a previous apply wrote, only the manifest changed since: the overwrite is still backed up (--force included)", async () => {
    writeManifest("/h1.sh");
    const target = targetPath();
    const first = await apply({ homeDir: tmpHome, target });
    const generatedBytes = fs.readFileSync(target, "utf8");
    writeManifest("/h2.sh");
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetWritten).toBe(true);
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(generatedBytes);
    expect(fs.readFileSync(target, "utf8")).toContain("/h2.sh");
    // The first write created the file: no backup then, only for this
    // overwrite of the existing file.
    expect(backupNames(tmpHome)).toEqual([path.basename(backupName(target))]);
    expect(first.targetBackupPath).toBeUndefined();
  });

  it("hand-created target with no lock entry for it at all: byte-for-byte backup before the --force overwrite", async () => {
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

  it("generated files change but the target already matches: the target is not rewritten and gets no backup", async () => {
    writeManifest();
    const target = targetPath();
    await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    // Only harness.generated/ changes: the manifest gains a memory directory,
    // the hooks (and so the target's content) stay the same.
    const memDir = path.join(tmpHome, "mem");
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, "note.md"), "---\nname: note\ndescription: d\ntype: project\n---\nbody\n");
    const manifest = {
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [{ path: memDir, scope: "project" }] },
      hooks: [{ name: "h", event: "SessionStart", command: "/h.sh", blocking: false, budget_ms: 30000 }],
      policies: [],
    };
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), yamlStringify(manifest));
    const before = fs.readFileSync(target, "utf8");
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.outcome).toBe("applied");
    expect(r.targetWritten).toBe(false);
    expect(r.targetBackupPath).toBeUndefined();
    expect(backupNames(tmpHome)).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
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

  it("backup failure on a NON-first apply: apply errors, harness.generated/ and .last-apply and the target all unchanged; after removing the blocker the next apply needs no --overwrite-drift", async () => {
    writeManifest("/h1.sh");
    const target = targetPath();
    await apply({ homeDir: tmpHome, target, force: true });
    const generatedDir = path.join(tmpHome, "harness.generated");
    expect(fs.existsSync(path.join(generatedDir, LAST_APPLY_BASENAME))).toBe(true);
    writeManifest("/h2.sh");
    fs.mkdirSync(backupName(target));
    const generatedBefore = snapshotTree(generatedDir);
    const targetBefore = fs.readFileSync(target, "utf8");
    let err: unknown;
    try {
      await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessExitError);
    expect((err as Error).message).toContain(backupName(target));
    // The backup runs before the harness.generated/ writes, so the aborted
    // apply leaves no partial state: the tree is byte-identical (this is
    // what keeps the retry from meeting a drift-refuse).
    expect(snapshotTree(generatedDir)).toEqual(generatedBefore);
    expect(fs.readFileSync(target, "utf8")).toBe(targetBefore);
    expect(fs.readdirSync(tmpHome).filter((n) => n.includes(".bak."))).toEqual([
      path.basename(backupName(target)),
    ]);

    fs.rmSync(backupName(target), { recursive: true });
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.outcome).toBe("applied");
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(target, "utf8")).toContain("/h2.sh");
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

describe("apply --target backup: CLI output", () => {
  async function runCli(extra: string[]): Promise<string> {
    let out = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
    });
    await program.parseAsync(
      ["apply", "--config", path.join(tmpHome, "harness.yaml"), ...extra],
      { from: "user" },
    );
    return out;
  }

  it("overwriting an existing changed target prints the backup path; a fresh write prints none", async () => {
    writeManifest("/h1.sh");
    const target = targetPath();
    const created = await runCli(["--target", target, "--force"]);
    expect(created).toContain("wrote target:");
    expect(created).not.toContain("backup written to");

    writeManifest("/h2.sh");
    const overwritten = await runCli(["--target", target, "--force"]);
    expect(overwritten).toContain("wrote target:");
    expect(overwritten).toMatch(new RegExp(`backup written to ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.bak\\.`));
    expect(backupNames(tmpHome)).toHaveLength(1);
  });
});
