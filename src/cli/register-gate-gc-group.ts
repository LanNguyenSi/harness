import type { Command } from "commander";
import { EX_FAIL, HarnessExitError } from "./exit-codes.js";
import { gateDisable, GateDisableError } from "./gate/disable.js";
import { gateEnable, GateEnableError } from "./gate/enable.js";

export function registerGateGcGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout, stderr } = io;
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
}
