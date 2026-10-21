import type { Command } from "commander";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { sessionExport, type ExportFormat } from "./session-export/index.js";

export function registerAuditGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
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
}
