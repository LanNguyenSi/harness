// Interactive wizard for `harness init --interactive` (task c5287b80,
// PR split 3/3). Sequential Q&A via `@inquirer/prompts`. Composes the
// detection module (PR 1) and the profile templates (PR 2).
//
// Design notes:
//
// - Prompts are dependency-injected via the InteractivePrompts shape so
//   tests can drive the wizard with synchronous mock answers. The
//   default values come from the @inquirer/prompts package.
// - Ctrl-C from inquirer surfaces as an `ExitPromptError` with a name
//   matching `/ExitPrompt|aborted/i`. The wizard catches it, prints an
//   abort line to stderr, and returns `aborted:true` WITHOUT calling
//   `init()`. No partial manifest is ever written.
// - After validate-clean the wizard offers a runtime multiselect and
//   runs `harness apply` once per selected runtime (task 696f7560).
//   The set defaults to whichever runtimes detect() found configured,
//   so a fresh CC-only machine sees the historical single-runtime flow.
//   Unchecking everything skips wiring and prints the manual fallback.
// - Acceptance criterion "fresh ~/.claude/ produces a valid harness.yaml":
//   we delegate writing to the existing `init()` so the same atomic
//   write + file-lock + post-write validate path is reused. The wizard
//   is essentially a UI for picking the `--template` value.

import { select, confirm, input, checkbox } from "@inquirer/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { assertNoRealSpawnInTests, HermeticSpawnViolationError } from "../../runtime/hermetic-spawn-guard.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import {
  detect,
  type DetectionResult,
  type DetectedRuntime,
  type RuntimeName,
} from "./detect.js";
import { init, type InitResult } from "./index.js";
import type { NpmExec } from "../doctor/npm-bin-path.js";
import { validate } from "../validate/index.js";
import { apply, CODEX_CONFIG_BASENAME, SETTINGS_BASENAME, type ApplyResult } from "../apply/index.js";
import {
  buildMcpServers,
  projectGroundingEnv,
  type SettingsMcpServer,
} from "../apply/generate-settings.js";
import { loadManifest } from "../loader.js";
import type { Manifest } from "../../schema/index.js";
import {
  ensureMcpServers,
  manualRemoveLines,
  posixSingleQuote,
  stripOwnedMcpServers,
  type ClaudeMcpExec,
  type EnsureMcpServersResult,
} from "../../io/claude-mcp.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import { readLastApply, type LastApplyRecord } from "../../io/last-apply.js";
import { DEFAULT_OWNED_MCP_SERVERS } from "../uninstall/index.js";
import {
  checkDependencies,
  checkDependencyList,
  dependenciesForCustom,
  formatDependencyTable,
  installPackagesGlobally,
  type InstallOptions,
} from "./dependencies.js";
import {
  probeAgentTasksAuth,
  runBridgeLogin,
  type LoginSpawn,
  type ProbeSpawn,
} from "./agent-tasks-auth.js";
import {
  COMPOSABLE_MCPS,
  COMPOSABLE_PACKS,
  COMPOSABLE_POLICIES,
  composeCustom,
  type CustomMcpKey,
  type CustomPackKey,
  type CustomPolicyKey,
  type CustomSelection,
} from "./composer.js";

export type ProfileChoice = "solo" | "team" | "full" | "custom";

export interface InteractivePrompts {
  select: typeof select;
  confirm: typeof confirm;
  input: typeof input;
  checkbox: typeof checkbox;
}

/**
 * Wire targets the wizard knows about. `claude-code` and `codex` map to
 * the runtimes `harness apply` already supports via this wizard.
 * `opencode`'s runtime adapter has SHIPPED (task f34eb233 --
 * `harness apply --runtime opencode` works standalone), but wiring
 * THIS wizard up to call it is tracked separately as installer v1.1
 * task c5287b80, not built here (MED-F3, batch18 fix-round). The
 * checkbox slot stays disabled and stable in the meantime so docs and
 * screenshots do not churn when that wizard wiring lands.
 */
export type WireableRuntime = RuntimeName;
export interface RuntimeApplyOutcome {
  runtime: WireableRuntime;
  /** undefined if `apply()` threw — recoveryHint carries the user-facing message. */
  apply?: ApplyResult;
  /** Operator-facing recovery message when apply threw, or the manual merge command for codex. */
  recoveryHint?: string;
  /**
   * claude-code only (task init-mcp-wiring-claude-code/T-002): the result
   * of reconciling the manifest's `tools.mcp[]` servers against the live
   * `claude mcp` user-scope registry. Present whenever the wizard reached
   * the Ensure step for claude-code, regardless of outcome.
   */
  mcpEnsure?: EnsureMcpServersResult;
  /**
   * claude-code only: names stripped from the dead settings.json
   * `mcpServers` block, when the post-Ensure migration ran and changed
   * something. Absent when migration didn't run (Ensure incomplete) or
   * ran as a no-op.
   */
  mcpMigrationRemovedNames?: string[];
}

export interface RunInteractiveOptions {
  /** Override homedir for detection + write target. */
  homeDir?: string;
  /** Dependency-injection seam for tests. */
  prompts?: InteractivePrompts;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Force-confirm overwrite of existing manifest. Real users go through
   * the prompt; tests can pre-set this. */
  forceOverwrite?: boolean;
  /** Override the `npm i -g` runner. Tests fake success/failure here. */
  installSpawn?: InstallOptions["spawn"];
  /**
   * Override the PATH probed by the dependency check. Tests set this
   * to a directory with no binaries (or a curated one) to exercise the
   * "everything missing" / "partially installed" branches without
   * needing the real packages on the test host.
   */
  dependencyPathEnv?: string;
  /** Override the agent-tasks-mcp-bridge `status` probe runner (tests). */
  authProbeSpawn?: ProbeSpawn;
  /** Override the agent-tasks-mcp-bridge `login` runner (tests). */
  authLoginSpawn?: LoginSpawn;
  /**
   * Override the `claude mcp` CLI exec (task init-mcp-wiring-claude-code/
   * T-002). Tests inject a fake to drive the Ensure step (registering
   * `tools.mcp[]` servers via `claude mcp add-json --scope user`) without
   * a real `claude` binary on PATH. Production leaves this undefined and
   * gets the real CLI spawn (see `io/claude-mcp.ts`).
   */
  mcpExec?: ClaudeMcpExec;
  /**
   * Repo directory the orchestrator-workflow co-install offer scaffolds
   * into when the operator accepts. Defaults to `process.cwd()` — the repo
   * where `harness init` was invoked. Tests inject a tmp path and assert
   * it reaches the spawn.
   */
  repoDir?: string;
  /**
   * Override the `npx orchestrator-workflow init` runner. Mirrors
   * `installSpawn` / `installPackagesGlobally`'s injectable spawn so tests
   * can fake success / non-zero exit / throw without touching the network.
   */
  owInitSpawn?: InstallOptions["spawn"];
  /**
   * Override the `npm prefix -g` runner used by `init()`'s post-write
   * bin-resolution check (task 325ace29). Mirrors `dependencyPathEnv`:
   * the wizard owns no npm spawn of its own, it just forwards this to
   * `init()`, which already accepts it as `InitOptions.npmBinExec`.
   * Production leaves it undefined and gets the real spawn; tests MUST
   * inject a fake, or the hermetic-spawn guard on `realNpmExec` throws.
   */
  npmBinExec?: NpmExec;
}

export interface InteractiveResult {
  /** True if the operator (or a Ctrl-C / decline) bailed out. No write happened. */
  aborted: boolean;
  /** The init result, if a write happened. */
  init?: InitResult;
  /** The profile the operator chose, if not aborted. */
  profile?: ProfileChoice;
  /** Whether `harness validate` reported zero errors after the write. */
  validateClean?: boolean;
  /**
   * Whether every declared, enabled MCP binary and every REQUIRED CLI
   * binary resolves on PATH (task 7f8fb4bc). `undefined` when this check
   * did not run (validate itself failed first). False does not abort the
   * wizard — the operator may still want to wire runtimes and fix PATH
   * afterward — but the CLI layer surfaces it as a loud, non-zero exit.
   */
  binResolutionClean?: boolean;
  /**
   * Per-runtime apply outcome from the wire-now step. Present when the
   * operator selected at least one runtime in the multiselect (default:
   * every detected runtime is pre-checked). Empty array means the
   * operator unchecked all runtimes — manifest stays on disk, no wiring.
   */
  applies?: RuntimeApplyOutcome[];
  /**
   * Legacy single-runtime shorthand: the claude-code apply outcome, if
   * the wizard wired claude-code this run. Preserved so callers that
   * predate task 696f7560 keep working. New code should read `applies[]`
   * instead.
   */
  apply?: ApplyResult;
}

const DEFAULT_PROMPTS: InteractivePrompts = { select, confirm, input, checkbox };

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /ExitPrompt|aborted|cancel/i.test(err.name) || /force.?closed/i.test(err.message);
}

