import { describe, expect, it } from "vitest";
import { parseLedgerTimestamp } from "../../src/policies/timestamp.js";

// Phase 5 #8 regression coverage. The ground truth for SQLite-stored
// ledger timestamps is UTC; the parser must return the same epoch
// regardless of the host TZ. Tests don't override `process.env.TZ`
// because vitest already runs UTC by default — we instead pin against
// known UTC moments.

describe("parseLedgerTimestamp", () => {
  it("treats SQLite DATETIME (`YYYY-MM-DD HH:MM:SS`) as UTC", () => {
    const ms = parseLedgerTimestamp("2026-05-01 08:33:24");
    expect(ms).toBe(Date.UTC(2026, 4, 1, 8, 33, 24));
  });

  it("matches an explicit Z-suffixed ISO for the same instant", () => {
    const sql = parseLedgerTimestamp("2026-05-01 08:33:24");
    const iso = parseLedgerTimestamp("2026-05-01T08:33:24Z");
    expect(sql).toBe(iso);
  });

  it("preserves millisecond precision when present", () => {
    const ms = parseLedgerTimestamp("2026-05-01 08:33:24.789");
    expect(ms).toBe(Date.UTC(2026, 4, 1, 8, 33, 24, 789));
  });

  it("treats T-separated ISO without a zone as UTC", () => {
    const naive = parseLedgerTimestamp("2026-05-01T08:33:24");
    expect(naive).toBe(Date.UTC(2026, 4, 1, 8, 33, 24));
  });

  it("passes through already-zoned ISO timestamps unchanged", () => {
    const z = parseLedgerTimestamp("2026-05-01T08:33:24Z");
    const offset = parseLedgerTimestamp("2026-05-01T10:33:24+02:00");
    expect(z).toBe(offset);
  });

  it("returns NaN for empty / non-string / unparseable input", () => {
    expect(parseLedgerTimestamp("")).toBeNaN();
    expect(parseLedgerTimestamp("not a timestamp")).toBeNaN();
    // @ts-expect-error — exercising the runtime guard
    expect(parseLedgerTimestamp(undefined)).toBeNaN();
  });

  it("survives a non-UTC test TZ when one is forced", () => {
    // On Linux/glibc, mid-run `process.env.TZ` mutation flips
    // `Date.parse`'s interpretation of naive timestamps via tzset(),
    // so without `parseLedgerTimestamp`'s normalisation a UTC-only CI
    // would still let the bug survive an ill-considered code change.
    // This test exercises that path and is the actual backstop for
    // Phase 5 #8 on UTC CI hosts — do NOT delete as a no-op.
    const before = parseLedgerTimestamp("2026-05-01 08:33:24");
    const previousTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const after = parseLedgerTimestamp("2026-05-01 08:33:24");
      expect(after).toBe(before);
    } finally {
      process.env.TZ = previousTz;
    }
  });
});
