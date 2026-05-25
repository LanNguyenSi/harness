// Phase 7 #6 — `harness approve risk [--session <id>]` CLI verb.
//
// The operator's grant for a Risk Gate `require_approval` decision.
// When `harness policy intercept` blocks a risky action with outcome
// `require_approval`, the policy's `requires:` names a `risk-approved:
// ${SESSION_ID}` ledger tag; this verb writes that tag so the next
// evaluation of the same policy passes and the outcome becomes `allow`.
//
// Deliberately simpler than `harness approve understanding`: the Risk
// Gate's requires-evaluator reads the evidence ledger (it is the same
// Phase 4 evaluator), so an ordinary `ledger_add` entry IS the approval.
// There is no persisted-report flip and no filesystem marker — the
// ledger tag is the single source of truth, exactly as Phase 7's design
// (docs/risk-gate.md "Decision model") specifies. `agent-grounding`
// needs no change: it already stores arbitrary tags through `ledger_add`.

import { addLedgerFact } from "../../runtime/ledger-add.js";
import {
  readPendingApproval,
  resolveGeneratedDir,
} from "../../runtime/pending-approval.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "../exit-codes.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";

export interface ApproveRiskOptions extends LoaderOptions {
  /** Explicit session id (overrides $CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID / $CODEX_SESSION_ID). */
  session?: string;
  /**
   * Operator-deliberate override of a Risk Gate `deny` decision. Writes
   * `risk-override:${SESSION_ID}:forced:<reason-slug>` instead of the
   * default `risk-approved:${SESSION_ID}` tag, so the built-in
   * `gate-prod-destructive` policy (which gates on `risk-override:`,
   * see `src/cli/init/templates.ts`) clears. `deny` is by design not
   * approvable, so this path is hard-gated behind operator-only checks:
   * a TTY stdin OR explicit `iAmTheOperator` acknowledgement is
   * required, mirroring `harness pause`. The reason becomes part of the
   * audit trail and is sanitised to a tag-safe slug.
   */
  force?: { reason: string };
  /**
   * Acknowledge a non-TTY / scripted invocation of `--force`. Without
   * this flag a non-TTY `--force` refuses with a usage error.
   */
  iAmTheOperator?: boolean;
  /**
   * Override `process.stdin.isTTY` for tests; mirrors the pause/resume
   * seam so the non-TTY refusal can be exercised hermetically.
   */
  stdinIsTTY?: boolean;
  /** Override the harness.generated/ directory (test injection). */
  generatedDir?: string;
  /** Inject a manifest (test); bypasses `loadManifest`. */
  manifest?: Manifest;
  /** Override the ledger writer (test). */
  ledgerAdd?: (
    sessionId: string,
    content: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ApproveRiskResult {
  sessionId: string;
  /** Where `sessionId` came from — surfaced so the operator can sanity-check it. */
  sessionSource:
    | "flag"
    | "env-claude-code"
    | "env-claude"
    | "env-codex"
    | "pending-approval";
  /**
   * True when the verb wrote a `risk-override:` tag via `--force`
   * instead of the default `risk-approved:`. The CLI surfaces this so
   * the operator can see at a glance that they exercised the deny-tier
   * override, not a clean require_approval approval.
   */
  forced: boolean;
  ledger: { ok: boolean; tag: string; reason?: string };
}

const RISK_APPROVED_PREFIX = "risk-approved";
const RISK_OVERRIDE_PREFIX = "risk-override";

/** The evidence-ledger tag a Risk Gate `require_approval` policy consults. */
export function riskApprovedTagFor(sessionId: string): string {
  return `${RISK_APPROVED_PREFIX}:${sessionId}`;
}

/**
 * The evidence-ledger tag a Risk Gate `deny`-tier policy with
 * `requires.ledger_tag: risk-override:${SESSION_ID}` consults. The
 * `:forced:<reason>` suffix is additive metadata: the built-in
 * policy's matcher pins the `risk-override:<session>` substring, so the
 * suffix never affects whether the gate clears. It exists for the
 * audit trail (`harness audit` can grep `:forced:` to surface every
 * operator-deliberate override).
 */
export function riskOverrideTagFor(sessionId: string, reason: string): string {
  return `${RISK_OVERRIDE_PREFIX}:${sessionId}:forced:${sanitiseReasonSlug(reason)}`;
}

/**
 * Reduce an operator-supplied free-form reason to a tag-safe slug. Keeps
 * `[A-Za-z0-9._-]`, collapses any other run to a single `-`, trims
 * leading / trailing `-`, lowercases, caps at 64 chars. An empty result
 * (e.g. the operator passed only punctuation) is rejected upstream.
 */
function sanitiseReasonSlug(reason: string): string {
  const slug = reason
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "operator-override";
}

function refuseForcedIfNonTTY(opts: ApproveRiskOptions): void {
  if (!opts.force) return;
  if (opts.iAmTheOperator === true) return;
  // Deliberate divergence from `harness pause`'s twin guard
  // (`src/cli/pause/index.ts`'s `refuseIfAgentShell`): this verb is
  // designed to be runnable from inside `!`-prefixed Claude Code shells
  // where `$CLAUDE_SESSION_ID` is set (the session-id resolver below
  // reads it as a fallback tier). Refusing on that env var would gut
  // the `! ` UX. Operator intent is gated by the non-empty `<reason>`
  // and the TTY / `--i-am-the-operator` check; that is sufficient.
  const tty = opts.stdinIsTTY !== undefined ? opts.stdinIsTTY : process.stdin.isTTY === true;
  if (tty) return;
  throw new HarnessExitError(
    [
      "harness approve risk --force refuses to run with non-TTY stdin (looks scripted).",
      "",
      "This is the load-bearing guardrail against `--force` becoming an agent-driven",
      "bypass of a deny-tier Risk Gate decision. Run the verb from your own operator",
      "shell (in Claude Code: prefix the command with `! `), or pass --i-am-the-operator",
      "to acknowledge a one-off recovery script.",
    ].join("\n"),
    EX_USAGE,
  );
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

async function writeLedgerTag(
  manifest: Manifest,
  sessionId: string,
  content: string,
  opts: ApproveRiskOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.ledgerAdd) return opts.ledgerAdd(sessionId, content);
  const server = findGroundingMcp(manifest);
  if (!server) {
    return { ok: false, reason: "grounding-mcp not declared in manifest" };
  }
  // No `~` expansion here: `addLedgerFact` expands leading `~/` in every
  // command token itself, so a second pass would be dead work.
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  return addLedgerFact({
    mcpCommand: command,
    ...(server.env && { mcpEnv: server.env }),
    timeoutMs: server.health?.timeout_ms ?? 5_000,
    sessionId,
    content,
    source: "harness-approve-risk",
  });
}

/**
 * Resolve the target session id and write its `risk-approved:` ledger
 * tag. Session id precedence mirrors `harness approve understanding`
 * tiers 1-4: explicit `--session`, then `$CLAUDE_CODE_SESSION_ID`
 * (the var Claude Code itself sets), then `$CLAUDE_SESSION_ID` (legacy
 * / docs name), then `$CODEX_SESSION_ID`, then the `.pending-approval`
 * file the gate hook staged on its last block. There is no
 * persisted-report tier-5 guess: the Risk Gate produces no persisted
 * reports.
 *
 * Throws `HarnessExitError(EX_FAIL)` when no session id can be resolved.
 * A degraded ledger (grounding-mcp absent / unreachable) is surfaced in
 * the result, not thrown — same best-effort contract as `approve
 * understanding`'s ledger write.
 */
export async function approveRisk(
  opts: ApproveRiskOptions = {},
): Promise<ApproveRiskResult> {
  // --force is operator-deliberate; guard before any side effect. The
  // session-id resolution below intentionally still runs the agent-shell
  // env tier (CLAUDE_CODE_SESSION_ID etc.), since the operator may be
  // running from `!` with --i-am-the-operator and the session id has to
  // come from somewhere.
  refuseForcedIfNonTTY(opts);

  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: resolvePaths(opts).base,
    });

