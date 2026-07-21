// Suite-wide deny-by-default spawn guard (task 052f9d5b). Installed once
// per test FILE via vitest's `setupFiles` (see vitest.config.ts). Patches
// all SEVEN of node:child_process's process-launching entry points and
// throws `HermeticSpawnViolationError` (reused from
// src/runtime/hermetic-spawn-guard.ts, NOT reimplemented — see that
// file's own doc for the four PER-SITE guards this complements, not
// replaces) for any spawn whose resolved absolute binary (or, for
// `fork`, resolved `execPath`) is neither on the small explicit allowlist
// below nor a fixture the calling test itself created under os.tmpdir().
//
// Deny-by-default, not "enumerate known call sites": a FUTURE spawn
// point (a new fixture, a typo'd binary, a copy-pasted real spawn) is
// covered from day one, instead of only after someone measures it. (This
// hook's own coverage stops at process boundaries it doesn't control —
// see "Residual exposure" below.)
//
// --- Why seven entry points, not the four originally named ---
// The brief that spawned this task named "spawn/spawnSync/execFile/exec"
// (four). Verified empirically on this repo's Node version that
// `execFileSync` and `execSync` are each independently implemented —
// they do NOT call through `child_process.spawnSync`/`exec`'s EXPORTED
// bindings internally (only `exec` happens to delegate to the exported
// `execFile`). Patching only the four named functions would leave
// `execFileSync` (measured: git, most of its 101 spawns) and `execSync`
// (measured: tests/io/patch.test.ts's `patch -p0 -i ...` — the exact
// case this task's own D4 calls out) completely UNGUARDED — the opposite
// of deny-by-default. Probe that established this:
//
//   $ node -e '
//     const cp = require("node:child_process");
//     ["spawn","spawnSync","exec","execSync","execFile","execFileSync"]
//       .forEach(n => { const o = cp[n]; cp[n] = (...a) => { console.log(n); return o(...a); }; });
//     cp.execFileSync("true", []);   // logs only "execFileSync"
//     cp.execSync("true");           // logs only "execSync"
//     cp.exec("true", () => {});     // logs "exec" THEN "execFile"
//   '
//
// A SEVENTH entry point, `fork`, was found by an independent review
// (task 052f9d5b review F2) AFTER the six above shipped: `fork` does not
// route through any of the other six exported bindings either (confirmed
// on Node v26.5.0 by the same patch-and-log probe pattern above — calling
// `cp.fork(...)` logs only "fork"), so it was left completely unguarded.
// `fork(modulePath, args, { execPath })` lets a caller launch ANY
// executable as the child's interpreter, not just node — a total bypass
// of this hook if left unpatched (and today's exposure was low only
// because a default `fork()` call launches `process.execPath`, which is
// INFRA-allowed anyway). Unlike the other six, fork's "target" is not
// its first argument (that's a MODULE PATH run by node, not an
// executable) — it's `options.execPath ?? process.execPath` — so it
// needs its own resolve path (`wrapFork` below) rather than reusing
// `wrapArgvStyle`/`wrapStringStyle`.
//
// All seven are patched here; see the T-001 implementer report (this
// branch) for the full six-entry-point validation, and the T-002
// (fix-pass) implementer report for the fork addition and F2's proof.
//
// --- Residual exposure (task 052f9d5b review F3) ---
// Allowlisting an INTERPRETER allowlists everything it can be told to
// run: `sh` is INFRA-allowed below, and `sh -c <anything>` runs
// `<anything>` with ZERO guard coverage from this hook — not
// hypothetical, a live, executed code path today:
// src/cli/pack/hook-runtime-reality.ts:97 runs `execFileSync("sh", ["-c",
// cmd], ...)` against an operator-supplied command string, and
// tests/cli/pack-hook-runtime-reality.test.ts exercises it with real
// `cat`/`printf` grandchildren. The same applies to `node -e "<code>"`
// (INFRA-allowed `node`) and to any `fork()`'d or `spawn()`'d child in
// general: this hook patches only THIS process's own `node:child_process`
// module, so it has no visibility into what a child process, once
// launched, in turn spawns on its own. Allowlisting sh/node/git/patch
// below (D6) is a deliberate, scoped trust decision about what THIS
// suite's fixture setup genuinely needs — not a claim that everything
// downstream of them is guarded too.
//
// --- Why patching via require(), not `import`/`import *` ---
// Named ESM imports of a CJS builtin (`import { spawn } from
// "node:child_process"`, the idiom used throughout src/ and most test
// files) snapshot the function VALUE the first time that import
// statement is evaluated — verified empirically NOT to be a live binding
// that re-reads a later reassignment (patching
// `require("node:child_process").spawnSync` AFTER a module's `import {
// spawnSync }` line has already evaluated does not affect that module's
// calls; patching it BEFORE that line evaluates does). The patch below
// therefore runs, synchronously, at THIS FILE'S OWN TOP LEVEL — vitest
// guarantees setupFiles finish loading (including their top-level side
// effects) before it imports the actual test file, so by the time any
// test file's (or its src/ import graph's) own `import { spawn, ... }
// from "node:child_process"` line evaluates, the CJS module object those
// bindings snapshot from has already been patched. Deferring the patch
// into a `beforeAll` callback would be too late: hooks run only after
// every module in the file's import graph has already finished
// evaluating (and snapshotting).
//
// --- Decisions (task 052f9d5b) ---
// D1 resolve-then-check: match the RESOLVED ABSOLUTE (symlink-canonical)
//    path, against the effective PATH of the call
//    (`options.env?.PATH ?? process.env.PATH`) — never the raw command
//    or a basename (a basename entry would wave through any same-named
//    binary anywhere on PATH).
// D2 unresolvable commands are allowed: a command that resolves to no
//    existing file can't do anything (ENOENT downstream); this is what
//    covers this suite's "definitely not a real binary" probes without
//    maintaining them individually.
// D3 temp fixtures are scoped by os.tmpdir(): a binary the test itself
//    wrote into a temp dir is a fixture by construction. os.tmpdir() can
//    itself be reached through a symlink (macOS: /var -> /private/var),
//    so both the raw and realpath'd forms are checked.
// D4 exec/execSync take a command STRING: the first whitespace token is
//    extracted (minimal quote handling only) BEFORE resolving — proven
//    necessary by tests/io/patch.test.ts's `execSync("patch -p0 -i
//    ...")`. This is a HEURISTIC, not a shell parser: task 052f9d5b
//    review F4 proved several ordinary shell idioms defeat it against
//    the real implementation ("cd /tmp && npm install" -> "cd", "VAR=1
//    npm install" -> "VAR=1", "export X=1; npm i" -> "export", "(npm
//    install)" -> "(npm", "$(which npm) install" -> "$(which", an
//    unterminated quote -> "'unterminated") and let a real, unguarded
//    spawn through every time. Fixed by failing CLOSED: an env-var
//    assignment prefix or a known shell builtin in the FIRST TOKEN, or a
//    shell metacharacter ANYWHERE in the whole command string (task
//    052f9d5b review G3 widened this from "first token only" after
//    proving a metacharacter later in the string, e.g. a pipe to a
//    second command, still hands control to the shell — see G3's own
//    comment above `isUnsafeCommandString` for that finding and the
//    expanded character class), is now blocked outright, never passed
//    through to "resolves to nothing" (D2). What this check actually
//    guarantees: for the shapes it recognizes (the listed
//    metacharacters/env-assignment-prefix/builtins), it fails closed
//    instead of guessing — it is NOT a claim that every shell idiom that
//    could desynchronize "the extracted first token" from "the real
//    first-run binary" is covered; only the ones proven against the real
//    implementation (F4's six plus G3's glob/tilde/later-token findings)
//    are known-closed. See `isUnsafeCommandString` below.
// D5 the four existing PER-SITE guards (assertNoRealSpawnInTests, called
//    from src/cli/init/*, src/io/claude-mcp.ts,
//    src/cli/doctor/npm-bin-path.ts) are UNCHANGED — they give a more
//    precise, actionable message at their specific call sites; this hook
//    is the backstop for everything they don't cover. They also fire
//    independently of this hook's child_process patching (their own
//    mechanism is a `process.env.VITEST` check, not a spawn interception)
//    — see the meta-test asserting that directly.
// D6 git/node/sh/patch are allowlisted (INFRA below) — real system
//    infrastructure the fixture suite depends on throughout, resolved
//    freshly per call (not a fixed path baked in at setup time) so
//    machine-specific install locations and per-test PATH overrides both
//    resolve correctly instead of drifting from a stale snapshot.
// D7 escape hatch: `HARNESS_ALLOW_REAL_SPAWN=1` disables this hook too
//    (task 052f9d5b review F7), mirroring
//    src/runtime/hermetic-spawn-guard.ts's own escape hatch of the same
//    name — same env var, same one-time stderr warning — so a caller
//    following THAT documented escape hatch is not still silently
//    blocked by this separate mechanism.
// D8 violation collection: every violation this hook throws is also
//    recorded in a module-local array BEFORE throwing (task 052f9d5b
//    review F1); this file's `afterAll` hard-fails if that array is
//    non-empty, regardless of whether some caller's try/catch swallowed
//    the actual throw — see "Swallowed violations" below.
// D9 `shell: true` reclassifies an argv-style call as a string-style
//    call (task 052f9d5b review G2): spawn/spawnSync/execFile/
//    execFileSync all accept `{ shell: true }`, which makes Node hand
//    `command` (and `args`) to a real shell instead of exec'ing it
//    directly — the ordinary argv-style path (treat `command` as a
//    literal binary name) is wrong for these calls and was proven to let
//    a real spawn through unguarded (`spawnSync("/bin/ls -la /", {
//    shell: true })` resolved the whole string as one nonexistent path
//    and fell through D2). `wrapArgvStyle` detects `opts.shell` and
//    routes through the same D4/F4/G3 string-style heuristic
//    (`guardShellStyle`) that exec/execSync already use.
//
// --- Swallowed violations still fail the file (task 052f9d5b review F1) ---
// Several src/ call sites catch broadly and degrade ANY thrown error
// (including HermeticSpawnViolationError) to an ordinary warn-and-continue
// result, instead of re-throwing past the catch as
// src/runtime/hermetic-spawn-guard.ts's own module doc requires callers to
// do. Auditing every current and future call site for a correct re-throw
// is not tractable from this file, and a green run is worthless as
// evidence if it's compatible with a silently swallowed violation.
// Instead (D8): every violation is pushed onto a module-local `violations`
// array at the exact moment it's thrown, and this file's own `afterAll`
// throws — hard-failing the test file — if that array is non-empty,
// independent of what any individual caller did with the exception. A
// swallowed violation still turns the file red, just reported at
// teardown instead of at the call site. This suite's OWN meta-tests
// deliberately trigger violations to verify the guard throws at all —
// that is the opposite of swallowing (the test catches it and asserts
// `instanceof HermeticSpawnViolationError`), so those call
// `__testOnly.acknowledgeViolation(err)` — passing the exact caught error
// object, matched by IDENTITY, not position (task 052f9d5b review G1) —
// right after that assertion to avoid also tripping this same-file hard
// fail; see that export's doc.
//
// --- isolate:true coupling (task 052f9d5b review F9, failure mode
// corrected in review H4/third pass) ---
// This file's top level is written to run EXACTLY ONCE per test file
// (patch on load, restore in `afterAll`), which holds only because
// vitest's default `isolate: true` (forks pool, this repo's actual
// config — no override in vitest.config.ts) gives each test file a fresh
// evaluation of every setupFile. A `GUARD_INSTALLED_MARKER` symbol on the
// `child_process` module object (a real Node singleton, unaffected by
// vitest's per-file module registry resets) makes a SECOND same-process
// evaluation of this file idempotent — it reuses the first evaluation's
// true originals instead of capturing already-wrapped functions as
// "originals", and skips re-wrapping.
//
// It cannot fix every failure mode of running this suite under
// `isolate: false`, though — and the F9 marker CHANGES what that failure
// mode looks like, it does not remove it (H4, task 052f9d5b review, third
// pass corrects the earlier version of this paragraph, which predated the
// marker and described the opposite symptom). If setupFiles simply are
// not re-evaluated per later file under that mode, the marker is exactly
// what prevents this file's own restore step from ever running for those
// later files: `previouslyInstalled` is a `const` captured once, at the
// ONE module evaluation that actually happened, so every place that reads
// it (both the install guard and the `afterAll` restore guard) sees the
// SAME frozen value for the lifetime of that evaluation's closures. The
// practical failure mode is therefore NOT "wrappers get removed, later
// files run unguarded" — it is the opposite: the wrapped `cp.*` functions
// from the FIRST evaluation stay installed and keep intercepting spawns
// for every later file in that worker (later files ARE still guarded),
// but every violation a later file triggers gets pushed onto the FIRST
// evaluation's `violations` array — the only one whose closures are still
// live — whose own `afterAll` already ran to completion long before that
// later file even started. Nothing ever re-checks that array again: an
// ORPHANED collection, not a removed guard. A later file's swallowed
// violation would silently vanish exactly like the "swallowed violations"
// class D8/F1 exists to catch, except this specific path bypasses even
// D8/F1's own protection. Do not set `isolate: false` (directly or via
// `poolOptions.forks.isolate`) for this suite without revisiting this
// file.