/**
 * Resolve the harness state root to hand to `init()` / `apply()`.
 *
 * Home-dir semantics, post the v0.24.0 migration: the wizard's own
 * `opts.homeDir` is the operator's `$HOME` (that is how `detect()`
 * consumes it), whereas `init()` and `apply()` treat their `homeDir`
 * argument as the explicit harness state root — both pass it straight
 * to `resolveHomeDir({ homeDir })`. So the wizard must translate
 * `$HOME` → harness root via the same resolver `detect()` now uses, or
 * the wizard and `init()` disagree on where the manifest lives
 * (harness/418cebd4). Returns `undefined` when the wizard has no
 * `homeDir` override (production), letting `init()` / `apply()` resolve
 * from `os.homedir()` themselves — exactly as before.
 */
function harnessHomeArg(opts: RunInteractiveOptions): string | undefined {
  if (opts.homeDir === undefined) return undefined;
  return resolveHomeDir({ userHome: opts.homeDir }).path;
}

function summariseDetection(d: DetectionResult): string {
  const lines: string[] = ["Environment probe:"];
  for (const r of d.runtimes) {
    const status = r.homeExists ? (r.settingsExists ? "configured" : "home only") : "not found";
    lines.push(`  ${r.name.padEnd(12)} ${status} (${r.home})`);
  }
  lines.push(`  manifest    ${d.manifest.exists ? "present" : "absent"} (${d.manifest.path})`);
  if (d.mcpServers.length > 0) {
    lines.push(`  MCP wired   ${d.mcpServers.map((s) => s.name).join(", ")}`);
  } else {
    lines.push(`  MCP wired   (none detected in the Claude Code user-scope registry)`);
  }
  lines.push(`  harness     v${d.harness.version}`);
  return lines.join("\n");
}

function profileNeedsAgentTasks(profile: ProfileChoice): boolean {
  // Full inherits the team layer, including the agent-tasks MCP and
  // the review-before-merge policy, so it has the same Claude-side
  // wiring requirement as Team.
  return profile === "team" || profile === "full";
}

function detectionHasAgentTasks(d: DetectionResult): boolean {
  return d.mcpServers.some((s) => s.name === "agent-tasks");
}

function runtimeIsConfigured(r: DetectedRuntime | undefined): boolean {
  if (!r) return false;
  return r.homeExists || r.settingsExists;
}

interface WireRuntimeOpts {
  runtime: WireableRuntime;
  configPath: string;
  homeDir?: string;
  claudeSettingsPath: string;
  codexConfigPath: string;
  stderr: (s: string) => void;
  /** Test seam for the `claude mcp` CLI exec (task T-002). */
  mcpExec?: ClaudeMcpExec;
}

/**
 * Read `.last-apply` BEFORE `apply()` gets a chance to re-stamp it (task
 * 363a6de0, Reviewer-Finding 2 / D-107). `apply()` overwrites `.last-apply`
 * with the CURRENT manifest's snapshot whenever anything changed —
 * including a combined edit that both removes a `tools.mcp[]` entry AND
 * touches something else (e.g. a hook via a pack) — which would erase the
 * PRE-edit provenance GC's ownership union needs. Malformed JSON or a
 * schema-invalid record (`readLastApply`'s own validation throws for
 * both) degrades to `null` — the same conservative "no snapshot" fallback
 * D-107 already specifies — rather than letting a corrupt file crash
 * wire-now (previously this was read late and only reachable after
 * Ensure succeeded; hoisting it here means a throw would otherwise
 * surface twice, once from the try branch and again from the catch
 * branch's own `wireClaudeMcp` call).
 */
function readPriorLastApply(o: WireRuntimeOpts): LastApplyRecord | null {
  const generatedDir = resolveGeneratedDir({
    ...(o.homeDir !== undefined ? { homeDir: o.homeDir } : {}),
    manifestPath: o.configPath,
  });
  try {
    return readLastApply(generatedDir);
  } catch {
    return null;
  }
}