  let sessionId = "";
  let sessionSource: ApproveRiskResult["sessionSource"] = "flag";
  if (typeof opts.session === "string" && opts.session.length > 0) {
    sessionId = opts.session;
    sessionSource = "flag";
  } else if (
    typeof process.env.CLAUDE_CODE_SESSION_ID === "string" &&
    process.env.CLAUDE_CODE_SESSION_ID.length > 0
  ) {
    // Canonical: the var Claude Code actually exports into the agent
    // shell. Read before the legacy $CLAUDE_SESSION_ID so an operator
    // who has both set (e.g. a manual export plus the runtime export)
    // gets the runtime's id, not whatever they typed by hand.
    sessionId = process.env.CLAUDE_CODE_SESSION_ID;
    sessionSource = "env-claude-code";
  } else if (
    typeof process.env.CLAUDE_SESSION_ID === "string" &&
    process.env.CLAUDE_SESSION_ID.length > 0
  ) {
    sessionId = process.env.CLAUDE_SESSION_ID;
    sessionSource = "env-claude";
  } else if (
    typeof process.env.CODEX_SESSION_ID === "string" &&
    process.env.CODEX_SESSION_ID.length > 0
  ) {
    sessionId = process.env.CODEX_SESSION_ID;
    sessionSource = "env-codex";
  } else {
    const staged = readPendingApproval(generatedDir);
    if (staged !== null) {
      sessionId = staged;
      sessionSource = "pending-approval";
    }
  }

