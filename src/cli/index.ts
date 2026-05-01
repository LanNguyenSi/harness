import { Command } from "commander";
import { add } from "./add/index.js";
import type { AddEntry } from "./add/mutate.js";
import { adopt } from "./adopt/index.js";
import {
  apply,
  DRIFT_HINT_MESSAGE,
  type FileApplyOutcome,
} from "./apply/index.js";
import { isRemoveType, KNOWN_REMOVE_TYPES, remove } from "./remove/index.js";
import { describe, isPillar, type Pillar } from "./describe.js";
import { diff as diffRun } from "./diff/index.js";
import { diffSinceApply } from "./diff/since-apply.js";
import { exportManifest } from "./export.js";
import { doctor } from "./doctor/index.js";
import { format as formatDoctor } from "./doctor/format.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { explain } from "./explain.js";
import { init, isTemplate, KNOWN_TEMPLATES } from "./init/index.js";
import { isListCategory, list, type ListCategory } from "./list.js";
import { audit, type AuditOutcome } from "./audit.js";
import { dryRun } from "./dry-run.js";
import { runInterceptCli } from "./policy/intercept.js";
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
    .version("0.4.0")
    .configureOutput({
      writeOut: stdout,
      writeErr: stderr,
    })
    .exitOverride((err) => {
      // Commander exits with code 0 + writes the help/version text itself for
      // --help and --version. Suppress our re-throw on those so we don't get
      // a duplicate stderr line + a non-zero exit on a successful display.
      if (err.exitCode === 0) {
        throw new HarnessExitError("", 0);
      }
      // unknownOption / unknownCommand / missingArgument exit 1 by default.
      // Map them to EX_USAGE per ARCHITECTURE §9 sysexits, and pass empty
      // message because Commander already wrote the human-readable text.
      const code = err.exitCode === 1 ? EX_USAGE : (err.exitCode ?? EX_USAGE);
      throw new HarnessExitError("", code);
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
    .description(
      "Diff the manifest against a git ref (--since <ref>) or against the last " +
        "applied state (--since-apply). --memory-detail expands per-memory-dir " +
        "Merkle drift back to per-file changes.",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--since <ref>", "git ref to diff against")
    .option("--since-apply", "diff against harness.generated/.last-apply")
    .option("--memory-detail", "expand per-memory-dir drift to per-file changes")
    .option("--json", "emit structured JSON output")
    .action(
      (options: {
        config?: string;
        project?: string;
        since?: string;
        sinceApply?: boolean;
        memoryDetail?: boolean;
        json?: boolean;
      }) => {
        if (options.since && options.sinceApply) {
          throw new HarnessExitError(
            "--since <ref> and --since-apply are mutually exclusive",
            EX_USAGE,
          );
        }
        if (options.sinceApply) {
          const r = diffSinceApply({
            ...(options.config !== undefined ? { configPath: options.config } : {}),
            ...(options.memoryDetail ? { memoryDetail: true } : {}),
          });
          if (options.json) {
            stdout(`${JSON.stringify(r.json, null, 2)}\n`);
          } else if (!r.hasDrift) {
            stdout("no drift since last apply\n");
          } else {
            stdout(r.output);
          }
          for (const w of r.warnings) {
            stderr(`warning: ${w}\n`);
          }
          if (r.hasDrift) throw new HarnessExitError("", EX_FAIL);
          return;
        }
        const result = diffRun({
          configPath: options.config,
          project: options.project,
          since: options.since,
        });
        stdout(result.output);
      },
    );

  program
    .command("init")
    .description("Bootstrap a starter harness.yaml from a template")
    .option(
      "--template <name>",
      `template to instantiate: ${KNOWN_TEMPLATES.join(" | ")} (default: minimal)`,
    )
    .option("--force", "overwrite an existing manifest")
    .option(
      "--config <path>",
      "manifest path to write (default: ~/.claude/harness.yaml)",
    )
    .action(async (options: { template?: string; force?: boolean; config?: string }) => {
      if (options.template !== undefined && !isTemplate(options.template)) {
        throw new HarnessExitError(
          `unknown template "${options.template}"; expected one of ${KNOWN_TEMPLATES.join(", ")}`,
          EX_USAGE,
        );
      }
      const result = await init({
        template: options.template,
        force: options.force,
        configPath: options.config,
      });
      if (result.stderr) stderr(result.stderr);
      stdout(result.stdout);
    });

  const addCmd = program
    .command("add")
    .description("Insert a new entry into harness.yaml (managed mutation)");

  function addCommonOptions(c: Command): Command {
    return c
      .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
      .option("--dry-run", "print the unified diff and exit without writing");
  }

  function parseBlocking(s: string): boolean | "soft" | "hard" {
    if (s === "false") return false;
    if (s === "soft" || s === "hard") return s;
    throw new HarnessExitError(
      `invalid --blocking value "${s}"; expected one of false, soft, hard`,
      EX_USAGE,
    );
  }

  function parseIntFlag(s: string, label: string): number {
    const n = Number.parseInt(s, 10);
    if (!Number.isFinite(n) || String(n) !== s.trim()) {
      throw new HarnessExitError(`invalid ${label} value "${s}"; expected an integer`, EX_USAGE);
    }
    return n;
  }

  async function runAdd(action: AddEntry, opts: { config?: string; dryRun?: boolean }): Promise<void> {
    const result = await add(action, { configPath: opts.config, dryRun: opts.dryRun });
    if (opts.dryRun) {
      stdout(result.diff);
      return;
    }
    stdout(`added ${result.type} ${JSON.stringify(result.name)} to ${result.path}\n`);
  }

  addCommonOptions(
    addCmd
      .command("mcp <name>")
      .description("Add an MCP server entry under tools.mcp[]")
      .option("--command <cmd>", "argv-style command; comma-separated for multi-token")
      .option("--health-verb <v>", "MCP verb to invoke for liveness")
      .option("--health-timeout-ms <n>", "verb timeout in ms (default 5000 when --health-verb is set)")
      .option("--enabled <bool>", "true|false (default true)"),
  ).action(
    async (
      name: string,
      options: {
        command?: string;
        healthVerb?: string;
        healthTimeoutMs?: string;
        enabled?: string;
        config?: string;
        dryRun?: boolean;
      },
    ) => {
      const command = options.command
        ? options.command.includes(",")
          ? options.command.split(",").map((s) => s.trim())
          : options.command
        : "";
      if (!command) {
        throw new HarnessExitError(
          "harness add mcp: --command is required",
          EX_USAGE,
        );
      }
      const entry: AddEntry["entry"] & object = {
        name,
        command,
      };
      if (options.healthVerb !== undefined) {
        const timeoutMs = options.healthTimeoutMs
          ? parseIntFlag(options.healthTimeoutMs, "--health-timeout-ms")
          : 5000;
        (entry as { health?: { verb: string; timeout_ms: number } }).health = {
          verb: options.healthVerb,
          timeout_ms: timeoutMs,
        };
      }
      if (options.enabled !== undefined) {
        if (options.enabled !== "true" && options.enabled !== "false") {
          throw new HarnessExitError(
            `invalid --enabled value "${options.enabled}"; expected true or false`,
            EX_USAGE,
          );
        }
        (entry as { enabled?: boolean }).enabled = options.enabled === "true";
      }
      await runAdd(
        { type: "mcp", entry: entry as { name: string; command: string | string[] } },
        { config: options.config, dryRun: options.dryRun },
      );
    },
  );

  addCommonOptions(
    addCmd
      .command("cli <name>")
      .description("Add a CLI tool entry under tools.cli[]")
      .requiredOption("--binary <b>", "binary name on PATH or absolute path")
      .option("--required", "validate fails if the binary is missing")
      .option("--min-version <v>", "minimum semver"),
  ).action(
    async (
      name: string,
      options: {
        binary: string;
        required?: boolean;
        minVersion?: string;
        config?: string;
        dryRun?: boolean;
      },
    ) => {
      const entry: { name: string; binary: string; required?: boolean; min_version?: string } = {
        name,
        binary: options.binary,
      };
      if (options.required) entry.required = true;
      if (options.minVersion !== undefined) entry.min_version = options.minVersion;
      await runAdd({ type: "cli", entry }, { config: options.config, dryRun: options.dryRun });
    },
  );

  addCommonOptions(
    addCmd
      .command("skill <name>")
      .description("Enable a skill by name under tools.skills.enabled[]"),
  ).action(async (name: string, options: { config?: string; dryRun?: boolean }) => {
    await runAdd({ type: "skill", entry: name }, { config: options.config, dryRun: options.dryRun });
  });

  addCommonOptions(
    addCmd
      .command("hook <name>")
      .description("Add a hook entry under hooks[]")
      .requiredOption("--event <e>", "runtime event (e.g. SessionStart, PreToolUse)")
      .requiredOption("--command <c>", "shell command (executable path or script with args)")
      .option("--match <r>", "tool-name regex filter (PreToolUse / PostToolUse only)")
      .option("--blocking <m>", "false | soft | hard (default false)")
      .option("--budget-ms <n>", "timeout in ms (default 30000)"),
  ).action(
    async (
      name: string,
      options: {
        event: string;
        command: string;
        match?: string;
        blocking?: string;
        budgetMs?: string;
        config?: string;
        dryRun?: boolean;
      },
    ) => {
      const entry: {
        name: string;
        event: string;
        command: string;
        match?: string;
        blocking: boolean | "soft" | "hard";
        budget_ms?: number;
      } = {
        name,
        event: options.event,
        command: options.command,
        blocking: options.blocking !== undefined ? parseBlocking(options.blocking) : false,
      };
      if (options.match !== undefined) entry.match = options.match;
      if (options.budgetMs !== undefined) {
        entry.budget_ms = parseIntFlag(options.budgetMs, "--budget-ms");
      }
      await runAdd({ type: "hook", entry }, { config: options.config, dryRun: options.dryRun });
    },
  );

  program
    .command("export")
    .description(
      "Emit the effective merged manifest as a single self-contained YAML " +
        "(or JSON). --sanitize redacts /home/<user>/ paths and env values whose " +
        "key looks credential-shaped.",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--sanitize", "redact /home/<user>/ paths and credential-shaped env values")
    .option("--json", "emit JSON instead of YAML")
    .option("-o, --output <file>", "write to <file> atomically instead of stdout")
    .action(
      (options: {
        config?: string;
        project?: string;
        sanitize?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        const result = exportManifest({
          configPath: options.config,
          project: options.project,
          sanitize: options.sanitize,
          json: options.json,
          outputPath: options.output,
        });
        if (result.wroteTo === null) {
          stdout(result.output);
          if (!result.output.endsWith("\n")) stdout("\n");
        } else {
          stderr(`wrote ${result.wroteTo}\n`);
        }
      },
    );

  program
    .command("adopt <file>")
    .description(
      "Capture hand-edits from a runtime file (today: ~/.claude/settings.json) " +
        "into the manifest. Diffs against the manifest's current declarations and " +
        "prompts y/N before writing.",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--yes", "skip the confirmation prompt (for non-interactive use)")
    .action(async (file: string, options: { config?: string; yes?: boolean }) => {
      const result = await adopt(file, { configPath: options.config, yes: options.yes });
      if (result.outcome === "no-drift") {
        stdout(`nothing to adopt (no drift between ${file} and ${result.manifestPath})\n`);
        return;
      }
      if (result.outcome === "declined") {
        stdout(`adoption declined; ${result.manifestPath} unchanged\n`);
        return;
      }
      stdout(
        `adopted ${result.driftCount} hook${result.driftCount === 1 ? "" : "s"} ` +
          `from ${result.settingsPath} into ${result.manifestPath} ` +
          `(names: ${result.adoptedNames.join(", ")})\n`,
      );
    });

  program
    .command("apply")
    .description(
      "Regenerate harness.generated/ outputs (settings.json + MEMORY.md index) " +
        "from the manifest. Refuses to overwrite hand-edits without --overwrite-drift; " +
        "use `harness adopt <file>` to capture them back into the manifest instead.",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--dry-run", "print the would-be diff + restart hints; do not write")
    .option(
      "--overwrite-drift",
      "discard any on-disk hand-edits to harness.generated/ files (prompts for `yes`)",
    )
    .action(
      async (options: {
        config?: string;
        project?: string;
        dryRun?: boolean;
        overwriteDrift?: boolean;
      }) => {
        const result = await apply({
          ...(options.config !== undefined ? { configPath: options.config } : {}),
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.overwriteDrift ? { overwriteDrift: true } : {}),
        });

        if (result.outcome === "drift-refuse") {
          for (const f of result.files) {
            if (f.diff) {
              stderr(`drift detected in ${f.path}:\n`);
              stderr(f.diff);
              if (!f.diff.endsWith("\n")) stderr("\n");
            }
          }
          stderr(`${DRIFT_HINT_MESSAGE}\n`);
          throw new HarnessExitError("", EX_FAIL);
        }

        if (result.outcome === "drift-discarded") {
          stdout("overwrite-drift declined; nothing written\n");
          return;
        }

        const changedFiles = result.files.filter((f: FileApplyOutcome) => f.changed);

        if (result.outcome === "no-changes") {
          stdout("no changes\n");
        } else if (result.outcome === "would-apply") {
          stdout(`would apply ${changedFiles.length} file(s):\n`);
          for (const f of changedFiles) {
            stdout(`  ${f.path}\n`);
          }
        } else {
          stdout(`applied ${changedFiles.length} file(s):\n`);
          for (const f of changedFiles) {
            stdout(`  ${f.path}\n`);
          }
          stdout(`harness.lock written to ${result.lockPath}\n`);
        }

        for (const d of result.lockDrift) {
          if (d.reason === "missing") {
            stderr(`asset drift detected: ${d.entry.path} missing since last apply\n`);
          } else {
            stderr(`asset drift detected: ${d.entry.path} changed since last apply\n`);
          }
        }
        for (const w of result.warnings) {
          stderr(`warning: ${w}\n`);
        }
        for (const h of result.restartHints) {
          stderr(`restart hint: ${h}\n`);
        }
      },
    );

  program
    .command("remove <type> <name>")
    .description(
      `Remove an entry by name. <type> is one of ${KNOWN_REMOVE_TYPES.join(" | ")}. ` +
        "Refuses to remove a hook still referenced by a policy unless --force.",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--dry-run", "print the unified diff and exit without writing")
    .option(
      "--force",
      "remove even if a policy references this entry (dangling policy.hook is then caught by schema)",
    )
    .action(
      async (
        type: string,
        name: string,
        options: { config?: string; dryRun?: boolean; force?: boolean },
      ) => {
        if (!isRemoveType(type)) {
          throw new HarnessExitError(
            `unknown remove type "${type}"; expected one of ${KNOWN_REMOVE_TYPES.join(", ")}`,
            EX_USAGE,
          );
        }
        const result = await remove(type, name, {
          configPath: options.config,
          dryRun: options.dryRun,
          force: options.force,
        });
        if (result.forcedReferences.length > 0) {
          stderr(
            `(forced removal — referenced by: ${result.forcedReferences.join(", ")})\n`,
          );
        }
        if (options.dryRun) {
          stdout(result.diff);
          return;
        }
        stdout(`removed ${result.type} ${JSON.stringify(result.name)} from ${result.path}\n`);
      },
    );

  program
    .command("explain <policy>")
    .description("Print a policy's definition; --trace reads the last recorded evaluation")
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit JSON instead of YAML")
    .option("--trace", "include the full decision trail from the most recent evaluation")
    .option("--session <id>", "grounding session whose audit log to read (default: $CLAUDE_SESSION_ID, then 'default')")
    .action(
      async (
        policyName: string,
        options: {
          config?: string;
          project?: string;
          json?: boolean;
          trace?: boolean;
          session?: string;
        },
      ) => {
        const explainOpts: Parameters<typeof explain>[1] = {};
        if (options.config) explainOpts.configPath = options.config;
        if (options.project) explainOpts.project = options.project;
        if (options.json) explainOpts.json = options.json;
        if (options.trace) explainOpts.trace = options.trace;
        if (options.session) explainOpts.sessionId = options.session;
        const result = await explain(policyName, explainOpts);
        stdout(result.output);
      },
    );

  program
    .command("audit")
    .description(
      "Replay policy decisions from the evidence ledger for a time window",
    )
    .option("--since <duration>", "time window (default: 24h)")
    .option("--policy <name>", "filter to a single policy by name")
    .option(
      "--outcome <outcome>",
      "filter by decision outcome (allow / deny / warn-degraded)",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
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
    .command("dry-run <prompt>")
    .description(
      "Statically predict which hooks fire / policies match / memories route for a prompt",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
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

  const policy = program.command("policy").description("Policy runtime verbs");
  policy
    .command("intercept")
    .description(
      "PreToolUse hook entrypoint: read tool-event JSON from stdin, evaluate matching policies, emit Claude Code deny JSON on block",
    )
    .option("--config <path>", "manifest path (default: ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(async (options: {
      config?: string;
      project?: string;
      ledgerTimeout?: string;
    }) => {
      const cliOpts: Parameters<typeof runInterceptCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      await runInterceptCli(cliOpts);
    });

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
