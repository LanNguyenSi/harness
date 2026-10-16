import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { drainStdio } from "../../src/cli/drain-stdio.js";

/** A stream whose write callbacks fire after `delayMs`, or never. */
function fakeStream(delayMs: number | null, extra: { destroyed?: boolean; writable?: boolean } = {}) {
  const writes: string[] = [];
  return {
    writes,
    destroyed: extra.destroyed ?? false,
    writable: extra.writable ?? true,
    write(chunk: string, cb?: (err?: Error | null) => void): boolean {
      writes.push(chunk);
      if (delayMs !== null) setTimeout(() => cb?.(), delayMs);
      return true;
    },
  };
}

describe("drainStdio", () => {
  it("waits for a write callback that arrives before the bound", async () => {
    const slow = fakeStream(80);
    const started = Date.now();
    await drainStdio(2000, [slow as never]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(slow.writes).toEqual([""]);
  });

  it("gives up at the bound when a stream never completes", async () => {
    const stuck = fakeStream(null);
    const started = Date.now();
    await drainStdio(120, [stuck as never]);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(110);
    expect(took).toBeLessThan(1500);
  });

  it("does not wait for a destroyed or closed stream", async () => {
    const gone = fakeStream(null, { destroyed: true });
    const closed = fakeStream(null, { writable: false });
    const started = Date.now();
    await drainStdio(5000, [gone as never, closed as never]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(gone.writes).toEqual([]);
    expect(closed.writes).toEqual([]);
  });

  it("settles when a write throws", async () => {
    const throwing = {
      destroyed: false,
      writable: true,
      write(): boolean {
        throw new Error("EPIPE");
      },
    };
    await expect(drainStdio(5000, [throwing as never])).resolves.toBeUndefined();
  });

  it("completes for a real stream after its queued data was read", async () => {
    const pt = new PassThrough({ highWaterMark: 16 });
    pt.write("x".repeat(64));
    let seen = 0;
    setTimeout(() => {
      pt.on("data", (b: Buffer) => {
        seen += b.length;
      });
    }, 60);
    await drainStdio(3000, [pt as never]);
    expect(seen).toBe(64);
  });
});
