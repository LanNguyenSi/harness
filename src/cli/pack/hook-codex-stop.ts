// Phase 6 #6 follow-up — `harness pack hook codex-stop` runtime verb.
//
// Codex Stop-equivalent for the `understanding-before-execution` pack.
// Mirrors the `@lannguyensi/understanding-gate` claude-code stop bin's
// contract, scoped to v1: read the agent's stop event on stdin,
// extract the last assistant message, parse Understanding Report
// fields, persist as JSON under `.understanding-gate/reports/`. The
// resulting file lands with `approvalStatus: "pending"` so a later
// `harness approve understanding` flips it to approved.
//
// Wire format on stdin (envelope harness publishes; Codex CLI
// integration wraps its native event into this shape):
//
//   { session_id?: string, last_assistant_message?: string,
//     messages?: Array<{ role: string, content: string }> }
//
// Either `last_assistant_message` is provided directly, OR the last
// entry in `messages[]` with role === "assistant" is used.
//
// Failure mode: any error (malformed input, missing session id,
// unwritable reports dir, parser yielded zero recognisable fields)
// falls through to exit 0 + a stderr diagnostic. The Stop event must
// never block the agent's response path; capture is best-effort.
//
// Out of scope for v1 (filed separately when needed):
//   - Backfill of older transcripts.
//   - A schema-validating parser; the v1 parser is heading-driven and
//     intentionally lenient.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { defaultReportsDir } from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { loadManifestOrInjected, pickString, readStdin } from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";
const RUNTIME_TAG = "codex";

export interface PackHookCodexStopOptions extends LoaderOptions {
  pack?: string;
  reportsDir?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
  /** Test-injectable clock; defaults to new Date(). */
  now?: Date;
}

export interface ParsedReport {
  interpretation: string;
  assumptions: string[];
  openQuestions: string[];
  outOfScope: string[];
  risks: string[];
  verificationPlan: string;
}

export interface PackHookCodexStopResult {
  exitCode: number;
  /** Path of the persisted report; null when no file was written. */
  reportPath: string | null;
  /** True when at least one Understanding Report field was extracted. */
  parsed: boolean;
  diagnostic: string;
}

interface StopEnvelope {
  session_id?: unknown;
  last_assistant_message?: unknown;
  messages?: unknown;
}

interface MessageRow {
  role?: unknown;
  content?: unknown;
}

function extractLastAssistantText(env: StopEnvelope): string | null {
  const direct = pickString(env.last_assistant_message);
  if (direct !== undefined) return direct;
  if (!Array.isArray(env.messages)) return null;
  for (let i = env.messages.length - 1; i >= 0; i--) {
    const row = env.messages[i] as MessageRow;
    if (row && typeof row === "object" && row.role === "assistant") {
      const content = pickString(row.content);
      if (content !== undefined) return content;
    }
  }
  return null;
}

// Field names recognised by the parser. Lower-case canonical forms;
// the matcher is case-insensitive and accepts CamelCase / snake_case
// / spaces.
const FIELDS = [
  "interpretation",
  "assumptions",
  "openquestions",
  "outofscope",
  "risks",
  "verificationplan",
] as const;
type FieldKey = (typeof FIELDS)[number];

const SCALAR_FIELDS: ReadonlySet<FieldKey> = new Set(["interpretation", "verificationplan"]);

