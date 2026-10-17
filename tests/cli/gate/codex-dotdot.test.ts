import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  CODEX_MANAGED_BEGIN,
  CodexInstallRefusalError,
  planCodexConfigInstall,
  resolveConfigSymlink,
  writeCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { EX_FAIL, EX_OK } from "../../../src/cli/exit-codes.js";
import { run } from "../../../src/cli/index.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import { listCodexSnapshots } from "../../../src/cli/gate/codex-snapshot.js";
import { GateDisableError } from "../../../src/cli/gate/disable.js";
import { GateEnableError } from "../../../src/cli/gate/enable.js";
import { parseManifest } from "../../../src/schema/index.js";

// The walker is the real one unless a test makes it lie about where a chain ends.
const walker = vi.hoisted(() => ({ lie: null as null | ((start: string) => unknown) }));
vi.mock("../../../src/cli/gate/link-chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/gate/link-chain.js")>();
  return {
    ...actual,
    walkLinkChain: (start: string) => (walker.lie !== null ? walker.lie(start) : actual.walkLinkChain(start)),
  };
});

// A config reached through a link whose text, or a --config spelled with `..`, takes `..` after a directory
// link: the kernel climbs out of the directory that link leads to, and every Codex path (the install target, the
// gate's listing, the backups and snapshots) has to end up at the file reading through the spelling gives.

const NOW = new Date("2026-10-01T00:00:00.000Z");
const PLAIN = 'model = "gpt-5.5"\n';

const generated = generateCodexConfig(
  parseManifest({
    version: 1,
    hooks: [
      {
        name: "policy-pack:branch-protection:pre-tool-use",
        event: "PreToolUse",
        match: "apply_patch",
        command: "harness pack hook branch-protection --runtime codex",
        blocking: "hard",
        budget_ms: 5000,
      },
    ],
  }),
);

interface Built {
  /** What is handed to the install and to `gate disable --config`. */
  spell: string;
  /** The working directory the spelling is read from, when it is relative. */
  cwd?: string;
}

type Shape = (r: string, decoy: boolean) => Built;

const J = path.join;
const mk = (p: string): void => {
  fs.mkdirSync(p, { recursive: true });
};
const ln = (text: string, at: string): void => {
  mk(path.dirname(at));
  fs.symlinkSync(text, at);
};
// A regular file is an operator config. A decoy is a file a lexical reading of the spelling lands on.
const config = (p: string): void => {
  mk(path.dirname(p));
  fs.writeFileSync(p, `${PLAIN}# ${path.basename(path.dirname(p))}/${path.basename(p)}\n`);
};
const decoyConfig = (decoy: boolean, p: string): void => {
  if (decoy) config(p);
};

