// The block generation marker: the installer writes the hash of the content it
// renders into the harness-managed Codex block, `gate disable --runtime codex`
// records it in its snapshot, and a snapshot whose recorded marker differs from
// the block's is retired as superseded, never applied, whatever link it sits
// beside and whatever installer backups exist. Snapshots and blocks without a
// marker keep the older dating rules. Every fixture is built by the installer.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  planCodexConfigInstall,
  readCodexManagedHookUnits,
  writeCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { EX_FAIL, EX_OK } from "../../../src/cli/exit-codes.js";
import { run } from "../../../src/cli/index.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import {
  CODEX_NEUTRALISED_HOOKS,
  listCodexSnapshots,
  readCodexSnapshot,
  retiredCodexSnapshotPath,
} from "../../../src/cli/gate/codex-snapshot.js";
import { parseManifest } from "../../../src/schema/index.js";

// Spelled out here rather than imported, so the tests pin the written format.
const MARKER = "# harness block generation: ";
const MARKER_LINE_RE = /^# harness block generation: [0-9a-f]{64}\n/m;

const BP = "policy-pack:branch-protection:pre-tool-use";
const SG = "shell-guard";
const V1 = "harness pack hook shell-guard --runtime codex";
const V2 = "harness pack hook shell-guard --runtime codex --v2";
const OLD_SG_LINE = `command = "${V1}"`;
const OPERATOR = 'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs-server"\n';
const OPERATOR_AFTER = '\n[projects."/work/x"]\ntrust_level = "trusted"\n';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-codex-generation-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const at = (hour: number): Date => new Date(`2026-10-02T${String(hour).padStart(2, "0")}:00:00.000Z`);
const readFile = (file: string): string => fs.readFileSync(file, "utf8");

/** The generated content; `shellGuard: null` leaves the shell guard out of the manifest. */
function generated(shellGuard: string | null = V1): string {
  return generateCodexConfig(
    parseManifest({
      version: 1,
      hooks: [
        { name: BP, event: "PreToolUse", match: "apply_patch", command: "harness pack hook branch-protection --runtime codex", blocking: "hard", budget_ms: 5000 },
        ...(shellGuard === null
          ? []
          : [{ name: SG, event: "PreToolUse", match: "Bash", command: shellGuard, blocking: "hard", budget_ms: 5000 }]),
        { name: "prompt-note", event: "UserPromptSubmit", command: "/usr/bin/true", blocking: false, budget_ms: 5000 },
      ],
    }),
  ).content;
}

/** The marker the installer is expected to write for the generated content: sha256 of it as the block holds it. */
function expectedGeneration(content: string): string {
  return sha(content.trimEnd());
}

/** Runs the real installer through `target` at `now` (it supersedes the snapshots it can find). */
function install(target: string, now: Date, shellGuard: string | null = V1): ReturnType<typeof writeCodexConfigInstall> {
  return writeCodexConfigInstall(
    planCodexConfigInstall({ configPath: target, generatedPath: "/gen/codex/config.toml", generatedContent: generated(shellGuard) }),
    { now },
  );
}

/** A config file holding operator text before and after the installed block, written by the installer. */
function installFresh(target: string, now = at(0)): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, OPERATOR);
  const result = install(target, now);
  const full = `${readFile(result.configPath)}${OPERATOR_AFTER}`;
  fs.writeFileSync(result.configPath, full);
  return full;
}

function disable(target: string, matcher: string, now: Date): string {
  const d = codexGateDisable({ configPath: target, matcher, now });
  if (d.mode !== "remove") throw new Error("expected remove");
  return d.snapshotPath;
}

/** The unit's `hooks` line emptied by hand, in the shape the gate writes. */
function neutraliseByHand(file: string, id: string): string {
  const text = readFile(file);
  const unit = readCodexManagedHookUnits(text, file)!.units.find((u) => u.id === id)!;
  const out = `${text.slice(0, unit.hooksStart)}${CODEX_NEUTRALISED_HOOKS}${text.slice(unit.hooksEnd)}`;
  fs.writeFileSync(file, out);
  return out;
}

/** `text` with the generation marker line removed. */
function withoutMarker(text: string): string {
  return text.replace(MARKER_LINE_RE, "");
}