function normalizeFieldKey(raw: string): FieldKey | null {
  // Strip trailing punctuation that operators commonly leave inside
  // bold labels (e.g. `**Interpretation:**` → field name is just
  // "Interpretation"). Then compact whitespace/separators.
  const compact = raw
    .trim()
    .replace(/[:.\s]+$/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  // Accept synonyms / British/American variants.
  switch (compact) {
    case "openquestions":
    case "questions":
      return "openquestions";
    case "outofscope":
    case "scopeexclusions":
    case "exclusions":
      return "outofscope";
    case "verificationplan":
    case "validation":
    case "verification":
      return "verificationplan";
    default:
      if ((FIELDS as readonly string[]).includes(compact)) {
        return compact as FieldKey;
      }
      return null;
  }
}

// A heading/label line opens a section. Recognised:
//   `## Interpretation`           markdown heading
//   `**Interpretation:**`         bold label
//   `Interpretation:` (line)      plain colon-prefixed label
// Returns the FieldKey on hit, plus any inline content trailing on
// the same line (e.g. `Interpretation: short paragraph`).
function matchSectionHeader(line: string): { field: FieldKey; inlineRest: string } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  // Markdown heading: `## Interpretation` or `### Open Questions`.
  const heading = trimmed.match(/^#{1,6}\s+(.+?)\s*$/);
  if (heading) {
    const field = normalizeFieldKey(heading[1] ?? "");
    if (field) return { field, inlineRest: "" };
  }

  // Bold label: `**Interpretation:**` or `**Interpretation**:`.
  const bold = trimmed.match(/^\*\*([^*]+?)\*\*\s*:?\s*(.*)$/);
  if (bold) {
    const field = normalizeFieldKey(bold[1] ?? "");
    if (field) return { field, inlineRest: bold[2]?.trim() ?? "" };
  }

  // Plain label `Interpretation: rest of line` (avoid matching arbitrary
  // sentence colons by requiring the prefix to be a known field name).
  const plain = trimmed.match(/^([A-Za-z][A-Za-z _-]*)\s*:\s*(.*)$/);
  if (plain) {
    const field = normalizeFieldKey(plain[1] ?? "");
    if (field) return { field, inlineRest: plain[2]?.trim() ?? "" };
  }

  return null;
}

function extractBulletText(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const m = trimmed.match(/^[-*•]\s+(.+)$/);
  return m ? m[1]!.trim() : null;
}

export function parseUnderstandingReport(text: string): ParsedReport {
  const out: ParsedReport = {
    interpretation: "",
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
    verificationPlan: "",
  };
  if (typeof text !== "string" || text.trim() === "") return out;

  const lines = text.split(/\r?\n/);
  let active: FieldKey | null = null;
  let scalarBuffer: string[] = [];

  const flushScalar = (): void => {
    if (active && SCALAR_FIELDS.has(active) && scalarBuffer.length > 0) {
      const joined = scalarBuffer.join(" ").replace(/\s+/g, " ").trim();
      writeScalar(out, active, joined);
    }
    scalarBuffer = [];
  };

  for (const line of lines) {
    const header = matchSectionHeader(line);
    if (header) {
      flushScalar();
      active = header.field;
      if (header.inlineRest !== "") {
        if (SCALAR_FIELDS.has(active)) {
          scalarBuffer.push(header.inlineRest);
        } else {
          // Inline content on a list-field header counts as the first item.
          appendList(out, active, header.inlineRest);
        }
      }
      continue;
    }
    if (!active) continue;

    if (SCALAR_FIELDS.has(active)) {
      const trimmed = line.trim();
      if (trimmed === "") {
        // Blank line within a scalar paragraph terminates accumulation.
        if (scalarBuffer.length > 0) flushScalar();
        continue;
      }
      scalarBuffer.push(trimmed);
    } else {
      const bullet = extractBulletText(line);
      if (bullet !== null) {
        appendList(out, active, bullet);
      }
      // Non-bullet lines under a list field are dropped (the upstream
      // package's contract is "use bullets"; lenient drop avoids
      // accidentally appending the next paragraph).
    }
  }
  flushScalar();
  return out;
}

function writeScalar(out: ParsedReport, field: FieldKey, value: string): void {
  if (field === "interpretation") out.interpretation = value;
  else if (field === "verificationplan") out.verificationPlan = value;
}

function appendList(out: ParsedReport, field: FieldKey, value: string): void {
  if (field === "assumptions") out.assumptions.push(value);
  else if (field === "openquestions") out.openQuestions.push(value);
  else if (field === "outofscope") out.outOfScope.push(value);
  else if (field === "risks") out.risks.push(value);
}

export function reportHasContent(r: ParsedReport): boolean {
  return (
    r.interpretation !== "" ||
    r.verificationPlan !== "" ||
    r.assumptions.length > 0 ||
    r.openQuestions.length > 0 ||
    r.outOfScope.length > 0 ||
    r.risks.length > 0
  );
}

function sessionShortHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

function isoFilenameStamp(now: Date): string {
  // 2026-05-10T17:25:30.123Z -> 2026-05-10T17-25-30
  const iso = now.toISOString();
  const head = iso.slice(0, iso.indexOf(".") === -1 ? iso.length - 1 : iso.indexOf("."));
  return head.replace(/:/g, "-");
}

function buildReportFilename(sessionId: string, now: Date): string {
  const stamp = isoFilenameStamp(now);
  const hash = sessionShortHash(sessionId);
  return `${stamp}-${RUNTIME_TAG}-${hash}.json`;
}

function writeReportFile(
  reportsDir: string,
  filename: string,
  body: Record<string, unknown>,
): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const target = path.join(reportsDir, filename);
  atomicWriteFile(target, `${JSON.stringify(body, null, 2)}\n`);
  return target;
}