import { createRequire } from "node:module";
import * as fsNode from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, it } from "vitest";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";

// The real, mutable CJS module object — see "why require()" above.
const requireCjs = createRequire(import.meta.url);
const cp = requireCjs("node:child_process") as typeof import("node:child_process");

type SpawnOptionsLike = { cwd?: unknown; env?: NodeJS.ProcessEnv; execPath?: unknown; shell?: unknown };

/**
 * First object (not array) among the trailing args — works for every
 * overload of all seven functions without hardcoding argument positions
 * (args-array vs. options vs. callback all vary by overload).
 */
function findOptions(args: readonly unknown[]): SpawnOptionsLike | undefined {
  for (const a of args) {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      return a as SpawnOptionsLike;
    }
  }
  return undefined;
}

/** D4: first whitespace token of a shell command string, minimal quote handling. */
function firstToken(commandStr: string): string {
  const s = commandStr.trimStart();
  if (s.length === 0) return "";
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    if (end !== -1) return s.slice(1, end);
  }
  return /^\S+/.exec(s)?.[0] ?? "";
}

// F4 (task 052f9d5b review): D4's first-token extraction is a HEURISTIC,
// not a shell parser. A token containing a shell metacharacter, matching
// an env-var-assignment shape, or equal to a known shell builtin means
// the heuristic could not have safely identified "the command" — in every
// one of those shapes, the real first-run binary is NOT the extracted
// token, and it was proven (against the real implementation) to sail
// through unguarded when treated as "resolves to nothing" (D2). Fail
// CLOSED for these instead of guessing.
//
// G3 (task 052f9d5b review, second pass): F4's original character class
// covered grouping/substitution/control metacharacters
// (`(){}$\`;&|<>'"\\` and newline) but not glob wildcards (`*`, `?`,
// `[`, `]`), tilde-expansion (`~`), or history/negation (`!`) — proven
// exploitable against the real implementation:
// `execSync("/bin/l? /")` (glob-expands to a real, different binary) and
// `execSync("~/../../bin/ls /")` (tilde-expands to a real path) both ran
// for real, unguarded. F4's check was also applied to the extracted
// FIRST TOKEN only, not the whole command string — also proven
// exploitable: `execSync("git --version | /usr/bin/wc -c")` has its
// metacharacter (`|`) AFTER the first token, so "git" alone (INFRA
// allowed) looked safe while the real, unguarded second command ran.
// isUnsafeCommandString below therefore scans the WHOLE string for
// metacharacters (not just the first token) with the expanded class, and
// still limits the position-sensitive env-assignment/builtin checks to
// the first token only (those two ARE inherently about "is this token,
// in first position, a command at all" — scanning them suite-wide would
// misfire on, e.g., a legitimate later argument literally named "cd").
// This closes the SIX F4 examples plus this class of glob/tilde/
// later-token gaps; it remains a heuristic, not a shell parser — see D4
// above.
// H3 (task 052f9d5b review, third pass): the original five builtins missed
// three command-PREFIX shell keywords that also hand off execution to a
// FOLLOWING command word — "command", "time", and "builtin" — plus the
// POSIX dot command "." (the exact synonym of "source", already listed).
// This class is specifically "a first token that does not itself do the
// work, but instead executes/modifies execution of whatever word comes
// after it" — NOT every builtin (e.g. "type"/"which"/"hash" only report,
// they never hand control to a new program, so they stay out).
//
// Verified empirically on this machine (fail-CLOSED reasoning, not
// guessed): whether D1 happens to resolve one of these to a real,
// non-INFRA binary and block it "by accident" is PLATFORM-DEPENDENT, so
// this list must not rely on that coincidence —
//   - /usr/bin/command and /usr/bin/time both EXIST here, so
//     "command ls /" and "time ls /" were, before this fix, only blocked
//     because D1 resolved them to real, non-allowlisted binaries and
//     reportViolation fired via the ORDINARY path — not because the
//     fail-closed heuristic recognized them. A slim CI image without
//     those two binaries would hit D2 ("unresolvable is allowed") and let
//     the shell run the real following command ungurded.
//   - /usr/bin/builtin does NOT exist here, so "builtin ls /" was
//     confirmed DURCHGELASSEN (reached the real, unguarded exec call) —
//     not a hypothetical, the live gap this fix closes.
//   - "." resolves even more reliably to "nothing executable": every
//     directory on PATH literally contains an entry named "." (itself),
//     but it is never a regular FILE, so resolveAbsolute's `!stat.isFile()`
//     check skips it on every PATH candidate — "." was ALWAYS silently
//     allowed through via D2 on every platform, never by accident.
// See the module doc's D4 for why this list must stay fail-CLOSED
// (platform-independent) rather than deny only what happens to already
// resolve to a real binary on any one machine/image.
const SHELL_METACHARACTERS = /[(){}$`;&|<>'"\\\n*?[\]~!]/;
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  "cd",
  "export",
  "source",
  "eval",
  "exec",
  "command",
  "time",
  "builtin",
  ".",
]);

function isUnsafeCommandString(cmdStr: string, token: string): boolean {
  if (token === "") return false; // empty command string — D2 resolves it to nothing, harmlessly.
  if (SHELL_METACHARACTERS.test(cmdStr)) return true; // G3: whole string, not just the first token.
  if (/^\w+=/.test(token)) return true; // env-var assignment prefix, e.g. "VAR=1 npm install"
  return SHELL_BUILTINS.has(token);
}

/**
 * D1/D2: resolve `command` to an absolute, symlink-canonical, EXECUTABLE
 * path using the given cwd/PATH, approximating POSIX execvp search
 * semantics: a name containing "/" is never PATH-searched (D1); an EMPTY
 * PATH entry means the current working directory, not "skip this entry"
 * (task 052f9d5b review F6a); and a candidate that exists but is not
 * executable is skipped in favor of the next PATH entry, mirroring
 * execvp's EACCES fallthrough (review F6b) instead of stopping at the
 * first same-named regular file. Returns null when nothing executable
 * exists at any candidate (D2: unresolvable is allowed, it can't do
 * anything).
 */
function resolveAbsolute(command: string, cwd: string, pathEnv: string | undefined): string | null {
  if (!command) return null;
  const candidates: string[] = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else if (command.includes("/")) {
    candidates.push(path.resolve(cwd, command));
  } else if (pathEnv !== undefined) {
    for (const dir of pathEnv.split(path.delimiter)) {
      // F6a: an empty PATH entry (leading/trailing/doubled delimiter)
      // means "search the current working directory" under POSIX, not
      // "skip this entry".
      candidates.push(path.join(dir === "" ? cwd : dir, command));
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = fsNode.statSync(candidate);
      if (!stat.isFile()) continue;
      // F6b: a candidate that exists but isn't executable doesn't count
      // as resolved — execvp treats EACCES as non-fatal and keeps
      // searching PATH; stopping here would wrongly stop this guard's
      // search at an unusable candidate too.
      fsNode.accessSync(candidate, fsNode.constants.X_OK);
      try {
        return fsNode.realpathSync(candidate);
      } catch {
        return candidate;
      }
    } catch {
      // Not a file, not executable (EACCES), or ENOENT — try the next
      // PATH entry.
    }
  }
  return null;
}

// Hot-path cache ("Resolve cachen"): resolution is a pure function of
// (cwd, PATH, command) within a single test file's run; git alone is
// spawned 101 times across the suite, mostly with the same cwd/PATH.
const resolveCache = new Map<string, string>();
function resolveCached(command: string, cwd: string, pathEnv: string | undefined): string | null {
  const key = `${cwd} ${pathEnv ?? ""} ${command}`;
  const cached = resolveCache.get(key);
  if (cached !== undefined) return cached;
  const resolved = resolveAbsolute(command, cwd, pathEnv);
  if (resolved !== null) {
    // F5 (task 052f9d5b review): only cache POSITIVE resolutions. A
    // cached NEGATIVE (null) would go stale in the UNSAFE direction if a
    // later test in the same file creates a real binary at the exact
    // resolved location — the cache motivation (git, 101 spawns) is
    // entirely positive hits, so never caching "nothing here" costs
    // nothing measurable (one failed stat per PATH entry) and removes
    // the unsafe staleness direction entirely.
    resolveCache.set(key, resolved);
  }
  return resolved;
}

function safeRealpath(p: string): string {
  try {
    return fsNode.realpathSync(p);
  } catch {
    return p;
  }
}

// D3: a binary a test wrote into its own temp dir is a fixture by
// construction. os.tmpdir() can be reached through a symlink (macOS:
// /var -> /private/var) — both forms are matched, with a trailing
// separator so a sibling directory sharing the prefix textually (e.g.
// "/var/folders/T-evil") can't false-match.
const TMP_PREFIXES: readonly string[] = (() => {
  const raw = os.tmpdir();
  const withSep = (p: string) => (p.endsWith(path.sep) ? p : p + path.sep);
  return [...new Set([withSep(raw), withSep(safeRealpath(raw))])];
})();

function isUnderTmp(resolvedPath: string): boolean {
  return TMP_PREFIXES.some((prefix) => resolvedPath.startsWith(prefix));
}

// D6: the four infra binaries the suite's fixture setup genuinely needs.
// Resolved FRESH per call (through the same resolveCached used for every
// spawn, so repeated lookups under the same cwd/PATH are cache-hits, not
// repeated fs syscalls) rather than baked in once at setup time — a test
// that overrides PATH still correctly finds "its" git, and a dev machine
// with git/patch at a nonstandard location isn't hardcoded around.
const INFRA: ReadonlyArray<{ name: string; reason: string }> = [
  // node: the suite's subprocess IPC/exit smoke tests spawn `node
  // <fixture>.js` as a real child (measured ~35 spawns:
  // tests/runtime/ledger-*.test.ts, tests/probes/mcp.test.ts,
  // tests/cli/doctor-codex.test.ts, ...). Both a PATH lookup of "node"
  // AND process.execPath (the exact running vitest binary) are accepted
  // as candidates — see infraCandidates() below.
  // CAVEAT (task 052f9d5b review F3): `node -e "<code>"` runs arbitrary
  // code with zero guard coverage from this hook — allowlisting the
  // interpreter allowlists what it can be told to run.
  { name: "node", reason: "the same node runtime executing vitest (subprocess smoke tests)." },
  // git: real system git, used throughout the suite to build fixture
  // repos (init/commit/branch) — measured 101 spawns (execFileSync +
  // spawnSync). Task 052f9d5b's own D6: excluding every real system
  // binary is not achievable without breaking the fixture-repo family.
  { name: "git", reason: "fixture-repo setup across the suite (101 measured spawns) — see D6." },
  // sh: the real system shell, invoked directly by a handful of tests
  // (measured 9 spawns) as an inline command wrapper — not a repo
  // binary, not test-authored.
  // CAVEAT (task 052f9d5b review F3): `sh -c "<cmd>"` runs arbitrary
  // commands with zero guard coverage from this hook — see
  // src/cli/pack/hook-runtime-reality.ts:97 for a live production call
  // site that does exactly this against an operator-supplied string.
  { name: "sh", reason: "real system shell, invoked directly by a handful of tests (9 measured spawns)." },
  // patch: real system `patch`, used by tests/io/patch.test.ts to prove
  // a generated unified diff actually applies (round-trip check).
  { name: "patch", reason: "round-trip-applies a generated diff in tests/io/patch.test.ts." },
];

