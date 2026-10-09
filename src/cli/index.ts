import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { HermeticSpawnViolationError } from "../runtime/hermetic-spawn-guard.js";

// Production version probe for `harness doctor`: synchronous --version
// invocation with a 5s timeout. Tests inject their own probe; the CLI
// entrypoint wires this default. Same shape as `cli/doctor/codex.ts`.
export function defaultVersionProbe(cmd: readonly string[]): string | null {
  if (cmd.length === 0) return null;
  try {
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return null;
    return (result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}
import type { RogueLedgerScanOptions } from "./doctor/rogue-ledger.js";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { VERSION } from "../version.js";
import { registerRemove } from "./remove/register.js";
import { registerAuditGroup } from "./register-audit-group.js";
import { registerUninstall } from "./uninstall/register.js";
import { registerOperatorLifecycle } from "./register-operator-lifecycle.js";
import { registerInspectGroup } from "./register-inspect-group.js";
import { registerSetupGroup } from "./register-setup-group.js";
import { registerPackGroup } from "./register-pack-group.js";
import { registerApproveGroup } from "./register-approve-group.js";
import { registerExplainGroup } from "./register-explain-group.js";
import { registerSmokeGroup } from "./register-smoke-group.js";
import { registerRecordSessionGroup } from "./register-record-session-group.js";
import { registerGateGcGroup } from "./register-gate-gc-group.js";
import { registerPolicyGroup } from "./register-policy-group.js";

export interface RunOptions {
  argv?: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /**
   * Test-injection knob for `harness doctor --rm-rogue-ledgers`. When set,
   * both the initial scan (forwarded to `doctor()`) and the post-deletion
   * re-scan use these options instead of the runtime `os.homedir()` /
   * `process.cwd()` defaults. This makes the re-scan fully hermetic in unit
   * tests without spawning real filesystem side-effects.
   */
  rogueLedgerScanOptions?: Partial<RogueLedgerScanOptions>;
}

export function buildProgram(opts: RunOptions = {}): Command {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const program = new Command();
  program
    .name("harness")
    .description("Declarative control plane for agent harnesses")
    .version(VERSION)
    .configureOutput({
      writeOut: stdout,
      writeErr: stderr,
    })
    .exitOverride((err) => {
      // Commander exits with code 0 + writes the help/version text itself for
      // --help and --version. Suppress our re-throw on those so we don't get
      // a duplicate stderr line + a non-zero exit on a successful display.
      if (err.exitCode === 0) {
        throw new HarnessExitError("", 0);
      }
      // unknownOption / unknownCommand / missingArgument exit 1 by default.
      // Map them to EX_USAGE per ARCHITECTURE §9 sysexits, and pass empty
      // message because Commander already wrote the human-readable text.
      const code = err.exitCode === 1 ? EX_USAGE : (err.exitCode ?? EX_USAGE);
      throw new HarnessExitError("", code);
    });

  registerInspectGroup(program, { stdout, stderr }, opts);

  registerSetupGroup(program, { stdout, stderr });

  registerRemove(program, { stdout, stderr });

  registerPackGroup(program, { stdout, stderr });

  registerApproveGroup(program, { stdout, stderr });

  registerExplainGroup(program, { stdout, stderr });

  registerAuditGroup(program, { stdout, stderr });

  registerSmokeGroup(program, { stdout, stderr });

  registerRecordSessionGroup(program, { stdout, stderr });

  registerGateGcGroup(program, { stdout, stderr });

  registerUninstall(program, { stdout, stderr });

  registerOperatorLifecycle(program, { stdout, stderr });

  registerPolicyGroup(program, { stdout, stderr });

  return program;
}

export async function run(opts: RunOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2);
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const program = buildProgram(opts);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    // Defense-in-depth (task 325ace29): a hermetic-spawn-guard violation
    // must always propagate out of run() as a hard failure, never be
    // folded into the generic "return 70" branch below. Without this,
    // any test that merely asserts "exit code != 0" (rather than the
    // specific message) would mask a future real spawn slipping past a
    // guarded call site. This is production-neutral: the guard
    // (src/runtime/hermetic-spawn-guard.ts) only ever throws when
    // `process.env.VITEST` is set, which a real, standalone `harness`
    // invocation never has — so this branch is unreachable outside of
    // vitest and changes no production behavior.
    if (err instanceof HermeticSpawnViolationError) throw err;
    if (err instanceof HarnessExitError) {
      if (err.exitCode !== 0 && err.message) stderr(`${err.message}\n`);
      return err.exitCode;
    }
    stderr(`${(err as Error).message ?? err}\n`);
    return 70;
  }
}