/** Shapes whose spelling the kernel resolves to one regular file. */
const RESOLVING: Record<string, Shape> = {
  rel_dotdot_via_dirlink: (r, d) => {
    // home/via -> dot/real ; dot/real/settings.json -> ../x/settings.json (kernel: dot/x/settings.json)
    config(J(r, "dot/x/settings.json"));
    decoyConfig(d, J(r, "home/x/settings.json"));
    mk(J(r, "dot/real"));
    ln(J(r, "dot/real"), J(r, "home/via"));
    ln("../x/settings.json", J(r, "dot/real/settings.json"));
    return { spell: J(r, "home/via/settings.json") };
  },
  abs_dotdot_after_dirlink: (r, d) => {
    mk(J(r, "real/inner"));
    config(J(r, "real/f.json"));
    decoyConfig(d, J(r, "base/f.json"));
    ln(J(r, "real/inner"), J(r, "base/d"));
    ln(`${r}/base/d/../f.json`, J(r, "a/settings.json"));
    return { spell: J(r, "a/settings.json") };
  },
  d_dot_dotdot: (r, d) => {
    mk(J(r, "real/inner"));
    config(J(r, "real/f.json"));
    decoyConfig(d, J(r, "base/f.json"));
    ln(J(r, "real/inner"), J(r, "base/d"));
    ln("d/./../f.json", J(r, "base/settings.json"));
    return { spell: J(r, "base/settings.json") };
  },
  d_empty_dotdot: (r, d) => {
    mk(J(r, "real/inner"));
    config(J(r, "real/f.json"));
    decoyConfig(d, J(r, "base/f.json"));
    ln(J(r, "real/inner"), J(r, "base/d"));
    ln("d//../f.json", J(r, "base/settings.json"));
    return { spell: J(r, "base/settings.json") };
  },
  multihop_with_dirlinks: (r, d) => {
    // a/settings.json -> ../hop/l2.json (hop -> dot/h) ; dot/h/l2.json -> d/../l3.json (d -> deep/in)
    // => deep/l3.json -> final/settings.json
    config(J(r, "final/settings.json"));
    mk(J(r, "dot/h"));
    mk(J(r, "deep/in"));
    ln(J(r, "dot/h"), J(r, "hop"));
    ln("../hop/l2.json", J(r, "a/settings.json"));
    ln(J(r, "deep/in"), J(r, "dot/h/d"));
    ln("d/../l3.json", J(r, "dot/h/l2.json"));
    decoyConfig(d, J(r, "dot/h/l3.json"));
    ln(J(r, "final/settings.json"), J(r, "deep/l3.json"));
    return { spell: J(r, "a/settings.json") };
  },
  config_flag_dotdot: (r, d) => {
    // --config home/in/../a/settings.json ; home/in -> dot/b => dot/a/settings.json
    config(J(r, "dot/a/settings.json"));
    mk(J(r, "dot/b"));
    decoyConfig(d, J(r, "home/a/settings.json"));
    ln(J(r, "dot/b"), J(r, "home/in"));
    return { spell: `${r}/home/in/../a/settings.json` };
  },
  config_flag_dotdot_and_dotdot_link: (r, d) => {
    // --config home/in/../a/settings.json (in -> dot/b) ; dot/a/settings.json -> d/../conf.json (d -> deep/x)
    mk(J(r, "dot/b"));
    mk(J(r, "deep/x"));
    config(J(r, "deep/conf.json"));
    decoyConfig(d, J(r, "dot/a/conf.json"));
    decoyConfig(d, J(r, "home/a/settings.json"));
    ln(J(r, "dot/b"), J(r, "home/in"));
    ln(J(r, "deep/x"), J(r, "dot/a/d"));
    ln("d/../conf.json", J(r, "dot/a/settings.json"));
    return { spell: `${r}/home/in/../a/settings.json` };
  },
  relative_config_flag_dotdot: (r, d) => {
    // the working directory is home/in (-> dot/b) ; ../a/settings.json => dot/a/settings.json
    config(J(r, "dot/a/settings.json"));
    mk(J(r, "dot/b"));
    decoyConfig(d, J(r, "home/a/settings.json"));
    ln(J(r, "dot/b"), J(r, "home/in"));
    return { spell: "../a/settings.json", cwd: J(r, "home/in") };
  },
  dotdot_last_is_dirlink_parent: (r, d) => {
    // via/../settings.json where via -> deep/x ; kernel => deep/settings.json
    mk(J(r, "deep/x"));
    config(J(r, "deep/settings.json"));
    decoyConfig(d, J(r, "settings.json"));
    ln(J(r, "deep/x"), J(r, "via"));
    return { spell: `${r}/via/../settings.json` };
  },
  // Spellings without a `..` after a directory link, whose behaviour must not change.
  plain: (r) => {
    config(J(r, "a/settings.json"));
    return { spell: J(r, "a/settings.json") };
  },
  rel_other_dir: (r) => {
    config(J(r, "b/settings.json"));
    ln("../b/settings.json", J(r, "a/settings.json"));
    return { spell: J(r, "a/settings.json") };
  },
  abs_other_dir: (r) => {
    config(J(r, "b/settings.json"));
    ln(J(r, "b/settings.json"), J(r, "a/settings.json"));
    return { spell: J(r, "a/settings.json") };
  },
  dot_segments_text: (r) => {
    config(J(r, "b/settings.json"));
    ln("./.././b/./settings.json", J(r, "a/settings.json"));
    return { spell: J(r, "a/settings.json") };
  },
  dirlink_in_middle_then_link_dotdot: (r) => {
    // home/cl -> dot/cl ; dot/cl/settings.json -> ../../dotfiles/settings.json (physical: r/dotfiles)
    config(J(r, "dotfiles/settings.json"));
    mk(J(r, "dot/cl"));
    ln(J(r, "dot/cl"), J(r, "home/cl"));
    ln("../../dotfiles/settings.json", J(r, "dot/cl/settings.json"));
    return { spell: J(r, "home/cl/settings.json") };
  },
};

