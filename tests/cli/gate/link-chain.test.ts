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

  it("falls back to the lexical reading when the directory a climbing text enters does not exist", () => {
    fs.mkdirSync(path.join(tmp, "base"));
    fs.symlinkSync("nodir/../gone.json", path.join(tmp, "base", "link.json"));
    const link = path.join(tmp, "base", "link.json");
    expect(walkLinkChain(link).chain).toEqual([link, path.join(tmp, "base", "gone.json")]);
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