/** The marker the config's block carries, read straight from the line under BEGIN. */
function markerIn(text: string): string {
  const lines = text.split("\n");
  const line = lines[lines.indexOf(CODEX_MANAGED_BEGIN) + 1]!;
  if (!line.startsWith(MARKER)) throw new Error(`no marker under BEGIN: ${line}`);
  return line.slice(MARKER.length);
}

function snapshotBody(snapPath: string): Record<string, unknown> {
  return JSON.parse(readFile(snapPath)) as Record<string, unknown>;
}

function removeInstallBackups(): void {
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.includes(".harness-backup-")) fs.rmSync(p);
    }
  };
  walk(tmp);
}

function thrownMessage(call: () => unknown): string {
  try {
    call();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the call to throw");
}

async function gate(...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv: ["gate", ...argv],
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, code };
}

describe("the installer writes the block generation marker", () => {
  it("puts one marker line directly under BEGIN, holding the sha256 of the rendered content", () => {
    const configPath = path.join(tmp, "config.toml");
    const text = installFresh(configPath);
    const lines = text.split("\n");
    const begin = lines.indexOf(CODEX_MANAGED_BEGIN);
    expect(lines[begin + 1]).toBe(`${MARKER}${expectedGeneration(generated())}`);
    expect(lines[begin + 2]).toBe("# Generated by harness apply --runtime codex.");
    expect(lines.filter((l) => l.startsWith(MARKER))).toHaveLength(1);
    expect(lines.indexOf(CODEX_MANAGED_END)).toBeGreaterThan(begin + 1);
    expect(readCodexManagedHookUnits(text, configPath)!.generation).toBe(expectedGeneration(generated()));
  });

  it("adds no TOML data: every hook entry keeps its position and content, and the text outside the fences is the operator's", () => {
    const configPath = path.join(tmp, "config.toml");
    const text = installFresh(configPath);
    expect(parseToml(text)).toEqual(parseToml(withoutMarker(text)));
    const hooks = (parseToml(text) as { hooks: Record<string, Array<Record<string, unknown>>> }).hooks;
    expect(hooks["PreToolUse"]!.map((e) => e["matcher"])).toEqual(["apply_patch", expect.stringContaining("Bash")]);
    expect(hooks["UserPromptSubmit"]).toHaveLength(1);
    expect(text.startsWith(`${OPERATOR}\n# Harness Codex hook wiring.`)).toBe(true);
    expect(text.endsWith(`${CODEX_MANAGED_END}\n${OPERATOR_AFTER}`)).toBe(true);
  });

  it("renders the same marker for the same content, so a re-install of an unchanged manifest stays a no-op", () => {
    const configPath = path.join(tmp, "config.toml");
    installFresh(configPath);
    const plan = planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated() });
    expect(plan.changed).toBe(false);
    expect(plan.summary).toContain("already up to date");
  });

  it("renders another marker for other content", () => {
    const configPath = path.join(tmp, "config.toml");
    const before = markerIn(installFresh(configPath));
    install(configPath, at(1), V2);
    const after = markerIn(readFile(configPath));
    expect(after).toBe(expectedGeneration(generated(V2)));
    expect(after).not.toBe(before);
  });

  it("adds the line once to a block an older install wrote, changing nothing else", () => {
    const configPath = path.join(tmp, "config.toml");
    const legacy = withoutMarker(installFresh(configPath));
    fs.writeFileSync(configPath, legacy);
    expect(readCodexManagedHookUnits(legacy, configPath)!.generation).toBeNull();
    const plan = planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated() });
    expect(plan.changed).toBe(true);
    expect(withoutMarker(plan.nextContent)).toBe(legacy);
    writeCodexConfigInstall(plan, { now: at(1) });
    expect(
      planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated() }).changed,
    ).toBe(false);
  });
});

