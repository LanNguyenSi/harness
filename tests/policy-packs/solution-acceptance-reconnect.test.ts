import { describe, expect, it } from "vitest";
import {
  RECONNECT_FACT_JOIN_NOT_RETRY,
  RECONNECT_FACT_POLL_AND_RETENTION,
  RECONNECT_FACT_RECONNECT_BY_ID,
  RECONNECT_RETENTION_FLOOR,
  RECONNECT_TASK_ID_PLACEHOLDER,
  RECONNECT_VERSION_QUALIFIER,
  renderReconnectDenyParagraph,
  renderReconnectInstructionsSection,
} from "../../src/policy-packs/builtin/solution-acceptance-reconnect.js";
import { resolve } from "../../src/policy-packs/builtin/solution-acceptance.js";
import type { PolicyPack } from "../../src/schema/index.js";

function pack(config: Record<string, unknown> = {}): PolicyPack {
  return {
    name: "solution-acceptance",
    source: "builtin",
    enabled: true,
    config,
  } as PolicyPack;
}

function instructionsContent(): string {
  const { contribution } = resolve(pack(), "claude-code");
  const file = contribution.files.find((f) =>
    f.relativePath.endsWith("policy-packs/solution-acceptance/instructions.md"),
  );
  return file!.content;
}

// Parity: the completion-gate deny paragraph (hook-solution-acceptance.ts,
// blockJson) and the pack's instructions.md "Reconnecting vs. retrying"
// section (buildInstructions, solution-acceptance.ts) both render from
// `solution-acceptance-reconnect.ts`. This is the redesign for the
// recurring review class (rounds 1-2): hand-written deny text asserting
// producer semantics that drift from instructions.md and the source. A
// future edit to one surface that forgets the other now fails HERE
// instead of shipping a silent drift, because every assertion below reads
// the SAME exported fact constants both renderers consume.
describe("solution-acceptance-reconnect: shared fact source (parity)", () => {
  it("every fact sentence rendered into the deny paragraph also appears verbatim in instructions.md", () => {
    const deny = renderReconnectDenyParagraph("task-parity-1");
    const instructions = instructionsContent();
    for (const fact of [
      RECONNECT_FACT_RECONNECT_BY_ID,
      RECONNECT_FACT_JOIN_NOT_RETRY,
      RECONNECT_FACT_POLL_AND_RETENTION,
    ]) {
      expect(deny).toContain(fact);
      expect(instructions).toContain(fact);
    }
  });

  it("both surfaces carry the producer-version qualifier, not an unconditional claim", () => {
    const deny = renderReconnectDenyParagraph("task-parity-2");
    const instructions = instructionsContent();
    expect(deny).toContain(RECONNECT_VERSION_QUALIFIER);
    expect(instructions).toContain(RECONNECT_VERSION_QUALIFIER);
    expect(RECONNECT_VERSION_QUALIFIER).toBe("With grounding-mcp >= 0.11.0:");
  });

  it("resolves the explicit verdict-id placeholder in the deny surface", () => {
    const deny = renderReconnectDenyParagraph("task-resolved-42");
    expect(deny).toContain('`solution_evaluate` was never called for "task-resolved-42"');
    expect(deny).not.toContain(RECONNECT_TASK_ID_PLACEHOLDER);
  });

  // The paragraph is now
  // appended ONLY for the live-attempt reading (`reconnectGuidanceFor` in
  // hook-solution-acceptance.ts), so it must say the hook READ the anchor
  // and detected that reading, not that the hook "does not read" it and
  // "cannot rule any of these three apart" (both were true of the OLD,
  // pre-799de976 behavior, false once the caller only appends this text
  // for reading (2)). A literal-string pin, independent of whatever the
  // renderer currently outputs, so a regression back to the old wording is
  // caught here rather than passing by construction against itself.
  it("says the hook READ the anchor and detected reading (2), not that it cannot rule the readings apart", () => {
    const deny = renderReconnectDenyParagraph("task-corrected-1");
    expect(deny).toContain(
      "this hook read the documented attempt-lock anchor and is showing you this paragraph",
    );
    expect(deny).toMatch(/detected reading \(2\): an attempt is still live/);
    expect(deny).not.toContain("this hook does not read the documented attempt-lock anchor");
    expect(deny).not.toMatch(/cannot rule any of/);
    expect(deny).not.toMatch(/message fires whether/);
  });

  it("keeps shared tool and attempt identifiers in code formatting", () => {
    expect(RECONNECT_FACT_RECONNECT_BY_ID).toContain("`id`");
    expect(RECONNECT_FACT_RECONNECT_BY_ID).toContain("`attemptId`");
    expect(RECONNECT_FACT_JOIN_NOT_RETRY).toContain("`solution_evaluate`");
    expect(RECONNECT_FACT_JOIN_NOT_RETRY).toContain("`forceNewAttempt`");
    expect(RECONNECT_FACT_POLL_AND_RETENTION).toContain("`pollAfterMs`");
  });

  it("renders the retention-floor phrase with pollAfterMs exactly once on both surfaces", () => {
    for (const surface of [
      renderReconnectDenyParagraph("task-retention-1"),
      renderReconnectInstructionsSection(),
    ]) {
      const retentionFloorLine = surface.split("\n").find((line) =>
        line.includes(RECONNECT_RETENTION_FLOOR),
      );
      expect(retentionFloorLine).toBeDefined();
      expect(retentionFloorLine!.match(/pollAfterMs/g)).toHaveLength(1);
    }
  });

  it("keeps the renderer-owned Never re-call lead-in and readable rendered lines", () => {
    const deny = renderReconnectDenyParagraph("task-lines-1");
    const instructions = renderReconnectInstructionsSection();
    expect(deny).toContain(`Never re-call \`solution_evaluate\`:\n${RECONNECT_FACT_JOIN_NOT_RETRY}.`);
    expect(instructions).toContain(
      `Never re-call \`solution_evaluate\` as a stall workaround:\n${RECONNECT_FACT_JOIN_NOT_RETRY}.`,
    );
    for (const line of [...deny.split("\n"), ...instructions.split("\n")]) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("instructions.md still teaches the never-re-call-as-a-stall-workaround framing (audit-copy wording)", () => {
    // The audit copy's own wording may differ from the deny paragraph's
    // (task instruction: "its wording may change only where the shared
    // source now renders it"), but the pre-existing pinned phrase in
    // solution-acceptance-expand.test.ts must survive the redesign.
    const instructions = instructionsContent();
    expect(instructions).toMatch(/Never re-call .solution_evaluate. as a stall workaround/);
  });

  it("renderReconnectInstructionsSection output matches what buildInstructions actually emits", () => {
    // Guards against the section being duplicated by hand again instead
    // of delegated to the shared renderer.
    const instructions = instructionsContent();
    expect(instructions).toContain(renderReconnectInstructionsSection().trimEnd());
  });
});
