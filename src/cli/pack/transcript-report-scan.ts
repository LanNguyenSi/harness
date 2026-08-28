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
//
// The clock and the sleep are injected so the tests drive the poll
// deterministically and never sleep for real.

import * as fs from "node:fs";

/**
 * The report heading the scan looks for, anchored to a whole line.
 *
 * Deliberately `[ \t]` rather than `\s` around the words: `\s` matches
 * newlines, so `^#\s*Understanding Report\s*$` under the `m` flag would
 * also match a bare `#` on one line followed by the words on the next,
 * which is not a heading. Case-insensitive on the words themselves (an
 * agent that writes `# UNDERSTANDING REPORT` has still emitted the
 * section the deny text asked for); a trailing `\r` is tolerated for a
 * CRLF-written transcript.
 */
const REPORT_HEADING = /^#[ \t]*understanding[ \t]+report[ \t]*\r?$/i;

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
}

export type TranscriptReportScanResult =
  | {
      found: true;
      /** The report markdown, from its heading line to the end of the text block that carried it. */
      markdown: string;
      /** Zero-based index of the JSONL line the report was found on. */
      lineIndex: number;
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
      waitedMs: number;
    };

type TranscriptRead =
  | { kind: "ok"; content: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

function readTranscript(transcriptPath: string): TranscriptRead {
  try {
    return { kind: "ok", content: fs.readFileSync(transcriptPath, "utf8") };
  } catch (err) {
    // ENOENT is "not there YET": under `-p` the hook can fire before the
    // transcript file exists, and it may appear inside the bound. Every
    // other errno means a file (or something) IS at that path and cannot
    // be read, which is a distinct, immediately-reported condition rather
    // than something waiting will fix.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
}

interface TranscriptEntryLite {
  type?: unknown;
  sessionId?: unknown;
  isSidechain?: unknown;
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
}

/**
 * The NEWEST eligible report in a transcript's raw text, or null.
 * "Newest" is last-line-wins: the JSONL is append-only, so a later line
 * is a later turn. Unparseable and blank lines are skipped rather than
 * aborting the scan; a transcript being written while it is read can end
 * in a half-flushed line, and refusing the whole file for that would turn
 * a routine race into a block.
 */
export function findNewestReportInTranscript(
  content: string,
  sessionId: string,
): ReportHit | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let entry: TranscriptEntryLite;
    try {
      entry = JSON.parse(line) as TranscriptEntryLite;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.type !== "assistant") continue;
    if (entry.isSidechain === true) continue;
    if (entry.sessionId !== sessionId) continue;
    const blocks = textBlocksOf(entry);
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const markdown = reportInBlock(blocks[b]!);
      if (markdown !== null) return { markdown, lineIndex: i };
    }
  }
  return null;
}

const DEFAULT_POLL_MS = 50;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep a hook process alive on the poll timer alone.
    timer.unref?.();
  });
}

/**
 * Poll the payload's own transcript for this session's Understanding
 * Report until it appears or `maxWaitMs` elapses. See the module header
 * for the filters and why each one is there.
 */
export async function scanTranscriptForReport(
  args: TranscriptReportScanArgs,
): Promise<TranscriptReportScanResult> {
  const now = args.now ?? ((): number => Date.now());
  const sleep = args.sleep ?? defaultSleep;
  const pollMs = args.pollMs !== undefined && args.pollMs > 0 ? args.pollMs : DEFAULT_POLL_MS;
  const maxWaitMs = Number.isFinite(args.maxWaitMs) && args.maxWaitMs > 0 ? args.maxWaitMs : 0;
  const start = now();
  // Belt and braces against a clock that does not advance (an injected
  // one that forgets to, a suspended VM): the poll count is bounded on
  // its own, so this can never become an unbounded loop inside a hook.
  // Generous enough that it never pre-empts the real time bound.
  const maxPolls = Math.ceil(maxWaitMs / pollMs) + 2;

  for (let poll = 0; ; poll += 1) {
    const read = readTranscript(args.transcriptPath);
    if (read.kind === "unreadable") {
      return { found: false, reason: "unreadable", waitedMs: now() - start };
    }
    if (read.kind === "ok") {
      const hit = findNewestReportInTranscript(read.content, args.sessionId);
      if (hit !== null) {
        return {
          found: true,
          markdown: hit.markdown,
          lineIndex: hit.lineIndex,
          waitedMs: now() - start,
        };
      }
    }
    const elapsed = now() - start;
    if (elapsed >= maxWaitMs || poll >= maxPolls) {
      return { found: false, reason: "timeout", waitedMs: elapsed };
    }
    await sleep(pollMs);
  }
}
