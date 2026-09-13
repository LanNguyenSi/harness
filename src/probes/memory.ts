import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseProbedVersion, compareVersionFloor } from "../io/version-compare.js";
import { isValidProjectName } from "../runtime/git-context.js";
import type { Manifest } from "../schema/index.js";

export interface StaleMemory {
  path: string;
  lastTouched: Date;
  ageDays: number;
}

/**
 * Optional `min_version` probe for the memory router. Same shape as
 * `McpVersionReport`; populated only when the router declares
 * `min_version`. Skipped when the router is disabled or its executable
 * could not be located.
 */
export interface RouterVersionReport {
  status: "ok" | "warn";
  message: string;
}

export interface MemoryReport {
  /**
   * `unresolved: true` marks an entry that still contains a placeholder
   * (e.g. `{project}`) because no project context was provided to the
   * probe. The doctor renders these as informational notes instead of
   * "missing", since the real directory only exists per-project.
   */
  directories: Array<{ path: string; scope: string; exists: boolean; unresolved?: boolean }>;
  /**
   * The `opts.project` value the caller supplied, when it failed
   * `isValidProjectName` at `substituteProject`'s sink (task `e904f25a`):
   * `null` when no project was supplied, or when the supplied one was
   * valid. Distinguishes "operator passed `--project` and it was rejected
   * as an unsafe path segment" from the ordinary "no project supplied"
   * case, both of which otherwise produce the same `unresolved: true`
   * directory entries above; `doctor` uses `projectRejectionWarns` below
   * (this value AND at least one such directory) to decide whether to
   * render a warning instead of the informational "resolved per-project
   * at runtime" note; `list` carries this value as a row field regardless.
   * Carries the RAW operator value, which is by definition unvalidated:
   * a name is rejected precisely BECAUSE it escapes a path segment or
   * carries a control character, so this field can hold a newline or an
   * ANSI escape. Every site that renders or serializes it passes it
   * through `sanitizeProjectForDisplay` (`src/runtime/git-context.ts`)
   * first. Nothing downstream of a name that was ACCEPTED needs the same
   * treatment: `isValidProjectName` rejects control characters at the
   * source, so an accepted name (and any path it was substituted into)
   * is already a plain single-line string.
   */
  projectRejected: string | null;
  routerExecutable: { path: string; exists: boolean } | null;
  routerVersion?: RouterVersionReport;
  staleMemories: StaleMemory[];
}