function infraCandidates(name: string, cwd: string, pathEnv: string | undefined): readonly string[] {
  const viaPath = resolveCached(name, cwd, pathEnv);
  if (name === "node") {
    const execPath = safeRealpath(process.execPath);
    return viaPath ? [execPath, viaPath] : [execPath];
  }
  return viaPath ? [viaPath] : [];
}

function isInfraAllowed(resolved: string, cwd: string, pathEnv: string | undefined): boolean {
  return INFRA.some(({ name }) => infraCandidates(name, cwd, pathEnv).includes(resolved));
}

/** Best-effort: first `tests/**\/*.test.ts` frame in the current stack. */
function currentTestFile(): string {
  const stack = new Error().stack ?? "";
  const match = /[^\s(]*tests\/[^\s):]*\.test\.ts/.exec(stack);
  return match ? match[0].replace(/^.*?(tests\/)/, "$1") : "(test file not found in stack trace)";
}

// D8/F1: every violation is recorded here at the moment it's thrown, so
// this file's afterAll (below) can hard-fail even when some caller's
// broad catch swallows the actual thrown error — see "Swallowed
// violations" in the module doc above.
//
// G1 (task 052f9d5b review, second pass): the ERROR OBJECT itself is
// pushed (not just its message string), so `acknowledgeViolation` below
// can remove an entry by IDENTITY instead of by position. A positional
// `violations.pop()` has no idea whether the error a caller is
// acknowledging is the one it's actually popping — proven exploitable:
// a test that (a) triggers and swallows a REAL, unrelated violation from
// this hook, then (b) catches an unrelated HermeticSpawnViolationError
// that was never pushed here at all (e.g.
// src/runtime/hermetic-spawn-guard.ts's assertNoRealSpawnInTests, which
// throws the same class but never calls reportViolation) and
// acknowledges it, would silently delete (a)'s real, unacknowledged
// violation instead — exactly the swallowed-violation hole D8/F1 exists
// to catch, reopened by an unconditional pop. See the nested-fixture
// proof in tests/runtime/hermetic-spawn-allowlist-nested-fixtures.test.ts
// ("G1: acknowledgeViolation is identity-based").
const violations: HermeticSpawnViolationError[] = [];

