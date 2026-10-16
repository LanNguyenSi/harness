// `harness gate disable --runtime codex`: the operator's switch for a
// blocking hook in the Codex config.
//
// Reads `~/.codex/config.toml` (or `--config <path>`), finds the hook units
// of the harness-managed block (the `# BEGIN harness-managed codex hooks`
// fence that `harness apply --runtime codex --install` writes) whose
// `matcher` substring-matches `--matcher`, and neutralises exactly those
// units in place: the comment line, the `[[hooks.<Event>]]` header and the
// `matcher` line stay, the `hooks = [...]` line becomes `hooks = []`. Codex
// keys a user hook's trust and enabled state by its position in the event's
// array, and an empty group takes its position without registering a
// handler, so no other hook of any event moves or loses its trust. A backup
// of the original (`<config>.bak.<ISO>`) and a snapshot of the original
// `hooks` lines (`harness.gate-disable-codex.<ISO>.json`) land before the
// atomic rewrite. At most one snapshot per config is live: a disable made
// while one exists merges its units into that snapshot (keeping the original
// pre-disable sha, recording the new post-disable sha and an audit entry in
// `merges`) instead of writing a second one; if the config write then fails,
// the snapshot is put back as it was. A live snapshot that `gate enable` would
// only retire (an install re-rendered the block, the config is back at the
// pre-disable state, or every unit it names is enabled again) is retired by
// the disable itself, which then starts a fresh snapshot. Any other live
// snapshot the config no longer matches refuses the disable and names
// `gate enable --force`. Text outside the fences, and every operator-authored
// table, is never touched. The block is read by the installer's own scanner
// (`readCodexManagedHookUnits`), so a duplicate BEGIN marker, a foreign table
// wedged in the block or a missing END marker refuse instead of guessing.
//
// With NO `--matcher` this verb is a pure listing, like the Claude one. A
// later `harness apply --runtime codex --install` re-renders the whole block
// and so brings the units back.

