import type { Command } from "commander";
import { createCliHelpers } from "./cli-helpers.js";
import {
  runRecordDogfood,
  runRecordReview,
  runRecordReviewSubagent,
} from "./record/index.js";

export function registerRecordSessionGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { applyLedgerTimeout, reportRecordResult } = createCliHelpers(io);
  // `harness record {review,review-subagent,dogfood}` (task T-001):
  // evidence-ledger producers for the review-before-merge,
  // review-subagent-before-pr-create, and dogfood-before-release gate
  // families (see src/cli/init/templates.ts for the exact policies).
  // These are NOT hooks: they are invoked deliberately by an agent or
  // operator, so a failure exits non-zero with a clear stderr message
  // (written by the runner itself) rather than degrading silently.
  const recordCmd = program
    .command("record")
    .description(
      "Evidence-ledger producers for the review / review-subagent / dogfood gate families. " +
        "Interactive verbs (not hooks): a failure exits non-zero.",
    );

  recordCmd
    .command("review <summary>")
    .description(
      "Record a review:${PR_NUMBER} + review:${BRANCH} (+ review:${BASE}, + review:${TASK_ID} " +
        "with --task) fact for the review-before-merge / review-before-merge-bash / " +
        "review-before-task-merge / review-before-task-finish-automerge gates.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .requiredOption("--pr <number>", "PR number the review:${PR_NUMBER} tag is namespaced by")
    .option(
      "--base <branch>",
      "base branch for the review:${BASE} tag. Default: the remote's default branch read from " +
        "refs/remotes/origin/HEAD (packed-refs fallback included); omitted with a stderr warning " +
        "when neither resolves. No `gh` shell-out.",
    )
    .option("--branch <name>", "explicit branch override for review:${BRANCH} (default: current git branch)")
    .option(
      "--task <id>",
      "agent-tasks task id for the review:${TASK_ID} tag the task_merge / task_finish(autoMerge) gates read. " +
        "Optional; pass it and one recorded review satisfies all four merge surfaces.",
    )
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then newest Claude Code transcript)",
    )
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(
      async (
        summary: string,
        options: {
          config?: string;
          project?: string;
          pr: string;
          base?: string;
          branch?: string;
          task?: string;
          session?: string;
          ledgerTimeout?: string;
        },
      ) => {
        const cliOpts: Parameters<typeof runRecordReview>[0] = { pr: options.pr, summary };
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.base) cliOpts.base = options.base;
        if (options.branch) cliOpts.branch = options.branch;
        if (options.task !== undefined) cliOpts.task = options.task;
        if (options.session) cliOpts.session = options.session;
        applyLedgerTimeout(options.ledgerTimeout, cliOpts);
        reportRecordResult(await runRecordReview(cliOpts));
      },
    );

  recordCmd
    .command("review-subagent [summary]")
    .description(
      "Record a review-subagent:${TASK_ID} + review-subagent:${BRANCH} fact for the " +
        "review-subagent-before-pr-create / review-subagent-before-pr-create-bash gates. " +
        "Exactly one of --task or --adhoc is required; --adhoc (work without an agent-tasks " +
        "task) writes review-subagent:${BRANCH} only.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--task <id>", "agent-tasks task id the review-subagent:${TASK_ID} tag is namespaced by (exactly one of --task or --adhoc)")
    .option("--adhoc", "record for work without an agent-tasks task: writes review-subagent:${BRANCH} only, no task tag (exactly one of --task or --adhoc)")
    .requiredOption("--verdict <text>", "reviewer verdict recorded in the fact content")
    .option("--branch <name>", "explicit branch override for review-subagent:${BRANCH} (default: current git branch)")
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then newest Claude Code transcript)",
    )
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(
      async (
        summary: string | undefined,
        options: {
          config?: string;
          project?: string;
          task?: string;
          adhoc?: boolean;
          verdict: string;
          branch?: string;
          session?: string;
          ledgerTimeout?: string;
        },
      ) => {
        const cliOpts: Parameters<typeof runRecordReviewSubagent>[0] = {
          verdict: options.verdict,
        };
        if (options.task !== undefined) cliOpts.task = options.task;
        if (options.adhoc) cliOpts.adhoc = true;
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.branch) cliOpts.branch = options.branch;
        if (options.session) cliOpts.session = options.session;
        if (summary) cliOpts.summary = summary;
        applyLedgerTimeout(options.ledgerTimeout, cliOpts);
        reportRecordResult(await runRecordReviewSubagent(cliOpts));
      },
    );

  recordCmd
    .command("dogfood <summary>")
    .description(
      "Record a dogfood:${SESSION_ID} fact for the dogfood-before-release gate.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then newest Claude Code transcript)",
    )
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(
      async (
        summary: string,
        options: {
          config?: string;
          project?: string;
          session?: string;
          ledgerTimeout?: string;
        },
      ) => {
        const cliOpts: Parameters<typeof runRecordDogfood>[0] = { summary };
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.session) cliOpts.session = options.session;
        applyLedgerTimeout(options.ledgerTimeout, cliOpts);
        reportRecordResult(await runRecordDogfood(cliOpts));
      },
    );
}
