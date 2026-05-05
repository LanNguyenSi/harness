# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `harness explain --last` traces the most recent policy decision in the
  evidence ledger without needing the policy name, closing the common
  "I just got a deny, what fired?" loop in one command instead of three.
  Pair with `--decision allow|deny|warn-degraded` to skip past intervening
  outcomes. `<policy>` and `--last` are mutually exclusive.

## [0.6.0] - 2026-05-03

**Headline: the Phase-5 adoption-blocker cycle closes end-to-end.**
`harness apply` now writes directly into a Claude Code settings
discovery path (`--target` + `--merge`), translates the manifest's
`tools.mcp[]` into the settings.json `mcpServers` block (so a real
`claude -p --settings <apply'd>` session actually loads them), prints
a Next-steps hint that names the real wire-up commands instead of
leaving adopters to guess, and `harness adopt` round-trips hand-edits
to `mcpServers` back into the manifest. The full
`apply → hand-edit → adopt → apply` cycle is byte-identical on the
settings.json bytes.

Operator note: no schema changes; `harness.lock` gains an optional
`target` entry kind (additive). Existing `harness.lock` files without
target entries continue to parse. The new flags on `apply` are all
opt-in; the default invocation still writes to `harness.generated/`.
Per-package version bumped from 0.5.0 to 0.6.0; this is the first
minor release on the `@lannguyensi/harness` npm distribution. No
operator action required beyond `npm i -g @lannguyensi/harness@0.6.0`
on machines running the published binary.

### Added

