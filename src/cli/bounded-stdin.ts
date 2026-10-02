// One idle-bounded stdin reader shared by every hook-style CLI entry that
// parses an event JSON from stdin (session-start preflight, branch-check,
// stale-base-check, toolchain-parity, policy intercept, and the pack hook
// readers: `readStdin` / `readStdinChecked` in pack/hook-bootstrap.ts and the
// runtime-reality reader in pack/hook-runtime-reality.ts).
//
// A hook pipes the event JSON and closes stdin at once, so a real pipe never
// gets near the bound; it only bites when stdin is an open pipe or a TTY that
// never produces `end` (a backgrounded compound command with no controlling
// terminal), where an end-only read hangs the process forever.

/**
 * Idle bound for the stdin read. The timer restarts on every chunk, so a slow
 * but live pipe is never cut off mid-write; it stays well under the 60 s
 * preflight timeout so the fallback costs little.
 */
export const STDIN_IDLE_TIMEOUT_MS = 3000;

export interface StdinRead {
  text: string;
  /** True when the idle bound fired before `end`. */
  timedOut: boolean;
}

function ignoreLateError(): void {
  // Deliberately empty: the read already resolved, see readStdinBounded.
}

/**
 * Read a stream as UTF-8 text until `end`, or until no chunk has arrived for
 * `idleTimeoutMs`. After a timeout the stream is paused and a no-op error
 * handler stays attached, so a late `error` is not an unhandled event.
 */
export async function readStdinBounded(
  stream: NodeJS.ReadableStream,
  idleTimeoutMs: number = STDIN_IDLE_TIMEOUT_MS,
): Promise<StdinRead> {
  return new Promise((resolve, reject) => {
    let data = "";
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
        // A later 'error' on a stream nobody listens to any more would be an
        // unhandled event and throw, so keep a no-op handler attached.
        stream.on("error", ignoreLateError);
        // Stop reading so a caller that passed a live stream is not left with
        // a flowing one (the CLI itself exits through process.exit regardless).
        stream.pause();
        resolve({ text: data, timedOut: true });
      }, idleTimeoutMs);
    };
    const onData = (chunk: string): void => {
      data += chunk;
      arm();
    };
    const onEnd = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ text: data, timedOut: false });
    };
    const onError = (err: Error): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(err);
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    arm();
  });
}

/** Tail of the empty-read note used by the session-start producers. */
export const DEFAULT_EMPTY_READ_TAIL = "falling back to the default session resolution";

/**
 * The stderr note for a read the idle bound cut off (no trailing newline).
 * `emptyReadTail` says what the caller does when nothing was read; it defaults
 * to the session-start wording, and a caller with a different fallback (the pack
 * hook readers continue as an empty event) passes its own. The partial-data note
 * is the same for every caller.
 */
export function stdinTimeoutNote(
  read: StdinRead,
  idleTimeoutMs: number,
  emptyReadTail: string = DEFAULT_EMPTY_READ_TAIL,
): string {
  return read.text.length === 0
    ? `no complete event JSON on stdin within ${idleTimeoutMs} ms (stdin never closed); ` +
        emptyReadTail
    : `stdin did not close within ${idleTimeoutMs} ms of the last data; ` +
        `using the ${Buffer.byteLength(read.text)} bytes read`;
}
