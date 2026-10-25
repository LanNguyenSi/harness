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
        "gate, harness.lock, and the override layers file by file " +
        "(machines/<discriminator>.harness.overrides.yaml, " +
        "projects/<name>/harness.overrides.yaml; other files in those directories, " +
        "e.g. Claude Code's session transcripts, stay). A layer behind a symlink " +
        "(machines/, projects/ or projects/<name> being a link, or a layer link that " +
        "would no longer resolve) is not moved: the command prints 'move by hand' lines " +
        "and exits non-zero. A partial run also exits non-zero; fix the error and re-run " +
        "--apply. Does NOT touch settings.json or any other ~/.claude/ contents.",
    )
    .option("--apply", "perform the move (default: dry-run report only)")
    .action(async (options: { apply?: boolean }) => {
      const result = migrateHome({ ...(options.apply ? { apply: true } : {}) });
      if (result.outcome === "target-conflict") {
        throw new HarnessExitError("", EX_FAIL);
      }
      if (options.apply && result.outcome === "partial") {
        throw new HarnessExitError(
          "migrate-home stopped part-way. Fix the error above, then re-run `harness migrate-home --apply` to finish.",
          EX_FAIL,
        );
      }
      if (options.apply && result.manual.length > 0) {
        throw new HarnessExitError(
          "migrate-home left override layers that must be moved by hand (see the `move by hand` lines above). Move them, then re-run `harness migrate-home --apply`.",
          EX_FAIL,
        );
      }
    });
}
