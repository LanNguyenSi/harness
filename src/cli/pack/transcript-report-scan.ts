// Session-scoped, role-aware transcript scan for the child's own
// Understanding Report: slice 3 of
// docs/decisions/2026-08-27-ug-auto-mode-approval.md ("Report capture
// under `-p`", agent-tasks 37ad0b05).
//
// WHY THIS EXISTS. Under `claude -p` there is no operator to run
// `harness approve understanding`, and the Stop hook fires only at the
// end of the run, so neither channel can supply key two (the child's own
// report) at the instant the first gated tool call is decided. The
// session transcript is the remaining channel, and it LAGS: at the
// PreToolUse instant the report the agent just emitted is not in the
// JSONL yet; it lands tens of milliseconds later (measured, see
// `docs/okf/understanding-gate-auto-mode-signals.md` and
// `dogfood/ug-auto-mode-signals/`). This module is the bounded poll the
// ADR chose over a lone block-and-retry: it waits for the flush itself,
// for at most `auto_approve.report_scan.max_wait`, and then gives up.
//
// FAIL CLOSED. There is no branch here that turns an absent report into
// anything but `found: false`. The caller blocks on that; the timeout is
// a block, never an allow.
//
// WHAT IT WILL NOT DO, AND WHY EACH REFUSAL IS LOAD-BEARING:
//
//   - It opens exactly ONE file, the `transcript_path` the payload names,
//     and never a directory. A directory scan could reach another
//     session's transcript, and (per the ADR's subagent measurement) the
//     separate `agent-<agent_id>.jsonl` a subagent's turns live in.
//   - Only `type: "assistant"` entries count. A report the agent quoted
//     back inside a user message is the PROMPT's text, not the model's
//     own report, and adopting it would let the launcher's prompt supply
//     key two.
//   - Only entries whose own `sessionId` equals the session being decided
//     count. The payload names the file, but a file can hold entries from
//     more than one session id (a resumed / forked transcript), and an
//     entry stamped with a foreign id is not this session's report.
//   - `isSidechain: true` entries are excluded. The measured shape never
//     puts one in the payload's own transcript (subagent turns live in a
//     separate file), so this is defence in depth against a shape the
//     measurement did not produce, not the mechanism the separation
//     relies on.
//   - EACH TRANSCRIPT ENTRY IS ADOPTED AT MOST ONCE PER SESSION: the
//     caller passes the entry ids it has already spent (`adopted`) and
//     this scan returns the newest NON-adopted hit, so one report cannot
//     mint a second marker after the first one expired or a task boundary
//     cleared it. Without that rule the delegation's TTL would silently
//     replace the marker's, which is the lifetime the ADR's two-key
//     design deliberately keeps short.
//
// HOW IT READS. The first poll reads the whole file; every later poll
// reads only the bytes appended since the previous one, carrying a
// partial trailing line over, and keeps the best hit found so far. A
// transcript that SHRANK between polls (truncated or replaced by a
// shorter file), or whose underlying file identity changed (inode/device,
// from `fs.fstatSync`, even when the new file is the same size or LARGER,
// as in a rename swapping in a different file in place), resets the
// reader and it is re-read from the top. Size alone cannot catch the
// second case: a same-size-or-larger replacement passes the size check
// but its bytes at the old offset are not a continuation of anything
// this reader has seen.
//
// The clock and the sleep are injected so the tests drive the poll
// deterministically and never sleep for real.

import * as fs from "node:fs";
import { sha256Hex } from "../../runtime/approval-signing.js";

/**
 * The report heading the scan looks for, anchored to a whole line.
 *
 * ANY heading level, `#` through `######`: the deny text the child is
 * given (`renderReportSchemaHint`) says "any heading level (#, ##, ###)"
 * and shows a `##` example, so a scan that accepted only `#` would refuse
 * exactly the shape its own instruction asked for.
 *
 * Deliberately `[ \t]` rather than `\s` around the words: `\s` matches
 * newlines, so `^#\s*Understanding Report\s*$` under the `m` flag would
 * also match a bare `#` on one line followed by the words on the next,
 * which is not a heading. Case-insensitive on the words themselves (an
 * agent that writes `# UNDERSTANDING REPORT` has still emitted the
 * section the deny text asked for); a trailing `\r` is tolerated for a
 * CRLF-written transcript.
 */
