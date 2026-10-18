/**
 * Hook liveness: are the hooks `harness apply` generates actually present in
 * the live runtime config? Without this check a hook that exists only in the
 * generated artefact (never installed, dropped by a hand edit) leaves its
 * gate silently absent.
 *
 * Per runtime the generated hook entries are compared with the live config
 * by (event, matcher, command):
 * - Claude Code: `settings.json` under the `CLAUDE_CONFIG_DIR` resolution
 *   `resolveSettingsPath` applies.
 * - Codex: `~/.codex/config.toml`.
 *
 * Severity: a generated entry that is absent or carries another command is an
 * error. An entry taken out by `harness gate disable` is a warning (the
 * operator did it on purpose and can read it back from the recorded state:
 * the live gate snapshot of either runtime). A Codex unit counts as disabled
 * only when `harness gate enable --runtime codex` would restore it (an own
 * snapshot that is not spent names it by id); an empty hooks array otherwise
 * is a hand edit, so a missing error.
 * The warning names the command that puts the entry back as that runtime's
 * gate takes it: `harness gate enable` for Claude Code, with `--settings` when
 * the compared file is not the one the gate targets by default (for example
 * under `CLAUDE_CONFIG_DIR`) and `--force` when the gate would refuse the
 * plain command (by its own refusal decision, `claudeEnableRefusal`: the file
 * holds a group with the event and matcher of a removed one but other
 * content, or it was edited since the disable and the still-missing groups do
 * not add up to the pre-disable file); `harness gate enable --runtime codex`
 * for Codex, with `--config` for a config other than the default one and
 * `--force` when the config was edited since the disable (the restore refuses
 * without it).
 * A live hook that is not in the generated set is an info line, never counted.
 * A live file that is missing or unreadable is one error finding, and so is a
 * gate snapshot that cannot be read: the disabled state is then unknowable, so
 * doctor fails closed and names the snapshot instead of guessing.
 */
import * as fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { expandPolicyPacks } from "../../policy-packs/index.js";
import type { Runtime } from "../../policy-packs/runtime.js";
import type { Manifest } from "../../schema/index.js";
import { generateCodexConfig } from "../apply/generate-codex-config.js";
import { generateSettings } from "../apply/generate-settings.js";
import {
  type CodexManagedHookUnit,
  defaultCodexConfigPath,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import {
  CODEX_INSTALL_COMMAND,
  codexConfigFlag,
  latestInstall,
  type LoadedCodexSnapshot,
  planCodexRestore,
  readLiveCodexSnapshots,
  resolveCodexConfig,
  spentCodexSnapshot,
} from "../gate/codex-snapshot.js";
import { shellQuote } from "../gate/shell-quote.js";
import {
  claudeEnableRefusal,
  type ClaudeEnableRefusal,
  type LiveSnapshot,
  listLiveSnapshots,
  planRestore,
  settingsFlag,
  sha256Hex,
} from "../gate/snapshot.js";
import { resolveSettingsPath } from "./claude-mcp.js";

export type HookLivenessStatus = "ok" | "warn" | "error" | "info";
export type HookLivenessKind = "present" | "missing" | "differing" | "disabled" | "extra" | "file";
export type HookLivenessRuntime = "claude-code" | "codex";

export interface HookLivenessEntry {
  kind: HookLivenessKind;
  status: HookLivenessStatus;
  /** Hook event; empty for a `file` finding. */
  event: string;
  matcher: string | null;
  command: string;
  message: string;
}

export interface HookLivenessRuntimeReport {
  runtime: HookLivenessRuntime;
  /** The live config that was compared. */
  livePath: string;
  entries: HookLivenessEntry[];
}

export interface HookLivenessSection {
  runtimes: HookLivenessRuntimeReport[];
}

export interface HookKey {
  event: string;
  matcher: string | null;
  command: string;
}

export interface HookLivenessOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Which runtimes to compare. */
  runtimes: readonly HookLivenessRuntime[];
  /** Test seam: the Codex config to compare; defaults to `~/.codex/config.toml`. */
  codexConfigPath?: string;
}

export interface LiveHookCheckOptions {
  /**
   * The file `harness gate enable` targets when the command names no
   * `--settings` / `--config`. The warning for a gate-disabled entry names
   * the flag unless the compared file is this one; absent, it always does.
   */
  gateDefaultPath?: string;
}

const keyId = (k: HookKey): string => JSON.stringify([k.event, k.matcher, k.command]);
const slotId = (k: Pick<HookKey, "event" | "matcher">): string => JSON.stringify([k.event, k.matcher]);

