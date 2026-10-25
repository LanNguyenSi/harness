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
        "e.g. Claude Code's session transcripts, stay). Symlinked override layers are never " +
        "moved: a layer file that is a link, and machines/, projects/ or projects/<name> being " +
        "a link, are printed as 'move by hand: <path> (symlink to <target>)' and left " +
        "untouched, and --apply then exits non-zero; once the layer under ~/.harness/ " +
        "resolves, following links, to a regular file the line becomes an 'already at' note " +
        "and no longer fails the run. A top-level item that is itself a link (e.g. " +
        "harness.yaml linked into a dotfiles checkout) is moved as a link, and a relative " +
        "link target may then no longer resolve. A failure before harness.yaml " +
        "moves undoes the run (nothing is changed) and exits non-zero; a failure after it " +
        "leaves a partial state, says what is where and exits non-zero; fix the error and " +
        "re-run --apply. Does NOT touch settings.json or any other ~/.claude/ contents.",
    )
    .option("--apply", "perform the move (default: dry-run report only)")
    .action(async (options: { apply?: boolean }) => {
      const result = migrateHome({ ...(options.apply ? { apply: true } : {}) });
      if (result.outcome === "target-conflict") {
        throw new HarnessExitError("", EX_FAIL);
      }
      if (result.outcome === "rolled-back") {
        throw new HarnessExitError(
          "migrate-home failed and undid its moves; nothing was changed. Fix the error above, then re-run `harness migrate-home --apply`.",
          EX_FAIL,
        );
      }
      if (options.apply && result.outcome === "partial") {
        throw new HarnessExitError(
          "migrate-home stopped part-way (see the lines above for what is where). Fix the error, then re-run `harness migrate-home --apply` to finish.",
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
