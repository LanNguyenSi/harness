// `harness apply [--dry-run] [--overwrite-drift]`.
//
// Pipeline:
//   1. Load the effective manifest.
//   2. Generate expected runtime files: settings.json (Phase 3 #2),
//      MEMORY.md index (Phase 3 #3).
//   3. Read `harness.generated/.last-apply` (Phase 3 #1) if present.
//   4. Read on-disk `harness.generated/<file>` if present.
//   5. If `harness.lock` exists, hash every locked asset / memory-dir
//      Merkle and surface mismatches as `lockDrift` (Phase 3 #6,
//      warn-only). Drift is reported on every code path including
//      --dry-run so users can preview without writing.
//   6. Three-state-compare per file (Phase 3 #1):
//        no-drift       → write expected (overwrite is safe)
//        safe-overwrite → write expected (no on-disk file existed)
//        drift-refuse   → refuse with diff + adopt-or-overwrite hint
//   7. `--overwrite-drift` requires literal `yes` confirmation before
//      discarding on-disk changes; on confirm, treat refusals as
//      safe-overwrite.
//   8. `--dry-run` prints the would-be diff + would-emit hints, exits 0
//      without writing.
//   9. After successful write: refresh `.last-apply` (with a manifest
//      snapshot for the next apply's restart-hint comparison), write
//      `harness.lock` next to `harness.yaml`, emit restart hints. The
//      idempotent no-op path also refreshes the lock when asset drift
//      was detected so the drift report is not "sticky".

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  LOCK_BASENAME,
  buildLockEntries,
  computeDrift,
  readLock,
  writeLock,
  type DriftedAsset,
  type LockEntry,
} from "../../io/harness-lock.js";
import { mergeSettings, summarizeMerge } from "../../io/merge-settings.js";
import {
  buildLastApply,
  readLastApply,
  sha256Hex,
  verifyLastApplyIntegrity,
  writeLastApply,
  type LastApplyRecord,
} from "../../io/last-apply.js";
import { unifiedDiff } from "../../io/patch.js";
import { emitRestartHints } from "../../io/restart-hints.js";
import { compare, type ThreeStateVerdict } from "../../io/three-state.js";
import { reportsDirForManifest } from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  checkPolicyPackSources,
  expandPolicyPacks,
  DEFAULT_RUNTIME,
  type Runtime,
} from "../../policy-packs/index.js";
import { parseManifest, type Manifest } from "../../schema/index.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import { loadManifest } from "../loader.js";
import { GENERATED_DIRNAME, resolveGeneratedDir } from "../../io/generated-dir.js";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import {
  CODEX_GENERATED_HEADER_LINE,
  generateCodexConfig,
} from "./generate-codex-config.js";
import { generateMemoryIndex } from "./generate-memory-index.js";
import { generateSettingsWithWarnings } from "./generate-settings.js";
import {
  planCodexConfigInstall,
  writeCodexConfigInstall,
  type CodexConfigInstallPlan,
  type CodexConfigInstallResult,
} from "./install-codex-config.js";

export { GENERATED_DIRNAME };
export const SETTINGS_BASENAME = "settings.json";
export const MEMORY_BASENAME = "MEMORY.md";
export const MANIFEST_BASENAME = "harness.yaml";
export const CODEX_CONFIG_BASENAME = "codex/config.toml";

