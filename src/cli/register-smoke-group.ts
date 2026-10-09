import type { Command } from "commander";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
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
}
