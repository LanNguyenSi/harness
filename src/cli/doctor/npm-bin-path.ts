// Detect whether the npm global bin directory is on PATH. Surfaces the
// nvm-drift footgun where `harness init --interactive` runs `npm i -g`
// against the active Node's prefix, but the operator's shell PATH
// points at a different Node (system-node, a different nvm slot, etc.).
// The install reports success, `npm list -g` confirms the package is
// there, but `harness doctor` later flags every wired binary as
// "not found on PATH" with no hint why.
//
// We resolve the bin dir via `npm prefix -g` (the modern replacement
// for `npm bin -g`, which was removed in npm v9), append the unix
// `/bin` suffix (harness is unix-only per its template paths), then
// check membership in process.env.PATH. Three outcomes:
//   ok       bin dir resolves AND is in PATH
//   warn     bin dir resolves AND is NOT in PATH (the actionable case)
//   unknown  npm not on PATH, prefix command errored, or empty stdout
//
// The unknown branch is deliberately silent in the doctor output: if
// npm itself is missing, every other dep check has already failed
// loudly, and a second "npm is missing" line would be noise.

import { spawn } from "node:child_process";
import * as path from "node:path";

import { assertNoRealSpawnInTests } from "../../runtime/hermetic-spawn-guard.js";

export interface NpmBinReport {
  status: "ok" | "warn" | "unknown";
  /** The resolved global bin dir (e.g. /home/lan/.nvm/.../v22.22.0/bin). Empty on unknown. */
  binDir: string;
  /** The PATH-patch line suggested when status === "warn". Empty otherwise. */
  pathPatchSuggestion: string;
  /** Why we could not resolve, when status === "unknown". Empty on ok/warn. */
  reason: string;
}

export interface NpmExec {
  (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Hermetic guard (task 325ace29): asserts BEFORE touching `child_process`
 * that we are not running under vitest without a test having injected a
 * fake `exec`/`npmBinExec`. See src/runtime/hermetic-spawn-guard.ts for
 * why and the env signal used. `realNpmExec` itself has no try/catch
 * around this call, so the thrown `HermeticSpawnViolationError`
 * propagates directly to the caller — but local "no try/catch here" is
 * not the actual guarantee (the OW guard in src/cli/init/interactive.ts
 * proved a local absence-of-catch argument isn't enough on its own).
 * Backstops verified for this function's call chains:
 *   - `checkNpmBinPath` (this module) has no try/catch around the call.
 *   - doctor's `checkBinResolution` and `doctor()` (both in
 *     src/cli/doctor/index.ts) call `checkNpmBinPath` with no
 *     surrounding try/catch.
 *   - init's `init()` (src/cli/init/index.ts) calls `checkBinResolution`
 *     with no surrounding try/catch.
 *   - `runInteractive`'s outer catch (src/cli/init/interactive.ts, the
 *     handler that otherwise treats a caught error as either an
 *     `isAbortError` Ctrl-C or a rethrow) explicitly re-throws any
 *     `HermeticSpawnViolationError` past every intermediate handler.
 *   - `run()`'s top-level catch (src/cli/index.ts) — which otherwise
 *     degrades ANY thrown error to exit code 70 — explicitly re-throws
 *     `HermeticSpawnViolationError` first (task 325ace29), so a
 *     `harness doctor`/`harness init` CLI invocation never silently
 *     folds a violation into a generic non-zero exit.
 *
 * (Review finding F2, task T-007): a `RunOptions.npmBinExec` seam that
 * would let a CLI-level `run({ argv: [...] })` test inject a fake exec
 * for `init`/`init --interactive` was considered and deliberately NOT
 * added — no test needs it today, and adding an unused seam speculatively
 * would just be more surface to keep honest. Add it if/when a CLI-level
 * `init` test actually needs one.
 */
function realNpmExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  assertNoRealSpawnInTests(
    `${cmd} ${args.join(" ")}`.trim(),
    "Inject a fake `exec` directly (`CheckNpmBinPathOptions.exec`), or a fake `npmBinExec` if " +
      "you're calling a caller that threads one through — `InitOptions.npmBinExec`, " +
      "`DoctorOptions.npmBinExec`, and `RunInteractiveOptions.npmBinExec` all reach this seam. " +
      "None of those are reachable from a CLI-level test that goes through `run({ argv: [...] })`: " +
      "`RunOptions` (src/cli/index.ts) has no `npmBinExec`, and the `doctor`/`init`/`init " +
      "--interactive` action handlers do not thread one through. For `doctor`, pass `--shallow` " +
      "to skip this check entirely; for `init`/`init --interactive` there is no CLI-level seam " +
      "today — call `init()`/`runInteractive()` directly instead of through `run()`.",
  );
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: `spawn failed: ${(err as Error).message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 127, stdout, stderr: `${stderr}\n${(err as Error).message}` });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export interface CheckNpmBinPathOptions {
  /** Override the npm spawn. Tests fake success / failure / specific stdout. */
  exec?: NpmExec;
  /** Override PATH for tests. Defaults to process.env.PATH. */
  pathEnv?: string;
}

export async function checkNpmBinPath(opts: CheckNpmBinPathOptions = {}): Promise<NpmBinReport> {
  const exec = opts.exec ?? realNpmExec;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const { code, stdout, stderr } = await exec("npm", ["prefix", "-g"]);
  if (code !== 0) {
    return {
      status: "unknown",
      binDir: "",
      pathPatchSuggestion: "",
      reason: stderr.trim() || `\`npm prefix -g\` exited ${code}`,
    };
  }
  const prefix = stdout.trim();
  if (prefix === "") {
    return {
      status: "unknown",
      binDir: "",
      pathPatchSuggestion: "",
      reason: "`npm prefix -g` returned empty output",
    };
  }
  const binDir = path.join(prefix, "bin");
  const segments = pathEnv.split(path.delimiter).filter((s) => s !== "");
  const onPath = segments.includes(binDir);
  if (onPath) {
    return { status: "ok", binDir, pathPatchSuggestion: "", reason: "" };
  }
  return {
    status: "warn",
    binDir,
    pathPatchSuggestion: `export PATH="${binDir}:$PATH"`,
    reason: "",
  };
}