/** Shapes the kernel does not resolve to a file: each refuses, naming why, and writes nothing. */
const REFUSING: Record<string, { build: Shape; message: (r: string) => string }> = {
  file_dotdot_enotdir: {
    build: (r) => {
      config(J(r, "base/f.json"));
      ln("f.json/../f.json", J(r, "base/settings.json"));
      return { spell: J(r, "base/settings.json") };
    },
    message: () => "cannot be resolved (ENOTDIR",
  },
  nodir_dotdot_dangling: {
    build: (r, d) => {
      decoyConfig(d, J(r, "base/f.json"));
      mk(J(r, "base"));
      ln("nodir/../f.json", J(r, "base/settings.json"));
      return { spell: J(r, "base/settings.json") };
    },
    // The chain ends at the text as written, never at a lexical guess of where it might have led.
    message: (r) => `its link chain ends at ${r}/base/nodir/../f.json, which does not exist`,
  },
  dangling_file_gone: {
    build: (r) => {
      mk(J(r, "b"));
      ln("../b/settings.json", J(r, "a/settings.json"));
      return { spell: J(r, "a/settings.json") };
    },
    message: (r) => `its link chain ends at ${r}/b/settings.json, which does not exist`,
  },
  abs_dotdot_dangling_via_dirlink: {
    build: (r, d) => {
      mk(J(r, "real/inner"));
      decoyConfig(d, J(r, "base/gone.json"));
      ln(J(r, "real/inner"), J(r, "base/d"));
      ln(`${r}/base/d/../gone.json`, J(r, "a/settings.json"));
      return { spell: J(r, "a/settings.json") };
    },
    message: (r) => `its link chain ends at ${r}/real/gone.json, which does not exist`,
  },
  link_loop: {
    build: (r) => {
      mk(J(r, "a"));
      ln("y.json", J(r, "a/settings.json"));
      ln("settings.json", J(r, "a/y.json"));
      return { spell: J(r, "a/settings.json") };
    },
    message: () => "cannot be resolved (ELOOP",
  },
  // The walk ends at a regular file, but the kernel refuses a path that takes a file as a directory.
  trailing_slash_text: {
    build: (r) => {
      config(J(r, "a/real.json"));
      ln("real.json/", J(r, "a/settings.json"));
      return { spell: J(r, "a/settings.json") };
    },
    message: () => "cannot be resolved (ENOTDIR",
  },
};

let root: string;
let cwdBefore: string;

beforeEach(() => {
  cwdBefore = process.cwd();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-codex-dotdot-")));
});

afterEach(() => {
  process.chdir(cwdBefore);
  walker.lie = null;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every regular file under `dir` with a digest of its content, and every symlink with its text. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) out[`${path.relative(dir, p)}@`] = fs.readlinkSync(p);
      else out[path.relative(dir, p)] = crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** The files whose content differs between two trees, by tree-relative path, new files and removals included. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((k) => before[k] !== after[k])
    .map((k) => k.replace(/\d{4}-\d\d-\d\dT[\d-]+(\.\d+)?Z/g, "<TS>"))
    .sort();
}

/** Where the absolute form of `spell` lies, with its directory resolved as the kernel resolves it. */
function physicalDirOf(spell: string): string {
  const abs = path.isAbsolute(spell) ? spell : `${process.cwd()}${path.sep}${spell}`;
  return fs.realpathSync.native(path.dirname(abs));
}

/** The path, relative to the tree, of the regular file reading through `spell` reaches. */
function kernelFileOf(spell: string): string {
  return path.relative(root, fs.realpathSync.native(spell));
}

function installThrough(spell: string): ReturnType<typeof writeCodexConfigInstall> {
  const plan = planCodexConfigInstall({
    configPath: spell,
    generatedPath: "/gen/codex/config.toml",
    generatedContent: generated.content,
    now: NOW,
  });
  return writeCodexConfigInstall(plan, { now: NOW });
}

