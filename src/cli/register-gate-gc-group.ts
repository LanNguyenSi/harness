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
        "to `harness.gate-disable-codex.<ts>.json` (a later disable joins the live snapshot). " +
        "With no `--matcher` flag, lists the candidate " +
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
            runtime === "codex"
              ? "\nPass --matcher <substring> to disable a unit (its `hooks` array is emptied in place; " +
                  "nothing is removed). This is reversible via `harness gate enable --runtime codex`.\n"
              : "\nPass --matcher <substring> to remove a group. Removal is reversible via `harness gate enable`.\n",
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
        "pre-disable state, exits 0 without writing. With `--runtime codex` there is at most one " +
        "live `harness.gate-disable-codex.*.json` snapshot per config (another config's is skipped): " +
        "a later disable merges its units into it, and one enable applies it. A snapshot it applies, " +
        "or the config already matches, is renamed to `*.restored.json`; one taken before a later " +
        "`harness apply --runtime codex --install`, or whose units are all enabled again (not deleted), " +
        "is renamed to `*.superseded.json`; neither is applied again. It exits non-zero and names the " +
        "units when any hook unit stays disabled, and names how many live snapshots remain when an " +
        "earlier build left several (it handles the newest per run). `--force` applies the snapshot to a config edited since: it swaps " +
        "only that snapshot's hooks lines back into the units it names (found by id) and keeps " +
        "every other edit; it refuses when a unit is missing, changed or not disabled.",
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
        const missing = "missing" in result ? result.missing : [];
        if (result.mode === "no-snapshots") {
          if (stillDisabled.length === 0) {
            stdout(`no gate-disable snapshots found next to ${target}; nothing to restore.\n`);
          }
        } else if (result.mode === "already-restored") {
          if (stillDisabled.length === 0 && missing.length === 0) {
            stdout(
              (runtime === "codex"
                ? `no hook unit of the harness-managed block in ${target} is disabled; no write needed. `
                : `settings.json already matches the pre-disable state; no write needed. `) +
                `(snapshot: ${result.snapshotPath})\n`,
            );
          }
        } else {
          stdout(
            `restored ${result.restoredCount} ${runtime === "codex" ? "hook unit(s)" : "hook group(s)"} ` +
              `into ${target} from ${result.snapshotPath}.\n`,
          );
        }
        if ("skippedForeign" in result) {
          for (const p of result.skippedForeign) stdout(`skipped ${p}: taken for another config.\n`);
        }
        if ("retired" in result && result.retired?.why === "superseded") {
          const r = result.retired;
          stdout(
            r.installBackup !== undefined
              ? `retired ${r.from} as ${r.to}: a later install (${r.installBackup}) re-rendered its units.\n`
              : `retired ${r.from} as ${r.to}: its units were enabled again.\n`,
          );
        }
        const remaining = "remaining" in result ? result.remaining : [];
        if (missing.length > 0 || stillDisabled.length > 0 || remaining.length > 0) {
          throw new HarnessExitError(
            [
              missing.length > 0 &&
                `${missing.length} hook unit(s) a gate snapshot names are missing from the harness-managed block in ${target}: ` +
                  `${missing.join(", ")}. The snapshot ${"snapshotPath" in result ? result.snapshotPath : ""} stays live and ` +
                  "nothing was retired for them. Run `harness apply --runtime codex --install` to re-render the block, " +
                  "restore the config from the backup beside it (<config>.bak.<timestamp>), or move the snapshot " +
                  "aside by hand if they are gone for good.",
              stillDisabled.length > 0 &&
                `${stillDisabled.length} hook unit(s) in ${target} are still disabled: ${stillDisabled.join(", ")}.` +
                  (remaining.length > 0
                    ? ""
                    : " No Codex gate snapshot restores them. Restore the config from the backup beside it " +
                      "(<config>.bak.<timestamp>), or re-run `harness apply --runtime codex --install` to re-render the block."),
              remaining.length > 0 &&
                `${remaining.length} more live Codex gate snapshot(s) remain (an earlier build wrote one per disable): ` +
                  `${remaining.join(", ")}. Run \`harness gate enable --runtime codex\` again for the next one.`,
            ]
              .filter((m) => m !== false)
              .join(" "),
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
