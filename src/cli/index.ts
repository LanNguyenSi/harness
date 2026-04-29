import { Command } from "commander";
import { describe, isPillar, type Pillar } from "./describe.js";
import { diff as diffRun } from "./diff/index.js";
import { doctor } from "./doctor/index.js";
import { format as formatDoctor } from "./doctor/format.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { explain } from "./explain.js";
import { isListCategory, list, type ListCategory } from "./list.js";
import { formatReport, validate } from "./validate/index.js";

export interface RunOptions {
  argv?: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export function buildProgram(opts: RunOptions = {}): Command {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const program = new Command();
  program
    .name("harness")
    .description("Declarative control plane for agent harnesses")
    .version("0.1.0-pre.1")
    .configureOutput({
      writeOut: stdout,
      writeErr: stderr,
    })
    .exitOverride((err) => {
      throw new HarnessExitError(err.message, err.exitCode || EX_USAGE);
    });

  program
    .command("describe")
    .description("Print the effective merged manifest")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option(
      "--pillar <pillar>",
      "filter output to one section: grounding | tools | memory | hooks | policies",
    )
    .option("--json", "emit JSON instead of YAML")
    .action((options: { config?: string; project?: string; pillar?: string; json?: boolean }) => {
      let pillar: Pillar | undefined;
      if (options.pillar !== undefined) {
        if (!isPillar(options.pillar)) {
          throw new HarnessExitError(
            `unknown pillar "${options.pillar}"; expected one of grounding, tools, memory, hooks, policies`,
            EX_USAGE,
          );
        }
        pillar = options.pillar;
      }

      const result = describe({
        configPath: options.config,
        project: options.project,
        pillar,
        json: options.json,
      });
      stdout(result.output);
      if (!result.output.endsWith("\n")) stdout("\n");
    });

  program
    .command("validate")
    .description("Lint the manifest + referenced assets")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--strict", "promote warnings to errors")
    .action((options: { config?: string; project?: string; strict?: boolean }) => {
      const result = validate({
        configPath: options.config,
        project: options.project,
        strict: options.strict,
      });
      const report = formatReport(result);
      if (result.diagnostics.length > 0) stderr(report);
      else stdout(report);
      if (result.errorCount > 0) {
        throw new HarnessExitError("", EX_FAIL);
      }
    });

  program
    .command("doctor")
    .description("Health summary across all pillars")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--shallow", "skip MCP probes (CLI --version probes still run); report manifest-reference state only")
    .action(async (options: { config?: string; project?: string; shallow?: boolean }) => {
      const report = await doctor({
        configPath: options.config,
        project: options.project,
        shallow: options.shallow,
      });
      stdout(formatDoctor(report));
    });

  program
    .command("list <category>")
    .description("Flat denormalised listing per category: mcp / cli / skills / memories / hooks / policies")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--filter <substr>", "case-insensitive substring filter on name (or path for memories)")
    .option("--json", "emit JSON array instead of an aligned text table")
    .action(
      (
        category: string,
        options: { config?: string; project?: string; filter?: string; json?: boolean },
      ) => {
        if (!isListCategory(category)) {
          throw new HarnessExitError(
            `unknown list category "${category}"; expected one of mcp, cli, skills, memories, hooks, policies`,
            EX_USAGE,
          );
        }
        const result = list(category as ListCategory, {
          configPath: options.config,
          project: options.project,
          filter: options.filter,
          json: options.json,
        });
        stdout(result.output);
      },
    );

  program
    .command("diff")
    .description("Diff the current manifest against a git ref (--since-apply lands in Phase 3)")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--since <ref>", "git ref to diff against")
    .action((options: { config?: string; project?: string; since?: string }) => {
      const result = diffRun({
        configPath: options.config,
        project: options.project,
        since: options.since,
      });
      stdout(result.output);
    });

  program
    .command("explain <policy>")
    .description("Print a single policy's schema-level definition (Phase 1: no --trace)")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit JSON instead of YAML")
    .action(
      (
        policyName: string,
        options: { config?: string; project?: string; json?: boolean },
      ) => {
        const result = explain(policyName, {
          configPath: options.config,
          project: options.project,
          json: options.json,
        });
        stdout(result.output);
      },
    );

  return program;
}

export async function run(opts: RunOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2);
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const program = buildProgram(opts);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof HarnessExitError) {
      if (err.exitCode !== 0 && err.message) stderr(`${err.message}\n`);
      return err.exitCode;
    }
    stderr(`${(err as Error).message ?? err}\n`);
    return 70;
  }
}
