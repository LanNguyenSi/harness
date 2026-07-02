import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseConfigUx } from "../../src/cli/pack/hook-bootstrap.js";

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

// The four hook labels that previously each carried their own byte-identical
// parseConfigUx copy (task 19e293c6). These strings pin the stderr warnings
// to the exact pre-extraction output; a label change is an operator-visible
// diagnostic change and must be deliberate.
const HOOK_LABELS = [
  "harness pack hook",
  "harness pack hook codex",
  "harness pack hook branch-protection",
  "harness pack hook solution-acceptance",
] as const;

describe("hook-bootstrap parseConfigUx (shared, task 19e293c6)", () => {
  it("returns undefined without output when ux is absent", () => {
    const { stream, read } = bufferStream();
    expect(parseConfigUx(undefined, stream, "harness pack hook")).toBeUndefined();
    expect(read()).toBe("");
  });

  it("parses a valid ux block", () => {
    const { stream, read } = bufferStream();
    const ux = parseConfigUx(
      { cannot: "You cannot merge yet.", required: ["a review"], run: ["harness approve risk"] },
      stream,
      "harness pack hook",
    );
    expect(ux?.cannot).toBe("You cannot merge yet.");
    expect(read()).toBe("");
  });

  for (const label of HOOK_LABELS) {
    it(`emits the byte-identical pre-extraction warning for "${label}"`, () => {
      const { stream, read } = bufferStream();
      const ux = parseConfigUx({ cannot: 42 }, stream, label);
      expect(ux).toBeUndefined();
      const out = read();
      expect(out.startsWith(`${label}: config.ux ignored (`)).toBe(true);
      expect(out.endsWith(")\n")).toBe(true);
      expect(out).toContain("cannot");
    });
  }
});