describe("readCodexManagedHookUnits: the generation", () => {
  it("is null when the line under BEGIN is missing, edited into another shape, or moved", () => {
    const configPath = path.join(tmp, "config.toml");
    const text = installFresh(configPath);
    const marker = markerIn(text);
    const cases = [
      withoutMarker(text),
      text.replace(`${MARKER}${marker}`, `${MARKER}${marker.slice(1)}`),
      text.replace(`${MARKER}${marker}`, `${MARKER}${marker.toUpperCase()}`),
      text.replace(`${MARKER}${marker}`, "# harness block generation: edited by hand"),
      // The right 64 digits with more after them: the whole line must match.
      text.replace(`${MARKER}${marker}`, `${MARKER}${marker}0`),
      text.replace(`${MARKER}${marker}`, `${MARKER}${marker} edited`),
      // The right shape, one line too low: only the line right under BEGIN counts.
      withoutMarker(text).replace(
        "# Generated by harness apply --runtime codex.\n",
        `# Generated by harness apply --runtime codex.\n${MARKER}${marker}\n`,
      ),
    ];
    for (const edited of cases) {
      expect(edited).not.toBe(text);
      const block = readCodexManagedHookUnits(edited, configPath)!;
      expect(block.generation).toBeNull();
      expect(block.units.map((u) => u.id)).toEqual([BP, SG, "prompt-note"]);
    }
  });

  it("is read from a CRLF config too", () => {
    const configPath = path.join(tmp, "config.toml");
    const text = installFresh(configPath);
    expect(readCodexManagedHookUnits(text.replace(/\n/g, "\r\n"), configPath)!.generation).toBe(markerIn(text));
  });
});

describe("gate disable --runtime codex records the block generation", () => {
  it("in a fresh snapshot, and a merge keeps it", () => {
    const configPath = path.join(tmp, "config.toml");
    const marker = markerIn(installFresh(configPath));
    const s0 = disable(configPath, "apply_patch", at(1));
    expect(snapshotBody(s0)["blockGeneration"]).toBe(marker);
    expect(disable(configPath, "Bash", at(2))).toBe(s0);
    const merged = snapshotBody(s0);
    expect(merged["blockGeneration"]).toBe(marker);
    expect(merged["merges"]).toHaveLength(1);
  });

  it("writes no blockGeneration field for a block without a marker", () => {
    const configPath = path.join(tmp, "config.toml");
    fs.writeFileSync(configPath, withoutMarker(installFresh(configPath)));
    const s0 = disable(configPath, "Bash", at(1));
    expect("blockGeneration" in snapshotBody(s0)).toBe(false);
    const read = readCodexSnapshot(s0);
    expect(read.ok && read.snapshot.blockGeneration).toBeUndefined();
  });
});

/** One config reached through two links in different directories: A and B. */
function twoLinks(): { real: string; a: string; b: string; dirA: string; dirB: string; original: string } {
  const real = path.join(tmp, "dotfiles", "config.toml");
  const original = installFresh(real);
  const dirA = path.join(tmp, "codex-home");
  const dirB = path.join(tmp, "other-home");
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  const a = path.join(dirA, "config.toml");
  const b = path.join(dirB, "config.toml");
  fs.symlinkSync(real, a);
  fs.symlinkSync(real, b);
  return { real, a, b, dirA, dirB, original };
}

/** Disable via B, install a changed command via `installVia`, disable the same unit again via A. */
function staleBesideB(installVia: "a" | "real") {
  const f = twoLinks();
  const s1 = disable(f.b, "Bash", at(1));
  const result = install(installVia === "a" ? f.a : f.real, at(2), V2);
  // The install cannot see a snapshot beside B: it stays live.
  expect(result.supersededSnapshots).toBeUndefined();
  expect(listCodexSnapshots(f.dirB)).toEqual([s1]);
  const v2 = readFile(f.real);
  const s2 = disable(f.a, "Bash", at(3));
  return { ...f, s1, s2, v2, offAgain: readFile(f.real) };
}