function allowResult(diagnostic: string, stderr: NodeJS.WritableStream): PackHookCodexStopResult {
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, reportPath: null, parsed: false, diagnostic };
}

export async function runPackHookCodexStopCli(
  opts: PackHookCodexStopOptions = {},
): Promise<PackHookCodexStopResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;
  const now = opts.now ?? new Date();

  // Fail-open on stdin read errors (e.g. EPIPE on a closed pipe). The
  // Stop hook must never crash the agent's response path; a missed
  // capture is acceptable, an uncaught reject is not.
  let raw: string;
  try {
    raw = await readStdin(stdin);
  } catch (err) {
    return allowResult(
      `harness pack hook codex-stop: stdin read failed (${(err as Error).message}), skipping capture.`,
      stderr,
    );
  }
  let envelope: StopEnvelope = {};
  try {
    envelope = JSON.parse(raw.trim() || "{}") as StopEnvelope;
  } catch {
    return allowResult(
      "harness pack hook codex-stop: malformed JSON on stdin, skipping capture.",
      stderr,
    );
  }

  let manifest: Manifest;
  try {
    ({ manifest } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    return allowResult(
      `harness pack hook codex-stop: manifest load failed (${(err as Error).message}), skipping capture.`,
      stderr,
    );
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared || !declared.enabled) {
    return allowResult(
      `harness pack hook codex-stop: pack "${packName}" not enabled, skipping capture.`,
      stderr,
    );
  }

  const sessionId =
    pickString(envelope.session_id) ??
    process.env["CODEX_SESSION_ID"] ??
    process.env["CLAUDE_CODE_SESSION_ID"] ??
    process.env["CLAUDE_SESSION_ID"] ??
    "";
  if (sessionId === "") {
    return allowResult(
      "harness pack hook codex-stop: no session_id resolvable, skipping capture.",
      stderr,
    );
  }

  const lastMessage = extractLastAssistantText(envelope);
  if (lastMessage === null || lastMessage.trim() === "") {
    return allowResult(
      "harness pack hook codex-stop: no assistant message in stop event, skipping capture.",
      stderr,
    );
  }

  const report = parseUnderstandingReport(lastMessage);
  if (!reportHasContent(report)) {
    return allowResult(
      "harness pack hook codex-stop: assistant message did not contain a recognisable Understanding Report (no labelled fields found), skipping capture.",
      stderr,
    );
  }

  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const filename = buildReportFilename(sessionId, now);
  const body: Record<string, unknown> = {
    sessionId,
    runtime: RUNTIME_TAG,
    createdAt: now.toISOString(),
    approvalStatus: "pending",
    report,
    rawMessage: lastMessage,
  };
  let target: string;
  try {
    target = writeReportFile(reportsDir, filename, body);
  } catch (err) {
    return allowResult(
      `harness pack hook codex-stop: failed to write report (${(err as Error).message}), skipping capture.`,
      stderr,
    );
  }

  const diagnostic = `harness pack hook codex-stop: captured Understanding Report at ${target} (approvalStatus: pending).`;
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, reportPath: target, parsed: true, diagnostic };
}