export function describeHook(k: HookKey): string {
  return `${k.event} matcher ${k.matcher === null ? "(none)" : `"${k.matcher}"`} command ${k.command}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Flatten `{ [event]: [{ matcher?, hooks: [{ command }] }] }` into keys; malformed shapes are skipped. */
function flattenHookTable(table: unknown): HookKey[] {
  const out: HookKey[] = [];
  if (!isRecord(table)) return out;
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group["matcher"] === "string" ? group["matcher"] : null;
      const hooks = group["hooks"];
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        if (isRecord(h) && typeof h["command"] === "string") {
          out.push({ event, matcher, command: h["command"] });
        }
      }
    }
  }
  return out;
}

export function expectedClaudeHooks(manifest: Manifest): HookKey[] {
  const hooks = [...manifest.hooks, ...expandPolicyPacks(manifest, "claude-code").hooks];
  return flattenHookTable(generateSettings({ ...manifest, hooks }).hooks);
}

export function expectedCodexHooks(manifest: Manifest): HookKey[] {
  const hooks = [...manifest.hooks, ...expandPolicyPacks(manifest, "codex").hooks];
  const text = generateCodexConfig({ ...manifest, hooks }).content;
  const doc = parseToml(text);
  return flattenHookTable(doc["hooks"]);
}

function fileFinding(message: string): HookLivenessEntry {
  return { kind: "file", status: "error", event: "", matcher: null, command: "", message };
}

/**
 * Compare `expected` with `live`. `isDisabled` answers from the gate's own
 * recorded state whether a missing entry was taken out by `harness gate disable`;
 * `disabledMessage` words the warning for such an entry.
 */
function compare(
  expected: readonly HookKey[],
  live: readonly HookKey[],
  isDisabled: (k: HookKey) => boolean,
  disabledMessage: (k: HookKey) => string,
  liveLabel: string,
  fixHintFor: (ctx: { extraOrDisabled: boolean }) => string,
): HookLivenessEntry[] {
  const out: HookLivenessEntry[] = [];
  const liveIds = new Set(live.map(keyId));
  const expectedIds = new Set(expected.map(keyId));
  const extraOrDisabled =
    live.some((l) => !expectedIds.has(keyId(l))) ||
    expected.some((e) => !liveIds.has(keyId(e)) && isDisabled(e));
  const fixHint = fixHintFor({ extraOrDisabled });
  const liveBySlot = new Map<string, HookKey[]>();
  for (const l of live) {
    const list = liveBySlot.get(slotId(l)) ?? [];
    list.push(l);
    liveBySlot.set(slotId(l), list);
  }
  for (const e of expected) {
    if (liveIds.has(keyId(e))) {
      out.push({ ...e, kind: "present", status: "ok", message: `present: ${describeHook(e)}` });
      continue;
    }
    if (isDisabled(e)) {
      out.push({ ...e, kind: "disabled", status: "warn", message: disabledMessage(e) });
      continue;
    }
    const sameSlot = (liveBySlot.get(slotId(e)) ?? []).filter((l) => !expectedIds.has(keyId(l)));
    if (sameSlot.length > 0) {
      out.push({
        ...e,
        kind: "differing",
        status: "error",
        message:
          `differs in ${liveLabel}: expected ${describeHook(e)}, live has ` +
          `${sameSlot.map((l) => l.command).join(", ")}; ${fixHint}`,
      });
      continue;
    }
    out.push({
      ...e,
      kind: "missing",
      status: "error",
      message: `missing from ${liveLabel}: ${describeHook(e)}; ${fixHint}`,
    });
  }
  const differingLive = new Set(
    out.filter((o) => o.kind === "differing").map((o) => slotId(o)),
  );
  for (const l of live) {
    if (expectedIds.has(keyId(l))) continue;
    // A live entry that stands in for a generated one is reported by the
    // differing line, not a second time as extra.
    if (differingLive.has(slotId(l))) continue;
    out.push({
      ...l,
      kind: "extra",
      status: "info",
      message: `not generated by harness: ${describeHook(l)}`,
    });
  }
  return out;
}

function readText(
  p: string,
  fixHint: string,
): { ok: true; text: string } | { ok: false; message: string } {
  try {
    return { ok: true, text: fs.readFileSync(p, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, message: `${p} not found; ${fixHint}` };
    }
    return { ok: false, message: `cannot read ${p}: ${(err as Error).message}` };
  }
}

export function checkClaudeLiveHooks(
  manifest: Manifest,
  settingsPath: string,
  opts: LiveHookCheckOptions = {},
): HookLivenessRuntimeReport {
  const report: HookLivenessRuntimeReport = { runtime: "claude-code", livePath: settingsPath, entries: [] };
  const expected = expectedClaudeHooks(manifest);
  if (expected.length === 0) return report;
  const applyHint = `run \`harness apply --target ${shellQuote(settingsPath)} --merge\``;
  const read = readText(settingsPath, applyHint);
  if (!read.ok) {
    report.entries.push(fileFinding(read.message));
    return report;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch (err) {
    report.entries.push(fileFinding(`${settingsPath} is not valid JSON: ${(err as Error).message}`));
    return report;
  }
  if (!isRecord(doc)) {
    report.entries.push(fileFinding(`${settingsPath} is not a JSON object`));
    return report;
  }
  const live = flattenHookTable(doc["hooks"]);
  // The gate's own record of what it took out: every live snapshot beside the
  // file lists the removed groups. A snapshot that cannot be read leaves the
  // disabled state unknowable: one error finding names it, and the missing
  // entries point at it instead of at an apply that would not help.
  const removed: HookKey[] = [];
  const snaps = listLiveSnapshots(settingsPath);
  let snapshotProblem = false;
  if (snaps.ok) {
    for (const s of snaps.live) {
      for (const r of s.snapshot.removed) {
        removed.push(...flattenHookTable({ [r.event]: [r.group] }));
      }
    }
  } else {
    snapshotProblem = true;
    report.entries.push(
      fileFinding(
        `cannot read the gate snapshot ${snaps.path}: ${snaps.reason}; ` +
          "a hook taken out by `harness gate disable` cannot be told from a missing one until it is readable " +
          "(fix or move the snapshot aside)",
      ),
    );
  }
  const removedIds = new Set(removed.map(keyId));
  // The gate does not read CLAUDE_CONFIG_DIR: any other file than its default needs --settings.
  const enable = `harness gate enable${settingsPath === opts.gateDefaultPath ? "" : ` ${settingsFlag(settingsPath)}`}`;
  // A disabled hook comes back with `gate enable` alone, or with `gate enable
  // --force`, by the gate's own decision: a live snapshot the gate refuses
  // without `--force` marks every group it removed, so the warning names the
  // flag exactly when the plain command would refuse and say why.
  const forceOf = claudeEnableForce(read.text, doc, snaps.ok ? snaps.live : []);
  report.entries.push(
    ...compare(
      expected,
      live,
      (k) => removedIds.has(keyId(k)),
      (k) => {
        const head = `disabled via \`harness gate disable\`: ${describeHook(k)}; `;
        const force = forceOf.get(keyId(k));
        return force === undefined
          ? `${head}run \`${enable}\` to put it back`
          : `${head}run \`${enable} --force\` to put it back: ` +
              (force.reason === "changed-group"
                ? "settings.json holds a group with the event and matcher of the removed one but other content"
                : "settings.json was edited since the disable") +
              `, so the restore refuses without \`--force\` (inspect the diff against ${force.settingsBackupPath} first)`;
      },
      "settings.json",
      ({ extraOrDisabled }) =>
        snapshotProblem
          ? "see the gate snapshot finding above"
          : applyHint +
            (extraOrDisabled
              ? " (`--merge` replaces the hooks key: live hooks harness did not generate are lost, hooks " +
                "taken out by `harness gate disable` come back and the gate snapshot goes stale)"
              : ""),
    ),
  );
  return report;
}

/**
 * Why doctor must name `--force` for each group the live snapshots removed,
 * by the gate's own decision and not a copy of it: a snapshot
 * `gate enable` would refuse without `--force` marks every group it removed.
 * Newest snapshot first, the order `gate enable` applies them; the first
 * reason naming a group wins. A `hooks` shape the gate refuses to read marks
 * nothing: that refusal is not one of the two `--force` answers this warning
 * could name.
 */
function claudeEnableForce(
  text: string,
  doc: Record<string, unknown>,
  live: readonly LiveSnapshot[],
): Map<string, { reason: ClaudeEnableRefusal; settingsBackupPath: string }> {
  const out = new Map<string, { reason: ClaudeEnableRefusal; settingsBackupPath: string }>();
  for (const { snapshot } of live) {
    const hooks = settingsHooksOf(doc);
    if (hooks === null) break;
    const reason = claudeEnableRefusal(sha256Hex(text), doc, planRestore(hooks, snapshot), snapshot);
    if (reason === null) continue;
    for (const r of snapshot.removed) {
      for (const k of flattenHookTable({ [r.event]: [r.group] })) {
        const id = keyId(k);
        if (!out.has(id)) out.set(id, { reason, settingsBackupPath: snapshot.settingsBackupPath });
      }
    }
  }
  return out;
}

/** The `hooks` of a parsed settings.json as the gate reads them: an array of groups per event; null for any other shape. */
function settingsHooksOf(doc: Record<string, unknown>): Record<string, unknown[]> | null {
  const rawHooks = doc["hooks"];
  const hooks: Record<string, unknown[]> = {};
  if (rawHooks === undefined) return hooks;
  if (!isRecord(rawHooks)) return null;
  for (const [event, groups] of Object.entries(rawHooks)) {
    if (!Array.isArray(groups)) return null;
    hooks[event] = groups.slice();
  }
  return hooks;
}

export function checkCodexLiveHooks(
  manifest: Manifest,
  configPath: string,
  opts: LiveHookCheckOptions = {},
): HookLivenessRuntimeReport {
  const report: HookLivenessRuntimeReport = { runtime: "codex", livePath: configPath, entries: [] };
  const expected = expectedCodexHooks(manifest);
  if (expected.length === 0) return report;
  const namedPath = configPath === opts.gateDefaultPath ? null : configPath;
  const fixHint = `run \`${CODEX_INSTALL_COMMAND}${codexConfigFlag(namedPath, "--codex-config")}\``;
  const read = readText(configPath, fixHint);
  if (!read.ok) {
    report.entries.push(fileFinding(read.message));
    return report;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(read.text);
  } catch (err) {
    report.entries.push(fileFinding(`${configPath} is not valid TOML: ${(err as Error).message}`));
    return report;
  }
  const live = flattenHookTable(doc["hooks"]);
  // The gate neutralises a unit in place (`hooks = []`) and records it in an
  // own snapshot beside the config. A unit counts as disabled only when
  // `harness gate enable --runtime codex` would restore it: the unit is still
  // neutralised in the block, an own snapshot names it by id, that snapshot is
  // not spent (the gate's own predicate: an install re-rendered the block
  // after it, the config is back at its pre-disable state, or it names units
  // that were deleted), the restore plan holds and does not hit the refusal
  // for an unedited config. The original hooks text must carry the expected
  // command. An empty array without that record is a hand edit and stays a
  // missing error, since `gate enable` could not put it back. A config edited
  // since the disable is restored only with `--force`, so the warning says so.
  let snapshotProblem = false;
  let ownSnapshots: LoadedCodexSnapshot[] = [];
  try {
    ownSnapshots = readLiveCodexSnapshots(configPath, (m) => new Error(m), namedPath).own;
  } catch (err) {
    snapshotProblem = true;
    report.entries.push(
      fileFinding(
        `cannot read the gate snapshot beside ${configPath}: ${(err as Error).message} ` +
          "A hook taken out by `harness gate disable` cannot be told from a missing one until it is readable.",
      ),
    );
  }
  const disabledUnits: RestorableCodexUnit[] = [];
  if (ownSnapshots.length > 0) {
    disabledUnits.push(...restorableCodexUnits(read.text, configPath, ownSnapshots));
  }
  const recordsOf = (k: HookKey): RestorableCodexUnit[] => disabledUnits.filter((d) => keyId(d.key) === keyId(k));
  const enable = `harness gate enable --runtime codex${codexConfigFlag(namedPath)}`;
  const disabledMessage = (k: HookKey): string => {
    const head = `disabled via \`harness gate disable --runtime codex\`: ${describeHook(k)}; `;
    const edited = recordsOf(k).find((d) => d.needsForce);
    return edited === undefined
      ? `${head}run \`${enable}\` to put it back`
      : `${head}run \`${enable} --force\` to put it back: the config was edited since the disable, so the ` +
          `restore refuses without \`--force\` (inspect the diff against ${edited.configBackupPath} first)`;
  };
  report.entries.push(
    ...compare(
      expected,
      live,
      (k) => recordsOf(k).length > 0,
      disabledMessage,
      "config.toml",
      () => (snapshotProblem ? "see the gate snapshot finding above" : fixHint),
    ),
  );
  return report;
}

/** A hook `harness gate enable --runtime codex` would put back, and how. */
interface RestorableCodexUnit {
  key: HookKey;
  /**
   * The gate makes this restore only under `--force`: the config was edited
   * since the snapshot and the restore does not rebuild its pre-disable sha.
   */
  needsForce: boolean;
  /** The snapshot's backup of the config as it was before the disable. */
  configBackupPath: string;
}

/**
 * The hooks `harness gate enable --runtime codex` would put back into `text`,
 * by the gate's own rules (the same predicates, not a re-implementation): a
 * snapshot that is spent is skipped (enable only retires it), a restore plan
 * that fails restores nothing, and neither does the refusal for a config that
 * is exactly what the snapshot left behind but does not rebuild its pre-disable
 * sha. Units match by id only, like the restore.
 */
function restorableCodexUnits(
  text: string,
  configPath: string,
  snapshots: readonly LoadedCodexSnapshot[],
): RestorableCodexUnit[] {
  let units: CodexManagedHookUnit[] | null;
  try {
    units = readCodexManagedHookUnits(text, configPath)?.units ?? null;
  } catch {
    // A block the scanner refuses yields no record; the entry stays a plain missing error.
    return [];
  }
  let requestedPath = configPath;
  let resolvedPath = configPath;
  try {
    const resolved = resolveCodexConfig({ configPath }, (m) => new Error(m));
    requestedPath = resolved.requestedPath;
    resolvedPath = resolved.configPath;
  } catch {
    // A dangling link: the install backups are looked for beside the path as given.
  }
  const install = latestInstall(requestedPath, resolvedPath);
  const sha = sha256Hex(text);
  const out: RestorableCodexUnit[] = [];
  for (const live of snapshots) {
    const { snapshot } = live;
    const spent = spentCodexSnapshot(snapshot, sha, units, install);
    if (spent.retire !== null) continue;
    const plan = planCodexRestore(text, units, configPath, live);
    if (!plan.ok) continue;
    if (sha === snapshot.configAfterSha256 && sha256Hex(plan.text) !== snapshot.configBeforeSha256) continue;
    // An unedited config that the restore does not rebuild was skipped above, so a restore that does not
    // rebuild the pre-disable bytes here is one on an edited config: the gate makes it only under --force.
    const needsForce = sha256Hex(plan.text) !== snapshot.configBeforeSha256;
    for (const restored of plan.restored) {
      for (const command of snapshotCommands(restored.hooksText)) {
        out.push({
          key: { event: restored.event, matcher: restored.matcher, command },
          needsForce,
          configBackupPath: snapshot.configBackupPath,
        });
      }
    }
  }
  return out;
}

/** The commands in a snapshot's original `hooks = [...]` line; none when it does not parse. */
function snapshotCommands(hooksText: string): string[] {
  try {
    const doc = parseToml(hooksText);
    const hooks = doc["hooks"];
    return Array.isArray(hooks)
      ? hooks.flatMap((h) => (isRecord(h) && typeof h["command"] === "string" ? [h["command"]] : []))
      : [];
  } catch {
    return [];
  }
}

export function buildHookLiveness(manifest: Manifest, opts: HookLivenessOptions): HookLivenessSection {
  const runtimes: HookLivenessRuntimeReport[] = [];
  if (opts.runtimes.includes("claude-code")) {
    // `harness gate enable` without --settings targets `~/.claude/settings.json`; it does not read CLAUDE_CONFIG_DIR.
    runtimes.push(
      checkClaudeLiveHooks(manifest, resolveSettingsPath(opts.home, opts.env), {
        gateDefaultPath: resolveSettingsPath(opts.home, {}),
      }),
    );
  }
  if (opts.runtimes.includes("codex")) {
    const defaultConfig = defaultCodexConfigPath(opts.home);
    runtimes.push(
      checkCodexLiveHooks(manifest, opts.codexConfigPath ?? defaultConfig, { gateDefaultPath: defaultConfig }),
    );
  }
  return { runtimes };
}

export function countHookLiveness(section: HookLivenessSection): { errorCount: number; warningCount: number } {
  let errorCount = 0;
  let warningCount = 0;
  for (const r of section.runtimes) {
    for (const e of r.entries) {
      if (e.status === "error") errorCount++;
      else if (e.status === "warn") warningCount++;
    }
  }
  return { errorCount, warningCount };
}

/** The runtimes whose live config doctor compares: the one a plain apply selects, plus Codex under `--target codex`. */
export function livenessRuntimes(selected: Runtime, target: string | undefined): HookLivenessRuntime[] {
  const out: HookLivenessRuntime[] = [];
  if (selected === "claude-code") out.push("claude-code");
  if (selected === "codex" || target === "codex") out.push("codex");
  return out;
}
