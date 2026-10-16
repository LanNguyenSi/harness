import type { Command } from "commander";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { codexGateDisable } from "./gate/codex-disable.js";
import { codexGateEnable } from "./gate/codex-enable.js";
import { gateDisable, GateDisableError } from "./gate/disable.js";
import { gateEnable, GateEnableError } from "./gate/enable.js";

const RUNTIME_HELP =
  "which runtime's hook config to edit: claude (default, ~/.claude/settings.json) or codex " +
  "(~/.codex/config.toml, the harness-managed block). With codex, a unit is neutralised in place " +
  "(its `hooks` array becomes empty, so other hooks keep their trust because positions do not move). " +
  "A later `harness apply --runtime codex --install` re-renders that block and brings disabled units back";

/** Validates `--runtime` and the path flag that belongs to it. */
function parseGateRuntime(
  options: { runtime?: string; settings?: string; config?: string },
): "claude" | "codex" {
  const runtime = options.runtime ?? "claude";
  if (runtime !== "claude" && runtime !== "codex") {
    throw new HarnessExitError(
      `unknown --runtime ${JSON.stringify(runtime)}; expected claude or codex`,
      EX_USAGE,
    );
  }
  if (runtime === "claude" && options.config) {
    throw new HarnessExitError("--config only applies to --runtime codex; use --settings", EX_USAGE);
  }
  if (runtime === "codex" && options.settings) {
    throw new HarnessExitError("--settings only applies to --runtime claude; use --config", EX_USAGE);
  }
  return runtime;
}