async function wireRuntime(o: WireRuntimeOpts): Promise<RuntimeApplyOutcome> {
  // Defensive: only claude-code and codex have WIZARD apply paths in
  // v1. opencode's runtime adapter has already SHIPPED (task f34eb233,
  // `harness apply --runtime opencode` works standalone) -- wiring THIS
  // wizard up to call it is tracked separately as installer v1.1 task
  // c5287b80, not built here (MED-F3, batch18 fix-round). The checkbox
  // UI keeps "opencode" disabled, so this branch is unreachable through
  // normal use; the guard fires if the disabled flag is ever removed
  // without wiring the wizard path, instead of silently returning a
  // half-built RuntimeApplyOutcome.
  if (o.runtime !== "claude-code" && o.runtime !== "codex") {
    throw new HarnessExitError(
      `wireRuntime: ${o.runtime} is not a wizard-wirable runtime yet (adapter shipped in f34eb233; wizard wiring tracked in c5287b80)`,
      EX_FAIL,
    );
  }
  if (o.runtime === "claude-code") {
    // D-107 / Reviewer-Finding 2 (task 363a6de0): capture `.last-apply`'s
    // manifest snapshot BEFORE apply() runs. apply() re-stamps
    // `.last-apply` with the CURRENT (already-edited) manifest whenever
    // anything changed — including a combined edit that both removes a
    // `tools.mcp[]` entry AND touches something else (e.g. a hook via a
    // pack). Reading it only after apply() (the pre-fix ordering) would
    // silently erase the very provenance GC's ownership union needs to
    // see a manifest entry that existed just before THIS run.
    const priorLastApply = readPriorLastApply(o);
    // init's wire-now intent is "wire this freshly written manifest"
    // — the operator already confirmed by ticking claude-code in the
    // wire-now checkbox. A pre-existing drift in
    // ~/.claude/harness.generated/settings.json (stale snapshot from
    // a prior harness version, or first apply on this machine with a
    // non-empty settings.json) should not silently make the merge
    // step a no-op. Pass overwriteDrift + auto-confirm so the fresh
    // manifest actually lands. The drift safeguard is appropriate
    // for ad-hoc `harness apply` calls, not for init's canonical
    // "start from scratch" path (agent-tasks/df68b3e6).
    const applyOpts: Parameters<typeof apply>[0] = {
      configPath: o.configPath,
      target: o.claudeSettingsPath,
      merge: true,
      overwriteDrift: true,
      prompt: async () => "yes",
    };
    // `o.homeDir` is already the resolved harness state root (the caller
    // passes `harnessHomeArg(opts)`); `apply()` consumes `homeDir` as
    // that root verbatim. Do NOT re-append `.claude` here.
    if (o.homeDir !== undefined) applyOpts.homeDir = o.homeDir;
    try {
      const r = await apply(applyOpts);
      if (r.targetMergeSummary) o.stderr(`\n${r.targetMergeSummary}\n`);
      if (r.targetWritten || r.targetInSync) {
        // `targetInSync` without `targetWritten` is an idempotent merge:
        // the merged content was byte-identical to the existing
        // settings.json, so apply wrote nothing. That is success — the
        // runtime IS wired — not a failure. Reporting it as a failure
        // (the old `!targetWritten` branch did) sent the operator into a
        // loop of redundant `harness apply` retries.
        const syncNote = r.targetWritten ? "" : " (already in sync)";
        o.stderr(`wired into ${r.targetPath}${syncNote}\n`);
        o.stderr(
          `verify: claude -p "say hi" --settings ${r.targetPath} --output-format stream-json --include-hook-events\n`,
        );
      } else {
        // Outcome was drift-related and overwrite didn't confirm, or
        // apply returned a no-target outcome. Surface why so the
        // operator isn't left guessing why "wired into" never showed.
        const recoveryHint = `harness apply --target ${o.claudeSettingsPath} --merge --overwrite-drift`;
        o.stderr(
          `\nWire-now did not write ${o.claudeSettingsPath} (outcome: ${r.outcome}). Retry manually:\n  ${recoveryHint}\n`,
        );
      }
      for (const hint of r.restartHints) o.stderr(`restart hint: ${hint}\n`);
      const outcome: RuntimeApplyOutcome = { runtime: "claude-code", apply: r };
      if (!r.targetWritten && !r.targetInSync) {
        outcome.recoveryHint = `harness apply --target ${o.claudeSettingsPath} --merge --overwrite-drift`;
      }
      // T-002: MCP registration below is independent of this hooks/
      // settings.json merge — it goes through the `claude mcp` CLI, not
      // through settings.json. Run it regardless of the merge outcome so
      // a hooks-merge hiccup doesn't also withhold MCP wiring.
      await wireClaudeMcp(o, outcome, priorLastApply);
      return outcome;
    } catch (err) {
      // Hermetic guard (task 0d80e969): a real-spawn violation from
      // `wireClaudeMcp`'s FIRST call above (inside this `try`) must
      // never be treated as an ordinary `apply()` failure — this catch
      // otherwise degrades any thrown error to a "Failed to wire ..."
      // warning AND calls `wireClaudeMcp` a SECOND time below, which
      // would both print a misleading message and retry a spawn that
      // must never happen under vitest. Re-throw before any of that.
      if (err instanceof HermeticSpawnViolationError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const recoveryHint = `harness apply --target ${o.claudeSettingsPath} --merge --overwrite-drift`;
      o.stderr(`\nFailed to wire ${o.claudeSettingsPath}: ${message}\n`);
      o.stderr(`Manifest is on disk. To retry the merge manually:\n  ${recoveryHint}\n`);
      const outcome: RuntimeApplyOutcome = { runtime: "claude-code", recoveryHint };
      await wireClaudeMcp(o, outcome, priorLastApply);
      return outcome;
    }
  }
  // Codex path: apply --runtime codex emits harness.generated/codex/config.toml.
  // We deliberately do NOT pass --target: apply rejects --target+codex (see
  // apply.ts) because harness owns harness.generated/, the operator owns
  // ~/.codex/config.toml, and there is no in-place TOML merge yet. We print
  // the exact merge command the operator needs instead.
  const applyOpts: Parameters<typeof apply>[0] = {
    configPath: o.configPath,
    runtime: "codex",
    installCodex: true,
    codexConfigPath: o.codexConfigPath,
  };
  // `o.homeDir` is already the resolved harness state root (see the
  // claude-code branch above); `apply()` takes `homeDir` as that root
  // verbatim. Do NOT re-append `.claude`.
  if (o.homeDir !== undefined) applyOpts.homeDir = o.homeDir;
  try {
    const r = await apply(applyOpts);
    const generatedCodexPath = path.join(r.generatedDir, CODEX_CONFIG_BASENAME);
    o.stderr(`\ncodex config generated at ${generatedCodexPath}\n`);
    if (r.codexConfigInstall?.written) {
      o.stderr(`codex config installed into ${o.codexConfigPath}\n`);
      if (r.codexConfigInstall.backupPath) {
        o.stderr(`backup written to ${r.codexConfigInstall.backupPath}\n`);
      }
    } else {
      o.stderr(`codex config already up to date at ${o.codexConfigPath}\n`);
    }
    for (const hint of r.restartHints) o.stderr(`restart hint: ${hint}\n`);
    const recoveryHint = `harness apply --runtime codex --install --codex-config ${o.codexConfigPath}`;
    return { runtime: "codex", apply: r, recoveryHint };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const recoveryHint = `harness apply --runtime codex --install --codex-config ${o.codexConfigPath}`;
    o.stderr(`\nFailed to generate codex config: ${message}\n`);
    o.stderr(`To retry manually:\n  ${recoveryHint}\n`);
    return { runtime: "codex", recoveryHint };
  }
}

interface DesiredMcpServers {
  manifest: Manifest;
  desired: Record<string, SettingsMcpServer>;
  warnings: string[];
}

/**
 * Reload the effective manifest and translate `tools.mcp[]` into the
 * server-spec shape the `claude mcp` CLI wants (task
 * init-mcp-wiring-claude-code/T-002). Reuses the exact same
 * `buildMcpServers` + `projectGroundingEnv` functions the settings.json
 * projection used to feed into the (now dead) `mcpServers` block —
 * see generate-settings.ts's `GenerateSettingsResult.mcpServers` doc.
 * `harnessHomeDir` is the harness STATE root (`harnessHomeArg(opts)`),
 * not the operator's `$HOME`; `projectGroundingEnv`'s tilde-expansion is
 * deliberately left on its default (`os.homedir()`) here, mirroring
 * `apply.ts`'s own `buildExpectedFiles` call, which never overrides it
 * either.
 *
 * Returns `null` when the manifest can't be reloaded (should not happen
 * right after a successful `init()`, but a hand-edited/deleted manifest
 * between write and this read is possible); callers degrade gracefully.
 */
function loadDesiredMcpServers(
  configPath: string,
  harnessHomeDir: string | undefined,
): DesiredMcpServers | null {
  let manifest: Manifest;
  try {
    manifest = loadManifest({
      configPath,
      ...(harnessHomeDir !== undefined ? { homeDir: harnessHomeDir } : {}),
    }).manifest;
  } catch {
    return null;
  }
  const warnings: string[] = [];
  const desired = buildMcpServers(manifest.tools.mcp, warnings);
  projectGroundingEnv(manifest, desired);
  return { manifest, desired, warnings };
}

/** One `claude mcp add-json --scope user <name> '<json>'` line per desired server, sorted by name. */
function manualAddJsonLines(desired: Record<string, SettingsMcpServer>): string[] {
  return Object.keys(desired)
    .sort()
    .map(
      (name) =>
        `claude mcp add-json --scope user ${name} ${posixSingleQuote(JSON.stringify(desired[name]))}`,
    );
}

/**
 * Extract the mcpServers names a PREVIOUS apply wrote into
 * `harness.generated/settings.json`, from `.last-apply`. Pre-T-002
 * harness versions projected `mcpServers` into that file; a leftover
 * record from one of those versions is the provenance signal the
 * migration step (below) needs to safely strip the matching names out of
 * the live (dead) settings.json block without guessing. Mirrors the
 * equivalent snippet in `apply.ts`'s `--target --merge` provenance
 * handling (kept separate rather than shared: apply.ts's version is
 * private to that module and the two call sites read a different record
 * shape's field, not worth a shared export for ~10 lines).
 */
function priorGeneratedMcpNames(lastApply: LastApplyRecord | null): string[] {
  const content = lastApply?.files[SETTINGS_BASENAME]?.content;
  if (content === undefined) return [];
  try {
    const prior = JSON.parse(content) as Record<string, unknown>;
    const mcp = prior["mcpServers"];
    if (mcp !== null && typeof mcp === "object" && !Array.isArray(mcp)) {
      return Object.keys(mcp as Record<string, unknown>);
    }
  } catch {
    // Corrupt .last-apply record: no provenance names from it; the
    // manifest + DEFAULT_OWNED_MCP_SERVERS sets still apply.
  }
  return [];
}

/**
 * Extract `tools.mcp[]` names from the manifest snapshot `.last-apply`
 * stores (`LastApplyRecord.manifest`, Phase 3 #1) — the effective manifest
 * as of the apply BEFORE this run (see `readPriorLastApply` — the record
 * passed in here is captured before this run's `apply()` re-stamps the
 * file), not necessarily the manifest on disk right now. GC ownership
 * (task 363a6de0, D-107) needs this: a server whose `tools.mcp[]` entry
 * was removed or disabled just before THIS run is still harness-owned,
 * and the CURRENT manifest alone can never surface it — by definition
 * it's gone from there. An older `.last-apply` record (pre-manifest-
 * snapshot, so `.manifest` is absent) or a snapshot that fails to parse
 * both degrade to an EMPTY result — the conservative fallback D-107
 * calls for is to fall back to JUST the current manifest's names (NOT
 * `DEFAULT_OWNED_MCP_SERVERS` — see the D-107 note on `wireClaudeMcp`)
 * rather than guess at this one.
 */
function priorManifestMcpNames(lastApply: LastApplyRecord | null): string[] {
  const content = lastApply?.manifest?.content;
  if (content === undefined) return [];
  try {
    const prior = JSON.parse(content) as { tools?: { mcp?: unknown } };
    const mcp = prior.tools?.mcp;
    if (!Array.isArray(mcp)) return [];
    const names: string[] = [];
    for (const entry of mcp) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string"
      ) {
        names.push((entry as { name: string }).name);
      }
    }
    return names;
  } catch {
    // Corrupt .last-apply record: no provenance names from it; the
    // current manifest's names still apply.
    return [];
  }
}

/**
 * Strip harness-owned names from the dead `mcpServers` block in
 * `o.claudeSettingsPath` (D-002/D-003: only ever called AFTER Ensure has
 * confirmed every desired server is correctly registered via the `claude`
 * CLI). Owned = the current manifest's `tools.mcp[]` names, UNION any
 * names a pre-T-002 harness version generated into settings.json
 * (`.last-apply` provenance), UNION the uninstall module's default
 * ownership set (covers a manifest-less/first-run migration the same way
 * `harness uninstall` already does). Foreign entries (anything outside
 * that union — an operator hand-add, or another tool's MCP server) are
 * left untouched. Writes only when something actually changes.
 *
 * `lastApply` is read once, BEFORE `apply()` runs, by `wireRuntime`
 * (`readPriorLastApply`, task 363a6de0 / D-107) and threaded through
 * `wireClaudeMcp` rather than re-read here — both this function's
 * pre-T-002 provenance check and GC's ownership-union construction need
 * the SAME pre-apply snapshot (apply() re-stamps `.last-apply` with the
 * current manifest whenever anything changed, which would otherwise be
 * read back here as if it were "prior").
 */
