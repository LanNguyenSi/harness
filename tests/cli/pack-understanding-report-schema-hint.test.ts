import { describe, expect, it } from "vitest";
import {
  UNDERSTANDING_REPORT_REQUIRED_SECTIONS,
  renderReportSchemaHint,
} from "../../src/cli/pack/understanding-report-schema-hint.js";

describe("renderReportSchemaHint", () => {
  it("enumerates all nine sections the @lannguyensi/understanding-gate parser requires", () => {
    expect(UNDERSTANDING_REPORT_REQUIRED_SECTIONS).toHaveLength(9);
    const hint = renderReportSchemaHint();
    for (const section of UNDERSTANDING_REPORT_REQUIRED_SECTIONS) {
      expect(hint).toContain(section);
    }
  });

  it("calls out parsed-by attribution + parse-error consequence so the agent knows why it matters", () => {
    const hint = renderReportSchemaHint();
    expect(hint).toContain("@lannguyensi/understanding-gate");
    expect(hint).toMatch(/parse-error/);
    expect(hint).toContain(".understanding-gate/parse-errors/");
  });

  it("formats bullets one per line so a JSON-stringified gate envelope reads cleanly", () => {
    const hint = renderReportSchemaHint();
    const bulletLines = hint.split("\n").filter((l) => l.startsWith("  - "));
    expect(bulletLines).toHaveLength(9);
  });

  it("preserves the canonical section ordering (matches parser SECTIONS order)", () => {
    // The standalone parser tries aliases in declaration order; keeping
    // the same order in the hint helps an agent who scans top-to-bottom.
    expect(UNDERSTANDING_REPORT_REQUIRED_SECTIONS[0]).toMatch(/^Current Understanding/);
    expect(UNDERSTANDING_REPORT_REQUIRED_SECTIONS[1]).toMatch(/^Intended Outcome/);
    expect(UNDERSTANDING_REPORT_REQUIRED_SECTIONS[8]).toMatch(/^Verification Plan/);
  });
});