for (const decoy of [true, false]) {
  describe(`codex config through a spelling that takes \`..\` after a directory link (${decoy ? "a decoy where a lexical fold lands" : "nothing where a lexical fold lands"})`, () => {
    for (const [name, build] of Object.entries(RESOLVING)) {
      it(`${name}: install, gate disable and gate enable write and read the file the kernel reads`, () => {
        const { spell, cwd } = build(root, decoy);
        process.chdir(cwd ?? root);
        const file = kernelFileOf(spell);
        const dir = physicalDirOf(spell);
        const start = snapshotTree(root);
        // What reading through the spelling gives, before and after, is the differential.
        expect(fs.readFileSync(spell, "utf8")).toBe(fs.readFileSync(path.join(root, file), "utf8"));

        const installed = installThrough(spell);
        expect(installed.written).toBe(true);
        expect(path.relative(root, installed.configPath)).toBe(file);
        const afterInstall = snapshotTree(root);
        // Only the file the kernel reads is rewritten; the one other new file is the backup beside the spelling.
        expect(changed(start, afterInstall).filter((k) => !k.includes(".harness-backup-"))).toEqual([file]);
        expect(fs.readFileSync(spell, "utf8")).toContain(CODEX_MANAGED_BEGIN);
        expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(fs.readFileSync(spell, "utf8"));
        expect(fs.realpathSync.native(path.dirname(installed.backupPath ?? ""))).toBe(dir);
        const afterInstallText = fs.readFileSync(spell, "utf8");

        const off = codexGateDisable({ configPath: spell, matcher: "apply_patch", now: NOW });
        if (off.mode !== "remove") throw new Error("expected a disable");
        expect(fs.realpathSync.native(path.dirname(off.snapshotPath))).toBe(dir);
        expect(fs.realpathSync.native(path.dirname(off.backupPath))).toBe(dir);
        const afterDisable = snapshotTree(root);
        expect(changed(afterInstall, afterDisable).filter((k) => !k.includes("<TS>"))).toEqual([file]);
        expect(fs.readFileSync(spell, "utf8")).toContain("hooks = []");
        expect(listCodexSnapshots(dir)).toHaveLength(1);

        const on = codexGateEnable({ configPath: spell, now: NOW });
        expect(on.mode).toBe("restored");
        expect(fs.readFileSync(spell, "utf8")).toBe(afterInstallText);
        expect(changed(afterDisable, snapshotTree(root)).filter((k) => !k.includes("<TS>"))).toEqual([file]);
        expect(listCodexSnapshots(dir)).toHaveLength(0);
      });
    }

    for (const [name, { build, message }] of Object.entries(REFUSING)) {
      it(`${name}: install, gate disable and gate enable refuse, naming the cause, and write nothing`, () => {
        const { spell, cwd } = build(root, decoy);
        process.chdir(cwd ?? root);
        const start = snapshotTree(root);

        let installErr: unknown;
        try {
          installThrough(spell);
        } catch (err) {
          installErr = err;
        }
        expect(installErr).toBeInstanceOf(CodexInstallRefusalError);
        expect((installErr as Error).message).toContain(message(root));
        expect((installErr as Error).message).not.toContain("ENOENT: no such file");

        expect(() => codexGateDisable({ configPath: spell, matcher: "apply_patch", now: NOW })).toThrow(GateDisableError);
        expect(() => codexGateDisable({ configPath: spell, matcher: "apply_patch", now: NOW })).toThrow(message(root));
        expect(() => codexGateEnable({ configPath: spell, now: NOW })).toThrow(GateEnableError);
        expect(changed(start, snapshotTree(root))).toEqual([]);
      });
    }
  });
}

describe("codex config path handling that must not change", () => {
  it("returns a path that is no link, or does not exist, as given", () => {
    config(J(root, "a/config.toml"));
    expect(resolveConfigSymlink(J(root, "a/config.toml"))).toBe(J(root, "a/config.toml"));
    expect(resolveConfigSymlink(J(root, "a/missing.toml"))).toBe(J(root, "a/missing.toml"));
  });

  it("makes a plain relative --config absolute", () => {
    config(J(root, "a/config.toml"));
    process.chdir(J(root, "a"));
    const on = codexGateEnable({ configPath: "./config.toml", now: NOW });
    expect(on.mode).toBe("no-snapshots");
    expect(on.configPath).toBe(J(root, "a/config.toml"));
  });

  it("refuses a link to a directory as not a regular file, naming where it leads", () => {
    mk(J(root, "dir/inner"));
    ln(J(root, "dir/inner"), J(root, "a/config.toml"));
    expect(() => resolveConfigSymlink(J(root, "a/config.toml"))).toThrow(
      `is a symlink to ${J(root, "dir/inner")}, which is not a regular file`,
    );
  });
});

