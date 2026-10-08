import type { Command } from "commander";
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
import { runPackHookBranchProtectionCli } from "./pack/hook-branch-protection.js";
import { runPackHookSolutionAcceptanceCli } from "./pack/hook-solution-acceptance.js";
import { runPackHookSolutionAcceptanceWriteguardCli } from "./pack/hook-solution-acceptance-writeguard.js";
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
      "PostToolUse: read tool-event JSON from stdin, maintain ~/.claude/harness.generated/active-claim on agent-tasks task_start / task_finish / task_abandon / task_merge so `harness approve understanding` can auto-resolve the task id without --task (harness/494fd1e5). task_finish keeps the marker when the resulting status is review and clears it otherwise (task c86e3c4a); task_abandon / task_merge / a non-review task_finish clear it only when the marker already names the same task id, otherwise it is left in place (task c86e3c4a round 2).",
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
  // shape; UserPromptSubmit emits developer-context instructions on stdout.
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
      "Codex UserPromptSubmit injector: emit developer-context instructions on stdout whenever Codex invokes the event",
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
}