function migrateDeadSettingsMcpBlock(
  o: WireRuntimeOpts,
  manifest: Manifest,
  lastApply: LastApplyRecord | null,
): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(o.claudeSettingsPath, "utf8");
  } catch {
    return []; // No settings.json (yet) — nothing to migrate.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    o.stderr(
      `\n⚠ ${o.claudeSettingsPath} is not valid JSON; skipped the dead mcpServers cleanup. Fix the file and re-run \`harness init --interactive\`.\n`,
    );
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const ownedNames = new Set<string>([
    ...manifest.tools.mcp.map((m) => m.name),
    ...priorGeneratedMcpNames(lastApply),
    ...DEFAULT_OWNED_MCP_SERVERS,
  ]);

  const { settings, removedNames } = stripOwnedMcpServers(
    parsed as Record<string, unknown>,
    [...ownedNames],
  );
  if (removedNames.length === 0) return [];
  atomicWriteFile(o.claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return removedNames;
}

/**
 * Register the manifest's `tools.mcp[]` servers with Claude Code's
 * user-scope registry via the `claude mcp` CLI (task
 * init-mcp-wiring-claude-code/T-001/T-002), then — only once every
 * desired server is confirmed correctly registered (D-002) — strip the
 * dead settings.json `mcpServers` block. Mutates `outcome` in place so
 * both the try and catch branches of the caller (the settings.json/hooks
 * apply above) get the same MCP wiring regardless of whether that apply
 * itself succeeded.
 *
 * `claude` CLI missing (`cli-missing`) is NOT a hard failure: the wizard
 * warns, prints copy-pasteable `claude mcp add-json --scope user <name>
 * '<json>'` commands per server, and continues — the manifest is on disk
 * and hooks may already be wired even if MCP isn't yet. Migration is
 * skipped in that case (and for any other incomplete registration) so a
 * still-effective legacy settings.json entry is never removed out from
 * under a server that couldn't be re-registered.
 *
 * Also drives GC (task 363a6de0): `ensureMcpServers`'s `gc` option is
 * given the D-107 ownership union — the current manifest's `tools.mcp[]`
 * names UNION the `tools.mcp[]` names of `priorLastApply` (the
 * `.last-apply` manifest snapshot captured by the caller BEFORE this
 * run's `apply()` ran, see `readPriorLastApply`) — so a server whose
 * manifest entry was removed or disabled since it was last registered
 * gets `claude mcp remove`d. `DEFAULT_OWNED_MCP_SERVERS` is DELIBERATELY
 * NOT part of this union (D-107, reviewer HIGH finding on the original
 * D-103): a server sharing a name with a harness default (grounding-mcp,
 * agent-tasks, codebase-oracle) that the operator registered themselves
 * — outside of, or before, any harness manifest on this machine — must
 * never be GC'd just because it never appears in `desired`; "never in
 * the manifest" is not the same ownership claim as "removed from the
 * manifest". GC reporting is independent of the add/replace gate below —
 * it runs, and is reported, regardless of whether the add/replace pass
 * for `desired` succeeded.
 *
 * `homeDir: claudeHomeDir` below (batch19/T-005, Finding 2 — task
 * fb3e4dce) is the ONLY drift-read/spawn-alignment input this call needs
 * to pass: `ensureMcpServers` itself now derives `configDir` from the
 * SAME `registryPath` it resolves from this `homeDir` and threads it to
 * every real `claude` spawn, so a non-default harness home (`--home`)
 * mutates/reads the same registry file this function's drift comparison
 * used. See `io/claude-mcp.ts`'s module doc for the empirical CLI probe
 * behind this.
 */
async function wireClaudeMcp(
  o: WireRuntimeOpts,
  outcome: RuntimeApplyOutcome,
  priorLastApply: LastApplyRecord | null,
): Promise<void> {
  const loaded = loadDesiredMcpServers(o.configPath, o.homeDir);
  if (loaded === null) {
    o.stderr(
      `\n⚠ Could not reload the manifest to register MCP servers with the claude CLI; skipped.\n`,
    );
    return;
  }
  for (const w of loaded.warnings) o.stderr(`mcp warning: ${w}\n`);

  // D-107: GC eligibility is manifest-provenance-based ONLY — current
  // manifest names ∪ the pre-apply `.last-apply` snapshot's names.
  // DEFAULT_OWNED_MCP_SERVERS is intentionally excluded here (see the
  // function doc above); it remains the ownership source for the
  // read-only paths below (dead-settings-block migration, detection).
  const gcOwnedNames = [
    ...new Set<string>([
      ...loaded.manifest.tools.mcp.map((m) => m.name),
      ...priorManifestMcpNames(priorLastApply),
    ]),
  ];

  const claudeHomeDir = path.dirname(o.claudeSettingsPath);
  const ensureResult = await ensureMcpServers({
    desired: loaded.desired,
    homeDir: claudeHomeDir,
    gc: { ownedNames: gcOwnedNames },
    ...(o.mcpExec ? { exec: o.mcpExec } : {}),
  });
  outcome.mcpEnsure = ensureResult;

  const gcResults = ensureResult.gc?.results ?? [];
  const gcRemoved = gcResults.filter((r) => r.action === "removed");
  const gcSkipped = gcResults.filter((r) => r.action === "skipped");
  if (gcRemoved.length > 0) {
    o.stderr(
      `deregistered ${gcRemoved.length} stale MCP server(s) no longer in the manifest ` +
        `(user scope, claude CLI): ${gcRemoved.map((r) => r.name).join(", ")}\n`,
    );
  }
  if (gcSkipped.length > 0) {
    o.stderr(
      [
        "",
        "⚠ Could not deregister one or more stale MCP server(s) via the `claude` CLI:",
        ...gcSkipped.map((r) => `  ${r.name}: ${r.reason ?? r.remove.message}`),
        "  Remove them yourself:",
        ...manualRemoveLines(gcSkipped.map((r) => r.name)).map((l) => `    ${l}`),
        "",
      ].join("\n"),
    );
  }
  if (ensureResult.gc?.registryReadError) {
    o.stderr(
      "⚠ Could not read the claude CLI user-scope registry to garbage-collect stale MCP " +
        `servers: ${ensureResult.gc.registryReadError}\n`,
    );
  }

  const actionable = ensureResult.results.filter((r) => r.action !== "noop");
  const cliMissing = actionable.some(
    (r) => r.add?.status === "cli-missing" || r.remove?.status === "cli-missing",
  );
  // batch19/T-005, Finding 3: an `add-json` "already exists" outcome
  // counts as OK too, but ONLY when `ensureMcpServers`'s own
  // `claude mcp get` + registry-file-re-read verification (see
  // `addAndVerifyAlreadyExists` in `io/claude-mcp.ts`) confirmed the
  // already-registered spec actually matches `desired` — the manifest's
  // target state holds even though this run's own add-json call didn't
  // register it. An unverified or spec-mismatched already-exists (
  // `verifiedAlreadyExists` absent or `matches: false`) keeps the prior
  // conservative behavior: NOT ok, migration below stays gated.
  const allOk = ensureResult.results.every(
    (r) =>
      r.action === "noop" ||
      ((r.action === "add" || r.action === "replace") &&
        (r.add?.status === "added" ||
          (r.add?.status === "already-exists" && r.verifiedAlreadyExists?.matches === true))),
  );

  if (!allOk) {
    if (cliMissing) {
      o.stderr(
        [
          "",
          "⚠ The `claude` CLI is not on PATH — MCP servers were not registered automatically.",
          "  Install Claude Code, then register the manifest's MCP servers yourself:",
          "",
          ...manualAddJsonLines(
            Object.fromEntries(actionable.map((r) => [r.name, loaded.desired[r.name]!])),
          ).map((l) => `    ${l}`),
          "",
        ].join("\n"),
      );
    } else {
      o.stderr(
        [
          "",
          "⚠ Registering one or more MCP servers with the `claude` CLI failed:",
          ...actionable.map(
            (r) => `  ${r.name}: ${r.add?.message ?? r.remove?.message ?? r.reason ?? r.action}`,
          ),
          "",
        ].join("\n"),
      );
    }
    o.stderr(
      "  Re-run `harness init --interactive` after fixing the issue to finish MCP registration and the settings.json cleanup.\n",
    );
    if (outcome.recoveryHint === undefined) {
      outcome.recoveryHint =
        "re-run `harness init --interactive` to finish registering MCP servers with the claude CLI";
    }
    return; // D-002: migration runs only after every desired server registers successfully.
  }

  if (actionable.length > 0) {
    o.stderr(
      `\nregistered ${actionable.length} MCP server(s) with the claude CLI (user scope): ${actionable
        .map((r) => r.name)
        .join(", ")}\n`,
    );
  }

  const removedNames = migrateDeadSettingsMcpBlock(o, loaded.manifest, priorLastApply);
  if (removedNames.length > 0) {
    outcome.mcpMigrationRemovedNames = removedNames;
    o.stderr(
      `removed ${removedNames.length} dead mcpServers entr${
        removedNames.length === 1 ? "y" : "ies"
      } from ${o.claudeSettingsPath}: ${removedNames.join(", ")}\n`,
    );
  }
}

