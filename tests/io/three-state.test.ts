import { describe, expect, it } from "vitest";
import { compare } from "../../src/io/three-state.js";

describe("three-state compare()", () => {
  // The four cells from ARCHITECTURE.md §7's decision table.

  it("returns safe-overwrite when there is no last-apply and no on-disk file", () => {
    expect(
      compare({
        manifestExpected: "next\n",
        lastApplied: null,
        onDiskCurrent: null,
      }),
    ).toBe("safe-overwrite");
  });

  it("returns drift-refuse when on-disk exists but last-apply does not (first-run with pre-existing file)", () => {
    expect(
      compare({
        manifestExpected: "next\n",
        lastApplied: null,
        onDiskCurrent: "hand-written\n",
      }),
    ).toBe("drift-refuse");
  });

  it("returns no-drift when last-apply matches on-disk (clean overwrite is safe)", () => {
    expect(
      compare({
        manifestExpected: "next\n",
        lastApplied: "previous\n",
        onDiskCurrent: "previous\n",
      }),
    ).toBe("no-drift");
  });

  it("returns drift-refuse when on-disk has been hand-edited away from last-apply", () => {
    expect(
      compare({
        manifestExpected: "next\n",
        lastApplied: "previous\n",
        onDiskCurrent: "hand-edited\n",
      }),
    ).toBe("drift-refuse");
  });

  it("returns drift-refuse when last-apply exists but on-disk file is gone", () => {
    expect(
      compare({
        manifestExpected: "next\n",
        lastApplied: "previous\n",
        onDiskCurrent: null,
      }),
    ).toBe("drift-refuse");
  });

  it("returns no-drift when manifestExpected is identical to last-applied + on-disk (idempotent re-apply)", () => {
    // Idempotent: nothing changed across the board.
    expect(
      compare({
        manifestExpected: "same\n",
        lastApplied: "same\n",
        onDiskCurrent: "same\n",
      }),
    ).toBe("no-drift");
  });
});
