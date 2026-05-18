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
import * as path from "node:path";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import {
  detect,
  type DetectionResult,
  type DetectedRuntime,
  type RuntimeName,
} from "./detect.js";
import { init, type InitResult } from "./index.js";
import { validate } from "../validate/index.js";
import { apply, CODEX_CONFIG_BASENAME, type ApplyResult } from "../apply/index.js";
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
 * the runtimes that `harness apply` already supports. `opencode` is
 * surfaced as disabled until the runtime adapter (agent-tasks/f34eb233)
 * lands; including it here keeps the checkbox slot stable so docs and
 * screenshots do not churn when the adapter ships.
 */
export type WireableRuntime = RuntimeName;
export interface RuntimeApplyOutcome {
  runtime: WireableRuntime;
  /** undefined if `apply()` threw — recoveryHint carries the user-facing message. */
  apply?: ApplyResult;
  /** Operator-facing recovery message when apply threw, or the manual merge command for codex. */
  recoveryHint?: string;
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
    lines.push(`  MCP wired   (none detected in Claude settings.json)`);
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
}

async function wireRuntime(o: WireRuntimeOpts): Promise<RuntimeApplyOutcome> {
  // Defensive: only claude-code and codex have apply paths in v1. The
  // checkbox UI disables "opencode" until task f34eb233 lands, so this
  // branch is unreachable through normal use; the guard fires if the
  // disabled flag is ever removed without wiring an adapter, instead of
  // silently returning a half-built RuntimeApplyOutcome.
  if (o.runtime !== "claude-code" && o.runtime !== "codex") {
    throw new HarnessExitError(
      `wireRuntime: ${o.runtime} is not a wirable runtime in this harness build`,
      EX_FAIL,
    );
  }
  if (o.runtime === "claude-code") {
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
    if (o.homeDir !== undefined) applyOpts.homeDir = path.join(o.homeDir, ".claude");
    try {
      const r = await apply(applyOpts);
      if (r.targetMergeSummary) o.stderr(`\n${r.targetMergeSummary}\n`);
      if (r.targetWritten) {
        o.stderr(`wired into ${r.targetPath}\n`);
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
      if (!r.targetWritten) {
        outcome.recoveryHint = `harness apply --target ${o.claudeSettingsPath} --merge --overwrite-drift`;
      }
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recoveryHint = `harness apply --target ${o.claudeSettingsPath} --merge --overwrite-drift`;
      o.stderr(`\nFailed to wire ${o.claudeSettingsPath}: ${message}\n`);
      o.stderr(`Manifest is on disk. To retry the merge manually:\n  ${recoveryHint}\n`);
      return { runtime: "claude-code", recoveryHint };
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
  };
  if (o.homeDir !== undefined) applyOpts.homeDir = path.join(o.homeDir, ".claude");
  try {
    const r = await apply(applyOpts);
    const generatedCodexPath = path.join(r.generatedDir, CODEX_CONFIG_BASENAME);
    o.stderr(`\ncodex config generated at ${generatedCodexPath}\n`);
    o.stderr(
      `To activate: copy or include those [[hooks.*]] entries into ${o.codexConfigPath}\n`,
    );
    for (const hint of r.restartHints) o.stderr(`restart hint: ${hint}\n`);
    const recoveryHint = `merge ${generatedCodexPath} into ${o.codexConfigPath}`;
    return { runtime: "codex", apply: r, recoveryHint };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const recoveryHint = `harness apply --runtime codex   # then merge harness.generated/codex/config.toml into ${o.codexConfigPath}`;
    o.stderr(`\nFailed to generate codex config: ${message}\n`);
    o.stderr(`To retry manually:\n  ${recoveryHint}\n`);
    return { runtime: "codex", recoveryHint };
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
          "The Team profile wires the agent-tasks MCP via the `agent-tasks-mcp-bridge` binary AND assumes you have an agent-tasks account (hosted or self-hosted). Claude's settings.json does not yet declare the MCP; the wizard will offer to install missing packages and wire it in a moment via `harness apply --target ~/.claude/settings.json --merge`. Proceed?",
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
    // TemplateName entries that `init()` understands.
    //
    // Path semantics are deliberately split: detect() treats `homeDir`
    // as the user's $HOME and synthesizes `.claude` from it, while
    // init() treats `homeDir` as the .claude directory itself. Bridge
    // by passing the .claude path explicitly when the caller overrides
    // homeDir (test scenarios). When unset, both fall back to their own
    // defaults from os.homedir().
    const initOpts: { template: "solo" | "team" | "full"; force: boolean; homeDir?: string } = {
      template: profile,
      force: detection.manifest.exists,
    };
    if (opts.homeDir !== undefined) {
      initOpts.homeDir = path.join(opts.homeDir, ".claude");
    }
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
  } catch (err) {
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
      name: `codex        → writes harness.generated/codex/config.toml, you merge into ${codexConfigPath}`,
      value: "codex",
      checked: runtimeIsConfigured(codexRuntime),
    },
  ];

  const selectedRuntimes = (await prompts.checkbox({
    message: "Wire harness into which runtimes now? (space to toggle, return to confirm; uncheck all to skip)",
    choices: [
      ...wireChoices,
      // opencode is parked until the runtime adapter (task f34eb233)
      // lands. Listing it disabled keeps the slot stable so the wizard
      // copy and screenshots do not churn when v1.1 enables it.
      {
        name: "opencode     (shipping in harness v1.1 — adapter task f34eb233)",
        value: "opencode" as WireableRuntime,
        checked: false,
        disabled: "(disabled until f34eb233 lands)",
      },
    ],
  })) as WireableRuntime[];

  if (selectedRuntimes.length === 0) {
    stderr(
      [
        "",
        "Manifest written; no runtimes selected for wiring. To wire later:",
        `  claude-code: harness apply --target ${claudeSettingsPath} --merge`,
        `  codex:       harness apply --runtime codex   # then merge harness.generated/codex/config.toml into ${codexConfigPath}`,
        "",
      ].join("\n"),
    );
    return { aborted: false, profile, init: initResult, validateClean, applies: [] };
  }

  if (selectedRuntimes.length > 1) {
    stderr(
      "\nMulti-runtime wiring: harness.lock will reflect the last-applied runtime; re-run `harness apply --runtime <name>` to refresh drift baselines.\n",
    );
  }

  const applies: RuntimeApplyOutcome[] = [];
  for (const runtime of selectedRuntimes) {
    const outcome = await wireRuntime({
      runtime,
      configPath: initResult.path,
      homeDir: opts.homeDir,
      claudeSettingsPath,
      codexConfigPath,
      stderr,
    });
    applies.push(outcome);
  }

  const legacyApply = applies.find((a) => a.runtime === "claude-code")?.apply;
  const result: InteractiveResult = {
    aborted: false,
    profile,
    init: initResult,
    validateClean,
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

  const initOpts: { content: string; contentLabel: string; force: boolean; homeDir?: string } = {
    content: composed.yaml,
    contentLabel: "custom",
    force: detection.manifest.exists,
  };
  if (opts.homeDir !== undefined) initOpts.homeDir = path.join(opts.homeDir, ".claude");
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
