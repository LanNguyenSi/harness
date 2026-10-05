import type { Command } from "commander";
import { issueDelegation } from "./index.js";
import { InvalidDurationError, parseDurationSeconds } from "../../policies/index.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "../exit-codes.js";

export function registerDelegate(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
  // `harness delegate` (Slice 3 of docs/decisions/2026-08-27-ug-auto-mode-approval.md,
  // agent-tasks 37ad0b05): issue a signed pre-authorization for a
  // headless `claude -p` child session, bound to an already-approved
  // PARENT session. NOT an approval: the child still writes and gets its
  // own Understanding Report checked by its own PreToolUse hook before
  // its auto-marker is minted. Writes harness.generated/.delegations/,
  // never .approvals/.
  program
    .command("delegate")
    .description(
      "Issue a signed delegation for a headless `claude -p` child session, bound to " +
        "an already-approved parent session (pre-authorization, not an approval: the " +
        "child still writes and gets its own Understanding Report checked). Writes " +
        "harness.generated/.delegations/<child-sid>, never .approvals/. Consumption is " +
        "Claude Code only: the Codex adapter has no delegation consumer, so a Codex " +
        "session cannot be the delegated child. A Codex session CAN be the delegating " +
        "parent today (parent resolution reads $CODEX_SESSION_ID and accepts any " +
        "validly signed marker). See docs/decisions/2026-08-27-ug-auto-mode-approval.md.",
    )
    .requiredOption(
      "--child-session <uuid>",
      "session id of the claude -p child this delegation authorizes (UUID)",
    )
    .option(
      "--cwd <path>",
      "bind the delegation to this working directory; at least one of --cwd/--task is required",
    )
    .option(
      "--task <id>",
      "bind the delegation to this agent-tasks task id; at least one of --cwd/--task is required",
    )
    .option(
      "--ttl <duration>",
      "delegation lifetime (e.g. 30m, 1h); default: the pack's approval_lifecycle.max_age when set, else 1h",
    )
    .option(
      "--report <path>",
      "fallback shape: copy the child's Understanding Report to harness.generated/.delegation-reports/<child-sid>.md and bind it by content + that conventional path's hash at spawn time; the child's PreToolUse hook reads it back from there, see the pack doc",
    )
    .option(
      "--session-id <id>",
      "explicit parent session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then $CODEX_SESSION_ID, then staged .pending-approval)",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .action(
      async (options: {
        childSession: string;
        cwd?: string;
        task?: string;
        ttl?: string;
        report?: string;
        sessionId?: string;
        config?: string;
        project?: string;
      }) => {
        // Usage-level check ahead of every deeper resolution, with the
        // exact message the ADR slice 3 acceptance criterion pins.
        // `issueDelegation` carries the identical check (reason
        // "no-binding") for callers that invoke it directly (the smoke
        // runner, tests) without going through commander's flag parsing.
        if (options.cwd === undefined && options.task === undefined) {
          throw new HarnessExitError(
            "a delegation must bind a cwd or a task",
            EX_FAIL,
          );
        }
        let ttlSeconds: number | undefined;
        if (options.ttl) {
          try {
            ttlSeconds = parseDurationSeconds(options.ttl);
          } catch (err) {
            if (err instanceof InvalidDurationError) {
              throw new HarnessExitError(`--ttl: ${err.message}`, EX_USAGE);
            }
            throw err;
          }
        }
        const cliOpts: Parameters<typeof issueDelegation>[0] = {
          childSessionId: options.childSession,
        };
        // `!== undefined` (not truthy), agreeing with the usage check
        // above: a truthy check would silently drop an explicit `--cwd
        // ''` / `--task ''` instead of letting `issueDelegation` refuse
        // it with `invalid-cwd` / `invalid-task` (L3 fix, agent-tasks
        // 37ad0b05).
        if (options.cwd !== undefined) cliOpts.cwd = options.cwd;
        if (options.task !== undefined) cliOpts.taskId = options.task;
        if (ttlSeconds !== undefined) cliOpts.ttlSeconds = ttlSeconds;
        if (options.report) cliOpts.reportPath = options.report;
        if (options.sessionId) cliOpts.parentSessionId = options.sessionId;
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;

        const result = await issueDelegation(cliOpts);
        if (!result.ok) {
          throw new HarnessExitError(
            `delegate refused (${result.reason}): ${result.detail}`,
            EX_FAIL,
          );
        }
        const lines: string[] = [
          `delegation: ✓ ${result.filePath} (child ${result.childSessionId}, parent ${result.parentSessionId}, expires ${result.expiresAt})`,
        ];
        if (result.ledgerFact.written) {
          lines.push(
            `ledger:     ✓ wrote understanding-delegated:${result.childSessionId}:${result.parentSessionId} (audit only)`,
          );
        } else {
          lines.push(
            `ledger:     ⚠ skipped (${result.ledgerFact.reason ?? "unknown"}) (audit only)`,
          );
        }
        stdout(`${lines.join("\n")}\n`);
      },
    );
}
