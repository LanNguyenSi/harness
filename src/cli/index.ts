import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";

import { HermeticSpawnViolationError } from "../runtime/hermetic-spawn-guard.js";

// Production version probe for `harness doctor`: synchronous --version
// invocation with a 5s timeout. Tests inject their own probe; the CLI
// entrypoint wires this default. Same shape as `cli/doctor/codex.ts`.
function defaultVersionProbe(cmd: readonly string[]): string | null {
  if (cmd.length === 0) return null;
  try {
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return null;
    return (result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}
import { add } from "./add/index.js";
import type { AddEntry } from "./add/mutate.js";
import { adopt } from "./adopt/index.js";
import {
  apply,
  CODEX_CONFIG_BASENAME,
  DRIFT_HINT_MESSAGE,
  formatNextSteps,
  OPENCODE_CONFIG_BASENAME,
  SETTINGS_BASENAME,
  type FileApplyOutcome,
} from "./apply/index.js";
import { isRemoveType, KNOWN_REMOVE_TYPES, remove } from "./remove/index.js";
import { packAdd, packList, packRemove, packReseed, packUpgrade } from "./pack/index.js";
import { runPackHookPreToolUseCli } from "./pack/hook-pre-tool-use.js";
import { runPackHookPostToolUseCli } from "./pack/hook-post-tool-use.js";
import { runPackHookTrackActiveClaimCli } from "./pack/hook-track-active-claim.js";
import { runPackHookStayInScopeCli } from "./pack/hook-stay-in-scope.js";
import { runPackHookSubagentStartCli } from "./pack/hook-subagent-start.js";
import { runPackHookSubagentStopCli } from "./pack/hook-subagent-stop.js";
import { runPackHookCodexPreToolUseCli } from "./pack/hook-codex-pre-tool-use.js";
import { runPackHookCodexPostToolUseCli } from "./pack/hook-codex-post-tool-use.js";
import { runPackHookCodexStopCli } from "./pack/hook-codex-stop.js";
import { runPackHookCodexUserPromptSubmitCli } from "./pack/hook-codex-user-prompt-submit.js";
import { isRuntime, KNOWN_RUNTIMES, type Runtime } from "../policy-packs/index.js";
import { approveBranchProtection } from "./approve/branch-protection.js";
import { approveRisk } from "./approve/risk.js";
import { approveUnderstanding } from "./approve/understanding.js";
import { readPipedStdin } from "./approve/stdin-report.js";
import { issueDelegation } from "./delegate/index.js";
import { InvalidDurationError, parseDurationSeconds } from "../policies/index.js";
import {
  runRecordDogfood,
  runRecordReview,
  runRecordReviewSubagent,
  type RecordResult,
} from "./record/index.js";
import { describe, isPillar, type Pillar } from "./describe.js";
import { diff as diffRun } from "./diff/index.js";
import { diffSinceApply } from "./diff/since-apply.js";
import { exportManifest } from "./export.js";
import { doctor, isDoctorTarget, KNOWN_DOCTOR_TARGETS } from "./doctor/index.js";
import { format as formatDoctor } from "./doctor/format.js";
import type { DoctorTarget } from "./doctor/types.js";
import {
  deleteRogueLedgers,
  scanForRogueLedgers,
  type RogueLedgerScanOptions,
} from "./doctor/rogue-ledger.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { explain } from "./explain.js";
import { explainAction } from "./explain-action.js";
import { explainPolicy } from "./explain-policy.js";
import { testRisk } from "./test-risk.js";
import { resolveEnv } from "./resolve-env.js";
import { detect as detectInit } from "./init/detect.js";
import { init, isTemplate, KNOWN_TEMPLATES } from "./init/index.js";
import { runInteractive } from "./init/interactive.js";
import { isListCategory, list, type ListCategory } from "./list.js";
import { audit, type AuditOutcome } from "./audit.js";
import { sessionExport, type ExportFormat } from "./session-export/index.js";
import { dryRun } from "./dry-run.js";
import { runInterceptCli } from "./policy/intercept.js";
import { runSessionStartPreflight } from "./session-start/index.js";
import { writePendingApproval } from "../runtime/pending-approval.js";
import { runSessionStartBranchCheck } from "./session-start/branch-check.js";
import { runSessionStartToolchainParity } from "./session-start/toolchain-parity.js";
import { runSessionStartStaleBaseCheck } from "./session-start/stale-base-check.js";
import { runPackHookBranchProtectionCli } from "./pack/hook-branch-protection.js";
import { runPackHookSolutionAcceptanceCli } from "./pack/hook-solution-acceptance.js";
import { runPackHookSolutionAcceptanceWriteguardCli } from "./pack/hook-solution-acceptance-writeguard.js";
import { runPackHookPostMergeGateRecordCli } from "./pack/hook-post-merge-gate-record.js";
import { runPackHookPostMergeGateCli } from "./pack/hook-post-merge-gate.js";
import { runPackHookRuntimeRealityCli } from "./pack/hook-runtime-reality.js";
import { gateDisable, GateDisableError } from "./gate/disable.js";
import { gateEnable, GateEnableError } from "./gate/enable.js";
import { DEFAULT_RETENTION_DAYS, gc } from "./gc/index.js";
import { uninstall, UninstallError } from "./uninstall/index.js";
import { migrateHome } from "./migrate-home/index.js";
import { pause as pauseHarness, resume as resumeHarness } from "./pause/index.js";
import {
  formatSmokeReport,
  runSmoke,
  splitCommaList,
  type SmokeExpectations,
  type ExpectDecision,
} from "./smoke/index.js";
import { formatReport, validate } from "./validate/index.js";
import { VERSION } from "../version.js";

export interface RunOptions {
  argv?: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /**
   * Test-injection knob for `harness doctor --rm-rogue-ledgers`. When set,
   * both the initial scan (forwarded to `doctor()`) and the post-deletion
   * re-scan use these options instead of the runtime `os.homedir()` /
   * `process.cwd()` defaults. This makes the re-scan fully hermetic in unit
   * tests without spawning real filesystem side-effects.
   */
  rogueLedgerScanOptions?: Partial<RogueLedgerScanOptions>;
}

export function buildProgram(opts: RunOptions = {}): Command {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const program = new Command();
  program
    .name("harness")
    .description("Declarative control plane for agent harnesses")
    .version(VERSION)
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
    .option(
      "--recent-sessions <n>",
      "understanding-gate auto-approval doctor window: how many of the newest .approvals/ session markers to scan (default: 20)",
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
        recentSessions?: string;
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
        let recentSessions: number | undefined;
        if (options.recentSessions !== undefined) {
          const parsed = Number(options.recentSessions);
          if (!Number.isInteger(parsed) || parsed < 1) {
            stderr(
              `--recent-sessions must be an integer >= 1, got ${JSON.stringify(options.recentSessions)}\n`,
            );
            throw new HarnessExitError("", EX_USAGE);
          }
          recentSessions = parsed;
        }
        const report = await doctor({
          configPath: options.config,
          project: options.project,
          shallow: options.shallow,
          versionProbe: defaultVersionProbe,
          ...(target !== undefined ? { target } : {}),
          ...(recentSessions !== undefined ? { recentSessions } : {}),
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
      "manifest path to write (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)",
    )
    .option(
      "--probe",
      "skip writing, print a JSON snapshot of detected runtimes (Claude Code, Codex), the existing ~/.harness/harness.yaml (or legacy ~/.claude/harness.yaml), and MCP servers wired in settings.json. Read-only.",
    )
    .option(
      "--interactive",
      "run the guided wizard (detect environment, pick profile, preview + write). Mutually exclusive with --probe / --template.",
    )
    .action(
      async (options: {
        template?: string;
        force?: boolean;
        config?: string;
        probe?: boolean;
        interactive?: boolean;
      }) => {
        if (options.probe && options.interactive) {
          throw new HarnessExitError(
            "--probe and --interactive are mutually exclusive",
            EX_USAGE,
          );
        }
        if (options.probe) {
          if (options.template !== undefined || options.force || options.config !== undefined) {
            throw new HarnessExitError(
              "--probe is read-only; pass it without --template / --force / --config",
              EX_USAGE,
            );
          }
          const result = await detectInit();
          stdout(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (options.interactive) {
          if (options.template !== undefined || options.config !== undefined) {
            throw new HarnessExitError(
              "--interactive owns its own template + path choices; do not combine with --template / --config",
              EX_USAGE,
            );
          }
          // Thread --force into the wizard's forceOverwrite: without it
          // an existing manifest makes the wizard re-prompt, and
          // `harness init --interactive --force` looked like it should
          // overwrite non-interactively but the flag never reached
          // runInteractive (harness/418cebd4).
          const r = await runInteractive({
            stdout,
            stderr,
            ...(options.force ? { forceOverwrite: true } : {}),
          });
          if (r.aborted) {
            return;
          }
          if (r.validateClean === false) {
            throw new HarnessExitError(
              `manifest written but failed harness validate; see stderr for diagnostics`,
              EX_FAIL,
            );
          }
          if (r.binResolutionClean === false) {
            throw new HarnessExitError(
              `manifest written but one or more declared MCP/CLI binaries do not resolve on PATH; see stderr for diagnostics and remediation hints`,
              EX_FAIL,
            );
          }
          return;
        }
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
      },
    );

  const addCmd = program
    .command("add")
    .description("Insert a new entry into harness.yaml (managed mutation)");

  function addCommonOptions(c: Command): Command {
    return c
      .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
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
    for (const w of result.warnings) {
      stderr(`warning: ${w}\n`);
    }
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
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
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
      "Capture hand-edits into the manifest. Hooks are diffed against <file> " +
        "(today: ~/.claude/settings.json). MCP servers are ALWAYS diffed " +
        "against the effective Claude Code registry (top-level mcpServers in " +
        "~/.claude.json, respecting CLAUDE_CONFIG_DIR) regardless of <file> — " +
        "Claude Code does not read <file>'s mcpServers block at runtime. " +
        "Prompts y/N before writing.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--yes", "skip the confirmation prompt (for non-interactive use)")
    .action(async (file: string, options: { config?: string; yes?: boolean }) => {
      const result = await adopt(file, { configPath: options.config, yes: options.yes });
      if (result.deadSettingsMcpNames.length > 0) {
        stderr(
          `⚠ ${file} has a dead \`mcpServers\` block (${result.deadSettingsMcpNames.join(", ")}); ` +
            "Claude Code does not read this file for MCP registration — adopt diffed against the " +
            "effective registry instead. Safe to remove by hand.\n",
        );
      }
      if (result.registryReadError !== undefined) {
        stderr(
          `⚠ could not read the Claude Code MCP registry: ${result.registryReadError}; ` +
            "treated as empty for MCP drift purposes.\n",
        );
      }
      if (result.outcome === "no-drift") {
        stdout(`nothing to adopt (no drift between ${file} and ${result.manifestPath})\n`);
        return;
      }
      if (result.outcome === "declined") {
        stdout(`adoption declined; ${result.manifestPath} unchanged\n`);
        return;
      }
      const parts: string[] = [];
      if (result.hookDriftCount > 0) {
        parts.push(
          `${result.hookDriftCount} hook${result.hookDriftCount === 1 ? "" : "s"}` +
            ` (${result.adoptedNames.join(", ")})`,
        );
      }
      if (result.mcpDriftCount > 0) {
        const mcpFrag = `${result.mcpDriftCount} MCP server${result.mcpDriftCount === 1 ? "" : "s"}` +
          ` (${result.adoptedMcpNames.join(", ")})`;
        parts.push(
          result.replacedMcpNames.length > 0
            ? `${mcpFrag}; replaced existing manifest entry for: ${result.replacedMcpNames.join(", ")}`
            : mcpFrag,
        );
      }
      stdout(
        `adopted ${parts.join(" + ")} from ${result.settingsPath} into ${result.manifestPath}\n`,
      );
    });

  program
    .command("apply")
    .description(
      "Regenerate harness.generated/ outputs (settings.json + MEMORY.md index) " +
        "from the manifest. Refuses to overwrite hand-edits without --overwrite-drift; " +
        "use `harness adopt <file>` to capture them back into the manifest instead.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides for this project name")
    .option("--dry-run", "print the would-be diff + restart hints; do not write")
    .option(
      "--overwrite-drift",
      "discard any on-disk hand-edits to harness.generated/ files (prompts for `yes`; pair with --yes for non-interactive runs)",
    )
    .option(
      "--yes",
      "with --overwrite-drift, skip the confirmation prompt (for non-interactive use)",
    )
    .option(
      "--strict-lock",
      "refuse with exit 1 (no write) when harness.lock asset drift is detected; dry-run wins",
    )
    .option(
      "--target <path>",
      "additionally write the generated settings.json to <path> (e.g. .claude/settings.local.json)",
    )
    .option(
      "--merge",
      "with --target, 3-way merge into an existing target file (replace owned keys, preserve others)",
    )
    .option("--force", "with --target, overwrite an existing target file (no merge)")
    .option(
      "--runtime <runtime>",
      `policy-pack adapter runtime (${KNOWN_RUNTIMES.join(" | ")}; default: claude-code). ` +
        "Selects which adapter shape policy-pack hooks expand into and which artefacts apply writes. " +
        "`codex` emits harness.generated/codex/config.toml in place of settings.json. " +
        "`opencode` emits harness.generated/opencode/opencode.json (MCP servers only; not auto-installed).",
    )
    .option(
      "--install",
      "with --runtime codex, merge the generated hook block into ~/.codex/config.toml",
    )
    .option(
      "--codex-config <path>",
      "with --runtime codex --install, override the Codex config path (default ~/.codex/config.toml)",
    )
    .option("--quiet", "suppress the post-apply Next-steps hint")
    .option("--json", "emit a structured JSON summary instead of prose (implies --quiet)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        dryRun?: boolean;
        overwriteDrift?: boolean;
        yes?: boolean;
        strictLock?: boolean;
        target?: string;
        merge?: boolean;
        force?: boolean;
        runtime?: string;
        install?: boolean;
        codexConfig?: string;
        quiet?: boolean;
        json?: boolean;
      }) => {
        let runtime: Runtime | undefined;
        if (options.runtime !== undefined) {
          if (!isRuntime(options.runtime)) {
            stderr(
              `unknown --runtime ${JSON.stringify(options.runtime)}; expected one of ${KNOWN_RUNTIMES.join(", ")}\n`,
            );
            throw new HarnessExitError("", EX_USAGE);
          }
          runtime = options.runtime;
        }
        // --json is documented as implying --quiet. Normalize early so any
        // future fall-through path (or new prose branch) honors it without
        // depending on the JSON early-return below as the only chokepoint.
        if (options.json) options.quiet = true;

        const result = await apply({
          ...(options.config !== undefined ? { configPath: options.config } : {}),
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.overwriteDrift ? { overwriteDrift: true } : {}),
          ...(options.yes ? { yes: true } : {}),
          ...(options.strictLock ? { strictLock: true } : {}),
          ...(options.target !== undefined ? { target: options.target } : {}),
          ...(options.merge ? { merge: true } : {}),
          ...(options.force ? { force: true } : {}),
          ...(runtime !== undefined ? { runtime } : {}),
          ...(options.install ? { installCodex: true } : {}),
          ...(options.codexConfig !== undefined
            ? { codexConfigPath: options.codexConfig }
            : {}),
        });

        if (options.json) {
          // Machine-readable: one JSON object on stdout regardless of
          // outcome. Refusals still set the non-zero exit below; consumers
          // should check both `outcome` in the JSON and the process exit.
          stdout(`${JSON.stringify(result, null, 2)}\n`);
          if (
            result.outcome === "target-exists-refuse" ||
            result.outcome === "lock-drift-refuse" ||
            result.outcome === "drift-refuse"
          ) {
            throw new HarnessExitError("", EX_FAIL);
          }
          return;
        }

        if (result.outcome === "target-exists-refuse") {
          stderr(
            `target ${result.targetPath} exists; pass --merge to merge into it, or --force to overwrite\n`,
          );
          throw new HarnessExitError("", EX_FAIL);
        }

        if (result.outcome === "lock-drift-refuse") {
          for (const d of result.lockDrift) {
            if (d.reason === "missing") {
              stderr(`asset drift detected: ${d.entry.path} missing since last apply\n`);
            } else {
              stderr(`asset drift detected: ${d.entry.path} changed since last apply\n`);
            }
          }
          stderr(
            "--strict-lock: refusing to overwrite the lock; re-run without --strict-lock to acknowledge, or revert the upstream asset edit\n",
          );
          throw new HarnessExitError("", EX_FAIL);
        }

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
          if (result.codexConfigInstall?.changed) {
            stdout(`  ${result.codexConfigInstall.configPath} (Codex install)\n`);
          }
        } else {
          stdout(`applied ${changedFiles.length} file(s):\n`);
          for (const f of changedFiles) {
            stdout(`  ${f.path}\n`);
          }
          if (result.targetPath && (result.targetWritten || result.targetInSync)) {
            if (result.targetWritten) {
              if (result.targetMergeSummary) {
                stdout(`${result.targetMergeSummary}\n`);
              } else {
                stdout(`wrote target: ${result.targetPath}\n`);
              }
            } else {
              // Idempotent re-apply: the merge was a no-op because the
              // target already held the merged content. Report it as
              // success, not silence.
              stdout(`target already in sync: ${result.targetPath}\n`);
            }
          }
          if (result.codexConfigInstall?.written) {
            stdout(`${result.codexConfigInstall.summary}\n`);
            if (result.codexConfigInstall.backupPath) {
              stdout(`backup written to ${result.codexConfigInstall.backupPath}\n`);
            }
          }
          stdout(`harness.lock written to ${result.lockPath}\n`);

          if (!options.quiet) {
            // `formatNextSteps` collapses to the single "wired into ..."
            // line when it receives `targetPath`. Pass it whenever the
            // target ended this run in sync — written this run, OR
            // already byte-identical (`targetInSync`). Gating on
            // `targetWritten` alone misclassified an idempotent
            // re-apply as "nothing is wired" and looped the operator
            // through redundant apply commands.
            // `anyChanged` softens the no-target lede when the generated
            // manifest is already up to date (avoids over-claiming
            // "nothing is wired" against operators who wired a target
            // on a previous run).
            const generatedSettingsPath = path.join(result.generatedDir, SETTINGS_BASENAME);
            const codexConfigPath = path.join(result.generatedDir, CODEX_CONFIG_BASENAME);
            const opencodeConfigPath = path.join(result.generatedDir, OPENCODE_CONFIG_BASENAME);
            const anyChanged = result.files.some((f) => f.changed);
            stdout(
              formatNextSteps({
                generatedSettingsPath,
                codexConfigPath,
                opencodeConfigPath,
                anyChanged,
                ...(runtime !== undefined ? { runtime } : {}),
                ...((result.targetWritten || result.targetInSync) && result.targetPath
                  ? { targetPath: result.targetPath }
                  : {}),
              }),
            );
          }
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
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
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
        // F3 (review round 3, 99f47307 Slice 1): printed on the dry-run AND
        // the write path. A --force'd removal of an evidence hook silently
        // disables the workflows[]-derived merge gate (no schema safety
        // net, unlike a dangling policy.hook), so this line is the only
        // warning the operator gets.
        if (result.derivedGateReferences.length > 0) {
          stderr(
            `(forced removal disables the workflows[]-derived merge gate for: ` +
              `${result.derivedGateReferences.join(", ")}; harness policy intercept ` +
              `no longer blocks merges for ${result.derivedGateReferences.length === 1 ? "this workflow" : "these workflows"} ` +
              `and for any other workflow sharing the same merge surface)\n`,
          );
        }
        if (options.dryRun) {
          stdout(result.diff);
          return;
        }
        stdout(`removed ${result.type} ${JSON.stringify(result.name)} from ${result.path}\n`);
      },
    );

  // `harness pack` subtree (Phase 6 #3): managed CRUD over policy_packs[].
  const packCmd = program
    .command("pack")
    .description("Manage policy_packs[] entries (add / remove / list / reseed)");

  packCmd
    .command("add <name>")
    .description(
      "Insert a new policy_packs entry. <name> must be a known builtin (see docs/policy-packs/).",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--mode <mode>", "pack-specific config.mode value (e.g. fast_confirm | grill_me | strict)")
    .option("--source <src>", "pack source (default: builtin)")
    .option("--description <text>", "operator-facing description")
    .option("--disabled", "register as enabled: false")
    .option("--dry-run", "print the unified diff and exit without writing")
    .action(
      async (
        name: string,
        options: {
          config?: string;
          mode?: string;
          source?: string;
          description?: string;
          disabled?: boolean;
          dryRun?: boolean;
        },
      ) => {
        const entry: Parameters<typeof packAdd>[0] = { name };
        if (options.source !== undefined) entry.source = options.source;
        if (options.disabled === true) entry.enabled = false;
        if (options.description !== undefined) entry.description = options.description;
        if (options.mode !== undefined) entry.config = { mode: options.mode };
        const result = await packAdd(entry, {
          configPath: options.config,
          dryRun: options.dryRun,
        });
        if (options.dryRun) {
          stdout(result.diff);
          return;
        }
        stdout(`added policy_packs entry ${JSON.stringify(result.name)} to ${result.path}\n`);
      },
    );

  packCmd
    .command("remove <name>")
    .description(
      "Remove a policy_packs entry. Refuses without --force when applied state " +
        "is recorded in .last-apply.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--dry-run", "print the unified diff and exit without writing")
    .option(
      "--force",
      "remove the manifest entry AND clean up the on-disk pack files + .last-apply state",
    )
    .action(
      async (
        name: string,
        options: { config?: string; dryRun?: boolean; force?: boolean },
      ) => {
        const result = await packRemove(name, {
          configPath: options.config,
          dryRun: options.dryRun,
          force: options.force,
        });
        if (result.cleanedFiles.length > 0) {
          stderr(
            `(forced cleanup — removed ${result.cleanedFiles.length} pack file(s) and pruned .last-apply)\n`,
          );
        }
        if (options.dryRun) {
          stdout(result.diff);
          return;
        }
        stdout(`removed policy_packs entry ${JSON.stringify(result.name)} from ${result.path}\n`);
      },
    );

  // `harness pack reseed <name>` (task 68b9ad9c): pull the shipped
  // builtin template's config.ux (and config.producers) into an already-
  // installed manifest. Explicit-only, mirroring add/remove — never
  // invoked by `apply`, so an upgrade never silently rewrites an
  // operator's deliberate ux customisation. Paired with the `harness
  // doctor` divergence warning (src/policy-packs/ux-drift-check.ts).
  packCmd
    .command("reseed <name>")
    .description(
      "Pull the shipped builtin template's config.ux (and config.producers) for <name> into " +
        "the manifest, preserving other config keys (mode, approval_lifecycle, ...). No-op if " +
        "already up to date. See `harness doctor` for a divergence warning.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--dry-run", "print the unified diff and exit without writing")
    .action(
      async (name: string, options: { config?: string; dryRun?: boolean }) => {
        const result = await packReseed(name, {
          configPath: options.config,
          dryRun: options.dryRun,
        });
        if (result.fieldsChanged.length === 0) {
          stdout(
            `policy_packs entry ${JSON.stringify(result.name)} already matches the shipped template; nothing to reseed.\n`,
          );
          return;
        }
        if (options.dryRun) {
          stdout(result.diff);
          return;
        }
        stdout(
          `reseeded ${result.fieldsChanged.map((f) => `config.${f}`).join(", ")} for policy_packs entry ${JSON.stringify(result.name)} in ${result.path}\n`,
        );
      },
    );

  // `harness pack upgrade <name>` (task 8f637efd, D-004): text-level
  // insertion of a pack's missing default config block into an existing
  // manifest, idempotent, never rewrites content outside the inserted
  // block. Today's only wired upgrade is `understanding-before-
  // execution`'s `auto_approve` default; see upgrade.ts's module header
  // for why this is text-level rather than a Document-API mutation like
  // `add` / `reseed`.
  packCmd
    .command("upgrade <name>")
    .description(
      "Insert a pack's missing default config block into an existing manifest (today: " +
        "understanding-before-execution's auto_approve default). Idempotent; " +
        "refuses on ambiguity rather than guessing where to insert.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--dry-run", "print the unified diff and exit without writing")
    .action(async (name: string, options: { config?: string; dryRun?: boolean }) => {
      const result = await packUpgrade(name, {
        configPath: options.config,
        dryRun: options.dryRun,
      });
      if (result.alreadyPresent) {
        stdout(
          `policy_packs entry ${JSON.stringify(result.name)} already carries this upgrade; nothing to insert (${result.path} unchanged).\n`,
        );
        return;
      }
      if (options.dryRun) {
        stdout(result.diff);
        return;
      }
      stdout(`upgraded policy_packs entry ${JSON.stringify(result.name)} in ${result.path}\n`);
    });

  // `harness pack hook` runtime sub-tree (Phase 6 #4): wired by the
  // pack's PreToolUse hook contribution; reads PreToolUse JSON from
  // stdin, consults the signed approval marker (the persisted report and
  // the ledger are audit evidence only, task 7402301d), emits Claude Code
  // deny JSON on block.
  const packHookCmd = packCmd
    .command("hook")
    .description("Pack runtime hook entrypoints (called by Claude Code via settings.json)");

  packHookCmd
    .command("pre-tool-use")
    .description(
      "PreToolUse blocker: read tool-event JSON from stdin, consult the signed approval marker (persisted report and ledger are audit evidence only), emit deny JSON on block",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .option("--reports-dir <path>", "override the persisted-report directory (default: ./.understanding-gate/reports)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        pack?: string;
        ledgerTimeout?: string;
        reportsDir?: string;
      }) => {
        const cliOpts: Parameters<typeof runPackHookPreToolUseCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        if (options.reportsDir) cliOpts.reportsDir = options.reportsDir;
        if (options.ledgerTimeout) {
          const n = Number.parseInt(options.ledgerTimeout, 10);
          if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
        }
        await runPackHookPreToolUseCli(cliOpts);
      },
    );

  packHookCmd
    .command("post-tool-use")
    .description(
      "PostToolUse marker-expiry: read tool-event JSON from stdin, delete the per-session approval marker when the just-completed tool matches config.approval_lifecycle.expire_on_tool_match (agent-tasks/d8ee60ca)",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .action(
      async (options: { config?: string; project?: string; pack?: string }) => {
        const cliOpts: Parameters<typeof runPackHookPostToolUseCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        await runPackHookPostToolUseCli(cliOpts);
      },
    );

  packHookCmd
    .command("track-active-claim")
    .description(
      "PostToolUse: read tool-event JSON from stdin, maintain ~/.claude/harness.generated/active-claim on agent-tasks task_start / task_finish / task_abandon so `harness approve understanding` can auto-resolve the task id without --task (harness/494fd1e5).",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .action(
      async (options: { config?: string; project?: string; pack?: string }) => {
        const cliOpts: Parameters<typeof runPackHookTrackActiveClaimCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        await runPackHookTrackActiveClaimCli(cliOpts);
      },
    );

  packHookCmd
    .command("stay-in-scope")
    .description(
      "PostToolUse: read tool-event JSON from stdin and, when explicitly configured, emit a non-blocking reminder and JSONL audit row for configured task-tool payloads. Current manifest configuration controls matching; STAY_IN_SCOPE_DISABLED=1 disables a live hook and STAY_IN_SCOPE_LOG overrides its log path.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .action(
      async (options: { config?: string; project?: string }) => {
        const cliOpts: Parameters<typeof runPackHookStayInScopeCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        await runPackHookStayInScopeCli(cliOpts);
      },
    );

  packHookCmd
    .command("subagent-start")
    .description(
      "SubagentStart: read event JSON from stdin, write a signed in-flight record for this (session_id, agent_id) when the parent session currently holds a valid understanding-gate approval (docs/decisions/2026-08-27-ug-auto-mode-approval.md).",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .action(
      async (options: { config?: string; project?: string; pack?: string }) => {
        const cliOpts: Parameters<typeof runPackHookSubagentStartCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        await runPackHookSubagentStartCli(cliOpts);
      },
    );

  packHookCmd
    .command("subagent-stop")
    .description(
      "SubagentStop: read event JSON from stdin, remove the in-flight record written for this (session_id, agent_id) by subagent-start.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .action(
      async (options: { config?: string; project?: string; pack?: string }) => {
        const cliOpts: Parameters<typeof runPackHookSubagentStopCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        await runPackHookSubagentStopCli(cliOpts);
      },
    );

  // Phase 6 #6 — Codex adapter sub-commands. Mirror the pre-tool-use
  // shape; UserPromptSubmit equivalent injects the instruction template
  // on stdout for Codex to prepend to additional_instructions.
  packHookCmd
    .command("codex-pre-tool-use")
    .description(
      "Codex PreToolUse blocker: read tool-event JSON from stdin, consult the signed approval marker (persisted report and ledger are audit evidence only), exit 2 with stderr reason on block",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .option("--reports-dir <path>", "override the persisted-report directory (default: ./.understanding-gate/reports)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        pack?: string;
        ledgerTimeout?: string;
        reportsDir?: string;
      }) => {
        const cliOpts: Parameters<typeof runPackHookCodexPreToolUseCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        if (options.reportsDir) cliOpts.reportsDir = options.reportsDir;
        if (options.ledgerTimeout) {
          const n = Number.parseInt(options.ledgerTimeout, 10);
          if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
        }
        const result = await runPackHookCodexPreToolUseCli(cliOpts);
        if (result.exitCode !== 0) {
          throw new HarnessExitError("", result.exitCode);
        }
      },
    );

  packHookCmd
    .command("codex-post-tool-use")
    .description(
      "Codex PostToolUse marker-expiry: read tool-event JSON from stdin, delete the per-session (and, where applicable, per-task) approval marker and expire the persisted report when the just-completed tool matches config.approval_lifecycle.expire_on_tool_match / expire_on_bash_match (task a1348c89, mirrors the Claude `post-tool-use` hook).",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .option("--reports-dir <path>", "override the persisted-report directory (default: ./.understanding-gate/reports)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        pack?: string;
        reportsDir?: string;
      }) => {
        const cliOpts: Parameters<typeof runPackHookCodexPostToolUseCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        if (options.reportsDir) cliOpts.reportsDir = options.reportsDir;
        await runPackHookCodexPostToolUseCli(cliOpts);
      },
    );

  packHookCmd
    .command("codex-user-prompt-submit")
    .description(
      "Codex UserPromptSubmit injector: emit the Understanding-Gate instruction template on stdout for Codex to prepend to additional_instructions",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .action(
      async (options: { config?: string; project?: string; pack?: string }) => {
        const cliOpts: Parameters<typeof runPackHookCodexUserPromptSubmitCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        await runPackHookCodexUserPromptSubmitCli(cliOpts);
      },
    );

  packHookCmd
    .command("branch-protection")
    .description(
      "PreToolUse blocker for the branch-protection pack: read tool-event JSON from stdin, consult the " +
        "evidence ledger, emit a deny envelope on protected branches unless either a fresh " +
        "`branch:non-protected` tag (within 5m) or the operator-only override marker " +
        "(written by `harness approve branch-protection`) is present.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .action(async (options: {
      config?: string;
      project?: string;
      ledgerTimeout?: string;
      cwd?: string;
    }) => {
      const cliOpts: Parameters<typeof runPackHookBranchProtectionCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      const result = await runPackHookBranchProtectionCli(cliOpts);
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  packHookCmd
    .command("solution-acceptance")
    .description(
      "PreToolUse completion-gate for the solution-acceptance pack: read tool-event JSON from stdin, " +
        "and on a task-finishing tool (agent-tasks completion verb or `git push` / `gh pr merge`) emit a " +
        "deny envelope unless a ready solution-acceptance verdict exists at the current git HEAD for the " +
        "active-claim task. Fail-closed.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .action(async (options: { config?: string; project?: string; cwd?: string }) => {
      const cliOpts: Parameters<typeof runPackHookSolutionAcceptanceCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.cwd) cliOpts.cwd = options.cwd;
      const result = await runPackHookSolutionAcceptanceCli(cliOpts);
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  packHookCmd
    .command("solution-acceptance-writeguard")
    .description(
      "PreToolUse anti-forgery write-guard for the solution-acceptance pack: read tool-event JSON from " +
        "stdin, emit a deny envelope on any agent write into the solution-verdict dir (path-tool file_path " +
        "inside it, or a non-read-only Bash command that references it). The producer (grounding-mcp) is the " +
        "only legitimate writer.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .action(async (options: { config?: string; project?: string; cwd?: string }) => {
      const cliOpts: Parameters<typeof runPackHookSolutionAcceptanceWriteguardCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.cwd) cliOpts.cwd = options.cwd;
      const result = await runPackHookSolutionAcceptanceWriteguardCli(cliOpts);
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  packHookCmd
    .command("post-merge-gate-record")
    .description(
      "PostToolUse producer for the post-merge-gate pack: read tool-event JSON from stdin and, on a " +
        "`gh pr merge` Bash call whose tool_output.exit_code is the number 0, record a " +
        "`post-merge-gate:merged:<repo>:<branch>:<sha>` fact to the evidence ledger. blocking:false; every " +
        "non-match / failure path is a no-op.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .action(async (options: {
      config?: string;
      project?: string;
      ledgerTimeout?: string;
      cwd?: string;
    }) => {
      const cliOpts: Parameters<typeof runPackHookPostMergeGateRecordCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      await runPackHookPostMergeGateRecordCli(cliOpts);
    });

  packHookCmd
    .command("post-merge-gate")
    .description(
      "PreToolUse blocker for the post-merge-gate pack: read tool-event JSON from stdin, and on a curated " +
        "history-mutating Bash command (git commit/add/push/merge/rebase/cherry-pick/revert/reset/stash " +
        "pop|apply, gh pr create/merge) emit a deny envelope when the current branch tip matches a recorded " +
        "merged-tip fact. The recovery vocabulary (git switch/checkout/pull/fetch, git branch -d/-D, git stash " +
        "list/show, any `harness ...` command) always passes as its own command, classified before any manifest " +
        "or ledger access; chaining one of those with a curated mutation does NOT exempt the mutation. Fails " +
        "open when the ledger is unreachable.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .action(async (options: {
      config?: string;
      project?: string;
      ledgerTimeout?: string;
      cwd?: string;
    }) => {
      const cliOpts: Parameters<typeof runPackHookPostMergeGateCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      const result = await runPackHookPostMergeGateCli(cliOpts);
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  packHookCmd
    .command("runtime-reality")
    .description(
      "PreToolUse drift gate: read tool-event JSON from stdin, run the operator-configured " +
        "RUNTIME_REALITY_PROBE_CMD to capture actual runtime state, compare against the " +
        "RUNTIME_REALITY_KEYWORD expectations file, and emit a deny envelope on critical drift. " +
        "Env-driven (no manifest options); fail-open on any probe / load error.",
    )
    .action(async () => {
      const result = await runPackHookRuntimeRealityCli();
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  packHookCmd
    .command("codex-stop")
    .description(
      "Codex Stop-equivalent: parse the agent's last message for an Understanding Report and persist it under .understanding-gate/reports/ as approvalStatus:pending. Failure modes resolve to exit 0 (capture must never block the agent's stop path).",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--pack <name>", "pack name to evaluate (default: understanding-before-execution)")
    .option("--reports-dir <path>", "override the persisted-report directory (default: ./.understanding-gate/reports)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        pack?: string;
        reportsDir?: string;
      }) => {
        const cliOpts: Parameters<typeof runPackHookCodexStopCli>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.pack) cliOpts.pack = options.pack;
        if (options.reportsDir) cliOpts.reportsDir = options.reportsDir;
        // Intentional: codex-stop's contract is fail-open. The runner
        // returns exitCode 0 on every code path (including malformed
        // input, missing session, parser misses); we deliberately do
        // NOT throw HarnessExitError on a non-zero exit the way the
        // codex-pre-tool-use sibling does. A future runner change
        // that introduces a non-zero exit must also revisit this
        // contract.
        await runPackHookCodexStopCli(cliOpts);
      },
    );

  packCmd
    .command("list")
    .description("Print policy_packs entries as a flat table or JSON.")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--enabled-only", "skip entries with enabled: false")
    .option("--json", "emit JSON array instead of an aligned text table")
    .action(
      (options: {
        config?: string;
        project?: string;
        enabledOnly?: boolean;
        json?: boolean;
      }) => {
        const result = packList({
          ...(options.config !== undefined ? { configPath: options.config } : {}),
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.enabledOnly === true ? { enabledOnly: true } : {}),
          ...(options.json === true ? { json: true } : {}),
        });
        stdout(result.output);
      },
    );

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
      "agent-tasks task id(s) — writes one task-scoped marker per id. Pass several (--task a b c, or --task a,b,c) to pre-approve a whole batch in a single operator action so a multi-task session does not re-prompt per task_finish (harness/1ee26e77, harness/0dce3880)",
    )
    .option("--reports-dir <path>", "override the persisted-report directory (default: ./.understanding-gate/reports)")
    .option("--approved-by <actor>", "actor to record on the persisted report (default: harness-approve-cli)")
    .option(
      "--force",
      "bypass approve-time report validation (priorArt enforcement on grill_me reports). Writes the marker / ledger / report-flip anyway and stamps the ledger tag with `:forced:<field>` so audit can distinguish forced approvals from clean ones. Emergency-unblock path: default refuses the marker when a grill_me report fails validation.",
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
        lines.push(`session: ${result.sessionId}${sourceNote}`);
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
            lines.push(`    ${result.newestReportPath}`);
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
          lines.push(`marker:  ✓ ${result.marker.filePath} (canonical gate signal)`);
        } else {
          lines.push(`marker:  ✗ FAILED (${result.marker.reason})`);
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
        if (result.taskMarkers.length > 1) {
          const okCount = result.taskMarkers.filter((t) => t.ok).length;
          lines.push(
            `         (${okCount}/${result.taskMarkers.length} task markers written — the batch is pre-approved)`,
          );
        }
        if (result.ledger.ok) {
          lines.push(`ledger:  ✓ wrote ${result.ledger.tag} (audit only)`);
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
            `report:  ✓ ${result.persistedReport.filePath} (approvalStatus: ${prev} → approved${stampNote})`,
          );
          const fb = result.persistedReport.fallbackAdopted;
          if (fb) {
            lines.push(
              `  ⚠ adopted via sessionId-less fallback: created ${fb.createdAt ?? "<unknown>"} (${fb.ageMinutes}m ago).`,
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
            lines.push(`validation: ✓ ${v.mode} report passed structural checks`);
          }
        } else if ("ok" in v && v.ok === false) {
          if (v.enforced) {
            lines.push(
              `validation: ✗ ${v.field} FAILED: ${v.reason}`,
            );
            lines.push("  the marker was NOT written; the gate stays closed.");
            lines.push(
              "  pass --force to bypass this check (the ledger tag will be stamped `:forced:<field>` for audit).",
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
              `Run with --force to bypass (the ledger tag will be stamped \`:forced:${v.field}\` for audit).`,
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

  const VALID_DECISION_FILTERS = [
    "allow",
    "warn",
    "require_approval",
    "deny",
    "warn-degraded",
    "deny-degraded",
  ] as const;
  type DecisionFilter = (typeof VALID_DECISION_FILTERS)[number];
  const isDecisionFilter = (v: string): v is DecisionFilter =>
    (VALID_DECISION_FILTERS as readonly string[]).includes(v);

  program
    .command("explain [policy]")
    .description("Print a policy's definition; --trace reads the last recorded evaluation; --last traces the most recent decision in the ledger")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit JSON instead of YAML")
    .option("--trace", "include the full decision trail from the most recent evaluation")
    .option("--last", "trace the most recent policy decision in the ledger (any policy); mutually exclusive with <policy>")
    .option("--decision <outcome>", `with --last, restrict to decisions of this outcome (${VALID_DECISION_FILTERS.join(" / ")})`)
    .option("--session <id>", "grounding session whose audit log to read (default: $CLAUDE_SESSION_ID, then 'default')")
    .action(
      async (
        policyName: string | undefined,
        options: {
          config?: string;
          project?: string;
          json?: boolean;
          trace?: boolean;
          last?: boolean;
          decision?: string;
          session?: string;
        },
      ) => {
        if (options.last && policyName !== undefined) {
          throw new HarnessExitError(
            "explain: <policy> and --last are mutually exclusive",
            EX_USAGE,
          );
        }
        if (options.decision !== undefined && !options.last) {
          throw new HarnessExitError(
            "explain: --decision requires --last",
            EX_USAGE,
          );
        }
        if (options.decision !== undefined && !isDecisionFilter(options.decision)) {
          throw new HarnessExitError(
            `explain: --decision must be one of ${VALID_DECISION_FILTERS.join(", ")} (got "${options.decision}")`,
            EX_USAGE,
          );
        }
        const explainOpts: Parameters<typeof explain>[1] = {};
        if (options.config) explainOpts.configPath = options.config;
        if (options.project) explainOpts.project = options.project;
        if (options.json) explainOpts.json = options.json;
        if (options.trace) explainOpts.trace = options.trace;
        if (options.last) explainOpts.last = options.last;
        if (options.decision !== undefined && isDecisionFilter(options.decision)) {
          explainOpts.decisionFilter = options.decision;
        }
        if (options.session) explainOpts.sessionId = options.session;
        const result = await explain(policyName, explainOpts);
        stdout(result.output);
      },
    );

  program
    .command("explain-action <event.json>")
    .description(
      "Risk Gate debug verb (Phase 7): read a tool-event JSON file (the Claude Code PreToolUse hook payload shape: " +
        "{ hook_event_name, tool_name, tool_input, session_id, cwd }) and print the normalized Action Envelope. " +
        "Inspection surface for the envelope that downstream Risk Gate stages consume; does not evaluate policies.",
    )
    .option("--json", "emit the envelope as JSON instead of YAML")
    .action((eventPath: string, options: { json?: boolean }) => {
      const result = explainAction({
        eventPath,
        ...(options.json === true && { json: true }),
      });
      stdout(result.output);
      if (!result.output.endsWith("\n")) stdout("\n");
    });

  program
    .command("test-risk <event.json>")
    .description(
      "Risk Gate debug verb (Phase 7): read a tool-event JSON file, build its Action Envelope, and classify it " +
        "against the manifest's risk.classifiers[]. Prints the risk profile (severity, categories, reversibility, " +
        "confidence, reasons). An action no pattern matches reports as unclassified, not as safe.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the risk profile as JSON instead of YAML")
    .action(
      (eventPath: string, options: { config?: string; project?: string; json?: boolean }) => {
        const result = testRisk({
          eventPath,
          ...(options.config !== undefined && { configPath: options.config }),
          ...(options.project !== undefined && { project: options.project }),
          ...(options.json === true && { json: true }),
        });
        stdout(result.output);
        if (!result.output.endsWith("\n")) stdout("\n");
      },
    );

  program
    .command("resolve-env <event.json>")
    .description(
      "Risk Gate debug verb (Phase 7): read a tool-event JSON file, build its Action Envelope, and resolve its " +
        "target environment against the manifest's environments.resolvers[] (branch / env-var / kube-context / " +
        "kube-namespace signals). An action no resolver matches resolves to `unknown`, not to a safe default.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the environment resolution as JSON instead of YAML")
    .action(
      (eventPath: string, options: { config?: string; project?: string; json?: boolean }) => {
        const result = resolveEnv({
          eventPath,
          ...(options.config !== undefined && { configPath: options.config }),
          ...(options.project !== undefined && { project: options.project }),
          ...(options.json === true && { json: true }),
        });
        stdout(result.output);
        if (!result.output.endsWith("\n")) stdout("\n");
      },
    );

  program
    .command("explain-policy <policy>")
    .description(
      "Risk Gate debug verb (Phase 7): explain whether <policy> would APPLY to a tool event. " +
        "Reads the event from --event, builds and enriches the Action Envelope, and shows the " +
        "trigger match, the risk classification, the resolved environment, and a per-clause " +
        "`when:` breakdown. Evaluates a hypothetical event live and reads nothing from the " +
        "ledger (use `harness explain <policy> --trace` for the last recorded decision).",
    )
    .requiredOption("--event <event.json>", "path to the tool-event JSON file")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the explanation as JSON instead of YAML")
    .action(
      (
        policyName: string,
        options: {
          event: string;
          config?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        const result = explainPolicy(policyName, {
          eventPath: options.event,
          ...(options.config !== undefined && { configPath: options.config }),
          ...(options.project !== undefined && { project: options.project }),
          ...(options.json === true && { json: true }),
        });
        stdout(result.output);
        if (!result.output.endsWith("\n")) stdout("\n");
      },
    );

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

  program
    .command("smoke")
    .description(
      "Drive `claude -p` end-to-end against the apply'd manifest and assert per --expect-* flags. " +
        "Writes stream.jsonl + stderr.log + settings.json under --output-dir; exits 1 on any expectation miss. " +
        "Replaces the hand-rolled dogfood recipes under dogfood/phase5/.",
    )
    .requiredOption("--prompt <text>", "Prompt fed to claude -p")
    .requiredOption("--output-dir <path>", "Directory for stream.jsonl + stderr.log + settings.json")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--session-id <id>", "session id (default: fresh uuid)")
    .option("--claude-bin <path>", "claude binary (default: $CLAUDE_BIN, then 'claude' on PATH)")
    .option("--timeout-ms <n>", "wall-clock budget in milliseconds (default: 60000)")
    .option(
      "--expect-hook <names>",
      "comma-separated list of hook names / events that MUST fire (repeatable)",
      (value: string, prev: string[] = []) => prev.concat(splitCommaList(value)),
      [] as string[],
    )
    .option(
      "--expect-no-hook <names>",
      "comma-separated list of hook names / events that MUST NOT fire (repeatable)",
      (value: string, prev: string[] = []) => prev.concat(splitCommaList(value)),
      [] as string[],
    )
    .option("--expect-exit <n>", "expected result.is_error: 0 ⇒ false, !=0 ⇒ true")
    .option("--expect-decision <kind>", "policy decision must be one of allow|deny|warn")
    .option(
      "--no-delegate",
      "do not pre-authorize the spawned child (docs/decisions/2026-08-27-ug-auto-mode-approval.md); " +
        "it then has no delegation binding it to this approved session and falls back to the plain opt-in path",
    )
    .action(async (options: {
      prompt: string;
      outputDir: string;
      config?: string;
      project?: string;
      sessionId?: string;
      claudeBin?: string;
      timeoutMs?: string;
      expectHook?: string[];
      expectNoHook?: string[];
      expectExit?: string;
      expectDecision?: string;
      delegate?: boolean;
    }) => {
      const expectations: SmokeExpectations = {};
      if (options.expectHook && options.expectHook.length > 0) {
        expectations.expectHooks = options.expectHook;
      }
      if (options.expectNoHook && options.expectNoHook.length > 0) {
        expectations.expectNoHooks = options.expectNoHook;
      }
      if (options.expectExit !== undefined) {
        const n = Number.parseInt(options.expectExit, 10);
        if (!Number.isFinite(n)) {
          throw new HarnessExitError(
            `harness smoke: --expect-exit must be an integer (got "${options.expectExit}")`,
            EX_USAGE,
          );
        }
        expectations.expectExit = n;
      }
      if (options.expectDecision !== undefined) {
        expectations.expectDecision = options.expectDecision as ExpectDecision;
      }
      const smokeOpts: Parameters<typeof runSmoke>[0] = {
        prompt: options.prompt,
        outputDir: options.outputDir,
        expectations,
      };
      // commander's `--no-delegate` negates `options.delegate` (default
      // true); only an explicit `--no-delegate` flips it to `false`.
      if (options.delegate === false) smokeOpts.noDelegate = true;
      if (options.config) smokeOpts.configPath = options.config;
      if (options.project) smokeOpts.project = options.project;
      if (options.sessionId) smokeOpts.sessionId = options.sessionId;
      if (options.claudeBin) smokeOpts.claudeBin = options.claudeBin;
      if (options.timeoutMs !== undefined) {
        const n = Number.parseInt(options.timeoutMs, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new HarnessExitError(
            `harness smoke: --timeout-ms must be a positive integer`,
            EX_USAGE,
          );
        }
        smokeOpts.timeoutMs = n;
      }
      const result = await runSmoke(smokeOpts);
      stdout(formatSmokeReport(result));
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  // Top-level alias for `harness session-start preflight`, so the
  // policy `ux.run:` field can show the short form the agent should
  // type: `Run: harness preflight`. The handler delegates to the same
  // implementation, with the same CLI options.
  program
    .command("preflight")
    .description(
      "Alias for `harness session-start preflight`: run agent-preflight against the session cwd " +
        "and, on a ready:true result, record a `preflight:${REPO}` fact to the evidence ledger.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--session <id>", "explicit session id (overrides stdin event + env)")
    .option("--timeout <ms>", "agent-preflight subprocess timeout in milliseconds (default 60000)")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(async (options: {
      config?: string;
      project?: string;
      session?: string;
      timeout?: string;
      ledgerTimeout?: string;
    }) => {
      const cliOpts: Parameters<typeof runSessionStartPreflight>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.session) cliOpts.session = options.session;
      if (options.timeout) {
        const n = Number.parseInt(options.timeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.preflightTimeoutMs = n;
      }
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      // Opt into the bootstrap-staging side effect from the CLI entry
      // point only. Library callers (vitest cases) get the no-op default
      // so they cannot clobber the operator's real pending-approval file.
      cliOpts.stagePendingApproval = writePendingApproval;
      await runSessionStartPreflight(cliOpts);
    });

  // Shared by the three `record` verbs' action handlers below: parse
  // `--ledger-timeout <ms>` into `cliOpts.ledgerTimeoutMs`, and report a
  // `RecordResult` (print the recorded fact on success; on failure, throw
  // with the runner's own exit code and an EMPTY message, since the
  // runner already wrote the reason to stderr itself — throwing the same
  // text again would double-print it).
  //
  // An unparseable / non-positive value used to fall back to the
  // default silently (review finding, T-004): an operator who typo'd
  // `--ledger-timeout 5ooo` got the default timeout with zero
  // diagnostic. Now a malformed value warns once on stderr before
  // falling back, same "never a silent gap" convention `resolveBase`'s
  // own degrade path already uses below.
  const applyLedgerTimeout = (
    raw: string | undefined,
    cliOpts: { ledgerTimeoutMs?: number },
  ): void => {
    if (!raw) return;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      cliOpts.ledgerTimeoutMs = n;
      return;
    }
    stderr(
      `harness record: --ledger-timeout ${JSON.stringify(raw)} is not a positive integer; using the default timeout.\n`,
    );
  };
  const reportRecordResult = (result: RecordResult): void => {
    if (result.wrote) {
      stdout(`recorded ${result.content} for session ${result.sessionId}\n`);
    }
    if (result.exitCode !== 0) {
      throw new HarnessExitError("", result.exitCode);
    }
  };

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
        "review-subagent-before-pr-create / review-subagent-before-pr-create-bash gates.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .requiredOption("--task <id>", "agent-tasks task id the review-subagent:${TASK_ID} tag is namespaced by")
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
          task: string;
          verdict: string;
          branch?: string;
          session?: string;
          ledgerTimeout?: string;
        },
      ) => {
        const cliOpts: Parameters<typeof runRecordReviewSubagent>[0] = {
          task: options.task,
          verdict: options.verdict,
        };
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
  sessionStart
    .command("preflight")
    .description(
      "SessionStart producer: run agent-preflight against the session cwd and, on a ready:true result, " +
        "record a `preflight:${REPO}` fact to the evidence ledger so the preflight-before-* policies have a " +
        "fresh tag to match. Reads SessionStart event JSON from stdin ({ session_id, cwd, hook_event_name }). " +
        "blocking:false — every failure path logs to stderr and exits 0.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (overrides stdin event + env). Use for manual / scripted invocations " +
        "where no SessionStart event JSON is piped on stdin. Without it the resolver tries " +
        "stdin event → $CLAUDE_SESSION_ID → newest Claude Code transcript → 'default' (which logs " +
        "a loud warning since the literal 'default' session never satisfies a preflight-before-* gate).",
    )
    .option("--timeout <ms>", "agent-preflight subprocess timeout in milliseconds (default 60000)")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(async (options: {
      config?: string;
      project?: string;
      session?: string;
      timeout?: string;
      ledgerTimeout?: string;
    }) => {
      const cliOpts: Parameters<typeof runSessionStartPreflight>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.session) cliOpts.session = options.session;
      if (options.timeout) {
        const n = Number.parseInt(options.timeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.preflightTimeoutMs = n;
      }
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      // Opt into the bootstrap-staging side effect from the CLI entry
      // point only. Library callers (vitest cases) get the no-op default
      // so they cannot clobber the operator's real pending-approval file.
      cliOpts.stagePendingApproval = writePendingApproval;
      await runSessionStartPreflight(cliOpts);
    });
  sessionStart
    .command("branch-check")
    .description(
      "SessionStart producer for the branch-protection pack: read .git/HEAD for the session cwd and, " +
        "when the branch is NOT in the operator's protected list (default: master, main, develop), " +
        "record a `branch:non-protected:<branch>` fact to the evidence ledger so the pack's PreToolUse " +
        "blocker has a fresh tag to satisfy its 5-minute freshness window. Also runnable on demand from " +
        "the operator's shell. blocking:false — every failure path logs to stderr and exits 0.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (overrides stdin event + env)",
    )
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(async (options: {
      config?: string;
      project?: string;
      session?: string;
      cwd?: string;
      ledgerTimeout?: string;
    }) => {
      const cliOpts: Parameters<typeof runSessionStartBranchCheck>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.session) cliOpts.session = options.session;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      await runSessionStartBranchCheck(cliOpts);
    });
  sessionStart
    .command("toolchain-parity")
    .description(
      "SessionStart producer (opt-in via `toolchain_parity.enabled: true`): writes THIS machine's " +
        "toolchain snapshot (node version, npm globals, OW-Kit version, MCP server names) to " +
        "`<machine_state_dir>/<profile>.json`, compares it against every OTHER snapshot file already " +
        "in that directory, and records a `toolchain-parity:ok` / `toolchain-parity:drift:<n>` fact " +
        "(with a `:unparseable-peer:<n>` suffix whenever a peer file failed to parse as JSON, so an " +
        "unparseable peer never silently vanishes from the comparison) to the evidence ledger. " +
        "Purely advisory — never blocking, and never touches a peer's file. " +
        "Cross-machine transport of the snapshot files is agent-memory-sync's job, not this command's.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (overrides stdin event + env)",
    )
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(async (options: {
      config?: string;
      project?: string;
      session?: string;
      cwd?: string;
      ledgerTimeout?: string;
    }) => {
      const cliOpts: Parameters<typeof runSessionStartToolchainParity>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.session) cliOpts.session = options.session;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      await runSessionStartToolchainParity(cliOpts);
    });
  sessionStart
    .command("stale-base-check")
    .description(
      "SessionStart producer (opt-in via `stale_base_check.enabled: true`; task ce3903b0, incident " +
        "ea8becf5): runs a LIVE `git fetch` of the remote default branch (never trusting the local " +
        "origin/<default> ref, which can itself be stale — that is the exact bug this closes) and, when " +
        "the current branch's base is behind, writes a WARNING to stderr naming how many commits behind, " +
        "how old the missing work is, and the recovery command. Records a `stale-base:ok` / " +
        "`stale-base:behind:<n>` fact to the evidence ledger (audit-only — no gate consumes it). " +
        "Purely advisory: never blocks, and degrades cleanly (no fact written) when offline, the remote " +
        "or default branch can't be resolved, or credentials are missing. blocking:false — every failure " +
        "path logs to stderr and exits 0.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (overrides stdin event + env)",
    )
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds")
    .action(async (options: {
      config?: string;
      project?: string;
      session?: string;
      cwd?: string;
      ledgerTimeout?: string;
    }) => {
      const cliOpts: Parameters<typeof runSessionStartStaleBaseCheck>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.session) cliOpts.session = options.session;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.ledgerTimeout) {
        const n = Number.parseInt(options.ledgerTimeout, 10);
        if (Number.isFinite(n) && n > 0) cliOpts.ledgerTimeoutMs = n;
      }
      await runSessionStartStaleBaseCheck(cliOpts);
    });

  // `harness gate` — operator escape hatch for hard-blocking hooks.
  // Task 8fcddb26: the understanding-before-execution PreToolUse hook can
  // lock a Claude session out of every Bash call, and the recommended
  // recovery (`harness approve understanding`) is itself a Bash invocation
  // and gets caught by the same gate. `gate disable` strips the
  // offending hook group out of settings.json with a reversible snapshot.
  const gate = program
    .command("gate")
    .description("Operator escape hatch: disable/restore hook groups in ~/.claude/settings.json");
  gate
    .command("disable")
    .description(
      "Remove hook groups from ~/.claude/settings.json whose `matcher` substring-matches " +
        "`--matcher <pattern>`. Writes a snapshot of the removed groups next to settings.json " +
        "(`harness.gate-disable.<ts>.json`) and backs up the original to `settings.json.bak.<ts>` " +
        "so `harness gate enable` can restore them. With no `--matcher` flag, lists the candidate " +
        "groups without writing.",
    )
    .option("--matcher <pattern>", "remove groups whose matcher includes this substring")
    .option("--settings <path>", "override ~/.claude/settings.json")
    .action(async (options: { matcher?: string; settings?: string }) => {
      const cliOpts: Parameters<typeof gateDisable>[0] = {};
      if (options.matcher) cliOpts.matcher = options.matcher;
      if (options.settings) cliOpts.settingsPath = options.settings;
      try {
        const result = gateDisable(cliOpts);
        if (result.mode === "list") {
          if (result.candidates.length === 0) {
            stdout(`no hook groups in ${result.settingsPath}; nothing to disable.\n`);
            return;
          }
          stdout(`candidate hook groups in ${result.settingsPath}:\n`);
          for (const c of result.candidates) {
            const matcherLabel = c.matcher === null ? "(no matcher)" : JSON.stringify(c.matcher);
            stdout(`  ${c.event}[${c.index}] matcher=${matcherLabel}: ${c.description}\n`);
          }
          stdout(
            `\nPass --matcher <substring> to remove a group. Removal is reversible via ` +
              `\`harness gate enable\`.\n`,
          );
          return;
        }
        stdout(`disabled ${result.removed.length} hook group(s) in ${result.settingsPath}:\n`);
        for (const r of result.removed) {
          const matcherLabel =
            r.group !== null && typeof r.group === "object" && !Array.isArray(r.group)
              ? JSON.stringify((r.group as Record<string, unknown>)["matcher"] ?? null)
              : "null";
          stdout(`  ${r.event}[${r.index}] matcher=${matcherLabel}\n`);
        }
        stdout(`backup:   ${result.backupPath}\n`);
        stdout(`snapshot: ${result.snapshotPath}\n`);
        stdout(`This is reversible: run \`harness gate enable\` to restore.\n`);
      } catch (err) {
        if (err instanceof GateDisableError) {
          throw new HarnessExitError(err.message, EX_FAIL);
        }
        throw err;
      }
    });
  gate
    .command("enable")
    .description(
      "Restore hook groups from the newest `harness.gate-disable.*.json` snapshot next to " +
        "settings.json. Refuses if settings.json has been edited since the snapshot was taken " +
        "(use `--force` to restore anyway). Idempotent: if settings.json already matches the " +
        "pre-disable state, exits 0 without writing.",
    )
    .option("--settings <path>", "override ~/.claude/settings.json")
    .option("--force", "restore even when settings.json has been edited since the snapshot")
    .action(async (options: { settings?: string; force?: boolean }) => {
      const cliOpts: Parameters<typeof gateEnable>[0] = {};
      if (options.settings) cliOpts.settingsPath = options.settings;
      if (options.force) cliOpts.force = true;
      try {
        const result = gateEnable(cliOpts);
        if (result.mode === "no-snapshots") {
          stdout(`no gate-disable snapshots found next to ${result.settingsPath}; nothing to restore.\n`);
          return;
        }
        if (result.mode === "already-restored") {
          stdout(
            `settings.json already matches the pre-disable state; no write needed. ` +
              `(snapshot: ${result.snapshotPath})\n`,
          );
          return;
        }
        stdout(
          `restored ${result.restoredCount} hook group(s) into ${result.settingsPath} from ` +
            `${result.snapshotPath}.\n`,
        );
      } catch (err) {
        if (err instanceof GateEnableError) {
          throw new HarnessExitError(err.message, EX_FAIL);
        }
        throw err;
      }
    });

  program
    .command("gc")
    .description(
      "Retention-based cleanup of harness-owned gate state: terminal " +
        "(approved/expired) understanding-gate reports, parse-error logs, " +
        "approval markers, expired delegation markers, orphaned delegation " +
        "adoption ledgers, and stale permission-mode observations older than " +
        "the retention window, plus stale in-flight subagent records (fixed " +
        "24h window, independent of --retention-days). Pending reports and " +
        "anything outside the enumerated harness-owned dirs are never " +
        "touched (the evidence ledger and solution-acceptance verdict dirs " +
        "are owned by their producers). Dry-run by default; pass --apply " +
        "to delete.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option(
      "--retention-days <n>",
      `delete artifacts older than this many days (default: ${DEFAULT_RETENTION_DAYS})`,
    )
    .option("--apply", "delete the listed artifacts (default: dry-run listing only)")
    .action((options: { config?: string; retentionDays?: string; apply?: boolean }) => {
      const cliOpts: Parameters<typeof gc>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.apply) cliOpts.apply = true;
      if (options.retentionDays !== undefined) {
        const parsed = Number(options.retentionDays);
        if (!Number.isFinite(parsed) || parsed < 1) {
          stderr(`--retention-days must be a positive number, got ${JSON.stringify(options.retentionDays)}\n`);
          throw new HarnessExitError("", EX_USAGE);
        }
        cliOpts.retentionDays = parsed;
      }
      const result = gc(cliOpts);
      const sweptDirs = [
        result.reportsDir,
        ...(result.parseErrorsDir !== null ? [result.parseErrorsDir] : []),
        result.approvalsDir,
        result.delegationsDir,
        result.adoptionLedgerDir,
        result.permissionModeObservationsDir,
        result.inflightRecordsDir,
      ];
      if (result.parseErrorsDir === null) {
        stderr(
          "gc: skipping the parse-errors sweep (reports dir does not have the conventional .understanding-gate/reports shape)\n",
        );
      }
      if (result.unparseable.length > 0) {
        stderr(
          `gc: ${result.unparseable.length} file(s) could not be parsed and were left in place:\n` +
            result.unparseable.map((u) => `  [${u.category}] ${u.filePath} (${u.reason})\n`).join(""),
        );
      }
      if (result.candidates.length === 0) {
        stdout(
          `gc: nothing older than ${result.retentionDays}d (cutoff ${result.cutoffIso}) under\n` +
            sweptDirs.map((d) => `  ${d}\n`).join("") +
            `${result.keptCount} artifact(s) inspected and kept.\n`,
        );
        return;
      }
      const verb = result.applied ? "removing" : "would remove";
      stdout(
        `gc: ${verb} ${result.candidates.length} artifact(s) older than ${result.retentionDays}d (cutoff ${result.cutoffIso}); keeping ${result.keptCount}:\n`,
      );
      for (const c of result.candidates) {
        stdout(`  [${c.category}] ${c.filePath} (${c.reason})\n`);
      }
      if (!result.applied) {
        stdout(`\nDry-run; pass --apply to delete.\n`);
        return;
      }
      stdout(`removed ${result.removed.length} file(s).\n`);
      if (result.failures.length > 0) {
        for (const f of result.failures) {
          stderr(`gc: failed to remove ${f.filePath}: ${f.reason}\n`);
        }
        throw new HarnessExitError(
          `${result.failures.length} deletion(s) failed`,
          EX_FAIL,
        );
      }
    });

  program
    .command("uninstall")
    .description(
      "Clean teardown of a harness installation. Inventories harness-owned " +
        "state (manifest, lock, harness.generated/, .understanding-gate/ under " +
        "the state root; hook groups and mcpServers in ~/.claude/settings.json) " +
        "and prints it. With --apply, removes it after writing a reversible " +
        "settings.json backup + snapshot. " +
        "settings.json.pre-harness-<TS> backups are listed but never deleted, " +
        "so the operator can hand them to --restore-from <path> (atomic restore " +
        "from that file) or `rm` them manually.",
    )
    .option("--apply", "execute the teardown (default: dry-run listing only)")
    .option(
      "--restore-from <path>",
      "atomic restore: copy this file over settings.json instead of selective removal (implies --apply)",
    )
    .option(
      "--home <path>",
      "override ~/.claude/ (settings home; without --state it also overrides the state root, for tests / non-default installs)",
    )
    .option(
      "--state <path>",
      "override the harness state root (default: ~/.harness/, legacy fallback ~/.claude/)",
    )
    .option("--settings <path>", "override ~/.claude/settings.json")
    .action(async (options: { apply?: boolean; restoreFrom?: string; home?: string; state?: string; settings?: string }) => {
      const cliOpts: Parameters<typeof uninstall>[0] = {};
      if (options.apply) cliOpts.apply = true;
      if (options.restoreFrom) cliOpts.restoreFrom = options.restoreFrom;
      if (options.home) cliOpts.homeDir = options.home;
      if (options.state) cliOpts.stateDir = options.state;
      if (options.settings) cliOpts.settingsPath = options.settings;
      try {
        const result = await uninstall(cliOpts);
        const inv = result.inventory;
        if (result.mode === "list") {
          const nothing =
            inv.manifestPath === null &&
            inv.lockPath === null &&
            inv.generatedDir === null &&
            inv.gateStateDir === null &&
            inv.hookGroups.length === 0 &&
            inv.mcpServers.length === 0 &&
            inv.mcpRegistryServers.length === 0 &&
            inv.preHarnessBackups.length === 0;
          const rootsLabel =
            inv.stateDir === inv.homeDir
              ? inv.homeDir
              : `${inv.stateDir} (state) + ${inv.homeDir} (settings)`;
          if (nothing) {
            stdout(`no harness install found under ${rootsLabel}; nothing to do.\n`);
            for (const w of inv.warnings) stderr(`warning: ${w}\n`);
            return;
          }
          stdout(`harness install under ${rootsLabel}:\n`);
          if (inv.manifestPath) stdout(`  manifest:  ${inv.manifestPath}\n`);
          if (inv.lockPath) stdout(`  lock:      ${inv.lockPath}\n`);
          if (inv.generatedDir) stdout(`  generated: ${inv.generatedDir}/\n`);
          if (inv.gateStateDir) stdout(`  gate:      ${inv.gateStateDir}/ (understanding-gate state)\n`);
          if (inv.hookGroups.length > 0) {
            stdout(`  hook groups in ${inv.settingsPath}:\n`);
            for (const g of inv.hookGroups) {
              const matcherLabel = g.matcher === null ? "(no matcher)" : JSON.stringify(g.matcher);
              stdout(`    ${g.event}[${g.index}] matcher=${matcherLabel}: ${g.description}\n`);
            }
          }
          if (inv.mcpServers.length > 0) {
            stdout(`  mcpServers in ${inv.settingsPath}: ${inv.mcpServers.join(", ")}\n`);
          }
          if (inv.mcpRegistryServers.length > 0) {
            stdout(
              `  mcpServers registered in the claude CLI user-scope registry (${inv.mcpRegistryPath}): ` +
                `${inv.mcpRegistryServers.join(", ")}\n`,
            );
          }
          if (inv.preHarnessBackups.length > 0) {
            stdout(`  pre-harness backups:\n`);
            for (const b of inv.preHarnessBackups) stdout(`    ${b}\n`);
            stdout(
              `\n  Restore from one of these with: harness uninstall --restore-from <path>\n`,
            );
          }
          stdout(`\nPass --apply to remove the above. This is a dry-run.\n`);
          for (const w of inv.warnings) stderr(`warning: ${w}\n`);
          return;
        }
        if (result.mode === "restore") {
          stdout(`restored ${inv.settingsPath} from ${result.restoredFrom}.\n`);
          stdout(`backup:   ${result.backupPath}\n`);
          stdout(`snapshot: ${result.snapshotPath}\n`);
          if (result.removedFiles.length > 0) {
            stdout(`removed:\n`);
            for (const f of result.removedFiles) stdout(`  ${f}\n`);
          }
          if (result.mcpRegistryRemovals.length > 0) {
            stdout(`claude mcp remove (user scope, ${inv.mcpRegistryPath}):\n`);
            for (const r of result.mcpRegistryRemovals) stdout(`  ${r.name}: ${r.status}\n`);
          }
          stdout(
            `\nTo finish: \`npm uninstall -g @lannguyensi/harness\` (uninstall does not touch the npm install).\n`,
          );
          for (const w of inv.warnings) stderr(`warning: ${w}\n`);
          return;
        }
        // apply
        if (result.backupPath !== null && result.snapshotPath !== null) {
          stdout(`mutated ${inv.settingsPath}:\n`);
          if (inv.hookGroups.length > 0) {
            stdout(`  removed ${inv.hookGroups.length} hook group(s): `);
            stdout(inv.hookGroups.map((g) => `${g.event}[${g.index}]`).join(", "));
            stdout(`\n`);
          }
          if (inv.mcpServers.length > 0) {
            stdout(`  removed mcpServers: ${inv.mcpServers.join(", ")}\n`);
          }
          stdout(`backup:   ${result.backupPath}\n`);
          stdout(`snapshot: ${result.snapshotPath}\n`);
        }
        if (result.removedFiles.length > 0) {
          stdout(`removed from disk:\n`);
          for (const f of result.removedFiles) stdout(`  ${f}\n`);
          // Explicit kept-list: name whatever survives under the state
          // root (machines/ + projects/ override layers are
          // operator-authored; foreign files are not ours to judge) so
          // the operator never has to discover residue by accident.
          try {
            const residue = fs
              .readdirSync(inv.stateDir)
              .filter((name) => !name.startsWith("settings.json"));
            if (residue.length > 0) {
              stdout(
                `kept under ${inv.stateDir}: ${residue.join(", ")} (not removed; operator-authored or out of scope)\n`,
              );
            }
          } catch {
            /* state root itself may be gone or unreadable; nothing to report */
          }
        }
        if (result.mcpRegistryRemovals.length > 0) {
          stdout(`claude mcp remove (user scope, ${inv.mcpRegistryPath}):\n`);
          for (const r of result.mcpRegistryRemovals) stdout(`  ${r.name}: ${r.status}\n`);
        }
        if (
          result.backupPath === null &&
          result.snapshotPath === null &&
          result.removedFiles.length === 0 &&
          result.mcpRegistryRemovals.length === 0
        ) {
          const rootsLabel =
            inv.stateDir === inv.homeDir
              ? inv.homeDir
              : `${inv.stateDir} (state) + ${inv.homeDir} (settings)`;
          stdout(`no harness install found under ${rootsLabel}; nothing to remove.\n`);
        } else {
          stdout(
            `\nTo finish: \`npm uninstall -g @lannguyensi/harness\` (uninstall does not touch the npm install).\n`,
          );
        }
        for (const w of inv.warnings) stderr(`warning: ${w}\n`);
      } catch (err) {
        if (err instanceof UninstallError) {
          throw new HarnessExitError(err.message, EX_FAIL);
        }
        throw err;
      }
    });

  program
    .command("migrate-home")
    .description(
      "Move harness operator-state from the legacy ~/.claude/ root to the runtime-neutral " +
        "~/.harness/ root introduced in v0.24.0. Dry-run by default; pass --apply to perform " +
        "the move. Re-running on already-migrated state is a no-op. Moves: harness.yaml, " +
        "harness.generated/, .understanding-gate/, harness.lock. Does NOT touch settings.json " +
        "or any other ~/.claude/ contents.",
    )
    .option("--apply", "perform the move (default: dry-run report only)")
    .action(async (options: { apply?: boolean }) => {
      const result = migrateHome({ ...(options.apply ? { apply: true } : {}) });
      if (result.outcome === "target-conflict") {
        throw new HarnessExitError("", EX_FAIL);
      }
    });

  // `harness pause` / `harness resume`: operator-only kill switch.
  // Sibling top-level commands: `pause` must start its own
  // `program.command(...)` statement. It was previously chained onto the
  // `migrate-home` block above, which (Commander's `.command()` returns
  // the new subcommand) registered it as `harness migrate-home pause`
  // and dropped it from top-level `harness --help`.
  program
    .command("pause")
    .description(
      "Temporarily make all harness hooks dormant by writing a sentinel under harness.generated/. " +
        "Operator-only (refuses when $CLAUDE_CODE_SESSION_ID, $CLAUDE_SESSION_ID, or $CODEX_SESSION_ID " +
        "is set, or stdin is non-TTY). Intended for lockout recovery, debug A/B-tests, and incident " +
        "hotfixes. NOT for routine gate bypass: for permanent per-policy disable, edit " +
        "`policies[].enabled` in the manifest.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--for <duration>",
      "auto-resume after this duration (e.g. 5m, 1h, PT30S; default: 15m)",
    )
    .option("--indefinite", "skip auto-expiry (requires --i-am-the-operator-and-accept-no-auto-resume)")
    .option(
      "--i-am-the-operator-and-accept-no-auto-resume",
      "acknowledge that --indefinite leaves harness dormant until you remember to resume",
    )
    .option("--reason <text>", "free-form reason recorded in the sentinel + announced on each hook fire")
    .option("--i-am-the-operator", "acknowledge a scripted / non-TTY invocation (otherwise refused)")
    .action(
      async (options: {
        config?: string;
        project?: string;
        for?: string;
        indefinite?: boolean;
        iAmTheOperatorAndAcceptNoAutoResume?: boolean;
        reason?: string;
        iAmTheOperator?: boolean;
      }) => {
        const cliOpts: Parameters<typeof pauseHarness>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.for) cliOpts.forDuration = options.for;
        if (options.indefinite) cliOpts.indefinite = true;
        if (options.iAmTheOperatorAndAcceptNoAutoResume) cliOpts.acceptNoAutoResume = true;
        if (options.reason) cliOpts.reason = options.reason;
        if (options.iAmTheOperator) cliOpts.iAmTheOperator = true;
        const result = await pauseHarness(cliOpts);
        const lines: string[] = [];
        if (result.alreadyPaused) {
          lines.push("note:    harness was already paused; sentinel overwritten with new expiry");
        }
        const expiry =
          result.sentinel.expiresAt === null
            ? "indefinite (no auto-resume)"
            : `auto-resumes at ${result.sentinel.expiresAt}`;
        lines.push(`paused:  ✓ ${result.sentinelPath}`);
        lines.push(`expiry:  ${expiry}`);
        if (result.sentinel.reason !== null) {
          lines.push(`reason:  ${result.sentinel.reason}`);
        }
        if (result.ledger.ok) {
          lines.push(`ledger:  ✓ wrote ${result.ledger.tag} (audit)`);
        } else {
          lines.push(`ledger:  ⚠ skipped (${result.ledger.reason ?? "unknown"}) (audit)`);
        }
        lines.push("");
        lines.push("Hooks will allow + emit a stderr notice while paused. Run `harness resume` to re-enable.");
        stdout(`${lines.join("\n")}\n`);
      },
    );

  program
    .command("resume")
    .description(
      "Delete the pause sentinel and re-enable harness hooks. Operator-only. Idempotent: " +
        "running against an un-paused install exits 0 with a notice.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--i-am-the-operator", "acknowledge a scripted / non-TTY invocation (otherwise refused)")
    .action(
      async (options: { config?: string; project?: string; iAmTheOperator?: boolean }) => {
        const cliOpts: Parameters<typeof resumeHarness>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.iAmTheOperator) cliOpts.iAmTheOperator = true;
        const result = await resumeHarness(cliOpts);
        const lines: string[] = [];
        if (!result.wasPaused) {
          lines.push(`resume:  · harness was not paused (${result.sentinelPath} did not exist)`);
        } else {
          lines.push(`resume:  ✓ deleted ${result.sentinelPath}`);
          if (result.previousSentinel) {
            const prev = result.previousSentinel;
            lines.push(`prev:    pausedAt=${prev.pausedAt} expiresAt=${prev.expiresAt ?? "indefinite"}`);
            if (prev.reason !== null) lines.push(`reason:  ${prev.reason}`);
          }
          if (result.ledger.ok) {
            lines.push(`ledger:  ✓ wrote ${result.ledger.tag} (audit)`);
          } else {
            lines.push(`ledger:  ⚠ skipped (${result.ledger.reason ?? "unknown"}) (audit)`);
          }
        }
        stdout(`${lines.join("\n")}\n`);
      },
    );

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
    // Defense-in-depth (task 325ace29): a hermetic-spawn-guard violation
    // must always propagate out of run() as a hard failure, never be
    // folded into the generic "return 70" branch below. Without this,
    // any test that merely asserts "exit code != 0" (rather than the
    // specific message) would mask a future real spawn slipping past a
    // guarded call site. This is production-neutral: the guard
    // (src/runtime/hermetic-spawn-guard.ts) only ever throws when
    // `process.env.VITEST` is set, which a real, standalone `harness`
    // invocation never has — so this branch is unreachable outside of
    // vitest and changes no production behavior.
    if (err instanceof HermeticSpawnViolationError) throw err;
    if (err instanceof HarnessExitError) {
      if (err.exitCode !== 0 && err.message) stderr(`${err.message}\n`);
      return err.exitCode;
    }
    stderr(`${(err as Error).message ?? err}\n`);
    return 70;
  }
}
