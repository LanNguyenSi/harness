// Phase 6 #4 — `harness approve understanding [--session <id>]` CLI verb.
//
// Round-trips both approval sources for the
// `understanding-before-execution` pack:
//
//   1. Writes the evidence-ledger tag `understanding-approved:${SESSION_ID}`
//      via `grounding-mcp`'s `ledger_add` (best-effort: degraded ledger
//      surfaces as a warning, not a hard failure).
//   2. Flips `approvalStatus: "approved"` on the latest persisted JSON
//      report under `.understanding-gate/reports/`. Atomic rewrite.
//
// Rationale for writing both: harnessed sessions consult the ledger as
// canonical, but a solo `@lannguyensi/understanding-gate` user without
// `grounding-mcp` wired only sees the persisted JSON. Round-tripping
// both means switching between the two stacks doesn't lose history.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  approvedLedgerTagFor,
  defaultReportsDir,
  listPersistedReports,
  readActiveClaim,
  selectReportForSession,
  TOLERANT_FALLBACK_MAX_AGE_MS,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  type ModeConfigSource,
  PACK_NAME as UNDERSTANDING_PACK_NAME,
  resolveMode,
  toPackageMode,
} from "../../policy-packs/builtin/understanding-before-execution.js";
import { sha256Hex } from "../../runtime/approval-signing.js";
import { addLedgerFact } from "../../runtime/ledger-add.js";
import {
  clearPendingApproval,
  resolveGeneratedDir,
} from "../../runtime/pending-approval.js";
import { resolveApprovalSessionId } from "../../runtime/session-id.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";
import { describeSectionKey } from "../pack/understanding-report-schema-hint.js";
import { persistStdinReport, type StdinReportOutcome } from "./stdin-report.js";

