import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { drainStdio, tolerateClosedStdio } from "../../src/cli/drain-stdio.js";

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

  it("settles on an error event even when the write callback never fires, and keeps swallowing later ones", async () => {
    // A stream whose reader has gone: the error is emitted on a later tick
    // (here one pending from an earlier write, one from the drain's own
    // write) and the callback is never called. Without a listener, EventEmitter
    // throws on an 'error' event; the throw is collected so a missing listener
    // shows as a result, not as an uncaught exception.
    const thrown: unknown[] = [];
    const emitter = new EventEmitter();
    const emitError = (): void => {
      try {
        emitter.emit("error", new Error("write EPIPE"));
      } catch (err) {
        thrown.push(err);
      }
    };
    const gone = Object.assign(emitter, {
      destroyed: false,
      writable: true,
      write(): boolean {
        setImmediate(emitError);
        return false;
      },
    });
    process.nextTick(emitError);
    const started = Date.now();
    await drainStdio(3000, [gone as never]);
    expect(Date.now() - started).toBeLessThan(1500);
    emitError();
    expect(thrown).toEqual([]);
  });

  it("drains every stream, not only the first", async () => {
    const first = fakeStream(0);
    const second = fakeStream(null);
    const started = Date.now();
    await drainStdio(200, [first as never, second as never]);
    // The second stream never completes, so the wait runs to the bound.
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(first.writes).toEqual([""]);
    expect(second.writes).toEqual([""]);
  });
});

describe("tolerateClosedStdio", () => {
  it("lets a stream error that no one else listens for pass without throwing", () => {
    const stream = new PassThrough();
    expect(stream.listenerCount("error")).toBe(0);
    tolerateClosedStdio([stream]);
    expect(() => stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });

  it("adds one listener per stream however often it is called", () => {
    const stream = new PassThrough();
    tolerateClosedStdio([stream]);
    tolerateClosedStdio([stream]);
    expect(stream.listenerCount("error")).toBe(1);
  });

  it("skips a stream without an on() method", () => {
    expect(() => tolerateClosedStdio([{} as never])).not.toThrow();
  });
});