describe("a stale snapshot beside a second link (on neither the install's chain nor enable's)", () => {
  it("the reproduction: disable via B, install via A, disable via A, enable via B retires the snapshot as superseded and writes no outdated line", () => {
    const f = staleBesideB("a");
    const g1 = markerIn(f.original);
    const g2 = markerIn(f.v2);
    expect(g2).not.toBe(g1);
    expect(snapshotBody(f.s1)["blockGeneration"]).toBe(g1);
    const e = codexGateEnable({ configPath: f.b, now: at(4) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired).toEqual({
      from: f.s1,
      to: retiredCodexSnapshotPath(f.s1, "superseded"),
      why: "superseded",
      generation: { snapshot: g1, block: g2 },
    });
    expect(e.stillDisabled).toEqual([SG]);
    expect(readFile(f.real)).toBe(f.offAgain);
    expect(readFile(f.real)).not.toContain(OLD_SG_LINE);
    expect(listCodexSnapshots(f.dirB)).toEqual([]);
    // The snapshot the second disable wrote, beside A, puts the current line back byte-identically.
    const back = codexGateEnable({ configPath: f.a, now: at(5) });
    expect(back.mode).toBe("restored");
    expect(readFile(f.real)).toBe(f.v2);
  });

  it("--force never applies it either", () => {
    const f = staleBesideB("a");
    const e = codexGateEnable({ configPath: f.b, force: true, now: at(4) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired?.why).toBe("superseded");
    expect(e.mode !== "no-snapshots" && e.retired?.generation).toBeDefined();
    expect(readFile(f.real)).toBe(f.offAgain);
  });

  for (const force of [false, true]) {
    it(`deleting the installer's backups does not re-open it${force ? " (--force)" : ""}: an install through the target, whose backups enable via B would see, is dated by the marker once they are gone`, () => {
      const f = staleBesideB("real");
      // With the backups in place they date the install (the older rule, named first).
      expect(fs.existsSync(`${f.real}.harness-backup-2026-10-02T02-00-00-000Z`)).toBe(true);
      removeInstallBackups();
      const e = codexGateEnable({ configPath: f.b, force, now: at(4) });
      expect(e.mode).toBe("already-restored");
      expect(e.mode !== "no-snapshots" && e.retired).toEqual({
        from: f.s1,
        to: retiredCodexSnapshotPath(f.s1, "superseded"),
        why: "superseded",
        generation: { snapshot: markerIn(f.original), block: markerIn(f.v2) },
      });
      expect(readFile(f.real)).toBe(f.offAgain);
      expect(readFile(f.real)).not.toContain(OLD_SG_LINE);
    });
  }

  it("a disable via B retires it instead of joining it, and starts a fresh snapshot with the block's marker", () => {
    const f = staleBesideB("a");
    removeInstallBackups();
    const d = codexGateDisable({ configPath: f.b, matcher: "apply_patch", now: at(4) });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.retired).toEqual({
      from: f.s1,
      to: retiredCodexSnapshotPath(f.s1, "superseded"),
      why: "superseded",
      generation: { snapshot: markerIn(f.original), block: markerIn(f.v2) },
    });
    expect(d.snapshotPath).not.toBe(f.s1);
    expect(snapshotBody(d.snapshotPath)["blockGeneration"]).toBe(markerIn(f.v2));
    // Each snapshot restores what its own disable took out; the old line never comes back.
    expect(codexGateEnable({ configPath: f.b, now: at(5) }).mode).toBe("restored");
    expect(codexGateEnable({ configPath: f.a, now: at(6) }).mode).toBe("restored");
    expect(readFile(f.real)).toBe(f.v2);
  });

  it("with every unit enabled again by the install, enable via B retires it naming the markers and writes nothing", () => {
    const f = twoLinks();
    const s1 = disable(f.b, "Bash", at(1));
    install(f.a, at(2), V2);
    const v2 = readFile(f.real);
    const e = codexGateEnable({ configPath: f.b, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired).toEqual({
      from: s1,
      to: retiredCodexSnapshotPath(s1, "superseded"),
      why: "superseded",
      generation: { snapshot: markerIn(f.original), block: markerIn(v2) },
    });
    expect(e.stillDisabled).toEqual([]);
    expect(readFile(f.real)).toBe(v2);
  });

  it("when the install dropped a unit the snapshot names, enable via B retires it instead of keeping it live for the missing unit", () => {
    const f = twoLinks();
    const s1 = disable(f.b, "Bash", at(1));
    install(f.a, at(2), null);
    const without = readFile(f.real);
    expect(readCodexManagedHookUnits(without, f.real)!.units.map((u) => u.id)).not.toContain(SG);
    const e = codexGateEnable({ configPath: f.b, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.missing).toEqual([]);
    expect(e.mode !== "no-snapshots" && e.retired?.generation).toEqual({ snapshot: markerIn(f.original), block: markerIn(without) });
    expect(listCodexSnapshots(f.dirB)).toEqual([]);
    expect(readFile(f.real)).toBe(without);
  });

  it("enable via B names the retired snapshot and why, and exits non-zero pointing at the --config the disable used", async () => {
    const f = staleBesideB("a");
    const r = await gate("enable", "--runtime", "codex", "--config", f.b);
    expect(r.code).toBe(EX_FAIL);
    expect(r.stdout).toContain(
      `retired ${f.s1} as ${retiredCodexSnapshotPath(f.s1, "superseded")}: a later install re-rendered the ` +
        `harness-managed block (its generation marker is now ${markerIn(f.v2).slice(0, 12)}..., the snapshot recorded ` +
        `${markerIn(f.original).slice(0, 12)}...), so its hooks lines may be outdated.`,
    );
    expect(r.stderr).toContain(`are still disabled: ${SG}`);
    expect(r.stderr).toContain("Run `harness gate enable --runtime codex --config <that spelling>`");
    expect(readFile(f.real)).toBe(f.offAgain);
  });

  it("enable via B never offers the stale backup: it names the --config re-run, then the re-install, then the by-hand line", async () => {
    const f = staleBesideB("a");
    const r = await gate("enable", "--runtime", "codex", "--config", f.b);
    expect(r.code).toBe(EX_FAIL);
    expect(r.stderr).toContain(`are still disabled: ${SG}`);
    expect(r.stderr).toContain("Run `harness gate enable --runtime codex --config <that spelling>`");
    expect(r.stderr).toContain(`\`harness apply --runtime codex --install --codex-config ${f.b}\``);
    expect(r.stderr).toContain("put the units' `hooks` lines back by hand");
    expect(r.stderr).not.toContain(".bak.<timestamp>");
    // The other spelling's enable comes before the re-install, and the re-install before the by-hand line.
    expect(r.stderr.indexOf("--config <that spelling>")).toBeLessThan(
      r.stderr.indexOf("`harness apply --runtime codex --install"),
    );
    expect(r.stderr.indexOf("`harness apply --runtime codex --install")).toBeLessThan(
      r.stderr.indexOf("put the units' `hooks` lines back by hand"),
    );
    expect(readFile(f.real)).toBe(f.offAgain);
  });

  it("a disable via B prints the retirement with its reason", async () => {
    const f = staleBesideB("a");
    const r = await gate("disable", "--runtime", "codex", "--config", f.b, "--matcher", "apply_patch");
    expect(r.code).toBe(EX_OK);
    expect(r.stdout).toContain(
      `retired ${f.s1} as ${retiredCodexSnapshotPath(f.s1, "superseded")}: a later install re-rendered the ` +
        "harness-managed block (its generation marker is now ",
    );
    expect(r.stdout).toContain("so its hooks lines may be outdated; this disable starts a fresh snapshot.");
  });
});

describe("a snapshot that matches the block's marker keeps every other rule", () => {
  it("restores byte-identically with every installer backup deleted", () => {
    const f = twoLinks();
    const s1 = disable(f.b, "Bash", at(1));
    removeInstallBackups();
    const e = codexGateEnable({ configPath: f.b, now: at(2) });
    expect(e.mode).toBe("restored");
    expect(e.mode === "restored" && e.snapshotPath).toBe(retiredCodexSnapshotPath(s1, "restored"));
    expect(readFile(f.real)).toBe(f.original);
  });
});

describe("the marker line removed or edited by hand never locks a legitimate enable out", () => {
  for (const [what, edit] of [
    ["removed", (t: string): string => withoutMarker(t)],
    ["edited into another shape", (t: string): string => t.replace(MARKER_LINE_RE, `${MARKER}see the install log\n`)],
  ] as const) {
    it(`${what}: the config counts as edited since the disable, enable names --force and --force restores the unit`, () => {
      const configPath = path.join(tmp, "config.toml");
      const original = installFresh(configPath);
      const s0 = disable(configPath, "Bash", at(1));
      const edited = edit(readFile(configPath));
      fs.writeFileSync(configPath, edited);
      expect(readCodexManagedHookUnits(edited, configPath)!.generation).toBeNull();
      expect(thrownMessage(() => codexGateEnable({ configPath, now: at(2) }))).toMatch(
        /edited since the snapshot was taken[\s\S]*--force restores every unit/,
      );
      expect(thrownMessage(() => codexGateDisable({ configPath, matcher: "apply_patch", now: at(2) }))).toContain(
        `harness gate enable --runtime codex --config ${configPath} --force`,
      );
      const e = codexGateEnable({ configPath, force: true, now: at(3) });
      expect(e.mode).toBe("restored");
      expect(e.mode === "restored" && e.snapshotPath).toBe(retiredCodexSnapshotPath(s0, "restored"));
      expect(readFile(configPath)).toBe(edit(original));
    });
  }

  it("edited into another well-formed marker: read as a re-install, retired as superseded, the unit named as still off", () => {
    const configPath = path.join(tmp, "config.toml");
    installFresh(configPath);
    const s0 = disable(configPath, "Bash", at(1));
    const other = "0".repeat(64);
    fs.writeFileSync(configPath, readFile(configPath).replace(MARKER_LINE_RE, `${MARKER}${other}\n`));
    const e = codexGateEnable({ configPath, now: at(2) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired?.generation?.block).toBe(other);
    expect(e.stillDisabled).toEqual([SG]);
    // The retired snapshot keeps the original line for a by-hand restore.
    expect(readFile(retiredCodexSnapshotPath(s0, "superseded"))).toContain(V1);
  });
});

describe("a snapshot without a marker keeps the older dating rules", () => {
  it("restores byte-identically on a block that carries a marker (it is never dated by a marker it did not record)", () => {
    const configPath = path.join(tmp, "config.toml");
    const original = installFresh(configPath);
    const s0 = disable(configPath, "Bash", at(1));
    const body = snapshotBody(s0);
    delete body["blockGeneration"];
    fs.writeFileSync(s0, JSON.stringify(body));
    removeInstallBackups();
    const e = codexGateEnable({ configPath, now: at(2) });
    expect(e.mode).toBe("restored");
    expect(readFile(configPath)).toBe(original);
  });

  it("is not superseded by a later install's marker alone: with the backups gone the edited config needs --force, as before", () => {
    const f = twoLinks();
    fs.writeFileSync(f.real, withoutMarker(f.original));
    const s1 = disable(f.b, "Bash", at(1));
    expect("blockGeneration" in snapshotBody(s1)).toBe(false);
    install(f.real, at(2), V2);
    removeInstallBackups();
    neutraliseByHand(f.real, SG);
    expect(thrownMessage(() => codexGateEnable({ configPath: f.b, now: at(3) }))).toContain("edited since the snapshot was taken");
    expect(listCodexSnapshots(f.dirB)).toEqual([s1]);
  });

  it("is still superseded by a later install's backup", () => {
    const f = twoLinks();
    fs.writeFileSync(f.real, withoutMarker(f.original));
    const s1 = disable(f.b, "Bash", at(1));
    install(f.real, at(2), V2);
    neutraliseByHand(f.real, SG);
    const e = codexGateEnable({ configPath: f.b, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired?.installBackup).toBe(`${f.real}.harness-backup-2026-10-02T02-00-00-000Z`);
    expect(e.mode !== "no-snapshots" && e.retired?.from).toBe(s1);
    expect(readFile(f.real)).not.toContain(OLD_SG_LINE);
  });
});

describe("a snapshot whose blockGeneration is not a marker", () => {
  for (const [what, value] of [
    ["a short string", "abc"],
    ["upper-case hex", "A".repeat(64)],
    ["a number", 7],
    ["null", null],
  ] as const) {
    it(`(${what}) blocks both verbs, naming the file and the move-aside step`, () => {
      const configPath = path.join(tmp, "config.toml");
      installFresh(configPath);
      const s0 = disable(configPath, "Bash", at(1));
      fs.writeFileSync(s0, JSON.stringify({ ...snapshotBody(s0), blockGeneration: value }));
      const before = readFile(configPath);
      for (const call of [
        () => codexGateEnable({ configPath, now: at(2) }),
        () => codexGateDisable({ configPath, matcher: "apply_patch", now: at(2) }),
      ]) {
        const message = thrownMessage(call);
        expect(message).toContain(`snapshot ${s0} has a "blockGeneration" that is not a block generation marker`);
        expect(message).toContain(`move ${s0} aside`);
      }
      expect(readFile(configPath)).toBe(before);
    });
  }
});