export interface ApproveUnderstandingOptions extends LoaderOptions {
  /** Explicit session id (overrides $CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID / $CODEX_SESSION_ID). */
  session?: string;
  /**
   * Override the approve-time report validation (priorArt enforcement for
   * `grill_me` reports). Writes the marker / ledger / report-flip anyway
   * and stamps the ledger tag content with a `:forced:<field>-<reason>`
   * suffix so the audit trail records the bypass. Emergency-unblock path:
   * the default refuses the marker when validation fails so an agent
   * cannot ship a hollow Understanding Report and still get the gate open.
   */
  force?: boolean;
  /**
   * Optional agent-tasks task id (harness/1ee26e77). When set, an
   * additional task-scoped marker file is written at
   * `<generatedDir>/.approvals/task-<taskId>`, in addition to the
   * legacy session-scoped marker. Either satisfies the gate; the
   * task-scoped marker is the design-intent target for multi-task
   * sessions so the next task can require its own Understanding Report.
   *
   * When omitted, `harness approve understanding` falls back to reading
   * `<generatedDir>/active-claim` (written by the track-active-claim
   * PostToolUse hook on `task_start`, harness/494fd1e5). If that file
   * exists, its content is used as the task id. If absent, no task
   * marker is written — the session marker is the only one (v1
   * back-compat).
   *
   * Single-id back-compat field. For pre-approving a batch use `tasks`;
   * when both are set, `tasks` wins.
   */
  task?: string;
  /**
   * Multiple agent-tasks task ids to pre-approve in one operator action
   * (harness/0dce3880 friction #2). One task-scoped marker is written
   * per id. As the agent's active claim cycles through the listed
   * tasks, each `task_start` finds its own marker already present, so a
   * homogeneous batch (e.g. a CVE sweep across N repos) needs a single
   * `harness approve understanding --task a b c` instead of one
   * approval per `task_finish`. The understanding gate stays
   * task-scoped: the operator's report still has to enumerate every
   * task it covers; only the round-trip count collapses. Empty / blank
   * entries are dropped and duplicates de-duplicated.
   */
  tasks?: string[];
  /**
   * Understanding Report markdown captured from the command's stdin
   * (the report-heredoc shape, task 61fd36db). When set and non-blank,
   * it is parsed and persisted as a pending, session-bound report BEFORE
   * the report lookup below, so this very approve run validates and
   * flips it. A parse failure degrades loudly (parse-error log + reason
   * on the result) but does not abort the approval — the operator just
   * approved interactively; a formatting nit must not brick that.
   */
  reportMarkdown?: string;
  /** Override the reports directory (test injection). */
  reportsDir?: string;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Override the actor recorded in the persisted report. */
  approvedBy?: string;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /** Override the ledger writer (test). */
  ledgerAdd?: (sessionId: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Outcome of writing one task-scoped approval marker. */
export type TaskMarkerOutcome =
  | { ok: true; taskId: string; filePath: string; approvedAt: string; source: "flag" | "active-claim" }
  | { ok: false; taskId: string; reason: string; source: "flag" | "active-claim" };

/**
 * Human-scale age for operator messages: minutes up to two hours,
 * hours up to two days, then days. A 17-day-old report should read
 * "17d", not "24893m" (review finding on harness-discovery C1).
 */
function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (Math.abs(min) < 120) return `${min}m`;
  const hours = Math.round(min / 60);
  if (Math.abs(hours) < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface ApproveUnderstandingResult {
  sessionId: string;
  /**
   * Where `sessionId` came from. Surfaced so the CLI can show the
   * operator when the id was not explicit (`pending-approval` / `env`),
   * which is the moment to sanity-check it against the live session.
   */
  sessionSource:
    | "flag"
    | "env-claude-code"
    | "env-claude"
    | "env-codex"
    | "pending-approval"
    | "newest-report";
  /**
   * When `sessionSource` is `"newest-report"`, the absolute path of the
   * persisted report the session id was guessed from. Undefined for
   * every other source. The CLI names this file in its loud tier-5
   * "verify this is your live session" warning so the operator can open
   * it and check before trusting the marker (harness/56f51f2b).
   */
  newestReportPath?: string;
  /**
   * Canonical gate-satisfying signal as of agent-tasks/88ca4bb3.
   * `ok: false` means the marker file could not be written (rare:
   * fs permission, missing parent directory) and the gate will still
   * block on the next tool call. The CLI surfaces this as a hard error
   * to the operator so they don't think they approved when they didn't.
   */
  marker: { ok: true; filePath: string; approvedAt: string } | { ok: false; reason: string };
  /**
   * Task-scoped marker write outcomes, one entry per resolved task id
   * (harness/0dce3880). Populated when `--task` / `opts.task` /
   * `opts.tasks` was supplied OR when the active-claim file resolved an
   * id (harness/494fd1e5). Empty array when no task was resolved
   * through any surface, so a regression cannot silently flip
   * session-only sessions into task-mode.
   *
   * The `source` field tells the operator which surface fed each id so
   * a wrong claim file can be spotted before it lands in the marker.
   */
  taskMarkers: TaskMarkerOutcome[];
  /**
   * `resolveMode`'s own warning (invalid `config.mode` in `harness.yaml`,
   * or an invalid `UNDERSTANDING_GATE_MODE` env value) surfaced verbatim
   * (task 5d73d78d review LOW, fix-round-3). Absent when the resolution
   * was clean. This mirrors what the Codex `UserPromptSubmit` injector
   * already writes to stderr for the exact same `resolveMode` call — this
   * command used to compute the same warning and drop it silently.
   */
  modeWarning?: string;
  /**
   * Outcome of capturing a report passed on stdin (`reportMarkdown`).
   * Absent when no report was supplied. `ok: true` means the markdown
   * parsed and was persisted pending + session-bound; the
   * `persistedReport` result below then reports the flip of that same
   * file. `ok: false` carries the parse/persist failure reason (and the
   * parse-error log path when one was written).
   */
  stdinReport?: StdinReportOutcome;
  ledger: { ok: boolean; tag: string; reason?: string };
  persistedReport:
    | {
        ok: true;
        filePath: string;
        previousStatus: string | null;
        approvedAt: string;
        /** True when this approval stamped a missing `sessionId` onto the report. */
        sessionIdStamped: boolean;
        /**
         * Present when the report was adopted via the sessionId-less
         * tolerant fallback rather than a strict sessionId match. The
         * CLI prints it loudly: the operator must verify the adopted
         * report is the one they just read, because a fallback adoption
         * means the live session's own report was never persisted
         * (harness-discovery C1).
         */
        fallbackAdopted?: { createdAt: string | null; ageMinutes: number };
      }
    | { ok: false; reason: string };
  /**
   * Approve-time content validation of the persisted report. `mode` is
   * the report's stamped mode field (the schema variant the report is
   * judged against). `ok: false` means a structural rule the prompt
   * already declared was violated (today: `grill_me` reports must have
   * a non-empty priorArt list with no literal `- None`).
   *
   * `enforced: false` means the failure was bypassed via `--force`; the
   * marker / ledger / report-flip still ran, and `ledger.tag` carries a
   * `:forced:<field>-<reason>` suffix so audit can distinguish forced
   * approvals from clean ones.
   *
   * `skipped: true` means no report was loaded to validate (no `latest`
   * matched the session, ledger-only path); validation is silently
   * waived because there is nothing to enforce.
   */
  validation:
    | { ok: true; mode: string | null }
    | { ok: false; field: string; reason: string; enforced: boolean }
    | { skipped: true };
}

const DEFAULT_APPROVED_BY = "harness-approve-cli";

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

function expandHomePath(p: string): string {
  if (p === "~") return process.env.HOME ?? os.homedir();
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? os.homedir(), p.slice(2));
  return p;
}

async function writeLedgerTag(
  manifest: Manifest,
  sessionId: string,
  content: string,
  opts: ApproveUnderstandingOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.ledgerAdd) return opts.ledgerAdd(sessionId, content);
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  const command = Array.isArray(server.command)
    ? server.command.map(expandHomePath)
    : server.command.trim().split(/\s+/).map(expandHomePath);
  return addLedgerFact({
    mcpCommand: command,
    ...(server.env && { mcpEnv: server.env }),
    timeoutMs: server.health?.timeout_ms ?? 5_000,
    sessionId,
    content,
    source: "harness-approve-understanding",
  });
}

export interface ParseErrorSummary {
  filePath: string;
  /** One-line human-readable summary suitable for inlining in the CLI reason. */
  summary: string;
  /**
   * Section keys the log's `malformedSections` field named: a (list)
   * heading that WAS present but whose body was prose instead of markdown
   * list items (`@lannguyensi/understanding-gate` >= 0.4.10, agent-tasks
   * be98cd96). Empty when the field is absent/empty on the log (older
   * package pin, or an unrelated parse-error reason). `summary` already
   * has this named, appended as its own clause; this is exposed
   * separately too so a caller that wants to build its own sentence
   * (e.g. the PreToolUse hooks' agent-facing block reason, task
   * 823837fd) does not have to re-parse the log.
   */
  malformedSections: string[];
}

/**
 * Find the freshest parse-error log under `<dir>` (the
 * `<reports-dir>/../parse-errors/` location the standalone Stop hook
 * writes to when `parseReport` rejects the agent's last message). Used
 * to upgrade `approve understanding`'s "no reports found" diagnostic
 * from a silent dead end to a "hook fired but parse failed because X"
 * pointer. Best-effort: any I/O error is swallowed and we report no
 * parse-error, mirroring the listPersistedReports contract.
 *
 * `sessionId` filter (agent-tasks/b13205b2): each parse-error log's JSON
 * header carries the `sessionId` of the session that produced it. The
 * lookup used to return the directory-newest log regardless of whose
 * session wrote it, so a stale parse-error from a previous session would
 * surface in the current operator's approve output and read like a
 * failure of THEIR session. Logs whose header sessionId does not match
 * `sessionId` are now skipped entirely. Logs missing a `sessionId` field
 * (or whose header is not JSON) are also skipped, since we cannot
 * attribute them.
 *
 * `malformedSections` (task 823837fd, follow-up to 7e29e5d7): when the
 * log's JSON header carries a non-empty `malformedSections` array (a
 * (list) section that was present but not a markdown list), the returned
 * `summary` names those sections explicitly so the CLI's one-line reason
 * does not read as a bare "missing" when the agent actually wrote
 * *something* under the heading. Exported so the PreToolUse hooks
 * (hook-pre-tool-use.ts, hook-codex-pre-tool-use.ts) can reuse the same
 * lookup + attribution logic rather than re-implementing the header scan.
 */
export function findLatestParseError(dir: string, sessionId: string): ParseErrorSummary | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: { filePath: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    candidates.push({ filePath: full, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const cand of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(cand.filePath, "utf8");
    } catch {
      continue;
    }
    // The standalone package writes a JSON header followed by `--- raw ---`
    // and the original assistant text. Read the header for a `message`,
    // `reason`, or `missing` field; fall back to the first line if the
    // schema is unfamiliar so a future format change still surfaces
    // *something* rather than going silent.
    const header = raw.split("\n--- raw ---")[0] ?? raw;
    let summary = (header.split("\n")[0] ?? "").trim();
    let headerSessionId: string | null = null;
    let malformedSections: string[] = [];
    // Tracks whether `summary` was taken verbatim from the package's own
    // `message` field: `@lannguyensi/understanding-gate` >= 0.4.10 already
    // annotates each malformed (list) section inline in that string
    // ("Prior Art (list) (present but not a markdown list -- use '- ' or
    // '1.' items)"). Appending the same names again below would duplicate
    // them in one line; the append is only useful when `summary` came from
    // the `reason` fallback or the raw first-line fallback, neither of
    // which mentions the malformed sections on its own.
    let summaryFromMessage = false;
    try {
      const parsed = JSON.parse(header) as Record<string, unknown>;
      if (typeof parsed["sessionId"] === "string") {
        headerSessionId = parsed["sessionId"] as string;
      }
      if (Array.isArray(parsed["malformedSections"])) {
        malformedSections = (parsed["malformedSections"] as unknown[]).filter(
          (m): m is string => typeof m === "string",
        );
      }
      if (typeof parsed["message"] === "string" && parsed["message"].length > 0) {
        summary = parsed["message"] as string;
        summaryFromMessage = true;
      } else if (typeof parsed["reason"] === "string") {
        const missing = Array.isArray(parsed["missing"])
          ? ` (missing: ${(parsed["missing"] as unknown[]).filter((m) => typeof m === "string").join(", ")})`
          : "";
        summary = `${parsed["reason"] as string}${missing}`;
      }
    } catch {
      /* keep the first-line fallback; headerSessionId stays null */
    }
    if (headerSessionId !== sessionId) continue;
    if (malformedSections.length > 0 && !summaryFromMessage) {
      summary = `${summary}; malformed (present but not a markdown list): ${malformedSections.join(", ")}`;
    }
    return { filePath: cand.filePath, summary, malformedSections };
  }
  return null;
}

/**
 * Render the agent-facing "your previous report had malformed sections"
 * sentence from a `ParseErrorSummary.malformedSections` list, or `null`
 * when there is nothing to say. Shared by both PreToolUse hooks
 * (hook-pre-tool-use.ts, hook-codex-pre-tool-use.ts, task 823837fd
 * review) so the sentence is defined once instead of duplicated
 * byte-identically in each runtime; same extraction shape as
 * `checkOperatorApprovalMarkers` (understanding-before-execution-runtime.ts),
 * a marker-check helper both hooks already call instead of
 * re-implementing.
 *
 * Section keys are mapped to their display name via `describeSectionKey`
 * (`Prior Art (priorArt)` rather than the bare camelCase key) so the
 * sentence reads consistently with `renderReportSchemaHint`'s section
 * bullets in the same block reason, instead of mixing two vocabularies
 * for the same section. The CLI's own one-line summary
 * (`findLatestParseError` above) intentionally stays on raw keys; it is
 * operator-facing and matches the parse-error log verbatim.
 */
export function renderMalformedSectionsNotice(sections: string[]): string | null {
  if (sections.length === 0) return null;
  const named = sections.map((s) => describeSectionKey(s)).join(", ");
  return (
    `Your previous Understanding Report attempt had malformed sections ` +
    `(present but not a markdown list): ${named}.`
  );
}

/**
 * Approve-time content validation. v1 enforces the one rule the dogfood
 * loop discovered today (2026-05-24): a `grill_me` Report must declare a
 * non-empty `priorArt` list with no literal `- None`. The structural
 * parser in `@lannguyensi/understanding-gate` intentionally stays loose
 * here (`CHANGELOG.md:18` documents the design: the prompt is the
 * contract, the parser is structural). The approve CLI is the right
 * boundary to flip that loose acceptance into hard refusal, so an agent
 * cannot ship a hollow Understanding Report and still get the gate open.
 *
 * Modes that skip validation:
 *   - `fast_confirm`: schema-relaxed variant (`UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM`)
 *     drops priorArt from `required`, on purpose: fast_confirm is for
 *     low-stakes prompts where the gate barely fires.
 *   - missing/unknown mode: legacy reports pre-date the mode field;
 *     enforcing on them would retroactively invalidate every historical
 *     report.
 *
 * v1 limits the enforced list to `priorArt` because that is the
 * concrete failure observed in dogfood. Broader schema enforcement
 * (e.g. empty `derivedTodos`) is a follow-up if the same class of
 * "agent skipped a required section" failure recurs.
 */
type ValidationResult =
  | { ok: true; mode: string | null }
  | { ok: false; field: string; reason: string };

function validatePersistedReport(parsed: Record<string, unknown>): ValidationResult {
  const mode = typeof parsed["mode"] === "string" ? (parsed["mode"] as string) : null;
  if (mode !== "grill_me") return { ok: true, mode };

  const priorArt = parsed["priorArt"];
  if (!Array.isArray(priorArt) || priorArt.length === 0) {
    return {
      ok: false,
      field: "priorArt",
      reason:
        "grill_me report is missing required Section 10 (Prior Art). " +
        "The schema requires a non-empty list naming the channels searched " +
        "and the closest existing solution.",
    };
  }

  // Mirror the schema's `items: { type: "string", minLength: 1 }`.
  for (const item of priorArt) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        ok: false,
        field: "priorArt",
        reason:
          "grill_me report's priorArt contains a non-string or empty item; " +
          "every entry must be a non-empty string.",
      };
    }
  }

  // Deterrent for the literal `- None` / `None` placeholder. The parser
  // intentionally accepts these structurally; approve-time is where the
  // prompt's "do not write `- None`" rule turns into a hard refusal.
  // Only blocks when EVERY item is the None literal; a mixed list with
  // real content is accepted.
  const isNone = (x: unknown): boolean =>
    typeof x === "string" && ["none", "- none"].includes(x.trim().toLowerCase());
  if (priorArt.every(isNone)) {
    return {
      ok: false,
      field: "priorArt",
      reason:
        "grill_me report's priorArt is entirely literal `None` / `- None`. " +
        "The section exists to force a written answer to 'should this be " +
        "built at all'; name the channels searched and the closest existing tool.",
    };
  }

  return { ok: true, mode };
}

