/**
 * How long the process waits for stdout and stderr to accept what is queued
 * before it exits anyway, in ms. A hook runs under a host budget and a hook
 * killed at its budget counts as an allow, so the wait is short and fixed; a
 * reader that is slower than this loses the tail, which is the lesser harm.
 */
export const STDIO_DRAIN_TIMEOUT_MS = 500;

type FlushableStream = Pick<NodeJS.WriteStream, "write" | "destroyed" | "writable"> &
  Partial<Pick<NodeJS.WriteStream, "on">>;

function flushed(stream: FlushableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      // A write to a pipe whose reader has gone fails with EPIPE, and the
      // stream emits that as an 'error' event. With no listener the event is
      // an uncaught exception: the process exits 1, which a hook host reads
      // as allow. The listener goes on before the empty write below, and it
      // also catches an earlier write's error that is emitted after run() has
      // settled. An error emitted while run() is still awaiting I/O (before
      // drainStdio is called) is covered only for a stream that
      // tolerateClosedStdio already got a listener. A failed stream has nothing left to wait
      // for, so the error also settles the flush, whether or not the stream
      // calls the write callback. The exit code is already decided.
      stream.on?.("error", () => resolve());
      if (stream.destroyed || !stream.writable) {
        resolve();
        return;
      }
      // An empty write completes after every earlier write has, or with an
      // error when the reader has gone; either way nothing is left to wait for.
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

const tolerated = new WeakSet<object>();

/**
 * Put a no-op 'error' listener on each stream, once. A write to a pipe whose
 * reader has gone fails with EPIPE, and a stream with no listener turns that
 * event into an uncaught exception: the process exits 1, which a hook host
 * reads as allow. A hook calls this at its entry, before its first write, so
 * an error emitted while the hook is still awaiting (git, a probe) cannot
 * change its exit code; drainStdio only covers errors emitted after the hook
 * has settled. The decision is already made by the time a write fails, so the
 * error carries nothing the caller could act on.
 */
export function tolerateClosedStdio(
  streams: readonly { on?(event: "error", listener: () => void): unknown }[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (typeof stream.on !== "function" || tolerated.has(stream)) continue;
    tolerated.add(stream);
    stream.on("error", () => undefined);
  }
}

/**
 * Resolve once everything written to stdout and stderr so far has been handed
 * to the OS, or after `timeoutMs`. `process.exit` drops writes still queued
 * for a pipe whose reader is behind (macOS cuts at the 64 KiB pipe buffer),
 * so the entry point awaits this before it exits. A stream whose reader has
 * gone (EPIPE) counts as flushed and its error is swallowed, so the exit code
 * is the one the caller passed.
 */
export async function drainStdio(
  timeoutMs: number = STDIO_DRAIN_TIMEOUT_MS,
  streams: readonly FlushableStream[] = [process.stdout, process.stderr],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.all(streams.map(flushed)), limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
