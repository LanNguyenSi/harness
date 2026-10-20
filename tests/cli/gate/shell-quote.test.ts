import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../../../src/cli/shell-quote.js";

/** What a POSIX shell makes of `word` when it is written into a command line. */
function shellRead(word: string): string {
  const r = spawnSync("/bin/sh", ["-c", `printf %s ${word}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sh refused ${word}: ${r.stderr}`);
  return r.stdout;
}

describe("shellQuote", () => {
  it("leaves a plain absolute path bare", () => {
    expect(shellQuote("/Users/dev/.codex/config.toml")).toBe("/Users/dev/.codex/config.toml");
    expect(shellQuote("/tmp/a-b_c.d+e@f:g,h/config.toml")).toBe("/tmp/a-b_c.d+e@f:g,h/config.toml");
  });

  it("single-quotes anything outside the plain set and escapes an embedded single quote", () => {
    expect(shellQuote("/tmp/my configs/config.toml")).toBe("'/tmp/my configs/config.toml'");
    expect(shellQuote("/tmp/it's.toml")).toBe(`'/tmp/it'\\''s.toml'`);
    expect(shellQuote("")).toBe("''");
  });

  it("hands the shell back exactly the value, whatever it holds", () => {
    const values = [
      "/tmp/my configs/config.toml",
      "/tmp/it's here/config.toml",
      "/tmp/$HOME/`id`/$(id)/config.toml",
      "/tmp/semi;colon&amp|pipe>out<in/config.toml",
      "/tmp/glob*?[a]/config.toml",
      "/tmp/back\\slash/config.toml",
      '/tmp/"double"/config.toml',
      "/tmp/new\nline/config.toml",
      "~/config.toml",
      "=cmd",
      "-n",
      "",
    ];
    for (const value of values) expect(shellRead(shellQuote(value))).toBe(value);
  });
});