function rewriteReportApproved(
  filePath: string,
  approvedAt: string,
  approvedBy: string,
  sessionId: string,
): { previousStatus: string | null; sessionIdStamped: boolean } {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const previousStatus =
    typeof parsed["approvalStatus"] === "string" ? (parsed["approvalStatus"] as string) : null;
  parsed["approvalStatus"] = "approved";
  parsed["approvedAt"] = approvedAt;
  parsed["approvedBy"] = approvedBy;
  // `expiredAt` is `expirePersistedReport`'s stamp for how a report
  // reached "expired" (understanding-before-execution-runtime.ts); it
  // describes that specific past state, not the report's current one.
  // Approving a report that was previously expired must not let that
  // stale timestamp survive into the new snapshot, or the persisted
  // record becomes self-contradictory: {approvalStatus: "approved",
  // expiredAt: ...}. Mirrors the same idiom in the standalone package's
  // `withApprovalStatus` (agent-grounding PR #173 / 5120938c review
  // round 2). `delete` (not `= undefined`) so `JSON.stringify` below
  // drops the key entirely instead of serializing `"expiredAt": null`-
  // adjacent noise.
  delete parsed["expiredAt"];
  // Stamp the session id when the report lacks one (older Stop-hook
  // package versions write reports without a `sessionId` field). This
  // binds the report to the session that approved it, so every later
  // lookup strict-matches it and the sessionId-null tolerant fallback
  // can never re-adopt it for a different session (harness/0dce3880
  // friction #1). A report that already carries a sessionId is left
  // untouched — it is not this command's place to rewrite identity.
  let sessionIdStamped = false;
  const existing = parsed["sessionId"];
  if (typeof existing !== "string" || existing.length === 0) {
    parsed["sessionId"] = sessionId;
    sessionIdStamped = true;
  }
  atomicWriteFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { previousStatus, sessionIdStamped };
}