- **`harness apply --target / --merge / --force`** (task `d38f6f91`, PR #58):
  write the rendered settings.json directly into a Claude Code settings
  discovery path (e.g. `.claude/settings.local.json` or
  `~/.claude/settings.json`). `--merge` does a 3-way merge that replaces
  harness-owned top-level keys (today: `hooks`, `mcpServers`) and preserves
  everything else. `harness.lock` records the target sha so `validate
  --check-lock` flags out-of-band edits. Closes the adoption blocker that
  forced every adopter into a hand `cp` or per-invocation `--settings`.
- **`apply` translates `tools.mcp[]` into the settings.json `mcpServers`
  block** (task `62380337`, PR #59). The Phase 5 #1a caveat is closed:
  `init.mcp_servers` in a `claude -p --settings <apply'd>` session now
  contains the manifest's MCP entries. Disabled servers (`enabled: false`)
  are omitted; warnings (not errors) cover entries that survive schema
  but produce no runnable command. String-form commands with embedded
  whitespace in paths must be expressed as the array form to preserve
  token boundaries.
- **`apply` prints a Next-steps hint after a successful run** (task
  `517aa919`, PR #60). After the summary line, the CLI prints concrete,
  copy-pasteable next actions: one-shot `claude -p --settings ...`,
  project-scope `harness apply --target .claude/settings.local.json`,
  and user-global `harness apply --target ~/.claude/settings.json --merge`.
  When `--target` was actually written, the hint collapses to a single
  verify line with `--settings <targetPath>` included (so non-canonical
  target paths still resolve through `claude -p`). Two new flags pair
  with this: `--quiet` suppresses the hint while keeping the summary,
  and `--json` emits a machine-readable JSON summary instead of prose
  (implies `--quiet`; refusal outcomes still set non-zero exit).
  Motivated by a 2026-05-03 hallucination incident where an agent
  fabricated a non-existent `claude -p --output-dir` flag because
  nothing in the apply output guided the wire-up step; both unit and
  CLI integration tests assert the hint never contains `--output-dir`.
- **`adopt` reverse-projection for `mcpServers` into `tools.mcp[]`**
  (task `7059d92b`, PR #61). Closes the round-trip gap: hand-edits to
  settings.json's `mcpServers` block can now be captured back into the
  manifest. New entries are appended; same-name entries with different
  command/env are replaced (preserving manifest-only fields like `health`
  and `enabled: false`, so adopting a hand-edit does not silently wipe
  doctor/probe/policy metadata). The full
  `harness apply --target ... --merge → hand-edit → harness adopt → harness apply`
  cycle is byte-identical on the settings.json bytes.

### Notes for upgraders

- The settings.json output now includes a `mcpServers` key when your
  manifest declares enabled MCP servers. On the first apply after
  upgrade, the file grows by that block. The three-state compare handles
  this safely (no spurious drift-refuse on the generated file), but if
  you have hand-edited a `mcpServers` block into a previously apply'd
  settings.json, the next apply will refuse (`drift-refuse`) until you
  reconcile via `harness adopt` or `--overwrite-drift`.

## [0.5.0] - 2026-05-01

**Phase 5: dogfood + polish.** Phase 4 shipped policies that fire; Phase 5
ran them end-to-end against real grounding-mcp + the live SQLite ledger,
caught the bugs that surfaced, and turned the whole feedback loop into a
quality-of-life pass over `audit`/`explain`/`policy intercept`. The
package is now also distributed under `@lannguyensi/harness` on npm
(install with `npm i -g @lannguyensi/harness` and use `harness ...` from
the command line).

The killer-test from the founding incident still works exactly the same
way; this release is about it staying that way under realistic
operational pressure.

### Added

- **`harness policy intercept --verbose`** (Phase 5 #3, PR #44) — opt-in
  stderr diagnostics for non-allow decisions: policy name, ledger_tag,
  matched count, reason, and sorted extract values. Default off; v0.4.0
  byte-equivalent. Also enabled via `HARNESS_POLICY_VERBOSE=1`
  (case-insensitive disable: `0`/`false`/`no`/`off`).
- **`$CLAUDE_SESSION_ID` env fallback** (Phase 5 #2, PR #43) for
  `audit`/`explain --trace`/`policy intercept` when `--session` is
  omitted. Real Claude Code sessions arrive via `event.session_id`, so
  reads under the literal `"default"` were silently invisible. New
  precedence: explicit > env > `"default"`.
- **`policy_decision` first-class entry type** (Phase 5 #4, PR #47) via
  the matching `@lannguyensi/evidence-ledger@0.2.0` change. Writer
  tries `type='policy_decision'` and falls back to legacy `type='fact'`
  on an old server. Reader tags rows with their bucket-derived type so
  the requires evaluator can drop policy-decision rows without the
  substring-pollution that inflated `matchedCount` in PR #39's dogfood.
  Legacy `policy_decision:`-prefixed `fact` rows are also dropped via a
  content-prefix backstop so upgraded users don't keep paying the
  pollution tax until their dev ledger ages out.
- **Server-side `audit` filter pushdown** (Phase 5 #5, PR #46) via the
  matching evidence-ledger 0.2.0 change. `audit` now passes
  `sinceIso` (derived from its `--since` cutoff) and
  `contentPrefix: "policy_decision:"` to `ledger_summary`. Capability
  detection via `tools/list` keeps it back-compatible with old servers
  (filter args are dropped silently when not advertised). Hot path
  (no filter requested) skips `tools/list` entirely.
- **`dogfood/phase5/`** — reproducible smoke driver against real
  grounding-mcp + live SQLite ledger (Phase 5 #1, PR #39). All five
  gates (deny / ledger_add / silent allow / 5m audit / 24h audit /
  explain --trace) exit non-zero on regression.
- **`tests/_helpers/manifest.ts` + `tests/_helpers/decision.ts`** (Phase 5
  #6, PR #45) — shared `makeManifest`, `makePolicy`, `makeDecision`,
  `makeDecisionEntry` builders. Pure refactor; existing test count
  unchanged.

### Fixed

- **`audit --since` window now parses UTC ledger timestamps correctly**
  (Phase 5 #8, PR #40). evidence-ledger stores `created_at` as SQLite
  `datetime('now')` (UTC, space-separated). V8's `Date.parse` parses
  the space form as local time; on any non-UTC host a `--since` window
  narrower than the host TZ offset silently filtered out fresh
  entries. New `parseLedgerTimestamp` coerces the SQL form to ISO-with-
  Z before delegating to `Date.parse`. Applied at all four call sites
  (audit row sort + cutoff filter, explain `selectLatestForPolicy`,
  `requires.entryTime`).
- **`explain --trace` picks the latest decision by `evaluatedAt`**
  (Phase 5 #9, PR #41). Sub-second collisions used to tie at
  `bt - at = 0` because the sort keyed on ledger `createdAt`
  (1-second precision), and V8's stable sort returned the earliest
  fire. New `decisionSortKey` prefers the decoded payload's
  `evaluatedAt` (ms precision), fallback to `createdAt`. Same fix in
  `audit` row order.

### Distribution

- Package renamed from `harness` (the unscoped name was already taken on
  npm) to `@lannguyensi/harness`. The CLI binary is still `harness`.
- New `publish-npm.yml` workflow tags `v*` → publishes to npm with
  provenance. Single package; no monorepo workspace.

## [0.4.0] - 2026-04-30

**Phase 4: policy layer.** Policies *fire*. The `requires` schema
(`ledger_tag`, `+ within`, `+ count` from `docs/ARCHITECTURE.md` §6) is
now evaluatable at the actual hook event. `harness policy intercept`
runs as a `PreToolUse` hook: it reads the tool-event JSON from stdin,
runs every matching policy through extract-substitution + ledger-query
+ requires-evaluation, and emits Claude Code's `{"decision":"deny",...}`
JSON when blocking. Each fire writes one `policy_decision` entry to the
evidence ledger via grounding-mcp `ledger_add` so `harness explain
--trace` and `harness audit` can replay decisions. The killer-test from
the founding incident is answered end-to-end: `mcp__agent-tasks__pull_requests_merge`
against a session without a `review:${PR_NUMBER}` ledger entry refuses;
the same call after `ledger record review:42 …` is allowed.

The exit-gate from `docs/ROADMAP.md` is met against a fresh tmpdir
install: deny without ledger entry / silent allow with one / silent
allow on unreachable ledger / `explain --trace` shows the full decision
trail / `audit --since 1h` lists both deny+allow fires sorted ascending
/ `dry-run "merge PR 42"` statically reports `[review-before-merge]` /
validate enhancements reject `within: yesterday`, `count.min: 0`, and
warn when policies are declared without `grounding-mcp` wired.

### Added

- **`evaluateRequires` library** (`src/policies/requires.ts`) — pure
  evaluator over the three v1 `requires` shapes returning
  `{ allowed, reason, matchedCount, traceData }`. Reason strings match
  the spec verbatim (`no matching ledger entry for tag \`<tag>\``,
  `no matching entry within <duration>`, `<n> of required <bound>
  entries found`). Rejects `within: <bad-duration>` and `count.min: 0`
  at evaluation time as well as validate time.
- **`evaluateExtract` evaluator + `validateExtractGrammar` parser**
  (`src/policies/extract.ts`) — JSONPath-restricted DSL: dotted
  accessors rooted at `toolArgs / event / session / git`, with
  bracket-quoted keys for non-identifier names. Function calls,
  numeric/slice indices, unknown namespaces all rejected with the
  spec-mandated literal phrases. Built-in vars (`SESSION_ID, REPO,
  BRANCH, TOOL_NAME, CWD`) auto-resolve; extracts override on
  collision with one trace row per variable. `substituteTemplate`
  completes the Appendix-A `review:${REPO}:${PR_NUMBER}` end-to-end.
- **`queryLedgerByTag` adapter** (`src/policies/ledger-client.ts`) —
  spawns the configured grounding-mcp, performs the
  init/notifications/initialized/`tools/call` handshake, parses
  `ledger_summary`, and returns
  `{ kind: "ok", entries } | { kind: "degraded", reason }`. Every
  spec-named failure mode (spawn ENOENT, JSON-RPC error, stdout
  closes, timeout, payload-shape drift) maps to `degraded`. Empty
  ledger ≠ degraded.
- **Validate enhancements** — schema delegates `within` to the runtime
  duration parser, rejects `count.min: 0` with the literal "no-op"
  message, validates `trigger.extract` grammar via
  `validateExtractGrammar`, and the CLI layer warns when
  `policies[]` is non-empty but no `tools.mcp[name: grounding-mcp]`
  is wired (links to `docs/ARCHITECTURE.md` §6).
- **Runtime hook interceptor** (`src/runtime/intercept.ts` +
  `src/cli/policy/intercept.ts`) — wired as `harness policy intercept`.
  Reads tool-event JSON from stdin; runs every matching policy;
  evaluates ALL, denies if any block-enforcement policy denies;
  warn-enforcement deny does NOT block. Unresolved extract →
  `warn-degraded`. Audit-write failure does NOT crash. Multiple
  matching policies on the same event all fire; one ledger entry
  per fire.
- **`harness explain <policy> --trace`** — replaces the Phase 1 stub.
  Reads the most-recent `policy_decision` entry for the named policy
  and renders the full decision trail (decision, reason,
  triggerMatched, extract substitutions, requiresEval, ledgerQuery).
  Cross-policy entries skipped; latest by `createdAt` wins; malformed
  content silently skipped. Exit codes: 64 missing policy / 1 missing
  evaluation / 1 degraded ledger.
- **`harness audit [--since <duration>] [--policy <name>] [--outcome
  <allow|deny|warn-degraded>] [--session <id>] [--json]`** — replays
  the evidence ledger for a window; default 24h. Sorted ascending.
  Empty window → documented literal, exit 0. Degraded ledger →
  `ledger unreachable: <reason>`, exit 69 (EX_UNAVAILABLE). Bad input
  → exit 64.
- **`harness dry-run "<prompt>" [--tool <name>] [--tool-args <json>]
  [--json]`** — static prediction (no LLM, no ledger I/O). With
  `--tool`, simulates a `PreToolUse` event and reports
  `ledgerQuery=<substituted tag>` for each matching policy.
  PreToolUse policies bucket as "could match" without `--tool`.
- **`policy_decision` audit-log encoding**
  (`src/runtime/ledger-record.ts`) — canonical
  `policy_decision:<name>:<outcome> <json-blob>` format with
  encode/decode round-trip helpers the audit/explain verbs consume.

### Changed

- `harness explain` is now async; the CLI awaits the result. Default
  output gains a `--trace` hint replacing the "ships in Phase 4"
  placeholder.
- Schema modules (`src/schema/extract.ts`, `src/schema/requires.ts`)
  delegate to the runtime grammar/duration helpers. No cycle:
  `policies/duration.ts` and `policies/extract.ts` are leaves.

### Notes

- Real Claude Code dogfood (vs. a fake stdio script) is captured in
  the v0.4.0 release PR description; tests use the fake-stdio pattern
  from `tests/probes/mcp.test.ts`.
- Test count: 519/519 green (pre-release; up from 417 at v0.3.0).

## [0.3.0] - 2026-04-30

**Phase 3: declarative truth.** `harness apply` regenerates
`harness.generated/settings.json` and `harness.generated/MEMORY.md` from
the manifest, with the three-state drift detection from
`docs/ARCHITECTURE.md` §7 protecting hand-edits. `harness.lock` pins
SHA-256 of every referenced asset (hook scripts, MCP entrypoints, skill
SKILL.md, memory-router binary) plus per-directory Merkle aggregates for
memory dirs. `harness diff --since-apply` reports drift across three
sections (generated files, asset SHAs, memory dirs); `--memory-detail`
expands per-directory Merkle entries to per-file changes. Asset-content
drift is reported on every apply against the lock with the canonical
message format: `asset drift detected: <path> changed since last apply`.

The exit-gate from `docs/ROADMAP.md` is met: against a fresh tmpdir
install of `init --template full`, `apply` writes both generated files
and the lock; re-`apply` is `no changes`; hand-edited
`harness.generated/settings.json` refuses with the documented diff +
hint and `--overwrite-drift yes` restores it; an externally-edited hook
script surfaces `asset drift detected:` on stderr; a memory-file edit
under a tracked memory directory surfaces a single Merkle drift line
which `diff --since-apply --memory-detail` expands to the changed
filename.

### Added

- `harness apply [--config <path>] [--project <name>] [--dry-run] [--overwrite-drift]`
  — regenerate runtime files from the manifest. Three-state comparator
  (manifest-expected / last-applied / on-disk-current) decides per file:
  `safe-overwrite` (write fresh), `no-drift` (overwrite is safe), or
  `drift-refuse` (refuse with diff + adopt-or-overwrite hint). Drift
  refusal exits 1; `--overwrite-drift` requires literal `yes` (case-
  insensitive, rejects `y`) before discarding hand-edits. `--dry-run`
  prints the would-be diff and restart hints, exits 0 without writing.

- `harness diff --since-apply [--memory-detail] [--json]` — diff against
  the last applied state. Three sections: `# Generated files` (unified
  diff per file), `# Asset drift` (lock SHA mismatches), `# Memory
  directories` (Merkle drift; `--memory-detail` expands to per-file
  added / removed / modified). Exit 0 on no drift; exit 1 on any
  drift. Mutually exclusive with `--since <ref>` (EX_USAGE).

- Asset-content drift detection on every apply: re-hashes every locked
  asset / memory-dir Merkle, surfaces mismatches as warning-style
  stderr lines. Warn-only by default; the lock is rewritten with current
  SHAs at the end of the run, so drift is reported once and the next
  apply is clean. Users wanting enforcement wrap apply in a script that
  greps for `asset drift detected:`.

- Restart-hint emitter: comparing the prior-apply manifest snapshot with
  the current effective manifest, apply prints `mcp servers changed; …`
  on `tools.mcp[]` change, `memory router command changed; …` on
  `memory.router.command` change, `hooks changed; …` on hook /
  policy structure change. Description-only edits emit no hints.

- Library modules (no CLI verbs of their own):
  - `src/io/three-state.ts` — `compare()` returning `safe-overwrite` /
    `no-drift` / `drift-refuse` per the §7 decision table.
  - `src/io/last-apply.ts` — read/write `harness.generated/.last-apply`
    with file SHA + content + optional manifest snapshot + optional
    per-memory-dir per-file index. Atomic-write contract from Phase 2.
    `verifyLastApplyIntegrity()` defends against on-disk corruption.
  - `src/io/harness-lock.ts` — NDJSON `harness.lock` writer/reader.
    Asset entries (hook scripts, MCP entrypoints, skill SKILL.md,
    memory-router binary) plus Merkle-style memory-dir aggregates.
    `enabled: false` mcp[] / `memory.router` and known interpreter
    binaries (`node`, `npx`, `python`, `bash`, `sh`, `tsx`, `deno`,
    `bun`) are excluded. Locale-independent byte-order sort.
    `computeDrift()` returns missing/modified per locked asset.
  - `src/io/restart-hints.ts` — pure manifest-delta to hint list.
  - `src/cli/apply/generate-settings.ts` — manifest hooks projection
    into Claude Code's nested `settings.json` shape.
  - `src/cli/apply/generate-memory-index.ts` — walks
    `memory.directories[]`, parses frontmatter, emits the markdown
    index. CRLF-tolerant; matches the canonical loader's strict
    `name` + `type` requirement; warns + skips on basename collision
    across memory directories.

### Decided here

- **Lock granularity.** Every referenced path gets one entry, except
  memory directories which collapse to a Merkle aggregate per directory
  (so a 1000-memory install does not produce a 1000-line lock). Per-
  file detail is recoverable on demand via
  `harness diff --since-apply --memory-detail`. Per-file index lives
  in `.last-apply` (next to the directory hash); the lock stays small.

- **Asset drift is warn-only at apply time.** Enforcement is one shell
  script wrapper away (`grep "asset drift detected:"`); coupling
  enforcement into the verb itself would be the wrong default for the
  founding-incident use case (where one edit upstream of harness
  shouldn't block the user from re-applying).

- **`apply` writes to `harness.generated/`.** When `--config` is passed
  without an explicit home, generated artefacts live next to the
  configured manifest, not in `~/.claude/harness.generated/`. This
  closes a smoke-test footgun where running with `--config /repo/...`
  silently scribbled into the user's global runtime directory.

- **Manifest snapshot integrity.** The optional manifest snapshot in
  `.last-apply` is sha-checked before being used for restart-hint
  comparison; on mismatch, hints fall back to "no prev manifest" so a
  corrupted record does not produce confidently-wrong restart hints.

- **`path_match` and `bash_match` do NOT survive the settings.json
  projection.** Per ARCHITECTURE Appendix A canonical pattern, these
  filters are enforced inside the referenced hook script. The manifest
  fields exist for `validate` / `doctor` inventory.

### Carried into Phase 4

- **No policy enforcement.** Policies are still schema-only;
  `requires.ledger_tag` / `+ within` / `+ count` evaluation against the
  evidence ledger lands in Phase 4.
- **No `validate --check-lock`.** Lock-drift is surfaced by `apply`
  and `diff --since-apply` in Phase 3; folding it into `validate`
  is a deferred follow-up.

## [0.2.0] - 2026-04-29

**Phase 2: managed edits.** Five write verbs (`init`, `add`, `remove`,
`adopt`, `export`) plus the foundation library (file lock, atomic write,
schema-validate-before-write, unified-diff emitter). The exit-gate from
`docs/ROADMAP.md` is met: a fresh tmpdir round-trip of init → add (mcp /
cli / hook / skill) → adopt → export → remove → validate runs clean,
with comments preserved across every mutation.

### Added

- `harness init [--template minimal|full] [--force] [--config <path>]` —
  bootstrap a starter manifest. `minimal` is the empty-but-valid header
  + comment block (`harness validate` passes immediately). `full` is
  pre-populated from ARCHITECTURE.md Appendix A (3 MCPs, 3 CLIs, 4
  skills, 4 hooks, 3 policies). Refuses to overwrite without `--force`;
  `--force` emits an `(overwriting ...)` line on stderr.

- `harness add <type> <name> ...` — managed insert. Four sub-commands:
  `add mcp <name> --command <cmd> [--health-verb <v>] [--health-timeout-ms <n>] [--enabled <bool>]`,
  `add cli <name> --binary <b> [--required] [--min-version <v>]`,
  `add skill <name>` (managed enable in `tools.skills.enabled[]`),
  `add hook <name> --event <e> --command <c> [--match <r>] [--blocking false|soft|hard] [--budget-ms <n>]`.
  Common flags `--config <path>`, `--dry-run`. Two-stage gate before
  writing: schema (catches duplicate names, dangling references) +
  asset (catches non-+x hook scripts, missing required CLIs). Dry-run
  emits the unified diff and exits 0 without writing.

- `harness remove <type> <name>` — drop entries by name with hook-aware
  reference check. Refuses to remove a hook still referenced by a
  policy unless `--force`; with `--force`, the schema gate (dangling
  `policy.hook`) is the safety net so a broken manifest never lands.
  `<unknown>` exits 1 with the available-name list. `--dry-run` shows
  the patch with `-` lines.

- `harness adopt <file> [--yes]` — capture hand-edits from
  `~/.claude/settings.json` back into the manifest. Computes drift
  (settings hooks not declared in the manifest), synthesises names
  from command basenames with `-2/-3/...` disambiguation, prints the
  unified diff, prompts `Apply (y/N)?` per the write-and-confirm
  decision. `--yes` skips the prompt. Adopted hooks default to
  `blocking: false` so capture never starts gating tool calls
  unintentionally. Idempotent on re-run.

- `harness export [--sanitize] [--json] [-o <file>]` — emit the
  effective merged manifest as a single self-contained YAML or JSON.
  `--sanitize` rewrites `/home/<user>/...` → `~/...` (with a trailing-
  separator anchor so `/home/lan` does not match inside
  `/home/landscape`) and redacts env values whose key matches
  `/(_|^)(KEY|TOKEN|SECRET|PASSWORD|API_KEY)$/i` to `<REDACTED>`.
  Footer comment names what is and is not covered. `-o <file>` writes
  atomically via the foundation's tmp+fsync+rename.

- `src/io/` foundation library: `withFileLock(lockPath, fn)` (via
  `proper-lockfile`, lock-then-mutate-then-release), `atomicWriteFile`
  (tmp+fsync+rename), `withDocument` (CST round-trip preserving user
  comments and long flow sequences), `validateBeforeWrite`
  (parseManifest gate returning structured errors), `unifiedDiff`
  (compatible with `patch -p0`).

- Example manifest + Appendix A: `grounding-mcp` MCP entry with
  `EVIDENCE_LEDGER_DB` env, the `require-preflight-evidence` hook,
  and the `preflight-before-investigation` policy that gates
  investigative `git status|log|diff|branch` on a fresh
  `agent-preflight` ledger entry. Wires the founding-incident
  block-policy concretely.

- Phase 4 ROADMAP acceptance bullet: `validate` warns when `policies[]`
  is non-empty but no `tools.mcp[]` entry named `grounding-mcp` is
  wired (prevents silent degraded-mode failure).

### Changed

- `agent-preflight` repositioned in README §Related and across
  VISION / ARCHITECTURE / ROADMAP as the **canonical implementation**
  of preflight hook content, not a sibling tool. The hook script
  `~/.claude/hooks/git-preflight.sh` is canonically a thin wrapper
  around `preflight run --json` + a `ledger record preflight:${REPO}`
  call. ARCHITECTURE §5 acknowledges this pattern: hook commands are
  routinely thin wrappers around named tools, not bespoke shell.

- `withDocument` now passes `lineWidth: 0` to the YAML stringifier so
  long flow sequences are not silently rewritten to block style on
  round-trip.

### Decided here

- **`harness adopt` UX: write-and-confirm.** Reads the file, computes
  the patch, prints a unified diff, prompts `Apply (y/N)?`. No editor
  mode, no patch-to-stdout shape. `--yes` is the non-interactive
  escape hatch. Per ROADMAP "Open decisions resolved here #2".

- **`harness add policy` is intentionally absent in Phase 2.** Policy
  evaluation lands in Phase 4; shipping `add policy` here would create
  the schema-without-behaviour failure mode.

### Known limitations carried from Phase 1

- No `harness apply` (Phase 3): adopt captures from settings.json into
  the manifest, but the inverse — generating settings.json *from* the
  manifest — is Phase 3.
- No policy evaluation (Phase 4): the schema parses `requires` /
  `trigger.extract` and `validate` lints them, but no policy fires
  against the ledger yet.
- No `harness.lock` (Phase 3): asset-content drift (a hook script
  edited under your feet) is not yet detectable; manifest-layer
  drift is.

## [0.1.0] - 2026-04-29

**Phase 1: read-only inventory.** First releasable cut. Six CLI verbs
(`describe`, `validate`, `doctor`, `list`, `explain`, `diff`) backed by a
single zod-validated YAML manifest with a per-machine + per-project
override layer. No write-side verbs yet, no policy evaluation, no lock
file. The exit-gate from `docs/ROADMAP.md` is met: `harness doctor` against
a real manifest reproduces the Appendix-D structure with `✗ FAILED:` lines
that surface the actual MCP-server stderr, not generic "unhealthy" labels.

### Added

- `harness describe [--config <path>] [--project <name>] [--pillar <p>] [--json]` —
  print the effective merged manifest. YAML by default, JSON via `--json`.
  `--pillar` filters to one of grounding / tools / memory / hooks /
  policies. Golden fixture `docs/examples/full-manifest.expected.yaml`
  locks the format down byte-for-byte.

- `harness validate [--config <path>] [--project <name>] [--strict]` —
  schema lint plus six asset-existence checks: `mcp[].command` first-arg
  rooted-path resolution, `cli[].binary` `$PATH` resolution + semver
  comparison against `min_version`, `tools.skills.required` SKILL.md
  presence, `hooks[].command` exists/regular-file/`+x`, `tools.builtin`
  one-sided drift warning. `--strict` promotes warnings to errors.
  Diagnostics print to stderr; clean runs print "no validation findings"
  to stdout. Exit codes per `sysexits.h`: 1 / 64 / 66.

- `harness doctor [--config <path>] [--project <name>] [--shallow]` —
  the killer-test value-demo. Spawns each `mcp[]` server, runs
  initialize → tools/call over JSON-RPC stdio, races against the
  configured `health.timeout_ms` and the child's exit. Captures stderr
  verbatim so a broken server surfaces with the actual error message.
  `--shallow` skips probe spawning (useful in tight iteration loops);
  reports `~ name  manifest-only (probe skipped)` instead of falsely
  claiming "healthy". Output follows ARCHITECTURE Appendix D structure
  (Manifest / Tools / Memory / Hooks / Policies / Summary).

- `harness list <category> [--filter <substr>] [--json]` —
  pipe-friendly flat listing across the six categories
  (`mcp` / `cli` / `skills` / `memories` / `hooks` / `policies`).
  Default output is a column-aligned table; `--json` gives a flat
  array suited for `jq`. `--filter` is case-insensitive substring
  match on `name` (or `path` for `memories`).

- `harness explain <policy-name> [--json]` — schema-only printer for a
  named policy. Includes the Phase-1 caveat
  `schema valid; last-evaluated tracking ships in Phase 4`. Missing
  policy → exit 64 with the available-name list (`(none)` when zero
  policies are declared). `--trace` is intentionally NOT wired here;
  it lands in Phase 4.

- `harness diff --since <ref>` — manifest-layer diff against a git ref.
  Name-keyed lists (`tools.mcp[]`, `hooks[]`, `policies[]`) diff by
  `name`, so a single field change emits exactly one hunk on that
  field rather than a wholesale list re-emit. Output groups changes
  under per-pillar headers (`## tools`, `## hooks`, etc.).
  `--since-apply` is explicitly Phase 3 and not wired.

- **Manifest schema (zod)** for `version: 1` covering all five pillars
  (grounding / tools / memory / hooks / policies) with strict-by-default
  unknown-key rejection. Includes the `trigger.extract:` JSONPath
  grammar (restricted to dotted accessors rooted at `toolArgs` /
  `event` / `session` / `git`) and the three v1 `requires` shapes
  (`ledger_tag`, `+ within`, `+ count`). Cross-policy validation
  rejects `${PR_NUMBER}` references that lack a matching
  `trigger.extract` entry.

- **Override engine** implementing every `ARCHITECTURE.md` §8 rule:
  scalar replace, map merge, name-keyed list merge, plain-list
  wholesale replace, `null` tombstone, empty-list `[]` clears,
  mixed-shape rejection, `_delete: true` removal. Result is fully
  owned (deep-cloned), so callers can mutate without corrupting the
  parsed base.

- **Per-machine override layer** at
  `~/.claude/machines/<discriminator>.harness.overrides.yaml` with
  three discriminator types (`hostname` / `os` / `default`) and
  WSL2 detection via `/proc/version` containing `microsoft`
  (case-insensitive). Merge order: base → os → hostname → project.

- **MCP stdio probe** (`src/probes/mcp.ts`) with `RealMcpProbe` (real
  spawn) + `McpProbe` interface for test injection. Concurrent probes
  via `Promise.all`. EPIPE handling on early-exit servers; pending
  timers are cleared in `finally`.

- **Memory introspection** (`src/probes/memory.ts`): walks declared
  memory directories, surfaces `*.md` files older than
  `retention.staleness_days` with last-touched dates. Router-executable
  detection picks the first absolute / `~/...` path in
  `memory.router.command`, not the runtime binary.

- **Loader split** (`loadMergedRaw` vs `loadManifest`) so `validate`
  can convert schema errors to structured diagnostics (exit 1) while
  `describe` keeps refusing to print broken manifests (exit 66).

### Resolved design questions

Per `docs/ROADMAP.md` "Open decisions resolved here":

- **Phase-1 doctor health checks: real call default + first-class
  `--shallow` flag.** The default mode invokes each `mcp[].health.verb`
  with the configured `timeout_ms` so users learn the diagnostic value
  immediately. `--shallow` is the explicit fast-path opt-in; both modes
  are first-class.

- **Override granularity for memory directories.** Lists of
  name-keyed entries (`tools.mcp`, `hooks`, `policies`) merge by
  `name`; lists without `name` (`memory.directories`) replace
  wholesale. Mixed-shape lists are rejected at merge time.

- **`harness adopt` UX (Phase 2 deferred).** Per ROADMAP, write-and-confirm
  is the chosen pattern: `harness adopt <file>` will read the on-disk
  file, compute the manifest patch, print a unified diff, and prompt
  `Apply (y/N)?`. This release does not ship `adopt`; the decision is
  recorded so Phase 2 picks up where the design left off.

- **Policy storage location (Phase 4 deferred).** Inline `policies:` in
  the main manifest is the runtime-firing surface; library-style
  imported policies (e.g. claim-gate via `grounding.policies_source`)
  stay in their own DSL files. Phase 1 only validates the inline shape;
  Phase 4 wires the evaluator.

### Known limitations (deferred to later phases)

- **No `harness apply`.** Source-of-truth applies at the *manifest*
  layer only; runtime files (`~/.claude/settings.json`, etc.) stay
  user-owned in Phase 1. Generation lands in Phase 3.
- **No policy evaluation.** Policies are schema-only in Phase 1;
  `harness explain --trace` and `harness audit` ship in Phase 4.
- **No `harness.lock`.** Asset-content drift (a hook script edited
  under your feet) is detectable only after the lock file ships in
  Phase 3.
- **No write verbs.** `init`, `add`, `remove`, `adopt`, `export`
  ship in Phase 2.

### Tests

147 vitest cases across 12 files. Line coverage: 93.75% on `src/`.

[0.1.0]: https://github.com/LanNguyenSi/harness/releases/tag/v0.1.0