interface EnsureAgentTasksAuthOpts {
  prompts: InteractivePrompts;
  stderr: (s: string) => void;
  probeSpawn?: ProbeSpawn;
  loginSpawn?: LoginSpawn;
}

/**
 * Post-install auth check for the agent-tasks bridge. Probes the
 * bridge's `status` verb and, when no token is configured, offers the
 * operator a login / signup / skip dialog. Token-validation failures
 * (backend unreachable, expired token) print an informational line and
 * continue, because that case is not actionable from inside the
 * wizard.
 *
 * Returns `aborted:true` only when the operator picks the explicit
 * "create an account first" path; the wizard then exits with a
 * pointer to the signup URL and the re-run command.
 */
async function ensureAgentTasksAuth(
  o: EnsureAgentTasksAuthOpts,
): Promise<{ aborted: boolean }> {
  const probeOpts = o.probeSpawn ? { spawn: o.probeSpawn } : {};
  const probe = await probeAgentTasksAuth(probeOpts);
  if (probe.kind === "ok") {
    o.stderr("✓ agent-tasks token validated against the backend.\n");
    return { aborted: false };
  }
  if (probe.kind === "validation_failed") {
    o.stderr(
      [
        "",
        "⚠ agent-tasks token is stored but the backend rejected it or could not be reached.",
        `  bridge said: ${probe.message}`,
        "  The MCP will load but tool calls will fail until this resolves. Re-check with",
        "  `agent-tasks-mcp-bridge status` once your endpoint is reachable.",
        "",
      ].join("\n"),
    );
    return { aborted: false };
  }
  if (probe.kind === "binary_missing" || probe.kind === "probe_error") {
    o.stderr(
      [
        "",
        `⚠ Could not probe the agent-tasks bridge (${probe.kind}). Skipping the auth check.`,
        "  Run `agent-tasks-mcp-bridge status` manually after the wizard finishes.",
        "",
      ].join("\n"),
    );
    return { aborted: false };
  }
  // probe.kind === "no_token" — actionable dialog.
  o.stderr(
    [
      "",
      "ℹ The agent-tasks MCP is wired but no auth token is configured yet.",
      "  Without a token the MCP loads but every tool call returns an auth error.",
      "",
    ].join("\n"),
  );
  const choice = (await o.prompts.select({
    message: "How would you like to configure agent-tasks auth?",
    choices: [
      {
        name: "Run `agent-tasks-mcp-bridge login` now (recommended)",
        value: "login",
        description: "Interactive login. The bridge prompts for a token and stores it in your OS keychain.",
      },
      {
        name: "Skip: I'll run `agent-tasks-mcp-bridge login` later",
        value: "skip",
        description: "Manifest stays as-is, MCP is non-functional until login runs.",
      },
      {
        name: "Abort wizard: I need to create an agent-tasks account first",
        value: "abort",
        description: "Exit with a pointer to the signup URL and the re-run command. Manifest is NOT written.",
      },
    ],
  })) as "login" | "skip" | "abort";

  if (choice === "abort") {
    o.stderr(
      [
        "",
        "Aborted: create an agent-tasks account first.",
        "  Hosted:      https://agent-tasks.opentriologue.ai",
        "  Self-hosted: https://github.com/LanNguyenSi/agent-tasks",
        "Then re-run: harness init --interactive",
        "",
      ].join("\n"),
    );
    return { aborted: true };
  }

  if (choice === "skip") {
    o.stderr(
      [
        "",
        "Skipped auth setup. Manifest will be written and the MCP wired.",
        "Recover later with: agent-tasks-mcp-bridge login",
        "",
      ].join("\n"),
    );
    return { aborted: false };
  }

  // login path
  const loginOpts = o.loginSpawn ? { spawn: o.loginSpawn } : {};
  const login = await runBridgeLogin(loginOpts);
  if (!login.ok) {
    o.stderr(
      [
        "",
        "⚠ `agent-tasks-mcp-bridge login` did not complete successfully.",
        "  Manifest will be written and the MCP wired; finish the login manually with",
        "  `agent-tasks-mcp-bridge login`.",
        "",
      ].join("\n"),
    );
    return { aborted: false };
  }
  // Re-probe to confirm token now validates.
  const reprobe = await probeAgentTasksAuth(probeOpts);
  if (reprobe.kind === "ok") {
    o.stderr("\n✓ agent-tasks login complete, token validates against the backend.\n\n");
  } else {
    o.stderr(
      [
        "",
        "⚠ Login finished but the follow-up `status` probe did not return ok.",
        `  bridge probe: ${reprobe.kind}`,
        "  The MCP is wired; finish troubleshooting with `agent-tasks-mcp-bridge status`.",
        "",
      ].join("\n"),
    );
  }
  return { aborted: false };
}

/**
 * Default runner for the orchestrator-workflow co-install. Mirrors
 * `dependencies.ts`'s `realSpawn`: streams the child's stderr to the
 * operator's terminal and resolves a structured `{ code, stderr }`
 * instead of rejecting. A spawn `error` (e.g. `npx`/node missing on
 * PATH) resolves `code: 1` rather than throwing, so the caller's
 * graceful-failure path handles a missing toolchain the same as a
 * non-zero exit.
 *
 * Hermetic guard (task 54739002): asserts BEFORE touching
 * `child_process` that we are not running under vitest without a test
 * having injected `owInitSpawn`. See
 * src/runtime/hermetic-spawn-guard.ts for why and the env signal used.
 * The thrown `HermeticSpawnViolationError` is re-thrown past the
 * caller's try/catch (which otherwise degrades a thrown runner to a
 * warning) — see the catch in offerOrchestratorWorkflow below.
 */
