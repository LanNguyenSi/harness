import type { Command } from "commander";
import { escapeForDisplay } from "../io/display-path.js";
import { approveBranchProtection } from "./approve/branch-protection.js";
import { approveRisk } from "./approve/risk.js";
import { approveUnderstanding } from "./approve/understanding.js";
import { readPipedStdin } from "./approve/stdin-report.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";

export function registerApproveGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
  // `harness approve` (Phase 6 #4): operator-driven approval verbs.
  // Today only `understanding` is implemented; other packs can plug in
  // sister sub-commands (e.g. `harness approve preflight`) without
  // restructuring this surface.
  const approveCmd = program
    .command("approve")
    .description("Operator-driven approval verbs (writes evidence-ledger tags + flips persisted artefacts)");

  approveCmd
    .command("understanding")
    .description(
      "Mark the latest Understanding Report as approved AND write the evidence-ledger tag. " +
        "Writes the signed approval marker and round-trips the audit records (persisted report, ledger row) " +
        "so harnessed and solo (@lannguyensi/understanding-gate) stacks stay in sync.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then $CODEX_SESSION_ID, then staged .pending-approval, then newest pending Understanding Report)",
    )
    .option(
      "--task <ids...>",
      "agent-tasks task id(s): writes one task-scoped marker per id. Pass several (--task a b c, or --task a,b,c) to pre-approve a whole batch in a single operator action so a multi-task session does not re-prompt for each task it claims (outside approval_lifecycle mode: session the session approval covers only the task claimed when it was granted, and a done, abandoned or merged task expires it) (harness/1ee26e77, harness/0dce3880, harness 5018c0c4)",
    )
    .option("--reports-dir <path>", "override the persisted-report directory (default: ./.understanding-gate/reports)")
    .option("--approved-by <actor>", "actor to record on the persisted report (default: harness-approve-cli)")
    .option(
      "--force",
      "bypass approve-time report validation (priorArt enforcement on grill_me reports). Writes the marker / ledger / report-flip anyway and stamps the ledger tag with `:forced:<field>` so audit can distinguish forced approvals from clean ones. Emergency-unblock path: default refuses the marker when a grill_me report fails validation. Also overrides the nesting-depth refusal (the marker is then signed with no content binding); never overrides the size refusal (also on the pretty-printed approval rewrite), an unreadable report, or one that is not a regular file.",
    )
    .action(
      async (options: {
        config?: string;
        project?: string;
        session?: string;
        task?: string[];
        reportsDir?: string;
        approvedBy?: string;
        force?: boolean;
      }) => {
        const cliOpts: Parameters<typeof approveUnderstanding>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.session) cliOpts.session = options.session;
        // Commander's variadic `<ids...>` yields a string[]; comma-split
        // and de-dup happen inside approveUnderstanding (dedupeTaskIds).
        if (options.task && options.task.length > 0) cliOpts.tasks = options.task;
        if (options.reportsDir) cliOpts.reportsDir = options.reportsDir;
        if (options.approvedBy) cliOpts.approvedBy = options.approvedBy;
        if (options.force) cliOpts.force = true;
        // Report capture (task 61fd36db): the agent attaches the
        // Understanding Report as a quoted heredoc on stdin. A TTY stdin
        // means an interactive operator shell with nothing piped — skip
        // the read entirely so the CLI never sits waiting for input.
        // Incomplete input (timeout, error, size cap) is refused rather
        // than captured: a truncated-but-parseable report must never be
        // persisted and approved as if it were whole.
        let stdinIncomplete = false;
        if (!process.stdin.isTTY) {
          const piped = await readPipedStdin(process.stdin);
          if (piped.text.trim().length > 0) {
            if (piped.complete) cliOpts.reportMarkdown = piped.text;
            else stdinIncomplete = true;
          }
        }
        const result = await approveUnderstanding(cliOpts);
        const lines: string[] = [];
        // Annotate non-explicit session sources so the operator can spot
        // a wrong id before it lands in the ledger.
        const sourceNote =
          result.sessionSource === "pending-approval"
            ? " (resolved from .pending-approval staged by the gate hook)"
            : result.sessionSource === "env-claude-code"
              ? " (from $CLAUDE_CODE_SESSION_ID)"
              : result.sessionSource === "env-claude"
                ? " (from $CLAUDE_SESSION_ID)"
                : result.sessionSource === "env-codex"
                  ? " (from $CODEX_SESSION_ID)"
                  : result.sessionSource === "newest-report"
                    ? " (GUESSED from the newest pending Understanding Report)"
                    : "";
        lines.push(`session: ${escapeForDisplay(result.sessionId)}${sourceNote}`);
        if (result.sessionSource === "newest-report") {
          // Tier-5 is a guess: no --session, no env var, no gate-staged
          // .pending-approval. It is restricted to `pending` reports
          // (harness/56f51f2b), but a stale session that left a never-
          // approved report can still be picked. Name the report file
          // so the operator can open it and confirm the id before
          // trusting a marker that may approve the wrong session.
          lines.push("");
          lines.push("⚠ WARNING: the session id was GUESSED, not confirmed. There was no");
          lines.push("  --session flag, no $CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID /");
          lines.push("  $CODEX_SESSION_ID, and no");
          lines.push("  gate-staged .pending-approval, so it was read from the newest pending");
          lines.push("  Understanding Report:");
          if (result.newestReportPath) {
            lines.push(`    ${escapeForDisplay(result.newestReportPath)}`);
          }
          lines.push("  If that is not your live session, the marker above approves the wrong");
          lines.push("  session and the gate stays blocked. Confirm the id matches the running");
          lines.push("  agent ($CLAUDE_CODE_SESSION_ID / $CLAUDE_SESSION_ID / $CODEX_SESSION_ID); if it differs, re-run");
          lines.push("  with --session <live-id>.");
        }
        if (result.modeWarning) {
          lines.push(`mode:    ⚠ ${result.modeWarning}`);
        }
        if (result.marker.ok) {
          lines.push(`marker:  ✓ ${escapeForDisplay(result.marker.filePath)} (canonical gate signal)`);
        } else {
          lines.push(`marker:  ✗ FAILED (${escapeForDisplay(result.marker.reason)})`);
          lines.push(
            "  the gate WILL block the next tool call until the marker exists.",
          );
        }
        for (const tm of result.taskMarkers) {
          const sourceNote =
            tm.source === "active-claim"
              ? " (auto-resolved from active-claim file)"
              : "";
          if (tm.ok) {
            lines.push(
              `task:    ✓ ${tm.filePath} (task-scoped, expires when this task ends)${sourceNote}`,
            );
          } else {
            lines.push(`task:    ✗ FAILED for task ${tm.taskId}${sourceNote} (${tm.reason})`);
            lines.push(
              "  the session marker above is still in effect; the task-scoped path is degraded.",
            );
          }
        }
        if (result.activeClaimRefused !== undefined) {
          lines.push(`claim:   ⚠ ${escapeForDisplay(result.activeClaimRefused)}`);
          lines.push(
            "  the session marker is bound to no task and will not satisfy the task-bound gate; repair or remove",
          );
          lines.push("  the active-claim entry, then approve again.");
        }
        if (result.taskMarkers.length > 1) {
          const okCount = result.taskMarkers.filter((t) => t.ok).length;
          lines.push(
            `         (${okCount}/${result.taskMarkers.length} task markers written — the batch is pre-approved)`,
          );
        }
        if (result.ledger.ok) {
          lines.push(`ledger:  ✓ wrote ${escapeForDisplay(result.ledger.tag)} (audit only)`);
        } else {
          lines.push(`ledger:  ⚠ skipped (${result.ledger.reason ?? "unknown"}) (audit only)`);
        }
        if (stdinIncomplete) {
          lines.push(
            "stdin:   ⚠ piped input arrived incomplete (timeout, stream error, or size cap) — report NOT captured.",
          );
          lines.push(
            "  the approval itself proceeds below; re-run with the report as a quoted heredoc to persist the audit trail.",
          );
        }
        if (result.stdinReport) {
          if (result.stdinReport.ok) {
            lines.push(`stdin:   ✓ report captured from stdin → ${result.stdinReport.filePath}`);
          } else {
            lines.push(`stdin:   ⚠ report on stdin NOT captured (${result.stdinReport.reason})`);
            if (result.stdinReport.parseErrorLogPath) {
              lines.push(`  raw text + parser reasons kept at ${result.stdinReport.parseErrorLogPath}`);
            }
            // Task 5d73d78d review MEDIUM (fix-round-3): this line used to
            // print unconditionally, but since HIGH-2 a rejected stdin
            // submission with nothing else to fall back on REFUSES the
            // approval (marker.ok === false) — "the approval itself
            // proceeds below" was then simply false. It only still holds
            // when a genuine earlier same-session report (the HIGH-2
            // carve-out) governs approval instead, i.e. when the marker
            // WAS written despite this submission being rejected.
            if (result.marker.ok) {
              lines.push(
                "  the approval itself proceeds below; re-run with a schema-conform report to persist the audit trail.",
              );
            } else {
              lines.push(
                "  the approval is REFUSED — no marker, no ledger tag, no report flip; see `validation` below for why.",
              );
            }
          }
        }
        if (result.persistedReport.ok) {
          const prev = result.persistedReport.previousStatus ?? "<missing>";
          const stampNote = result.persistedReport.sessionIdStamped
            ? "; stamped sessionId"
            : "";
          lines.push(
            `report:  ✓ ${escapeForDisplay(result.persistedReport.filePath)} (approvalStatus: ${escapeForDisplay(prev)} → approved${stampNote})`,
          );
          const fb = result.persistedReport.fallbackAdopted;
          if (fb) {
            lines.push(
              `  ⚠ adopted via sessionId-less fallback: created ${escapeForDisplay(fb.createdAt ?? "<unknown>")} (${fb.ageMinutes}m ago).`,
            );
            lines.push(
              "  The live session's report was never persisted, or an older producer",
              "  wrote it without a sessionId. Verify this is the report you just read",
              "  before trusting the approval.",
            );
          }
        } else {
          lines.push(`report:  ⚠ skipped (${result.persistedReport.reason})`);
        }
        // Surface the validation outcome explicitly. Three cases:
        //   - ok: report was loaded and structurally compliant for its mode.
        //   - failure-enforced: short-circuited, no writes ran. Hard error.
        //   - failure-forced: writes ran, ledger tag carries `:forced:`.
        //   - skipped: no report loaded; nothing to validate.
        const v = result.validation;
        if ("ok" in v && v.ok) {
          // mode === null is the legacy / pre-v0.4.0 case the validator
          // waives by design (the schema bump must not retroactively
          // reject historical reports). Distinguish it from a positive
          // check so the operator does not read "passed" and assume the
          // grill_me priorArt rule actually fired.
          if (v.mode === null) {
            lines.push("validation: ⓘ legacy report (no mode field) — priorArt rule waived");
          } else {
            lines.push(`validation: ✓ ${escapeForDisplay(v.mode)} report passed structural checks`);
          }
        } else if ("ok" in v && v.ok === false) {
          if (v.enforced) {
            lines.push(
              `validation: ✗ ${v.field} FAILED: ${v.reason}`,
            );
            lines.push("  the marker was NOT written; the gate stays closed.");
            lines.push(
              "  pass --force to bypass a content check (the ledger tag will be stamped `:forced:<field>` for audit); a report that is oversized, not a regular file or unreadable cannot be forced.",
            );
          } else {
            lines.push(
              `validation: ⚠ ${v.field} failed but --force bypassed (${v.reason})`,
            );
            lines.push(
              "  the marker IS written; the ledger tag carries a `:forced:` suffix for audit.",
            );
          }
        }
        stdout(`${lines.join("\n")}\n`);

        // Non-zero exit when validation refused the approval. Throwing
        // HarnessExitError reaches the CLI entrypoint's catch-all and
        // surfaces both the lines above and the chosen exit code so the
        // operator sees the rejection and shell pipelines (`&&`,
        // CI guards) can react.
        if ("ok" in v && v.ok === false && v.enforced) {
          throw new HarnessExitError(
            `approve refused: ${v.field} validation failed. ` +
              `Run with --force to bypass a content check (the ledger tag will be stamped \`:forced:${v.field}\` for audit); a report that is oversized, not a regular file or unreadable cannot be forced.`,
            EX_FAIL,
          );
        }
      },
    );

  approveCmd
    .command("risk")
    .description(
      "Grant a Risk Gate require_approval decision (default), or deliberately override " +
        "a deny-tier block with --force <reason>. The default path writes the " +
        "risk-approved:${SESSION_ID} ledger tag the production-scoped require_approval " +
        "policy's requires consults; --scope deletion writes " +
        "risk-approved:deletion:${SESSION_ID} instead, for the dev-context deletion arm " +
        "only; --force writes risk-override:${SESSION_ID}:forced:<reason> for the " +
        "deny-tier policy. Operator action.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then $CODEX_SESSION_ID, then staged .pending-approval)",
    )
    .option(
      "--scope <scope>",
      "restrict the ledger tag to one Risk Gate arm instead of the shared production tag; only 'deletion' is recognized (writes risk-approved:deletion:${SESSION_ID} for gate-dev-unsafe-deletion). Omit for the default production-scoped tag. Ignored with --force.",
    )
    .option(
      "--force <reason>",
      "operator-deliberate override of a deny-tier Risk Gate block; writes the risk-override tag with the reason stamped into the audit trail",
    )
    .option(
      "--i-am-the-operator",
      "acknowledge a scripted / non-TTY --force invocation (otherwise refused)",
    )
    .action(
      async (options: {
        config?: string;
        project?: string;
        session?: string;
        scope?: string;
        force?: string;
        iAmTheOperator?: boolean;
      }) => {
        const cliOpts: Parameters<typeof approveRisk>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.session) cliOpts.session = options.session;
        if (options.scope !== undefined) {
          if (options.scope !== "deletion") {
            throw new HarnessExitError(
              `--scope "${options.scope}" is not recognized; the only supported value is "deletion".`,
              EX_USAGE,
            );
          }
          cliOpts.scope = "deletion";
        }
        if (typeof options.force === "string") {
          const reason = options.force.trim();
          if (reason.length === 0) {
            throw new HarnessExitError(
              "--force requires a non-empty <reason>; the reason is recorded in the audit trail.",
              EX_USAGE,
            );
          }
          cliOpts.force = { reason };
        }
        if (options.iAmTheOperator) cliOpts.iAmTheOperator = true;
        const result = await approveRisk(cliOpts);
        const lines: string[] = [];
        const sourceNote =
          result.sessionSource === "pending-approval"
            ? " (resolved from .pending-approval staged by the gate hook)"
            : result.sessionSource === "env-claude-code"
              ? " (from $CLAUDE_CODE_SESSION_ID)"
              : result.sessionSource === "env-claude"
                ? " (from $CLAUDE_SESSION_ID)"
                : result.sessionSource === "env-codex"
                  ? " (from $CODEX_SESSION_ID)"
                  : "";
        lines.push(`session: ${result.sessionId}${sourceNote}`);
        if (result.ledger.ok) {
          lines.push(`ledger:  ✓ wrote ${result.ledger.tag}`);
          if (result.forced) {
            lines.push(
              "  deny-tier override recorded; the deny-tier Risk Gate policy now passes for this session.",
            );
          } else {
            lines.push(
              "  the Risk Gate require_approval policy now passes for this session.",
            );
          }
        } else {
          lines.push(`ledger:  ✗ FAILED (${result.ledger.reason ?? "unknown"})`);
          if (result.forced) {
            lines.push(
              "  the deny-tier override stays unrecorded; the gate keeps blocking.",
            );
          } else {
            lines.push(
              "  the require_approval gate stays blocked until the tag is recorded.",
            );
          }
        }
        stdout(`${lines.join("\n")}\n`);
      },
    );

  approveCmd
    .command("branch-protection")
    .description(
      "Bless a deliberate protected-branch edit for one session. Writes the canonical " +
        "operator-only approval marker under harness.generated/.approvals/ that the " +
        "branch-protection blocker consults, plus a best-effort branch-protection-ack " +
        "ledger row for audit. Operator action: the marker (not the ledger tag) is the " +
        "trusted override, because the ledger is agent-writable.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then $CODEX_SESSION_ID, then staged .pending-approval)",
    )
    .option(
      "--reason <text>",
      "free-form note recorded in the audit ledger tag (why the override fired)",
    )
    .option("--approved-by <actor>", "actor to record on the marker (default: harness-approve-cli)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        session?: string;
        reason?: string;
        approvedBy?: string;
      }) => {
        const cliOpts: Parameters<typeof approveBranchProtection>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.session) cliOpts.session = options.session;
        if (options.reason) cliOpts.reason = options.reason;
        if (options.approvedBy) cliOpts.approvedBy = options.approvedBy;
        const result = await approveBranchProtection(cliOpts);
        const lines: string[] = [];
        const sourceNote =
          result.sessionSource === "pending-approval"
            ? " (resolved from .pending-approval staged by the gate hook)"
            : result.sessionSource === "env-claude-code"
              ? " (from $CLAUDE_CODE_SESSION_ID)"
              : result.sessionSource === "env-claude"
                ? " (from $CLAUDE_SESSION_ID)"
                : result.sessionSource === "env-codex"
                  ? " (from $CODEX_SESSION_ID)"
                  : "";
        lines.push(`session: ${result.sessionId}${sourceNote}`);
        if (result.marker.ok) {
          lines.push(`marker:  ✓ ${result.marker.filePath} (canonical gate signal)`);
          lines.push(
            "  the branch-protection gate now allows protected-branch edits for this session.",
          );
        } else {
          lines.push(`marker:  ✗ FAILED (${result.marker.reason})`);
          lines.push(
            "  the gate WILL keep blocking the next tool call until the marker exists.",
          );
        }
        if (result.ledger.ok) {
          lines.push(`ledger:  ✓ wrote ${result.ledger.tag} (audit only)`);
        } else {
          lines.push(`ledger:  ⚠ skipped (${result.ledger.reason ?? "unknown"}) (audit only)`);
        }
        stdout(`${lines.join("\n")}\n`);
      },
    );
}
