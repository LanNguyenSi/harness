/**
 * How long the process waits for stdout and stderr to accept what is queued
 * before it exits anyway, in ms. A hook runs under a host budget and a hook
 * killed at its budget counts as an allow, so the wait is short and fixed; a
 * reader that is slower than this loses the tail, which is the lesser harm.
 */
export const STDIO_DRAIN_TIMEOUT_MS = 500;

type FlushableStream = Pick<NodeJS.WriteStream, "write" | "destroyed" | "writable">;

function flushed(stream: FlushableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
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
 * so the entry point awaits this before it exits.
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