function reportViolation(binaryLabel: string, hint: string): never {
  const err = new HermeticSpawnViolationError(binaryLabel, hint);
  violations.push(err);
  throw err;
}

// F7 (task 052f9d5b review): mirror src/runtime/hermetic-spawn-guard.ts's
// HARNESS_ALLOW_REAL_SPAWN=1 escape hatch (same env var, same one-time
// stderr warning) so a caller following THAT documented escape hatch
// isn't still silently blocked here — this hook and the four per-site
// guards it complements (D5) share one kill-switch, not two independent
// ones where only one is documented.
let printedAllowRealSpawnWarning = false;

function allowRealSpawnEscapeHatchActive(): boolean {
  if (process.env["HARNESS_ALLOW_REAL_SPAWN"] !== "1") return false;
  if (!printedAllowRealSpawnWarning) {
    printedAllowRealSpawnWarning = true;
    process.stderr.write(
      "⚠ hermetic-spawn-allowlist.ts DISABLED via HARNESS_ALLOW_REAL_SPAWN=1 — " +
        "real spawns are allowed for the rest of this test file.\n",
    );
  }
  return true;
}

function guardSpawn(rawLabel: string, resolveTarget: string, trailingArgs: readonly unknown[]): void {
  if (allowRealSpawnEscapeHatchActive()) return; // D7/F7

  const opts = findOptions(trailingArgs);
  const cwd = typeof opts?.cwd === "string" ? opts.cwd : process.cwd();
  const pathEnv = opts?.env?.["PATH"] ?? process.env["PATH"];

  const resolved = resolveCached(resolveTarget, cwd, pathEnv);
  if (resolved === null) return; // D2
  if (isUnderTmp(resolved)) return; // D3
  if (isInfraAllowed(resolved, cwd, pathEnv)) return; // D6

  reportViolation(
    `${rawLabel} (resolved: ${resolved})`,
    `Blocked by the suite-wide hermetic spawn allowlist ` +
      `(tests/_helpers/hermetic-spawn-allowlist.ts), triggered from ${currentTestFile()}. ` +
      "Inject a fake runner/binary in the test instead of exercising a real spawn, " +
      "or if this is genuine test infrastructure, add a justified entry to INFRA in that file.",
  );
}

