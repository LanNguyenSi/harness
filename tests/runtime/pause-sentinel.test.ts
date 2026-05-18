import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SENTINEL_BASENAME,
  deleteSentinel,
  formatRelative,
  maybeAnnouncePause,
  readSentinel,
  sentinelPath,
  writeSentinel,
  type PauseSentinel,
} from "../../src/runtime/pause-sentinel.js";

let tmp: string;
let stderrLines: string[];
let stderrSink: NodeJS.WritableStream;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pause-sentinel-"));
  stderrLines = [];
  stderrSink = {
    write: (s: string | Uint8Array): boolean => {
      stderrLines.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
      return true;
    },
  } as NodeJS.WritableStream;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fixedSentinel(overrides: Partial<PauseSentinel> = {}): PauseSentinel {
  return {
    pausedAt: "2026-05-18T12:00:00.000Z",
    expiresAt: "2026-05-18T12:15:00.000Z",
    reason: "test",
    pausedBy: "tester@host",
    ...overrides,
  };
}

describe("sentinelPath", () => {
  it("joins the basename onto generatedDir", () => {
    expect(sentinelPath("/x/y")).toBe(path.join("/x/y", SENTINEL_BASENAME));
  });
});

describe("readSentinel", () => {
  it("returns absent when no file exists", () => {
    expect(readSentinel(tmp).kind).toBe("absent");
  });

  it("round-trips a written sentinel as active when not expired", () => {
    writeSentinel(tmp, fixedSentinel());
    const result = readSentinel(tmp, new Date("2026-05-18T12:05:00.000Z"));
    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.sentinel.reason).toBe("test");
    expect(result.sentinel.pausedBy).toBe("tester@host");
  });

  it("returns expired when now is past expiresAt", () => {
    writeSentinel(tmp, fixedSentinel());
    const result = readSentinel(tmp, new Date("2026-05-18T13:00:00.000Z"));
    expect(result.kind).toBe("expired");
  });

  it("treats expiresAt:null (indefinite) as always active", () => {
    writeSentinel(tmp, fixedSentinel({ expiresAt: null }));
    const result = readSentinel(tmp, new Date("2099-01-01T00:00:00.000Z"));
    expect(result.kind).toBe("active");
  });

  it("treats malformed JSON as absent (debug-friendly fail-open)", () => {
    fs.writeFileSync(sentinelPath(tmp), "not json");
    expect(readSentinel(tmp).kind).toBe("absent");
  });

  it("treats a missing pausedAt as absent", () => {
    fs.writeFileSync(sentinelPath(tmp), JSON.stringify({ expiresAt: null }));
    expect(readSentinel(tmp).kind).toBe("absent");
  });

  it("treats an unparseable expiresAt as active (no auto-resume on garbage)", () => {
    fs.writeFileSync(
      sentinelPath(tmp),
      JSON.stringify({ pausedAt: "2026-05-18T12:00:00Z", expiresAt: "tomorrow" }),
    );
    expect(readSentinel(tmp).kind).toBe("active");
  });

  it("rejects a typed-wrong expiresAt as malformed (not downgraded to indefinite)", () => {
    // Without strict typing, an attacker who can write the sentinel could
    // smuggle `expiresAt: 42` and turn it into a no-auto-resume pause. The
    // normalizeSentinel guard rejects the file as malformed, which reads
    // as absent (the gate continues to evaluate normally).
    fs.writeFileSync(
      sentinelPath(tmp),
      JSON.stringify({ pausedAt: "2026-05-18T12:00:00Z", expiresAt: 42 }),
    );
    expect(readSentinel(tmp).kind).toBe("absent");
  });

  it("treats an empty-string expiresAt as malformed", () => {
    fs.writeFileSync(
      sentinelPath(tmp),
      JSON.stringify({ pausedAt: "2026-05-18T12:00:00Z", expiresAt: "" }),
    );
    expect(readSentinel(tmp).kind).toBe("absent");
  });
});

describe("deleteSentinel", () => {
  it("removes the sentinel and reports true", () => {
    writeSentinel(tmp, fixedSentinel());
    expect(deleteSentinel(tmp)).toBe(true);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("returns false when no sentinel existed", () => {
    expect(deleteSentinel(tmp)).toBe(false);
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-05-18T12:00:00.000Z");

  it("formats seconds under 90 as Ns", () => {
    expect(formatRelative("2026-05-18T12:00:30.000Z", now)).toBe("30s");
  });

  it("formats minutes under 90 as Nm", () => {
    expect(formatRelative("2026-05-18T12:30:00.000Z", now)).toBe("30m");
  });

  it("formats hours under 36 as Nh", () => {
    expect(formatRelative("2026-05-19T00:00:00.000Z", now)).toBe("12h");
  });

  it("formats longer offsets as Nd", () => {
    expect(formatRelative("2026-05-25T00:00:00.000Z", now)).toBe("7d");
  });

  it("never returns 0 for near-boundary values", () => {
    expect(formatRelative("2026-05-18T12:00:00.500Z", now)).toBe("1s");
  });
});

describe("maybeAnnouncePause", () => {
  it("returns paused:false on absent sentinel and writes nothing", () => {
    const result = maybeAnnouncePause({ generatedDir: tmp, stderr: stderrSink });
    expect(result.paused).toBe(false);
    expect(stderrLines).toEqual([]);
  });

  it("returns paused:true and emits one stderr line when active", () => {
    writeSentinel(tmp, fixedSentinel());
    const result = maybeAnnouncePause({
      generatedDir: tmp,
      stderr: stderrSink,
      hookLabel: "pre-tool-use",
      now: new Date("2026-05-18T12:05:00.000Z"),
    });
    expect(result.paused).toBe(true);
    expect(stderrLines).toHaveLength(1);
    const notice = stderrLines[0]!;
    expect(notice).toContain("PAUSED");
    expect(notice).toContain("pre-tool-use");
    expect(notice).toContain("reason: test");
    expect(notice).toContain("auto-resumes in");
    expect(notice).toContain("harness resume");
  });

  it("auto-deletes on expired sentinel and returns paused:false", () => {
    writeSentinel(tmp, fixedSentinel());
    const result = maybeAnnouncePause({
      generatedDir: tmp,
      stderr: stderrSink,
      now: new Date("2026-05-18T13:00:00.000Z"),
    });
    expect(result.paused).toBe(false);
    expect(stderrLines).toEqual([]);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("annotates an indefinite pause as no-auto-resume", () => {
    writeSentinel(tmp, fixedSentinel({ expiresAt: null }));
    const result = maybeAnnouncePause({
      generatedDir: tmp,
      stderr: stderrSink,
      now: new Date("2026-05-18T12:05:00.000Z"),
    });
    expect(result.paused).toBe(true);
    expect(stderrLines[0]).toContain("indefinite (no auto-resume)");
  });

  it("substitutes a default reason when none was recorded", () => {
    writeSentinel(tmp, fixedSentinel({ reason: null }));
    maybeAnnouncePause({
      generatedDir: tmp,
      stderr: stderrSink,
      now: new Date("2026-05-18T12:05:00.000Z"),
    });
    expect(stderrLines[0]).toContain("(no reason given)");
  });
});
