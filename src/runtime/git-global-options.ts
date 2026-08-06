// Leaf module: the NAMES of git's own global options (task 5b5d1022,
// review round 2 — module-cycle removal). Extracted out of
// `command-normalize.ts` so that module and `read-only-bash.ts` no longer
// import from each other.
//
// BEFORE this extraction, `command-normalize.ts` defined these four
// exports and `read-only-bash.ts` imported them; `read-only-bash.ts` in
// turn defined `ENV_LEADING_FLAGS` / `ENV_VALUE_FLAGS` /
// `ENV_SPLIT_STRING_FLAGS`, which `command-normalize.ts` imported back —
// a genuine circular import between two same-layer `src/runtime` modules.
// ES modules resolve a cycle with live bindings, but only code that runs
// AFTER the whole graph has finished loading may safely read an imported
// binding's value; a module-top-level dereference of one of these four
// names from within `read-only-bash.ts` could throw `ReferenceError:
// Cannot access '...' before initialization` depending on which module an
// entry point happened to import first (verified in both import orders
// plus the built dist CLI) — the TDZ landmine this extraction removes.
// Moving these four into a dependency-free leaf module both modules can
// import from breaks the cycle outright: `git-global-options.ts` (this
// file) has no imports of its own, `read-only-bash.ts` imports ONLY from
// here, and `command-normalize.ts` imports from both this file (re-
// exporting these four for its existing external consumers) and from
// `read-only-bash.ts` (for the `ENV_*` names, unaffected by this change).
// With the cycle gone, a module-scope reference to any of these four names
// is safe again in either importer — no function-body deferral needed.
//
// WHAT "SINGLE SOURCE OF TRUTH" ACTUALLY MEANS HERE (downgraded from the
// prior docstring's overstated claim, task 5b5d1022 review round 2, LOW
// finding): these four exports are the source of truth for WHICH NAMES ARE
// GIT GLOBAL OPTIONS — the enumeration, not what each consumer does with a
// match. The two importers do NOT treat every name identically:
//   - `command-normalize.ts`'s `peelGitGlobalOptions` peels EVERY name in
//     all three sets uniformly (skips past it) for its own canonicalization
//     purpose — collapsing a git invocation down to `git <subcommand>` so a
//     `bash_match` trigger regex still matches it.
//   - `read-only-bash.ts`'s read-only DECISION does NOT peel every name
//     uniformly: `-c`, `--exec-path[=<dir>]`, and `--git-dir[=<dir>]`
//     FORFEIT the whole invocation's read-only classification outright
//     (see that module's own comments — `-c` loads arbitrary,
//     case-insensitive-keyed git config including config that executes a
//     program; `--exec-path` is prepended to PATH for every child process
//     git spawns; `--git-dir` relocates which repository is even being
//     asked about, same as `-C`), and `-C`'s presence narrows which
//     subcommands are still classified read-only (a stricter subset that
//     excludes `branch`/`tag`/`remote`/`fetch` — see
//     `GIT_STRICT_QUERY_SUBS` in that module). Only `--no-pager`, `-p`,
//     `--paginate`, `--literal-pathspecs`, `--no-replace-objects`,
//     `--work-tree`, and `--namespace` are peeled past the same way by
//     both consumers.
// Agreement between these sets and what each consumer's own peeling
// function actually recognises is pinned by
// `tests/runtime/command-normalize.test.ts` (the peel-everything contract)
// and `tests/runtime/git-global-options.test.ts` (a content pin on the sets
// themselves, so a silent name removal here fails a test instead of
// silently narrowing both consumers at once).

/**
 * The `git` token itself, matched by BASENAME so a path-qualified
 * invocation (`/usr/bin/git`, `./git`) is recognised too. Anchored to the
 * WHOLE token (not a substring) so `mygit` / `git-foo` still correctly
 * fail to match — `\S*` only ever contributes characters immediately
 * before a literal `/`, never before `git` directly.
 *
 * This is `command-normalize.ts`'s own trigger-matching regex — deliberately
 * left BROAD (matches ANY path-qualified spelling, relative or absolute) by
 * task 5b5d1022's review round 2, MEDIUM finding: narrowing it would also
 * narrow `command-normalize.ts`'s unrelated normalization/trigger-matching
 * job, which is not this task's concern. `read-only-bash.ts`'s own
 * read-only DECISION does NOT use this regex for its binary check — it uses
 * a deliberately NARROWER regex, restricted to bare `git` plus ABSOLUTE
 * paths only, defined locally in that module (see its own comment for why:
 * an agent-controlled RELATIVE path like `./git` or `bin/git` can be a
 * different binary entirely, and trusting it the same as the real `git` on
 * PATH would let that other binary's behaviour masquerade as a proven
 * read-only git invocation).
 */
export const GIT_TOKEN_RE = /^(?:\S*\/)?git$/;

/**
 * Git global-option names whose value is the token immediately following
 * them, separated by whitespace: `-C <dir>`, `-c <key=value>`,
 * `--git-dir <dir>`, `--work-tree <dir>`, `--namespace <ns>`.
 */
export const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace",
]);

/**
 * Long git global-option names that ALSO accept a glued `--name=value`
 * spelling, in addition to the separate-token form in
 * `GIT_GLOBAL_VALUE_FLAGS` above. `--exec-path` is included here too even
 * though its BARE (no `=`) spelling takes no following token at all — see
 * `GIT_GLOBAL_BOOLEAN_FLAGS` below — only the glued form carries a value.
 */
export const GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES: ReadonlySet<string> = new Set([
  "--git-dir", "--work-tree", "--namespace", "--exec-path",
]);

/**
 * Git global options that take NO value at all: pure boolean toggles,
 * plus the bare (non-glued) `--exec-path` spelling, which prints the
 * configured exec path rather than consuming a following argument.
 */
export const GIT_GLOBAL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--no-pager", "-p", "--paginate", "--exec-path",
  "--literal-pathspecs", "--no-replace-objects",
]);
