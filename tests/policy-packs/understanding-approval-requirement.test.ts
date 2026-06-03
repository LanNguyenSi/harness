import { describe, expect, it } from "vitest";
import { understandingApprovalRequirement } from "../../src/policy-packs/builtin/understanding-before-execution.js";

// The `required:` phrase in the understanding-gate deny envelope is mode-
// derived: only `strict` forces requiresHumanApproval, so it is the only
// mode whose wording may claim "human-approved". fast_confirm and grill_me
// self-attest (a structural validator checks the report), so the generic
// "approved" is the accurate phrase there.
describe("understandingApprovalRequirement", () => {
  it("names human approval only in strict mode (the only mode that forces it)", () => {
    expect(understandingApprovalRequirement("strict")).toBe(
      "a human-approved Understanding Report for this session",
    );
  });

  it("stays generic for the self-approving modes", () => {
    expect(understandingApprovalRequirement("fast_confirm")).toBe(
      "an approved Understanding Report for this session",
    );
    expect(understandingApprovalRequirement("grill_me")).toBe(
      "an approved Understanding Report for this session",
    );
  });
});
