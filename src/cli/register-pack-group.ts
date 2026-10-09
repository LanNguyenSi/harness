import type { Command } from "commander";
import { packAdd, packList, packRemove, packReseed, packUpgrade } from "./pack/index.js";
import { runPackHookBranchProtectionCli } from "./pack/hook-branch-protection.js";
import { runPackHookRuntimeRealityCli } from "./pack/hook-runtime-reality.js";
import { HarnessExitError } from "./exit-codes.js";

export function registerPackGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout, stderr } = io;
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

  // `harness pack hook` runtime sub-tree (Phase 6 #4): wired by pack hook
  // contributions in settings.json; reads tool-event JSON from stdin and
  // emits Claude Code deny JSON on block.
  const packHookCmd = packCmd
    .command("hook")
    .description("Pack runtime hook entrypoints (called by Claude Code via settings.json)");

  packHookCmd
    .command("branch-protection")
    .description(
      "PreToolUse blocker for the branch-protection pack: read tool-event JSON from stdin, ask git " +
        "(`git -C <dir> symbolic-ref -q HEAD`) for the branch of every directory the call writes into, " +
        "and refuse when git names a protected branch or cannot answer. Claude Code gets a JSON deny " +
        "envelope on stdout; `--runtime codex` exits 2 with the reason on stderr.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--cwd <path>", "override cwd resolution (default: stdin event.cwd then process.cwd())")
    .option("--runtime <name>", "block contract: claude-code (default) or codex")
    .action(async (options: {
      config?: string;
      project?: string;
      cwd?: string;
      runtime?: string;
    }) => {
      const cliOpts: Parameters<typeof runPackHookBranchProtectionCli>[0] = {};
      if (options.config) cliOpts.configPath = options.config;
      if (options.project) cliOpts.project = options.project;
      if (options.cwd) cliOpts.cwd = options.cwd;
      if (options.runtime !== undefined) cliOpts.runtime = options.runtime;
      const result = await runPackHookBranchProtectionCli(cliOpts);
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
}
