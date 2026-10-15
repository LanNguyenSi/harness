// The shared idle-bounded stdin reader (task c8cfc110). Every hook-style CLI
// entry that parses an event JSON from stdin used to await `end` with no
// bound, so an open, never-closed stdin hung the process. The reader's own
// behaviour is pinned here in-process; the pack hooks pin their stdin-timeout
// refusal in tests/cli/pack-hook-stdin-bound.test.ts.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { readStdinBounded, STDIN_IDLE_TIMEOUT_MS, stdinTimeoutNote } from "../../src/cli/bounded-stdin.js";

describe("bounded stdin: reader behaviour", () => {
  it("a slow but live pipe is not cut off: each chunk restarts the idle bound", async () => {
    const stream = new PassThrough();
    const read = readStdinBounded(stream, 400);
    stream.write("ab");
    await new Promise((r) => setTimeout(r, 250));
    stream.write("cd");
    await new Promise((r) => setTimeout(r, 250));
    stream.end("ef");
    expect(await read).toEqual({ text: "abcdef", timedOut: false });
  });

  it("an idle stream resolves with what was read and timedOut set", async () => {
    const stream = new PassThrough();
    stream.write("partial");
    expect(await readStdinBounded(stream, 100)).toEqual({ text: "partial", timedOut: true });
    expect(stream.isPaused()).toBe(true);
    expect(() => stream.emit("error", new Error("late"))).not.toThrow();
  });

  it("the empty-read note keeps the preflight text by default and takes a caller tail", () => {
    const empty = { text: "", timedOut: true };
    expect(stdinTimeoutNote(empty, 3000)).toBe(
      "no complete event JSON on stdin within 3000 ms (stdin never closed); " +
        "falling back to the default session resolution",
    );
    expect(stdinTimeoutNote(empty, 3000, "continuing as an empty event")).toBe(
      "no complete event JSON on stdin within 3000 ms (stdin never closed); continuing as an empty event",
    );
    expect(stdinTimeoutNote({ text: "abc", timedOut: true }, 3000, "ignored tail")).toBe(
      "stdin did not close within 3000 ms of the last data; using the 3 bytes read",
    );
  });

  it("the default bound is the one the preflight path has always used", () => {
    expect(STDIN_IDLE_TIMEOUT_MS).toBe(3000);
  });
});
