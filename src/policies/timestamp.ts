// Phase 5 #8 — shared ledger-timestamp parser.
//
// `evidence-ledger`'s `created_at` column is populated by SQLite's
// `datetime('now')`, which writes UTC text in `YYYY-MM-DD HH:MM:SS`
// format (no `T`, no trailing `Z`). `Date.parse` of a space-separated
// timestamp without an explicit zone is implementation-defined; modern
// V8 interprets it as local time, so on any non-UTC host the parsed
// epoch lands `(host TZ offset)` hours away from the actual UTC moment.
//
// This helper normalises the input before delegating to `Date.parse` so
// every caller sees a UTC-correct epoch regardless of `TZ`.

/**
 * Normalise a ledger `createdAt` string to an epoch-millis value.
 *
 * Accepted shapes:
 *   - `YYYY-MM-DD HH:MM:SS`            (SQLite `datetime('now')`, UTC)
 *   - `YYYY-MM-DD HH:MM:SS.sss`        (SQLite with subsecond precision)
 *   - `YYYY-MM-DDTHH:MM:SS[.sss]`      (ISO-8601 without zone) — treated as UTC
 *   - `YYYY-MM-DDTHH:MM:SS[.sss]Z`     (already-UTC ISO) — passed through
 *   - `YYYY-MM-DDTHH:MM:SS[.sss]±HH:MM` (zoned ISO) — passed through
 *
 * Returns `NaN` when the input does not match any of these. Callers that
 * want a hard failure should check `Number.isNaN`.
 */
export function parseLedgerTimestamp(raw: string): number {
  if (typeof raw !== "string" || raw.length === 0) return NaN;
  // Already-zoned (ends with Z or ±HH:MM after the time portion).
  if (/[Zz]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(raw);
  }
  // Space-separated SQL DATETIME → coerce to ISO-with-Z.
  const iso = raw.includes("T") ? `${raw}Z` : `${raw.replace(" ", "T")}Z`;
  return Date.parse(iso);
}
