import * as os from "node:os";
import type { Command } from "commander";
import { defaultVersionProbe, type RunOptions } from "./index.js";
import { describe, isPillar, type Pillar } from "./describe.js";
import { diff as diffRun } from "./diff/index.js";
import { diffSinceApply } from "./diff/since-apply.js";
import { doctor, isDoctorTarget, KNOWN_DOCTOR_TARGETS } from "./doctor/index.js";
import { format as formatDoctor } from "./doctor/format.js";
import type { DoctorTarget } from "./doctor/types.js";
import { deleteRogueLedgers, scanForRogueLedgers } from "./doctor/rogue-ledger.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { isListCategory, list, type ListCategory } from "./list.js";
import { formatReport, validate } from "./validate/index.js";

export function registerInspectGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
  opts: RunOptions,
): void {
  const { stdout, stderr } = io;
  program
    .command("describe")
    .description("Print the effective merged manifest")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option(
      "--pillar <pillar>",
      "filter output to one section: grounding | tools | memory | hooks | policies | workflows | review_templates",
    )
    .option("--json", "emit JSON instead of YAML")
    .action((options: { config?: string; project?: string; pillar?: string; json?: boolean }) => {
      let pillar: Pillar | undefined;
      if (options.pillar !== undefined) {
        if (!isPillar(options.pillar)) {
          throw new HarnessExitError(
            `unknown pillar "${options.pillar}"; expected one of grounding, tools, memory, hooks, policies, workflows, review_templates`,
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
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--strict", "promote warnings to errors")
    .option("--check-lock", "surface harness.lock asset-content drift as warnings (or errors with --strict)")
    .option("--json", "emit a structured JSON report ({ diagnostics, errorCount, warningCount }) instead of prose")
    .action(
      (options: {
        config?: string;
        project?: string;
        strict?: boolean;
        checkLock?: boolean;
        json?: boolean;
      }) => {
        const result = validate({
          configPath: options.config,
          project: options.project,
          strict: options.strict,
          checkLock: options.checkLock,
        });
        if (options.json) {
          // JSON goes to stdout regardless of outcome so pipelines can
          // always parse it; the exit code still carries pass/fail.
          stdout(
            `${JSON.stringify(
              {
                diagnostics: result.diagnostics,
                errorCount: result.errorCount,
                warningCount: result.warningCount,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          const report = formatReport(result);
          if (result.diagnostics.length > 0) stderr(report);
          else stdout(report);
        }
        if (result.errorCount > 0) {
          throw new HarnessExitError("", EX_FAIL);
        }
      },
    );

  program
    .command("doctor")
    .description("Health summary across all pillars")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--shallow", "skip MCP probes (CLI --version probes still run); report manifest-reference state only")
    .option(
      "--target <runtime>",
      `additionally evaluate the harness-side adapter health for a runtime (allowed: ${KNOWN_DOCTOR_TARGETS.join(", ")})`,
    )
    .option("--json", "emit a structured JSON DoctorReport instead of prose (--rm-rogue-ledgers is ignored with --json)")
    .option(
      "--rm-rogue-ledgers",
      "after reporting, delete each rogue evidence-ledger directory found (prompts per hit; combine with --yes to skip prompts)",
    )
    .option("--yes", "with --rm-rogue-ledgers, skip per-hit confirmation prompts")
    .action(
      async (options: {
        config?: string;
        project?: string;
        shallow?: boolean;
        target?: string;
        json?: boolean;
        rmRogueLedgers?: boolean;
        yes?: boolean;
      }) => {
        let target: DoctorTarget | undefined;
        if (options.target !== undefined) {
          if (!isDoctorTarget(options.target)) {
            stderr(
              `unknown --target ${JSON.stringify(options.target)}; expected one of ${KNOWN_DOCTOR_TARGETS.join(", ")}\n`,
            );
            throw new HarnessExitError("", EX_USAGE);
          }
          target = options.target;
        }
        const report = await doctor({
          configPath: options.config,
          project: options.project,
          shallow: options.shallow,
          versionProbe: defaultVersionProbe,
          ...(target !== undefined ? { target } : {}),
          ...(opts.rogueLedgerScanOptions !== undefined
            ? { rogueLedgerScanOptions: opts.rogueLedgerScanOptions }
            : {}),
        });
        // Non-zero exit when the report carries errors (task a07b379a):
        // callers previously had no way to gate CI/scripts on doctor
        // health, since this action always fell through to exit 0
        // regardless of report.errorCount. Warnings alone still exit 0.
        // Checked before every return below (json / no --rm-rogue-ledgers /
        // no hits found / after the delete+rescan flow) so the exit code
        // is consistent across all output modes.
        const failIfErrors = (): void => {
          if (report.errorCount > 0) {
            throw new HarnessExitError("", EX_FAIL);
          }
        };

        if (options.json) {
          stdout(`${JSON.stringify(report, null, 2)}\n`);
          failIfErrors();
          return;
        }
        stdout(formatDoctor(report));

        if (!options.rmRogueLedgers) {
          failIfErrors();
          return;
        }

        const hits = report.rogueLedgerDbs;
        if (hits.length === 0) {
          stdout("no rogue evidence-ledger DBs found; nothing to delete\n");
          failIfErrors();
          return;
        }

        const result = await deleteRogueLedgers(hits, { yes: options.yes });

        for (const hit of result.deleted) {
          stdout(`deleted: ${hit.rogueDir}\n`);
        }
        for (const hit of result.skipped) {
          stdout(`skipped: ${hit.rogueDir}\n`);
        }

        // Re-scan and print clean delta so the operator can confirm the
        // on-disk state after deletion. Uses the same scan options as the
        // initial scan (injectable via RunOptions.rogueLedgerScanOptions for
        // tests; production falls back to os.homedir() / process.cwd()).
        const afterScan = scanForRogueLedgers({
          homeDir: opts.rogueLedgerScanOptions?.homeDir ?? os.homedir(),
          cwd: opts.rogueLedgerScanOptions?.cwd ?? process.cwd(),
          ...(opts.rogueLedgerScanOptions?.fsInterface !== undefined
            ? { fsInterface: opts.rogueLedgerScanOptions.fsInterface }
            : {}),
        });
        stdout(
          `rogue evidence-ledger DBs remaining: ${afterScan.length}\n`,
        );
        failIfErrors();
      },
    );

  program
    .command("list <category>")
    .description(
      "Flat denormalised listing per category: mcp / cli / skills / memories / hooks / policies / workflows",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
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
            `unknown list category "${category}"; expected one of mcp, cli, skills, memories, hooks, policies, workflows`,
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
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
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
        // Override-layer diagnostics go to stderr so stdout stays a clean
        // diff for piping (task b2660f9e).
        for (const w of result.warnings) stderr(`harness diff: ${w}\n`);
        stdout(result.output);
      },
    );
}