export function registerGateGcGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout, stderr } = io;
  // `harness gate` — operator escape hatch for hard-blocking hooks.
  // A hard-blocking PreToolUse hook can lock a Claude session out of every
  // Bash call, and any recovery that is itself a Bash invocation gets caught
  // by the same gate. `gate disable` strips the offending hook group out of
  // settings.json with a reversible snapshot.
  const gate = program
    .command("gate")
    .description("Operator escape hatch: disable/restore hook groups in ~/.claude/settings.json");
  gate
    .command("disable")
    .description(
      "Remove hook groups from ~/.claude/settings.json whose `matcher` substring-matches " +
        "`--matcher <pattern>`. Writes a snapshot of the removed groups next to settings.json " +
        "(`harness.gate-disable.<ts>.json`) and backs up the original to `settings.json.bak.<ts>` " +
        "so `harness gate enable` can restore them. With `--runtime codex` the matching hook units " +
        "of the harness-managed block in ~/.codex/config.toml are neutralised in place instead " +
        "(`hooks = []`, so the position of every other hook stays) and their original lines go " +
        "to `harness.gate-disable-codex.<ts>.json`. With no `--matcher` flag, lists the candidate " +
        "groups without writing.",
    )
    .option("--matcher <pattern>", "remove groups whose matcher includes this substring")
    .option("--settings <path>", "override ~/.claude/settings.json (--runtime claude)")
    .option("--config <path>", "override ~/.codex/config.toml (--runtime codex)")
    .option("--runtime <runtime>", RUNTIME_HELP)
    .action(async (options: { matcher?: string; settings?: string; config?: string; runtime?: string }) => {
      const runtime = parseGateRuntime(options);
      try {
        const result = runGateDisable(runtime, options);
        const plural = runtime === "codex" ? "hook units" : "hook groups";
        if (result.mode === "list") {
          if (result.candidates.length === 0) {
            stdout(`no ${plural} in ${result.path}; nothing to disable.\n`);
            return;
          }
          stdout(`candidate ${plural} in ${result.path}:\n`);
          for (const c of result.candidates) {
            const matcherLabel = c.matcher === null ? "(no matcher)" : JSON.stringify(c.matcher);
            stdout(`  ${c.event}[${c.index}] matcher=${matcherLabel}: ${c.description}${c.disabled ? " [disabled]" : ""}\n`);
          }
          stdout(
            `\nPass --matcher <substring> to remove ${runtime === "codex" ? "a unit" : "a group"}. Removal is reversible via ` +
              `\`harness gate enable${runtime === "codex" ? " --runtime codex" : ""}\`.\n`,
          );
          return;
        }
        stdout(
          `disabled ${result.removed.length} ${runtime === "codex" ? "hook unit(s)" : "hook group(s)"} in ${result.path}:\n`,
        );
        for (const r of result.removed) {
          stdout(`  ${r.event}[${r.index}] matcher=${JSON.stringify(r.matcher)}\n`);
        }
        stdout(`backup:   ${result.backupPath}\n`);
        stdout(`snapshot: ${result.snapshotPath}\n`);
        stdout(
          `This is reversible: run \`harness gate enable${runtime === "codex" ? " --runtime codex" : ""}\` to restore.\n`,
        );
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
        "pre-disable state, exits 0 without writing. With `--runtime codex` it walks the " +
        "`harness.gate-disable-codex.*.json` snapshots next to ~/.codex/config.toml newest first " +
        "and restores every one that still applies, so two disables need one enable. It exits " +
        "non-zero and names the units when any hook unit stays disabled. `--force` restores a " +
        "unit of the snapshot into the block as it is now, found by its id, even when the " +
        "config was edited since; it refuses when that unit is missing or not disabled.",
    )
    .option("--settings <path>", "override ~/.claude/settings.json (--runtime claude)")
    .option("--config <path>", "override ~/.codex/config.toml (--runtime codex)")
    .option("--runtime <runtime>", RUNTIME_HELP)
    .option("--force", "restore even when the config has been edited since the snapshot")
    .action(async (options: { settings?: string; config?: string; runtime?: string; force?: boolean }) => {
      const runtime = parseGateRuntime(options);
      try {
        const result =
          runtime === "codex"
            ? codexGateEnable({
                ...(options.config ? { configPath: options.config } : {}),
                ...(options.force ? { force: true } : {}),
              })
            : gateEnable({
                ...(options.settings ? { settingsPath: options.settings } : {}),
                ...(options.force ? { force: true } : {}),
              });
        const target = "configPath" in result ? result.configPath : result.settingsPath;
        const stillDisabled = "stillDisabled" in result ? result.stillDisabled : [];
        if (result.mode === "no-snapshots") {
          if (stillDisabled.length === 0) {
            stdout(`no gate-disable snapshots found next to ${target}; nothing to restore.\n`);
          }
        } else if (result.mode === "already-restored") {
          if (stillDisabled.length === 0) {
            stdout(
              (runtime === "codex"
                ? `no hook unit of the harness-managed block in ${target} is disabled; no write needed. `
                : `settings.json already matches the pre-disable state; no write needed. `) +
                `(snapshot: ${result.snapshotPath})\n`,
            );
          }
        } else {
          const from =
            "snapshotPaths" in result ? result.snapshotPaths.join(", ") : result.snapshotPath;
          stdout(
            `restored ${result.restoredCount} ${runtime === "codex" ? "hook unit(s)" : "hook group(s)"} ` +
              `into ${target} from ${from}.\n`,
          );
        }
        if (stillDisabled.length > 0) {
          throw new HarnessExitError(
            `${stillDisabled.length} hook unit(s) in ${target} are still disabled: ${stillDisabled.join(", ")}. ` +
              "No Codex gate snapshot restores them. Restore the config from the backup beside it " +
              "(<config>.bak.<timestamp>), or re-run `harness apply --runtime codex --install` to " +
              "re-render the block.",
            EX_FAIL,
          );
        }
      } catch (err) {
        if (err instanceof GateEnableError) {
          throw new HarnessExitError(err.message, EX_FAIL);
        }
        throw err;
      }
    });
}

interface GateDisableView {
  mode: "list" | "remove";
  path: string;
  candidates: Array<{
    event: string;
    index: number;
    matcher: string | null;
    description: string;
    /** Codex only: the unit was neutralised by an earlier `gate disable`. */
    disabled?: boolean;
  }>;
  backupPath: string;
  snapshotPath: string;
  removed: Array<{ event: string; index: number; matcher: string | null }>;
}

/** Runs the disable verb for one runtime and flattens both results into the one shape the printer reads. */
function runGateDisable(
  runtime: "claude" | "codex",
  options: { matcher?: string; settings?: string; config?: string },
): GateDisableView {
  const empty = { candidates: [], backupPath: "", snapshotPath: "", removed: [] };
  if (runtime === "codex") {
    const r = codexGateDisable({
      ...(options.matcher ? { matcher: options.matcher } : {}),
      ...(options.config ? { configPath: options.config } : {}),
    });
    if (r.mode === "list") return { ...empty, mode: "list", path: r.configPath, candidates: r.candidates };
    return {
      ...empty,
      mode: "remove",
      path: r.configPath,
      backupPath: r.backupPath,
      snapshotPath: r.snapshotPath,
      removed: r.neutralised.map((u) => ({ event: u.event, index: u.eventIndex, matcher: u.matcher })),
    };
  }
  const r = gateDisable({
    ...(options.matcher ? { matcher: options.matcher } : {}),
    ...(options.settings ? { settingsPath: options.settings } : {}),
  });
  if (r.mode === "list") return { ...empty, mode: "list", path: r.settingsPath, candidates: r.candidates };
  return {
    ...empty,
    mode: "remove",
    path: r.settingsPath,
    backupPath: r.backupPath,
    snapshotPath: r.snapshotPath,
    removed: r.removed.map((g) => ({
      event: g.event,
      index: g.index,
      matcher:
        g.group !== null && typeof g.group === "object" && !Array.isArray(g.group)
          ? ((g.group as Record<string, unknown>)["matcher"] ?? null) as string | null
          : null,
    })),
  };
}
