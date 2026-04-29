# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

143 vitest cases across 13 files. Line coverage: 93.75% on `src/`.

[0.1.0]: https://github.com/LanNguyenSi/harness/releases/tag/v0.1.0