// monkeypatch shim, signature intentionally untyped (this repo has no
// ESLint config/script — task 052f9d5b review F8)
type AnyFn = (...args: any[]) => any;

/**
 * Shared by `wrapStringStyle` (exec/execSync, which always take a shell
 * command STRING) and, since G2, `wrapArgvStyle`'s `shell: true` branch
 * (D9): the D4/F4/G3 fail-closed first-token/whole-string check, then
 * `guardSpawn` against the extracted first token.
 */
function guardShellStyle(cmdStr: string, rest: readonly unknown[]): void {
  const token = firstToken(cmdStr);
  if (isUnsafeCommandString(cmdStr, token) && !allowRealSpawnEscapeHatchActive()) {
    reportViolation(
      cmdStr,
      `D4 fail-closed (task 052f9d5b review F4/G3): this shell command could not be safely ` +
        `resolved by the minimal first-token heuristic — its first token ("${token}") looks like ` +
        "an env-var assignment or a shell builtin, or the command contains a shell metacharacter " +
        "(checked across the WHOLE command string, not just the first token — task 052f9d5b " +
        "review G3). Refusing to guess rather than risk letting an unguarded real spawn through. " +
        "Use the argv-based spawn/spawnSync/execFile/execFileSync API instead of a shell command " +
        "string.",
    );
  }
  guardSpawn(cmdStr, token, rest);
}

