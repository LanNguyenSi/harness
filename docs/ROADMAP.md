# Roadmap

This document turns the four phases sketched in [`README.md`](../README.md)'s status checklist into testable acceptance criteria. It is downstream of [`VISION.md`](VISION.md) (the *why*) and [`ARCHITECTURE.md`](ARCHITECTURE.md) (the *what*); both are inputs, not variables.

Each phase below ships in this shape:

- **Scope** — what this phase delivers, in plain English.
- **Deliverables** — concrete artefacts: CLI verbs, schema fields, file outputs.
- **Acceptance criteria** — testable bullets that answer "how do I know this phase is done?". Each is either scriptable or human-verifiable from a single command's output.
- **Non-goals** — what is explicitly *not* in this phase, especially items a reader might expect.
- **Exit gate** — the one-line statement of when this phase is releasable.

## Phase ordering rationale

The order is deliberate: read-only inventory → managed edits → declarative truth → policy layer. The full justification lives in [`VISION.md` §8](VISION.md#8-why-introspection-comes-before-enforcement) ("Why introspection comes before enforcement"). In short: you cannot enforce policies on a configuration surface you cannot read, and Phase 1's `harness doctor` already delivers user-visible value (worked demo in [`ARCHITECTURE.md` Appendix D](ARCHITECTURE.md#appendix-d--phase-1-value-demonstration)). Inverting the order would make every false-positive policy fire its own debugging incident.

## Phase 1 — Read-only inventory

### Scope

Build the floor. Phase 1 ships every read-only capability needed to answer "what is this harness configured to do, right now, comprehensively?" — across the manifest, MCP servers, CLI tools, skills, memory directories, hooks, and policies. Nothing in Phase 1 writes to disk or executes a hook. Schema validation happens; behaviour does not. The killer-test value-demo from `ARCHITECTURE.md` Appendix D is the user-visible outcome.

### Deliverables

CLI verbs (per `ARCHITECTURE.md` §9 "Read-only"):

- `harness describe [--project <name>] [--pillar <p>] [--json]` — print the effective merged manifest.
- `harness validate [--project <name>] [--strict]` — schema lint plus referenced-asset checks; exit 1 on error.
- `harness doctor [--project <name>]` — human-readable health summary across all pillars.
- `harness list <category> [--filter <s>] [--json]` — denormalised flat listing per category, pipe-friendly.
- `harness explain <policy-name>` — surface what a named policy *would* evaluate to (schema-only; full trace including last-evaluation result lands in Phase 4 once policies actually fire).
- `harness diff [--since <ref>]` — manifest-layer diff against a git ref. (`--since-apply` is Phase 3.)

Library-side:

- `version: 1` manifest schema parser (zod-based) covering all five pillars.
- Per-machine override layer per `ARCHITECTURE.md` §8: discovery via `<hostname>` / `<os>` / `default`, merge order base → os → hostname → project.
- Memory router introspection: read frontmatter, surface stale memories per `retention.staleness_days`.
- MCP health probe: real network/process call to each `mcp[].health.verb` with the configured `timeout_ms`.

### Acceptance criteria

- [ ] `harness describe` reproduces the merged manifest for a real test fixture (`docs/examples/full-manifest.yaml`) byte-equivalent to the hand-merged expected output.
- [ ] `harness validate` exits 1 on every malformed manifest under `docs/examples/invalid/*` and 0 on `docs/examples/full-manifest.yaml`. Each invalid fixture has a one-line comment explaining what is wrong.
- [ ] `harness validate --strict` rejects unknown keys per `ARCHITECTURE.md` §11 (Phase 1 strict default).
- [ ] `harness validate` rejects a `policies[].requires` entry that references `${PR_NUMBER}` without a matching `trigger.extract:` entry. (Schema-level rejection — the policy never fires in Phase 1, but malformed policies are caught at lint time.)
- [ ] `harness doctor` against the test fixture reproduces the structure shown in `ARCHITECTURE.md` Appendix D: a section per pillar (Manifest / Tools / Memory / Hooks / Policies / Summary), each with `✓ / ⚠ / ✗` status markers.
- [ ] `harness doctor` issues a real MCP health-verb call against each declared `mcp[]` entry; a server that exited 1 surfaces with the actual error message in the output, not a generic "unhealthy".
- [ ] `harness doctor` flags memories untouched for more than `retention.staleness_days` with their last-touched date.
- [ ] `harness diff --since master` against a manifest with one changed `mcp[].command` value emits exactly one diff hunk on that field.
- [ ] `harness list mcp` and `harness list policies --json` produce JSON parsable by `jq` with no extra prose lines on stdout.
- [ ] Per-machine override layer resolves correctly: a fixture with `~/.claude/harness.yaml` + `~/.claude/machines/wsl2.harness.overrides.yaml` produces the WSL2-merged manifest when `WSL_INTEROP=...` (or `/proc/version` containing `microsoft`) is set, and the bare manifest otherwise.
- [ ] Vitest suite covers schema parsing, override merging, MCP health-probe timeout, and stale-memory detection. ≥ 90% line coverage on `src/`.
- [ ] `npm run typecheck` and `npm test` are green on Node 20 LTS in CI.

### Non-goals

- **Hook execution.** `harness doctor` reports that a hook is wired but does not execute it. The hook actually firing on its event is Phase 4.
- **Policy evaluation.** `harness validate` lints `policies[]` for schema and reference correctness; it does not check whether `requires` would be satisfied. Policies don't fire until Phase 4.
- **Writing files.** Phase 1 reads `~/.claude/harness.yaml` and asset files; it never writes. `harness add`, `harness apply`, `harness adopt` are Phase 2 / 3 verbs.
- **Lock file.** `harness.lock` is a Phase 3 artefact; Phase 1's "single source of truth" claim applies at the manifest layer only, per `VISION.md` §4.
- **Asset-content drift detection.** `harness diff` shows manifest-level changes; "the SHA of `git-preflight.sh` changed under your feet" is a Phase 3 capability that needs the lock file.

### Exit gate

`harness doctor` against my real `~/.claude/harness.yaml` (≥ 3 MCP servers, ≥ 2 CLI tools, ≥ 4 skills, ≥ 2 hooks, ≥ 2 policies) reproduces a structurally-equivalent output to `ARCHITECTURE.md` Appendix D, with at least one ✗ surfaced when an MCP server is intentionally broken. Tag `v0.1.0`.

## Phase 2 — Managed edits

### Scope

Add the write-side verbs that mutate `~/.claude/harness.yaml` safely: bootstrap a manifest, add or remove entries by name with schema validation, capture hand-edits from runtime files into the manifest. Concurrent-edit safety via a lock file. No regeneration of runtime files yet — that's Phase 3.

### Deliverables

CLI verbs:

- `harness init [--template minimal|full] [--force]` — bootstrap `~/.claude/harness.yaml` from a template.
- `harness add mcp <name> [--command <cmd>] [--health-verb <v>] ...` — managed insert into `tools.mcp[]`.
- `harness add cli <name> --binary <b> [--required]` — managed insert into `tools.cli[]`.
- `harness add skill <name>` — managed enable in `tools.skills.enabled`.
- `harness add hook <name> --event <e> --command <c> [--match <r>] [--blocking <m>]` — managed insert into `hooks[]`.
- `harness remove <type> <name>` — remove by name with reference-check (refuses if a policy references a hook being removed; user must `--force` or remove the policy first).
- `harness adopt <file>` — capture hand-edits from a runtime file (today: `~/.claude/settings.json`) back into the manifest. Implementation: write-and-confirm (see "Open decisions resolved here" below).
- `harness export [--sanitize] [-o <file>]` — emit the effective manifest as a single self-contained YAML.

Library-side:

- File-lock coordination (`~/.claude/.harness.lock` flock) so two `harness add` invocations don't race.
- Schema-validate-before-write: every `add` runs `validate` against the proposed merged manifest and refuses on error before touching disk.
- Patch-emit module: produces a unified diff of the proposed manifest change for `adopt` and `add --dry-run`.

### Acceptance criteria

- [ ] `harness init --template minimal` creates a `~/.claude/harness.yaml` containing only the required `version: 1` header and a comment block explaining where to add the first entry. `harness validate` immediately passes.
- [ ] `harness init --template full` creates a manifest pre-populated with the `tools.mcp` / `tools.cli` / `tools.skills` / `hooks` / `policies` example values from `ARCHITECTURE.md` Appendix A.
- [ ] `harness init` refuses to overwrite an existing manifest without `--force`; prints a one-line message including the existing file's path.
- [ ] `harness add mcp <name> --command "..." --health-verb v` mutates `~/.claude/harness.yaml` to include the new entry, schema-validating before the write. After the call, `harness describe` shows the new entry.
- [ ] `harness add hook X --event SessionStart --command ./foo.sh` followed by `harness validate` passes; same call without `+x` on `./foo.sh` causes `validate` (and therefore `add`) to fail.
- [ ] Two concurrent `harness add` invocations cannot both succeed: the second blocks on `flock` and reads the manifest *after* the first commits. Vitest covers this with a forked-child harness.
- [ ] `harness remove hook require-review-evidence` while a policy references it: refuses with a one-line "policy `review-before-merge` references this hook; remove the policy first or pass `--force`".
- [ ] `harness adopt ~/.claude/settings.json` against a fixture where the on-disk file has one extra hook compared to `harness.generated/.last-apply` produces a unified diff of the proposed manifest patch and prompts `Apply (y/N)?`. On `y`, the manifest gains the missing hook. On `N`, the file is unchanged. (Decision: write-and-confirm.)
- [ ] `harness adopt` with no on-disk drift exits 0 with `nothing to adopt` and writes nothing.
- [ ] `harness export --sanitize` strips `OPENAI_API_KEY`-style env values from the emitted manifest while preserving structure.
- [ ] Schema-validation-before-write blocks an `add` that would create a duplicate `name` in any name-keyed list.
- [ ] Vitest suite covers init / add / remove / adopt / export, including the flock race condition.

### Non-goals

- **No regeneration of `~/.claude/settings.json`.** Phase 2's `harness adopt` reads it; nothing in Phase 2 writes it. `harness apply` is Phase 3.
- **No lock file.** `harness.lock` (asset SHAs) ships in Phase 3. Phase 2 writes only `~/.claude/harness.yaml` itself.
- **No automatic restart of MCP servers or runtimes.** `harness add mcp <name>` updates the manifest only; the user has to `/mcp reconnect` (or equivalent) themselves. Auto-reload is deferred to Phase 4 if it lands at all.
- **No interactive editor mode.** `harness adopt` does not drop the user into `$EDITOR`; it shows a diff and prompts y/N. The "edit the patch interactively" pattern is power-user-only and not in scope.
- **No policy authoring helpers.** `harness add policy` is intentionally absent in Phase 2 because policies don't fire until Phase 4; encouraging policy creation here would create the schema-without-behaviour failure mode.

### Exit gate

I can bootstrap a fresh harness install (`harness init --template full`), add a new MCP server, capture a hand-edited `settings.json` change into the manifest, and have `harness validate` pass at every step. Tag `v0.2.0`.

## Phase 3 — Declarative truth

### Scope

Make the manifest the source of truth at the runtime layer too. `harness apply` regenerates `~/.claude/settings.json` from the manifest, with three-state drift detection from `ARCHITECTURE.md` §7 protecting hand-edits. The `harness.lock` file pins SHAs of every referenced asset (hook scripts, MCP entrypoints, memory router binary, skill source dirs) so asset-content drift becomes diff-able.

### Deliverables

CLI verbs:

- `harness apply [--dry-run] [--overwrite-drift]` — regenerate `harness.generated/settings.json` and `harness.generated/MEMORY.md` index from the manifest, with drift-detection per `ARCHITECTURE.md` §7. `--dry-run` prints the would-be diff; `--overwrite-drift` discards on-disk changes after a confirmation.
- `harness diff --since-apply` — diff against the last applied state recorded in `harness.generated/.last-apply`.

Library-side:

- Three-state comparator: manifest-expected / last-applied / on-disk-current per `ARCHITECTURE.md` §7 decision tree.
- `harness.lock` writer: SHA-256 of every referenced file path on disk (decision: every referenced path, not only executables; see "Open decisions resolved here"). Lock format is line-oriented JSON for diff-friendliness.
- `harness.lock` reader: on subsequent `apply` runs, compare current asset SHAs against locked SHAs and surface drift per asset.
- `harness.generated/.last-apply` tracker: stores a copy of every generated file plus its hash at apply time.
- Restart-hint emitter: after `apply`, prints which runtime actions the user must take ("MCP servers changed; `/mcp reconnect` recommended", "memory router command changed; restart the session for new hooks").

### Acceptance criteria

- [ ] `harness apply --dry-run` against an unmodified manifest reports `no changes` and exits 0.
- [ ] `harness apply` on a fresh install (no `~/.claude/settings.json` and no `.last-apply` record) writes `harness.generated/settings.json` with the manifest-expected content. Subsequent `harness apply` is a no-op.
- [ ] `harness apply` after a hand-edit to `~/.claude/settings.json` (drift) refuses with exit 1, prints the unified diff between `.last-apply` and on-disk, and the message: `run "harness adopt ~/.claude/settings.json" to capture changes, or re-run with --overwrite-drift to discard them`.
- [ ] `harness apply --overwrite-drift` after a hand-edit prompts for explicit `yes` confirmation before discarding on-disk changes.
- [ ] `harness.lock` is written next to `harness.yaml` and contains a SHA-256 entry for every file path referenced by the effective manifest (every `mcp[].command[]` path that exists, every `hooks[].command` path, every memory directory contents, every skill `SKILL.md` path).
- [ ] `harness apply` after `git-preflight.sh` is edited externally (touched, contents changed) detects the SHA mismatch against `harness.lock` and surfaces it in the apply output with the message: `asset drift detected: ~/.claude/hooks/git-preflight.sh changed since last apply`.
- [ ] `harness diff --since-apply` against the same drift produces a per-asset summary listing which files changed.
- [ ] `~/.claude/settings.json` regenerated from the manifest produces a syntactically-valid JSON document that Claude Code accepts on next session start. Validated by parsing in Vitest.
- [ ] Restart-hint emitter prints the right hints: changing `mcp[]` triggers an MCP-restart hint, changing `memory.router.command` triggers a session-restart hint, changing only a `description` field triggers no hints.
- [ ] `harness apply` is idempotent: running it twice in a row produces identical files and an empty diff.
- [ ] Vitest covers all branches of the three-state decision tree, lock-file write/read, and restart-hint emission.

### Non-goals

- **No CLAUDE.md generation.** `~/.claude/CLAUDE.md` and per-repo `CLAUDE.md` files stay user-owned; Phase 3 reads them, never writes them. The §7 file-layout entry for these is "user-owned, drift-handling does not apply".
- **No memory file generation.** Memory markdown files in `projects/*/memory/` stay user-owned; only `harness.generated/MEMORY.md` (the *index*) is generated.
- **No policy enforcement.** Policies are still schema-only in Phase 3. They're written to `harness.generated/settings.json`'s `hooks` section as their referenced hook scripts, but `requires` evaluation lands in Phase 4.
- **No semver pinning.** `harness.lock` records content SHAs only. Version-pinning of MCP packages or CLI tools (e.g. `tools.cli[].min_version`) is checked at `validate` time, not pinned in the lock.
- **No remote sync.** Lock and manifest are local; no fetching of upstream policy bundles, no team-shared lockfiles.

### Exit gate

`harness apply` regenerates `~/.claude/settings.json` from my real manifest, the lock file catches an externally-edited hook script on the next apply with a helpful diff, and `harness adopt` round-trips a hand-edit cleanly. Tag `v0.3.0`.

## Phase 4 — Policy layer

### Scope

Make policies *fire*. The `requires` schema (`ledger_tag`, `+ within`, `+ count` from `ARCHITECTURE.md` §6) becomes evaluatable at the actual hook event. `PreToolUse mcp__agent-tasks__pull_requests_merge` triggers `review-before-merge`, which queries the evidence ledger via `${PR_NUMBER}` extracted through `trigger.extract:`, and blocks the tool call if the evidence is missing. The killer-test from the founding incident is fully answered: the agent that tried to declare `agent-grounding` tasks "stale" against a 16-commit-behind checkout would be blocked by a `requires.evidence: { ledger_tag: "preflight:${REPO}" }` policy attached to a `Bash` event matching `git status` or similar.

### Deliverables

CLI verbs:

- `harness explain <policy-name> --trace` — full trace of the last evaluation: trigger match result, `extract` substitution trail, ledger query, requires-shape evaluation, final enforcement decision. Essential for diagnosing "why did my merge get blocked".
- `harness audit [--since <when>]` — replay the evidence ledger for a window and cross-reference with harness policy decisions.
- `harness dry-run "<prompt>"` — simulate which hooks fire, which policies match, which memories route for a given user prompt. Requires runtime cooperation; first-pass implementation may be limited to "static prediction without invoking the LLM".

Library-side:

- `requires` evaluator covering all three v1 shapes:
  - `ledger_tag: "review:${PR_NUMBER}"` — substring/regex match against ledger entries' content/source columns.
  - `+ within: 24h` — time-window filter on `created_at`.
  - `+ count: { min: 2 }` — minimum count of matching entries.
- `trigger.extract:` JSONPath-restricted evaluator with `validate`-time grammar check.
- Policy-firing wiring at the runtime hook layer: when a hook bound to a policy fires, harness intercepts, evaluates `requires`, and either lets the hook proceed (allow) or returns the `decision: deny` shape that the runtime understands as a hard block.
- Policy-decision audit log: every fire writes to the evidence ledger as a `policy_decision` entry with `name`, `outcome`, `requires_eval`, `extract_values`. This makes `audit` and `explain --trace` possible.

### Acceptance criteria

- [ ] All three v1 `requires` shapes evaluate correctly:
  - [ ] `ledger_tag: "review:42"` against a ledger containing `{content: "review:42:approved", ...}` matches.
  - [ ] `ledger_tag: "dogfood:gs-pandora-abc" + within: 24h` against an entry created 23h ago matches; same shape against an entry created 25h ago does not match.
  - [ ] `ledger_tag: "review:${PR_NUMBER}" + count: {min: 2}` with two matching ledger entries passes; with one entry fails with the message: `1 of required 2 entries found`.
- [ ] `harness explain review-before-merge --trace` produces a structured trace including: trigger event matched, `extract` substitutions resolved, ledger query SQL (or equivalent), entry-count returned, decision (`block`/`allow`), and timestamp. Reproducible against a fixture session.
- [ ] A real `mcp__agent-tasks__pull_requests_merge` invocation against a session *without* a `review:42` ledger entry is blocked by harness with the policy's `enforcement: block` semantics; the user sees a one-line error referencing the policy name and the missing requires.
- [ ] The same invocation *with* a matching ledger entry passes; the policy decision is logged in the ledger as a `policy_decision` entry visible in `harness audit`.
- [ ] `harness dry-run "merge PR 42"` (or equivalent prompt) statically reports which policies *would* match the resulting tool calls, without actually invoking them.
- [ ] `validate` rejects a manifest with a policy `requires.within` value that is not a valid duration (e.g. `within: yesterday` fails; `within: 24h`, `within: PT1H`, `within: 86400s` all pass).
- [ ] `requires.count.min` of 0 is rejected at `validate` time as a no-op shape (the user should remove the field or use a different policy).
- [ ] When the evidence ledger is unreachable (e.g. database file missing), policy evaluation defaults to `enforcement: warn`-equivalent behaviour: the policy is logged as un-evaluated but does not block the tool call. This degraded-mode contract is documented and tested.
- [ ] Vitest covers each shape, `extract` evaluation, ledger-query construction, and the unreachable-ledger fallback.
- [ ] End-to-end: a freshly-cloned harness on a clean machine successfully blocks a self-merge attempt and logs the decision, all without manual intervention beyond `harness apply`.

### Non-goals

- **No v2 `requires` shapes.** `confidence_floor`, `not_present`, `tag_filter`, and `aggregate` are deferred per `ARCHITECTURE.md` §6 migration table. Phase 4 ships exactly the three v1 shapes.
- **No policy bundles or team sharing.** Policies live inline in `harness.yaml policies:` only; cross-team policy libraries are a v2 concern. (See "Open decisions resolved here" for the inline-vs-imported decision.)
- **No automatic ledger writes from policies.** Policies *read* the ledger to evaluate `requires`; writing ledger entries is the agent's or the user's job, mediated by `agent-grounding` primitives.
- **No retry / backoff on transient ledger failures.** Single attempt per evaluation; transient failures fall back to warn-mode per the contract above.
- **No graphical surface for policy traces.** `harness explain --trace` is text-only; any UI is out of scope.

### Exit gate

A self-merge attempt is blocked end-to-end on my real harness installation: `mcp__agent-tasks__pull_requests_merge` against a PR without a `review:${PR_NUMBER}` ledger entry refuses, `harness explain review-before-merge --trace` shows the full decision trail, and the same invocation succeeds after `ledger record review:42 ...`. Tag `v0.4.0`.

## Open decisions resolved here

The four design questions flagged in this task's brief, each with a defended position and rationale.

### 1. Phase 1 doctor MCP health checks: real call vs reference-only

**Decision: real call.**

`harness doctor` invokes each `mcp[].health.verb` with the configured `timeout_ms` (default 5000). Reference-only would miss exactly the failure mode `ARCHITECTURE.md` Appendix D demonstrates: `codebase-oracle` exited 1 because of a missing native dep — a state invisible to "the path exists" checks. The latency cost (5s × N MCP servers, parallelisable down to ~5s total) is acceptable for a command run on demand, not on every prompt. If a future install has many MCP servers and this becomes painful, `harness doctor --shallow` may add a reference-only mode in v2; v1 ships only the real-call path so users immediately learn its diagnostic value.

### 2. Phase 2 `harness adopt` UX: editor / patch-output / write-and-confirm

**Decision: write-and-confirm.**

`harness adopt <file>` reads the on-disk file, computes the manifest patch, prints a unified diff to stdout, and prompts `Apply (y/N)?`. On `y` it commits the patch to `harness.yaml`; on anything else it exits 0 with no changes. Editor-mode burdens users who want a one-shot capture; patch-output requires manual `patch` invocation that breaks under whitespace differences; write-and-confirm is what humans and AI agents both want — show me what you'd do, let me say yes. The `--yes` flag bypasses the prompt for non-interactive use (CI, agent driver scripts).

### 3. Phase 3 lock-file granularity: every path vs only executables

**Decision: every referenced path.**

`harness.lock` records SHA-256 of *every* file path the effective manifest references: hook scripts, MCP entrypoints, memory directories' files (per-file, not directory hash, so per-memory drift is visible), skill `SKILL.md` files, `.env.example`, anything else listed in the manifest. Narrower-net would miss memory drift (which the user often cares about more than hook drift) and would require maintaining an "is this path executable?" classifier that gets policy-arguments wrong. The wide-net cost is small (a typical install references maybe 30 files; SHA-256 of small text files is microseconds) and the diagnostic value is large.

### 4. Phase 4 policy storage: inline / imported / both

**Decision: both, with clear separation.**

- **Inline** (`harness.yaml policies:`): the runtime-firing policies. These are tightly coupled to the `hooks:` block (each policy references a hook by name), and inlining keeps the wiring legible at a glance.
- **Imported** (`harness.d/policies/<name>.yaml` via explicit `policies_source:` keys): library-style definitions for a *different DSL* — today, `agent-grounding`'s claim-gate policies via `grounding.policies_source`. The harness `policies:` top-level key does NOT support a `policies_source:` indirection in v1; if cross-manifest policy sharing becomes a real need, it lands as a v2 schema addition.

The reasoning is the one already encoded in `ARCHITECTURE.md` §2: claim-gate policies are their own opinionated DSL with their own evolution; they belong in their own file. Harness runtime policies are wiring, not data; they belong inline next to the hooks they reference.

## Out of scope across all phases

For one final pass of expectation-setting:

- **Cross-runtime portability** beyond Claude Code. The hook-event vocabulary is Claude-Code-specific; porting to a hypothetical second runtime is a separate effort.
- **Manifest schema v2.** All four phases stay on `version: 1`. v2 is a future doc.
- **Web UI / TUI.** CLI-only across all phases.
- **Cloud sync.** No team-shared manifests, no upstream policy bundles, no remote ledger.
- **Auto-restart of Claude Code or MCP servers.** `apply` and `add` print restart hints; the user (or agent) does the actual restart.

If a future capability does not fit one of the four phases above, that is the signal for either an explicit Phase 5 design doc or a separate sibling project — not a quiet expansion of this roadmap.
