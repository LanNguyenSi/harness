import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sessionExport } from "../../../src/cli/session-export/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import type { LedgerEntry, LedgerQueryResult } from "../../../src/policies/index.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE = path.resolve(
  path.dirname(__filename),
  "..",
  "..",
  "fixtures",
  "transcripts",
  "sample.jsonl",
);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-session-export-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "harness.yaml"), "version: 1\n", "utf8");
  return home;
}

function ledgerOk(entries: LedgerEntry[]): () => Promise<LedgerQueryResult> {
  return async () => ({ kind: "ok", entries });
}

function ledgerEmpty(): () => Promise<LedgerQueryResult> {
  return async () => ({ kind: "ok", entries: [] });
}

const SAMPLE_SID = "test-session";

describe("sessionExport — happy path", () => {
  it("joins transcript and ledger in chronological order", async () => {
    const homeDir = makeHome();
    const ledger: LedgerEntry[] = [
      {
        id: "l1",
        content: "policy_decision: block one_branch_per_task",
        type: "policy_decision",
        createdAt: "2026-05-06T08:00:01.500Z",
      },
      {
        id: "l2",
        content: "fact: ran ls",
        type: "fact",
        createdAt: "2026-05-06T08:00:03.500Z",
      },
    ];

    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => FIXTURE,
      fetchLedger: ledgerOk(ledger),
      env: {},
    });

    expect(result.header.transcriptEvents).toBe(9);
    expect(result.header.ledgerEntries).toBe(2);
    expect(result.header.transcriptPath).toBe(FIXTURE);
    expect(result.events.length).toBe(11);

    // chronological ordering with ledger interleaved
    const tsSeq = result.events
      .map((e) => e.timestamp)
      .filter((t): t is string => typeof t === "string");
    const sorted = [...tsSeq].sort();
    expect(tsSeq).toEqual(sorted);

    // each event has a source marker
    for (const e of result.events) {
      expect(["transcript", "ledger"]).toContain(e.source);
    }
  });

  it("redacts secrets in tool_use input by default", async () => {
    const homeDir = makeHome();
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => FIXTURE,
      fetchLedger: ledgerEmpty(),
      env: {},
    });
    const text = result.output;
    expect(text).not.toContain("sk-leak-1234");
    expect(text).toContain("<REDACTED>");
  });

  it("redacts an env_var value when declared in audit.redact[]", async () => {
    const homeDir = makeHome();
    fs.writeFileSync(
      path.join(homeDir, "harness.yaml"),
      `
version: 1
audit:
  redact:
    - env_var: AGENT_TASKS_TOKEN
      replacement: "<AT>"
`,
    );
    const ledger: LedgerEntry[] = [
      {
        id: "l1",
        content: "Authorization: Bearer at_secret_999",
        type: "fact",
        createdAt: "2026-05-06T08:00:00.500Z",
      },
    ];
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => FIXTURE,
      fetchLedger: ledgerOk(ledger),
      env: { AGENT_TASKS_TOKEN: "at_secret_999" },
    });
    expect(result.output).not.toContain("at_secret_999");
    expect(result.output).toContain("<AT>");
  });
});

describe("sessionExport — formats", () => {
  it("--format jsonl emits one event per line plus a session header line", async () => {
    const homeDir = makeHome();
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      format: "jsonl",
      locateTranscript: () => FIXTURE,
      fetchLedger: ledgerEmpty(),
      env: {},
    });
    const lines = result.output.trim().split("\n");
    expect(lines.length).toBe(1 + 9);
    expect(JSON.parse(lines[0]!).kind).toBe("session");
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line);
      expect(["transcript", "ledger"]).toContain(parsed.source);
    }
  });

  it("writes to --out file when provided", async () => {
    const homeDir = makeHome();
    const out = path.join(homeDir, "export.json");
    await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      outFile: out,
      locateTranscript: () => FIXTURE,
      fetchLedger: ledgerEmpty(),
      env: {},
    });
    const written = fs.readFileSync(out, "utf8");
    const parsed = JSON.parse(written);
    expect(parsed.session.id).toBe(SAMPLE_SID);
    expect(parsed.events.length).toBe(9);
  });
});

describe("sessionExport — partial sources", () => {
  it("runs against the transcript when the ledger is empty", async () => {
    const homeDir = makeHome();
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => FIXTURE,
      fetchLedger: ledgerEmpty(),
      env: {},
    });
    expect(result.header.ledgerEntries).toBe(0);
    expect(result.events.length).toBe(9);
    expect(result.header.ledgerStatus).toBe("ok");
  });

  it("runs against the ledger when the transcript is missing", async () => {
    const homeDir = makeHome();
    const ledger: LedgerEntry[] = [
      {
        id: "l1",
        content: "fact: only the ledger here",
        type: "fact",
        createdAt: "2026-05-06T08:00:00.000Z",
      },
    ];
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => null,
      fetchLedger: ledgerOk(ledger),
      env: {},
    });
    expect(result.header.transcriptPath).toBeNull();
    expect(result.header.transcriptEvents).toBe(0);
    expect(result.events.length).toBe(1);
  });

  it("notes a degraded ledger in the header instead of failing", async () => {
    const homeDir = makeHome();
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => FIXTURE,
      fetchLedger: async () => ({ kind: "degraded", reason: "ledger socket closed" }),
      env: {},
    });
    expect(result.header.ledgerStatus).toBe("degraded");
    expect(result.header.ledgerNote).toBe("ledger socket closed");
  });

  it("exits 1 when both transcript and ledger are empty", async () => {
    const homeDir = makeHome();
    let caught: unknown;
    try {
      await sessionExport({
        homeDir,
        sessionId: SAMPLE_SID,
        locateTranscript: () => null,
        fetchLedger: ledgerEmpty(),
        env: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(1);
  });
});

describe("sessionExport — merge ordering ties", () => {
  it("breaks identical timestamps deterministically by source then sequence", async () => {
    const homeDir = makeHome();
    const ts = "2026-05-06T08:00:00.500Z";
    const ledger: LedgerEntry[] = [
      { id: "lA", content: "A", type: "fact", createdAt: ts },
      { id: "lB", content: "B", type: "fact", createdAt: ts },
    ];
    const result = await sessionExport({
      homeDir,
      sessionId: SAMPLE_SID,
      locateTranscript: () => null,
      fetchLedger: ledgerOk(ledger),
      env: {},
    });
    const ledgerEvents = result.events.filter((e) => e.source === "ledger");
    expect(ledgerEvents.map((e) => (e.data as { id: string }).id)).toEqual(["lA", "lB"]);
  });
});