function realOwInitSpawn(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  assertNoRealSpawnInTests(
    "npx orchestrator-workflow init",
    "Inject a fake `owInitSpawn` runner in the test instead of exercising the real spawn path.",
  );
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => {
      resolve({ code: 1, stderr: `${stderr}\n${(err as Error).message}` });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

interface OfferOrchestratorWorkflowOpts {
  prompts: InteractivePrompts;
  stderr: (s: string) => void;
  /** Repo to scaffold orchestrator-workflow into (the `init` target dir). */
  repoDir: string;
  /** Test-injectable runner; defaults to a real `npx` spawn. */
  owInitSpawn?: InstallOptions["spawn"];
}

/**
 * Offer to co-install orchestrator-workflow (OW) into the repo after the
 * harness manifest is written. This is harness's install-coupling: the
 * solution-acceptance run-gate reads OW's `.ai/runs/` run files, so a
 * fresh harness works best when OW is scaffolded into the same repo.
 *
 * Trade-off — why `npx orchestrator-workflow init --yes <repoDir>` rather
 * than the alternatives:
 *   - vs. `npm i -g orchestrator-workflow`: OW is a one-shot scaffolder,
 *     not a binary the manifest's hooks shell out to (contrast the
 *     PROFILE_DEPENDENCIES in dependencies.ts, which MUST stay on PATH).
 *     A global install would leave a stale package the operator has to
 *     remember to update; `npx` resolves and runs the LATEST published
 *     kit on demand, so the `.ai/runs/` layout always matches what the
 *     run-gate expects.
 *   - vs. requiring OW to be already present: that would make a fresh
 *     `harness init` fail or nag. OW is OPTIONAL — harness offers it but
 *     never depends on it.
 *
 * Graceful by construction: a declined offer, a missing `npx`, no
 * network, or a non-zero exit only prints a warning plus the manual
 * command. harness init still succeeds — this function never aborts and
 * never mutates the wizard's result.
 */
async function offerOrchestratorWorkflow(o: OfferOrchestratorWorkflowOpts): Promise<void> {
  // Shared decline/skip warning. Used both when the operator explicitly
  // declines the offer AND when they Ctrl-C at it (graceful skip below),
  // so the two read identically. Leads with the same `⚠` glyph and
  // 2-space continuation indent as the failure blocks further down, so
  // all three OW operator-facing warnings are visually consistent.
  const printDeclineWarning = (): void => {
    o.stderr(
      [
        "",
        "⚠ harness works best with orchestrator-workflow: the solution-acceptance run-gate reads its .ai/runs/ run files.",
        "  You can add it later with `npx orchestrator-workflow init`.",
        "",
      ].join("\n"),
    );
  };

  let accept: boolean;
  try {
    accept = await o.prompts.confirm({
      message:
        "Set up orchestrator-workflow in this repo too? Its run files (.ai/runs/) are what the solution-acceptance run-gate reads. (recommended)",
      default: true,
    });
  } catch (err) {
    // This confirm is the LAST prompt of the wizard and sits AFTER the
    // manifest has been written + wired, inside runInteractive's shared
    // try/catch. A Ctrl-C here must NOT propagate to that outer handler:
    // doing so would print the FALSE "no manifest written" abort and
    // return `{aborted:true}`, discarding the already-successful
    // tailResult (validateClean and all). OW is OPTIONAL, so treat a
    // Ctrl-C / ExitPromptError at this trailing offer as a graceful skip:
    // print the same decline warning and return normally, leaving
    // runInteractive to return the unchanged successful tailResult. A
    // non-abort throw still propagates (genuine bug, not an operator
    // cancel).
    if (isAbortError(err)) {
      printDeclineWarning();
      return;
    }
    throw err;
  }
  if (!accept) {
    printDeclineWarning();
    return;
  }

  o.stderr(`\nSetting up orchestrator-workflow: npx orchestrator-workflow init --yes ${o.repoDir}\n`);
  const run = o.owInitSpawn ?? realOwInitSpawn;
  let result: { code: number; stderr: string };
  try {
    result = await run("npx", ["orchestrator-workflow", "init", "--yes", o.repoDir]);
  } catch (err) {
    // Hermetic guard (task 54739002): a real-spawn violation under
    // vitest is NOT an ordinary runner failure — it must propagate past
    // this optional-and-warn handling and fail the test hard, so it is
    // re-thrown here before the generic degrade-to-warning below runs.
    if (err instanceof HermeticSpawnViolationError) throw err;
    // A thrown runner (an injected spawn that rejects, or an unexpected
    // throw) is treated exactly like a non-zero exit: OW is optional, so
    // we warn and continue rather than failing harness init.
    const message = err instanceof Error ? err.message : String(err);
    o.stderr(
      [
        "",
        `⚠ Could not run orchestrator-workflow init (${message}).`,
        "  harness init succeeded; orchestrator-workflow is optional. Add it later with:",
        "  npx orchestrator-workflow init",
        "",
      ].join("\n"),
    );
    return;
  }

  if (result.code === 0) {
    o.stderr("✓ orchestrator-workflow set up; its .ai/ run files are in place.\n");
    return;
  }
  o.stderr(
    [
      "",
      `⚠ orchestrator-workflow init exited ${result.code}.`,
      "  harness init succeeded; orchestrator-workflow is optional. Add it later with:",
      "  npx orchestrator-workflow init",
      "",
    ].join("\n"),
  );
}

export async function runInteractive(
  opts: RunInteractiveOptions = {},
): Promise<InteractiveResult> {
  const prompts = opts.prompts ?? DEFAULT_PROMPTS;
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));

  let detection: DetectionResult;
  try {
    detection = await detect({ ...(opts.homeDir !== undefined && { homeDir: opts.homeDir }) });
  } catch (err) {
    throw new HarnessExitError(
      `detection failed before wizard could start: ${(err as Error).message}`,
      EX_FAIL,
    );
  }

  stderr(`${summariseDetection(detection)}\n\n`);

  try {
    if (detection.manifest.exists && !opts.forceOverwrite) {
      const overwrite = await prompts.confirm({
        message: `A manifest already exists at ${detection.manifest.path}. Overwrite it?`,
        default: false,
      });
      if (!overwrite) {
        stderr("Aborted: existing manifest left untouched.\n");
        return { aborted: true };
      }
    }

    const profile = (await prompts.select({
      message: "Pick a setup profile",
      choices: [
        {
          name: "Solo  (memory-router + understanding-before-execution)",
          value: "solo",
          description: "Standalone. No external accounts required. Single-operator baseline.",
        },
        {
          name: "Team  (Solo + agent-tasks MCP + review-before-merge policy)",
          value: "team",
          description:
            "Requires an agent-tasks account (hosted or self-hosted). Adds the merge gate that blocks PR-merge MCP calls without a review ledger entry. The gate matches the agent-tasks MCP only; gh-CLI PR workflows stay unguarded today.",
        },
        {
          name: "Full (Team + the reference policies wired through harness policy intercept)",
          value: "full",
          description:
            "Requires agent-tasks + @lannguyensi/agent-preflight on PATH. Ships the reference manifest with every example policy (dogfood gate, preflight gates, review-subagent gate). All hooks run through the bundled `harness policy intercept` engine.",
        },
        {
          name: "Custom (advanced, bail out and hand-edit)",
          value: "custom",
          description:
            "Print the install layout and exit. Use this when none of the profiles fit and you plan to author the manifest from scratch.",
        },
      ],
    })) as ProfileChoice;

    if (profile === "custom") {
      return await runCustomProfile({
        detection,
        prompts,
        stderr,
        stdout,
        opts,
      });
    }

    if (profileNeedsAgentTasks(profile) && !detectionHasAgentTasks(detection)) {
      const proceed = await prompts.confirm({
        message:
          "The Team profile wires the agent-tasks MCP via the `agent-tasks-mcp-bridge` binary AND assumes you have an agent-tasks account (hosted or self-hosted). It is not registered with Claude Code yet; the wizard will offer to install missing packages and register it in a moment via the `claude mcp` CLI (user scope). Proceed?",
        default: true,
      });
      if (!proceed) {
        stderr("Aborted: Team profile declined because agent-tasks is not yet wired.\n");
        return { aborted: true, profile };
      }
    }

    // Dependency check + install. Runs before the manifest is written
    // so an `npm i -g` failure leaves no half-installed state behind.
    // The operator decision (2026-05-13) is: abort on install error,
    // surface the npm output, let the user fix npm and re-run init.
    const depResult = checkDependencies(
      profile,
      opts.dependencyPathEnv !== undefined ? { pathEnv: opts.dependencyPathEnv } : {},
    );
    if (depResult.statuses.length > 0) {
      stderr(`\n${formatDependencyTable(profile, depResult)}\n`);
    }
    if (depResult.missingPackages.length > 0) {
      const installNow = await prompts.confirm({
        message: `Install ${depResult.missingPackages.length} missing package(s) with \`npm i -g ${depResult.missingPackages.join(" ")}\`?`,
        default: true,
      });
      if (!installNow) {
        stderr(
          [
            "",
            "Aborted: dependencies missing and install declined.",
            `To install manually: npm i -g ${depResult.missingPackages.join(" ")}`,
            "Then re-run `harness init --interactive`.",
            "",
          ].join("\n"),
        );
        return { aborted: true, profile };
      }
      stderr(`\nRunning npm i -g ${depResult.missingPackages.join(" ")}\n`);
      const installResult = await installPackagesGlobally(
        depResult.missingPackages,
        opts.installSpawn ? { spawn: opts.installSpawn } : {},
      );
      if (!installResult.ok) {
        stderr(
          [
            "",
            `Aborted: npm install exited ${installResult.exitCode}. Manifest NOT written.`,
            "Common fixes: re-run with sudo, switch nvm to a writable node, or check network proxy.",
            `Then re-run: harness init --interactive`,
            "",
          ].join("\n"),
        );
        return { aborted: true, profile };
      }
      stderr(`Installed ${installResult.attempted.length} package(s) successfully.\n`);
    }

    // Auth probe + login dispatcher for the agent-tasks bridge. Runs
    // after a successful (or pre-existing) install of the bridge so
    // the wizard does not declare success when the MCP is wired but
    // unauthenticated.
    const dependsOnAgentTasksBridge = depResult.statuses.some(
      (s) => s.dep.binary === "agent-tasks-mcp-bridge",
    );
    if (dependsOnAgentTasksBridge) {
      const authResult = await ensureAgentTasksAuth({
        prompts,
        stderr,
        ...(opts.authProbeSpawn ? { probeSpawn: opts.authProbeSpawn } : {}),
        ...(opts.authLoginSpawn ? { loginSpawn: opts.authLoginSpawn } : {}),
      });
      if (authResult.aborted) return { aborted: true, profile };
    }

    const defaultMemoryDir = path.join(detection.runtimes[0]?.home ?? "~/.claude", "projects", "{project}", "memory");
    const memoryDir = await prompts.input({
      message: "Memory directory pattern (use {project} for the per-project slug)",
      default: defaultMemoryDir,
    });
    if (memoryDir.trim() === "") {
      stderr("Aborted: memory directory left empty.\n");
      return { aborted: true, profile };
    }

    const confirmWrite = await prompts.confirm({
      message: `Write harness.yaml to ${detection.manifest.path}?`,
      default: true,
    });
    if (!confirmWrite) {
      stderr("Aborted: declined to write manifest.\n");
      return { aborted: true, profile };
    }

    // `custom` returned early above; the remaining values map 1:1 to
    // TemplateName entries that `init()` understands. `harnessHomeArg`
    // translates the wizard's `$HOME`-shaped `opts.homeDir` into the
    // harness state root `init()` expects (see its doc comment). `force`
    // is honored from `--force` (forceOverwrite) as well as from a
    // detected existing manifest, so a re-run with `--force` overwrites
    // without the wizard re-prompting.
    const initOpts: {
      template: "solo" | "team" | "full";
      force: boolean;
      homeDir?: string;
      pathEnv?: string;
      npmBinExec?: NpmExec;
    } = {
      template: profile,
      force: detection.manifest.exists || opts.forceOverwrite === true,
    };
    const homeArg = harnessHomeArg(opts);
    if (homeArg !== undefined) {
      initOpts.homeDir = homeArg;
    }
    // Task 7f8fb4bc: reuse the dependency-check PATH override (when a
    // test supplies one) for `init()`'s own post-write bin-resolution
    // check, so the two checks agree on what's "installed" for this run.
    if (opts.dependencyPathEnv !== undefined) {
      initOpts.pathEnv = opts.dependencyPathEnv;
    }
    // Task 325ace29: same forwarding for the `npm prefix -g` runner, so a
    // test can keep `init()`'s bin-resolution check off the real npm.
    if (opts.npmBinExec !== undefined) {
      initOpts.npmBinExec = opts.npmBinExec;
    }
    const initResult = await init(initOpts);
    stdout(initResult.stdout);

    const tailResult = await runPostInitTail({
      initResult,
      profile,
      detection,
      prompts,
      stderr,
      opts,
    });

    // orchestrator-workflow co-install offer. Only the NON-custom
    // profiles reach here — the custom path returned via
    // runCustomProfile() above — which is intentional: this is the
    // install-coupling for the standard profiles. It runs after the
    // manifest write + wire-now so the harness side is fully set up
    // before we offer its companion run-file scaffolder. OW is OPTIONAL:
    // offerOrchestratorWorkflow() never aborts and never mutates
    // tailResult (see its trade-off + graceful-failure doc).
    await offerOrchestratorWorkflow({
      prompts,
      stderr,
      repoDir: opts.repoDir ?? process.cwd(),
      ...(opts.owInitSpawn ? { owInitSpawn: opts.owInitSpawn } : {}),
    });

    return tailResult;
  } catch (err) {
    // Defense-in-depth (task 54739002): a hermetic-spawn-guard violation
    // must always propagate out of runInteractive as a hard failure.
    // `isAbortError` below already wouldn't match a
    // HermeticSpawnViolationError (it checks for an ExitPromptError/
    // abort-shaped name), so this is belt-and-suspenders against a
    // future change to isAbortError narrowing that behavior by name.
    if (err instanceof HermeticSpawnViolationError) throw err;
    if (isAbortError(err)) {
      stderr("Aborted: Ctrl-C received during prompt; no manifest written.\n");
      return { aborted: true };
    }
    throw err;
  }
}

