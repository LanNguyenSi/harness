import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseUnderstandingReport,
  reportHasContent,
  runPackHookCodexStopCli,
} from "../../src/cli/pack/hook-codex-stop.js";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-codex-stop-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifestWithPack(enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled }],
  });
}

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

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

const FULL_REPORT = [
  "## Interpretation",
  "Refactor the auth middleware to drop session-token storage.",
  "",
  "## Assumptions",
  "- Existing JWT path stays untouched.",
  "- The ops team has already run the prerequisite migration.",
  "",
  "## Open Questions",
  "- Which env vars need rotating after the cutover?",
  "",
  "## Out of Scope",
  "- Frontend client work.",
  "- Audit-log retention changes.",
  "",
  "## Risks",
  "- A logged-in user mid-session could see a 401.",
  "",
  "## Verification Plan",
  "Run the integration suite + manual login round-trip on staging.",
].join("\n");

describe("parseUnderstandingReport", () => {
  it("extracts every field from a markdown-heading-shaped report", () => {
    const r = parseUnderstandingReport(FULL_REPORT);
    expect(r.interpretation).toContain("Refactor the auth middleware");
    expect(r.assumptions).toEqual([
      "Existing JWT path stays untouched.",
      "The ops team has already run the prerequisite migration.",
    ]);
    expect(r.openQuestions).toEqual([
      "Which env vars need rotating after the cutover?",
    ]);
    expect(r.outOfScope).toEqual(["Frontend client work.", "Audit-log retention changes."]);
    expect(r.risks).toEqual(["A logged-in user mid-session could see a 401."]);
    expect(r.verificationPlan).toContain("integration suite");
    expect(reportHasContent(r)).toBe(true);
  });

  it("accepts bold-label and plain-colon variants", () => {
    const text = [
      "**Interpretation:** quick rewrite.",
      "Assumptions:",
      "- A",
      "- B",
      "**Risks**",
      "- low",
    ].join("\n");
    const r = parseUnderstandingReport(text);
    expect(r.interpretation).toBe("quick rewrite.");
    expect(r.assumptions).toEqual(["A", "B"]);
    expect(r.risks).toEqual(["low"]);
  });

  it("returns an empty report when no recognisable fields are present", () => {
    const r = parseUnderstandingReport("just a chatty reply with no labels");
    expect(reportHasContent(r)).toBe(false);
  });

  it("is tolerant of empty / non-string input", () => {
    expect(reportHasContent(parseUnderstandingReport(""))).toBe(false);
    // @ts-expect-error: deliberate misuse
    expect(reportHasContent(parseUnderstandingReport(null))).toBe(false);
  });

  it("handles synonym field names (Questions, Validation, Scope Exclusions)", () => {
    const text = [
      "Interpretation: x",
      "Questions:",
      "- q1",
      "Scope Exclusions:",
      "- ex1",
      "Validation:",
      "run tests",
    ].join("\n");
    const r = parseUnderstandingReport(text);
    expect(r.openQuestions).toEqual(["q1"]);
    expect(r.outOfScope).toEqual(["ex1"]);
    expect(r.verificationPlan).toBe("run tests");
  });

  it("does not falsely match a colon mid-sentence as a section header", () => {
    const text = [
      "## Interpretation",
      "Our interpretation: keep the scope tight.",
      "Risks:",
      "- low",
    ].join("\n");
    const r = parseUnderstandingReport(text);
    // The mid-paragraph "Our interpretation:" is normalized as field
    // "ourinterpretation" which is NOT in the FieldKey set, so the
    // sentence remains part of the scalar paragraph above.
    expect(r.interpretation).toContain("Our interpretation: keep the scope tight.");
    expect(r.risks).toEqual(["low"]);
  });

  it("a duplicate scalar heading silently overwrites the earlier value (v1 contract)", () => {
    const text = [
      "## Interpretation",
      "first take.",
      "## Interpretation",
      "second take.",
    ].join("\n");
    const r = parseUnderstandingReport(text);
    expect(r.interpretation).toBe("second take.");
  });

  it("tolerates CRLF line endings", () => {
    const text = ["## Interpretation", "x", "## Risks", "- y"].join("\r\n");
    const r = parseUnderstandingReport(text);
    expect(r.interpretation).toBe("x");
    expect(r.risks).toEqual(["y"]);
  });

  it("drops non-bullet lines under a list-typed heading (v1 lenient contract)", () => {
    const text = [
      "## Assumptions",
      "Some prose that is not a bullet.",
      "- real bullet.",
    ].join("\n");
    const r = parseUnderstandingReport(text);
    expect(r.assumptions).toEqual(["real bullet."]);
  });
});

