import { describe, expect, it } from "vitest";
import { InvalidDurationError, parseDurationSeconds } from "../../src/io/duration.js";

describe("parseDurationSeconds — shorthand", () => {
  it.each([
    ["60s", 60],
    ["30m", 30 * 60],
    ["24h", 24 * 60 * 60],
    ["7d", 7 * 24 * 60 * 60],
  ])("parses %s", (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });
});

describe("parseDurationSeconds — ISO-8601", () => {
  it.each([
    ["PT1H", 60 * 60],
    ["P1D", 24 * 60 * 60],
    ["PT30M", 30 * 60],
    ["P1DT1H", 25 * 60 * 60],
  ])("parses %s", (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });
});

describe("parseDurationSeconds — rejection", () => {
  it.each(["yesterday", "", "1y", "24", "h24", "P", "PT", "PT0H"])(
    "rejects %s",
    (input) => {
      expect(() => parseDurationSeconds(input)).toThrow(InvalidDurationError);
    },
  );
});
