// `harness pack hook branch-protection` — PreToolUse blocker for the
// `branch-protection` policy pack.
//
// Receives Claude Code's PreToolUse event JSON on stdin and emits a
// `{ decision: "block" }` envelope when the agent is about to mutate
// source on a protected branch without a satisfying ledger tag.
//
// Two paths satisfy the gate:
//
//   1. **Producer path** — a `branch:non-protected` tag exists in the
//      ledger from within the last 5 minutes (set by
//      `harness session-start branch-check` when the session opened on
//      a non-protected branch).
//
//   2. **Override path** — an operator-only approval marker file exists
//      at `harness.generated/.approvals/branch-protection-<sessionId>`,
//      written by `harness approve branch-protection` from outside the
//      gated shell to bless a deliberate protected-branch edit (version
//      bumps, CI workflow patches, hotfixes). The legacy
//      `branch-protection-ack:` LEDGER tag is NO LONGER trusted as an
//      override (audit finding #39): the agent has direct
//      `mcp__agent-grounding__ledger_add` access and could self-write the
//      tag to bless its own edit. The marker lives under
//      `harness.generated/`, which Edit / Write / Bash are all gated from
//      writing, so only a process the operator launched can produce it.
//      The ack ledger row is still recorded for audit and surfaced in the
//      diagnostics, but its presence alone never satisfies the gate.
//
// Failure mode: any error in load / parse / ledger query resolves to
// BLOCK. This is the inverse of understanding-before-execution's
// fail-open contract: branch-protection's whole job is to prevent
// edit-on-master incidents, so a bug in the blocker that silently
// allowed Writes through would defeat the purpose. The block envelope
// always names a recovery path so the operator is never wedged.

import * as path from "node:path";
import {
  queryLedgerByTag,
  type LedgerEntry,
} from "../../policies/index.js";
import {
  ACK_TAG_PREFIX,
  DEFAULT_PROTECTED_BRANCHES,
  NON_PROTECTED_TAG_PREFIX,
  PACK_NAME,
  PRODUCER_FRESHNESS_MS,
  checkBranchProtectionMarker,
  resolveProtectedBranches,
} from "../../policy-packs/builtin/branch-protection-runtime.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import { resolveGitContext } from "../../runtime/git-context.js";
import { POLICY_DECISION_TYPE } from "../../runtime/ledger-record.js";
import { renderAgentFacing } from "../../runtime/agent-facing.js";
import { PolicyUxSchema, type Manifest, type McpServer, type PolicyUx } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  readStdin,
} from "./hook-bootstrap.js";

export interface PackHookBranchProtectionOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Override "now" for deterministic freshness-window tests. */
  now?: Date;
  /** Override the cwd resolution (test injection). */
  cwd?: string;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject a manifest (test). */
  manifest?: Manifest;
  /**
   * Override the `harness.generated/` directory used to resolve the
   * operator-only override marker (test injection). When the real binary
   * loads the manifest from disk this is derived from the resolved
   * manifest path; an injected `manifest` has no on-disk path, so tests
   * that exercise the marker override path supply this directly.
   */
  generatedDir?: string;
  /** Inject a fake ledger query (test). */
  ledgerQuery?: (sessionId: string) => Promise<LedgerEntry[] | { degraded: string }>;
}

export interface PackHookBranchProtectionResult {
  exitCode: number;
  blocked: boolean;
  /** Diagnostic line emitted to stderr (always, even on allow). */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  cwd?: unknown;
  tool_input?: unknown;
}

/**
 * Pull the destination file path out of a PreToolUse event's `tool_input`
 * payload for the tools that mutate a single file. Returns null for tools
 * that don't have a single resolvable target (Bash, search tools, etc.) —
 * those keep cwd-based protection.
 *
 * Path-aware tools today: Write, Edit, MultiEdit, NotebookEdit.
 */
function extractTargetPath(toolName: string, toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  switch (toolName) {
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const fp = input["file_path"];
      return typeof fp === "string" && fp.length > 0 ? fp : null;
    }
    case "NotebookEdit": {
      const np = input["notebook_path"];
      return typeof np === "string" && np.length > 0 ? np : null;
    }
    default:
      return null;
  }
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

interface LedgerCheck {
  hasFreshProducer: boolean;
  hasAck: boolean;
  freshProducerContent: string | null;
  ackContent: string | null;
  totalEntries: number;
  degraded: string | null;
}

