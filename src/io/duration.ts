const SHORTHAND_RE = /^([0-9]+)(s|m|h|d)$/;
const ISO_RE =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

const SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
} as const;

const ISO_SECONDS = {
  year: 365 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  day: 24 * 60 * 60,
  hour: 60 * 60,
  minute: 60,
  second: 1,
} as const;

export class InvalidDurationError extends Error {
  constructor(public readonly value: string) {
    super(
      `invalid duration "${value}": expected shorthand like "24h" / "30m" / "7d" / "60s" or an ISO-8601 duration like "PT1H" / "P1D"`,
    );
    this.name = "InvalidDurationError";
  }
}

export function parseDurationSeconds(value: string): number {
  const trimmed = value.trim();
  const short = SHORTHAND_RE.exec(trimmed);
  if (short) {
    const n = Number.parseInt(short[1]!, 10);
    const unit = short[2] as keyof typeof SECONDS;
    return n * SECONDS[unit];
  }

  const iso = ISO_RE.exec(trimmed);
  if (iso) {
    const [, y, mo, w, d, h, mi, s] = iso;
    const total =
      (Number(y ?? 0) * ISO_SECONDS.year) +
      (Number(mo ?? 0) * ISO_SECONDS.month) +
      (Number(w ?? 0) * ISO_SECONDS.week) +
      (Number(d ?? 0) * ISO_SECONDS.day) +
      (Number(h ?? 0) * ISO_SECONDS.hour) +
      (Number(mi ?? 0) * ISO_SECONDS.minute) +
      (Number(s ?? 0) * ISO_SECONDS.second);
    if (total === 0) throw new InvalidDurationError(value);
    return total;
  }

  throw new InvalidDurationError(value);
}