interface PostInitTailOpts {
  initResult: InitResult;
  profile: ProfileChoice;
  detection: DetectionResult;
  prompts: InteractivePrompts;
  stderr: (s: string) => void;
  opts: RunInteractiveOptions;
}

/**
 * Run the shared tail after the manifest has been written: validate the
 * on-disk file, surface diagnostics, then offer the runtime-multiselect
 * wire-now step. Used by both the named-profile path (Solo / Team /
 * Full) and the Custom-profile composer path (task 31d2fbb5) so they
 * share identical post-init UX.
 */
async function runPostInitTail(t: PostInitTailOpts): Promise<InteractiveResult> {
  const { initResult, profile, detection, prompts, stderr, opts } = t;
  if (initResult.stderr) stderr(initResult.stderr);

  const v = validate({ configPath: initResult.path });
  const validateClean = v.errorCount === 0;
  stderr(`\nharness validate: ${v.errorCount} error(s), ${v.warningCount} warning(s)\n`);
  for (const d of v.diagnostics) {
    stderr(`  [${d.severity}] ${d.path}: ${d.message}\n`);
  }

  if (!validateClean) {
    stderr(`\nValidate reported errors. Fix the manifest before running \`harness apply\`.\n`);
    return { aborted: false, profile, init: initResult, validateClean };
  }

  // Bin-resolution check (task 7f8fb4bc): validate() only checks the
  // manifest's shape, not whether the binaries it declares actually
  // resolve. A binary that installed successfully but landed under a npm
  // global bin dir NOT on PATH (the dogfood incident this task fixes)
  // passes validate cleanly and only used to surface as an opaque
  // `harness doctor` crash later. `init()` itself already ran this check
  // against the just-written manifest (threaded through `pathEnv` above)
  // and folded any findings into `initResult.stderr`, printed at the top
  // of this function — read its verdict here rather than re-running the
  // check a second time with different (test-injection) plumbing.
  const binResolutionClean = initResult.binResolutionErrorCount === 0;

  if (profile === "team" || profile === "full") {
    // Reminder splits at the "Not using agent-tasks?" paragraph because
    // Full ships review-before-merge-bash + review-subagent-before-pr-create-bash
    // (PR #188, v0.20.0) so its `gh pr (merge|create)` Bash calls ARE
    // gated, while Team still matches only the agent-tasks MCP verbs.
    const head = [
      "",
      "ℹ This profile wires the agent-tasks MCP and its review-merge gate.",
      "  Already use agent-tasks? Run `agent-tasks-mcp-bridge login` to store",
      "  a token in your OS keychain (or set AGENT_TASKS_TOKEN). Without a",
      "  token the MCP loads but every tool call returns an auth error.",
      "",
    ];
    const tail =
      profile === "team"
        ? [
            "  Not using agent-tasks? The review-merge gate only matches",
            "  agent-tasks MCP tool names today, not `gh pr` Bash calls. Re-run",
            "  with --template solo to drop the agent-tasks coupling.",
          ]
        : [
            "  Both `mcp__agent-tasks__pull_requests_*` AND `gh pr (merge|create)`",
            "  Bash calls are gated. Tag shape differs: `review:${PR_NUMBER}` for",
            "  the MCP surface, `review:${BRANCH}` for the gh-cli surface. Re-run",
            "  with --template team if you want only the MCP gate, or",
            "  --template solo to drop the agent-tasks coupling.",
          ];
    stderr([...head, ...tail, ""].join("\n"));
  }

  // Validate-clean: offer to wire each runtime right now. A bare
  // `harness init` leaves the manifest on disk but Claude Code / Codex
  // do not see it until `harness apply` runs. The multiselect collapses
  // that trap into one and pre-checks whichever runtimes detect() found
  // configured so the common single-runtime case stays a single Enter
  // press.
  const claudeRuntime = detection.runtimes.find((r) => r.name === "claude-code");
  const codexRuntime = detection.runtimes.find((r) => r.name === "codex");
  const claudeSettingsPath = path.join(
    claudeRuntime?.home ?? path.join(opts.homeDir ?? process.env.HOME ?? "", ".claude"),
    "settings.json",
  );
  const codexConfigPath = path.join(
    codexRuntime?.home ?? path.join(opts.homeDir ?? process.env.HOME ?? "", ".codex"),
    "config.toml",
  );

  const wireChoices: { name: string; value: WireableRuntime; checked: boolean; disabled?: string }[] = [
    {
      name: `claude-code  → merges into ${claudeSettingsPath}`,
      value: "claude-code",
      checked: runtimeIsConfigured(claudeRuntime) || claudeRuntime === undefined,
    },
    {
      name: `codex        → installs harness-managed block into ${codexConfigPath} (with backup)`,
      value: "codex",
      checked: runtimeIsConfigured(codexRuntime),
    },
  ];

  const selectedRuntimes = (await prompts.checkbox({
    message: "Wire harness into which runtimes now? (space to toggle, return to confirm; uncheck all to skip)",
    choices: [
      ...wireChoices,
      // opencode's runtime adapter has SHIPPED (task f34eb233 --
      // `harness apply --runtime opencode` works standalone); wiring
      // THIS checkbox up to call it is tracked separately as installer
      // v1.1 task c5287b80, not built here (MED-F3, batch18 fix-round).
      // Listing it disabled keeps the slot stable so the wizard copy
      // and screenshots do not churn when that wizard wiring lands.
      {
        name: "opencode     (adapter shipped, f34eb233 -- wizard wiring tracked in c5287b80)",
        value: "opencode" as WireableRuntime,
        checked: false,
        disabled: "(adapter shipped; wizard wiring tracked in c5287b80)",
      },
    ],
  })) as WireableRuntime[];

  if (selectedRuntimes.length === 0) {
    // T-002: claude-code wiring is now two independent steps — the
    // settings.json/hooks merge (still `harness apply --target ... --merge`)
    // and MCP registration (via the `claude mcp` CLI, not settings.json;
    // see io/claude-mcp.ts). There is no single non-interactive command for
    // the latter yet, so print the manifest's per-server add-json commands
    // directly — the same manual fallback the wizard itself prints when
    // the `claude` CLI is missing.
    const desiredMcp = loadDesiredMcpServers(initResult.path, harnessHomeArg(opts));
    const mcpLines =
      desiredMcp !== null && Object.keys(desiredMcp.desired).length > 0
        ? manualAddJsonLines(desiredMcp.desired)
        : [];
    stderr(
      [
        "",
        "Manifest written; no runtimes selected for wiring. To wire later:",
        `  claude-code hooks: harness apply --target ${claudeSettingsPath} --merge`,
        ...(mcpLines.length > 0
          ? [
              "  claude-code MCP:   re-run `harness init --interactive` and select claude-code, or run:",
              ...mcpLines.map((l) => `    ${l}`),
            ]
          : []),
        `  codex:       harness apply --runtime codex --install --codex-config ${codexConfigPath}`,
        "",
      ].join("\n"),
    );
    return { aborted: false, profile, init: initResult, validateClean, binResolutionClean, applies: [] };
  }

  if (selectedRuntimes.length > 1) {
    stderr(
      "\nMulti-runtime wiring: harness.lock will reflect the last-applied runtime; re-run `harness apply --runtime <name>` to refresh drift baselines.\n",
    );
  }

  const applies: RuntimeApplyOutcome[] = [];
  for (const runtime of selectedRuntimes) {
    const wireOpts: Parameters<typeof wireRuntime>[0] = {
      runtime,
      configPath: initResult.path,
      claudeSettingsPath,
      codexConfigPath,
      stderr,
    };
    const homeArg = harnessHomeArg(opts);
    if (homeArg !== undefined) wireOpts.homeDir = homeArg;
    if (opts.mcpExec) wireOpts.mcpExec = opts.mcpExec;
    const outcome = await wireRuntime(wireOpts);
    applies.push(outcome);
  }

  const legacyApply = applies.find((a) => a.runtime === "claude-code")?.apply;
  const result: InteractiveResult = {
    aborted: false,
    profile,
    init: initResult,
    validateClean,
    binResolutionClean,
    applies,
  };
  if (legacyApply !== undefined) result.apply = legacyApply;
  return result;
}