function evaluateEntries(entries: LedgerEntry[], now: Date): LedgerCheck {
  const cutoff = now.getTime() - PRODUCER_FRESHNESS_MS;
  let hasFreshProducer = false;
  let hasAck = false;
  let freshProducerContent: string | null = null;
  let ackContent: string | null = null;
  for (const e of entries) {
    // Skip policy_decision audit rows: their serialized payload
    // incidentally contains the tag they're about (e.g. a denied
    // decision the engine recorded for THIS pack would carry the
    // literal "branch:non-protected" or "branch-protection-ack" in
    // its JSON, falsely satisfying the gate). Two-tier filter
    // mirrors `src/policies/requires.ts:75-83`: by-type for current
    // ledger rows, by-content-prefix as a backstop for legacy rows
    // a pre-Phase-5-#4 ledger may still carry.
    if (e.type === POLICY_DECISION_TYPE) continue;
    if (e.content.startsWith(`${POLICY_DECISION_TYPE}:`)) continue;
    if (e.content.includes(ACK_TAG_PREFIX)) {
      hasAck = true;
      if (ackContent === null) ackContent = e.content;
      continue;
    }
    if (!e.content.includes(NON_PROTECTED_TAG_PREFIX)) continue;
    const ts = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts.getTime() >= cutoff) {
      hasFreshProducer = true;
      if (freshProducerContent === null) freshProducerContent = e.content;
    }
  }
  return {
    hasFreshProducer,
    hasAck,
    freshProducerContent,
    ackContent,
    totalEntries: entries.length,
    degraded: null,
  };
}

async function probeLedger(
  manifest: Manifest | null,
  sessionId: string,
  opts: PackHookBranchProtectionOptions,
): Promise<LedgerCheck> {
  if (opts.ledgerQuery) {
    const r = await opts.ledgerQuery(sessionId);
    if ("degraded" in r) {
      return {
        hasFreshProducer: false,
        hasAck: false,
        freshProducerContent: null,
        ackContent: null,
        totalEntries: 0,
        degraded: r.degraded,
      };
    }
    return evaluateEntries(r, opts.now ?? new Date());
  }
  if (!manifest) {
    return {
      hasFreshProducer: false,
      hasAck: false,
      freshProducerContent: null,
      ackContent: null,
      totalEntries: 0,
      degraded: "manifest unavailable",
    };
  }
  const server = findGroundingMcp(manifest);
  if (!server) {
    return {
      hasFreshProducer: false,
      hasAck: false,
      freshProducerContent: null,
      ackContent: null,
      totalEntries: 0,
      degraded: "grounding-mcp not declared in manifest",
    };
  }
  const command = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  const env = server.env ?? undefined;
  const timeoutMs = opts.ledgerTimeoutMs ?? server.health?.timeout_ms ?? 5_000;
  const result = await queryLedgerByTag({
    mcpCommand: command,
    ...(env && { mcpEnv: env }),
    sessionId,
    timeoutMs,
  });
  if (result.kind === "degraded") {
    return {
      hasFreshProducer: false,
      hasAck: false,
      freshProducerContent: null,
      ackContent: null,
      totalEntries: 0,
      degraded: result.reason,
    };
  }
  return evaluateEntries(result.entries, opts.now ?? new Date());
}

// Parse pack config.ux. Mirrors parseConfigUx in hook-pre-tool-use.ts
// and hook-codex-pre-tool-use.ts; a follow-up cleanup will extract the
// three copies into a shared helper once we have a fourth call site.
function parseConfigUx(
  raw: unknown,
  stderr: NodeJS.WritableStream,
): PolicyUx | undefined {
  if (raw === undefined) return undefined;
  const result = PolicyUxSchema.safeParse(raw);
  if (!result.success) {
    stderr.write(
      `harness pack hook branch-protection: config.ux ignored (${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")})\n`,
    );
    return undefined;
  }
  return result.data;
}

