import type { Command } from "commander";
import { isRemoveType, KNOWN_REMOVE_TYPES, remove } from "./index.js";
import { EX_USAGE, HarnessExitError } from "../exit-codes.js";

export function registerRemove(
  program: Command,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  const { stdout, stderr } = io;
  program
    .command("remove <type> <name>")
    .description(
      `Remove an entry by name. <type> is one of ${KNOWN_REMOVE_TYPES.join(" | ")}. ` +
        "Refuses to remove a hook still referenced by a policy unless --force.",
    )
    .option("--config <path>", "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)")
    .option("--dry-run", "print the unified diff and exit without writing")
    .option(
      "--force",
      "remove even if a policy references this entry (dangling policy.hook is then caught by schema)",
    )
    .action(
      async (
        type: string,
        name: string,
        options: { config?: string; dryRun?: boolean; force?: boolean },
      ) => {
        if (!isRemoveType(type)) {
          throw new HarnessExitError(
            `unknown remove type "${type}"; expected one of ${KNOWN_REMOVE_TYPES.join(", ")}`,
            EX_USAGE,
          );
        }
        const result = await remove(type, name, {
          configPath: options.config,
          dryRun: options.dryRun,
          force: options.force,
        });
        if (result.forcedReferences.length > 0) {
          stderr(
            `(forced removal — referenced by: ${result.forcedReferences.join(", ")})\n`,
          );
        }
        if (options.dryRun) {
          stdout(result.diff);
          return;
        }
        stdout(`removed ${result.type} ${JSON.stringify(result.name)} from ${result.path}\n`);
      },
    );
}