interface RunCustomOpts {
  detection: DetectionResult;
  prompts: InteractivePrompts;
  stderr: (s: string) => void;
  stdout: (s: string) => void;
  opts: RunInteractiveOptions;
}

/**
 * Custom-profile à-la-carte builder (task 31d2fbb5). Drives three
 * checkbox prompts (packs / MCPs / policies), feeds them into the
 * composer, then rejoins the shared write + wire-now tail. v1 surface
 * is intentionally a subset of the FULL template; remaining packs,
 * MCPs, and policies are tracked as follow-up.
 */
async function runCustomProfile(rc: RunCustomOpts): Promise<InteractiveResult> {
  const { detection, prompts, stderr, stdout, opts } = rc;
  const profile: ProfileChoice = "custom";

  // Pre-check MCPs whose names appear in detected settings.json
  // mcpServers. Packs and policies have no detection signal today
  // (settings.json doesn't carry them), so they start unchecked and
  // the operator opts in.
  const detectedMcpNames = new Set(detection.mcpServers.map((s) => s.name));
  const detectedHasMemoryRouterDir = (() => {
    // memory.router is structurally not in settings.json mcpServers,
    // so this stays unchecked by default; operators who already have a
    // memory.router config can re-check it in the prompt.
    return false;
  })();

  const packs = (await prompts.checkbox({
    message: "Custom: pick policy packs",
    choices: COMPOSABLE_PACKS.map((p) => ({
      name: `${p.label}  ${p.description}`,
      value: p.key,
      checked: false,
    })),
  })) as CustomPackKey[];

  const mcps = (await prompts.checkbox({
    message: "Custom: pick MCP servers / routers",
    choices: COMPOSABLE_MCPS.map((m) => ({
      name: `${m.label}  ${m.description}`,
      value: m.key,
      checked:
        m.key === "memory-router" ? detectedHasMemoryRouterDir : detectedMcpNames.has(m.key),
    })),
  })) as CustomMcpKey[];

  const policies = (await prompts.checkbox({
    message: "Custom: pick reference policies",
    choices: COMPOSABLE_POLICIES.map((p) => ({
      name: `${p.label}  ${p.description}`,
      value: p.key,
      checked: false,
    })),
  })) as CustomPolicyKey[];

  if (packs.length === 0 && mcps.length === 0 && policies.length === 0) {
    stderr(
      [
        "",
        "Custom: no components selected — nothing to compose. Aborted; no manifest written.",
        "Re-run `harness init --interactive` and pick at least one pack, MCP, or policy.",
        "",
      ].join("\n"),
    );
    return { aborted: true, profile };
  }

  // Dependency check uses the Custom-specific dep resolver. Same install
  // UX as the named-profile path.
  const customDeps = dependenciesForCustom({ packs, mcps, policies });
  const depResult = checkDependencyList(
    customDeps,
    opts.dependencyPathEnv !== undefined ? { pathEnv: opts.dependencyPathEnv } : {},
  );
  if (depResult.statuses.length > 0) {
    stderr(`\n${formatDependencyTable(profile, depResult)}\n`);
  }
  if (depResult.missingPackages.length > 0) {
    const installNow = await prompts.confirm({
      message: `Install ${depResult.missingPackages.length} missing package(s) with \`npm i -g ${depResult.missingPackages.join(" ")}\`?`,
      default: true,
    });
    if (!installNow) {
      stderr(
        [
          "",
          "Aborted: dependencies missing and install declined.",
          `To install manually: npm i -g ${depResult.missingPackages.join(" ")}`,
          "Then re-run `harness init --interactive`.",
          "",
        ].join("\n"),
      );
      return { aborted: true, profile };
    }
    stderr(`\nRunning npm i -g ${depResult.missingPackages.join(" ")}\n`);
    const installResult = await installPackagesGlobally(
      depResult.missingPackages,
      opts.installSpawn ? { spawn: opts.installSpawn } : {},
    );
    if (!installResult.ok) {
      stderr(
        [
          "",
          `Aborted: npm install exited ${installResult.exitCode}. Manifest NOT written.`,
          "Common fixes: re-run with sudo, switch nvm to a writable node, or check network proxy.",
          `Then re-run: harness init --interactive`,
          "",
        ].join("\n"),
      );
      return { aborted: true, profile };
    }
    stderr(`Installed ${installResult.attempted.length} package(s) successfully.\n`);
  }

  // Auth probe for the agent-tasks bridge if the Custom selection
  // pulled it in (same rationale as the named-profile path).
  const customDependsOnAgentTasksBridge = depResult.statuses.some(
    (s) => s.dep.binary === "agent-tasks-mcp-bridge",
  );
  if (customDependsOnAgentTasksBridge) {
    const authResult = await ensureAgentTasksAuth({
      prompts,
      stderr,
      ...(opts.authProbeSpawn ? { probeSpawn: opts.authProbeSpawn } : {}),
      ...(opts.authLoginSpawn ? { loginSpawn: opts.authLoginSpawn } : {}),
    });
    if (authResult.aborted) return { aborted: true, profile };
  }

  const defaultMemoryDir = path.join(
    detection.runtimes[0]?.home ?? "~/.claude",
    "projects",
    "{project}",
    "memory",
  );
  const memoryDir = await prompts.input({
    message: "Memory directory pattern (use {project} for the per-project slug)",
    default: defaultMemoryDir,
  });
  if (memoryDir.trim() === "") {
    stderr("Aborted: memory directory left empty.\n");
    return { aborted: true, profile };
  }

  const selection: CustomSelection = { packs, mcps, policies, memoryDir: memoryDir.trim() };
  const composed = composeCustom(selection);
  for (const w of composed.warnings) {
    stderr(`composer warning: ${w}\n`);
  }

  const confirmWrite = await prompts.confirm({
    message: `Write composed harness.yaml to ${detection.manifest.path}?`,
    default: true,
  });
  if (!confirmWrite) {
    stderr("Aborted: declined to write manifest.\n");
    return { aborted: true, profile };
  }

  const initOpts: {
    content: string;
    contentLabel: string;
    force: boolean;
    homeDir?: string;
    pathEnv?: string;
    npmBinExec?: NpmExec;
  } = {
    content: composed.yaml,
    contentLabel: "custom",
    force: detection.manifest.exists || opts.forceOverwrite === true,
  };
  const homeArg = harnessHomeArg(opts);
  if (homeArg !== undefined) initOpts.homeDir = homeArg;
  // Task 7f8fb4bc: see the named-profile path above for rationale.
  if (opts.dependencyPathEnv !== undefined) initOpts.pathEnv = opts.dependencyPathEnv;
  // Task 325ace29: see the named-profile path above for rationale.
  if (opts.npmBinExec !== undefined) initOpts.npmBinExec = opts.npmBinExec;
  const initResult = await init(initOpts);
  stdout(initResult.stdout);

  return await runPostInitTail({
    initResult,
    profile,
    detection,
    prompts,
    stderr,
    opts,
  });
}
