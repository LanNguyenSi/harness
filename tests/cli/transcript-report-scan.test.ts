// Unit coverage for the slice-3 transcript scan
// (src/cli/pack/transcript-report-scan.ts, agent-tasks 37ad0b05, ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md "Report capture
// under `-p`").
//
// Every test here drives an INJECTED clock and sleep, so the bounded poll
// is exercised without a single millisecond of real waiting. The fake
// sleep is what advances the clock, which is also what makes the poll
// count observable.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTranscriptForReport } from "../../src/cli/pack/transcript-report-scan.js";

const SESSION = "child-9f2a";

let tmp: string;
let transcriptPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-transcript-scan-"));
  transcriptPath = path.join(tmp, `${SESSION}.jsonl`);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const REPORT_MARKDOWN = ["# Understanding Report", "", "The child understood the task."].join("\n");

/** One transcript entry, in the shape Claude Code writes. */
function entry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    uuid: "uuid-1",
    timestamp: "2026-08-28T09:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: REPORT_MARKDOWN }] },
    ...over,
  });
}

function writeTranscript(lines: string[]): void {
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Every interval the scan asked to sleep for, in order. */
  sleeps: number[];
  /** Side effect to run after the Nth sleep, e.g. "the report lands now". */
  onSleep: ((count: number) => void) | null;
}

/**
 * A clock whose ONLY source of advance is the sleep the scan awaits, so
 * the poll is fully deterministic and no test waits for real time. The
 * recorded `sleeps` are what make the poll COUNT observable.
 */
function fakeClock(): FakeClock {
  let t = 1_000_000;
  const clock: FakeClock = {
    now: (): number => t,
    sleep: (ms: number): Promise<void> => {
      clock.sleeps.push(ms);
      t += ms;
      clock.onSleep?.(clock.sleeps.length);
      return Promise.resolve();
    },
    sleeps: [],
    onSleep: null,
  };
  return clock;
}