export interface ApplyOptions {
  configPath?: string;
  homeDir?: string;
  project?: string;
  dryRun?: boolean;
  overwriteDrift?: boolean;
  /**
   * `--yes`: skip the `--overwrite-drift` confirmation prompt, as if the
   * operator had typed `yes`. The non-interactive escape hatch: without
   * it, a triggered confirmation under a non-TTY stdin (CI, agent
   * shells) refuses instead of prompting.
   */
  yes?: boolean;
  /**
   * Phase 3 follow-up: when set, any non-empty `lockDrift` causes apply
   * to refuse with the `lock-drift-refuse` outcome before writing,
   * prompting, or regenerating the lock (no on-disk side effects). The
   * user must either re-run without `--strict-lock` to acknowledge and
   * refresh the lock, or revert the upstream asset edit.
   *
   * Dry-run wins: `--strict-lock --dry-run` reports the would-be drift
   * and exits 0, leaving the existing dry-run scope intact.
   */
  strictLock?: boolean;
  /**
   * `--target <path>`: also write the generated settings.json to <path>
   * (in addition to harness.generated/). Resolved relative to cwd if not
   * absolute; `~` is expanded. Pairs with `--merge` (3-way merge into an
   * existing target file) or `--force` (overwrite existing target).
   */
  target?: string;
  /**
   * `--merge`: when --target points at a file that already exists, do a
   * 3-way merge: replace the keys harness owns (whichever appear in the
   * generated output, today: `hooks`); preserve every other top-level
   * key in the existing file verbatim.
   */
  merge?: boolean;
  /**
   * `--force`: overwrite an existing target file with the generated
   * settings as-is. Mutually exclusive with --merge.
   */
  force?: boolean;
  /**
   * Phase 6 #6 — `--runtime <claude-code|codex>`. Selects which adapter
   * shape policy-pack hooks expand into and which artefacts apply
   * writes. Defaults to `claude-code` (settings.json output unchanged
   * from previous releases). When set to `codex`, settings.json is NOT
   * written; instead `harness.generated/codex/config.toml` carries the
   * Codex adapter configuration. The two runtimes are mutually
   * exclusive in a single apply for v1; cross-runtime applies are a
   * future enhancement.
   */
  runtime?: Runtime;
  /**
   * `--install` with `--runtime codex`: merge the generated Codex hook
   * stanzas into the active Codex config as a marked harness-managed
   * block. The installer preserves every byte outside that block.
   */
  installCodex?: boolean;
  /** Override the active Codex config path for --runtime codex --install. */
  codexConfigPath?: string;
  /** Test-injectable clock for timestamped Codex config backups. */
  now?: Date;
  /** Test-injectable confirmation prompt; defaults to a stdin readline. */
  prompt?: (message: string) => Promise<string>;
}

export type ApplyOutcome =
  | "no-changes"
  | "applied"
  | "drift-refuse"
  | "drift-discarded"
  | "would-apply"
  | "lock-drift-refuse"
  | "target-exists-refuse";

export interface FileApplyOutcome {
  basename: string;
  path: string;
  verdict: ThreeStateVerdict;
  /** Unified diff, present when verdict is `drift-refuse`. */
  diff?: string;
  /** True when `expected !== onDiskCurrent` (whether or not we wrote). */
  changed: boolean;
}

export interface CodexConfigInstallOutcome {
  configPath: string;
  changed: boolean;
  written: boolean;
  summary: string;
  backupPath?: string;
}

export interface ApplyResult {
  manifestPath: string;
  generatedDir: string;
  files: FileApplyOutcome[];
  warnings: string[];
  restartHints: string[];
  /**
   * Locked assets whose on-disk SHA-256 has drifted since the lock was last
   * written. Computed on every apply (when a lock exists), reported but
   * not enforced: apply proceeds, the drift is surfaced as warning-style
   * output, and the lock is rewritten with current SHAs at the end of the
   * run. Wrap apply in a script that greps for `asset drift detected:` to
   * upgrade to enforcement.
   */
  lockDrift: DriftedAsset[];
  outcome: ApplyOutcome;
  written: boolean;
  dryRun: boolean;
  /** Path of the harness.lock that was (or would be) written. */
  lockPath: string;
  /**
   * Set when --target was passed: the absolute resolved target path.
   * Present on every outcome (including target-exists-refuse and dry-run)
   * so the CLI layer can include it in user-facing messages.
   */
  targetPath?: string;
  /** Whether the target file was written this run. */
  targetWritten?: boolean;
  /**
   * Set when --target was passed: whether the target file holds the
   * merged/generated settings after this run. True when the file was
   * written this run OR was already byte-identical (an idempotent
   * re-apply); false only when the target exists and apply refused to
   * touch it (`target-exists-refuse`). Distinct from `targetWritten`,
   * which is false in BOTH the already-in-sync and the refused cases —
   * callers that need "is the target correctly wired?" must read this,
   * not `!targetWritten`.
   */
  targetInSync?: boolean;
  /**
   * Human-readable one-liner describing the merge outcome, e.g.
   * `merged into /path: replaced 1 owned key (hooks), preserved 4 other keys`.
   * Present when --merge succeeded against an existing target.
   */
  targetMergeSummary?: string;
  /** Present when --runtime codex --install was requested. */
  codexConfigInstall?: CodexConfigInstallOutcome;
}

const DRIFT_HINT_MESSAGE =
  'run "harness adopt <file>" to capture changes, or re-run with --overwrite-drift to discard them';

