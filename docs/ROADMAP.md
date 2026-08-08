# Roadmap

This document turns the phases summarised in [`README.md`](../README.md)'s status section into testable acceptance criteria. It is downstream of [`VISION.md`](VISION.md) (the *why*) and [`ARCHITECTURE.md`](ARCHITECTURE.md) (the *what*); both are inputs, not variables.

Each phase below ships in this shape:

- **Scope**: what this phase delivers, in plain English.
- **Deliverables**: concrete artefacts: CLI verbs, schema fields, file outputs.
- **Acceptance criteria**: testable bullets that answer "how do I know this phase is done?". Each is either scriptable or human-verifiable from a single command's output.
- **Non-goals**: what is explicitly *not* in this phase, especially items a reader might expect.
- **Exit gate**: the one-line statement of when this phase is releasable.

## Phase ordering rationale

The order is deliberate: read-only inventory → managed edits → declarative truth → policy layer. The full justification lives in [`VISION.md` §8](VISION.md#8-why-introspection-comes-before-enforcement) ("Why introspection comes before enforcement"). In short: you cannot enforce policies on a configuration surface you cannot read, and Phase 1's `harness doctor` already delivers user-visible value (worked demo in [`ARCHITECTURE.md` Appendix D](ARCHITECTURE.md#appendix-d--phase-1-value-demonstration)). Inverting the order would make every false-positive policy fire its own debugging incident.

## Phase 1: Read-only inventory

### Scope

Build the floor. Phase 1 ships every read-only capability needed to answer "what is this harness configured to do, right now, comprehensively?", across the manifest, MCP servers, CLI tools, skills, memory directories, hooks, and policies. Nothing in Phase 1 writes to disk or executes a hook. Schema validation happens; behaviour does not. The killer-test value-demo from `ARCHITECTURE.md` Appendix D is the user-visible outcome.

### Deliverables

CLI verbs (per `ARCHITECTURE.md` §9 "Read-only"):

- `harness describe [--project <name>] [--pillar <p>] [--json]`: print the effective merged manifest.
- `harness validate [--project <name>] [--strict]`: schema lint plus referenced-asset checks; exit 1 on error.
- `harness doctor [--project <name>] [--shallow]`: human-readable health summary across all pillars. Default mode invokes each `mcp[].health.verb` for real (catches the runtime-broken case that motivated Appendix D); `--shallow` skips network/process probes and reports manifest-reference status only, for fast iteration in interactive sessions where the user is invoking `doctor` repeatedly.
- `harness list <mcp|cli|skills|memories|hooks|policies> [--filter <s>] [--json]`: denormalised flat listing per category, pipe-friendly. Categories match `ARCHITECTURE.md` §9.
- `harness explain <policy-name>`: surface what a named policy *would* evaluate to (schema-only; full trace including last-evaluation result lands in Phase 4 once policies actually fire).
- `harness diff [--since <ref>]`: manifest-layer diff against a git ref. (`--since-apply` is Phase 3.)

Library-side:

- `version: 1` manifest schema parser (zod-based) covering all five pillars.
- Per-machine override layer per `ARCHITECTURE.md` §8: discovery via `<hostname>` / `<os>` / `default`, merge order base → os → hostname → project.
- Memory router introspection: read frontmatter, surface stale memories per `retention.staleness_days`.
- MCP health probe: real network/process call to each `mcp[].health.verb` with the configured `timeout_ms`.

### Acceptance criteria

- [ ] `harness describe` reproduces the merged manifest for a real test fixture (`docs/examples/full-manifest.yaml`) byte-equivalent to the hand-merged expected output.
- [ ] `harness validate` exits 1 on every malformed manifest under `docs/examples/invalid/*` and 0 on `docs/examples/full-manifest.yaml`. Each invalid fixture has a one-line comment explaining what is wrong.
- [ ] `harness validate --strict` rejects unknown keys per `ARCHITECTURE.md` §11 (Phase 1 strict default).
- [ ] `harness validate` rejects a `policies[].requires` entry that references `${PR_NUMBER}` without a matching `trigger.extract:` entry. (Schema-level rejection; the policy never fires in Phase 1, but malformed policies are caught at lint time.)
- [ ] `harness doctor` against the test fixture reproduces the structure shown in `ARCHITECTURE.md` Appendix D: a section per pillar (Manifest / Tools / Memory / Hooks / Policies / Summary), each with `✓ / ⚠ / ✗` status markers. The Policies section in Phase 1 reports "schema valid; last-evaluated tracking ships in Phase 4" rather than the timestamps shown in Appendix D's illustrative output (which assumes Phase 4 is also live).
- [ ] `harness doctor` (default mode) issues a real MCP health-verb call against each declared `mcp[]` entry; a server that exited 1 surfaces with the actual error message in the output, not a generic "unhealthy".
- [ ] `harness doctor` for an `mcp[]` entry whose `health` block is absent reports `? unknown: no health verb declared` for that server (does not skip silently, does not fail).
- [ ] `harness doctor --shallow` skips MCP probes entirely and completes in under 100ms against a fixture with 8 MCP servers, reporting manifest-reference state only.
- [ ] `harness validate` warns when `tools.builtin.known` diverges from the runtime's currently-advertised built-in tool list (one-sided per `ARCHITECTURE.md` §3: a built-in present in the manifest but missing from the runtime is noise; a runtime built-in missing from the manifest is a warning).
- [ ] `harness doctor` flags memories untouched for more than `retention.staleness_days` with their last-touched date.
- [ ] `harness diff --since master` against a fixture git repo with two commits (the second changing one `mcp[].command` value) emits exactly one diff hunk on that field.
- [ ] `harness list mcp` and `harness list policies --json` produce JSON parsable by `jq` with no extra prose lines on stdout.
- [ ] Per-machine override layer resolves correctly: a fixture with `~/.claude/harness.yaml` + `~/.claude/machines/wsl2.harness.overrides.yaml` produces the WSL2-merged manifest when `/proc/version` contains `microsoft` (per `ARCHITECTURE.md` §8), and the bare manifest otherwise.
- [ ] Vitest suite covers schema parsing, override merging, MCP health-probe timeout, and stale-memory detection. ≥ 90% line coverage on `src/`.
- [ ] `npm run typecheck` and `npm test` are green on Node 20 LTS in CI.

### Non-goals

- **Hook execution.** `harness doctor` reports that a hook is wired but does not execute it. The hook actually firing on its event is Phase 4.
- **Policy evaluation.** `harness validate` lints `policies[]` for schema and reference correctness, including the three v1 `requires` shapes (`ledger_tag`, `+ within`, `+ count`) and `trigger.extract:` grammar. It does **not** evaluate whether the requirements are satisfied against the ledger, and policies do not fire on hook events. The shapes are *parsed and structurally validated* in Phase 1; the *evaluator* that checks the ledger and gates tool calls ships in Phase 4. This split is deliberate per the 2026-04-27 design conversation: shipping the schema without behaviour creates the "I wrote a policy, why does nothing happen?" failure mode if rolled out alone.
- **Writing files.** Phase 1 reads `~/.claude/harness.yaml` and asset files; it never writes. `harness add`, `harness apply`, `harness adopt` are Phase 2 / 3 verbs.
- **Lock file.** `harness.lock` is a Phase 3 artefact; Phase 1's "single source of truth" claim applies at the manifest layer only, per `VISION.md` §4.
- **Asset-content drift detection.** `harness diff` shows manifest-level changes; "the SHA of `git-preflight.sh` changed under your feet" is a Phase 3 capability that needs the lock file.

### Exit gate

`harness doctor` against my real `~/.claude/harness.yaml` (≥ 3 MCP servers, ≥ 2 CLI tools, ≥ 4 skills, ≥ 2 hooks, ≥ 2 policies) reproduces a structurally-equivalent output to `ARCHITECTURE.md` Appendix D, with at least one ✗ surfaced when an MCP server is intentionally broken. Tag `v0.1.0`.

## Phase 2: Managed edits

### Scope

Add the write-side verbs that mutate `~/.claude/harness.yaml` safely: bootstrap a manifest, add or remove entries by name with schema validation, capture hand-edits from runtime files into the manifest. Concurrent-edit safety via a lock file. No regeneration of runtime files yet; that's Phase 3.

### Deliverables

CLI verbs:

- `harness init [--template minimal|full] [--force]`: bootstrap `~/.claude/harness.yaml` from a template.
- `harness add mcp <name> [--command <cmd>] [--health-verb <v>] ...`: managed insert into `tools.mcp[]`.
- `harness add cli <name> --binary <b> [--required]`: managed insert into `tools.cli[]`.
- `harness add skill <name>`: managed enable in `tools.skills.enabled`.
- `harness add hook <name> --event <e> --command <c> [--match <r>] [--blocking <m>]`: managed insert into `hooks[]`.
- `harness remove <type> <name>`: remove by name with reference-check (refuses if a policy references a hook being removed; user must `--force` or remove the policy first).
- `harness adopt <file>`: capture hand-edits from a runtime file (today: `~/.claude/settings.json`) back into the manifest. Implementation: write-and-confirm (see "Open decisions resolved here" below).
- `harness export [--sanitize] [-o <file>]`: emit the effective manifest as a single self-contained YAML.

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

## Phase 3: Declarative truth

### Scope

Make the manifest the source of truth at the runtime layer too. `harness apply` regenerates `~/.claude/settings.json` from the manifest, with three-state drift detection from `ARCHITECTURE.md` §7 protecting hand-edits. The `harness.lock` file pins SHAs of every referenced asset (hook scripts, MCP entrypoints, memory router binary, skill source dirs) so asset-content drift becomes diff-able.

### Deliverables

CLI verbs:

- `harness apply [--dry-run] [--overwrite-drift]`: regenerate `harness.generated/settings.json` and `harness.generated/MEMORY.md` index from the manifest, with drift-detection per `ARCHITECTURE.md` §7. `--dry-run` prints the would-be diff; `--overwrite-drift` discards on-disk changes after a confirmation.
- `harness diff --since-apply [--memory-detail]`: diff against the last applied state recorded in `harness.generated/.last-apply`. `--memory-detail` expands per-directory Merkle entries back to per-file SHA changes for memories.

Library-side:

- Three-state comparator: manifest-expected / last-applied / on-disk-current per `ARCHITECTURE.md` §7 decision tree.
- `harness.lock` writer: SHA-256 of every referenced file path on disk for tool-asset files (hook scripts, MCP entrypoints, skill SKILL.md, etc.); one Merkle-style aggregate hash per memory directory (see "Open decisions resolved here" below). Lock format is line-oriented JSON for diff-friendliness.
- `harness.lock` reader: on subsequent `apply` runs, compare current asset SHAs against locked SHAs and surface drift per asset.
- `harness.generated/.last-apply` tracker: stores a copy of every generated file plus its hash at apply time.
- Restart-hint emitter: after `apply`, prints which runtime actions the user must take ("MCP servers changed; `/mcp reconnect` recommended", "memory router command changed; restart the session for new hooks").

### Acceptance criteria

- [ ] `harness apply --dry-run` against an unmodified manifest reports `no changes` and exits 0.
- [ ] `harness apply` on a fresh install (no `~/.claude/settings.json` and no `.last-apply` record) writes `harness.generated/settings.json` with the manifest-expected content. Subsequent `harness apply` is a no-op.
- [ ] `harness apply` after a hand-edit to `~/.claude/settings.json` (drift) refuses with exit 1, prints the unified diff between `.last-apply` and on-disk, and the message: `run "harness adopt ~/.claude/settings.json" to capture changes, or re-run with --overwrite-drift to discard them`.
- [ ] `harness apply --overwrite-drift` after a hand-edit prompts for explicit `yes` confirmation before discarding on-disk changes.
- [ ] `harness.lock` is written next to `harness.yaml`. It contains: one SHA-256 entry per tool-asset file (every `mcp[].command[]` path that exists, every `hooks[].command` path, every skill `SKILL.md` path, the memory-router binary path); one Merkle-aggregate entry per memory directory (`sha256(sorted(filename:filehash))`). Editing a single memory file changes exactly one entry in the lock.
- [ ] `harness diff --since-apply --memory-detail` expands the per-directory memory hash back to per-file detail on demand, so a user investigating "which memory file changed" has the full breakdown one flag away.
- [ ] `harness apply` after `git-preflight.sh` is edited externally (touched, contents changed) detects the SHA mismatch against `harness.lock` and surfaces it in the apply output with the message: `asset drift detected: ~/.claude/hooks/git-preflight.sh changed since last apply`.
- [ ] `harness diff --since-apply` against the same drift produces a per-asset summary listing which files changed.
- [ ] `~/.claude/settings.json` regenerated from the manifest is syntactically-valid JSON parseable by `JSON.parse` in Vitest, contains a `hooks` section with the expected event keys, and round-trips (parse → re-serialise → byte-equivalent to the generator's direct output). End-to-end "Claude Code accepts and runs the regenerated file" is a manual smoke step at the exit gate, not a Vitest assertion.
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

## Phase 4: Policy layer

### Scope

Make policies *fire*. The `requires` schema (`ledger_tag`, `+ within`, `+ count` from `ARCHITECTURE.md` §6) becomes evaluatable at the actual hook event. `PreToolUse mcp__agent-tasks__pull_requests_merge` triggers `review-before-merge`, which queries the evidence ledger via `${PR_NUMBER}` extracted through `trigger.extract:`, and blocks the tool call if the evidence is missing. The killer-test from the founding incident is fully answered by the `preflight-before-investigation` policy in `ARCHITECTURE.md` Appendix A: a `SessionStart` hook runs `preflight run --json` (from [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight)) and writes a `preflight:${REPO}` ledger entry with `ready` + confidence; the policy gates `PreToolUse Bash` matching `git (status|log|diff|branch)` on `requires: { ledger_tag: "preflight:${REPO}", within: 1h }`. The agent that tried to call `agent-grounding` tasks "stale" against a 16-commit-behind checkout would be blocked by that policy until `preflight run` had executed cleanly against the repo within the last hour, concretely wired via agent-preflight on the write side and [`grounding-mcp`](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/grounding-mcp) on the read side (the requires-evaluator queries the ledger through grounding-mcp's `ledger_summary` verb), not "or similar".

### Deliverables

CLI verbs:

- `harness explain <policy-name> --trace`: full trace of the last evaluation: trigger match result, `extract` substitution trail, ledger query, requires-shape evaluation, final enforcement decision. Essential for diagnosing "why did my merge get blocked".
- `harness audit [--since <when>]`: replay the evidence ledger for a window and cross-reference with harness policy decisions.
- `harness dry-run "<prompt>"`: simulate which hooks fire, which policies match, which memories route for a given user prompt. Requires runtime cooperation; first-pass implementation may be limited to "static prediction without invoking the LLM".

Library-side:

- `requires` evaluator covering all three v1 shapes. The evaluator queries the evidence ledger through [`grounding-mcp`](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/grounding-mcp), specifically `ledger_summary` (for tag presence + count) and `claim_evaluate_from_session` (for richer policy contexts). The MCP wrapper is the canonical client surface; harness does not re-open the SQLite ledger directly. grounding-mcp must be registered under `tools.mcp[]` for `requires` evaluation to work; `validate` warns when policies are declared but no grounding-mcp entry is wired.
  - `ledger_tag: "review:${PR_NUMBER}"`: substring/regex match against ledger entries' content/source columns.
  - `+ within: 24h`: time-window filter on `created_at`.
  - `+ count: { min: 2 }`: minimum count of matching entries.
- `trigger.extract:` JSONPath-restricted evaluator with `validate`-time grammar check.
- Policy-firing wiring at the runtime hook layer: when a hook bound to a policy fires, harness intercepts, evaluates `requires`, and either lets the hook proceed (allow) or returns the `decision: deny` shape that the runtime understands as a hard block.
- Policy-decision audit log: every fire writes to the evidence ledger as a `policy_decision` entry with `name`, `outcome`, `requires_eval`, `extract_values`. This makes `audit` and `explain --trace` possible.

### Acceptance criteria

- [ ] All three v1 `requires` shapes evaluate correctly:
  - [ ] `ledger_tag: "review:42"` against a ledger containing `{content: "review:42:approved", ...}` matches.
  - [ ] `ledger_tag: "dogfood:gs-pandora-abc" + within: 24h` against an entry created 23h ago matches; same shape against an entry created 25h ago does not match.
  - [ ] `ledger_tag: "review:${PR_NUMBER}" + count: {min: 2}` with two matching ledger entries passes; with one entry fails with the message: `1 of required 2 entries found`.
- [ ] `harness explain review-before-merge --trace` produces a structured trace including: trigger event matched, `extract` substitutions resolved, ledger-query identifier (the SQL string if the implementation is SQL-shelled, or the equivalent function call's signature otherwise; the implementation picks one and sticks with it), entry-count returned, decision (`block`/`allow`), and timestamp. Reproducible against a fixture session.
- [ ] A real `mcp__agent-tasks__pull_requests_merge` invocation against a session *without* a `review:42` ledger entry is blocked by harness with the policy's `enforcement: block` semantics; the user sees a one-line error referencing the policy name and the missing requires.
- [ ] The same invocation *with* a matching ledger entry passes; the policy decision is logged in the ledger as a `policy_decision` entry visible in `harness audit`.
- [ ] `harness dry-run "merge PR 42"` against the test-fixture session statically reports the exact set of matching policies (for the example fixture this is `[review-before-merge]` and nothing else) without actually invoking the tool call or the LLM.
- [ ] `validate` rejects a manifest with a policy `requires.within` value that is not a valid duration (e.g. `within: yesterday` fails; `within: 24h`, `within: PT1H`, `within: 86400s` all pass).
- [ ] `requires.count.min` of 0 is rejected at `validate` time as a no-op shape (the user should remove the field or use a different policy).
- [ ] When the evidence ledger is unreachable (e.g. database file missing), policy evaluation defaults to `enforcement: warn`-equivalent behaviour: the policy is logged as un-evaluated but does not block the tool call. This degraded-mode contract is documented and tested. *(SUPERSEDED by task f1aea826: the degraded outcome is tier-aware since 0.45 — `warn` policies stay non-blocking, `block`/`require_approval` policies fail CLOSED as `deny-degraded`. See docs/okf/gate-fail-posture-matrix.md; this bullet is kept as the historical Phase 4 acceptance.)*
- [ ] `harness validate` warns (not errors) when `policies[]` is non-empty but no `tools.mcp[]` entry with `name: grounding-mcp` is wired. The warning text names the missing MCP and links to the §6 policy/grounding-mcp docs. Reason: the requires-evaluator queries the ledger through grounding-mcp; without it, every policy fires in degraded warn-mode. Surfacing this at lint time prevents the silent-degradation failure mode. *(SUPERSEDED by task f1aea826: the warning is tier-aware since 0.45 — with no producer wired, block/require_approval policies now DENY instead of degrading to warn-mode.)*
- [ ] Vitest covers each shape, `extract` evaluation, ledger-query construction, and the unreachable-ledger fallback.
- [ ] End-to-end: a freshly-cloned harness on a clean machine successfully blocks a self-merge attempt and logs the decision, all without manual intervention beyond `harness apply`.

### Non-goals

- **No v2 `requires` shapes.** `confidence_floor`, `not_present`, `tag_filter`, and `aggregate` are deferred per `ARCHITECTURE.md` §6 migration table. Phase 4 ships exactly the three v1 shapes.
- **No policy bundles or team sharing.** Policies live inline in `harness.yaml policies:` only; cross-team policy libraries are a v2 concern. (See "Open decisions resolved here" for the inline-vs-imported decision.)
- **No automatic ledger writes from policies.** Policies *read* the ledger to evaluate `requires`; writing ledger entries is the agent's or the user's job, mediated by `agent-grounding` primitives.
- **No retry / backoff on transient ledger failures.** Single attempt per evaluation; transient failures fall back to warn-mode per the contract above. *(SUPERSEDED twice by task f1aea826: the fallback is tier-aware since 0.45, and the AUDIT WRITE for a `deny-degraded` decision gets one bounded fresh-session retry — evaluation itself remains single-attempt.)*
- **No graphical surface for policy traces.** `harness explain --trace` is text-only; any UI is out of scope.

### Exit gate

A self-merge attempt is blocked end-to-end on my real harness installation: `mcp__agent-tasks__pull_requests_merge` against a PR without a `review:${PR_NUMBER}` ledger entry refuses, `harness explain review-before-merge --trace` shows the full decision trail, and the same invocation succeeds after `ledger record review:42 ...`. Tag `v0.4.0`.

## Phase 5: Polish + dogfood lessons

### Scope

Phase 4 shipped policies that *fire*. Phase 5 ran them end-to-end against the real grounding-mcp + the live SQLite ledger, captured the bugs that surfaced on the way, and turned the whole feedback loop into a quality-of-life pass on `audit` / `explain --trace` / `policy intercept`. No new YAML keys, no new structural surfaces. The package is now also distributed on npm as `@lannguyensi/harness`.

### Deliverables

CLI ergonomics:

- **`harness policy intercept --verbose`**: opt-in stderr diagnostics for non-allow decisions (policy name, ledger_tag, matched count, reason, sorted extract values). Default off; v0.4.0 byte-equivalent. Also enabled via `HARNESS_POLICY_VERBOSE=1` (case-insensitive disable: `0` / `false` / `no` / `off`).
- **`$CLAUDE_SESSION_ID` env fallback**: `audit` / `explain --trace` / `policy intercept` resolve `--session` via the chain `explicit > $CLAUDE_SESSION_ID > "default"` so reads inside a real Claude Code session find what writes landed under the actual UUID.

Correctness fixes (live evidence in PR #39 dogfood):

- **`audit --since` UTC parse**: SQLite `datetime('now')` writes UTC `YYYY-MM-DD HH:MM:SS`; `Date.parse` of the space form is local, so non-UTC hosts silently filtered out fresh entries. New `parseLedgerTimestamp` coerces to ISO-with-Z. Applied at all four call sites (audit row sort + cutoff filter, explain `selectLatestForPolicy`, `requires.entryTime`).
- **`explain --trace` ms-precision sort**: sub-second collisions used to tie at `bt - at = 0` because the sort keyed on ledger `createdAt` (1-second precision) and V8's stable sort returned the earliest fire. New `decisionSortKey` prefers the decoded payload's `evaluatedAt` (ms precision); fallback to `createdAt`. Same fix in `audit` row order.
- **`policy_decision` first-class entry type**: was encoded as `type: "fact"` with a `policy_decision:` content prefix, so past audit payloads' serialised `"ledgerTag":"review:42"` substring-matched the same tag the decision was about and inflated `matchedCount`. Promoted to a first-class `EntryType` in `@lannguyensi/evidence-ledger@0.2.0`; harness writes with the new type and a retry-fallback to legacy `fact` for old servers; reader tags rows with the bucket-derived type so the requires evaluator can drop them. Legacy `policy_decision:`-prefixed `fact` rows are also dropped via a content-prefix backstop.
- **Server-side `audit` filter pushdown**: `audit` derives `sinceIso` from the existing `--since` cutoff and unconditionally requests `contentPrefix: "policy_decision:"` on `ledger_summary`. Capability detection via `tools/list` keeps it back-compatible with old servers (filter args are dropped silently when not advertised). Hot path (no filter requested) skips `tools/list` entirely.

Distribution:

- `@lannguyensi/harness` published to npm with `--access public --provenance`. CLI binary stays `harness`. Tag-driven workflow modeled after the agent-grounding pattern.

Test + reproducibility:

- `dogfood/phase5/run-smoke.sh`: reproducible end-to-end smoke against real grounding-mcp + live SQLite ledger, with five fail-closed gates (deny, ledger_add, silent allow, 5m audit, 24h audit, explain --trace). First-run baseline transcripts committed for review of the live wiring.
- Shared `tests/_helpers/` builders (`makeManifest`, `makePolicy`, `makeDecision`, `makeDecisionEntry`) collapsed ~80 lines of duplicated test boilerplate.

### Acceptance criteria

- [x] `harness policy intercept --verbose` writes a stderr diagnostic block per non-allow decision; default off keeps v0.4.0 byte-equivalent.
- [x] `audit` / `explain --trace` resolve sessionId via `explicit > $CLAUDE_SESSION_ID > "default"`; live regression test against a real ledger passes.
- [x] `audit --since 5m` returns rows seconds after a policy fires on a non-UTC host (CEST verification on a fresh dogfood run).
- [x] `explain --trace` returns the latest decision by `evaluatedAt` even when two fires share an SQL second.
- [x] `policy_decision` rows live in their own `policyDecisions` bucket on `ledger_summary`; the requires evaluator sees zero matchedCount inflation from past audit payloads.
- [x] `audit` pushes its filters server-side when the connected grounding-mcp advertises support, falls back transparently otherwise.
- [x] `dogfood/phase5/run-smoke.sh` exits 0 with all five fail-closed gates passing against the production binary.
- [x] `@lannguyensi/harness@0.5.0` is installable via `npm i -g @lannguyensi/harness` and the `harness` binary is on `$PATH`.

### Non-goals

- **No new YAML manifest keys.** Phase 5 stays on the `version: 1` schema.
- **No new policy `requires` shapes.** v2 shapes (`confidence_floor`, `not_present`, `tag_filter`, `aggregate`) are still deferred per ARCHITECTURE.md §6.
- **No backfill of pre-Phase-5 `policy_decision:`-prefixed `fact` rows in user ledgers.** They stay readable via the content-prefix backstop until they age out; explicit migration is a separate task if anyone asks for it.
- **No headless `claude -p` dogfood as part of CI.** The synthetic-stdin smoke covers the same wire contract; the headless variant is filed as a follow-up (`67517c67`).

### Exit gate

`@lannguyensi/harness@0.5.0` published to npm; `dogfood/phase5/run-smoke.sh` re-runs end-to-end with all five gates green; `audit --since 5m` returns rows on a non-UTC host within seconds of a policy fire; `matchedCount` no longer inflates after a same-session deny followed by allow. Tag `v0.5.0`.

## Phase 6: Understanding Gate Policy Pack

### Scope

Before an agent edits files, runs shell, commits, or opens a PR, it must produce an *Understanding Report* (interpretation of the task: derived todos, acceptance criteria, assumptions, out-of-scope, risks). The user confirms, corrects, or "grills me until precise enough". Only after explicit approval is recorded in the evidence ledger may write-capable tools fire.

Phase 6 introduces the *Policy Pack* concept as a first-class harness unit: a reusable bundle of instruction template + hooks + policies + permission profiles that ships under one name and is referenced from `harness.yaml` with one key. The Understanding Gate is the first showcase pack and the canonical reference implementation. Long-form design and rationale live in `lava-ice-logs/2026-04-30/harness-pre-execution-understanding-integration.md`.

### Sub-task decomposition

Phase 6 ships as six sequential sub-tasks. Each is a separate PR with its own dogfood gate. Cross-references to `lava-ice-logs/2026-04-30/harness-pre-execution-understanding-integration.md` are noted inline.

#### Phase 6 #1, Anchor: Policy Pack vocabulary + canonical doc *(this PR)*

- New manifest key `policy_packs:` (additive, version 1, no runtime behaviour). Schema: `name` (required), `source` (default `builtin`), `enabled` (default `true`), `description` (optional), `config` (free-form record, validated by the pack itself at resolve time).
- `docs/policy-packs/understanding-before-execution.md`: canonical pack documentation including target architecture, manifest reference, mode semantics, permission-profile sketches, adapter notes, approval state model.
- Schema-only validation: duplicate-name rejection, `.strict()` on entry shape, integration with `parseManifest` defaults.
- Two new invalid fixtures (`17-policy-pack-duplicate-name.yaml`, `18-policy-pack-unknown-key.yaml`).
- `docs/examples/full-manifest.yaml` carries the canonical pack as a worked example; the byte-for-byte `describe` golden test covers the resulting output.

**Out of scope here:** any code that reads `policy_packs:` at runtime, any new CLI verb, any `harness apply` integration, any hook installation. Those land in #2 through #6.

#### Phase 6 #2, Apply-time pack expansion

- `harness apply` resolves each enabled pack to its bundled instruction template + hook stanzas + permission-profile defaults; merges them into the generated `~/.claude/settings.json` and the per-project `CLAUDE.md` block.
- Three-state drift detection extends to instruction-text content (per `ARCHITECTURE.md` §7).
- `.harness/policy-packs/<name>/` per-project state directory; tracked by `harness.lock`.
- `harness diff --since-apply` surfaces pack-instruction drift.

#### Phase 6 #3, `harness pack` CLI surface

- `harness pack add <name> [--mode fast_confirm|grill_me|strict]`: managed insert into `policy_packs:`.
- `harness pack remove <name>`: reference-checked remove (refuses if hooks/policies still reference the pack's contributions).
- `harness pack list [--enabled-only]`: flat listing with resolved source + mode.
- Wires `harness validate` to fail when an `enabled: true` pack's `source` cannot be resolved.

#### Phase 6 #4, PreToolUse blocker + `harness approve understanding`

- Harness-side PreToolUse blocker that consults BOTH the `understanding-approved:${SESSION_ID}` evidence-ledger tag (canonical for harnessed sessions) AND the `@lannguyensi/understanding-gate` persisted JSON report (fallback). The package's standalone blocker stays available for solo users.
- `harness approve understanding [--session <id>]` round-trips both: writes the ledger tag via `grounding-mcp` AND flips `approvalStatus: "approved"` on the most recent persisted report.
- `harness doctor` validates: package binaries on `$PATH`, hooks registered in `settings.json`, instruction templates installed, ledger reachable.

#### Phase 6 #5, Permission profiles

- Three reference profiles (`safe-start`, `implementation-after-approval`, `high-risk-grill-me`) shipped with the canonical pack; documented as a new schema block (working name `permission_profiles:` or expressed inline in the pack's `config:`).
- Runtime semantics for `mode: ask | ask_or_deny | limited` defined and tested.
- Validated against the existing `policies:` evaluator so pack-driven permission requirements compose with manifest-level `requires:` shapes.

#### Phase 6 #6, Codex adapter *(shipped)*

- Codex hook adapter for UserPromptSubmit (instruction injection via `harness pack hook codex-user-prompt-submit`) and PreToolUse (`apply_patch|Bash|shell` blocking via `harness pack hook codex-pre-tool-use`). Mirrors the Claude Code shape; reuses the same persisted-report format under `.understanding-gate/reports/`.
- New CLI flag `harness apply --runtime codex` emits `harness.generated/codex/config.toml` (TOML hook stanzas) instead of `settings.json`. `--install` additionally merges those stanzas into a marked harness-managed block in `~/.codex/config.toml`.
- Smoke test under `dogfood/phase6-6/` exercises the synthetic-stdin path: PreToolUse blocks with exit 2 + reason on stderr, then allows with exit 0 after a persisted report flips `approvalStatus` to `approved`.
- Phase 6 #6 follow-ups (filed as separate agent-tasks entries): `harness doctor --target codex` adapter-health check; Codex-specific Stop-equivalent for transcript capture; permission-profile translator into Codex's sandbox shape.

### Non-goals

- A registry / marketplace for community-authored packs (deferred to a future phase).
- Cross-runtime packs beyond Claude Code, OpenCode, Codex.
- Automatic UI for the user-confirms step (still text-mode across all sub-tasks).
- Re-implementing templates / parser / persistence inside harness; those stay in `@lannguyensi/understanding-gate`.

### Exit gate

A fresh agent on a clean repo refuses to call write-capable tools until an Understanding Report has been produced and explicitly approved. The `understanding-before-execution` pack is declarable via `harness pack add`, applies cleanly via `harness apply`, and `harness doctor` reports the wiring as healthy. The PR-level cut tags `v0.8.0` after #6 lands; intermediate sub-tasks ship as patch releases.

## v0.24.0, runtime-neutral state root *(shipped)*

- Harness's operator-state root moves from `~/.claude/` to `~/.harness/`. The new resolver (`src/runtime/home-dir.ts`) picks the root from explicit flag, `$HARNESS_HOME` env, existing `~/.harness/`, legacy `~/.claude/` with deprecation warning, or create-on-first-use `~/.harness/`.
- New `harness migrate-home` command: dry-run by default, `--apply` to atomically move `harness.yaml`, `harness.generated/`, `.understanding-gate/`, `harness.lock` into the new root. Idempotent; refuses to overwrite. Operator guide at `docs/migration/v0.24.0-home-dir.md`.
- Backed by agent-tasks/e65decef, surfaced during the Codex approval-UX dogfood (f608b4ee). Legacy fallback still supported; deletion targeted for a future release.

## Phase 7: Risk Gate

### Scope

Today's policy model evaluates a rule per matching trigger and returns a binary block/allow. Phase 7 makes harness reason about *the action itself*: an Action Envelope (tool + raw input + session + runtime context) is enriched by a Context Resolver (production / staging / dev / local / unknown), classified by a Risk Classifier (severity + categories + reversibility), then matched against policies whose `when:` clauses can reference `risk.severity_at_least`, `environment.name`, and similar. Decision space extends to `allow / warn / require_approval / deny`.

Motivating use case: prevent `DROP TABLE users`, `kubectl delete namespace prod`, `terraform destroy` against an unverified production target before the runtime even fires the tool, even when the model would happily run them. Long-form design lives in `lava-ice-logs/2026-04-30/harness-risk-gate-extension.md`.

### Sub-task decomposition

Phase 7 ships as six sequential sub-tasks, mirroring the Phase 6 model: each is a separate PR with its own dogfood gate. The decomposition follows the A-E implementation phases in `lava-ice-logs/2026-04-30/harness-risk-gate-extension.md`; the canonical in-repo reference is [`docs/risk-gate.md`](risk-gate.md), which also resolves the source design's open questions.

The architectural split is settled: the Risk Gate lives entirely inside harness, layered onto the Phase 4 `policy intercept` runtime. `agent-grounding` stays the evidence backend the gate reads through `grounding-mcp`; it gains no risk-gate code. See `docs/risk-gate.md` for the full rationale.

#### Phase 7 #1, Anchor: Risk Gate vocabulary + canonical doc *(this PR)*

- New top-level manifest keys `risk:` (`classifiers[]`: name, tool, regex `patterns[]` mapping to closed `categories` + `severity` enums) and `environments:` (`resolvers[]`: name, asserted environment, branch / env-var / kube-context / kube-namespace signals). Additive, version 1.
- New optional `policy.when:` block (`risk.severity_at_least`, `risk.category_in`, `environment.name`, `action.reversible`), parsed and validated alongside the existing `trigger:` / `requires:`.
- `docs/risk-gate.md`: canonical reference covering target architecture, manifest reference, decision model, the harness-vs-agent-grounding split, and the resolved open questions.
- Schema-only: duplicate-name rejection, `.strict()` entry shapes, regex validation of classifier patterns, closed category/severity/environment enums. Five invalid fixtures (`19`-`23`). `docs/examples/full-manifest.yaml` carries a worked `dangerous-shell` classifier + `production-signals` resolver; the byte-for-byte `describe` golden covers the output.

**Out of scope here:** any code that reads `risk:` / `environments:` / `policy.when:` at runtime, the Action Envelope, the `require_approval` decision value, any new CLI verb. Those land in #2 through #6. A `when:` block today is parsed and inert; `harness policy intercept` still matches on `trigger:` alone.

#### Phase 7 #2, Action Envelope MVP *(shipped)*

- Normalize `PreToolUse` input into a stable `{ event, tool, raw_input, session, runtime, timestamp }` JSON structure (design phase A).
- `harness explain-action <event.json>` debug verb prints the envelope (YAML or `--json`).
- Existing hook behaviour unchanged; the envelope is built but not yet classified.

#### Phase 7 #3, Static risk classification *(shipped)*

- Risk Classifier consumes `risk.classifiers[]`: regex-match the envelope, emit `{ classified, severity, categories, reversible, confidence, reasons }` (design phase B).
- `harness test-risk <event.json>` debug verb shows the classification.
- "Unknown is not safe": an unclassified command is not implicitly low-risk; it reports `classified: false` / `severity: null`.

#### Phase 7 #4, Environment resolution *(shipped)*

- Context Resolver consumes `environments.resolvers[]`: branch + env-vars + kube-context + namespace signals produce `{ name, confidence, signals, resolver }` (design phase C). `harness resolve-env <event.json>` debug verb shows the resolution.
- Unresolved context resolves to `unknown`, matchable by `when.environment.name`. When resolvers disagree, the most-dangerous environment wins.

#### Phase 7 #5, Policy evaluation over the enriched envelope *(shipped)*

- `harness policy intercept` ANDs a policy's `when:` clauses onto its `trigger:` match, evaluating against the enriched envelope (design phase D).
- Decision space extends to `allow / warn / require_approval / deny`; `require_approval` is plumbed through the decision model.
- `harness explain-policy <policy> --event event.json` shows why a policy matched or did not.

#### Phase 7 #6, Enforcement through `PreToolUse` *(shipped)*

- Runtime decisions are authoritative: `deny` aborts the tool call; `require_approval` blocks until matching approval evidence exists in the ledger (design phase E).
- Approval reuses the Phase 6 ledger-tag pattern (`risk-approved:${SESSION_ID}` written by a `harness approve` verb); `agent-grounding` needs no change.
- Every decision is written to the evidence ledger; `harness doctor` / `audit` replay them.
- A built-in `dangerous-shell` classifier + `gate-prod-destructive` policy ship as the canonical worked example.

### Non-goals

- Full risk modeling at the LLM level (this is rule-based classification, not learned).
- Cross-session approval continuity (each `require_approval` is local to the request).
- Auto-recovery / undo for actions classified post-hoc.

### Exit gate

`harness policy intercept` blocks a `kubectl delete namespace prod` invocation against a manifest that ships the built-in `dangerous-shell` classifier + `gate-prod-destructive` policy, and only allows it after a `require_approval` round-trip. Tag `v0.27.0` (the phase-numbered `v0.7.0` in the original plan predates the project's diverged release line; Phase 7 #1-#4 shipped under `v0.26.0`, and the Phase 7 completion release is the next minor, `v0.27.0`).

## Open decisions resolved here

The four design questions flagged in this task's brief, each with a defended position and rationale.

### 1. Phase 1 doctor MCP health checks: real call vs reference-only

**Decision: real call by default, `--shallow` flag in Phase 1.**

The default mode invokes each `mcp[].health.verb` with the configured `timeout_ms` (default 5000); reference-only would miss exactly the failure mode `ARCHITECTURE.md` Appendix D demonstrates: `codebase-oracle` exited 1 because of a missing native dep, a state invisible to "the path exists" checks. The 5s × N (parallelisable) latency cost is acceptable for an on-demand command.

But the original draft of this decision deferred `--shallow` to v2, and the Phase-0 review pushed back: a user (or AI agent) running `harness doctor` repeatedly during interactive iteration shouldn't pay full-probe latency every time. So `--shallow` ships in Phase 1, with the explicit acceptance that it completes in < 100ms against an 8-MCP-server fixture (line 49 above). The default stays `real call`, so users immediately learn the diagnostic value; `--shallow` is the explicit fast-path opt-in. Both modes are first-class, neither is hidden.

### 2. Phase 2 `harness adopt` UX: editor / patch-output / write-and-confirm

**Decision: write-and-confirm.**

`harness adopt <file>` reads the on-disk file, computes the manifest patch, prints a unified diff to stdout, and prompts `Apply (y/N)?`. On `y` it commits the patch to `harness.yaml`; on anything else it exits 0 with no changes. Editor-mode burdens users who want a one-shot capture; patch-output requires manual `patch` invocation that breaks under whitespace differences; write-and-confirm is what humans and AI agents both want: show me what you'd do, let me say yes. The `--yes` flag bypasses the prompt for non-interactive use (CI, agent driver scripts).

### 3. Phase 3 lock-file granularity: every path, but memory dirs hashed Merkle-style

**Decision: every referenced path, with memory directories aggregated into one Merkle hash per directory.**

`harness.lock` records SHA-256 of every file path the effective manifest references: hook scripts, MCP entrypoints, skill `SKILL.md` files, `.env.example`, etc. Narrower-net would miss memory drift (which the user often cares about more than hook drift) and would require an "is this executable?" classifier that gets policy-arguments wrong. The wide-net cost is small (microseconds per file) and the diagnostic value is large.

**The Phase-0 review caught a real signal-to-noise issue here:** memory directories under `~/.claude/projects/*/memory/` realistically have 30-100+ files per project, and a multi-project install crosses 1000+ memory files easily. Per-file SHA-256 in the main lock would produce a 1000-line JSON document that diffs noisily on every memory edit; perf is fine, signal is destroyed.

The fix: memory directories are hashed Merkle-style: one entry per directory in `harness.lock`, where the directory's hash is `sha256(sorted(filename: filehash for each .md))`. A new memory file or a content change in any memory file produces exactly one diff line per affected directory. The per-file detail is recoverable on demand via `harness diff --since-apply --memory-detail` (Phase 3 deliverable, optional flag).

Tool-asset files (hook scripts, MCP entrypoints, skill SKILL.md) stay one-entry-per-file in the main lock; those are exactly the files where per-file content drift matters individually.

### 4. Phase 4 policy storage: inline / imported / both

**Decision: both, with clear separation.**

- **Inline** (`harness.yaml policies:`): the runtime-firing policies. These are tightly coupled to the `hooks:` block (each policy references a hook by name), and inlining keeps the wiring legible at a glance.
- **Imported** (`harness.d/policies/<name>.yaml` via explicit `policies_source:` keys): library-style definitions for a *different DSL*: today, `agent-grounding`'s claim-gate policies via `grounding.policies_source`. The harness `policies:` top-level key does NOT support a `policies_source:` indirection in v1; if cross-manifest policy sharing becomes a real need, it lands as a v2 schema addition.

The reasoning is the one already encoded in `ARCHITECTURE.md` §2: claim-gate policies are their own opinionated DSL with their own evolution; they belong in their own file. Harness runtime policies are wiring, not data; they belong inline next to the hooks they reference.

## Out of scope across all phases

For one final pass of expectation-setting:

- **Cross-runtime portability** beyond Claude Code. The hook-event vocabulary is Claude-Code-specific; porting to a hypothetical second runtime is a separate effort.
- **Manifest schema v2.** All seven phases stay on `version: 1`. v2 is a future doc.
- **Web UI / TUI.** CLI-only across all phases.
- **Cloud sync.** No team-shared manifests, no upstream policy bundles, no remote ledger.
- **Auto-restart of Claude Code or MCP servers.** `apply` and `add` print restart hints; the user (or agent) does the actual restart.

If a future capability does not fit one of the seven phases above, that is the signal for either an explicit follow-up design doc (Phase 8+) or a separate sibling project, not a quiet expansion of this roadmap.