  if (sessionId === "") {
    throw new HarnessExitError(
      [
        "no session id available. Pass --session <id>, or set one of",
        "$CLAUDE_CODE_SESSION_ID (Claude Code) / $CLAUDE_SESSION_ID (legacy) /",
        "$CODEX_SESSION_ID (Codex).",
        "",
        "The understanding-gate PreToolUse hook and `harness preflight` both stage the",
        `session id in ${generatedDir}/.pending-approval, so an arg-less`,
        "`harness approve risk` works after either has fired. An empty result means",
        "neither has run for the current session yet.",
        "",
        "From inside the running agent you can also read the id directly:",
        "Claude Code exposes $CLAUDE_CODE_SESSION_ID; Codex exposes $CODEX_SESSION_ID.",
      ].join("\n"),
      EX_FAIL,
    );
  }

  // The manifest is needed only for the grounding-mcp command. If it
  // cannot load, the ledger write degrades to a surfaced warning rather
  // than aborting — the operator still learns the resolved session id.
  let manifest: Manifest | null = null;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
  } catch {
    /* swallow; ledger write becomes a degraded-ok */
  }

  // Forced override writes a different tag prefix (`risk-override:`)
  // that the deny-tier `gate-prod-destructive` policy template consults.
  // The audit-only `:forced:<reason>` suffix lets `harness audit` and
  // `harness explain --trace` distinguish a clean require_approval
  // approval from a deliberate deny override.
  const forced = opts.force !== undefined;
  const tag = forced
    ? riskOverrideTagFor(sessionId, opts.force!.reason)
    : riskApprovedTagFor(sessionId);
  const ledgerResult = manifest
    ? await writeLedgerTag(manifest, sessionId, tag, opts)
    : { ok: false as const, reason: "manifest unreadable; skipped ledger write" };

  return {
    sessionId,
    sessionSource,
    forced,
    ledger: ledgerResult.ok
      ? { ok: true, tag }
      : { ok: false, tag, reason: ledgerResult.reason },
  };
}
