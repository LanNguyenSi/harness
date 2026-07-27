// Focused unit coverage for the parse-error log payload built by
// `persistStdinReport` (src/cli/approve/stdin-report.ts). The wider
// approve-understanding.test.ts covers the parse-error path end to end
// (log location, sessionId attribution, `findLatestParseError` pickup);
// this file pins the `malformedSections` field specifically — task
// 7e29e5d7, follow-up to agent-grounding PR #154 / be98cd96.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: keep the real `parseReport` as the default (so the
// "field absent" test below exercises the actual pinned 0.4.x parser),
// but wrap it in `vi.fn` so a single test can override its return value
// to simulate a future understanding-gate version that DOES emit
// `malformedSections` on ParseError.
vi.mock("@lannguyensi/understanding-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lannguyensi/understanding-gate")>();
  return { ...actual, parseReport: vi.fn(actual.parseReport) };
});

import { parseReport } from "@lannguyensi/understanding-gate";
import { persistStdinReport } from "../../src/cli/approve/stdin-report.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stdin-report-"));
  vi.mocked(parseReport).mockClear();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function reportsDirIn(root: string): string {
  const dir = path.join(root, ".understanding-gate", "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readLogHeader(logPath: string): Record<string, unknown> {
  const log = fs.readFileSync(logPath, "utf8");
  const [header] = log.split("\n\n--- raw ---\n");
  return JSON.parse(header ?? "{}") as Record<string, unknown>;
}

describe("persistStdinReport — malformedSections in the parse-error log payload", () => {
  it("defaults malformedSections to [] when the pinned understanding-gate version's ParseError does not carry the field (real parser, unparseable markdown)", () => {
    const reportsDir = reportsDirIn(tmp);
    const result = persistStdinReport({
      markdown: "just some prose, not a report",
      reportsDir,
      sessionId: "sess-no-field",
      now: new Date("2026-07-24T10:00:00Z"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.parseErrorLogPath).toBeDefined();
    const header = readLogHeader(result.parseErrorLogPath!);
    expect(header.malformedSections).toEqual([]);
  });

  it("carries malformedSections through verbatim when understanding-gate reports it (list section exists but body is prose)", () => {
    const reportsDir = reportsDirIn(tmp);
    vi.mocked(parseReport).mockReturnValueOnce({
      ok: false,
      error: {
        reason: "schema_violation",
        missing: [],
        schemaErrors: [],
        message: "Verification Plan and Prior Art are prose, not markdown lists.",
        malformedSections: ["Verification Plan (list)", "Prior Art (list)"],
      },
      // Cast: this repo's pinned `@lannguyensi/understanding-gate`
      // (0.4.x) predates `malformedSections` on the exported `ParseError`
      // type; the mock simulates a future version's payload to prove the
      // harness reads the field defensively once it's present.
    } as unknown as ReturnType<typeof parseReport>);

    const result = persistStdinReport({
      markdown: "## Understanding Report\n...",
      reportsDir,
      sessionId: "sess-with-field",
      now: new Date("2026-07-24T10:00:00Z"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const header = readLogHeader(result.parseErrorLogPath!);
    expect(header.malformedSections).toEqual(["Verification Plan (list)", "Prior Art (list)"]);
    // Untouched neighbors: the addition doesn't disturb existing fields.
    expect(header.reason).toBe("schema_violation");
    expect(header.sessionId).toBe("sess-with-field");
  });
});
