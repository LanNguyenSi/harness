import type { Command } from "commander";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { audit, type AuditOutcome } from "./audit.js";
import { sessionExport, type ExportFormat } from "./session-export/index.js";
import { dryRun } from "./dry-run.js";

export function registerAuditGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
  program
    .command("audit")
    .description(
      "Replay policy decisions from the evidence ledger for a time window, plus an approvals section listing raw understanding-gate approval facts",
    )
    .option("--since <duration>", "time window (default: 24h)")
    .option("--policy <name>", "filter to a single policy by name")
    .option(
      "--outcome <outcome>",
      "filter by decision outcome (allow / warn / require_approval / deny / warn-degraded / deny-degraded)",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--session <id>", "grounding session whose audit log to read (default: $CLAUDE_SESSION_ID, then 'default')")
    .option("--json", "emit JSON instead of a table")
    .action(async (options: {
      since?: string;
      policy?: string;
      outcome?: string;
      config?: string;
      project?: string;
      session?: string;
      json?: boolean;
    }) => {
      const auditOpts: Parameters<typeof audit>[0] = {};
      if (options.since) auditOpts.since = options.since;
      if (options.policy) auditOpts.policy = options.policy;
      if (options.outcome) auditOpts.outcome = options.outcome as AuditOutcome;
      if (options.config) auditOpts.configPath = options.config;
      if (options.project) auditOpts.project = options.project;
      if (options.session) auditOpts.sessionId = options.session;
      if (options.json) auditOpts.json = options.json;
      const result = await audit(auditOpts);
      stdout(result.output);
    });

  program
    .command("session-export [sessionId]")
    .description(
      "Export a chronological audit artifact joining the on-disk transcript JSONL and the evidence ledger for a session",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--format <fmt>",
      "output format: json (default) or jsonl",
      "json",
    )
    .option("-o, --out <file>", "write the export to <file> instead of stdout")
    .action(
      async (
        sessionIdArg: string | undefined,
        options: { config?: string; project?: string; format?: string; out?: string },
      ) => {
        const fmt = options.format ?? "json";
        if (fmt !== "json" && fmt !== "jsonl") {
          throw new HarnessExitError(
            `unknown --format "${fmt}"; expected json or jsonl`,
            EX_USAGE,
          );
        }
        const exportOpts: Parameters<typeof sessionExport>[0] = {
          format: fmt as ExportFormat,
        };
        if (sessionIdArg) exportOpts.sessionId = sessionIdArg;
        if (options.config) exportOpts.configPath = options.config;
        if (options.project) exportOpts.project = options.project;
        if (options.out) exportOpts.outFile = options.out;
        const result = await sessionExport(exportOpts);
        if (!options.out) {
          stdout(result.output);
        } else {
          stdout(`session-export wrote ${result.events.length} events to ${options.out}\n`);
        }
      },
    );

  program
    .command("dry-run <prompt>")
    .description(
      "Statically predict which hooks fire / policies match / memories route for a prompt",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--tool <name>", "simulate a PreToolUse event for this tool name")
    .option("--tool-args <json>", "JSON for tool_input (default: {})")
    .option("--json", "emit JSON instead of YAML")
    .action((prompt: string, options: {
      config?: string;
      project?: string;
      tool?: string;
      toolArgs?: string;
      json?: boolean;
    }) => {
      const dryRunOpts: Parameters<typeof dryRun>[1] = {};
      if (options.config) dryRunOpts.configPath = options.config;
      if (options.project) dryRunOpts.project = options.project;
      if (options.tool) dryRunOpts.tool = options.tool;
      if (options.toolArgs) dryRunOpts.toolArgs = options.toolArgs;
      if (options.json) dryRunOpts.json = options.json;
      const result = dryRun(prompt, dryRunOpts);
      stdout(result.output);
    });
}