function wrapArgvStyle(orig: AnyFn): AnyFn {
  return function (this: unknown, command: unknown, ...rest: unknown[]) {
    const cmdStr = String(command);
    const opts = findOptions(rest);
    if (opts?.shell) {
      // D9 (task 052f9d5b review G2): `{ shell: true }` reclassifies this
      // argv-style call as a STRING-style call — with shell:true, Node
      // hands `command` (plus `args`) to a real shell instead of exec'ing
      // it directly, so treating `command` as a literal binary name (the
      // ordinary argv-style path below) is wrong: a full command line
      // like "/bin/ls -la /" would resolve as one nonexistent path
      // ("/bin/ls -la /") and fall through D2 unguarded — proven against
      // the real implementation. Route it through the same string-style
      // heuristic (first-token extraction, D4/F4/G3 fail-closed check,
      // then guardSpawn on the extracted token) that wrapStringStyle
      // already uses for exec/execSync.
      guardShellStyle(cmdStr, rest);
    } else {
      guardSpawn(cmdStr, cmdStr, rest);
    }
    return orig.apply(this, [command, ...rest]);
  };
}

function wrapStringStyle(orig: AnyFn): AnyFn {
  return function (this: unknown, command: unknown, ...rest: unknown[]) {
    const cmdStr = String(command);
    guardShellStyle(cmdStr, rest);
    return orig.apply(this, [command, ...rest]);
  };
}

/**
 * F2 (task 052f9d5b review): `fork`'s target is not its first argument
 * (that's a MODULE PATH run by node, not an executable) — it's the
 * interpreter that runs that module, `options.execPath ?? process.execPath`.
 * Everything else about fork (options is one of the trailing args; cwd/env
 * come from that same options object) matches the other six, so this
 * reuses `guardSpawn` with a different `resolveTarget`.
 */
function wrapFork(orig: AnyFn): AnyFn {
  return function (this: unknown, modulePath: unknown, ...rest: unknown[]) {
    const opts = findOptions(rest);
    const execPath = typeof opts?.execPath === "string" ? opts.execPath : process.execPath;
    guardSpawn(`fork(${String(modulePath)})`, execPath, rest);
    return orig.apply(this, [modulePath, ...rest]);
  };
}

interface CpOriginals {
  spawn: typeof cp.spawn;
  spawnSync: typeof cp.spawnSync;
  execFile: typeof cp.execFile;
  execFileSync: typeof cp.execFileSync;
  exec: typeof cp.exec;
  execSync: typeof cp.execSync;
  fork: typeof cp.fork;
}