const REPORT_HEADING = /^#{1,6}[ \t]*understanding[ \t]+report[ \t]*\r?$/i;

export interface TranscriptReportScanArgs {
  /** The `transcript_path` from the hook payload. The ONLY file this scan opens. */
  transcriptPath: string;
  /** The session being decided; an entry's own `sessionId` must equal this. */
  sessionId: string;
  /** Bound of the poll, from `auto_approve.report_scan.max_wait`. */
  maxWaitMs: number;
  /** Re-read interval. */
  pollMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Injectable sleep, so tests never wait for real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Entry ids (see {@link TranscriptReportScanResult}'s `entryId`) this
   * session has ALREADY adopted. A hit whose id is in here is skipped as
   * if it were not a report at all, and a transcript that carries nothing
   * else times out with `adoptedOnly: true`. Absent means "nothing
   * adopted yet", the first-call case.
   */
  adopted?: ReadonlySet<string>;
}

export type TranscriptReportScanResult =
  | {
      found: true;
      /** The report markdown, from its heading line to the end of the text block that carried it. */
      markdown: string;
      /** Zero-based index of the JSONL line the report was found on. */
      lineIndex: number;
      /**
       * Stable identity of the adopted entry, for the caller's
       * once-per-session adoption ledger: the entry's own `uuid` when it
       * carries a usable one, otherwise a digest of the adopted markdown
       * and its line index. Never contains a newline, so the caller can
       * store one id per line.
       */
      entryId: string;
      waitedMs: number;
    }
  | {
      found: false;
      /**
       * `timeout`: the bound elapsed with no eligible report (this
       * includes a transcript file that never appeared, since the file
       * may still be created while the poll runs).
       * `unreadable`: the file IS there and could not be read (a
       * permission error, a directory at that path, a symlink loop).
       */
      reason: "timeout" | "unreadable";
      /**
       * Set when the ONLY report(s) in the transcript were entries this
       * session had already adopted. The outcome is the same block, but
       * the caller can say so: the child must emit a FRESH report, not
       * retry against the one it already spent.
       */
      adoptedOnly?: true;
      waitedMs: number;
    };

interface TranscriptEntryLite {
  type?: unknown;
  sessionId?: unknown;
  isSidechain?: unknown;
  uuid?: unknown;
  message?: unknown;
}

/**
 * The text blocks of one entry's `message.content`, in order. A string
 * `content` counts as exactly one text block; in the array shape only
 * `{ type: "text", text: <string> }` blocks contribute, so `tool_use` and
 * `thinking` blocks are ignored (a report the model only ever "thought"
 * is not a report it emitted).
 */
function textBlocksOf(entry: TranscriptEntryLite): string[] {
  const message = entry.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== "text") continue;
    if (typeof b.text !== "string") continue;
    blocks.push(b.text);
  }
  return blocks;
}

/** The report markdown inside one text block, or null when it carries no heading. */
function reportInBlock(block: string): string | null {
  const lines = block.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (REPORT_HEADING.test(lines[i]!)) {
      return lines.slice(i).join("\n");
    }
  }
  return null;
}

interface ReportHit {
  markdown: string;
  lineIndex: number;
  entryId: string;
}

/** Longest `uuid` accepted verbatim as an adoption id; anything longer falls back to the digest. */
const ENTRY_UUID_MAX_LENGTH = 200;

/**
 * Stable identity of one adopted entry. The transcript's own `uuid` is
 * preferred (Claude Code stamps one on every entry, and it survives the
 * file being rewritten or resumed); a value that is missing, empty,
 * over-long, or carries a line break (all of which would corrupt the
 * caller's one-id-per-line ledger) falls back to a digest of the adopted
 * markdown plus its line index. The two forms are namespaced so a crafted
 * `uuid` cannot impersonate a digest id.
 */
function entryIdFor(entry: TranscriptEntryLite, markdown: string, lineIndex: number): string {
  const uuid = entry.uuid;
  if (
    typeof uuid === "string" &&
    uuid.length > 0 &&
    uuid.length <= ENTRY_UUID_MAX_LENGTH &&
    !/[\r\n]/.test(uuid)
  ) {
    return `uuid:${uuid}`;
  }
  return `sha256:${sha256Hex(`${lineIndex}\n${markdown}`)}`;
}

