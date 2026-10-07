import type { Command } from "commander";
import { createCliHelpers } from "./register-smoke-group.js";
import {
  runRecordDogfood,
  runRecordReview,
  runRecordReviewSubagent,
} from "./record/index.js";
import { runSessionStartBranchCheck } from "./session-start/branch-check.js";
import { runSessionStartToolchainParity } from "./session-start/toolchain-parity.js";
import { runSessionStartStaleBaseCheck } from "./session-start/stale-base-check.js";
import {
  addCwdOption,
  addIdentityOptions,
  addLedgerTimeoutOption,
  applyCliOptions,
  type SessionStartCliOptions,
  type SessionStartCliTarget,
} from "./session-start/shared-options.js";

export function registerRecordSessionGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { applyLedgerTimeout, reportRecordResult, preflightAction } =
    createCliHelpers(io);
  // `harness record {review,review-subagent,dogfood}` (task T-001):
  // evidence-ledger producers for the review-before-merge,
  // review-subagent-before-pr-create, and dogfood-before-release gate
  // families (see src/cli/init/templates.ts for the exact policies).
  // Unlike the `preflight` / `session-start preflight` pair above,
  // these are NOT hooks: they are invoked deliberately by an agent or
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

  const sessionStart = program
    .command("session-start")
    .description("SessionStart hook entrypoints (called by Claude Code via settings.json)");
  addLedgerTimeoutOption(
    addIdentityOptions(
      sessionStart
        .command("preflight")
        .description(
          "SessionStart producer: run agent-preflight against the session cwd and, on a ready:true result, " +
            "record a `preflight:${REPO}` fact to the evidence ledger so the preflight-before-* policies have a " +
            "fresh tag to match. Reads SessionStart event JSON from stdin ({ session_id, cwd, hook_event_name }). " +
            "Opt-in `session_start_preflight.setup: true` (default off) passes --setup through; " +
            "see docs/CLI.md for the trust and scope caveats. " +
            "blocking:false \u2014 every failure path logs to stderr and exits 0.",
        ),
      "explicit session id (overrides stdin event + env). Use for manual / scripted invocations " +
        "where no SessionStart event JSON is piped on stdin. Without it the resolver tries " +
        "stdin event → $CLAUDE_SESSION_ID → newest Claude Code transcript → 'default' (which logs " +
        "a loud warning since the literal 'default' session never satisfies a preflight-before-* gate).",
    ).option("--timeout <ms>", "agent-preflight subprocess timeout in milliseconds (default 60000)"),
  ).action(preflightAction);
  // The three advisory producers below share one option set and one
  // action shape: only the description and the runner differ.
  const addSessionStartProducer = (
    name: string,
    description: string,
    run: (opts: SessionStartCliTarget) => Promise<unknown>,
  ): void => {
    addLedgerTimeoutOption(
      addCwdOption(
        addIdentityOptions(
          sessionStart.command(name).description(description),
          "explicit session id (overrides stdin event + env)",
        ),
      ),
    ).action(async (options: SessionStartCliOptions) => {
      const cliOpts: SessionStartCliTarget = {};
      applyCliOptions(options, cliOpts);
      await run(cliOpts);
    });
  };
  addSessionStartProducer(
    "branch-check",
    "SessionStart producer for the branch-protection pack: read .git/HEAD for the session cwd and, " +
      "when the branch is NOT in the operator's protected list (default: master, main, develop), " +
      "record a `branch:non-protected:<branch>` fact to the evidence ledger so the pack's PreToolUse " +
      "blocker has a fresh tag to satisfy its 5-minute freshness window. Also runnable on demand from " +
      "the operator's shell. blocking:false \u2014 every failure path logs to stderr and exits 0.",
    runSessionStartBranchCheck,
  );
  addSessionStartProducer(
    "toolchain-parity",
    "SessionStart producer (opt-in via `toolchain_parity.enabled: true`): writes THIS machine's " +
      "toolchain snapshot (node version, npm globals, OW-Kit version, MCP server names) to " +
      "`<machine_state_dir>/<profile>.json`, compares it against every OTHER snapshot file already " +
      "in that directory, and records a `toolchain-parity:ok` / `toolchain-parity:drift:<n>` fact " +
      "(with a `:unparseable-peer:<n>` suffix whenever a peer file failed to parse as JSON, so an " +
      "unparseable peer never silently vanishes from the comparison) to the evidence ledger. " +
      "Purely advisory \u2014 never blocking, and never touches a peer's file. " +
      "Cross-machine transport of the snapshot files is agent-memory-sync's job, not this command's.",
    runSessionStartToolchainParity,
  );
  addSessionStartProducer(
    "stale-base-check",
    "SessionStart producer (opt-in via `stale_base_check.enabled: true`; task ce3903b0, incident " +
      "ea8becf5): runs a LIVE `git fetch` of the remote default branch (never trusting the local " +
      "origin/<default> ref, which can itself be stale \u2014 that is the exact bug this closes) and, when " +
      "the current branch's base is behind, writes a WARNING to stderr naming how many commits behind, " +
      "how old the missing work is, and the recovery command. Records a `stale-base:ok` / " +
      "`stale-base:behind:<n>` fact to the evidence ledger (audit-only \u2014 no gate consumes it). " +
      "Purely advisory: never blocks, and degrades cleanly (no fact written) when offline, the remote " +
      "or default branch can't be resolved, or credentials are missing. blocking:false \u2014 every failure " +
      "path logs to stderr and exits 0.",
    runSessionStartStaleBaseCheck,
  );
}