describe("runPackHookCodexStopCli", () => {
  it("captures a parseable report from last_assistant_message", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const env = JSON.stringify({
      session_id: "sess-stop-1",
      last_assistant_message: FULL_REPORT,
    });
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(env),
      stderr: stderr.stream,
      reportsDir,
      now: new Date("2026-05-10T17:25:30.000Z"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBe(true);
    expect(result.reportPath).toMatch(/2026-05-10T17-25-30-codex-[a-f0-9]{8}\.json$/);
    expect(stderr.read()).toMatch(/captured Understanding Report/);

    const parsed = JSON.parse(fs.readFileSync(result.reportPath!, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed["sessionId"]).toBe("sess-stop-1");
    expect(parsed["runtime"]).toBe("codex");
    expect(parsed["approvalStatus"]).toBe("pending");
    const report = parsed["report"] as Record<string, unknown>;
    expect(report["interpretation"]).toContain("Refactor");
    expect((report["assumptions"] as string[]).length).toBe(2);
  });

  it("falls back to the last assistant message in the messages[] array", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const env = JSON.stringify({
      session_id: "sess-stop-2",
      messages: [
        { role: "user", content: "do X" },
        { role: "assistant", content: "thinking..." },
        { role: "user", content: "go" },
        { role: "assistant", content: FULL_REPORT },
      ],
    });
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(env),
      stderr: stderr.stream,
      reportsDir,
    });
    expect(result.parsed).toBe(true);
    expect(result.reportPath).not.toBeNull();
  });

  it("skips capture (exit 0) on malformed JSON", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("{not-json"),
      stderr: stderr.stream,
      reportsDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBe(false);
    expect(result.reportPath).toBeNull();
    expect(stderr.read()).toMatch(/malformed JSON/);
    expect(fs.existsSync(reportsDir)).toBe(false);
  });

  it("skips capture when the assistant message has no recognisable Understanding Report fields", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const env = JSON.stringify({
      session_id: "sess-stop-3",
      last_assistant_message: "just a chatty answer, no report",
    });
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(env),
      stderr: stderr.stream,
      reportsDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBe(false);
    expect(stderr.read()).toMatch(/no labelled fields found/);
  });

  it("skips capture when the pack is disabled", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(false),
      stdin: readableFromString(
        JSON.stringify({ session_id: "x", last_assistant_message: FULL_REPORT }),
      ),
      stderr: stderr.stream,
      reportsDir,
    });
    expect(result.parsed).toBe(false);
    expect(stderr.read()).toMatch(/not enabled/);
  });

  it("skips capture when no session_id is resolvable", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ last_assistant_message: FULL_REPORT }),
      ),
      stderr: stderr.stream,
      reportsDir,
    });
    expect(result.parsed).toBe(false);
    expect(stderr.read()).toMatch(/no session_id/);
  });

  it("fails open (exit 0) when stdin emits a stream error", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const errored = new Readable({
      read(): void {
        this.destroy(new Error("synthetic stdin failure"));
      },
    });
    const result = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: errored,
      stderr: stderr.stream,
      reportsDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBe(false);
    expect(result.reportPath).toBeNull();
    expect(stderr.read()).toMatch(/stdin read failed/);
  });

  it("end-to-end: capture then approve flips approvalStatus to approved on the same file", async () => {
    const reportsDir = path.join(tmp, "reports");
    const stderr = bufferStream();
    const sessionId = "sess-stop-roundtrip";
    const env = JSON.stringify({
      session_id: sessionId,
      last_assistant_message: FULL_REPORT,
    });
    const captureResult = await runPackHookCodexStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(env),
      stderr: stderr.stream,
      reportsDir,
    });
    expect(captureResult.parsed).toBe(true);

    const approveResult = await approveUnderstanding({
      manifest: manifestWithPack(),
      session: sessionId,
      reportsDir,
      generatedDir: path.join(tmp, "harness.generated"),
    });
    expect(approveResult.persistedReport.ok).toBe(true);
    expect(approveResult.persistedReport).toMatchObject({
      ok: true,
      filePath: captureResult.reportPath!,
      previousStatus: "pending",
    });

    const after = JSON.parse(
      fs.readFileSync(captureResult.reportPath!, "utf8"),
    ) as Record<string, unknown>;
    expect(after["approvalStatus"]).toBe("approved");
    expect(after["approvedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
