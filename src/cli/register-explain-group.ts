import type { Command } from "commander";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { explain } from "./explain.js";
import { explainAction } from "./explain-action.js";
import { explainPolicy } from "./explain-policy.js";
import { testRisk } from "./test-risk.js";
import { resolveEnv } from "./resolve-env.js";

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

  program
    .command("explain-action <event.json>")
    .description(
      "Risk Gate debug verb (Phase 7): read a tool-event JSON file (the Claude Code PreToolUse hook payload shape: " +
        "{ hook_event_name, tool_name, tool_input, session_id, cwd }) and print the normalized Action Envelope. " +
        "Inspection surface for the envelope that downstream Risk Gate stages consume; does not evaluate policies.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml); read only for a leading `git switch|checkout`")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the envelope as JSON instead of YAML")
    .action((eventPath: string, options: { config?: string; project?: string; json?: boolean }) => {
      const result = explainAction({
        eventPath,
        ...(options.config !== undefined && { configPath: options.config }),
        ...(options.project !== undefined && { project: options.project }),
        ...(options.json === true && { json: true }),
      });
      stdout(result.output);
      if (!result.output.endsWith("\n")) stdout("\n");
    });

  program
    .command("test-risk <event.json>")
    .description(
      "Risk Gate debug verb (Phase 7): read a tool-event JSON file, build its Action Envelope, and classify it " +
        "against the manifest's risk.classifiers[]. Prints the risk profile (severity, categories, reversibility, " +
        "confidence, reasons). An action no pattern matches reports as unclassified, not as safe.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the risk profile as JSON instead of YAML")
    .action(
      (eventPath: string, options: { config?: string; project?: string; json?: boolean }) => {
        const result = testRisk({
          eventPath,
          ...(options.config !== undefined && { configPath: options.config }),
          ...(options.project !== undefined && { project: options.project }),
          ...(options.json === true && { json: true }),
        });
        stdout(result.output);
        if (!result.output.endsWith("\n")) stdout("\n");
      },
    );

  program
    .command("resolve-env <event.json>")
    .description(
      "Risk Gate debug verb (Phase 7): read a tool-event JSON file, build its Action Envelope, and resolve its " +
        "target environment against the manifest's environments.resolvers[] (branch / env-var / kube-context / " +
        "kube-namespace signals). An action no resolver matches resolves to `unknown`, not to a safe default.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the environment resolution as JSON instead of YAML")
    .action(
      (eventPath: string, options: { config?: string; project?: string; json?: boolean }) => {
        const result = resolveEnv({
          eventPath,
          ...(options.config !== undefined && { configPath: options.config }),
          ...(options.project !== undefined && { project: options.project }),
          ...(options.json === true && { json: true }),
        });
        stdout(result.output);
        if (!result.output.endsWith("\n")) stdout("\n");
      },
    );

  program
    .command("explain-policy <policy>")
    .description(
      "Risk Gate debug verb (Phase 7): explain whether <policy> would APPLY to a tool event. " +
        "Reads the event from --event, builds and enriches the Action Envelope, and shows the " +
        "trigger match, the risk classification, the resolved environment, and a per-clause " +
        "`when:` breakdown. Evaluates a hypothetical event live and reads nothing from the " +
        "ledger (use `harness explain <policy> --trace` for the last recorded decision).",
    )
    .requiredOption("--event <event.json>", "path to the tool-event JSON file")
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option("--json", "emit the explanation as JSON instead of YAML")
    .action(
      (
        policyName: string,
        options: {
          event: string;
          config?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        const result = explainPolicy(policyName, {
          eventPath: options.event,
          ...(options.config !== undefined && { configPath: options.config }),
          ...(options.project !== undefined && { project: options.project }),
          ...(options.json === true && { json: true }),
        });
        stdout(result.output);
        if (!result.output.endsWith("\n")) stdout("\n");
      },
    );
}