function blockJson(
  toolName: string,
  branch: string,
  detail: string,
  protectedList: readonly string[],
  ux: PolicyUx | undefined,
  sessionId: string,
): string {
  // When the pack config declares `ux:`, the agent-facing surface
  // becomes the plain-language `{ cannot, required, run }` shape and
  // the legacy "branch-protection: refusing ..." vocabulary is
  // suppressed. The stderr BLOCK diagnostic keeps the engine reason
  // (`detail`) for operator audit. `${BRANCH}` / `${TOOL_NAME}` /
  // `${SESSION_ID}` substitute against the pack runtime context.
  let reasonText: string;
  if (ux) {
    reasonText = renderAgentFacing(ux, {
      BRANCH: branch,
      TOOL_NAME: toolName,
      SESSION_ID: sessionId,
    });
  } else {
    const minutes = Math.round(PRODUCER_FRESHNESS_MS / 60000);
    reasonText =
      `branch-protection: refusing ${toolName} on protected branch "${branch}". ` +
      `${detail}\n` +
      `To proceed, cut a feature branch and re-run the producer:\n` +
      `  git checkout -b <feature-slug>\n` +
      `  harness session-start branch-check\n` +
      `Once the gate sees a fresh ${NON_PROTECTED_TAG_PREFIX} tag (within ${minutes}m), this tool call will succeed.\n` +
      `\n` +
      `Override (operator only): the operator runs, from an un-hooked shell:\n` +
      `  harness approve branch-protection --session ${sessionId}\n` +
      `which writes the canonical approval marker the gate consults. ` +
      `A \`${ACK_TAG_PREFIX}:<reason>\` ledger tag is no longer a sufficient override on its own ` +
      `(it is agent-writable); the marker file under harness.generated/ is the trusted signal.\n` +
      `\n` +
      `Protected branches: ${protectedList.join(", ")}.`;
  }
  return JSON.stringify({
    decision: "block",
    reason: reasonText,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasonText,
    },
  });
}

