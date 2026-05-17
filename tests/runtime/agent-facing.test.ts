import { describe, expect, it } from "vitest";
import {
  buildAgentFacingBlock,
  formatAgentFacingMessage,
  renderAgentFacing,
} from "../../src/runtime/agent-facing.js";
import type { PolicyUx } from "../../src/schema/index.js";

describe("buildAgentFacingBlock", () => {
  it("substitutes ${VAR} references against the values map", () => {
    const ux: PolicyUx = {
      cannot: "You cannot push branch ${BRANCH} yet.",
      required: ["a fresh preflight for ${BRANCH}"],
      run: ["harness preflight"],
    };
    const block = buildAgentFacingBlock(ux, { BRANCH: "feat/x" });
    expect(block.cannot).toBe("You cannot push branch feat/x yet.");
    expect(block.required).toEqual(["a fresh preflight for feat/x"]);
    expect(block.run).toEqual(["harness preflight"]);
  });

  it("leaves unresolved ${VAR} literal (best-effort, mirrors renderProducers)", () => {
    const ux: PolicyUx = {
      cannot: "blocked: ${UNKNOWN}",
      required: ["${ALSO_UNKNOWN}"],
      run: ["echo ok"],
    };
    const block = buildAgentFacingBlock(ux, {});
    expect(block.cannot).toBe("blocked: ${UNKNOWN}");
    expect(block.required).toEqual(["${ALSO_UNKNOWN}"]);
  });
});

describe("formatAgentFacingMessage", () => {
  it("produces the verbatim three-section shape from the design", () => {
    const out = formatAgentFacingMessage({
      cannot: "You cannot investigate this repository yet.",
      required: ["verified repository preflight"],
      run: ["harness preflight"],
    });
    expect(out).toBe(
      [
        "You cannot investigate this repository yet.",
        "",
        "Required:",
        "- verified repository preflight",
        "",
        "Run:",
        "  harness preflight",
      ].join("\n"),
    );
  });

  it("renders multiple required + run entries as separate lines", () => {
    const out = formatAgentFacingMessage({
      cannot: "blocked",
      required: ["first thing", "second thing"],
      run: ["cmd-a", "cmd-b"],
    });
    expect(out).toBe(
      [
        "blocked",
        "",
        "Required:",
        "- first thing",
        "- second thing",
        "",
        "Run:",
        "  cmd-a",
        "  cmd-b",
      ].join("\n"),
    );
  });
});

describe("renderAgentFacing", () => {
  it("substitutes and formats in one pass", () => {
    const ux: PolicyUx = {
      cannot: "You cannot merge PR #${PR_NUMBER} yet.",
      required: ["a recorded review of PR #${PR_NUMBER}"],
      run: ["harness review record ${PR_NUMBER}"],
    };
    const out = renderAgentFacing(ux, { PR_NUMBER: "42" });
    expect(out).toBe(
      [
        "You cannot merge PR #42 yet.",
        "",
        "Required:",
        "- a recorded review of PR #42",
        "",
        "Run:",
        "  harness review record 42",
      ].join("\n"),
    );
  });
});
