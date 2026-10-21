// The one walker both gates use to find the hops of a settings or config link:
// where each hop leads, and why the walk stopped.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkChain, walkLinkChain } from "../../../src/cli/gate/link-chain.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-chain-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("walkLinkChain: why the walk stops", () => {
  it("ends at a target for an existing file that is not a link", () => {
    const file = path.join(tmp, "f.json");
    fs.writeFileSync(file, "{}\n");
    expect(walkLinkChain(file)).toEqual({ chain: [file], end: "target" });
  });

  it("ends dangling for a path with nothing at it and for a link to nothing", () => {
    const absent = path.join(tmp, "absent.json");
    expect(walkLinkChain(absent)).toEqual({ chain: [absent], end: "dangling" });
    const dangling = path.join(tmp, "dangling.json");
    fs.symlinkSync(absent, dangling);
    expect(walkLinkChain(dangling)).toEqual({ chain: [dangling, absent], end: "dangling" });
  });

  it("ends in a loop after the hop budget, naming every hop it walked", () => {
    const x = path.join(tmp, "x.json");
    const y = path.join(tmp, "y.json");
    fs.symlinkSync(y, x);
    fs.symlinkSync(x, y);
    const walked = walkLinkChain(x);
    expect(walked.end).toBe("loop");
    expect(walked.chain).toHaveLength(41);
    expect(new Set(walked.chain)).toEqual(new Set([x, y]));
  });

  it("ends unreadable when a directory on the way is a file", () => {
    const file = path.join(tmp, "plain");
    fs.writeFileSync(file, "x");
    expect(walkLinkChain(path.join(file, "settings.json"))).toEqual({
      chain: [path.join(file, "settings.json")],
      end: "unreadable",
    });
  });

  it("treats a trailing separator as requiring a directory: a same-named file ends unreadable", () => {
    const file = path.join(tmp, "plain");
    fs.writeFileSync(file, "x");
    const link = path.join(tmp, "slash.json");
    fs.symlinkSync("plain/", link);
    expect(() => fs.readFileSync(link)).toThrow(/ENOTDIR/);
    // The text as written (separator kept), not the file `basename` would
    // name after dropping it.
    expect(walkLinkChain(link)).toEqual({
      chain: [link, `${file}${path.sep}`],
      end: "unreadable",
    });
  });

  it("walks a trailing separator over a real directory to that directory", () => {
    const dir = path.join(tmp, "d");
    fs.mkdirSync(dir);
    const link = path.join(tmp, "dlink");
    fs.symlinkSync("d/", link);
    expect(walkLinkChain(link)).toEqual({ chain: [link, dir], end: "target" });
  });

  it("lets a trailing separator on a link to a loop end in a loop, not an unreadable end", () => {
    const loopa = path.join(tmp, "loopa");
    const loopb = path.join(tmp, "loopb");
    fs.symlinkSync(path.basename(loopb), loopa);
    fs.symlinkSync(path.basename(loopa), loopb);
    // statting `loopa/` as spelled answers ELOOP; the walker must walk the
    // link instead, so the hop budget ends the chain, as it does unslashed.
    const link = path.join(tmp, "loophop");
    fs.symlinkSync("loopa/", link);
    const walked = walkLinkChain(link);
    expect(walked.end).toBe("loop");
    expect(new Set(walked.chain)).toEqual(new Set([link, loopa, loopb]));
  });

  it("follows a trailing separator on a dangling link to its missing target, as without the slash", () => {
    const missing = path.join(tmp, "gone");
    const dangl = path.join(tmp, "dangl");
    fs.symlinkSync(path.basename(missing), dangl);
    const slashed = path.join(tmp, "dlink-slashed");
    fs.symlinkSync("dangl/", slashed);
    const unslashed = path.join(tmp, "dlink-plain");
    fs.symlinkSync("dangl", unslashed);
    expect(walkLinkChain(slashed)).toEqual({
      chain: [slashed, dangl, missing],
      end: "dangling",
    });
    expect(walkLinkChain(unslashed)).toEqual({
      chain: [unslashed, dangl, missing],
      end: "dangling",
    });
  });
});

