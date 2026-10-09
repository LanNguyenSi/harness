import type { Command } from "commander";
import { approveRisk } from "./approve/risk.js";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";

export function registerApproveGroup(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout } = io;
  // `harness approve`: operator-driven approval verbs. Today only `risk`
  // is implemented; further verbs plug in as sister sub-commands without
  // restructuring this surface.
  const approveCmd = program
    .command("approve")
    .description("Operator-driven approval verbs (writes evidence-ledger tags + flips persisted artefacts)");

  approveCmd
    .command("risk")
    .description(
      "Grant a Risk Gate require_approval decision (default), or deliberately override " +
        "a deny-tier block with --force <reason>. The default path writes the " +
        "risk-approved:${SESSION_ID} ledger tag the production-scoped require_approval " +
        "policy's requires consults; --scope deletion writes " +
        "risk-approved:deletion:${SESSION_ID} instead, for the dev-context deletion arm " +
        "only; --force writes risk-override:${SESSION_ID}:forced:<reason> for the " +
        "deny-tier policy. Operator action.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--project <name>", "apply per-project overrides")
    .option(
      "--session <id>",
      "explicit session id (default: $CLAUDE_CODE_SESSION_ID, then $CLAUDE_SESSION_ID, then $CODEX_SESSION_ID, then staged .pending-approval)",
    )
    .option(
      "--scope <scope>",
      "restrict the ledger tag to one Risk Gate arm instead of the shared production tag; only 'deletion' is recognized (writes risk-approved:deletion:${SESSION_ID} for gate-dev-unsafe-deletion). Omit for the default production-scoped tag. Ignored with --force.",
    )
    .option(
      "--force <reason>",
      "operator-deliberate override of a deny-tier Risk Gate block; writes the risk-override tag with the reason stamped into the audit trail",
    )
    .option(
      "--i-am-the-operator",
      "acknowledge a scripted / non-TTY --force invocation (otherwise refused)",
    )
    .action(
      async (options: {
        config?: string;
        project?: string;
        session?: string;
        scope?: string;
        force?: string;
        iAmTheOperator?: boolean;
      }) => {
        const cliOpts: Parameters<typeof approveRisk>[0] = {};
        if (options.config) cliOpts.configPath = options.config;
        if (options.project) cliOpts.project = options.project;
        if (options.session) cliOpts.session = options.session;
        if (options.scope !== undefined) {
          if (options.scope !== "deletion") {
            throw new HarnessExitError(
              `--scope "${options.scope}" is not recognized; the only supported value is "deletion".`,
              EX_USAGE,
            );
          }
          cliOpts.scope = "deletion";
        }
        if (typeof options.force === "string") {
          const reason = options.force.trim();
          if (reason.length === 0) {
            throw new HarnessExitError(
              "--force requires a non-empty <reason>; the reason is recorded in the audit trail.",
              EX_USAGE,
            );
          }
          cliOpts.force = { reason };
        }
        if (options.iAmTheOperator) cliOpts.iAmTheOperator = true;
        const result = await approveRisk(cliOpts);
        const lines: string[] = [];
        const sourceNote =
          result.sessionSource === "pending-approval"
            ? " (resolved from .pending-approval staged by the gate hook)"
            : result.sessionSource === "env-claude-code"
              ? " (from $CLAUDE_CODE_SESSION_ID)"
              : result.sessionSource === "env-claude"
                ? " (from $CLAUDE_SESSION_ID)"
                : result.sessionSource === "env-codex"
                  ? " (from $CODEX_SESSION_ID)"
                  : "";
        lines.push(`session: ${result.sessionId}${sourceNote}`);
        if (result.ledger.ok) {
          lines.push(`ledger:  ✓ wrote ${result.ledger.tag}`);
          if (result.forced) {
            lines.push(
              "  deny-tier override recorded; the deny-tier Risk Gate policy now passes for this session.",
            );
          } else {
            lines.push(
              "  the Risk Gate require_approval policy now passes for this session.",
            );
          }
        } else {
          lines.push(`ledger:  ✗ FAILED (${result.ledger.reason ?? "unknown"})`);
          if (result.forced) {
            lines.push(
              "  the deny-tier override stays unrecorded; the gate keeps blocking.",
            );
          } else {
            lines.push(
              "  the require_approval gate stays blocked until the tag is recorded.",
            );
          }
        }
        stdout(`${lines.join("\n")}\n`);
      },
    );
}
