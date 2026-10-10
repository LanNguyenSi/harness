import type { Command } from "commander";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { explain } from "./explain.js";

export function registerExplainGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
  const VALID_DECISION_FILTERS = [
    "allow",
    "warn",
    "require_approval",
    "deny",
    "warn-degraded",
    "deny-degraded",
  ] as const;
  type DecisionFilter = (typeof VALID_DECISION_FILTERS)[number];
  const isDecisionFilter = (v: string): v is DecisionFilter =>
    (VALID_DECISION_FILTERS as readonly string[]).includes(v);

  program
    .command("explain [policy]")
    .description("Print a policy's definition; --trace reads the last recorded evaluation; --last traces the most recent decision in the ledger")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit JSON instead of YAML")
    .option("--trace", "include the full decision trail from the most recent evaluation")
    .option("--last", "trace the most recent policy decision in the ledger (any policy); mutually exclusive with <policy>")
    .option("--decision <outcome>", `with --last, restrict to decisions of this outcome (${VALID_DECISION_FILTERS.join(" / ")})`)
    .option("--session <id>", "grounding session whose audit log to read (default: $CLAUDE_SESSION_ID, then 'default')")
    .action(
      async (
        policyName: string | undefined,
        options: {
          config?: string;
          project?: string;
          json?: boolean;
          trace?: boolean;
          last?: boolean;
          decision?: string;
          session?: string;
        },
      ) => {
        if (options.last && policyName !== undefined) {
          throw new HarnessExitError(
            "explain: <policy> and --last are mutually exclusive",
            EX_USAGE,
          );
        }
        if (options.decision !== undefined && !options.last) {
          throw new HarnessExitError(
            "explain: --decision requires --last",
            EX_USAGE,
          );
        }
        if (options.decision !== undefined && !isDecisionFilter(options.decision)) {
          throw new HarnessExitError(
            `explain: --decision must be one of ${VALID_DECISION_FILTERS.join(", ")} (got "${options.decision}")`,
            EX_USAGE,
          );
        }
        const explainOpts: Parameters<typeof explain>[1] = {};
        if (options.config) explainOpts.configPath = options.config;
        if (options.project) explainOpts.project = options.project;
        if (options.json) explainOpts.json = options.json;
        if (options.trace) explainOpts.trace = options.trace;
        if (options.last) explainOpts.last = options.last;
        if (options.decision !== undefined && isDecisionFilter(options.decision)) {
          explainOpts.decisionFilter = options.decision;
        }
        if (options.session) explainOpts.sessionId = options.session;
        const result = await explain(policyName, explainOpts);
        stdout(result.output);
      },
    );
}