// F9 (task 052f9d5b review): see "isolate:true coupling" in the module
// doc above. A symbol on the child_process module singleton (not on this
// module's own local state, which a second evaluation wouldn't share)
// lets a second same-process evaluation detect that the true originals
// were already captured, reuse them, and skip re-wrapping.
const GUARD_INSTALLED_MARKER = Symbol.for("harness.hermeticSpawnAllowlist.trueOriginals");
type MarkedCp = typeof cp & { [GUARD_INSTALLED_MARKER]?: CpOriginals };
const markedCp = cp as MarkedCp;

const previouslyInstalled = markedCp[GUARD_INSTALLED_MARKER];
const originals: CpOriginals = previouslyInstalled ?? {
  spawn: cp.spawn,
  spawnSync: cp.spawnSync,
  execFile: cp.execFile,
  execFileSync: cp.execFileSync,
  exec: cp.exec,
  execSync: cp.execSync,
  fork: cp.fork,
};

// Patched synchronously, at module top level — see "why require()" above
// for why this ordering (not inside beforeAll) is load-bearing. Skipped
// entirely on a second same-process evaluation (F9): the functions are
// already wrapped.
if (!previouslyInstalled) {
  markedCp[GUARD_INSTALLED_MARKER] = originals;
  cp.spawn = wrapArgvStyle(originals.spawn) as typeof cp.spawn;
  cp.spawnSync = wrapArgvStyle(originals.spawnSync) as typeof cp.spawnSync;
  cp.execFile = wrapArgvStyle(originals.execFile) as typeof cp.execFile;
  cp.execFileSync = wrapArgvStyle(originals.execFileSync) as typeof cp.execFileSync;
  cp.exec = wrapStringStyle(originals.exec) as typeof cp.exec;
  cp.execSync = wrapStringStyle(originals.execSync) as typeof cp.execSync;
  cp.fork = wrapFork(originals.fork) as typeof cp.fork;
}

// Restore exactly what was here before this file's patch — never leak a
// wrapped function into the next test file that reuses this worker
// process (child_process is a Node core singleton, not reset per file).
// Also (D8/F1): hard-fail the file if any violation was collected during
// its run, even if some caller's catch swallowed the actual throw.
afterAll(() => {
  if (!previouslyInstalled) {
    cp.spawn = originals.spawn;
    cp.spawnSync = originals.spawnSync;
    cp.execFile = originals.execFile;
    cp.execFileSync = originals.execFileSync;
    cp.exec = originals.exec;
    cp.execSync = originals.execSync;
    cp.fork = originals.fork;
    delete markedCp[GUARD_INSTALLED_MARKER];
  }

  if (violations.length > 0) {
    throw new Error(
      `hermetic-spawn-allowlist: ${violations.length} spawn violation(s) were thrown during ` +
        "this test file. If this is unexpected, a HermeticSpawnViolationError was almost " +
        "certainly thrown from inside a broad try/catch that swallowed it instead of " +
        "re-throwing (see src/runtime/hermetic-spawn-guard.ts's module doc: callers MUST " +
        "re-throw this error class past any such catch). Collected violation(s):\n" +
        violations.map((v, i) => `  ${i + 1}. ${v.message}`).join("\n"),
    );
  }
});

