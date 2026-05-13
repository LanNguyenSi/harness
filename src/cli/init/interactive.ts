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
// - The wizard never invokes `harness apply` itself. It prints the
//   suggested command and lets the operator decide. This is a
//   deliberate scope-cut for v1 (per the task description's
//   out-of-scope list).
// - Acceptance criterion "fresh ~/.claude/ produces a valid harness.yaml":
//   we delegate writing to the existing `init()` so the same atomic
//   write + file-lock + post-write validate path is reused. The wizard
//   is essentially a UI for picking the `--template` value.

import { select, confirm, input } from "@inquirer/prompts";
import * as path from "node:path";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { detect, type DetectionResult } from "./detect.js";
import { init, type InitResult } from "./index.js";
import { validate } from "../validate/index.js";
import { apply, type ApplyResult } from "../apply/index.js";

export type ProfileChoice = "solo" | "team" | "custom";

export interface InteractivePrompts {
  select: typeof select;
  confirm: typeof confirm;
  input: typeof input;
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
  /** Present when the wizard ran the post-write merge-apply step. */
  apply?: ApplyResult;
}

const DEFAULT_PROMPTS: InteractivePrompts = { select, confirm, input };

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
  return profile === "team";
}

function detectionHasAgentTasks(d: DetectionResult): boolean {
  return d.mcpServers.some((s) => s.name === "agent-tasks");
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
          description: "Single-operator baseline. No agent-tasks loop, no merge gate.",
        },
        {
          name: "Team  (Solo + agent-tasks MCP + review-before-merge policy)",
          value: "team",
          description: "Adds the merge gate that blocks PR merges without a review ledger entry.",
        },
        {
          name: "Custom (advanced, bail out and hand-edit)",
          value: "custom",
          description:
            "Print the install layout and exit. Run `harness init --template full` to get the full reference manifest and edit it directly.",
        },
      ],
    })) as ProfileChoice;

    if (profile === "custom") {
      stderr(
        [
          "Custom profile selected. The interactive wizard does not yet build",
          "manifests à la carte. Run `harness init --template full` to land",
          "the full Appendix A manifest, then hand-edit it. Detection results",
          "above tell you what the harness already sees in your environment.",
          "",
        ].join("\n"),
      );
      return { aborted: true, profile };
    }

    if (profileNeedsAgentTasks(profile) && !detectionHasAgentTasks(detection)) {
      const proceed = await prompts.confirm({
        message:
          "The Team profile wires the agent-tasks MCP via the `agent-tasks-mcp-bridge` binary. Claude's settings.json does not yet declare it; the wizard will offer to wire it in a moment via `harness apply --target ~/.claude/settings.json --merge`. Make sure the bridge is installed (`npm i -g @agent-tasks/mcp-bridge`). Proceed?",
        default: true,
      });
      if (!proceed) {
        stderr("Aborted: Team profile declined because agent-tasks is not yet wired.\n");
        return { aborted: true, profile };
      }
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

    // `custom` was handled above with an early return, so the remaining
    // value is one of the two real TemplateName entries.
    //
    // Path semantics are deliberately split: detect() treats `homeDir`
    // as the user's $HOME and synthesizes `.claude` from it, while
    // init() treats `homeDir` as the .claude directory itself. Bridge
    // by passing the .claude path explicitly when the caller overrides
    // homeDir (test scenarios). When unset, both fall back to their own
    // defaults from os.homedir().
    const initOpts: { template: "solo" | "team"; force: boolean; homeDir?: string } = {
      template: profile,
      force: detection.manifest.exists,
    };
    if (opts.homeDir !== undefined) {
      initOpts.homeDir = path.join(opts.homeDir, ".claude");
    }
    const initResult = await init(initOpts);

    if (initResult.stderr) stderr(initResult.stderr);
    stdout(initResult.stdout);

    const v = validate({ configPath: initResult.path });
    const validateClean = v.errorCount === 0;
    stderr(
      `\nharness validate: ${v.errorCount} error(s), ${v.warningCount} warning(s)\n`,
    );
    for (const d of v.diagnostics) {
      stderr(`  [${d.severity}] ${d.path}: ${d.message}\n`);
    }

    if (!validateClean) {
      stderr(
        `\nValidate reported errors. Fix the manifest before running \`harness apply\`.\n`,
      );
      return { aborted: false, profile, init: initResult, validateClean };
    }

    // Validate-clean: offer to wire into Claude Code right now. A bare
    // `harness init` leaves the manifest on disk but Claude Code does
    // not see it until `apply --target ... --merge` runs. Without this
    // prompt the operator gets a clean manifest, runs `harness apply`,
    // sees `harness.generated/` files appear, and is stuck wondering
    // why Claude still does not honour any hooks. Auto-offering the
    // merge here collapses that two-step trap into one.
    const claudeSettingsPath = path.join(
      detection.runtimes.find((r) => r.name === "claude-code")?.home ?? path.join(opts.homeDir ?? process.env.HOME ?? "", ".claude"),
      "settings.json",
    );
    const wireNow = await prompts.confirm({
      message: `Wire into Claude Code now? (merges hooks + mcpServers into ${claudeSettingsPath})`,
      default: true,
    });
    if (!wireNow) {
      stderr(
        `\nManifest written. To wire it into Claude Code later:\n  harness apply --target ${claudeSettingsPath} --merge\n`,
      );
      return { aborted: false, profile, init: initResult, validateClean };
    }

    const applyOpts: Parameters<typeof apply>[0] = {
      configPath: initResult.path,
      target: claudeSettingsPath,
      merge: true,
    };
    if (opts.homeDir !== undefined) {
      applyOpts.homeDir = path.join(opts.homeDir, ".claude");
    }
    // The merge-apply touches a real file under ~/.claude; permission
    // errors and pre-existing malformed JSON both throw from apply().
    // Catch here so a clean manifest write is not undone by a stack
    // trace, and the operator still sees the manual fallback command
    // they need to recover.
    let applyResult: ApplyResult | undefined;
    try {
      applyResult = await apply(applyOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stderr(`\nFailed to wire ${claudeSettingsPath}: ${message}\n`);
      stderr(
        `Manifest is on disk. To retry the merge manually:\n  harness apply --target ${claudeSettingsPath} --merge\n`,
      );
      return { aborted: false, profile, init: initResult, validateClean };
    }
    if (applyResult.targetMergeSummary) {
      stderr(`\n${applyResult.targetMergeSummary}\n`);
    }
    if (applyResult.targetWritten) {
      stderr(`wired into ${applyResult.targetPath}\n`);
      stderr(
        `verify: claude -p "say hi" --settings ${applyResult.targetPath} --output-format stream-json --include-hook-events\n`,
      );
    }
    for (const hint of applyResult.restartHints) {
      stderr(`restart hint: ${hint}\n`);
    }

    return { aborted: false, profile, init: initResult, validateClean, apply: applyResult };
  } catch (err) {
    if (isAbortError(err)) {
      stderr("Aborted: Ctrl-C received during prompt; no manifest written.\n");
      return { aborted: true };
    }
    throw err;
  }
}