/**
 * The eligible report on ONE JSONL line, or null. Unparseable and blank
 * lines yield null rather than aborting the scan: a transcript being
 * written while it is read can end in a half-flushed line, and refusing
 * the whole file for that would turn a routine race into a block.
 */
function reportHitInLine(line: string, lineIndex: number, sessionId: string): ReportHit | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let entry: TranscriptEntryLite;
  try {
    entry = JSON.parse(trimmed) as TranscriptEntryLite;
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (entry.type !== "assistant") return null;
  if (entry.isSidechain === true) return null;
  if (entry.sessionId !== sessionId) return null;
  const blocks = textBlocksOf(entry);
  for (let b = blocks.length - 1; b >= 0; b -= 1) {
    const markdown = reportInBlock(blocks[b]!);
    if (markdown !== null) {
      return { markdown, lineIndex, entryId: entryIdFor(entry, markdown, lineIndex) };
    }
  }
  return null;
}

const DEFAULT_POLL_MS = 50;
const NEWLINE = 0x0a;
const CLOSING_BRACE = 0x7d;
const EMPTY_ADOPTED: ReadonlySet<string> = new Set<string>();

/**
 * Incremental read state, carried across the polls of ONE scan. The JSONL
 * is append-only, so a later line is a later turn and "newest" is simply
 * "last complete hit seen".
 */
interface ScanState {
  /** Bytes of the transcript already consumed. */
  offset: number;
  /** Bytes after the last newline: a line the writer has not finished yet. */
  carry: Buffer;
  /** Zero-based index of the next COMPLETE line to be consumed. */
  lineIndex: number;
  /**
   * Newest hit on a complete line found so far in the poll that is
   * currently running. Not reset at the top of each poll (unlike
   * `tentative`): it does not need to be, because the caller returns as
   * soon as either field is non-null, so a poll that leaves this set
   * always ends the scan before another poll can run.
   */
  best: ReportHit | null;
  /** Hit on the (still incomplete) trailing line of THIS poll; see `scanCarry`. */
  tentative: ReportHit | null;
  /** At least one hit was skipped because the caller had already adopted it. */
  adoptedSkipped: boolean;
  /**
   * Identity of the file this state was last read from (`fs.fstatSync`'s
   * `ino`/`dev`). `null` until the first successful poll. A later poll
   * whose identity differs resets the reader exactly like a shrink does:
   * size alone would miss an in-place replacement by a same-size-or-larger
   * file.
   */
  ino: number | null;
  dev: number | null;
}

function newScanState(): ScanState {
  return {
    offset: 0,
    carry: Buffer.alloc(0),
    lineIndex: 0,
    best: null,
    tentative: null,
    adoptedSkipped: false,
    ino: null,
    dev: null,
  };
}

/** A hit the caller may still take: skips (and records) an already-adopted one. */
function eligible(
  hit: ReportHit | null,
  adopted: ReadonlySet<string>,
  state: ScanState,
): ReportHit | null {
  if (hit === null) return null;
  if (adopted.has(hit.entryId)) {
    state.adoptedSkipped = true;
    return null;
  }
  return hit;
}

/** Read `length` bytes from `offset`, tolerating a short `readSync`. */
function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/**
 * The trailing, newline-less bytes as a PROVISIONAL hit for this poll
 * only. A writer that has flushed a complete JSONL entry but not yet its
 * newline is the one case the append-only reader would otherwise miss
 * until the next flush, and the whole-file reader this replaced did see
 * it. Only attempted when the carry ends in `}`, which both keeps the
 * cost off every poll's partial line and guarantees the decoded bytes end
 * on a character boundary.
 */
function scanCarry(state: ScanState, sessionId: string, adopted: ReadonlySet<string>): void {
  const carry = state.carry;
  if (carry.length === 0 || carry[carry.length - 1] !== CLOSING_BRACE) return;
  state.tentative = eligible(
    reportHitInLine(carry.toString("utf8"), state.lineIndex, sessionId),
    adopted,
    state,
  );
}

type TranscriptPollOutcome = "ok" | "absent" | "unreadable";

/**
 * Consume everything appended to the transcript since the previous poll,
 * updating `state` in place.
 *
 * ENOENT is "not there YET": under `-p` the hook can fire before the
 * transcript file exists, and it may appear inside the bound. Every other
 * failure, and anything at that path that is not a regular file, means
 * something IS there and cannot be read as a transcript, which is a
 * distinct, immediately-reported condition rather than something waiting
 * will fix.
 */
