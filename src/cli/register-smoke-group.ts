import type { Command } from "commander";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { createCliHelpers } from "./cli-helpers.js";
import { addIdentityOptions, addLedgerTimeoutOption } from "./session-start/shared-options.js";
import {
  formatSmokeReport,
  runSmoke,
  splitCommaList,
  type SmokeExpectations,
  type ExpectDecision,
} from "./smoke/index.js";

export function registerSmokeGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
  const { preflightAction } = createCliHelpers(io);
  program
    .command("smoke")
    .description(
      "Drive `claude -p` end-to-end against the apply'd manifest and assert per --expect-* flags. " +
        "Writes stream.jsonl + stderr.log + settings.json under --output-dir; exits 1 on any expectation miss. " +
        "Replaces the hand-rolled dogfood recipes under dogfood/phase5/.",
    )
    .requiredOption("--prompt <text>", "Prompt fed to claude -p")
    .requiredOption("--output-dir <path>", "Directory for stream.jsonl + stderr.log + settings.json")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--session-id <id>", "session id (default: fresh uuid)")
    .option("--claude-bin <path>", "claude binary (default: $CLAUDE_BIN, then 'claude' on PATH)")
    .option("--timeout-ms <n>", "wall-clock budget in milliseconds (default: 60000)")
    .option(
      "--expect-hook <names>",
      "comma-separated list of hook names / events that MUST fire (repeatable)",
      (value: string, prev: string[] = []) => prev.concat(splitCommaList(value)),
      [] as string[],
    )
    .option(
      "--expect-no-hook <names>",
      "comma-separated list of hook names / events that MUST NOT fire (repeatable)",
      (value: string, prev: string[] = []) => prev.concat(splitCommaList(value)),
      [] as string[],
    )
    .option("--expect-exit <n>", "expected result.is_error: 0 ⇒ false, !=0 ⇒ true")
    .option("--expect-decision <kind>", "policy decision must be one of allow|deny|warn")
    .option(
      "--no-delegate",
      "do not pre-authorize the spawned child (docs/decisions/2026-08-27-ug-auto-mode-approval.md); " +
        "it then has no delegation binding it to this approved session and falls back to the plain opt-in path",
    )
    .action(async (options: {
      prompt: string;
      outputDir: string;
      config?: string;
      project?: string;
      sessionId?: string;
      claudeBin?: string;
      timeoutMs?: string;
      expectHook?: string[];
      expectNoHook?: string[];
      expectExit?: string;
      expectDecision?: string;
      delegate?: boolean;
    }) => {
      const expectations: SmokeExpectations = {};
      if (options.expectHook && options.expectHook.length > 0) {
        expectations.expectHooks = options.expectHook;
      }
      if (options.expectNoHook && options.expectNoHook.length > 0) {
        expectations.expectNoHooks = options.expectNoHook;
      }
      if (options.expectExit !== undefined) {
        const n = Number.parseInt(options.expectExit, 10);
        if (!Number.isFinite(n)) {
          throw new HarnessExitError(
            `harness smoke: --expect-exit must be an integer (got "${options.expectExit}")`,
            EX_USAGE,
          );
        }
        expectations.expectExit = n;
      }
      if (options.expectDecision !== undefined) {
        expectations.expectDecision = options.expectDecision as ExpectDecision;
      }
      const smokeOpts: Parameters<typeof runSmoke>[0] = {
        prompt: options.prompt,
        outputDir: options.outputDir,
        expectations,
      };
      // commander's `--no-delegate` negates `options.delegate` (default
      // true); only an explicit `--no-delegate` flips it to `false`.
      if (options.delegate === false) smokeOpts.noDelegate = true;
      if (options.config) smokeOpts.configPath = options.config;
      if (options.project) smokeOpts.project = options.project;
      if (options.sessionId) smokeOpts.sessionId = options.sessionId;
      if (options.claudeBin) smokeOpts.claudeBin = options.claudeBin;
      if (options.timeoutMs !== undefined) {
        const n = Number.parseInt(options.timeoutMs, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new HarnessExitError(
            `harness smoke: --timeout-ms must be a positive integer`,
            EX_USAGE,
          );
        }
        smokeOpts.timeoutMs = n;
      }
      const result = await runSmoke(smokeOpts);
      stdout(formatSmokeReport(result));
      if (result.exitCode !== 0) {
        throw new HarnessExitError("", result.exitCode);
      }
    });

  // Top-level alias for `harness session-start preflight`, so the
  // policy `ux.run:` field can show the short form the agent should
  // type: `Run: harness preflight`.
  addLedgerTimeoutOption(
    addIdentityOptions(
      program
        .command("preflight")
        .description(
          "Alias for `harness session-start preflight`: run agent-preflight against the session cwd " +
            "and, on a ready:true result, record a `preflight:${REPO}` fact to the evidence ledger. " +
            "Opt-in `session_start_preflight.setup: true` (default off) passes --setup through; " +
            "see docs/CLI.md for the trust and scope caveats.",
        ),
      "explicit session id (overrides stdin event + env)",
    ).option("--timeout <ms>", "agent-preflight subprocess timeout in milliseconds (default 60000)"),
  ).action(preflightAction);
}
