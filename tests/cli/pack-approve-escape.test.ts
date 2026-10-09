import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPipedStdin } from "../../src/cli/approve/stdin-report.js";

describe("readPipedStdin — completeness signal (review 2026-07-10)", () => {
  function slowStream(chunks: string[], endAfter: boolean): Readable {
    const s = new Readable({ read() {} });
    for (const c of chunks) s.push(c);
    if (endAfter) s.push(null);
    return s;
  }

  it("reports complete:true for a clean EOF", async () => {
    const result = await readPipedStdin(slowStream(["## Understanding Report\n"], true));
    expect(result.complete).toBe(true);
    expect(result.text).toBe("## Understanding Report\n");
  });

  it("reports complete:false when the stream never ends (timeout with partial data)", async () => {
    const result = await readPipedStdin(slowStream(["## Understanding Rep"], false), 1024, 25);
    expect(result.complete).toBe(false);
    expect(result.text).toBe("## Understanding Rep");
  });

  it("reports complete:false when the size cap truncates the input", async () => {
    const result = await readPipedStdin(slowStream(["abcdefghij"], true), 4, 500);
    expect(result.complete).toBe(false);
    expect(result.text).toBe("abcd");
  });

  it("reports complete:false on a stream error", async () => {
    const s = new Readable({ read() {} });
    s.push("partial");
    queueMicrotask(() => s.destroy(new Error("boom")));
    const result = await readPipedStdin(s, 1024, 500);
    expect(result.complete).toBe(false);
  });
});
