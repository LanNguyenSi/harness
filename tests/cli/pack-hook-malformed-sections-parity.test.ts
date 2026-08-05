import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReport } from "@lannguyensi/understanding-gate";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Cross-runtime parity for the malformed-sections agent-facing sentence
// (task 823837fd review Fix 4): both PreToolUse hooks now build the
// sentence via the SAME shared `renderMalformedSectionsNotice`
// (src/cli/approve/understanding.ts) instead of each carrying its own
// byte-identical copy. This test proves the sharing actually holds by
// running both hooks against the identical parse-error fixture and
// diffing the extracted sentence, rather than trusting the two call
// sites stayed in sync by eyeballing.

let tmp: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedCodex: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-malformed-parity-"));
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
});

function manifestWithPack(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
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

function writeParseErrorLog(
  parseErrorsDir: string,
  name: string,
  body: Record<string, unknown>,
): void {
  fs.mkdirSync(parseErrorsDir, { recursive: true });
  fs.writeFileSync(
    path.join(parseErrorsDir, name),
    `${JSON.stringify(body, null, 2)}\n\n--- raw ---\noriginal assistant text\n`,
  );
}

// Same shape as the fixture builder in pack-hook-pre-tool-use.test.ts /
// pack-hook-codex-pre-tool-use.test.ts: derived from an actual
// `parseReport` call so the malformed section keys cannot drift from
// what the producer really emits.
function malformedSectionsParseError(): {
  missing: string[];
  malformedSections: string[];
  message: string;
} {
  const markdown = [
    "# Understanding Report",
    "",
    "## Current Understanding",
    "I understand the task.",
    "",
    "## Intended Outcome",
    "Ship the fix.",
    "",
    "## Derived Todos",
    "- do the thing",
    "",
    "## Acceptance Criteria",
    "- it works",
    "",
    "## Assumptions",
    "- none",
    "",
    "## Open Questions",
    "- none",
    "",
    "## Out Of Scope",
    "- nothing",
    "",
    "## Risks",
    "This is prose instead of a list.",
    "",
    "## Verification Plan",
    "- ran tests",
    "",
    "## Prior Art",
    "Also prose here, not a list.",
    "",
  ].join("\n");
  const result = parseReport(markdown, { mode: "grill_me" });
  if (result.ok) {
    throw new Error("test fixture markdown unexpectedly parsed cleanly");
  }
  return {
    missing: result.error.missing,
    malformedSections: result.error.malformedSections ?? [],
    message: result.error.message,
  };
}

const MALFORMED_SENTENCE_RE =
  /Your previous Understanding Report attempt had malformed sections \(present but not a markdown list\): [^\n]+\./;

describe("malformed-sections notice — Claude/Codex hook parity (task 823837fd review Fix 4)", () => {
  it("both hooks emit the byte-identical sentence for the same session's parse-error fixture", async () => {
    const sessionId = "sess-parity";
    const { missing, malformedSections, message } = malformedSectionsParseError();
    const parseErrorBody = {
      sessionId,
      reason: "missing_sections",
      missing,
      malformedSections,
      message,
    };

    // Claude hook.
    const claudeParent = fs.mkdtempSync(path.join(tmp, "claude-"));
    const claudeReportsDir = path.join(claudeParent, "reports");
    writeParseErrorLog(path.join(claudeParent, "parse-errors"), "err.log", parseErrorBody);
    const claudeStdout = bufferStream();
    const claudeStderr = bufferStream();
    const claudeResult = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ session_id: sessionId, tool_name: "Edit" }),
      ),
      stdout: claudeStdout.stream,
      stderr: claudeStderr.stream,
      reportsDir: claudeReportsDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(claudeResult.blocked).toBe(true);
    const claudeDecision = JSON.parse(claudeStdout.read().trim()) as { reason: string };
    const claudeMatch = claudeDecision.reason.match(MALFORMED_SENTENCE_RE);
    expect(claudeMatch).not.toBeNull();

    // Codex hook — identical sessionId, identical parse-error fixture.
    const codexParent = fs.mkdtempSync(path.join(tmp, "codex-"));
    const codexReportsDir = path.join(codexParent, "reports");
    writeParseErrorLog(path.join(codexParent, "parse-errors"), "err.log", parseErrorBody);
    const codexStderr = bufferStream();
    const codexResult = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ session_id: sessionId, tool_name: "apply_patch" }),
      ),
      stderr: codexStderr.stream,
      reportsDir: codexReportsDir,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(codexResult.blocked).toBe(true);
    const codexMatch = codexStderr.read().match(MALFORMED_SENTENCE_RE);
    expect(codexMatch).not.toBeNull();

    // The extracted sentence itself — not the surrounding envelope, which
    // legitimately differs between the two runtimes (JSON reason vs.
    // plain stderr text) — must be byte-identical.
    expect(claudeMatch![0]).toBe(codexMatch![0]);
    expect(claudeMatch![0]).toBe(
      "Your previous Understanding Report attempt had malformed sections " +
        "(present but not a markdown list): Risks (risks), Prior Art (priorArt).",
    );
  });
});