export interface MemoryOptions {
  homeDir?: string;
  project?: string;
  now?: Date;
  /**
   * Override `process.env.PATH` for the router-executable lookup. Tests
   * use this to assert the bare-name-on-PATH branch without leaking the
   * host's real PATH into the assertion surface.
   */
  pathEnv?: string;
  /**
   * Optional probe for the memory router's `min_version` check. Tests
   * inject a deterministic stub; `harness doctor` wires a real
   * spawnSync probe at CLI invocation. Returning `null` is treated as
   * "version probe failed" and emits a warn line.
   */
  versionProbe?: (cmd: readonly string[]) => string | null;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Substitutes an operator-supplied `--project` value into the `{project}`
 * placeholder found in `manifest.memory.directories[].path`, AFTER the
 * caller has already run the path through `expandHome`. Guarded with the
 * same `isValidProjectName` check `resolvePaths` applies at its own sink
 * (`src/cli/loader.ts`, task `1c4eb3ea`): an invalid name (`".."`, a name
 * containing a path separator, a name containing a control character,
 * etc.) degrades to the "no project supplied" branch instead of being
 * interpolated. The `{project}` literal then survives substitution and is
 * reported as `unresolved: true` by the caller below, the same
 * informational path an absent `opts.project` already takes.
 *
 * Three properties this guard actually gives, no more: (1) an invalid name
 * never reaches the placeholder at all, so it cannot introduce a `..`
 * segment or a path separator into the manifest path; (2) the same
 * rejection keeps a control character out of the SUBSTITUTED path, so the
 * surfaces that render that path rather than the name (`harness doctor`'s
 * "memory directory missing" line, `harness list memories`' `path` row
 * field) cannot be made to carry a forged line by a name that passed
 * validation; (3) substitution
 * uses `String.prototype.split`/`join` (the same literal idiom
 * `src/io/harness-lock.ts` and `src/cli/apply/generate-memory-index.ts`
 * already use for the SAME placeholder), never `String.prototype.replace`
 * with a regex, so a project value containing a `$`-prefixed
 * replacement pattern (`$'`, `` $` ``, `$&`) is inserted literally instead
 * of being interpreted as a reference into the surrounding string. It
 * does NOT independently re-validate the result against the filesystem;
 * a valid-looking name can still name a directory that does not exist
 * (the caller's `fs.existsSync` handles that separately). Because the
 * caller expands `~` BEFORE calling this function, a project value of
 * `~` (which `isValidProjectName` allows: it contains no separator) is
 * inserted as an inert literal segment, never re-interpreted as a home
 * directory reference. This sink is NOT guarded for
 * `generate-memory-index.ts`'s own `{project}` substitution
 * (`src/cli/apply/generate-memory-index.ts`) or `buildLockEntries`'
 * (`src/io/harness-lock.ts`); see CHANGELOG.md for the reservation on the
 * former and the follow-up on the latter.
 */
function substituteProject(p: string, project: string | undefined): string {
  if (!project || !isValidProjectName(project)) return p;
  return p.split("{project}").join(project);
}

/**
 * True only when a rejected `--project` value should actually be surfaced
 * as a warning: `report.projectRejected` is set AND at least one memory
 * directory still carries the unresolved `{project}` placeholder. A
 * manifest with no `{project}`-templated directory at all has nothing for
 * the rejected value to have affected, so it stays silent rather than
 * warning about a substitution that was never going to happen. Shared by
 * `harness doctor` (`src/cli/doctor/format.ts`, `src/cli/doctor/index.ts`'s
 * `warningCount`) so both compute the same predicate instead of two
 * hand-written copies drifting apart (task `e904f25a`).
 */
export function projectRejectionWarns(report: MemoryReport): boolean {
  return report.projectRejected !== null && report.directories.some((d) => d.unresolved);
}

function findMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stack: string[] = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  return out;
}

export function inspectMemory(manifest: Manifest, opts: MemoryOptions = {}): MemoryReport {
  const home = opts.homeDir ?? os.homedir();
  const now = opts.now ?? new Date();
  const stalenessDays = manifest.memory.retention.staleness_days;
  const cutoffMs = now.getTime() - stalenessDays * 86400000;

  // `opts.project` supplied but rejected by `isValidProjectName`: distinct
  // from "no project supplied" (see `MemoryReport.projectRejected`'s doc
  // comment). Computed once, independent of any one directory's path.
  // The falsy check (not `!== undefined`) matches `substituteProject`'s own
  // `!project` branch below, so an empty-string `--project` is "not
  // supplied" in both places instead of "supplied and rejected" here but
  // "not supplied" there (task `e904f25a`).
  const projectRejected = opts.project
    ? isValidProjectName(opts.project)
      ? null
      : opts.project
    : null;

  const directories: MemoryReport["directories"] = manifest.memory.directories.map((d) => {
    // `~` is expanded BEFORE `{project}` is substituted so an operator
    // project value that itself looks like `~` (or starts with `~/`)
    // never gets re-interpreted as a home-directory reference: only the
    // manifest's own leading `~` is ever expanded.
    const expanded = expandHome(d.path, home);
    const substituted = substituteProject(expanded, opts.project);
    const unresolved = substituted.includes("{project}");
    return {
      path: substituted,
      scope: d.scope,
      // An entry with an unresolved placeholder is a pattern, not a
      // concrete path; existence is not meaningful and the doctor
      // should not flag it as missing.
      exists: unresolved ? true : fs.existsSync(substituted),
      ...(unresolved ? { unresolved: true } : {}),
    };
  });

  let routerExecutable: MemoryReport["routerExecutable"] = null;
  if (manifest.memory.router) {
    const cmd = manifest.memory.router.command;
    // For `[node, /abs/script.js]` shapes the original cmd[0]="node" is
    // useless: the meaningful executable is the script path. Prefer the
    // first absolute / tilde-prefixed argument, then fall back to the
    // first arg that is not an interpreter wrapper. Without this guard
    // the PATH walk below would happily resolve "node" / "npx" / "bun"
    // and report the router as installed even when the actual script is
    // missing.
    const isWrapper = (s: string): boolean =>
      s === "node" || s === "npx" || s === "bun" || s === "deno" || s === "ts-node" || s === "tsx";
    const scriptPath =
      cmd.find((arg) => path.isAbsolute(arg) || arg.startsWith("~/")) ??
      cmd.find((arg) => !isWrapper(arg)) ??
      cmd[0];
    if (scriptPath) {
      // Two shapes are supported in the manifest: an absolute or
      // tilde-prefixed file path (legacy, `node /abs/router.js`) and a
      // bare bin name on PATH (current, `memory-router-user-prompt-submit`).
      // For the bare-name case we replicate the PATH walk that the
      // doctor uses for `tools.cli` entries so a published bin counts
      // as "found".
      if (path.isAbsolute(scriptPath) || scriptPath.startsWith("~/")) {
        const candidate = expandHome(scriptPath, home);
        routerExecutable = { path: candidate, exists: fs.existsSync(candidate) };
      } else {
        const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
        let resolved: string | null = null;
        for (const seg of pathEnv.split(path.delimiter)) {
          if (!seg) continue;
          const candidate = path.join(seg, scriptPath);
          if (fs.existsSync(candidate)) {
            resolved = candidate;
            break;
          }
        }
        routerExecutable = resolved
          ? { path: resolved, exists: true }
          : { path: scriptPath, exists: false };
      }
    }
  }

  // Optional min_version probe for memory.router. Mirrors the
  // `tools.mcp[]` version-check contract: skipped when no min_version
  // declared, when router is disabled, or when the executable isn't
  // located. Outdated emits `warn`, not `error` (the router still
  // runs; the warning is informational).
  let routerVersion: RouterVersionReport | undefined;
  if (
    manifest.memory.router &&
    manifest.memory.router.enabled !== false &&
    manifest.memory.router.min_version &&
    routerExecutable?.exists
  ) {
    const probe = opts.versionProbe ?? (() => null);
    const minVersion = manifest.memory.router.min_version;
    const cmd = manifest.memory.router.command;
    const versionCmd = manifest.memory.router.version_command ?? [
      routerExecutable.path,
      ...cmd.slice(1),
      "--version",
    ];
    const stdout = probe(versionCmd);
    if (stdout === null) {
      routerVersion = {
        status: "warn",
        message: `version probe failed for ${versionCmd.join(" ")}`,
      };
    } else {
      // parseProbedVersion + compareVersionFloor (task db44ab46, extending
      // the hooks[] prerelease rule to memory.router): a release candidate
      // of the router binary must not satisfy an equal-numeric min_version
      // floor. See docs/decisions/2026-09-08-preflight-floors.md.
      const parsed = parseProbedVersion(stdout);
      if (!parsed) {
        routerVersion = {
          status: "warn",
          message: `could not parse a version from "${stdout.trim()}"`,
        };
      } else {
        const { version: actual, isPrerelease, token } = parsed;
        const cmp = compareVersionFloor(actual, isPrerelease, minVersion);
        routerVersion =
          cmp < 0
            ? {
                status: "warn",
                message: `outdated: installed v${token} < required ${minVersion}`,
              }
            : { status: "ok", message: `v${token} ≥ ${minVersion}` };
      }
    }
  }

  const staleMemories: StaleMemory[] = [];
  for (const dir of directories) {
    if (!dir.exists) continue;
    for (const file of findMarkdownFiles(dir.path)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) {
        staleMemories.push({
          path: file,
          lastTouched: stat.mtime,
          ageDays: Math.floor((now.getTime() - stat.mtimeMs) / 86400000),
        });
      }
    }
  }
  staleMemories.sort((a, b) => a.lastTouched.getTime() - b.lastTouched.getTime());

  return {
    directories,
    projectRejected,
    routerExecutable,
    ...(routerVersion ? { routerVersion } : {}),
    staleMemories,
  };
}
