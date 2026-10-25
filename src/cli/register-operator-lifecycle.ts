import type { Command } from "commander";
import { EX_FAIL, HarnessExitError } from "./exit-codes.js";
import { migrateHome } from "./migrate-home/index.js";

export function registerOperatorLifecycle(
  program: Command,
  _io: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  program
    .command("migrate-home")
    .description(
      "Move harness operator-state from the legacy ~/.claude/ root to the runtime-neutral " +
        "~/.harness/ root introduced in v0.24.0. Dry-run by default; pass --apply to perform " +
        "the move. Re-running on already-migrated state is a no-op. Moves: harness.yaml, " +
        "harness.generated/, the leftover .understanding-gate/ of the removed " +
        "gate, harness.lock. Does NOT touch settings.json " +
        "or any other ~/.claude/ contents.",
    )
    .option("--apply", "perform the move (default: dry-run report only)")
    .action(async (options: { apply?: boolean }) => {
      const result = migrateHome({ ...(options.apply ? { apply: true } : {}) });
      if (result.outcome === "target-conflict") {
        throw new HarnessExitError("", EX_FAIL);
      }
    });
}
