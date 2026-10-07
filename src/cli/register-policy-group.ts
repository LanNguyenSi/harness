import type { Command } from "commander";
import { runInterceptCli } from "./policy/intercept.js";

export function registerPolicyGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const policy = program.command("policy").description("Policy runtime verbs");
  policy
    .command("intercept")
    .description(
      "PreToolUse hook entrypoint: read tool-event JSON from stdin, evaluate matching policies, emit Claude Code deny JSON on block. " +
        "Stdin shape (per Claude Code hook protocol): " +
        "{ session_id, hook_event_name, tool_name, tool_input, cwd?, transcript_path? }. " +
        "hook_event_name is required for any policy to match; if missing or unmatched, a one-line diagnostic is written to stderr.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .option(
      "--verbose",
      "emit a stderr diagnostic block for each non-allow decision (also enabled by HARNESS_POLICY_VERBOSE=1)",
    )
    .option(
      "--hook <name>",
      "manifest hook name (injected by `harness apply` for the Codex projection so failure logs identify which hook fired)",
    )
    .action(async (options: {
      config?: string;
      project?: string;
      ledgerTimeout?: string;
      verbose?: boolean;
      hook?: string;
    }) => {
      const cliOpts: Parameters<typeof runInterceptCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      if (options.verbose) cliOpts.verbose = options.verbose;
      if (options.hook) cliOpts.hookName = options.hook;
      await runInterceptCli(cliOpts);
    });
}
