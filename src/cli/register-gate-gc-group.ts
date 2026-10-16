import type { Command } from "commander";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { codexGateDisable } from "./gate/codex-disable.js";
import { codexGateEnable } from "./gate/codex-enable.js";
import { gateDisable, GateDisableError } from "./gate/disable.js";
import { gateEnable, GateEnableError } from "./gate/enable.js";
import type { ForeignSnapshot } from "./gate/snapshot.js";

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
        "so `harness gate enable` can restore them; a later disable while that snapshot is live " +
        "is merged into it. With `--runtime codex` the matching hook units " +
        "of the harness-managed block in ~/.codex/config.toml are neutralised in place instead " +
        "(`hooks = []`, so the position of every other hook stays) and their original lines go " +
        "to `harness.gate-disable-codex.<ts>.json` (a later disable joins the live snapshot, or retires it " +
        "first when it has nothing left to restore). " +
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
        if (result.retired !== undefined) {
          stdout(
            result.retired.installBackup !== undefined
              ? `retired ${result.retired.from} as ${result.retired.to}: a later install (${result.retired.installBackup}) re-rendered its units; this disable starts a fresh snapshot.\n`
              : `retired ${result.retired.from} as ${result.retired.to}: it had nothing left to restore; this disable starts a fresh snapshot.\n`,
          );
        }
        for (const r of result.retiredSpent) {
          stdout(`retired a spent snapshot as ${r}: its groups were already back in ${result.path}.\n`);
        }
        stdout(`backup:   ${result.backupPath}\n`);
        stdout(
          result.merged
            ? `snapshot: ${result.snapshotPath} (merged into the snapshot that was already live)\n`
            : `snapshot: ${result.snapshotPath}\n`,
        );
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
      "Restore the hook groups of the live `harness.gate-disable.*.json` snapshot next to " +
        "settings.json (every `gate disable` since the last restore is merged into it) and retire " +
        "it as `*.restored.json`. A group settings.json already holds unchanged is left alone, " +
        "never added twice; one with the same event and matcher but other content makes it refuse " +
        "and name both groups' commands, and `--force` takes it as back. If settings.json has been " +
        "edited since the snapshot was taken, the groups still missing are put back only when that " +
        "gives exactly the pre-disable file; otherwise it refuses and `--force` puts them back into " +
        "the edited file (edits stay). If settings.json already matches the pre-disable state, or " +
        "holds every group unchanged, it only retires the snapshot. Older releases left one snapshot " +
        "per disable: each call handles the newest, and exits non-zero while another stays live. It " +
        "also exits non-zero while a live snapshot beside settings.json was taken for another " +
        "settings file, naming the `--settings` that restores it. With `--runtime codex` there is at most one " +
        "live `harness.gate-disable-codex.*.json` snapshot per config (another config's is skipped): " +
        "a later disable merges its units into it, and one enable applies it. A snapshot it applies, " +
        "or the config already matches, is renamed to `*.restored.json`; one taken before a later " +
        "`harness apply --runtime codex --install`, or whose units are all enabled again (not deleted), " +
        "is renamed to `*.superseded.json`; neither is applied again. It exits non-zero and names the " +
        "units when any hook unit stays disabled, and names how many live snapshots remain when an " +
        "earlier build left several (it handles the newest per run). A config edited since is " +
        "restored without `--force` only when skipping the units that are back already rebuilds " +
        "the pre-disable bytes; otherwise it refuses, and `--force` restores every unit the snapshot " +
        "names that is still disabled (found by id), leaves a unit that is enabled again as it is " +
        "and keeps every other edit. A unit that is missing, or changed while still disabled, refuses " +
        "with or without `--force` and the message names the ways out.",
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
        const liveLeft = "remaining" in result ? result.remaining : [];
        const missing = "missing" in result ? result.missing : [];
        const alreadyBack = "alreadyBack" in result ? result.alreadyBack : [];
        const accepted = "accepted" in result ? result.accepted : [];
        const foreign = "foreign" in result ? result.foreign : [];
        if (result.mode === "no-snapshots") {
          if (stillDisabled.length === 0 && foreign.length === 0) {
            stdout(`no gate-disable snapshots found next to ${target}; nothing to restore.\n`);
          }
        } else if (result.mode === "already-restored") {
          if (stillDisabled.length === 0 && missing.length === 0) {
            stdout(
              (runtime === "codex"
                ? `no hook unit of the harness-managed block in ${target} is disabled; no write needed. `
                : alreadyBack.length > 0 || accepted.length > 0
                  ? `${target} already holds every hook group the snapshot removed; no write needed. `
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
        if (result.mode === "restored" && alreadyBack.length > 0) {
          stdout(`left alone, already in ${target}: ${alreadyBack.join("; ")}.\n`);
        }
        if (accepted.length > 0) {
          stdout(
            `taken as back under --force, not put back (same event and matcher, other content): ${accepted.join("; ")}.\n`,
          );
        }
        if ("skippedForeign" in result) {
          for (const p of result.skippedForeign) {
            stdout(`skipped ${p}: taken for another ${runtime === "codex" ? "config" : "settings file"}.\n`);
          }
        }
        if ("skippedEnabled" in result && result.skippedEnabled.length > 0) {
          stdout(`left as they are: ${result.skippedEnabled.join(", ")} (already enabled again).\n`);
        }
        if ("retired" in result && result.retired?.why === "superseded") {
          const r = result.retired;
          stdout(
            r.installBackup !== undefined
              ? `retired ${r.from} as ${r.to}: a later install (${r.installBackup}) re-rendered its units.\n`
              : `retired ${r.from} as ${r.to}: its units were enabled again.\n`,
          );
        }
        // Claude only: the Codex result's `remaining` is folded into the one error below.
        const foreignNote = foreign.length > 0 ? foreignSnapshotsNote(target, foreign) : "";
        if (runtime === "claude" && liveLeft.length > 0) {
          throw new HarnessExitError(
            `${liveLeft.length} more gate snapshot(s) are still live next to ${target}: ${liveLeft.join(", ")}. ` +
              `Their groups are not restored yet; run \`harness gate enable\` again.${foreignNote ? ` ${foreignNote}` : ""}`,
            EX_FAIL,
          );
        }
        if (foreignNote) throw new HarnessExitError(foreignNote, EX_FAIL);
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

/**
 * Why a Claude `gate enable` does not exit 0 while live snapshots of another
 * settings file sit beside the target: their groups are still removed from
 * that file. Names each one with the command that restores it.
 */
function foreignSnapshotsNote(
  target: string,
  foreign: ForeignSnapshot[],
): string {
  return (
    `${foreign.length} gate snapshot(s) beside ${target} were taken for another settings file and their groups ` +
    `are not restored yet: ` +
    foreign
      .map(
        (f) =>
          `${f.path}: run \`harness gate enable --settings ${f.settingsPath}\`` +
          (f.settingsExists
            ? ""
            : ` (no file is at that name now: if the settings file was renamed after the disable, rename it back first)`),
      )
      .join("; ") +
    "."
  );
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
  /** Codex only: a spent live snapshot the disable retired before starting a fresh one. */
  retired?: { from: string; to: string; why: string; installBackup?: string };
  /** Claude only: the groups went into an already live snapshot. */
  merged: boolean;
  /** Claude only: spent snapshots this disable retired first (their retired names). */
  retiredSpent: string[];
}

/** Runs the disable verb for one runtime and flattens both results into the one shape the printer reads. */
function runGateDisable(
  runtime: "claude" | "codex",
  options: { matcher?: string; settings?: string; config?: string },
): GateDisableView {
  const empty = { candidates: [], backupPath: "", snapshotPath: "", removed: [], merged: false, retiredSpent: [] };
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
      ...(r.retired !== null ? { retired: r.retired } : {}),
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
    merged: r.merged,
    retiredSpent: r.retired,
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
