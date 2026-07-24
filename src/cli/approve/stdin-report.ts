// Report capture for `harness approve understanding` (task 61fd36db).
//
// The Understanding Report arrives as a heredoc on the approve command's
// stdin (see src/cli/pack/approve-escape.ts for why this is the only
// channel that reliably carries it: the Stop-hook producer fires after
// approve already ran, and current Claude Code builds do not reliably
// persist mid-turn assistant text to the transcript JSONL). This module
// parses the markdown with the canonical parser from
// `@lannguyensi/understanding-gate` and persists it — session-bound and
// `pending` — into the same reports directory the Stop hook targets, so
// the approve flow's existing selection / validation / flip path picks
// it up via a strict sessionId match.
//
// On parse failure it writes a parse-error log in the exact format the
// standalone Stop hook uses (JSON header incl. sessionId, `--- raw ---`
// separator, raw markdown), so `findLatestParseError` in
// approve/understanding.ts surfaces the reason on the `report:` line
// instead of a silent dead end.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseReport } from "@lannguyensi/understanding-gate";
import { atomicWriteFile } from "../../io/atomic-write.js";

export type StdinReportOutcome =
  | { ok: true; filePath: string }
  | { ok: false; reason: string; parseErrorLogPath?: string };

export interface PersistStdinReportArgs {
  /** The heredoc body: Understanding Report markdown. */
  markdown: string;
  /** Directory the approve flow lists reports from. */
  reportsDir: string;
  /** Resolved session id; stamped onto the persisted JSON. */
  sessionId: string;
  /** Clock injection for deterministic tests. */
  now: Date;
}

/** Mirror of the standalone package's slug rule (persistence.ts). */
function sanitizeSlug(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 40);
}

function summarizeParseError(error: {
  reason: string;
  missing: string[];
  message: string;
}): string {
  if (error.message.length > 0) return error.message;
  const missing = error.missing.length > 0 ? ` (missing: ${error.missing.join(", ")})` : "";
  return `${error.reason}${missing}`;
}

/**
 * `@lannguyensi/understanding-gate` added an additive optional
 * `malformedSections` field to `ParseError` (agent-grounding PR #154 /
 * be98cd96 — the package lives in the agent-grounding repo; follow-up
 * to the 2026-07-22 incident where prose under a (list) heading was
 * rejected with no way for the agent to see why): populated when a
 * (list) section heading EXISTS but its body is prose instead of
 * markdown list items — a strict subset of `missing`. The version pinned
 * in this repo's package.json (0.4.x) predates the field, so it is read
 * through this minimal structural extension of the imported `ParseError`
 * type rather than trusting a newer type shape (or reaching for `any`);
 * `?? []` below covers both "the pin predates the field" and "the field
 * is present but empty". Mirrors how agent-grounding's handle-stop.ts
 * and opencode's persist-report.ts take the same field.
 */
type ParseErrorWithMalformedSections = { malformedSections?: string[] };

/** Reports are a few KB; anything beyond this is not a report. */
export const STDIN_REPORT_MAX_BYTES = 512 * 1024;

export interface PipedStdinResult {
  text: string;
  /**
   * True only when the stream ended cleanly within the size cap. A
   * timeout with partial data, a stream error, or a size-cap hit all
   * yield `complete: false` — the caller must NOT feed such text into
   * the capture path, or a truncated-but-still-parseable report could
   * be persisted and approved as if it were whole (review 2026-07-10).
   */
  complete: boolean;
}

/**
 * Read piped stdin fully, with a hang guard. The caller must already
 * have established that stdin is NOT a TTY. The timeout exists because
 * this read sits on the operator-approval path: if some harness wires
 * the CLI to an open-but-idle pipe, a blocked read here would brick
 * approvals — after `timeoutMs` we proceed with whatever arrived
 * (a real heredoc is delivered immediately by the shell), flagged
 * `complete: false`.
 */
export function readPipedStdin(
  stream: NodeJS.ReadableStream,
  maxBytes: number = STDIN_REPORT_MAX_BYTES,
  timeoutMs = 2_000,
): Promise<PipedStdinResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (complete: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        text: Buffer.concat(chunks).toString("utf8"),
        complete: complete && length <= maxBytes,
      });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // Let a finished CLI exit even if the timer is still pending.
    timer.unref?.();
    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      if (length < maxBytes) {
        const remaining = maxBytes - length;
        chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      }
      length += chunk.length;
    });
    stream.on("end", () => finish(true));
    stream.on("error", () => finish(false));
  });
}

export function persistStdinReport(args: PersistStdinReportArgs): StdinReportOutcome {
  // Defaults mirror the standalone Stop hook (handle-stop.ts): the
  // report's own `**Metadata**` block wins for any field it declares;
  // these only fill gaps. approvalStatus is forced to "pending" by
  // parseReport regardless of input.
  const result = parseReport(args.markdown, {
    taskId: args.sessionId,
    createdAt: args.now.toISOString(),
    mode: "fast_confirm",
    riskLevel: "medium",
  });

  const stamp = args.now.toISOString().replace(/[:.]/g, "-");

  if (!result.ok) {
    const summary = summarizeParseError(result.error);
    // Same side-channel location + format as the standalone Stop hook:
    // <reportsDir>/../parse-errors/<stamp>.log with a JSON header that
    // carries sessionId (findLatestParseError skips logs it cannot
    // attribute to the approving session).
    const parseErrorDir = path.join(path.dirname(args.reportsDir), "parse-errors");
    const malformedSections =
      (result.error as ParseErrorWithMalformedSections).malformedSections ?? [];
    const payload = `${JSON.stringify(
      {
        reason: result.error.reason,
        missing: result.error.missing,
        malformedSections,
        schemaErrors: result.error.schemaErrors,
        message: result.error.message,
        stamp,
        sessionId: args.sessionId,
        source: "harness-approve-stdin",
      },
      null,
      2,
    )}\n\n--- raw ---\n${args.markdown}\n`;
    let parseErrorLogPath: string | undefined;
    try {
      parseErrorLogPath = path.join(parseErrorDir, `${stamp}.log`);
      atomicWriteFile(parseErrorLogPath, payload);
    } catch {
      // Best-effort side channel; the loud `stdin:` line still names the
      // parse failure even when the log write itself fails.
      parseErrorLogPath = undefined;
    }
    return {
      ok: false,
      reason: `report on stdin did not parse: ${summary}`,
      ...(parseErrorLogPath !== undefined ? { parseErrorLogPath } : {}),
    };
  }

  // The standalone package's saveReport cannot be used here: its
  // canonical serializer whitelists the schema keys and would strip the
  // sessionId binding, which is exactly what makes the approve flow's
  // strict match (and the tier-6 session-id fallback) work. Persist the
  // same JSON shape plus `sessionId`, with the package's filename
  // convention (<isoStamp>-<slug>-<hash8>.json) so directory listings
  // read uniformly.
  const persisted = { ...result.report, sessionId: args.sessionId };
  const json = `${JSON.stringify(persisted, null, 2)}\n`;
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 8);
  const slug = sanitizeSlug(result.report.taskId) || "report";
  const filePath = path.join(args.reportsDir, `${stamp}-${slug}-${hash}.json`);
  try {
    atomicWriteFile(filePath, json);
  } catch (err) {
    return {
      ok: false,
      reason: `report parsed but could not be persisted to ${filePath}: ${(err as Error).message}`,
    };
  }
  return { ok: true, filePath };
}