import * as fs from "node:fs";
import {
  assertCodexHookEditInvariant,
  existingFileMode,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { GateDisableError, type GateDisableCandidate } from "./disable.js";
import {
  CODEX_NEUTRALISED_HOOKS,
  CODEX_SNAPSHOT_TARGET,
  CODEX_SNAPSHOT_VERSION,
  codexSnapshotPath,
  type CodexDisabledUnit,
  type CodexGateSnapshot,
  type CodexRetiredSnapshot,
  latestInstall,
  readLiveCodexSnapshots,
  resolveCodexConfig,
  retireCodexSnapshot,
  spentCodexSnapshot,
  toGateError,
} from "./codex-snapshot.js";
import { backupPath, sha256Hex } from "./snapshot.js";

export interface CodexGateDisableOptions {
  /** `~/.codex/config.toml` override. */
  configPath?: string;
  /** Test-injectable home dir for the default config path. */
  homeDir?: string;
  /** Literal substring of a unit's `matcher`; absent means list only. */
  matcher?: string;
  now?: Date;
}

export interface CodexGateCandidate extends GateDisableCandidate {
  /** True for a unit an earlier `gate disable` already neutralised. */
  disabled: boolean;
}

export type CodexGateDisableResult =
  | { mode: "list"; configPath: string; candidates: CodexGateCandidate[] }
  | {
      mode: "remove";
      configPath: string;
      backupPath: string;
      snapshotPath: string;
      neutralised: CodexDisabledUnit[];
      /** A spent live snapshot this disable retired before starting a fresh one. */
      retired: CodexRetiredSnapshot | null;
    };

export function codexGateDisable(opts: CodexGateDisableOptions = {}): CodexGateDisableResult {
  const { requestedPath, configPath } = resolveCodexConfig(opts, (m) => new GateDisableError(m));
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateDisableError(`Codex config not found: ${requestedPath}; nothing to disable`);
    }
    throw new GateDisableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }

  let block: ReturnType<typeof readCodexManagedHookUnits>;
  try {
    block = readCodexManagedHookUnits(text, configPath);
  } catch (err) {
    throw toGateError(err, (m) => new GateDisableError(m));
  }
  if (block === null) {
    throw new GateDisableError(
      `${requestedPath} has no harness-managed Codex hook block (no '# BEGIN harness-managed codex hooks' ` +
        `fence); nothing to disable. \`harness apply --runtime codex --install\` writes that block.`,
    );
  }

  const seen = new Map<string, number>();
  const units = block.units.map((unit, ordinal) => {
    const eventIndex = seen.get(unit.event) ?? 0;
    seen.set(unit.event, eventIndex + 1);
    return { unit, ordinal, eventIndex };
  });

  if (typeof opts.matcher !== "string" || opts.matcher.length === 0) {
    return {
      mode: "list",
      configPath: requestedPath,
      candidates: units.map(({ unit, eventIndex }) => ({
        event: unit.event,
        index: eventIndex,
        matcher: unit.matcher,
        description: unit.commands.join("; ") || unit.id,
        disabled: unit.disabled,
      })),
    };
  }

  const pattern = opts.matcher;
  const matched = units.filter(({ unit }) => unit.matcher !== null && unit.matcher.includes(pattern));
  if (matched.length === 0) {
    throw new GateDisableError(
      `no hook units matched matcher substring ${JSON.stringify(pattern)} in the harness-managed block of ` +
        `${requestedPath}. Run \`harness gate disable --runtime codex\` (no --matcher) to list the available candidates.`,
    );
  }
  const active = matched.filter(({ unit }) => !unit.disabled);
  if (active.length === 0) {
    throw new GateDisableError(
      `every hook unit matching ${JSON.stringify(pattern)} in ${requestedPath} is already disabled ` +
        `(${matched.map(({ unit }) => unit.id).join(", ")}); nothing to do. ` +
        "`harness gate enable --runtime codex` restores them.",
    );
  }
  // The snapshot finds a unit again by its id, so two units must not share one.
  const ids = new Set(block.units.map((u) => u.id));
  if (ids.size !== block.units.length) {
    throw new GateDisableError(
      `two hook units of the harness-managed block in ${requestedPath} carry the same id; ` +
        "refusing to guess which one a restore would mean. Re-run `harness apply --runtime codex --install` " +
        "to rewrite the block. The file is untouched.",
    );
  }

  let next = "";
  let cursor = 0;
  for (const { unit } of active) {
    next += text.slice(cursor, unit.hooksStart) + CODEX_NEUTRALISED_HOOKS;
    cursor = unit.hooksEnd;
  }
  next += text.slice(cursor);

  const counts: Record<string, number> = {};
  for (const { unit } of active) counts[unit.event] = (counts[unit.event] ?? 0) + 1;
  try {
    assertCodexHookEditInvariant(text, next, configPath, { direction: "neutralise", counts });
  } catch (err) {
    throw toGateError(err, (m) => new GateDisableError(m));
  }

  // At most one live snapshot per config. A spent one (enable would only
  // retire it: an install re-rendered the block, the config is back at the
  // pre-disable state, or every unit it names is enabled again) is retired
  // here and this disable starts a fresh snapshot. Otherwise this disable
  // joins it, which is only possible when the config is exactly what the
  // snapshot left behind, since its pre-disable sha must stay the one state a
  // restore rebuilds.
  let live = readLiveCodexSnapshots(requestedPath, (m) => new GateDisableError(m)).own[0];
  let retired: CodexRetiredSnapshot | null = null;
  if (live !== undefined) {
    const spent = spentCodexSnapshot(
      live.snapshot,
      sha256Hex(text),
      block.units,
      latestInstall(requestedPath, configPath),
    ).retire;
    if (spent !== null) {
      try {
        retired = { from: live.path, to: retireCodexSnapshot(live.path, spent.why), ...spent };
      } catch (err) {
        throw new GateDisableError(
          `the live gate snapshot ${live.path} is spent (enable would only retire it) but cannot be retired ` +
            `(${(err as Error).message}); move it aside by hand and run the command again. The file is untouched.`,
        );
      }
      live = undefined;
    } else if (sha256Hex(text) !== live.snapshot.configAfterSha256) {
      throw new GateDisableError(
        `the live gate snapshot ${live.path} no longer matches ${requestedPath} (edited since the last disable) ` +
          "and still names units that are off, so this disable cannot join it. Run `harness gate enable " +
          "--runtime codex --force`: it puts back every unit the snapshot names that is still off, keeps your " +
          "other edits and retires the snapshot. Then disable again. The file is untouched.",
      );
    }
  }

  const now = opts.now ?? new Date();
  const backup = backupPath(requestedPath, now);
  const mode = existingFileMode(configPath);
  const neutralised: CodexDisabledUnit[] = active.map(({ unit, ordinal, eventIndex }) => ({
    event: unit.event,
    eventIndex,
    ordinal,
    id: unit.id,
    matcher: unit.matcher,
    hooksText: text.slice(unit.hooksStart, unit.hooksEnd),
  }));
  const snapPath = live?.path ?? codexSnapshotPath(requestedPath, now);
  const snapshot: CodexGateSnapshot = live
    ? {
        ...live.snapshot,
        configAfterSha256: sha256Hex(next),
        neutralised: [...live.snapshot.neutralised, ...neutralised].sort((a, b) => a.ordinal - b.ordinal),
        merges: [
          ...(live.snapshot.merges ?? []),
          { createdAt: now.toISOString(), matcher: pattern, configBackupPath: backup },
        ],
      }
    : {
        version: CODEX_SNAPSHOT_VERSION,
        target: CODEX_SNAPSHOT_TARGET,
        createdAt: now.toISOString(),
        configPath: requestedPath,
        configBackupPath: backup,
        configBeforeSha256: sha256Hex(text),
        configAfterSha256: sha256Hex(next),
        filter: { matcher: pattern },
        neutralised,
      };

  // Backup and snapshot land BEFORE the live rewrite, with the config's own
  // mode (it holds secrets and hook trust hashes): a crash between the writes
  // leaves the config untouched and the way back on disk.
  // A merge changes the live snapshot before the config, so a failed config
  // write puts the snapshot back as it was: a merged snapshot over an
  // unchanged config would name units that are still enabled.
  const priorBody = live === undefined ? undefined : fs.readFileSync(live.path, "utf8");
  atomicWriteFile(backup, text, { mode });
  atomicWriteFile(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode });
  try {
    atomicWriteFile(configPath, next, { mode });
  } catch (err) {
    if (priorBody !== undefined) {
      try {
        atomicWriteFile(snapPath, priorBody, { mode });
      } catch (rollbackErr) {
        throw new GateDisableError(
          `cannot write ${requestedPath}: ${(err as Error).message}; and the snapshot ${snapPath}, already merged, ` +
            `could not be put back (${(rollbackErr as Error).message}). \`harness gate enable --runtime codex\` ` +
            "restores what is off (add --force if it refuses).",
        );
      }
    }
    throw err;
  }

  return {
    mode: "remove",
    configPath: requestedPath,
    backupPath: backup,
    snapshotPath: snapPath,
    neutralised,
    retired,
  };
}