// H2 (task 052f9d5b review, third pass): a test FILE whose tests are ALL
// skipped (e.g. `describe.skipIf(...)` wrapping the whole file, or a file
// containing only `it.skip`) is a case vitest treats as the FILE itself
// being skipped — no suite-level hook, including this setup file's own
// top-level `afterAll` above, ever fires for it, so D8/F1's own
// protection (gated on `afterAll` actually running) never gets a chance
// to run either. A spawn violation triggered at MODULE TOP LEVEL
// (import/collection time — which DOES execute even when every `it`
// inside the file is skipped) or inside a `describe(...)`/
// `describe.skipIf(...)` CALLBACK BODY (also collected, not
// test-body-gated) would be pushed onto `violations` above and then never
// be checked by anything.
//
// First attempt, proven INEFFECTIVE by measurement — do not resurrect
// without re-reading this note: a `process.on("exit", ...)` handler that
// wrote to stderr and set `process.exitCode = 1` when `violations.length
// > 0` and `afterAll` never ran. Measured against a real nested `vitest
// run` (task 052f9d5b review H2's own acceptance criterion: prove, don't
// assume, whether a worker's exit code propagates) — see the "H2"
// nested-fixture proof in
// tests/runtime/hermetic-spawn-allowlist-nested-fixtures.test.ts. Result:
// the handler's `process.exitCode` mutation never changed the outer
// `vitest run` CLI's own reported exit code (stayed 0), and its stderr
// write never even reached the parent's captured output. Root cause:
// vitest's forks-pool workers report per-test results to the main
// process over their own RPC/IPC channel; that reporting path — the one
// that actually determines the CLI's exit code — never consults a
// worker's raw OS-level exit code or anything written during its "exit"
// event. A worker-local `process.exitCode`/stderr write happens on the
// wrong side of that boundary to influence what the CLI reports.
//
// Working fix: register a genuine, ALWAYS-RUN `it(...)` right here, at
// this setup file's own top level — never `it.skip`, never conditional.
// Because setupFiles finish loading (and therefore finish registering
// every top-level `it`/`describe`/hook call they make) before vitest even
// IMPORTS the actual test file, this test is always collected as part of
// that file's suite and runs like any ordinary test regardless of what
// the file's OWN tests do — so it participates in vitest's REAL pass/fail
// -> exit-code pipeline, the same one every other test failure already
// goes through, instead of the worker-exit side channel the main process
// doesn't consult.
//
// Why this is safe to run EARLY (registered before the actual test
// file's own tests, since setupFiles always import first) without
// needing to run LAST the way `afterAll` does: vitest fully COLLECTS a
// file — importing setupFiles, then the test file, walking every
// `describe`/`it` call synchronously to build the whole suite tree —
// before it EXECUTES any test in that file. A module-top-level or
// describe-body violation always happens during that collection phase,
// strictly before ANY test (including this one) starts running,
// regardless of registration order. This check is deliberately narrower
// than `afterAll`'s guarantee, on purpose: it does NOT catch a violation
// from inside an actually-EXECUTING test's `it` callback — but that case
// is exactly when `afterAll` itself still fires normally (at least one
// test ran), so the two checks' coverage is complementary, not
// redundant-by-accident.
//
// Caveat on the wording below (review round 4): this check's name and
// failure message say the violation was recorded "before any test ran".
// That is exact only while `sequence.shuffle` stays OFF (it is off, and
// vitest.config.ts sets no `sequence` block at all). Under shuffle this
// injected test could be ordered after other tests, and a violation from
// an executing test body would then be reported here as if it had
// happened at collection time — the violation would still be caught, only
// mis-attributed. Turning shuffle on means revisiting that wording.
//
// Known gap, deliberately NOT closed here (review round 4, tracked as its
// own task): a file carrying a committed `.only` whose selected tests are
// ALL skipped defeats both layers at once — only-mode filters this
// injected test out, and since nothing executes, `afterAll` never fires
// either. Pre-existing (that file shape was equally unprotected before
// this hook existed) and it needs a three-way conjunction, but the fix
// belongs in a CI gate that forbids committed `.only`, not in more
// machinery here.
//
// A file with both a collection-time violation AND
// at least one real running test will report the SAME violation via both
// checks (this one first, `afterAll` again at teardown) — accepted as
// harmless duplicate signal rather than added complexity to suppress it.
it(
  "hermetic-spawn-allowlist: no unacknowledged spawn violation was recorded before any test " +
    "in this file ran (task 052f9d5b review H2 — covers files where every OTHER test is " +
    "skipped, so this setup file's own afterAll never fires to run the D8/F1 check)",
  () => {
    if (violations.length > 0) {
      throw new Error(
        `hermetic-spawn-allowlist: ${violations.length} spawn violation(s) were recorded ` +
          "during this file's collection (module import or a describe body), before any test " +
          "ran — task 052f9d5b review H2. A HermeticSpawnViolationError was almost certainly " +
          "thrown from inside a broad try/catch outside any test body and swallowed there. " +
          "Collected violation(s):\n" +
          violations.map((v, i) => `  ${i + 1}. ${v.message}`).join("\n"),
      );
    }
  },
);

// Exported ONLY for this file's own meta-tests
// (tests/runtime/hermetic-spawn-allowlist*.test.ts). Not part of this
// setup file's public contract, and vitest.config.ts's setupFiles wiring
// does not use this export — nothing outside the tests/ tree should
// import from it.
export const __testOnly = {
  isUnderTmp,
  trueOriginals: originals,
  /**
   * D8/F1's afterAll must still fail a file where a violation was thrown
   * from inside a broad catch and never surfaced to an assertion — that
   * is what "swallowed" means. It must NOT fail a file whose test
   * DELIBERATELY triggers a violation specifically to verify the guard
   * throws (catch it, assert `instanceof HermeticSpawnViolationError`) —
   * that is the opposite of swallowed: the test saw it. This meta-test
   * suite's own `captureThrow` helper calls this immediately after
   * confirming the catch was that instanceof check, passing the CAUGHT
   * ERROR OBJECT so it can be removed by identity.
   *
   * G1 (task 052f9d5b review, second pass): identity-based, not
   * positional. `err` must be the EXACT object this hook pushed via
   * `reportViolation` — found with `lastIndexOf` (LIFO-biased: matches a
   * synchronous throw-then-catch, same as the old `.pop()`, when there
   * are duplicates) and removed with `splice`. A `HermeticSpawnViolationError`
   * this hook never recorded (e.g. one thrown directly by
   * src/runtime/hermetic-spawn-guard.ts's `assertNoRealSpawnInTests`,
   * which throws the same class but never calls this file's
   * `reportViolation`) throws LOUDLY instead of silently popping
   * whatever unrelated entry happens to be last — that unrelated entry
   * is exactly the kind of swallowed, un-acknowledged violation D8/F1's
   * afterAll exists to catch, and a positional pop could delete it
   * un-acknowledged. See the nested-fixture proof in
   * tests/runtime/hermetic-spawn-allowlist-nested-fixtures.test.ts ("G1:
   * acknowledgeViolation is identity-based").
   */
  acknowledgeViolation(err: unknown): void {
    const i = violations.lastIndexOf(err as HermeticSpawnViolationError);
    if (i === -1) {
      throw new Error(
        "acknowledgeViolation: this error was never recorded by the hook (it was not pushed " +
          "via this file's reportViolation) — refusing to pop an unrelated entry. If you're " +
          "acknowledging a HermeticSpawnViolationError thrown by something OTHER than this " +
          "hook (e.g. src/runtime/hermetic-spawn-guard.ts's assertNoRealSpawnInTests), don't " +
          "call acknowledgeViolation for it at all — it was never recorded here, so there is " +
          "nothing to acknowledge.",
      );
    }
    violations.splice(i, 1);
  },
};