describe("walkLinkChain: where a hop leads", () => {
  it("resolves a relative text against the physical directory of the link, not the directory it was reached through", () => {
    const dot = path.join(tmp, "dot");
    fs.mkdirSync(path.join(dot, "real"), { recursive: true });
    fs.mkdirSync(path.join(dot, "x"));
    fs.mkdirSync(path.join(tmp, "home"));
    fs.symlinkSync(path.join(dot, "real"), path.join(tmp, "home", "via"));
    fs.symlinkSync(path.join("..", "x", "gone.json"), path.join(dot, "real", "link.json"));
    const asked = path.join(tmp, "home", "via", "link.json");
    expect(walkLinkChain(asked)).toEqual({ chain: [asked, path.join(dot, "x", "gone.json")], end: "dangling" });
  });

  it("takes a `..` that follows a directory name through that directory's real location", () => {
    const real = path.join(tmp, "elsewhere", "inner");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(tmp, "elsewhere", "out"));
    fs.mkdirSync(path.join(tmp, "base"));
    fs.symlinkSync(real, path.join(tmp, "base", "d"));
    // d is a link to elsewhere/inner, so d/../out is elsewhere/out, not base/out.
    fs.symlinkSync("d/../out/gone.json", path.join(tmp, "base", "link.json"));
    const link = path.join(tmp, "base", "link.json");
    expect(walkLinkChain(link).chain).toEqual([link, path.join(tmp, "elsewhere", "out", "gone.json")]);
  });


  it("follows an absolute text as written", () => {
    const file = path.join(tmp, "f.json");
    fs.writeFileSync(file, "{}\n");
    const link = path.join(tmp, "abs.json");
    fs.symlinkSync(file, link);
    expect(walkLinkChain(link)).toEqual({ chain: [link, file], end: "target" });
  });

  it("linkChain is the hops alone", () => {
    const file = path.join(tmp, "f.json");
    fs.writeFileSync(file, "{}\n");
    const link = path.join(tmp, "abs.json");
    fs.symlinkSync(file, link);
    expect(linkChain(link)).toEqual([link, file]);
  });
});

describe("walkLinkChain: every hop lands on the file the kernel reads through the link", () => {
  // base/d is a link to real/inner, so `d/..` is real, not base. base/f.json is
  // where a lexical reading of `d/..` lands; real/f.json is what the kernel reads.
  let base: string;
  let physical: string;
  let lexical: string;

  beforeEach(() => {
    base = path.join(tmp, "base");
    fs.mkdirSync(path.join(tmp, "real", "inner"), { recursive: true });
    fs.mkdirSync(base);
    fs.symlinkSync(path.join(tmp, "real", "inner"), path.join(base, "d"));
    physical = path.join(tmp, "real", "f.json");
    lexical = path.join(base, "f.json");
    fs.writeFileSync(physical, "physical\n");
    fs.writeFileSync(lexical, "lexical\n");
  });

  /** The link's walk ends at a target whose content is what reading through the link gives. */
  function expectKernelFile(link: string): void {
    expect(fs.readFileSync(link, "utf8")).toBe("physical\n");
    expect(walkLinkChain(link)).toEqual({ chain: [link, physical], end: "target" });
  }

  it("takes `..` in an absolute text through the real location of the directory link before it", () => {
    const link = path.join(tmp, "abs.json");
    fs.symlinkSync(`${base}/d/../f.json`, link);
    expectKernelFile(link);
  });

  it("takes `d/./..` through the real location of d", () => {
    const link = path.join(base, "dot.json");
    fs.symlinkSync("d/./../f.json", link);
    expectKernelFile(link);
  });

  it("takes `d//..` through the real location of d", () => {
    const link = path.join(base, "empty.json");
    fs.symlinkSync("d//../f.json", link);
    expectKernelFile(link);
  });

  it("follows a later hop written with `..` the same way", () => {
    const first = path.join(tmp, "first.json");
    const second = path.join(base, "second.json");
    fs.symlinkSync(second, first);
    fs.symlinkSync("d/../f.json", second);
    expect(fs.readFileSync(first, "utf8")).toBe("physical\n");
    expect(walkLinkChain(first)).toEqual({ chain: [first, second, physical], end: "target" });
  });

  it("ends dangling at the text as written when a directory it passes through does not exist, not at a lexical guess", () => {
    const link = path.join(base, "nodir.json");
    fs.symlinkSync("nodir/../f.json", link);
    expect(() => fs.readFileSync(link)).toThrow(/ENOENT/);
    // A lexical reading would land on base/f.json, which exists.
    expect(walkLinkChain(link)).toEqual({ chain: [link, `${base}/nodir/../f.json`], end: "dangling" });
  });

  it("ends unreadable at the text as written when a name it passes through is a file", () => {
    const link = path.join(base, "notdir.json");
    fs.symlinkSync("f.json/../f.json", link);
    expect(() => fs.readFileSync(link)).toThrow(/ENOTDIR/);
    expect(walkLinkChain(link)).toEqual({ chain: [link, `${base}/f.json/../f.json`], end: "unreadable" });
  });
});