describe("codex gate --config spelled with `..`", () => {
  it("keeps a spelling whose directory is gone absolute, as written, instead of folding it", () => {
    // Nothing can be read through it; the message still names the spelling the call gave.
    mk(J(root, "x"));
    process.chdir(root);
    const on = codexGateEnable({ configPath: "nodir/../x/config.toml", now: NOW });
    expect(on.mode).toBe("no-snapshots");
    expect(on.configPath).toBe(`${root}/nodir/../x/config.toml`);
  });

  it("does not read a spelling that takes a regular file as a directory at the file's own directory", () => {
    // a/config.toml is a file, so a/config.toml/../config.toml leads nowhere (ENOTDIR). The native realpath of
    // some systems walks `file/..` back to the file's directory, which would edit a/config.toml instead.
    config(J(root, "a/config.toml"));
    installThrough(J(root, "a/config.toml"));
    const start = snapshotTree(root);
    const spelled = `${root}/a/config.toml/../config.toml`;
    expect(() => codexGateDisable({ configPath: spelled, matcher: "apply_patch", now: NOW })).toThrow("ENOTDIR");
    expect(() => codexGateEnable({ configPath: spelled, now: NOW })).toThrow("ENOTDIR");
    expect(changed(start, snapshotTree(root))).toEqual([]);
  });

  it("takes an absolute spelling through the directory the kernel reaches, and restores through the same spelling", async () => {
    // home/in -> dot/b, so home/in/../a is dot/a. home/a exists too: a lexical fold of the spelling lands there.
    config(J(root, "dot/a/config.toml"));
    mk(J(root, "dot/b"));
    mk(J(root, "home/a"));
    ln(J(root, "dot/b"), J(root, "home/in"));
    const spell = `${root}/home/in/../a/config.toml`;
    installThrough(spell);
    const installedText = fs.readFileSync(J(root, "dot/a/config.toml"), "utf8");

    let stdout = "";
    let stderr = "";
    const call = async (...argv: string[]): Promise<number> =>
      run({
        argv: ["gate", ...argv, "--runtime", "codex", "--config", spell],
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      });
    expect(await call("disable", "--matcher", "apply_patch")).toBe(EX_OK);
    expect(fs.readdirSync(J(root, "home/a"))).toEqual([]);
    expect(listCodexSnapshots(J(root, "dot/a"))).toHaveLength(1);
    expect(stdout).toContain(`snapshot: ${J(root, "dot/a")}/harness.gate-disable-codex.`);
    expect(fs.readFileSync(J(root, "dot/a/config.toml"), "utf8")).toContain("hooks = []");

    stdout = "";
    expect(await call("enable")).toBe(EX_OK);
    expect(stderr).toBe("");
    expect(fs.readFileSync(J(root, "dot/a/config.toml"), "utf8")).toBe(installedText);
    expect(fs.readdirSync(J(root, "home/a"))).toEqual([]);
  });

  it("exits non-zero for a link the kernel cannot resolve, with the chain end named", async () => {
    mk(J(root, "real/inner"));
    ln(J(root, "real/inner"), J(root, "base/d"));
    ln(`${root}/base/d/../gone.toml`, J(root, "a/config.toml"));
    let stderr = "";
    const code = await run({
      argv: ["gate", "disable", "--runtime", "codex", "--config", J(root, "a/config.toml"), "--matcher", "apply_patch"],
      stdout: () => undefined,
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(EX_FAIL);
    expect(stderr).toContain(`its link chain ends at ${root}/real/gone.toml, which does not exist`);
  });
});

describe("codex install: the walk and the kernel have to agree on the file", () => {
  it("refuses, writing nothing, when the walk ends at a file the kernel does not reach through the path", () => {
    config(J(root, "a/real.toml"));
    config(J(root, "b/other.toml"));
    ln("real.toml", J(root, "a/config.toml"));
    const start = snapshotTree(root);
    // A walk that lies about where the chain ends: the install must not write a file Codex never reads.
    walker.lie = () => ({ chain: [J(root, "a/config.toml"), J(root, "b/other.toml")], end: "target" });
    expect(() => installThrough(J(root, "a/config.toml"))).toThrow(
      `reaches another file than ${J(root, "b/other.toml")}`,
    );
    expect(changed(start, snapshotTree(root))).toEqual([]);
  });

  it("refuses a chain the walk gives up on while the kernel resolves nothing, with the kernel's cause", () => {
    ln("y.toml", J(root, "a/config.toml"));
    ln("config.toml", J(root, "a/y.toml"));
    walker.lie = (start) => ({ chain: [start], end: "unreadable" });
    expect(() => resolveConfigSymlink(J(root, "a/config.toml"))).toThrow("cannot be resolved (ELOOP");
  });

  it("refuses a chain the walk gives up on although the kernel resolves it, never writing to a guess", () => {
    config(J(root, "a/real.toml"));
    ln("real.toml", J(root, "a/config.toml"));
    walker.lie = (start) => ({ chain: [start], end: "loop" });
    expect(() => resolveConfigSymlink(J(root, "a/config.toml"))).toThrow(
      "cannot be resolved (the link chain ends in a loop)",
    );
  });
});

describe("codex install: the snapshots superseded by an install", () => {
  function snapshotNames(dir: string): string[] {
    return fs.readdirSync(dir).filter((n) => n.startsWith("harness.gate-disable-codex."));
  }

  it("supersedes the snapshot beside a config spelled with `..` after a directory link, not one beside a lexical fold", () => {
    // home/in -> dot/b, so home/in/../a is dot/a. home/a is where a lexical fold of the spelling lands.
    const spell = `${root}/home/in/../a/config.toml`;
    config(J(root, "dot/a/config.toml"));
    mk(J(root, "dot/b"));
    mk(J(root, "home/a"));
    ln(J(root, "dot/b"), J(root, "home/in"));
    installThrough(spell);
    const off = codexGateDisable({ configPath: spell, matcher: "apply_patch", now: NOW });
    if (off.mode !== "remove") throw new Error("expected a disable");
    expect(path.dirname(off.snapshotPath)).toBe(J(root, "dot/a"));
    expect(snapshotNames(J(root, "dot/a"))).toHaveLength(1);

    const plan = planCodexConfigInstall({
      configPath: spell,
      generatedPath: "/gen/codex/config.toml",
      generatedContent: `${generated.content}\n# changed\n`,
      now: NOW,
    });
    expect(plan.changed).toBe(true);
    const result = writeCodexConfigInstall(plan, { now: new Date("2026-10-02T00:00:00.000Z") });
    expect(result.snapshotWarnings ?? []).toEqual([]);
    expect(result.supersededSnapshots).toHaveLength(1);
    expect(listCodexSnapshots(J(root, "dot/a"))).toHaveLength(0);
    expect(fs.readdirSync(J(root, "home/a"))).toEqual([]);
  });

  it("reads one directory once when a hand-built plan spells the link path with `..`, and never reads the lexical fold", () => {
    // The planner never yields such a link path, so the plan is built by hand. A snapshot found twice would be
    // renamed once and then fail to rename. home/a holds a copy of the snapshot that names the same config: it
    // is not beside the config the kernel reaches, so the install leaves it alone.
    config(J(root, "dot/a/config.toml"));
    mk(J(root, "dot/b"));
    mk(J(root, "home/a"));
    ln(J(root, "dot/b"), J(root, "home/in"));
    installThrough(J(root, "dot/a/config.toml"));
    const off = codexGateDisable({ configPath: J(root, "dot/a/config.toml"), matcher: "apply_patch", now: NOW });
    if (off.mode !== "remove") throw new Error("expected a disable");
    fs.copyFileSync(off.snapshotPath, J(root, "home/a", path.basename(off.snapshotPath)));

    const plan = planCodexConfigInstall({
      configPath: J(root, "dot/a/config.toml"),
      generatedPath: "/gen/codex/config.toml",
      generatedContent: `${generated.content}\n# changed\n`,
      now: NOW,
    });
    const result = writeCodexConfigInstall(
      { ...plan, linkPath: `${root}/home/in/../a/config.toml` },
      { now: new Date("2026-10-02T00:00:00.000Z") },
    );
    expect(result.snapshotWarnings ?? []).toEqual([]);
    expect(result.supersededSnapshots).toHaveLength(1);
    expect(listCodexSnapshots(J(root, "dot/a"))).toHaveLength(0);
    expect(listCodexSnapshots(J(root, "home/a"))).toHaveLength(1);
  });
});
