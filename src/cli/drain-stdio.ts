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
      // as allow. The listener goes on before the empty write below and, as
      // drainStdio calls this synchronously, before any earlier write's error
      // is emitted on a later tick. A failed stream has nothing left to wait
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
