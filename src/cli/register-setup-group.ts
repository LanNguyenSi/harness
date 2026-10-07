import * as path from "node:path";
import type { Command } from "commander";
import { add } from "./add/index.js";
import type { AddEntry } from "./add/mutate.js";
import { adopt } from "./adopt/index.js";
import {
  apply,
  CODEX_CONFIG_BASENAME,
  CodexInstallRefusalError,
  DRIFT_HINT_MESSAGE,
  formatNextSteps,
  formatRuntimeLine,
  OPENCODE_CONFIG_BASENAME,
  SETTINGS_BASENAME,
  type FileApplyOutcome,
} from "./apply/index.js";
import { isRuntime, KNOWN_RUNTIMES, type Runtime } from "../policy-packs/index.js";
import { exportManifest } from "./export.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { detect as detectInit } from "./init/detect.js";
import { init, isTemplate, KNOWN_TEMPLATES } from "./init/index.js";
import { runInteractive } from "./init/interactive.js";

export function registerSetupGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout, stderr } = io;
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
      "additionally write the generated settings.json to <path> (e.g. .claude/settings.local.json); " +
        "claude-code only: without --runtime it implies claude-code, with --runtime codex or opencode it is refused",
    )
    .option(
      "--merge",
      "with --target, 3-way merge into an existing target file (replace owned keys, preserve others)",
    )
    .option("--force", "with --target, overwrite an existing target file (no merge)")
    .option(
      "--runtime <runtime>",
      `policy-pack adapter runtime (${KNOWN_RUNTIMES.join(" | ")}; default: claude-code with --target, ` +
        "otherwise the runtime of the last apply (inferred from its files for an older record), " +
        "or claude-code when there is none; --install follows the same default). " +
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

        // `apply()` throws `CodexInstallRefusalError` (rather than
        // returning a refuse `outcome`, the way `target-exists-refuse` /
        // `drift-refuse` do) for a codex-install refusal, because the
        // refusal is detected deep inside `planCodexConfigInstall`, before
        // an `ApplyResult` can be assembled. Catch it here so `--json`
        // still gets a structured error on stdout the same way every
        // other refusal does, instead of only the plain-text message
        // `run()`'s top-level catch would otherwise print.
        let result: Awaited<ReturnType<typeof apply>>;
        try {
          result = await apply({
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
        } catch (err) {
          if (err instanceof CodexInstallRefusalError && options.json) {
            stdout(
              `${JSON.stringify(
                { outcome: "codex-install-refuse", configPath: err.configPath, error: err.message },
                null,
                2,
              )}\n`,
            );
            throw new HarnessExitError("", EX_FAIL);
          }
          throw err;
        }

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

        // Name a reused or switched runtime before the file list, in the
        // dry-run and the real apply alike (agent-tasks b9e6d63c).
        const runtimeLine = formatRuntimeLine(result);
        if (runtimeLine !== null) stdout(`${runtimeLine}\n`);

        if (result.outcome === "no-changes") {
          stdout("no changes\n");
        } else if (result.outcome === "would-apply") {
          stdout(`would apply ${changedFiles.length} file(s):\n`);
          for (const f of changedFiles) {
            stdout(`  ${f.path}\n`);
          }
          if (result.codexConfigInstall?.changed) {
            stdout(`  ${result.codexConfigInstall.configPath} (Codex install)\n`);
            for (const id of result.codexConfigInstall.removedHookIds) {
              stdout(`    removing hook block: ${id}\n`);
            }
            for (const section of result.codexConfigInstall.foreignSectionsPreserved) {
              stdout(`    preserving foreign section: ${section}\n`);
            }
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
            for (const id of result.codexConfigInstall.removedHookIds) {
              stdout(`  removed hook block: ${id}\n`);
            }
            for (const section of result.codexConfigInstall.foreignSectionsPreserved) {
              stdout(`  preserved foreign section: ${section}\n`);
            }
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
                runtime: result.runtime,
                ...((result.targetWritten || result.targetInSync) && result.targetPath
                  ? { targetPath: result.targetPath }
                  : {}),
                // Pass the --install outcome through whenever one was
                // requested this run (written or a no-op), so the codex
                // lede reflects reality instead of always claiming
                // "nothing is installed yet".
                ...(result.codexConfigInstall !== undefined
                  ? {
                      codexInstall: {
                        configPath: result.codexConfigInstall.configPath,
                        written: result.codexConfigInstall.written,
                        ...(result.codexConfigInstall.backupPath !== undefined
                          ? { backupPath: result.codexConfigInstall.backupPath }
                          : {}),
                      },
                    }
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
}
