# Writing custom policies

You have a use case ("block X until Y is logged"), you know harness
runs, you want the YAML that expresses it. This is the how-to. The
worked examples here all live as standalone YAML files in
[`docs/examples/policies/`](examples/policies/) and are validated by
`tests/docs/policies-recipe-examples.test.ts`, so if the schema
evolves and a recipe breaks, CI fails before this doc rots.

If you have not yet installed harness or run your first `apply`,
read [`for-humans.md`](for-humans.md) first; this doc assumes a
working harness.

<a id="the-trust-model"></a>

## Read this first (four tripwires)

These four things bite people who skip ahead to the YAML:

1. **Custom *policies* are supported; custom policy *packs* are not (yet).**
   Anything you put in `policies:` is first-class: any name, any
   trigger, any `requires`. Only `policy_packs:` is gated to the two
   builtins (`understanding-before-execution`, `branch-protection`).
   `source: path:` / `npm:` / `git:` for packs is reserved vocabulary
   in v1, see [`policy-packs/understanding-before-execution.md`](policy-packs/understanding-before-execution.md)
   for the future contract.

2. **Evidence-consuming policies must wire `grounding-mcp` in `tools.mcp[]`,
   or their evaluation degrades — and what that means depends on the policy's
   `enforcement:` tier.** The `requires` evaluator
   queries the evidence ledger through grounding-mcp; without it, a
   `warn` policy degrades to the non-blocking `warn-degraded`, while a
   `block`/`require_approval` policy fails CLOSED (`deny-degraded`) and
   DENIES every matching event until the producer is wired — see
   docs/okf/gate-fail-posture-matrix.md. Since `v0.35.0`, `harness
   apply` refuses outright when the manifest declares a policy with
   `requires:` without `grounding-mcp` wired under `tools.mcp`;
   `operator_only: true` policies deny without querying the ledger and
   do not need grounding-mcp. Wire `grounding-mcp` or drop the
   evidence-consuming policies. Before the tier-aware posture, every
   unwired evidence policy fell back to the universal non-blocking
   warn-mode.

3. **Hook wiring is not auto-generated for custom policies.** The
   `harness init` wizard only knows about its four named reference
   policies (`review-before-merge`, `dogfood-before-release`, etc.).
   For a custom policy, you write the matching `hooks:` entry
   yourself: a hook with `command: harness policy intercept` and a
   `match:` (or `bash_match:`) that fires on the same tool the
   policy's `trigger` is watching.

