import type { Command } from "commander";
import * as fs from "node:fs";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { uninstall, UninstallError } from "./index.js";

export function registerUninstall(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout, stderr } = io;
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
}