// Pinned to the same literal the Codex generator emits as line 1.
// Single source of truth lives in generate-codex-config.ts so a future
// banner re-word can't silently disable last-apply baseline recovery.
const CODEX_GENERATED_HEADER = CODEX_GENERATED_HEADER_LINE;

function resolveManifestPath(opts: ApplyOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  const home = resolveHomeDir({
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  }).path;
  return path.join(home, MANIFEST_BASENAME);
}

function resolveTargetPath(target: string, homeDir?: string): string {
  let p = target;
  if (p === "~") p = homeDir ?? os.homedir();
  else if (p.startsWith("~/")) p = path.join(homeDir ?? os.homedir(), p.slice(2));
  return path.resolve(p);
}

function readTargetJson(targetPath: string): {
  parsed: Record<string, unknown> | null;
  parseError: string | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EISDIR") {
      return { parsed: null, parseError: "target path is a directory, not a file" };
    }
    return { parsed: null, parseError: null };
  }
  if (raw.trim() === "") return { parsed: {}, parseError: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { parsed: null, parseError: (e as Error).message };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { parsed: null, parseError: "target file is not a JSON object" };
  }
  return { parsed: parsed as Record<string, unknown>, parseError: null };
}

function serializeJson(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function codexInstallOutcome(
  result: CodexConfigInstallPlan | CodexConfigInstallResult,
): CodexConfigInstallOutcome {
  return {
    configPath: result.configPath,
    changed: result.changed,
    written: "written" in result ? result.written : false,
    summary: result.summary,
    ...("backupPath" in result && result.backupPath !== undefined
      ? { backupPath: result.backupPath }
      : {}),
  };
}

// Prompts must survive `harness apply | tee log` (the user still needs to
// see the question even when stdout is piped), so we write to stderr and
// read from stdin. Don't "fix" this back to stdout.
//
// Non-TTY stdin (CI, agent-driven shells) cannot answer a readline
// question; without the guard the process would block forever waiting
// for input that never comes (harness-discovery H4). Refuse loudly and
// name the escape hatch instead.
async function readlinePrompt(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new HarnessExitError(
      "confirmation required but stdin is not a TTY; re-run with --yes to confirm non-interactively",
      EX_FAIL,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

interface ExpectedFile {
  basename: string;
  content: string;
}

function buildExpectedFiles(
  manifest: Manifest,
  opts: ApplyOptions,
  manifestPath: string,
): { files: ExpectedFile[]; warnings: string[] } {
  // Phase 6 #2: expand policy_packs[] into hook contributions + extra
  // generated files BEFORE settings projection. Pack hooks flow through
  // generate-settings unchanged (they're just additional Hook entries
  // in the in-memory manifest), and pack files flow through the same
  // three-state-compare + lock pipeline as settings.json / MEMORY.md.
  //
  // The `reportsDir` opt threads a manifest-anchored absolute path into
  // the understanding-before-execution pack so its emitted hook commands
  // carry `UNDERSTANDING_GATE_REPORT_DIR=<path>` — every actor that
  // touches the persisted-report dir then resolves the same location,
  // independent of cwd. Without this, the pack's Stop hook (cwd =
  // session) and `harness approve understanding` (cwd = operator
  // terminal) silently diverge.
  const runtime: Runtime = opts.runtime ?? DEFAULT_RUNTIME;
  const reportsDir = reportsDirForManifest(manifestPath);
  const packExpansion = expandPolicyPacks(manifest, runtime, { reportsDir });
  const augmentedManifest: Manifest =
    packExpansion.hooks.length === 0
      ? manifest
      : { ...manifest, hooks: [...manifest.hooks, ...packExpansion.hooks] };
  const indexResult = generateMemoryIndex(manifest, {
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.project !== undefined ? { projectName: opts.project } : {}),
  });
  // Pack files emit in stable order (sorted by relativePath) so two
  // applies of the same manifest write byte-identical .last-apply.
  const packFiles: ExpectedFile[] = [...packExpansion.files]
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
    .map((f) => ({ basename: f.relativePath, content: f.content }));

  if (runtime === "codex") {
    // Codex apply: emit Codex config artefact instead of settings.json.
    // settings.json is Claude Code's contract and meaningless to Codex.
    // MEMORY.md and pack instructions.md are runtime-agnostic and ship
    // unchanged.
    const codexConfig = generateCodexConfig(augmentedManifest);
    const codexWarnings = [...codexConfig.warnings];
    if (packExpansion.permissions) {
      // Phase 6 #6: pack permission profiles project into Claude Code's
      // settings.json `permissions` block. The codex generator does not
      // yet consume them (Codex sandbox shaping is a follow-up); the
      // contribution would otherwise vanish silently.
      const totalPerms =
        packExpansion.permissions.allow.length +
        packExpansion.permissions.ask.length +
        packExpansion.permissions.deny.length;
      if (totalPerms > 0) {
        codexWarnings.push(
          `policy_packs contributed ${totalPerms} permission entr${
            totalPerms === 1 ? "y" : "ies"
          }; --runtime codex does not yet wire permissions into Codex's sandbox shape (filed as a Phase 6 #6 follow-up)`,
        );
      }
    }
    return {
      files: [
        { basename: CODEX_CONFIG_BASENAME, content: codexConfig.content },
        { basename: MEMORY_BASENAME, content: indexResult.content },
        ...packFiles,
      ],
      warnings: [...codexWarnings, ...indexResult.warnings, ...packExpansion.warnings],
    };
  }

  const settingsResult = generateSettingsWithWarnings(augmentedManifest, {
    ...(packExpansion.permissions && { packPermissions: packExpansion.permissions }),
  });
  const settings = `${JSON.stringify(settingsResult.root, null, 2)}\n`;
  return {
    files: [
      { basename: SETTINGS_BASENAME, content: settings },
      { basename: MEMORY_BASENAME, content: indexResult.content },
      ...packFiles,
    ],
    warnings: [...settingsResult.warnings, ...indexResult.warnings, ...packExpansion.warnings],
  };
}

function readOnDisk(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function buildPrevManifestForHints(record: LastApplyRecord | null): Manifest | null {
  if (!record?.manifest) return null;
  // Reject a snapshot whose stored sha256 disagrees with the recorded
  // content. Treats integrity failure as "no prev manifest" (silent: same
  // surface as a baseline record without a manifest field), so a corrupted
  // .last-apply does not produce confidently-wrong restart hints.
  const integrity = verifyLastApplyIntegrity({
    files: { manifest: record.manifest },
  });
  if (integrity.length > 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.manifest.content);
  } catch {
    return null;
  }
  try {
    return parseManifest(parsed);
  } catch {
    return null;
  }
}

function recoverMissingLastApplyContent(
  basename: string,
  onDisk: string | null,
): string | null {
  // Runtime-specific applies share one harness.generated/.last-apply file.
  // A default claude-code apply from older versions can leave an existing
  // harness-generated Codex artefact on disk while dropping its last-apply
  // entry. Treat only the Codex generator's own DO-NOT-EDIT artefact as a
  // recoverable baseline; arbitrary files without a last-apply record still
  // refuse as operator-owned drift.
  if (basename !== CODEX_CONFIG_BASENAME || onDisk === null) return null;
  return onDisk.startsWith(CODEX_GENERATED_HEADER) ? onDisk : null;
}

function buildMergedLastApplyRecord(
  expected: ExpectedFile[],
  previous: LastApplyRecord | null,
  manifest: Manifest,
  memoryDirSnapshots: Record<string, { sha256: string; fileHashes: Record<string, string> }>,
): LastApplyRecord {
  const next: LastApplyRecord = buildLastApply(
    Object.fromEntries(expected.map((f) => [f.basename, f.content])),
  );
  if (previous !== null) {
    for (const [relPath, entry] of Object.entries(previous.files)) {
      if (next.files[relPath] === undefined) next.files[relPath] = entry;
    }
  }
  const manifestSnapshotJson = JSON.stringify(manifest);
  next.manifest = {
    sha256: sha256Hex(manifestSnapshotJson),
    content: manifestSnapshotJson,
  };
  if (Object.keys(memoryDirSnapshots).length > 0) {
    next.memoryDirs = memoryDirSnapshots;
  }
  return next;
}

export async function apply(opts: ApplyOptions = {}): Promise<ApplyResult> {
  const runtime: Runtime = opts.runtime ?? DEFAULT_RUNTIME;
  const manifestPath = resolveManifestPath(opts);
  if (!fs.existsSync(manifestPath)) {
    throw new HarnessExitError(
      `harness manifest not found at ${manifestPath}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  const generatedDir = resolveGeneratedDir({ homeDir: opts.homeDir, manifestPath });
  const lockPath = path.join(path.dirname(manifestPath), LOCK_BASENAME);

  const loaderOpts: Parameters<typeof loadManifest>[0] = {
    configPath: manifestPath,
  };
  if (opts.homeDir !== undefined) loaderOpts.homeDir = opts.homeDir;
  if (opts.project !== undefined) loaderOpts.project = opts.project;
  const { manifest } = loadManifest(loaderOpts);

  // Fail loud on unknown pack source / builtin name BEFORE expansion.
  // Without this, `expandPolicyPacks` silently skips the bad entry and
  // apply reports success, masking the misconfigured pack until
  // someone runs `harness validate` or `doctor`. See
  // policy-packs/source-check.ts for the shared check shared with validate.
  const packSourceIssues = checkPolicyPackSources(manifest);
  if (packSourceIssues.length > 0) {
    const lines = packSourceIssues.map(
      (i) => `policy_packs[${i.packIndex}] (${i.packName}).${i.field}: ${i.message}`,
    );
    throw new HarnessExitError(
      `harness apply: ${lines.length} policy pack issue${
        lines.length === 1 ? "" : "s"
      }; run \`harness validate\` for the full report\n${lines.join("\n")}`,
      EX_FAIL,
    );
  }

  const { files: expected, warnings } = buildExpectedFiles(manifest, opts, manifestPath);
  const lastApply = readLastApply(generatedDir);

  if (opts.installCodex && runtime !== "codex") {
    throw new HarnessExitError("--install requires --runtime codex", EX_NOINPUT);
  }

  // Asset-content drift detection (Phase 3 #6): if a previous apply wrote
  // harness.lock, re-hash every locked asset / memory-dir Merkle and report
  // mismatches. Warn-only: apply still proceeds and the lock is rewritten
  // at the end of the run. Users wanting enforcement wrap apply in a script
  // that greps for `asset drift detected:`.
  //
  // We compute against the *previous* lock (read here, before the manifest
  // is consulted to build the new lock). An asset removed from the manifest
  // in this same apply still surfaces if it drifted — the reportable event
  // is "the file on disk diverged from what was last-known", regardless of
  // whether the manifest still references it.
  const previousLock = readLock(lockPath);
  const lockDrift: DriftedAsset[] = previousLock !== null ? computeDrift(previousLock) : [];

  // Phase 3 follow-up (strict-lock): when --strict-lock is set and any
  // locked asset has drifted, refuse with a distinct outcome before we
  // write anything, prompt, or regenerate the lock. (buildExpectedFiles
  // ran above; that is pure computation against the in-memory manifest
  // and produces no on-disk side effects, so running it pre-gate is
  // harmless and keeps the order independent of strict-lock.) Dry-run
  // wins per the task spec: `--strict-lock --dry-run` falls through to
  // the regular dry-run path so the user can preview the would-be
  // drift without exiting non-zero.
  if (opts.strictLock && lockDrift.length > 0 && !opts.dryRun) {
    return {
      manifestPath,
      generatedDir,
      files: [],
      warnings,
      restartHints: [],
      outcome: "lock-drift-refuse",
      lockDrift,
      written: false,
      dryRun: false,
      lockPath,
    };
  }

  // --target precondition: validate up front so we don't half-apply (write
  // harness.generated/, then refuse on the target). The settings.json
  // expected content is the manifest's projection — so the merge inputs
  // are already known here.
  const targetPath = opts.target ? resolveTargetPath(opts.target, opts.homeDir) : undefined;
  if (!targetPath && (opts.merge || opts.force)) {
    throw new HarnessExitError(
      `--${opts.merge ? "merge" : "force"} requires --target`,
      EX_NOINPUT,
    );
  }
  // Phase 6 #6: --target wires the generated settings.json into a
  // Claude Code path. The runtime=codex branch does not produce
  // settings.json at all, so the combination is incoherent. Reject
  // early instead of writing a half-broken state.
  if (targetPath && opts.runtime === "codex") {
    throw new HarnessExitError(
      "--target is incompatible with --runtime codex (target wires Claude Code's settings.json)",
      EX_NOINPUT,
    );
  }
  let targetContent: string | undefined;
  let targetMergeSummary: string | undefined;
  let targetChanged = false;
  if (targetPath) {
    if (opts.merge && opts.force) {
      throw new HarnessExitError(
        "--merge and --force are mutually exclusive",
        EX_NOINPUT,
      );
    }
    const settingsExpected = expected.find((f) => f.basename === SETTINGS_BASENAME);
    if (!settingsExpected) {
      throw new HarnessExitError(
        "internal: settings.json missing from expected files",
        EX_NOINPUT,
      );
    }
    const generatedSettings = JSON.parse(settingsExpected.content) as Record<string, unknown>;
    let targetStat: fs.Stats | null = null;
    try {
      targetStat = fs.statSync(targetPath);
    } catch {
      targetStat = null;
    }
    if (targetStat !== null && !targetStat.isFile()) {
      throw new HarnessExitError(
        `target ${targetPath} exists but is not a regular file (e.g. directory or device)`,
        EX_NOINPUT,
      );
    }
    const targetExists = targetStat !== null;
    if (targetExists) {
      const { parsed, parseError } = readTargetJson(targetPath);
      if (opts.merge) {
        if (parseError !== null) {
          throw new HarnessExitError(
            `cannot --merge into ${targetPath}: ${parseError}`,
            EX_NOINPUT,
          );
        }
        const mergeResult = mergeSettings(parsed, generatedSettings);
        targetContent = serializeJson(mergeResult.merged);
        targetMergeSummary = summarizeMerge(targetPath, mergeResult);
      } else if (opts.force) {
        targetContent = settingsExpected.content;
      } else {
        return {
          manifestPath,
          generatedDir,
          files: [],
          warnings,
          restartHints: [],
          outcome: "target-exists-refuse",
          lockDrift,
          written: false,
          dryRun: opts.dryRun ?? false,
          lockPath,
          targetPath,
          targetWritten: false,
          targetInSync: false,
        };
      }
    } else {
      targetContent = settingsExpected.content;
    }
    if (targetContent !== undefined) {
      const currentTargetContent = readOnDisk(targetPath);
      targetChanged = currentTargetContent !== targetContent;
    }
  }

  let codexInstallPlan: CodexConfigInstallPlan | undefined;
  let codexInstallChanged = false;
  if (opts.installCodex) {
    const codexExpected = expected.find(
      (f) => f.basename === CODEX_CONFIG_BASENAME,
    );
    if (!codexExpected) {
      throw new HarnessExitError(
        "internal: codex/config.toml missing from expected files",
        EX_NOINPUT,
      );
    }
    codexInstallPlan = planCodexConfigInstall({
      ...(opts.codexConfigPath !== undefined
        ? { configPath: resolveTargetPath(opts.codexConfigPath) }
        : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      generatedPath: path.join(generatedDir, CODEX_CONFIG_BASENAME),
      generatedContent: codexExpected.content,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    codexInstallChanged = codexInstallPlan.changed;
  }

  const fileOutcomes: FileApplyOutcome[] = [];
  let anyDriftRefuse = false;
  let anyChanged = false;
  let recoveredMissingLastApply = false;

  for (const f of expected) {
    const target = path.join(generatedDir, f.basename);
    const onDisk = readOnDisk(target);
    let lastAppliedContent = lastApply?.files[f.basename]?.content ?? null;
    if (lastAppliedContent === null) {
      const recovered = recoverMissingLastApplyContent(f.basename, onDisk);
      if (recovered !== null) {
        lastAppliedContent = recovered;
        recoveredMissingLastApply = true;
      }
    }
    const verdict = compare({
      manifestExpected: f.content,
      lastApplied: lastAppliedContent,
      onDiskCurrent: onDisk,
    });
    const outcome: FileApplyOutcome = {
      basename: f.basename,
      path: target,
      verdict,
      changed: f.content !== onDisk,
    };
    if (verdict === "drift-refuse") {
      anyDriftRefuse = true;
      outcome.diff = unifiedDiff({
        fileName: f.basename,
        oldText: lastAppliedContent ?? "",
        newText: onDisk ?? "",
        oldHeader: "last-apply",
        newHeader: "on-disk",
      });
    }
    if (outcome.changed) anyChanged = true;
    fileOutcomes.push(outcome);
  }

  if (anyDriftRefuse && !opts.overwriteDrift) {
    const result: ApplyResult = {
      manifestPath,
      generatedDir,
      files: fileOutcomes,
      warnings,
      restartHints: [],
      outcome: "drift-refuse",
      lockDrift,
      written: false,
      dryRun: opts.dryRun ?? false,
      lockPath,
    };
    if (codexInstallPlan) result.codexConfigInstall = codexInstallOutcome(codexInstallPlan);
    return result;
  }

  if (anyDriftRefuse && opts.overwriteDrift) {
    // `--yes` stands in for the typed confirmation (non-interactive runs).
    let confirmed = opts.yes === true;
    if (!confirmed) {
      const promptFn = opts.prompt ?? readlinePrompt;
      const answer = await promptFn(
        "Type 'yes' to discard on-disk hand-edits and overwrite with manifest-expected content: ",
      );
      // Case-insensitive comparison: a user typing `YES` or `Yes` is clearly
      // confirming. We still reject `y` per spec ("literal yes, not y").
      confirmed = answer.trim().toLowerCase() === "yes";
    }
    if (!confirmed) {
      const result: ApplyResult = {
        manifestPath,
        generatedDir,
        files: fileOutcomes,
        warnings,
        restartHints: [],
        outcome: "drift-discarded",
        lockDrift,
        written: false,
        dryRun: opts.dryRun ?? false,
        lockPath,
      };
      if (codexInstallPlan) result.codexConfigInstall = codexInstallOutcome(codexInstallPlan);
      return result;
    }
    // Confirmed: continue to the write phase. The per-file `verdict` field
    // remains `drift-refuse` so callers can still see which files would
    // have been refused; the wrapper outcome is `applied` post-write.
  }

  // Restart hints: compare the previous-apply's manifest snapshot to the
  // current effective manifest.
  const prevManifest = buildPrevManifestForHints(lastApply);
  const restartHints = prevManifest ? emitRestartHints(prevManifest, manifest) : [];

  if (opts.dryRun) {
    const result: ApplyResult = {
      manifestPath,
      generatedDir,
      files: fileOutcomes,
      warnings,
      restartHints,
      outcome: anyChanged || targetChanged || codexInstallChanged ? "would-apply" : "no-changes",
      lockDrift,
      written: false,
      dryRun: true,
      lockPath,
    };
    if (targetPath) {
      result.targetPath = targetPath;
      result.targetWritten = false;
      // Dry run writes nothing, so "in sync" reflects the current
      // on-disk state: in sync iff the merge would be a no-op.
      result.targetInSync = !targetChanged;
      if (targetMergeSummary !== undefined) result.targetMergeSummary = targetMergeSummary;
    }
    if (codexInstallPlan) result.codexConfigInstall = codexInstallOutcome(codexInstallPlan);
    return result;
  }

  if (!anyChanged && !targetChanged && !codexInstallChanged && lastApply !== null) {
    // Idempotent no-op for generated files. If asset-content drift was
    // detected against harness.lock, rewrite the lock now with current
    // SHAs so the drift is not "sticky": the user sees the drift line
    // once, the next apply is clean. Without this, every subsequent
    // apply re-reports the same drift forever until something else in
    // the manifest changes.
    if (lockDrift.length > 0) {
      const refreshed = buildLockEntries(manifest, {
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
        ...(opts.project !== undefined ? { projectName: opts.project } : {}),
      });
      const refreshedWithTarget = appendTargetEntry(
        refreshed,
        targetPath,
        targetContent,
        previousLock,
      );
      writeLock(lockPath, refreshedWithTarget);
    }
    if (recoveredMissingLastApply) {
      const refreshedMemoryDirs = collectMemoryDirSnapshots(
        buildLockEntries(manifest, {
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          ...(opts.project !== undefined ? { projectName: opts.project } : {}),
        }),
      );
      writeLastApply(
        generatedDir,
        buildMergedLastApplyRecord(expected, lastApply, manifest, refreshedMemoryDirs),
      );
    }
    const result: ApplyResult = {
      manifestPath,
      generatedDir,
      files: fileOutcomes,
      warnings,
      restartHints,
      outcome: "no-changes",
      lockDrift,
      written: false,
      dryRun: false,
      lockPath,
    };
    if (targetPath) {
      result.targetPath = targetPath;
      result.targetWritten = false;
      // `no-changes` is reached only when targetChanged is false, i.e.
      // the target already holds the merged content: in sync.
      result.targetInSync = true;
    }
    if (codexInstallPlan) result.codexConfigInstall = codexInstallOutcome(codexInstallPlan);
    return result;
  }

  // Only write generated files if anything in harness.generated/ actually
  // changed. When the user passed --target on an otherwise-clean tree,
  // anyChanged may be false but targetChanged true: we still want to write
  // the target without re-touching harness.generated/ files (and without
  // re-stamping .last-apply, which would invalidate the no-changes
  // shortcut on the very next apply).
  if (anyChanged) {
    fs.mkdirSync(generatedDir, { recursive: true });
    for (const f of expected) {
      const target = path.join(generatedDir, f.basename);
      atomicWriteFile(target, f.content);
    }
  }

  // Compute lock + memory-dir snapshot BEFORE writing .last-apply so the
  // record is built once and persisted atomically. A previous version of
  // this code wrote .last-apply twice (once without memoryDirs, then again
  // with it), which produced a half-state if the process died between
  // writes: the next `--memory-detail` diff would have seen every on-disk
  // .md as "added" against an empty index. Single write closes that gap.
  const lockEntries = buildLockEntries(manifest, {
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.project !== undefined ? { projectName: opts.project } : {}),
  });

  // Target write happens BEFORE the lock + .last-apply records so the
  // recorded sha matches what's actually on disk (and so a crash between
  // target-write and lock-write produces a re-applyable state, not a
  // permanently-drifted lock).
  let targetWritten = false;
  if (targetPath && targetContent !== undefined && targetChanged) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFile(targetPath, targetContent);
    targetWritten = true;
  }

  let codexInstallResult: CodexConfigInstallResult | undefined;
  if (codexInstallPlan && codexInstallPlan.changed) {
    codexInstallResult = writeCodexConfigInstall(codexInstallPlan, {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } else if (codexInstallPlan) {
    codexInstallResult = { ...codexInstallPlan, written: false };
  }

  const lockEntriesWithTarget = appendTargetEntry(
    lockEntries,
    targetPath,
    targetContent,
    previousLock,
  );

  if (anyChanged || recoveredMissingLastApply) {
    const memoryDirSnapshots = collectMemoryDirSnapshots(lockEntries);
    writeLastApply(
      generatedDir,
      buildMergedLastApplyRecord(expected, lastApply, manifest, memoryDirSnapshots),
    );
  }
  writeLock(lockPath, lockEntriesWithTarget);

  const result: ApplyResult = {
    manifestPath,
    generatedDir,
    files: fileOutcomes,
    warnings,
    restartHints,
    outcome: "applied",
    lockDrift,
    written: anyChanged || codexInstallResult?.written === true,
    dryRun: false,
    lockPath,
  };
  if (codexInstallResult) result.codexConfigInstall = codexInstallOutcome(codexInstallResult);
  if (targetPath) {
    result.targetPath = targetPath;
    result.targetWritten = targetWritten;
    // Reached the write phase without refusing the target: the file now
    // holds the merged content, whether written this run (targetChanged)
    // or already byte-identical.
    result.targetInSync = true;
    if (targetMergeSummary !== undefined) result.targetMergeSummary = targetMergeSummary;
  }
  return result;
}

function appendTargetEntry(
  entries: LockEntry[],
  targetPath: string | undefined,
  targetContent: string | undefined,
  previousLock: LockEntry[] | null,
): LockEntry[] {
  // Current invocation passed --target: emit an entry hashing the content
  // we're writing this run.
  if (targetPath && targetContent !== undefined) {
    return [
      ...entries,
      {
        kind: "target",
        path: targetPath,
        sha256: crypto.createHash("sha256").update(targetContent).digest("hex"),
      },
    ];
  }
  // No --target this run, but a prior apply set one up: carry every prior
  // target entry forward, re-hashing the on-disk content so the lock
  // remains an accurate drift baseline. A target file deleted out-of-band
  // is dropped from the lock here (the next `validate --check-lock` would
  // otherwise report it as missing forever); this matches the existing
  // asset-handling at the same layer.
  if (!previousLock) return entries;
  const carried: LockEntry[] = [];
  for (const e of previousLock) {
    if (e.kind !== "target") continue;
    let content: Buffer;
    try {
      content = fs.readFileSync(e.path);
    } catch {
      continue;
    }
    carried.push({
      kind: "target",
      path: e.path,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
  return [...entries, ...carried];
}

function sha256OfFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function collectMemoryDirSnapshots(
  lockEntries: ReturnType<typeof buildLockEntries>,
): Record<string, { sha256: string; fileHashes: Record<string, string> }> {
  const out: Record<string, { sha256: string; fileHashes: Record<string, string> }> = {};
  for (const e of lockEntries) {
    if (e.kind !== "memory-dir") continue;
    const fileHashes: Record<string, string> = {};
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(e.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!d.isFile() || !d.name.endsWith(".md")) continue;
      fileHashes[d.name] = sha256OfFile(path.join(e.path, d.name));
    }
    out[e.path] = { sha256: e.sha256, fileHashes };
  }
  return out;
}

export { DRIFT_HINT_MESSAGE };
