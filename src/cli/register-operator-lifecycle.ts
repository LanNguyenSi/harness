import type { Command } from "commander";
import { EX_FAIL, HarnessExitError } from "./exit-codes.js";
import { migrateHome } from "./migrate-home/index.js";
import { pause as pauseHarness, resume as resumeHarness } from "./pause/index.js";

export function registerOperatorLifecycle(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
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
        "hotfixes. NOT for routine gate bypass: for permanent per-policy disable, remove the " +
        "policy's entry from `policies:` in the manifest.",
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
}