/**
 * Normalise a list of task ids supplied via `opts.tasks` (or the CLI's
 * variadic `--task`). Each entry is comma-split (so `--task a,b` and
 * `--task a b` are equivalent), trimmed, blank entries dropped, and the
 * result de-duplicated while preserving first-seen order.
 */
export function dedupeTaskIds(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const id = part.trim();
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export async function approveUnderstanding(
  opts: ApproveUnderstandingOptions = {},
): Promise<ApproveUnderstandingResult> {
  // harness.generated/ holds the `.pending-approval` staging file (the
  // third resolution tier below) and is the directory this command cleans
  // up after consuming a staged id. `resolvePaths` only computes paths —
  // it does not read or parse the manifest — so the lookup still works
  // even when the manifest itself is unparseable.
  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: resolvePaths(opts).base,
    });

  // Session id resolution, in precedence order:
  //   1. explicit --session flag
  //   2. $CLAUDE_CODE_SESSION_ID — the canonical Claude Code env, the
  //      variable Claude Code itself exports into the agent shell. Read
  //      first so the runtime's id wins over a manually exported legacy
  //      $CLAUDE_SESSION_ID that may not match.
  //   3. $CLAUDE_SESSION_ID — legacy / docs-name peer, kept for the
  //      Codex pre-tool-use hook's own fallback chain and for operators
  //      who set it by hand in older `!`-shell recipes.
  //   4. $CODEX_SESSION_ID (set inside a live Codex session — symmetric
  //      with the Codex pre-tool-use hook's own env fallback).
  //   5. the `.pending-approval` file the gate hook staged on its last
  //      block — this is what makes an arg-less `harness approve` work
  //      from the operator's `!`-shell, where neither of the above is set.
  //   6. the freshest persisted Understanding Report under <reportsDir>
  //      whose JSON `sessionId` field is non-null. Runtime-neutral
  //      fallback when the gate has not blocked yet (e.g. arg-less
  //      approval right after the agent produced an Understanding Report,
  //      before any tool call hit the gate to stage `.pending-approval`).
  //
  // Reports-dir resolution mirrors the downstream persisted-report write
  // path: explicit opts.reportsDir wins (test injection), then
  // UNDERSTANDING_GATE_REPORT_DIR env (honoured by defaultReportsDir),
  // then manifest-anchored fallback via resolvePaths. resolvePaths is
  // evaluated lazily so a test that injects opts.reportsDir does not
  // also need to inject homeDir/configPath to satisfy the
  // HARNESS_ALLOW_REAL_GENERATED_DIR loader guard.
  const reportsDir =
    opts.reportsDir ??
    defaultReportsDir(path.dirname(resolvePaths(opts).base));
  const resolved = resolveApprovalSessionId({
    session: opts.session,
    generatedDir,
    // Tier 6: guess the session from the freshest persisted report.
    // Restricted to `pending` reports. An `approved` / `expired`
    // report belongs to a finished gate cycle (often a different
    // session days ago); adopting its sessionId silently approves an
    // unrelated session while the live one stays gated
    // (harness/56f51f2b). A `pending` report is one the Stop hook
    // just produced that no approval has consumed yet, so it is far
    // more likely to be the current session's. This mirrors the
    // `tolerantFallback: "uncompleted"` restriction PR #218 applied
    // to the report-flip path below. The residual case — a stale
    // session left a never-approved `pending` report — is caught by
    // the loud newest-report warning the CLI prints, which names the report
    // file so the operator can verify before trusting the marker.
    newestReportFallback: () => {
      const newest = listPersistedReports(reportsDir).find(
        (r) => r.sessionId !== null && r.approvalStatus === "pending",
      );
      if (newest && newest.sessionId !== null) {
        return { sessionId: newest.sessionId, filePath: newest.filePath };
      }
      return null;
    },
  });
  const sessionId = resolved.sessionId;
  const sessionSource = resolved.sessionSource;
  const newestReportPath = resolved.newestReportPath;

  if (sessionId === "") {
    // Reaching here means: no --session flag, no $CLAUDE_CODE_SESSION_ID
    // / $CLAUDE_SESSION_ID / $CODEX_SESSION_ID env, no staged
    // `.pending-approval`, AND no `pending` persisted Understanding
    // Report under <reportsDir> carries a sessionId field. Either the
    // gate has never blocked this session and the agent never produced a
    // report, or every report is already approved/expired or
    // sessionId-null (tier 6 only adopts a fresh `pending` report).
    // Spell out the retrieval paths so the operator does not have to
    // dig through docs.
    throw new HarnessExitError(
      [
        "no session id available. Pass --session <id>, or set one of",
        "$CLAUDE_CODE_SESSION_ID (Claude Code) / $CLAUDE_SESSION_ID (legacy) /",
        "$CODEX_SESSION_ID (Codex).",
        "",
        `Both the understanding-gate PreToolUse hook AND \`harness session-start preflight\``,
        "stage the session id in",
        `  ${generatedDir}/.pending-approval`,
        "(the hook on block, the preflight on every run with a resolved id) so an",
        "arg-less `harness approve` works after either event. An empty result here means",
        "neither has fired for the current session yet, or the staging file was already consumed.",
        "",
        "Fastest fix: run `harness preflight` once, then re-run `harness approve",
        "understanding`. The preflight stages the staging file as a side effect.",
        "",
        "Other runtime-neutral recovery paths:",
        `  • Read the JSON \`sessionId\` field from the newest report under`,
        `      ${reportsDir}`,
        "    The agent writes one report per Understanding Report it produces,",
        "    so this is the canonical session-id source for both Claude Code",
        "    and Codex runtimes regardless of cwd.",
        "  • From inside the running agent: ask it to print its session id",
        "    (Claude Code exposes $CLAUDE_CODE_SESSION_ID; Codex exposes",
        "    $CODEX_SESSION_ID and also prints it in `codex doctor --json`).",
        "",
        "If approve writes the tag but the gate still blocks, the running",
        "session is using a different session id than the report you picked.",
        "In that case ask the agent to read its own session id and pass",
        "that exact value to --session.",
      ].join("\n"),
      EX_FAIL,
    );
  }

  // Manifest is required for the ledger write path; if it can't load,
  // we still try to flip the persisted report so a solo user benefits.
  let manifest: Manifest | null = null;
  let manifestLoadError: string | null = null;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch (err) {
    // Not blocking: a solo user still benefits from the report flip below
    // even with no manifest. But capture the cause so the degraded-ok
    // ledger result names WHY the write was skipped instead of leaving the
    // operator with a bare `ledger: ok false` (no-silent-errors, M8).
    manifestLoadError = err instanceof Error ? err.message : String(err);
  }

  // Gap-fill mode for a stdin report that declares none of its own
  // (harness task 5d73d78d): resolve via `resolveMode` (Env >
  // config.mode > DEFAULT_MODE — this IS a live runtime consumer, unlike
  // `resolve()`/`buildHooks`'s generation path; see `MODE_ENV`'s doc
  // comment in understanding-before-execution.ts for why the two differ),
  // from whatever manifest is available, so a report captured via this
  // path is validated against the operator's actually-configured mode
  // instead of a hardcoded "fast_confirm" regardless of harness.yaml. A
  // missing manifest, or a manifest without the pack declared, resolves
  // the same as an empty `config:` block — resolveMode still applies
  // Env > DEFAULT_MODE in that case.
  //
  // A pack entry that IS declared but `enabled: false` is treated the
  // SAME as undeclared (task 5d73d78d review LOW-10): a disabled pack's
  // hooks never ran, so its `config.mode` is not "the operator's live
  // mode" in any sense this gap-fill should honor. The synthesized
  // fallback only needs `name` + `config` (resolveMode's minimal
  // `ModeConfigSource` shape) — `source`/`enabled` would otherwise have
  // to be invented for a pack entry that, by construction, was never
  // matched.
  const declaredPack: ModeConfigSource = manifest?.policy_packs.find(
    (p) => p.name === UNDERSTANDING_PACK_NAME && p.enabled !== false,
  ) ?? { name: UNDERSTANDING_PACK_NAME, config: {} };
  // Task 5d73d78d review LOW (fix-round-3): `resolveMode`'s own warning
  // (an invalid `config.mode` or `UNDERSTANDING_GATE_MODE` value) used to
  // be dropped on the floor here — only `.mode` was read. The Codex
  // `UserPromptSubmit` injector (hook-codex-user-prompt-submit.ts)
  // already surfaces the identical warning shape to stderr on this same
  // `resolveMode` call; this path silently swallowed it, so an operator
  // with a typo'd `config.mode` got no signal at all from `harness
  // approve understanding`. Surfaced via `modeWarning` on the result so
  // the CLI can print it the same way the marker/ledger/report lines are
  // printed.
  const modeResolution = resolveMode(declaredPack);
  const resolvedMode = toPackageMode(modeResolution.mode);

  // Report capture from stdin (task 61fd36db): persist BEFORE the
  // lookup below so this very approve run selects, validates, and flips
  // the report the agent just attached. Session-bound via the resolved
  // sessionId, so the strict match wins over any stale leftovers.
  let stdinReport: StdinReportOutcome | undefined;
  if (typeof opts.reportMarkdown === "string" && opts.reportMarkdown.trim().length > 0) {
    stdinReport = persistStdinReport({
      markdown: opts.reportMarkdown,
      reportsDir,
      sessionId,
      now: opts.now ?? new Date(),
      mode: resolvedMode,
    });
  }

  // Approve-time validation. Resolve the report we would flip BEFORE
  // writing the marker, so a validation failure can short-circuit every
  // downstream write. The `latest` + `reports` values are reused later;
  // we do not list / find twice. The fallback age limit is what stops a
  // weeks-old sessionId-less leftover from being adopted, validated,
  // and stamped as if it were the live session's report when the
  // producer Stop hook silently failed (harness-discovery C1).
  const reports = listPersistedReports(reportsDir);
  const selection = selectReportForSession(reports, sessionId, {
    tolerantFallback: "uncompleted",
    maxFallbackAgeMs: TOLERANT_FALLBACK_MAX_AGE_MS,
    now: opts.now,
  });
  const latest = selection.report;
  let validation: ApproveUnderstandingResult["validation"];
  if (!latest) {
    validation = { skipped: true };
  } else {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(latest.filePath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      validation = { skipped: true };
    } else {
      const v = validatePersistedReport(parsed);
      validation = v.ok ? v : { ...v, enforced: !opts.force };
    }
  }

  // Task 5d73d78d review HIGH-2: a stdin report that was REJECTED (failed
  // to parse, e.g. because it does not meet the resolved mode's schema —
  // typically a fast_confirm-shaped report submitted against a
  // grill_me-configured host, see `resolvedMode` above) AND left no
  // persisted report to fall back on must not fall through to `{ skipped:
  // true }` above. "skipped" means "nothing was submitted to check"; here
  // something WAS submitted and it was refused. Before this fix, that
  // case still landed on `{ skipped: true }` (no `latest` report exists
  // yet, since persistStdinReport never wrote one), which is not an `ok:
  // false` validation outcome, so the enforced short-circuit below never
  // triggered and the marker was written anyway — silently approving a
  // session whose only report attempt was rejected.
  //
  // Fix-round-3 HIGH (5d73d78d review, verification round 2): the
  // original guard checked only `!latest`, but `latest` can also be a
  // sessionId-null report ADOPTED via `selectReportForSession`'s
  // `tolerantFallback: "uncompleted"` mode above (any pending, sessionId-
  // less report younger than `TOLERANT_FALLBACK_MAX_AGE_MS`). A rejected
  // stdin submission with such a leftover sitting on disk used to sail
  // through unconstrained: `latest` was truthy so this override never
  // fired, the ADOPTED (unrelated) report's own — already-valid — content
  // passed `validatePersistedReport` instead, and `rewriteReportApproved`
  // below then stamped the live session's id onto that foreign report and
  // wrote the marker: a session whose actual submission was refused got
  // silently approved anyway. The condition now also treats a fallback-
  // adopted `latest` as "nothing THIS session can claim":
  // `selection.fallbackAdopted` is `true` exactly when the match was NOT
  // a strict sessionId match.
  //
  // The deliberate carve-out for a genuine EARLIER same-session
  // submission stays: when `latest` is a STRICT sessionId match
  // (`selection.fallbackAdopted === false`), that report's own content
  // validation above already governs the outcome and this block does not
  // override it.
  if (
    typeof opts.reportMarkdown === "string" &&
    opts.reportMarkdown.trim().length > 0 &&
    stdinReport !== undefined &&
    stdinReport.ok === false &&
    (!latest || selection.fallbackAdopted)
  ) {
    validation = {
      ok: false,
      field: "stdinReport",
      reason: stdinReport.reason,
      enforced: !opts.force,
    };
  }

  // Short-circuit before any side effect if validation rejects and the
  // operator did not pass --force. No marker, no ledger tag, no report
  // flip — the gate stays closed and the audit trail records no
  // approval. The CLI surfaces this as a hard failure so the operator
  // does not believe they approved when they didn't.
  if ("ok" in validation && validation.ok === false && validation.enforced) {
    // Any --task / --tasks ids the operator passed are dropped on the
    // floor: pre-approving a batch alongside a session whose own report
    // failed validation would write task markers for a session that the
    // gate is still going to refuse. The CLI surfaces this empty array
    // alongside the rejection so an operator who batched several tasks
    // can see the batch was NOT pre-approved.
    return {
      sessionId,
      sessionSource,
      ...(newestReportPath !== undefined ? { newestReportPath } : {}),
      ...(modeResolution.warning !== null ? { modeWarning: modeResolution.warning } : {}),
      marker: {
        ok: false,
        reason: `validation failed (${validation.field}): ${validation.reason}`,
      },
      taskMarkers: [],
      ...(stdinReport !== undefined ? { stdinReport } : {}),
      ledger: {
        ok: false,
        tag: approvedLedgerTagFor(sessionId),
        reason: `skipped: ${validation.field} validation failed`,
      },
      persistedReport: {
        ok: false,
        reason: `skipped: ${validation.field} validation failed`,
      },
      validation,
    };
  }

  // Report-content hash the marker's signature binds to (harness/f9485cc7):
  // sha256 of the persisted report's raw bytes AT APPROVAL TIME, read
  // BEFORE `rewriteReportApproved` below flips its status/approvedAt/
  // approvedBy fields — this hashes what the operator actually reviewed,
  // not the post-approval-flip artefact. null when no persisted report was
  // resolved (ledger-only / --force paths have nothing to bind).
  //
  // This is GROUNDWORK ONLY, not yet enforced at gate-check time: nothing
  // today cross-checks the hash carried in a signed marker against the
  // CURRENTLY-selected persisted report, so on its own this does not stop
  // a stale-report adoption. The live cross-check ("does this marker's
  // reportContentHash match the report the gate is about to consult right
  // now") is the C1 staleness follow-up (task fa423e9b), out of scope
  // here; this just makes the binding exist and be forensically
  // inspectable so that follow-up can add the comparison without a
  // marker-format change.
  let reportContentHash: string | null = null;
  if (latest) {
    try {
      reportContentHash = sha256Hex(fs.readFileSync(latest.filePath, "utf8"));
    } catch {
      reportContentHash = null;
    }
  }

  // Write the canonical approval marker first. The gate consults this
  // file (not the ledger) since agent-tasks/88ca4bb3 closed the self-
  // approval backdoor: the agent has direct MCP access to the ledger,
  // but no path to write a file under harness.generated/.
  const approvedAtMarker = (opts.now ?? new Date()).toISOString();
  const approvedByMarker = opts.approvedBy ?? DEFAULT_APPROVED_BY;
  let markerResult: ApproveUnderstandingResult["marker"];
  try {
    const filePath = writeApprovalMarker(generatedDir, sessionId, {
      approvedAt: approvedAtMarker,
      approvedBy: approvedByMarker,
      reportContentHash,
    });
    markerResult = { ok: true, filePath, approvedAt: approvedAtMarker };
  } catch (err) {
    markerResult = {
      ok: false,
      reason: `failed to write approval marker: ${(err as Error).message}`,
    };
  }

  // Task-scoped markers (harness/1ee26e77 + v2 auto-resolve in
  // harness/494fd1e5 + multi-task batch in harness/0dce3880). Written
  // alongside the session marker. Resolution precedence:
  //   - opts.tasks (explicit, multi) — pre-approve a whole batch, OR
  //   - opts.task (explicit, single, back-compat), OR
  //   - the active-claim file (source: "active-claim").
  // A failure on any one id is surfaced loudly but does not abort the
  // approve flow; the session marker still satisfies the gate as a
  // fallback, and the other ids still get their markers.
  let resolvedTaskIds: string[] = [];
  let taskSource: "flag" | "active-claim" = "flag";
  if (opts.tasks && opts.tasks.length > 0) {
    resolvedTaskIds = dedupeTaskIds(opts.tasks);
    taskSource = "flag";
  } else if (typeof opts.task === "string" && opts.task.length > 0) {
    resolvedTaskIds = [opts.task];
    taskSource = "flag";
  } else {
    const fromFile = readActiveClaim(generatedDir);
    if (fromFile !== null) {
      resolvedTaskIds = [fromFile];
      taskSource = "active-claim";
    }
  }
  const taskMarkers: TaskMarkerOutcome[] = [];
  for (const taskId of resolvedTaskIds) {
    try {
      const filePath = writeTaskApprovalMarker(generatedDir, taskId, {
        approvedAt: approvedAtMarker,
        approvedBy: approvedByMarker,
        reportContentHash,
      });
      taskMarkers.push({
        ok: true,
        taskId,
        filePath,
        approvedAt: approvedAtMarker,
        source: taskSource,
      });
    } catch (err) {
      taskMarkers.push({
        ok: false,
        taskId,
        reason: `failed to write task marker: ${(err as Error).message}`,
        source: taskSource,
      });
    }
  }

  // Ledger tag content: a `--force`-bypass of a validation failure
  // stamps the bypass into the tag so audit can distinguish a clean
  // approval from one that overrode a structural rule. The base tag
  // shape (`understanding-approved:<session>`) stays intact so the gate
  // matcher still recognises it; the `:forced:<field>` suffix is
  // additive metadata.
  const tag =
    "ok" in validation && validation.ok === false
      ? `${approvedLedgerTagFor(sessionId)}:forced:${validation.field}`
      : approvedLedgerTagFor(sessionId);
  const ledgerResult = manifest
    ? await writeLedgerTag(manifest, sessionId, tag, opts)
    : {
        ok: false as const,
        reason: manifestLoadError
          ? `manifest unreadable (${manifestLoadError}); skipped ledger write`
          : "manifest unreadable; skipped ledger write",
      };

  // Persisted report: flip the latest matching one. `reports` + `latest`
  // were resolved up front (alongside validation) so both paths agree
  // on the same artefact.

  let persistedReport: ApproveUnderstandingResult["persistedReport"];
  if (!latest) {
    // When no matching report exists, look at the sibling parse-errors
    // directory (`<dir-of-reports>/../parse-errors/`, the path the
    // standalone @lannguyensi/understanding-gate Stop hook writes to
    // when its parser rejects the agent's last message). Surface the
    // newest entry's reason so "no reports found" becomes "the hook
    // fired but the parser rejected the report — here is why", rather
    // than a silent dead end.
    const parseErrorsDir = path.join(path.dirname(reportsDir), "parse-errors");
    const latestParseError = findLatestParseError(parseErrorsDir, sessionId);
    let reason: string;
    if (reports.length === 0) {
      reason = `no reports found at ${reportsDir}`;
      if (latestParseError) {
        reason += `; latest parse-error at ${latestParseError.filePath}: ${latestParseError.summary}`;
      }
    } else if (selection.staleRejected.length > 0) {
      // A sessionId-less pending report existed but exceeded the
      // fallback age limit. This is its own failure mode, distinct from
      // "no report": it usually means the live session's report was
      // never persisted and only an unrelated leftover was on disk —
      // exactly the artefact the limit refuses to bind (C1).
      const newest = selection.staleRejected[0]!;
      const age = formatAge(
        (opts.now ?? new Date()).getTime() - newest.createdAtMs,
      );
      const maxMin = Math.round(TOLERANT_FALLBACK_MAX_AGE_MS / 60_000);
      reason =
        `no report matched session_id=${sessionId}; rejected ${selection.staleRejected.length} ` +
        `stale sessionId-less candidate(s) for age (newest: ${newest.filePath}, ` +
        `created ${newest.createdAt ?? "<unknown>"}, age ${age} > max ${maxMin}m). ` +
        `If the agent just wrote an Understanding Report, the Stop hook likely failed to ` +
        `persist it; check ${parseErrorsDir}`;
      if (latestParseError) {
        reason += `; latest parse-error at ${latestParseError.filePath}: ${latestParseError.summary}`;
      }
    } else {
      reason = `no report matched session_id=${sessionId} (${reports.length} report(s) for other sessions)`;
    }
    persistedReport = { ok: false, reason };
  } else {
    const approvedAt = (opts.now ?? new Date()).toISOString();
    const approvedBy = opts.approvedBy ?? DEFAULT_APPROVED_BY;
    try {
      const { previousStatus, sessionIdStamped } = rewriteReportApproved(
        latest.filePath,
        approvedAt,
        approvedBy,
        sessionId,
      );
      persistedReport = {
        ok: true,
        filePath: latest.filePath,
        previousStatus,
        approvedAt,
        sessionIdStamped,
        ...(selection.fallbackAdopted
          ? {
              fallbackAdopted: {
                createdAt: latest.createdAt,
                ageMinutes: Math.round(
                  ((opts.now ?? new Date()).getTime() - latest.createdAtMs) / 60_000,
                ),
              },
            }
          : {}),
      };
    } catch (err) {
      persistedReport = {
        ok: false,
        reason: `failed to rewrite ${latest.filePath}: ${(err as Error).message}`,
      };
    }
  }

  // Drop the staging file once we have consumed it AND the canonical
  // (marker) write landed, so a later arg-less `harness approve` cannot
  // revive this id. A failed marker write keeps the file so the operator
  // can retry; an id supplied by flag/env was never "ours" to clean up.
  if (sessionSource === "pending-approval" && markerResult.ok) {
    clearPendingApproval(generatedDir);
  }

  return {
    sessionId,
    sessionSource,
    ...(newestReportPath !== undefined ? { newestReportPath } : {}),
    ...(modeResolution.warning !== null ? { modeWarning: modeResolution.warning } : {}),
    marker: markerResult,
    taskMarkers,
    ...(stdinReport !== undefined ? { stdinReport } : {}),
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
    persistedReport,
    validation,
  };
}