export async function runPackHookBranchProtectionCli(
  opts: PackHookBranchProtectionOptions = {},
): Promise<PackHookBranchProtectionResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness pack hook branch-protection: ${msg}\n`);
  };

  // Defensive stdin parse. Empty / malformed input resolves to BLOCK
  // (the inverse of understanding-before-execution's allow-on-malformed
  // default): we'd rather block a Write we couldn't classify than let
  // it through silently.
  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    /* event stays {} — handled by the sessionId check below */
  }

  // Pause sentinel — even branch-protection (the strictest gate) yields
  // to an operator pause. The whole point of the incident-mode flow is
  // pushing a hotfix to a protected branch when normal gates are in the
  // way.
  if (checkHookPause("branch-protection", stderr, opts).paused) {
    const diagnostic = "harness paused; branch-protection allowing without evaluating.";
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "(unknown)";
  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();

  // Load manifest to resolve the protected-branches list AND the
  // grounding-mcp wiring. A manifest load failure forces BLOCK with a
  // clear hint — we can't know if the gate should fire if we can't
  // read its config.
  // Resolved manifest path feeds the harness.generated/ lookup below (the
  // override-marker directory). An injected manifest (tests) has no
  // on-disk path, so `generatedDir` falls back to opts.generatedDir.
  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    const reason = `manifest load failed (${(err as Error).message}); refusing on failsafe`;
    const diagnostic = `BLOCK — ${reason}`;
    note(diagnostic);
    // Manifest didn't load, so no ux config to honour; legacy
    // envelope is the only available surface here.
    stdout.write(
      `${blockJson(toolName, "(unresolvable)", reason, DEFAULT_PROTECTED_BRANCHES, undefined, sessionId)}\n`,
    );
    return { exitCode: 0, blocked: true, diagnostic };
  }

  const pack = manifest.policy_packs.find((p) => p.name === PACK_NAME);
  if (!pack) {
    const diagnostic = `pack "${PACK_NAME}" not declared in manifest, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }
  if (!pack.enabled) {
    const diagnostic = `pack "${PACK_NAME}" is enabled:false, allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const { branches: protectedList } = resolveProtectedBranches(pack);
  const configUx = parseConfigUx(
    (pack.config as Record<string, unknown>)["ux"],
    stderr,
  );

  // Resolve the branch context to gate against. For tools that target a
  // single file (Write, Edit, MultiEdit, NotebookEdit), the relevant
  // branch is whatever repo OWNS the target path — not cwd. Without this
  // step, a Write to `~/.claude/memory/foo.md` from inside a checkout on
  // a protected branch would be wrongly blocked, even though the target
  // is outside any repo (memory files), or inside an unrelated repo, and
  // the protection rules of cwd's repo have no bearing on it. For
  // path-less tools (Bash, etc.) we fall back to cwd as before.
  const targetPath = extractTargetPath(toolName, event.tool_input);
  let branchSourceDir = cwd;
  let branchSource: "target" | "cwd" = "cwd";
  if (targetPath !== null) {
    const absTarget = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(cwd, targetPath);
    branchSourceDir = path.dirname(absTarget);
    branchSource = "target";
  }
  const { branch } = resolveGitContext(branchSourceDir);

  // Outside a git work tree (or detached HEAD) we can't tell what the
  // edit would land on. We choose to allow here — the alternative is
  // blocking every Write in non-git workspaces, which would be hostile
  // to standalone-script workflows and to writes that target machine
  // state under $HOME / /tmp. A detached HEAD on an in-repo target also
  // lands here; arguably should block, but detached-HEAD edits don't
  // auto-push to a protected ref so the downstream
  // `preflight-before-push` gate still catches the actual hazard.
  if (branch === "") {
    const diagnostic = `${branchSource} is not on a named branch (detached HEAD or outside a git work tree); allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  if (!protectedList.includes(branch)) {
    const diagnostic = `branch "${branch}" is not in the protected list (${protectedList.join(", ")}); allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  // On a protected branch: probe the ledger for either gate path.
  if (sessionId === "") {
    const reason = `no session_id resolvable from stdin or $CLAUDE_CODE_SESSION_ID/$CLAUDE_SESSION_ID; cannot consult ledger`;
    const diagnostic = `BLOCK — ${reason}`;
    note(diagnostic);
    stdout.write(`${blockJson(toolName, branch, reason, protectedList, configUx, sessionId)}\n`);
    return { exitCode: 0, blocked: true, diagnostic };
  }

  const check = await probeLedger(manifest, sessionId, opts);

  // Override path (operator-only). The canonical override signal is a
  // marker file under harness.generated/.approvals/ that only a process
  // the operator launched can write — NOT the `branch-protection-ack`
  // ledger tag, which the agent can self-write via its own ledger_add MCP
  // access (audit finding #39; the understanding gate closed the identical
  // backdoor in agent-tasks/88ca4bb3). The ledger ack, if present, is
  // surfaced as a best-effort audit echo only. `generatedDir` is
  // unresolvable only on the test-injection path (an injected manifest has
  // no on-disk path and no opts.generatedDir); there the override is
  // simply unavailable and the gate falls through to the producer check.
  const generatedDir =
    opts.generatedDir ??
    (manifestPath !== undefined
      ? resolveGeneratedDir({
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          manifestPath,
        })
      : undefined);
  // Best-effort audit echo of the now-untrusted ledger ack, appended to
  // diagnostics so an operator chasing the gate can see the historic tag
  // without it being mistaken for the thing that opened (or failed to
  // open) the gate.
  const ackEcho = check.hasAck
    ? ` [audit: ledger ${check.ackContent ?? ACK_TAG_PREFIX} present, no longer satisfies the gate]`
    : "";
  if (generatedDir !== undefined) {
    const markerCheck = checkBranchProtectionMarker(generatedDir, sessionId);
    if (markerCheck.matched) {
      const diagnostic = `branch-protection override marker active (${markerCheck.detail}); allowing${ackEcho}`;
      note(diagnostic);
      return { exitCode: 0, blocked: false, diagnostic };
    }
  }
  if (check.hasFreshProducer) {
    const diagnostic = `fresh producer tag (${check.freshProducerContent ?? NON_PROTECTED_TAG_PREFIX}); allowing`;
    note(diagnostic);
    return { exitCode: 0, blocked: false, diagnostic };
  }

  const why =
    check.degraded !== null
      ? `ledger degraded (${check.degraded}); refusing on failsafe`
      : `no fresh ${NON_PROTECTED_TAG_PREFIX} tag (${check.totalEntries} entries scanned) and no operator override marker${ackEcho}`;
  const diagnostic = `BLOCK — ${why}`;
  note(diagnostic);
  stdout.write(`${blockJson(toolName, branch, why, protectedList, configUx, sessionId)}\n`);
  return { exitCode: 0, blocked: true, diagnostic };
}