function pollTranscript(
  transcriptPath: string,
  state: ScanState,
  sessionId: string,
  adopted: ReadonlySet<string>,
): TranscriptPollOutcome {
  // Provisional only for the poll that produced it: a file that vanished
  // (or shrank) between polls must not leave a hit behind.
  state.tentative = null;
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "unreadable";
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return "unreadable";
    // Identity change: the file at this path was replaced (rename, or a
    // recreate) between polls. Checked BEFORE the size comparison and
    // independently of it, because a replacement can be the same size or
    // larger, which the size check alone would read straight through as
    // ordinary growth.
    const identityChanged =
      state.ino !== null && (stat.ino !== state.ino || stat.dev !== state.dev);
    if (identityChanged || stat.size < state.offset) {
      // The file shrank, or was replaced in place: truncated, or a
      // different file now sits at this path. The bytes the offset
      // pointed past are stale (shrink) or belong to a different file
      // entirely (identity change), so start over from the top.
      Object.assign(state, newScanState());
    }
    state.ino = stat.ino;
    state.dev = stat.dev;
    if (stat.size > state.offset) {
      const chunk = readAt(fd, state.offset, stat.size - state.offset);
      state.offset += chunk.length;
      const data = state.carry.length > 0 ? Buffer.concat([state.carry, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const nl = data.indexOf(NEWLINE, start);
        if (nl === -1) break;
        const hit = eligible(
          reportHitInLine(data.subarray(start, nl).toString("utf8"), state.lineIndex, sessionId),
          adopted,
          state,
        );
        if (hit !== null) state.best = hit;
        state.lineIndex += 1;
        start = nl + 1;
      }
      state.carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
    scanCarry(state, sessionId, adopted);
    return "ok";
  } catch {
    return "unreadable";
  } finally {
    fs.closeSync(fd);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll the payload's own transcript for this session's Understanding
 * Report until it appears or `maxWaitMs` elapses. See the module header
 * for the filters and why each one is there.
 *
 * The poll timer is deliberately NOT `unref`'d. A hook process whose
 * stdin has been drained has no other ref'd handle, so an unref'd timer
 * lets Node exit mid-poll: the process would end with an empty stdout,
 * which Claude Code reads as ALLOW: a silent fail-open on precisely the
 * delegation path this scan exists for. The loop is bounded twice over
 * (`maxWaitMs`, itself capped by the config's 5 s ceiling, and the
 * `maxPolls` count below), so it can never hold the process open beyond
 * the bound.
 */
export async function scanTranscriptForReport(
  args: TranscriptReportScanArgs,
): Promise<TranscriptReportScanResult> {
  const now = args.now ?? ((): number => Date.now());
  const sleep = args.sleep ?? defaultSleep;
  const pollMs = args.pollMs !== undefined && args.pollMs > 0 ? args.pollMs : DEFAULT_POLL_MS;
  const maxWaitMs = Number.isFinite(args.maxWaitMs) && args.maxWaitMs > 0 ? args.maxWaitMs : 0;
  const adopted = args.adopted ?? EMPTY_ADOPTED;
  const start = now();
  // Belt and braces against a clock that does not advance (an injected
  // one that forgets to, a suspended VM): the poll count is bounded on
  // its own, so this can never become an unbounded loop inside a hook.
  // Generous enough that it never pre-empts the real time bound.
  const maxPolls = Math.ceil(maxWaitMs / pollMs) + 2;
  const state = newScanState();

  for (let poll = 0; ; poll += 1) {
    const outcome = pollTranscript(args.transcriptPath, state, args.sessionId, adopted);
    if (outcome === "unreadable") {
      return { found: false, reason: "unreadable", waitedMs: now() - start };
    }
    // The provisional trailing-line hit is newer than any complete one.
    const hit = state.tentative ?? state.best;
    if (hit !== null) {
      return {
        found: true,
        markdown: hit.markdown,
        lineIndex: hit.lineIndex,
        entryId: hit.entryId,
        waitedMs: now() - start,
      };
    }
    const elapsed = now() - start;
    if (elapsed >= maxWaitMs || poll >= maxPolls) {
      return {
        found: false,
        reason: "timeout",
        ...(state.adoptedSkipped ? { adoptedOnly: true as const } : {}),
        waitedMs: elapsed,
      };
    }
    await sleep(pollMs);
  }
}