describe("scanTranscriptForReport", () => {
  it("finds a report already in the transcript without polling once", async () => {
    writeTranscript([entry()]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 500,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.markdown).toBe(REPORT_MARKDOWN);
    expect(result.lineIndex).toBe(0);
    expect(result.waitedMs).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it("finds a report that appears after N polls, on the injected clock only", async () => {
    writeTranscript([JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "go" } })]);
    const clock = fakeClock();
    // The report lands on the third poll, i.e. after 3 sleeps of 50ms.
    clock.onSleep = (count): void => {
      if (count === 3) {
        writeTranscript([
          JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "go" } }),
          entry(),
        ]);
      }
    };

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 500,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.lineIndex).toBe(1);
    expect(result.waitedMs).toBe(150);
    expect(clock.sleeps).toEqual([50, 50, 50]);
  });

  it("times out fail-closed once the bound elapses, never allowing on absence", async () => {
    writeTranscript([JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "go" } })]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 200,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
    expect(result.waitedMs).toBe(200);
    expect(clock.sleeps).toEqual([50, 50, 50, 50]);
  });

  it("keeps polling a transcript file that does not exist yet and adopts it once it appears", async () => {
    expect(fs.existsSync(transcriptPath)).toBe(false);
    const clock = fakeClock();
    clock.onSleep = (count): void => {
      if (count === 2) writeTranscript([entry()]);
    };

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 500,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.waitedMs).toBe(100);
  });

  it("reports a transcript that never appears as a timeout, not as unreadable", async () => {
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 100,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
  });

  it("reports a path that IS there but cannot be read as unreadable, immediately", async () => {
    // A directory at the transcript path: present, and `readFileSync`
    // fails with EISDIR rather than ENOENT.
    fs.mkdirSync(transcriptPath);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 500,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.reason).toBe("unreadable");
    expect(clock.sleeps).toEqual([]);
  });

  it("skips unparseable lines instead of abandoning the whole transcript", async () => {
    writeTranscript(["{not json at all", "", entry(), '{"half":'] );
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.lineIndex).toBe(2);
  });

  it.each([
    ["a sidechain (subagent) assistant entry", { isSidechain: true }],
    ["a user-role entry", { type: "user" }],
    ["an entry stamped with a foreign sessionId", { sessionId: "some-other-session" }],
    ["an entry carrying no sessionId at all", { sessionId: undefined }],
  ])("does not adopt %s", async (_label, over) => {
    writeTranscript([entry(over)]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
  });

  it("ignores tool_use and thinking blocks, adopting only text blocks", async () => {
    writeTranscript([
      entry({
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: REPORT_MARKDOWN },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: REPORT_MARKDOWN } },
          ],
        },
      }),
    ]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
  });

  it("takes the NEWEST of two matching entries", async () => {
    writeTranscript([
      entry({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "# Understanding Report\n\nthe older one" }],
        },
      }),
      entry({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "# Understanding Report\n\nthe newer one" }],
        },
      }),
    ]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.markdown).toContain("the newer one");
    expect(result.markdown).not.toContain("the older one");
    expect(result.lineIndex).toBe(1);
  });

  it("treats a string `message.content` as one text block", async () => {
    writeTranscript([
      entry({ message: { role: "assistant", content: `prelude\n${REPORT_MARKDOWN}` } }),
    ]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    // From the heading to the end of the block; the prelude is dropped.
    expect(result.markdown).toBe(REPORT_MARKDOWN);
  });

  it.each([
    ["exact heading", "# Understanding Report", true],
    ["uppercase words", "# UNDERSTANDING REPORT", true],
    ["extra spaces after the hash", "#   Understanding Report", true],
    ["trailing spaces", "# Understanding Report   ", true],
    // The deny text the child is given (`renderReportSchemaHint`) says
    // "any heading level (#, ##, ###)" and shows a `##` example, so these
    // are exactly the shapes the gate's own instruction asks for.
    ["a level-two heading", "## Understanding Report", true],
    ["a level-three heading", "### Understanding Report", true],
    ["a level-six heading", "###### Understanding Report", true],
    ["seven hashes, past markdown's deepest heading", "####### Understanding Report", false],
    ["prose mentioning the phrase", "I will write an # Understanding Report later", false],
    ["a heading with trailing prose", "# Understanding Report for the task", false],
    ["the hash on its own line", "#\nUnderstanding Report", false],
  ])("heading regex: %s -> %s", async (_label, heading, expected) => {
    writeTranscript([
      entry({ message: { role: "assistant", content: [{ type: "text", text: `${heading}\n\nbody` }] } }),
    ]);
    const clock = fakeClock();

    const result = await scanTranscriptForReport({
      transcriptPath,
      sessionId: SESSION,
      maxWaitMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.found).toBe(expected);
  });

  // The poll reads INCREMENTALLY: the first poll reads the whole file,
  // every later one only the bytes appended since. These two pin the
  // append case and the one shape that invalidates a carried offset.
  describe("incremental reading", () => {
    it("finds a hit appended to the file after the first poll", async () => {
      writeTranscript([
        JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "go" } }),
      ]);
      const clock = fakeClock();
      // A real append, not a rewrite: only the new bytes are there to read.
      clock.onSleep = (count): void => {
        if (count === 1) fs.appendFileSync(transcriptPath, `${entry()}\n`);
      };

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 500,
        pollMs: 50,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.markdown).toBe(REPORT_MARKDOWN);
      expect(result.lineIndex).toBe(1);
      expect(result.waitedMs).toBe(50);
    });

    it("re-reads from the top when the transcript shrank between polls", async () => {
      // A carried byte offset is only valid while the file grows. Replace
      // a long report-less transcript with a much SHORTER one carrying the
      // report: a reader that kept the stale offset would see a file
      // smaller than what it had already consumed, read nothing, and time
      // out fail-closed on a report that is right there.
      const padded = (n: number): string =>
        JSON.stringify({
          type: "user",
          sessionId: SESSION,
          message: { role: "user", content: `go ${"x".repeat(400)} ${n}` },
        });
      writeTranscript([padded(1), padded(2), padded(3), padded(4), padded(5)]);
      const longSize = fs.statSync(transcriptPath).size;
      const clock = fakeClock();
      clock.onSleep = (count): void => {
        if (count === 1) writeTranscript([entry()]);
      };

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 500,
        pollMs: 50,
        now: clock.now,
        sleep: clock.sleep,
      });

      // The replacement really is shorter, or the test would not
      // discriminate a stale offset at all.
      expect(fs.statSync(transcriptPath).size).toBeLessThan(longSize);
      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.lineIndex).toBe(0);
      expect(result.markdown).toBe(REPORT_MARKDOWN);
    });

    it("re-reads from the top when the transcript is replaced in place by a SAME-SIZE-OR-LARGER file (rename)", async () => {
      // The shrink test above only pins the size-based reset. A rename
      // that swaps in a different file with an EQUAL or LARGER size
      // passes that check untouched, so a reader keyed on size alone
      // would read the replacement's bytes at the stale offset as if
      // they were a continuation of the old file, landing mid-content
      // rather than at the report's actual line. This pins the
      // inode/device identity check that catches that case too.
      const paddedNoReport = (n: number): string =>
        JSON.stringify({
          type: "user",
          sessionId: SESSION,
          message: { role: "user", content: `go ${"x".repeat(400)} ${n}` },
        });
      writeTranscript([paddedNoReport(1)]);
      const originalSize = fs.statSync(transcriptPath).size;
      const clock = fakeClock();
      clock.onSleep = (count): void => {
        if (count === 1) {
          // A DIFFERENT file, written under a different name and then
          // renamed into place, so it carries a different inode: the
          // report sits at line 0, which the stale offset would skip
          // straight past.
          const replacementPath = `${transcriptPath}.new`;
          fs.writeFileSync(
            replacementPath,
            `${[entry(), paddedNoReport(2), paddedNoReport(3)].join("\n")}\n`,
          );
          expect(fs.statSync(replacementPath).size).toBeGreaterThanOrEqual(originalSize);
          fs.renameSync(replacementPath, transcriptPath);
        }
      };

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 500,
        pollMs: 50,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.lineIndex).toBe(0);
      expect(result.markdown).toBe(REPORT_MARKDOWN);
    });
  });

  // `scanCarry` covers the ONE case the append-only, newline-delimited
  // reader would otherwise miss: a writer that has flushed a complete
  // JSONL entry but not yet its trailing newline. Without it, a no-op
  // `scanCarry` still passes the rest of the suite (every other fixture
  // ends its lines with `writeTranscript`'s trailing `\n`), so these two
  // are the only tests that would notice.
  describe("scanCarry (trailing line with no newline yet)", () => {
    it("finds a complete JSON entry with no trailing newline, on the very first poll", async () => {
      // No `writeTranscript` here on purpose: that helper always appends
      // a trailing `\n`. This writes the raw entry with nothing after it.
      fs.writeFileSync(transcriptPath, entry());
      const clock = fakeClock();

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.lineIndex).toBe(0);
      expect(result.entryId).toBe("uuid:uuid-1");
      expect(result.markdown).toBe(REPORT_MARKDOWN);
      expect(clock.sleeps).toEqual([]);
    });

    it("does not find bytes that stop mid-entry, until the line is completed on a later poll", async () => {
      const full = entry();
      // Cut a few characters into the markdown text, well before any of
      // the JSON's closing braces, so the carry does NOT end in `}` and
      // `scanCarry`'s guard declines to even attempt a parse.
      const cutAt = full.indexOf("task.") + 3;
      const partial = full.slice(0, cutAt);
      const rest = full.slice(cutAt);
      expect(partial.endsWith("}")).toBe(false);
      fs.writeFileSync(transcriptPath, partial);
      const clock = fakeClock();
      clock.onSleep = (count): void => {
        if (count === 1) fs.appendFileSync(transcriptPath, `${rest}\n`);
      };

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 500,
        pollMs: 50,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.lineIndex).toBe(0);
      expect(result.markdown).toBe(REPORT_MARKDOWN);
      // The line was completed on the poll right after the first sleep,
      // not found on the very first poll.
      expect(result.waitedMs).toBe(50);
    });
  });

  // One transcript entry may be adopted at most ONCE per session: the
  // caller records what it spent and passes it back, so an expired marker
  // cannot be re-minted from the same report (ADR two-key design; the
  // delegation's TTL must not replace the marker's).
  describe("once-per-session adoption", () => {
    it("names the adopted entry by its uuid so the caller can spend it", async () => {
      writeTranscript([entry()]);
      const clock = fakeClock();

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.entryId).toBe("uuid:uuid-1");
    });

    it("falls back to a content digest when the entry carries no uuid", async () => {
      writeTranscript([entry({ uuid: undefined })]);
      const clock = fakeClock();

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.entryId).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("does not re-adopt an entry the caller has already spent, and says so", async () => {
      writeTranscript([entry()]);
      const clock = fakeClock();

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 100,
        pollMs: 50,
        now: clock.now,
        sleep: clock.sleep,
        adopted: new Set(["uuid:uuid-1"]),
      });

      expect(result.found).toBe(false);
      if (result.found) throw new Error("unreachable");
      expect(result.reason).toBe("timeout");
      // Distinct from a transcript that simply never carried a report:
      // the child must emit a FRESH one, not retry against this entry.
      expect(result.adoptedOnly).toBe(true);
    });

    it("returns the newest NON-adopted hit when the newest one was already spent", async () => {
      writeTranscript([
        entry({
          uuid: "uuid-older",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "# Understanding Report\n\nthe older one" }],
          },
        }),
        entry({
          uuid: "uuid-newer",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "# Understanding Report\n\nthe newer one" }],
          },
        }),
      ]);
      const clock = fakeClock();

      const result = await scanTranscriptForReport({
        transcriptPath,
        sessionId: SESSION,
        maxWaitMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        adopted: new Set(["uuid:uuid-newer"]),
      });

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.entryId).toBe("uuid:uuid-older");
      expect(result.markdown).toContain("the older one");
      expect(result.lineIndex).toBe(0);
    });
  });
});