4. **The trust model: whoever can write the ledger can open the gate.**
   `requires.ledger_tag` is a substring match against evidence-ledger
   entries, and the gated agent can write those entries directly via
   `mcp__grounding-mcp__ledger_add`. A custom `block` policy is
   therefore **advisory against the agent it gates**: it forces a
   deliberate step (record the review verdict, log the smoke result)
   but does not survive an agent that simply writes the tag. That is
   exactly right for *process gates* — the recipes below, including the
   canonical review-before-merge, are process gates and declare that
   intent in their `producers:` blocks (see the example files). If your
   gate must *enforce* against the agent, the
   evidence has to come from an actor the agent does not control: an
   `ask`-kind producer (the operator's "go" on the prompt is the
   approval), CI, or a distinct trusted process. Two of the four
   builtin packs (`understanding-before-execution`,
   `branch-protection`) were hardened to filesystem markers for
   exactly this reason after a self-approval incident (see
   [`CLI.md`](CLI.md) on branch-protection: "the ledger is
   agent-writable and no longer opens the gate").
   `harness validate` warns when a `block` policy declares no
   `producers:` at all, because then the evidence source is
   undocumented and this trade-off was never made visibly.
   If your gate must be a genuine, unconditional operator-only deny —
   no evidence, agent-executable or not, should EVER satisfy it — see
   "Operator-only unconditional deny" below instead of trying to name
   an unsatisfiable `requires:`.

## Anatomy of a custom policy

Every block-enforcement policy is four parts:

| Part | Where | What |
|------|-------|------|
| **trigger** | `policies[].trigger` | which tool call should the policy look at (event + match + optional bash_match + optional extract) |
| **requires** | `policies[].requires` | which ledger evidence must exist (`ledger_tag`, optional `within`, optional `count.min`); mandatory unless the policy declares `operator_only: true` instead (see below) |
| **hook** | `hooks[]` referenced by `policies[].hook` | the PreToolUse glue that calls `harness policy intercept` so the runtime evaluates the policy |
| **ux** | `policies[].ux` | what the agent sees on a block (`cannot`, `required[]`, `run[]`); omit for the legacy engine-vocabulary envelope, prefer it for anything agent-facing |

The `${VAR}` references inside `requires.ledger_tag` and inside the
`ux:` strings resolve against `trigger.extract` plus the builtin
variables (`SESSION_ID`, `REPO`, `BRANCH`, `TOOL_NAME`, `CWD`). Full
substitution context: [`for-agents.md`](for-agents.md#var-substitution-context).

## Recipe A: review before merge (the canonical pattern)

Block an `agent-tasks` merge call unless a `review:${PR_NUMBER}`
entry has been logged for this session. This is the smallest useful
custom policy and covers most of the moving parts: MCP-tool match,
extract from `toolArgs`, `${VAR}` substitution, and a `ux:` block.

This is a **process gate** (tripwire 4): the agent records the review
verdict itself, so the gate forces the review *step*, it does not
defend against an agent that skips it and writes the tag directly.

Full file: [`docs/examples/policies/01-review-before-merge.yaml`](examples/policies/01-review-before-merge.yaml).
Core:

```yaml
policies:
  - name: review-before-merge
    description: Block PR merge unless a review:${PR_NUMBER} ledger entry exists.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block
    ux:
      cannot: "You cannot merge PR ${PR_NUMBER} yet."
      required: ["a logged review for PR ${PR_NUMBER}"]
      run:
        - "have the reviewer write review:${PR_NUMBER} via mcp__grounding-mcp__ledger_add"
```

`harness dry-run "merge PR 42" --tool mcp__agent-tasks__pull_requests_merge --tool-args '{"prNumber":42}' --config docs/examples/policies/01-review-before-merge.yaml`
reports `review-before-merge` as the matching policy and prints the
substituted `review:42` tag it would look for.

At runtime, the first merge fires `harness policy intercept`, which
looks up `review:42` in the ledger for the current session, finds
nothing, and returns the `ux:` envelope. The reviewer (or a review
subagent) calls `mcp__grounding-mcp__ledger_add` with content
`review:42:approved`. The next merge call lets through, and both
decisions (deny then allow) land in `harness audit` as
`policy_decision` rows.

## Recipe B: gate `git push` on a custom clean-check

The same shape works for any check that produces a per-branch ledger
tag. The example below uses [`slop-detector`](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/slop-detector)
(a multi-pack slop linter from `agent-dx`, shipping `agent-tics`,
`prose-slop`, `comment-slop`, `code-slop`, and `ui-slop`) as the
producer, but the policy itself does not name that tool: substitute
your own check (linter, typechecker, fuzzer, secrets-scan) by
changing the producer command in `ux.run` and the ledger tag.

Full file: [`docs/examples/policies/02-clean-check-before-push.yaml`](examples/policies/02-clean-check-before-push.yaml).
Core:

```yaml
policies:
  - name: clean-check-before-push
    description: Block git push unless a clean-check:${BRANCH} ledger entry was written in the last 10 minutes.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b"
    requires:
      ledger_tag: "clean-check:${BRANCH}"
      within: 10m
    hook: require-clean-check
    enforcement: block
    ux:
      cannot: "You cannot push branch ${BRANCH} without a recent clean check."
      required: ["a clean-check:${BRANCH} ledger entry from the last 10 minutes"]
      run:
        - "slop-detector check . --pack ui-slop,code-slop && mcp__grounding-mcp__ledger_add { tag: clean-check:${BRANCH} }"
```

`--pack` filters slop-detector to a subset of its packs; omit the
flag to run all five.

Like Recipe A this is a process gate (tripwire 4): the checker runs in
the agent's own session, and the agent writes the evidence.

What this recipe adds over Recipe A:

- **`bash_match`** instead of `match` on an MCP tool name. The regex
  filters Bash invocations down to ones that actually run `git push`
  (including via env-prefixed commands, subshells, pipes, `&&`
  chains). `harness dry-run "git push" --tool Bash --tool-args '{"command":"git push origin feat/foo"}'`
  is the way to test these regexes against realistic commands.
- **`${BRANCH}` from builtins.** No `trigger.extract:` block needed;
  the runtime resolves git HEAD automatically.
- **`within: 10m`** as a freshness window. An old clean signal from
  before the last edit does not satisfy the gate.
- **`ux.run` names the producer explicitly.** When the agent reads
  the block, it sees the literal command pair to make the push go
  through.

To use this with a different check, change the `slop-detector` call
in `run:` and the ledger tag prefix. The hook wiring, the trigger
regex, the `within:` value, all transfer.

## Per-policy target resolution: which repository do `${REPO}`/`${BRANCH}`/`at_head` resolve against?

Any policy whose `requires.ledger_tag` references `${REPO}` or `${BRANCH}`,
or that sets `requires.at_head: true`, is evaluated per REPOSITORY, not
once per event (task `98ad072f`). Most policy authors never need to think
about this — Recipe B above already gets it "for free" — but it matters
the moment a `bash_match` trigger can fire on a command that names a git
repository other than the session's own cwd (`git -C <path>`, `env -C
<path> git ...`, a leading `cd <path> &&`).

**Additive, not exclusive.** The session's own cwd is ALWAYS one of the
contexts evaluated, never dropped, regardless of what a command names
elsewhere, with one exception: when the cwd is outside every git
repository (neither its real path nor any ancestor up to the filesystem
root holds an entry named `HEAD` or `.git`, and no lookup there failed
with an error other than ENOENT), `${REPO}` is blank for the policy, and
a segment's own target (or a shell model path, below) resolved to a real
repository, the cwd context is not demanded next to that target and the
target's context is demanded in full (see
`mayBeInsideRepository` in `src/runtime/intercept.ts`). A detached cwd
and every other non-blank cwd context are still never dropped. When a trigger-satisfying segment ALSO names a distinct,
resolvable target (its own `-C`/`env -C`/`--git-dir`, or a target
inherited from a preceding `cd` earlier in the same command), that
target's context is evaluated TOO, side by side with cwd's — the policy's
`requires:` must be satisfied against BOTH for the command to pass. A
single `git -C <B> push` from a checkout of repo A therefore now demands
evidence in EACH repository the command touches, not just the one the
session started in.

**When a target gets attributed.** The engine reads the command through
two independent views and demands the union of what both name (task
`7d4abf84`). The union is built in a fixed order: the per-segment view
decides first, exactly as it does on its own (for a policy one of its
matching forms matched, including the cwd-only demand below and the cwd
context of a working directory outside every repository), and the shell
command model then adds its own demands or a fail-closed verdict; it never
removes a demand the per-segment view made. A policy only the shell
command model's match (below) brought in has no per-segment demand; it is
decided on the model's directories, with the same cwd rule as a segment
target.

The per-segment view re-tests the policy's own `bash_match` against each
segment of the command individually (the same segmentation the trigger
already matched against). A segment is attributed a target when it is
itself one of the segments that satisfies the trigger AND it names (or
inherits) a resolvable directory:

- its own invocation carries exactly one recognised repo-relocating
  option (`-C`, `--git-dir`, or a wrapping `env -C`/`--chdir`), or
- no such option of its own, but a `cd <path>` segment earlier in the
  SAME command genuinely persists to it (real bash semantics — a `cd`
  inside a subshell, before a `cd -`, or before a pipe stage does not
  count; see `command-normalize.ts`'s `CommandSegment.effectiveTarget`
  doc comment for the exact composition rules).

The shell command model (`src/runtime/shell-command-model.ts`) lexes the
command with quotes, escapes and real operator boundaries and computes,
for every simple command, the directories it can run in. A model command
whose decoded text satisfies the trigger on its own, and that names a
directory, demands each of them:

- `cd`, `chdir`, `pushd` and `popd` are read behind `!`, `{`, `time`, the
  compound-command keywords, `builtin`, `command`, `eval` with literal
  arguments, assignments and redirections, with a quoted or escaped
  command word (`\cd`, `c''d`) and with `-L`, `-P` or `--`; `cd -` and
  `popd` return the directory the command left;
- quoted values are decoded (`git -C 'vendor/lib sp' log`,
  `cd "vendor/lib;semi"`, `git '-C' X log`), and a line continuation is
  removed;
- relative paths compose: every `-C` of a git invocation in order, then
  `--git-dir`; `env`'s last `-C`; a `cd` followed by a relative `cd` or
  `-C` (`cd T && git -C sub log` runs in `T/sub`). A plain `cd` step is
  resolved the way the shell computes `$PWD` (a `..` removes the previous
  name), a `cd -P`, `-C`, `env -C` or `--git-dir` step through the real
  directory it starts from (a `..` after a symlink leaves the symlink's
  target);
- `&&`, `||`, `!`, `;`, `&`, pipelines (each element a subshell, the last
  one possibly the current shell, as in zsh), `( )` and substitutions
  (subshells whose own commands are read too), and `if` / `case` branches
  follow the shell's control flow, so `cd X | git log`, `cd X & git log`,
  `(cd X) && git log`, `cd X || git log` and `! cd X && git log` stay with
  the working directory;
- a `cd` or `pushd` may fail (a missing directory), and the shell then
  stays where it was, so a later command can run in either place
  (`cd X; git log` demands the working directory and `X`). The gate drops
  that branch only for a `cd` or `pushd` that meets all of these:
  - it is at the top level of the command (not inside `{ }`, a compound
    command, a subshell or substitution nested in one, a function body or
    an `eval` string), spelled so bash and zsh both run the builtin (`cd`,
    `builtin cd`, `time cd`; not `chdir`, `command cd`, `noglob cd` or
    `time -p cd`), with no redirection of its own and no `-e` or `-@`;
  - a plain `cd` / `pushd` target has every `..` before any name (`..`,
    `../..`, `../x`): bash and zsh fail `cd missing/../x`,
    `cd README.md/../x` and `cd a/../b` when the name is not a directory,
    whatever the lexical result names, so those keep the branch; a
    `cd -P` target is followed through the real directories it names and
    keeps the branch when a `..` leaves something that is not one;
  - no earlier command can have made `cd` or `pushd` something other than
    the builtin: after any function definition (any name, also zsh's
    anonymous `() { ... }`), `enable`, `disable`, `alias`, `unalias`,
    `unfunction`, `hash`, `unhash`, `autoload`, `functions`, `source`, `.`,
    `trap`, a command word or `eval` argument the gate cannot read (`$CMD`,
    `eval "$X"`), or an assignment to zsh's `functions` / `aliases` tables
    or bash's `BASH_ALIASES` / `BASH_CMDS`, every later `cd` keeps its
    branch;
  - its target is an existing directory the gate can enter when the hook
    runs.

  So `cd frontend; npm test; cd ..; git status` in a repository nested
  inside another one runs `git status` in that repository only, while
  `cd missing; npm test; cd ..; git status` can reach the parent and
  demands it, and `cd vendor/lib; cd missing/../../..; git push` or
  `cd vendor/lib; cd() { :; }; cd ../..; git push` demand the nested
  repository the push can run in. Two gaps stay open, and in both the
  per-segment view's demands still stand (the union), so they can drop
  only a demand of the shell command model's own: the check reads the
  filesystem when the hook runs, so a command that removes or renames
  that directory before its `cd` (`mv ../frontend ../fe2; cd
  ../frontend`) is read as if the directory were still there; and the
  hook does not see the shell the command runs in, so functions, aliases
  and options from the shell's startup files or the agent's shell
  environment, a `CDPATH` inherited from the environment (bash searches
  it before the working directory), or physical `cd` (`set -P`, zsh
  `CHASE_LINKS`) can make a `cd` the gate confirmed fail or land
  elsewhere.

The model also adds a match: a per-repo policy whose trigger none of the
other forms matched still applies when a model command that names a
directory satisfies it (`git -C 'vendor/lib sp' log` matched no policy at
all before). Only such policies and only such commands: a gated verb
spelled behind a prefix the trigger does not read (`! git log`,
`{ git log; }`) in a command that names no directory still matches no
policy.

**Cost.** The shell command model is computed at most once per Bash
event and, with any per-repo Bash policy in the manifest (the full
template has four), effectively for every Bash event: such a policy is
either missed by the other matching forms (the model's match is then
tried) or matched (its attribution reads the model), so a command no
policy matches computes it too. Its directories are resolved once per
distinct directory per event, for every policy, under a per-event work
budget (`MAX_MODEL_PATH_WORK` in `src/runtime/shell-model-paths.ts`, 4096
units: one per composition step or path component, per final `realpath`,
per directory check, and per level of the repository lookup for a newly
resolved directory); a command that needs more fails closed (next
section). End to end, a command at the 100000-character input bound is
decided well under a second on the measured shapes, against the 15000 ms
`budget_ms` of the `harness policy intercept` hooks (a hook past its
budget allows), and a command no policy matches pays the model's cost
too; the CHANGELOG entry for task `7d4abf84` records the measurement,
including one for such a command.

**Fallback to cwd only (no distinct second context).** A command still
evaluates against the session's cwd alone — identical to a policy with no
attribution at all — whenever:

- the policy has no `bash_match` trigger (an MCP-tool-triggered policy:
  attribution is a Bash-command concept only);
- the whole-command match came ONLY from the ampersand-aware third
  normalisation arm (a bare `&` boundary the primary segmentation cannot
  itself split on) — no individual segment can be attributed;
- the trigger matched the WHOLE, unsplit command text (a malformed
  `bash_match` regex, or one whose match genuinely spans more than one
  segment) rather than any single segment;
- the named directory is the home directory (a bare `cd`, or a `~` or
  `~/...` value) and the command does not assign `HOME` anywhere (see the
  next section), or the invocation names only `--work-tree` (it does not
  relocate the git-dir, so it never proves a target);
- the named target resolves to the SAME repository identity as cwd (a
  subdirectory of the cwd repo reached via `-C`, or a symlink into it) —
  this collapses into the single cwd context rather than a spurious
  duplicate;
- the named target is not inside any git repository at all.

**Fail closed: a target the gate refuses to read (tasks `cfb6b390`,
`7d4abf84`).** One kind of unattributable target is NOT left at the cwd
fallback above, because the command then really runs in some nested
repository and the cwd repository's evidence would stand in for it. A
`-C`, `--git-dir` or `env -C` value (every `-C`, not only the first, and
a `~`-prefixed one too), or an argument of a `cd`, `pushd` or `popd` in
a shape the gate recognises (flags and redirections after it; a `{` or
`!`, `builtin`, `command`, `eval`, `time`, a compound-command keyword
such as `if`, `then`, `do` or `else`, or a `VAR=value` assignment in
front of it), that holds

- a backtick (quoted, escaped or a command substitution),
- an ANSI-C quoted value (`$'...'`, which decodes escapes such as `\x60`)
  or a locale quoted value (`$"..."`: bash looks its text up in a locale
  catalogue that can translate it into a different name; zsh reads it as
  a literal `$` followed by a double-quoted string, so there the rule
  over-blocks), counted only where the `$` itself is unquoted and
  unescaped (`git -C 'a$' log` and `cd "a$"` are plain quoted values), or
- a control, format or separator character (C0, DEL, C1, zero-width and
  bidirectional controls, U+2028, U+2029, the byte order mark) in an
  otherwise unattributable value (a quoted or `~` value; an unquoted path
  holding such a character is attributed to that literal directory),

makes the policy fail CLOSED for that command: one deny (or the policy's
own `warn` enforcement) with the reason "cannot attribute", recorded
without querying the ledger. The same holds for a later command that
inherits the directory of such a `cd` or names a relative or dynamic
target against it, through any later `cd` form, `cd -`, `popd` or a
`||`. The shell command model fails closed the same way for:

- an unquoted glob in a target (`cd vendor/libpl*`, `git -C x? log`, a
  `[...]` class, a brace expansion with `,` or `..`); expanding it
  against the filesystem instead is a follow-up;
- a relative `cd` or `pushd` target while a `CDPATH` assignment made in
  the same command is in effect (inline, as a statement, or through
  `export` / `declare`); a `CDPATH` inherited from the environment is
  not visible to the gate;
- a target that depends on a value the gate cannot resolve (task
  `e927e903`): a `cd`, `pushd`, `git -C`, `env -C` or `--git-dir` value
  that is only known at run time (a variable, a command substitution or
  an arithmetic expansion, also next to literal text); in any of those
  values, a tilde prefix other than `~` and `~/...` (`~+`, `~-`, `~N`,
  `~+N`, `~-N`, `~NAME`); a `cd -` or `pushd -` before any directory
  change of the command (the session's previous directory); a bare `cd`,
  a `~` or `~/...` value, zsh's `pushd` with an empty stack (they read
  `HOME`), or `cd -` and `pushd -` (they read `OLDPWD`), when the same
  command assigns that variable anywhere (an assignment, a
  default-assigning or arithmetic expansion, the name operand of an
  assigning builtin such as `read` or `printf -v`, a `for` variable or a
  `{NAME}` redirection), also after the directory change in the text
  (the assignment can run first, in a later loop iteration or before a
  function that is called after it), inside a subshell or in front of
  another command (a function that subshell or command calls reads the
  value); and a `cd +N` / `cd -N`, which zsh reads as a stack entry and
  bash as a path an earlier command of the line can create. A `cd -` or
  `popd` after a directory change whose target fails closed keeps that
  possibility for the commands after it, because the return itself can
  fail and leave the shell where it was; joining the return and the next
  command with `&&` keeps that failure branch out;
- a loop whose body changes directory relative to where it is (a later
  iteration starts somewhere the command text does not name), for the
  commands after the loop and for the commands inside it;
- more than 8 possible directories for one command, or a composed path
  longer than 4096 characters;
- directories that need more than the per-event work budget to resolve
  (see Cost above): many distinct directories only the shell command
  model names (the tests pin 1000 `git '-C' <dir>` commands as failing
  closed and 10 as decided normally; the limit depends on how deep the
  directories are), or a chain of 2000 `cd` steps;
- a command line the model cannot lex but that may still run (for
  example subshells nested deeper than 8 levels), or one longer than the
  100000-character normalisation bound, when its text holds a
  directory-changing word (`cd`, `pushd`, `popd`, `chdir`, `-C`,
  `--chdir`, `--git-dir`, also partly quoted).

The reason for failing closed rather than guessing is that the gate
cannot name the directory, so it cannot name the repository whose
evidence is needed. No evidence can clear it, neither the cwd repository's
tag nor the nested repository's own. The remedy is to name the repository
with a plain path (`git -C <path> ...`, or `cd <path> && ...`) or to run
the command from inside it.

This over-blocks some commands that are in fact harmless: a backtick
command substitution such as ``git -C `pwd` log`` or ``cd `git rev-parse
--show-toplevel` ``, an ANSI-C or locale quoted value even when it spells a
plain path (`git -C $'vendor/ok' log`), a `cd` or `pushd` with such a value
that has nothing to do with the gated verb later in the command, a path
that really does contain a backtick, a glob that matches exactly one
directory, a `CDPATH` search, a `cd` or `-C` into a variable or a
command substitution that names the repository the command already runs
in (its top level, a loop over directories), a `cd` into `$HOME/...`
(the `~/...` spelling keeps the fallback), a tilde prefix such as `~+`
that names the working directory, a `cd -` before any other directory
change of the command, a home-directory target in a command that assigns
`HOME` only after it, in a subshell or for another command, a loop such as
`for d in a b; do cd "$d"; git status; cd ..; done`, and a command past
the work budget. Plain unquoted paths,
quoted plain paths and a backtick that is not a target (a `--grep='...'`
or a commit message) are unaffected. A command whose gated verb never
runs can also gain a demand or fail closed (a `git -C a -C b` where `b`
does not exist below `a`, a verb inside `while false; do ...; done`).
The CHANGELOG entry for task `7d4abf84` records how often each of these
occurred on the review corpora it was measured against.

Still the cwd fallback: the home directory when the command does not
assign `HOME` (see above), the previous directory after a `cd` that
failed (the shell keeps the previous directory it had, the gate reads
the directory before that `cd`), a `GIT_DIR=` or `GIT_WORK_TREE=`
assignment, a nested shell (`bash -c '...'`), `source`, a function call
(beyond the `HOME` and `OLDPWD` rule above), `sudo -D`, a variable whose
name is built at run time, `CDPATH` or `HOME` inherited from the
environment, and a gated verb whose own head
is spelled behind a prefix the trigger does not read (`! git log`,
`{ git log; }`, `eval git log`) in a command that names no directory,
which matches no policy at all: matching those is a follow-up.

**The cross-repo consequence.** Because attribution is additive, holding
evidence for ONLY the target repository named by a `-C`/`cd` is no longer
enough to satisfy a per-repo policy — the session's own cwd repo needs its
own evidence too, and vice versa. If your workflow legitimately runs
`git -C <other-repo> ...` (a monorepo helper script, a multi-repo release
script, CI tooling), record the evidence the policy requires (run its
producer, or `ledger_add` its tag) for BOTH repositories before the gated
verb, not only the one the command names.

**The bound.** A single event naming more than 4 distinct repository
targets for one policy fails CLOSED — one deny (or the policy's own
`warn`/`require_approval` enforcement) naming the ambiguity, without
querying the ledger for any of them — rather than silently evaluating an
unbounded number of contexts.

## Recipe C: operator-only unconditional deny (no self-satisfiable `requires:`)

Recipes A and B are **process gates** (tripwire 4): they name a
`requires.ledger_tag` the gated agent can write itself via
`mcp__grounding-mcp__ledger_add`, so the gate forces a step but does
not survive an agent that skips it and writes the tag directly. That
is the right shape for "make the agent do the review/check step
first." It is the wrong shape for "the agent may NEVER do this, full
stop" — there is no `ledger_tag` you can name for that intent that
isn't itself something the agent could forge.

`operator_only: true` (task 2cc73f55) is the schema's way of expressing
that second intent honestly: the policy declares **no `requires:` at
all**, and `harness policy intercept` denies unconditionally, without
ever querying the evidence ledger. There is no ledger write, marker
file, or env flag that flips it to allow — the runtime never looks.

```yaml
policies:
  - name: deny-kill-switch-bypass
    description: Deny harness pause / harness resume from the agent's Bash tool.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&|\()\s*(\w+=\S*\s+)*harness\s+(pause|resume)\b'
    operator_only: true
    hook: deny-kill-switch-bash
    enforcement: block
    ux:
      cannot: "You cannot run `harness pause` or `harness resume`."
      required:
        - "the OPERATOR to run this from a terminal genuinely outside your agent session"
      run:
        - "Stop. Ask the operator to run it themselves; this gate cannot be satisfied from inside the session."
```

Rules the schema enforces:

- **`operator_only: true` and `requires:` are mutually exclusive.**
  Declaring both is rejected — an unconditional deny that also names
  in-session-satisfiable evidence is self-contradictory.
- **Restricted to `enforcement: block`.** `warn` and `require_approval`
  already have their own always-evaluated evidence paths;
  `require_approval`'s canonical unblock is the `harness approve risk`
  operator verb, not a requires-satisfaction story this marker would
  replace.
- **`harness validate` does not warn** about a missing `producers:` for
  an `operator_only: true` policy (`checkPolicySelfAttestation` treats
  it as correct-by-construction: there is no undocumented evidence
  source to flag, because there is no evidence source at all).

What this recipe does **not** fix: `bash_match` is still a regex over
the raw command string, matched at the *trigger* layer, before
`operator_only:` is ever consulted. An agent that defeats the trigger
match (a heredoc, `sh -c '...'`, a base64-decoded payload, a script
file it writes and then executes) never reaches this deny at all —
`operator_only: true` closes the *evidence-satisfaction* hole, not the
*trigger-matching-coverage* hole. See the three `deny-*` kill-switch
policies in `docs/examples/full-manifest.yaml` /
`src/cli/init/templates.ts` for the full worked example, and
`tests/cli/init-full-template-kill-switch-deny.test.ts` for a test that
forges every ledger-evidence shape available to `intercept()` and
confirms none of them satisfy the gate.

## Variations

### Two reviewers (Recipe A + `count.min: 2`)

Add `count: { min: 2 }` under `requires` to demand N entries instead
of one. Full file:
[`docs/examples/policies/03-two-reviewers-required.yaml`](examples/policies/03-two-reviewers-required.yaml).

```yaml
requires:
  ledger_tag: "review:${PR_NUMBER}"
  count:
    min: 2
```

`count.min: 0` is rejected at validate time as a no-op. There is no
`max:` in v1; if you need "exactly N", `count.min: N` plus an
external check is the current workaround.

### A custom MCP tool from your org (Recipe A on a non-`agent-tasks` MCP)

Register the MCP in `tools.mcp[]`, then point `trigger.match` at its
tool name (`mcp__<server>__<tool>`). The policy engine has no
allowlist of "known" servers. Full file:
[`docs/examples/policies/04-custom-mcp-tool.yaml`](examples/policies/04-custom-mcp-tool.yaml).

```yaml
trigger:
  event: PreToolUse
  match: "mcp__myorg-ops__deploy_service"
  extract:
    SERVICE: "toolArgs.service"
```

### One tool, two modes: `trigger.input_match`

`match` filters on the tool NAME. When the same verb is sometimes
dangerous and sometimes not, that is too coarse. The motivating case is
`mcp__agent-tasks__task_finish`: called plainly it advances a task and
merges nothing, called with `autoMerge: true` it merges the PR. Gating
the tool name alone would either block every ordinary finish call or
leave the merging one uncovered.

`trigger.input_match` narrows the trigger by the tool call's own
arguments:

```yaml
trigger:
  event: PreToolUse
  match: "mcp__agent-tasks__task_finish"
  input_match:
    toolArgs.autoMerge: true
  extract:
    TASK_ID: "toolArgs.taskId"
```

Grammar and semantics:

- **Keys are extract expressions**, the same DSL `trigger.extract`
  uses (`<segment>` or `["quoted key"]` accessors, no function calls,
  no array indices), restricted to the `toolArgs.` namespace. An
  `event.` / `session.` / `git.` key is a `harness validate` error,
  not a predicate that quietly never fires.
- **Values are literals**: string, number, or boolean. No regex, no
  truthiness. An object, an array, or `null` is rejected.
- **Comparison is strict equality**, same JSON type and same value.
  `autoMerge: "true"` (a string) does not satisfy `autoMerge: true`.
- **Every entry must hold** (they are ANDed with each other and with
  `match` / `path_match` / `bash_match`).
- **A missing path never matches.** An argument the caller omitted
  leaves the narrowed policy out of the way rather than arming it.
- **An empty map is rejected** as a silent no-op.

`harness policy dry-run --tool mcp__agent-tasks__task_finish --tool-args
'{"taskId":"...","autoMerge":true}'` predicts exactly what `harness
policy intercept` decides, and a non-matching payload comes back in the
"could match" bucket with the failing entry named.

### Same gate, two PR-surface variants (MCP plus gh-cli)

`review-before-merge` matches `mcp__agent-tasks__pull_requests_merge`. If
your team also uses `gh pr merge` from the shell, that path is unguarded
unless you ship a parallel policy. A `PolicyTrigger` can only AND-match
one surface (MCP tool-name OR Bash command), so the minimum-scope answer
is a second policy with the same `requires.ledger_tag` shape but a Bash
trigger. The full template (`docs/examples/full-manifest.yaml`) ships
both: `review-before-merge` plus `review-before-merge-bash`, and the
analogous pair for `pull_requests_create` / `gh pr create`.

The tag shape differs by necessity. The MCP variant can extract
`PR_NUMBER` from `toolArgs.prNumber`; the Bash variant cannot, because
the extract DSL is JSONPath against tool args, not regex against
`tool_input.command`. The closest stable identifier on the Bash side is
the builtin `${BRANCH}`. So a hybrid operator who uses both surfaces
has both gates active with two tag shapes (`review:42` for the MCP
merge, `review:feat/foo` for the `gh pr merge`), which is honest at the
ledger layer.

```yaml
policies:
  - name: review-before-merge-bash
    description: Block `gh pr merge` unless a review:${BRANCH} ledger entry exists.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&|\()\s*(\w+=\S+\s+)*gh pr merge\b'
    requires:
      ledger_tag: "review:${BRANCH}"
    hook: require-review-evidence-bash
    enforcement: block
    ux:
      cannot: "You cannot merge the PR for branch ${BRANCH} via `gh pr merge` yet."
      required:
        - "a recorded review of the PR for branch ${BRANCH}"
      run:
        - 'mcp__grounding-mcp__ledger_add { sessionId: "${SESSION_ID}", type: "fact", content: "review:${BRANCH} — <verdict + key findings + nits>" }'
```

If your workflow only uses one surface, ship only that policy. The
parallel definitions are a per-surface opt-in, not a coupled pair.

### `ux:` versus `producers:`

`ux:` is what the agent reads. `producers:` is a structured
remediation hint that gets appended to the engine-vocabulary deny
envelope when `ux:` is *not* set; when both are set, `ux:` wins the
agent-facing surface and `producers:` still feeds `explain --trace`.

Declare `producers:` on every `block` policy even when `ux:` is set:
it is the operator-visible statement of the intended evidence flow
(tripwire 4 — the trust model), and `harness validate` warns when a
`block` policy has none. Use `ux:` for the agent-facing wording on
top of it.

## Author loop

The four CLI verbs you cycle through while writing a policy:

```bash
harness validate --config <path>      # schema + ${VAR} reference check, run first
harness dry-run "<description>" \     # tells you which policies would match
  --tool <tool-name> \                # without touching the ledger
  --tool-args '<json>' \
  --config <path>
harness apply                         # wire the policy into ~/.claude/settings.json
harness explain <policy-name> --trace # after the first real fire, the full trace
```

Run `validate` after every edit; `dry-run` whenever you change a
trigger or extract. Wait until both pass before `apply`. `explain`
is for after the policy has fired at least once and you want the
full ledger query, extract substitutions, and match trace.

## Field reference

| Field | Required | Notes |
|------|----------|-------|
| `policies[].name` | yes | Unique within `policies:`. Used by `explain` and audit rows. |
| `policies[].description` | yes | One line. Shows up in `harness describe` and audit context. |
| `policies[].trigger.event` | yes | `PreToolUse` for blockers (the most common). Other events parse but rarely make sense for `requires` gates. |
| `policies[].trigger.match` | optional | Substring match against the tool name. For MCP tools: `mcp__<server>__<tool>`. For built-ins: `Bash`, `Edit`, `Write`, ... |
| `policies[].trigger.bash_match` | optional | Regex against `toolArgs.command` when `match: Bash`. Anchor at command start (`^` or `(^|\n|;|\\||&|\\()`) to catch env-prefixes and subshells. |
| `policies[].trigger.path_match` | optional | Regex against file paths for Edit/Write/MultiEdit triggers. |
| `policies[].trigger.input_match` | optional | Map of a `toolArgs.`-namespaced extract expression to a literal (`string`/`number`/`boolean`), compared by strict equality and ANDed with the other trigger fields. Narrows a trigger to one MODE of a tool (`task_finish` with `autoMerge: true`). A missing path never matches; an empty map is rejected. |
| `policies[].trigger.extract` | optional | Map of `${VAR}` → JSONPath against the tool payload. Required if `ledger_tag` references a non-builtin `${VAR}`. |
| `policies[].requires.ledger_tag` | yes, unless `operator_only: true` | Tag the runtime queries grounding-mcp for. Substring/regex against ledger `content`. |
| `policies[].requires.within` | optional | Duration string (`10m`, `1h`, `24h`, `PT1H`, `86400s`). Filters to entries created in this window. |
| `policies[].requires.count.min` | optional | Minimum number of matching entries. `0` is rejected. |
| `policies[].operator_only` | optional | `true` declares an unconditional operator-only deny: no `requires:` at all, never queries the ledger, no in-session evidence can ever satisfy it. Mutually exclusive with `requires:`; only valid with `enforcement: block`. See [Recipe C](#recipe-c-operator-only-unconditional-deny-no-self-satisfiable-requires). |
| `policies[].hook` | yes | Name of a `hooks[]` entry whose `command: harness policy intercept` actually invokes the runtime. |
| `policies[].enforcement` | yes | `block`, `warn`, or `require_approval`. `warn` logs a `policy_decision` row but lets the tool call through. |
| `policies[].ux.cannot` | optional | One-line block message for the agent. `${VAR}` references substitute. |
| `policies[].ux.required` | optional | Array of plain-words preconditions. |
| `policies[].ux.run` | optional | Array of literal commands the agent can run to satisfy the gate. |
| `policies[].producers` | optional | Structured remediation hint shown when `ux:` is unset. At least one `kind: mcp` producer is required if set (so a Bash-locked-down agent still has a recovery path). |

Schema source of truth: [`src/schema/policies.ts`](../src/schema/policies.ts).
Acceptance criteria for each `requires` shape:
[`ROADMAP.md` Phase 4](ROADMAP.md#phase-4-policy-layer).

## See also

- [`for-agents.md`](for-agents.md): how agents read the policy/ledger contract, the audit triumvirate, the `ux:` rendering spec.
- [`for-humans.md`](for-humans.md): operator path from install to first `apply`.
- [`policy-packs/understanding-before-execution.md`](policy-packs/understanding-before-execution.md), [`policy-packs/branch-protection.md`](policy-packs/branch-protection.md): the two builtin packs, plus the future contract for custom-pack sources.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) Appendix A: full reference manifest.
