# Architecture

This document makes the shape of `harness` concrete. It follows [`VISION.md`](VISION.md), which established *why* a declarative control plane exists; this document decides *what* it looks like: the manifest schema, file layout, CLI surface, override rules, and implementation stack.

It is prescriptive but not final. Anything here is open to revision before Phase 1 begins, and explicitly versioned (`version: 1`) so future breaking changes stay visible. Once Phase 1 lands, changes to this shape require a minor-version bump on the manifest plus a migration note.

The phase-by-phase plan is deliberately *not* here — it belongs in [`ROADMAP.md`](ROADMAP.md), which follows this document. Likewise, concrete hook scripts belong in Phase 2, not here.

---

## 1. Manifest — top-level shape

A harness configuration is a single YAML file. Five top-level keys, one required header:

```yaml
version: 1                 # required; bumped on breaking schema changes

grounding: {…}             # pillar 1: evidence, policies, session config
tools: {…}                 # pillar 2: mcp + cli + skills + builtin inventory
memory: {…}                # pillar 3: directories, retention, scopes
hooks: […]                 # cross-cutting: event-bound shell commands
policies: […]              # cross-cutting: named rules that bind hooks to triggers
```

`grounding`, `tools`, `memory` map to the three pillars from VISION §3. `hooks` and `policies` are the cross-cutting layer that wires them to the runtime — they sit at the top level because multiple pillars reference them. Every other piece of config either lives under a pillar or is derived from the pillars.

There is no other top-level key. If a future concept (e.g. credentials, observability) does not fit under these five, that is the signal for an architecture revision, not a sixth sibling key added casually.

## 2. `grounding:` section

Wires the existing `agent-grounding` primitives (evidence-ledger, claim-gate, review-claim-gate, grounding-mcp) to the harness. Schema:

```yaml
grounding:
  session:
    auto_start: true                          # start a grounding session at harness boot
    id_format: "gs-{repo}-{timestamp:6}"      # format for auto-generated session ids
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db        # where ledger.db lives
    retention_days: 90                        # passed to `ledger prune --older-than`
  policies_source: ~/.claude/harness.d/policies/claim-gate.yaml
```

Notes:

- **`auto_start: true`** is the default because per VISION §3 Grounding the current "sessions must be started manually" mode is a sharp edge. Setting it to `false` disables auto-start for users who want to script it themselves.
- **`policies_source`** points to a file, not inline policies. Claim-gate policies are opinionated data structures (claim types × required evidence), arguably their own DSL. Keeping them out of the top-level manifest prevents the manifest from bloating and lets policy libraries be shared or versioned independently.
- **`retention_days`** is a hint, not an enforcement. It is passed to `ledger prune` by a scheduled or hook-triggered invocation; `harness` itself does not run prune.

Field defaults:

| Field | Default | Notes |
|---|---|---|
| `session.auto_start` | `true` | |
| `session.id_format` | `"gs-{repo}-{rand:8}"` | `{repo}`, `{timestamp:N}`, `{rand:N}` tokens |
| `evidence_ledger.path` | `~/.evidence-ledger/ledger.db` | matches current ledger default |
| `evidence_ledger.retention_days` | `90` | rough heuristic, tunable |
| `policies_source` | `null` | meaning "use claim-gate's built-in POLICIES array" |

## 3. `tools:` section

Tool registrations, explicitly typed by subsection. Four sub-blocks — `mcp`, `cli`, `skills`, `builtin` — each with its own schema. Explicit typing beats a generic `tools: [ … ]` list because validation is sharper and each tool class has different health-check semantics.

```yaml
tools:
  mcp:
    - name: codebase-oracle
      command: [npx, tsx, ~/git/pandora/codebase-oracle/src/mcp-server.ts]
      env:
        ORACLE_STORE: ~/.codebase-oracle/store.db
      health:
        verb: oracle_list_repos
        timeout_ms: 5000
      enabled: true

    - name: agent-tasks
      command: [node, ~/git/pandora/agent-tasks/mcp-server/dist/server.js]
      env:
        AGENT_TASKS_URL: https://agent-tasks.opentriologue.ai
      health:
        verb: projects_list
        timeout_ms: 5000
      enabled: true

  cli:
    - name: git-batch
      binary: git-batch
      min_version: "0.2.0"
      required: true
    - name: gh
      binary: gh
      required: true
      version_command: [gh, --version]

  skills:
    enabled:
      - simplify
      - init
      - review
      - security-review
    source_dirs:
      - ~/.claude/skills

  builtin:
    # Claude-Code built-ins are read-only metadata; listed for inventory only.
    # Changing this list doesn't enable/disable anything at runtime — it just
    # tells `harness describe` which built-ins the manifest knows about.
    known:
      - Read
      - Edit
      - Write
      - Bash
      - Agent
      - Skill
      - TaskCreate
```

Per-type schemas:

### `tools.mcp[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | unique within `tools.mcp` |
| `command` | `string` or `string[]` | yes | argv-style; `string` is split on whitespace |
| `env` | `{[key: string]: string}` | no | env vars for the child process |
| `health` | `{verb: string, timeout_ms?: number}` | no | MCP verb to invoke for liveness |
| `enabled` | boolean | no (default `true`) | `false` removes from generated `~/.claude.json` in Phase 3 |

### `tools.cli[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | unique |
| `binary` | string | yes | name or path; resolved via `$PATH` unless absolute |
| `min_version` | string | no | semver; if set, `version_command` stdout is parsed |
| `version_command` | `string[]` | no | defaults to `[binary, --version]` |
| `required` | boolean | no (default `false`) | `validate` fails if missing |

### `tools.skills`

| Field | Type | Notes |
|---|---|---|
| `enabled` | `string[]` | list of skill names currently wired |
| `required` | `string[]` | subset of `enabled`; `validate` fails (exit 1) if any are missing on disk. Unlike `tools.cli.required`, this applies per-name rather than per-entry because skills are identified only by name. |
| `source_dirs` | `string[]` | where to scan for SKILL.md — first match wins |

### `tools.builtin`

Inventory only — listed so `harness describe` reports which built-ins the manifest recognises. No `enabled:` flag (built-ins can't be disabled by harness today); the field exists to make drift against runtime-available built-ins detectable.

`validate` compares `builtin.known` against the runtime's currently-advertised built-in tool list (queried via the Claude Code protocol where possible) and warns when they diverge. The warning is one-sided — a built-in listed in the manifest but not in the runtime is noise, but a runtime built-in missing from the manifest means the user hasn't acknowledged a new tool and downstream policies may not cover it.

The four tool sub-blocks (`mcp`, `cli`, `skills`, `builtin`) deliberately do not share a parent schema. Their health-check semantics, lifecycle, and registration surfaces differ enough that forcing a common shape would be abstraction for its own sake.

## 4. `memory:` section

Memory lives in markdown with frontmatter; `harness` does not change that. This section declares where memory directories are, how they are scoped, and what lifecycle rules apply.

```yaml
memory:
  directories:
    - path: ~/.claude/projects/{project}/memory
      scope: project
    - path: ~/.claude/memory
      scope: user                       # future — not wired in Phase 1
  router:
    command: [node, ~/git/pandora/agent-memory/packages/memory-router/dist/hooks/user-prompt-submit.js]
    enabled: true
  retention:
    staleness_days: 180                  # memories untouched for N days → flagged by validate
    broken_refs: warn                    # "warn" | "error" | "ignore"
  scopes:
    default: project
    allowed: [project, user]             # future: team, public
```

Notes:

- **`directories`** is a list of `{path, scope}` — `{project}` is a placeholder that `harness describe --project <name>` substitutes. For user-scope, the path is literal.
- **`router.command`** wires the existing `memory-router` hook; the manifest does not re-implement routing. In Phase 3 the `settings.json` hook section is regenerated from this value.
- **`retention.broken_refs`** decides how `validate` treats memories that reference functions/files that no longer exist. `warn` is the safe default; `error` is for projects that want a hard gate.
- **`scopes.allowed`** bounds future growth — adding `team` or `public` scope is a manifest-version bump, not a silent extension.

## 5. `hooks:` section

Each hook is a shell command bound to a runtime event, with optional match pattern, blocking mode, and timeout budget. This is the surface that `harness apply` translates into `~/.claude/settings.json`'s `hooks` section in Phase 3.

```yaml
hooks:
  - name: git-preflight
    event: SessionStart
    command: ~/.claude/hooks/git-preflight.sh
    blocking: false
    budget_ms: 30000
    description: "Fetch watchlist repos and surface drift on session start."

  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: ~/.claude/hooks/require-review-evidence.sh
    blocking: hard
    budget_ms: 2000
    description: "Block PR merges without a ledger review entry."

  - name: entrypoint-pattern-lint
    event: PreToolUse
    match: "Write|Edit"
    path_match: "**/entrypoint.sh"
    command: ~/.claude/hooks/entrypoint-pattern-lint.sh
    blocking: soft
    budget_ms: 1000
```

Schema per entry:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | unique within `hooks` |
| `event` | enum | yes | one of `session_start` / `user_prompt_submit` / `pre_tool_use` / `post_tool_use` / `stop` / `subagent_stop` / `pre_compact` |
| `command` | string | yes | shell command; executable path or script with args |
| `match` | regex (JS flavour) | no | runtime-event-scoped filter; for `PreToolUse` / `PostToolUse` this matches the tool name (e.g. `"Write\|Edit"` or `"mcp__agent-tasks__.*"`) |
| `path_match` | glob (minimatch) | no | additional filter for events that carry a file path (e.g. `Write`, `Edit`): only fire when the path matches |
| `bash_match` | regex (JS flavour) | no | additional filter when the matched tool is `Bash`: fires only when the command string matches |
| `blocking` | enum | yes | `false` / `soft` / `hard` |
| `budget_ms` | integer | no (default 30000) | timeout before hook is killed |
| `description` | string | no | surfaced by `harness describe` |

Blocking semantics, three levels:

- **`false`** (non-blocking): hook may inject `additionalContext` via stdout-JSON but the tool call always proceeds. Default choice when the hook's job is to inform.
- **`soft`**: hook may warn; agent sees the warning but the tool call still proceeds. For patterns like "you probably shouldn't `rm -rf` here" that have legitimate exceptions.
- **`hard`**: hook's non-zero exit or explicit `decision: deny` aborts the tool call. Reserved for cases where false positives are tolerable — e.g. review-evidence-gate, dogfood-trace-gate.

Pick the softest level that solves the problem. Hard-blocking is a commitment that false positives will not happen under reasonable inputs; if you're not sure, start at `soft` and promote.

## 6. `policies:` section

Named rules. Each policy names a trigger (matching the same event/match shape as `hooks`) and declares what the trigger *requires* — typically an evidence-ledger entry of a given tag. Policies reference hooks by name; the hook is the machinery, the policy is the rule.

```yaml
policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block `npm publish` or `git tag v*` without a dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "^(npm publish|git tag v.*)"
    requires:
      ledger_tag: "dogfood:${SESSION_ID}"
    hook: require-dogfood-evidence
    enforcement: block
```

Schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | unique |
| `description` | string | yes | surfaced by `harness describe` |
| `trigger` | object | yes | `event`, `match`, optional `path_match` / `bash_match` |
| `requires` | object | yes | evidence shape; today `{ledger_tag: string}`, extensible |
| `hook` | string | yes | must reference a `hooks[].name` |
| `enforcement` | enum | yes | `block` / `warn` — higher level than hook's `blocking` flag |

The `requires` field is intentionally minimal for Phase 1 (just `ledger_tag`). Future extensions (confidence floor, multi-tag, recency-window) land as schema additions at `version: 2`.

### Policy ↔ hook binding

- **Dangling `policy.hook` reference** (names a non-existent hook): `harness validate` fails with exit 1.
- **Hooks without a referencing policy**: still fire on their event. They are the plain hook path — not every hook needs a policy, but every policy needs a hook. This lets a user keep simple informational hooks (e.g. `git-preflight`) as plain hooks without inventing a policy wrapper.

### Template variables

Variables appear in `requires.ledger_tag` and are substituted at policy-evaluation time. Phase 1 ships four; the others are declared here for design coherence and will land in later phases.

| Variable | Ships in | Source |
|---|---|---|
| `${SESSION_ID}` | Phase 1 | current grounding session id |
| `${REPO}` | Phase 1 | basename of `git rev-parse --show-toplevel`, or `""` if not in a git repo |
| `${BRANCH}` | Phase 1 | `git rev-parse --abbrev-ref HEAD` |
| `${PR_NUMBER}` | Phase 1 | parsed from the matched tool's args; for `mcp__agent-tasks__pull_requests_merge` this is `toolArgs.prNumber`. For other tool matchers, `validate` rejects the policy unless the hook explicitly declares how to extract this (future `trigger.pr_number_from:` field). |
| `${TOOL_NAME}` | Phase 2 | the matched tool's canonical name |
| `${CWD}` | Phase 2 | current working directory (absolute) |
| `${PROJECT}` | Phase 2 | the harness project scope in effect |
| `${USER}` | Phase 2 | `process.env.USER` |
| `${NOW}` | Phase 3 | ISO-8601 UTC timestamp at evaluation |

**Quoting / safety.** Template substitution happens on the `ledger_tag` *string field*, not on any shell command. The substituted value is passed to the evidence-ledger query as a data argument, never as shell text. If a future template variable lands in a shell-invoked field (e.g. a hook's `command`), the implementation MUST shell-quote via the platform stdlib and `validate` MUST reject raw string interpolation. This is load-bearing against inputs like a branch named `foo$(whoami)` or `a"; rm -rf ~`.

## 7. File layout

```
~/.claude/
├── harness.yaml                          ← user-level manifest; hand-edited
├── harness.lock                          ← (Phase 3) locked resolutions (SHAs, paths); does not exist in Phase 1–2
├── harness.d/                            ← imported fragments
│   ├── policies/
│   │   └── claim-gate.yaml
│   └── hooks/
│       └── team-defaults.yaml
├── harness.generated/                    ← Phase 3+ outputs; gitignored
│   ├── settings.json                     ← regenerated from harness.yaml on `apply`
│   ├── MEMORY.md                         ← index regenerated from memory dirs
│   └── .last-apply                       ← marker for `diff --since-apply`
├── projects/
│   └── <project-name>/
│       ├── harness.overrides.yaml        ← optional per-project overrides
│       └── memory/
│           └── *.md                      ← memory files (unchanged layout)
├── hooks/                                ← physical hook scripts referenced by harness.yaml
│   ├── git-preflight.sh
│   └── require-review-evidence.sh
└── skills/                               ← skills directory (existing convention)
```

Rules:

- **`harness.yaml` is the source of truth.** If `harness.generated/settings.json` differs from what the manifest would produce, `harness apply` regenerates it. `describe` detects drift.
- **`harness.lock`** is a Phase-3 artefact. It pins resolved paths/SHAs of hook scripts, MCP commands, etc. so drift between "what the manifest referenced" and "what was actually applied" is deterministic. The exact schema (fields per category, hash algorithm, version pinning rules) is decided when Phase 3 starts, not here. Phase 1–2 implementations do not produce or consume it.
- **`harness.d/`** is for fragments imported into the main manifest. Used by `claim-gate.yaml` per §2 `policies_source`, and optionally by `hooks:` / `policies:` extension files. Imports are explicit (`policies_source: …`, not auto-scanned).
- **`harness.generated/`** is treated as a build artefact. It is `.gitignore`d and regenerated; hand-edits are overwritten on next `apply`.
- **`projects/<proj>/harness.overrides.yaml`** is optional. Present only when a project needs to deviate from user-level defaults.

## 8. Override precedence

Project overrides merge into user-level settings with three rules, depending on the shape of each key:

| Shape | Rule | Example |
|---|---|---|
| **Scalar** (string, number, bool) | Override replaces user value | `memory.retention.staleness_days: 30` in project overrides replaces user's `180` |
| **Map** | Merge by key; project keys win per-key | `grounding.evidence_ledger.path` in project overrides replaces only that path; `retention_days` from user stays |
| **List of entries with `name`** | Merge by `name`; project entries update matching user entries (by key), non-matching entries are appended | `tools.mcp[]` with `name: codebase-oracle` in project overrides patches just that MCP entry; other MCP entries survive unchanged |
| **List without `name`** | Replace wholesale | `memory.directories[]` in project overrides replaces the entire list |

The name-keyed merge is the critical rule — it lets projects say "disable this one MCP server" without re-listing every other MCP server. Example:

```yaml
# user: ~/.claude/harness.yaml
tools:
  mcp:
    - name: codebase-oracle
      enabled: true
      command: [npx, tsx, /path/to/oracle.ts]
    - name: agent-tasks
      enabled: true
      command: [node, /path/to/tasks.js]
```

```yaml
# project: ~/.claude/projects/agent-grounding/harness.overrides.yaml
version: 1
tools:
  mcp:
    - name: codebase-oracle
      enabled: false    # disable oracle in this project; agent-tasks stays as-is
```

Effective manifest for that project has `codebase-oracle` with `enabled: false` and `agent-tasks` unchanged.

### Edge cases

| Case | Behaviour |
|---|---|
| **`null` value in project override** | Removes the key from the effective manifest (tombstone). `memory.router: null` unwires the router entirely, not "inherit". |
| **Empty list `[]`** | Clears the list in the effective manifest. `tools.mcp: []` disables all MCP servers; same for any other list-valued key. This is the explicit way to say "no entries here". |
| **New name-keyed entry not in user** | Appended, in project-declaration order, after user entries. Two projects adding the same `name` to their overrides is a no-op conflict (each project overrides only its own effective manifest). |
| **Mixed-shape list (some entries with `name`, some without)** | `validate` error. A list is either name-keyed or not; mixing is not supported. |
| **Removing a user entry** | Use `_delete: true` on a name-keyed entry (e.g. `- name: codebase-oracle\n  _delete: true`) to drop that entry from the effective manifest. This is the only supported removal syntax — omitting an entry does *not* remove it; it inherits unchanged. |
| **Project override sets key that user omitted entirely** | Added. Inheriting a "nothing" from user and introducing a "something" in project is fine. |

**Override files must have `version:` matching the user-level manifest.** `harness validate` flags mismatched versions.

## 9. CLI surface

Single binary, `harness`. Subcommands grouped by capability:

### Read-only

```
harness describe [--project <name>] [--pillar <grounding|tools|memory|hooks|policies>] [--json]
  Print the effective (merged) manifest, optionally filtered to one pillar.

harness validate [--project <name>] [--strict]
  Lint the manifest + referenced assets. Exit 1 on any error; exit 0 with stderr warnings otherwise.
  --strict turns warnings into errors.

harness doctor [--project <name>]
  Human-readable summary — tool health, memory corpus stats, hook registrations,
  recently-fired hooks (from ledger). Multi-section output, always exit 0 unless
  the manifest itself is unreadable.

harness diff [--since <ref>] [--since-apply]
  Show changes to the effective manifest. --since <ref> diffs against a git ref
  in the harness.yaml dir; --since-apply diffs against harness.generated/.last-apply.

harness list <skills|memories|tools|hooks|policies> [--filter <substr>] [--json]
  Flat listing of one category, filter-friendly. `describe --pillar` prints the
  full nested tree; `list` prints a single denormalised table suited for piping
  to grep / awk.

harness explain <policy-name> [--trace]
  Why did this policy behave as it did on its last evaluation? Shows the
  trigger match result, the requires evaluation (ledger query + result), and
  the final enforcement decision. --trace extends the output with the full
  variable-substitution trail. Essential for diagnosing "why did my merge get
  blocked" without reading the ledger by hand.
```

### Write-side (Phase 2+)

```
harness init [--template minimal|full] [--force]
  Bootstrap ~/.claude/harness.yaml. Refuses to overwrite without --force.

harness add mcp <name> [--command <cmd>] [--health-verb <v>] ...
harness add cli <name> --binary <b> [--required]
harness add skill <name>
harness add hook <name> --event <e> --command <c> [--match <r>] [--blocking <m>]
  Managed edits. Safe against concurrent edits (lock file), schema-validating
  before write.

harness remove <type> <name>
  Removes by name. Prompts if referenced elsewhere (e.g. policy referencing a hook).

harness apply [--dry-run]
  Regenerate harness.generated/ outputs from the manifest. --dry-run prints the
  would-be diff without writing. Does NOT restart MCP servers or reload Claude
  Code — emit a message telling the user which restart actions are needed
  (e.g. "MCP servers changed; /mcp reconnect required"). Phase 3.

harness export [--sanitize] [-o <file>]
  Emit the effective manifest as a single self-contained YAML. --sanitize
  strips absolute home paths and env secrets so the output is shareable.
```

### Phase 3+

```
harness dry-run "<prompt>"
  Simulate what would happen if the prompt were submitted now — which hooks
  would fire, which policies apply, which memories route. Requires the runtime
  to cooperate; Phase 4 feature.

harness audit [--since <when>]
  Replay the evidence-ledger for a time window; cross-reference with harness
  decisions. Provenance tool.
```

### Common flags

- `--config <path>`: override the default `~/.claude/harness.yaml` location
- `--json`: structured output where applicable
- `--quiet` / `--verbose`: tune stderr
- `--no-color`: disable ANSI
- `--help`: print command-specific help

### Exit codes

Follows BSD `sysexits.h` where applicable, extended only where a generic code (`1`) is clearer than a specific BSD code:

| Code | Symbol | Meaning |
|---|---|---|
| 0 | — | success |
| 1 | — | validation / lint error; a user-facing assertion failed |
| 64 | `EX_USAGE` | bad CLI arguments |
| 66 | `EX_NOINPUT` | configuration file not found or unreadable |
| 69 | `EX_UNAVAILABLE` | an external tool/process failed (MCP unreachable, required CLI missing, git call failed) |
| 70 | `EX_SOFTWARE` | internal error in `harness` itself |

`1` is retained for the common "your config is wrong, here is how" failure because it's what every shell user expects from a linter. All other failures map to a specific sysexits code so scripts can branch on them.

## 10. Implementation stack

**Node 20+ LTS** with **TypeScript**. Rationale:

- **Fit with ecosystem.** `memory-router` is Node/TS. `agent-tasks` MCP bridge is Node. `evidence-ledger` is Node (better-sqlite3). `git-batch-cli` is Node. Using Node means reusing these as libraries, not wrapping them as subprocesses.
- **Types for the manifest.** The manifest schema is non-trivial (five top-level sections, name-keyed merges, template variables). TypeScript + a schema lib gives compile-time and runtime safety.
- **Prior art in Lan's repos.** Every recent CLI (`git-batch`, `ledger`, `memory-router`) is Node/TS. Matching that reduces context-switch cost for future maintenance.

Dependencies (pinned in Phase 1):

| Package | Purpose |
|---|---|
| `zod` | Runtime schema validation + TS types |
| `yaml` | YAML parse/serialize with comment preservation (for `apply`) |
| `commander` | CLI parsing |
| `execa` | Process execution (MCP health checks, CLI version checks) |
| `chalk` | Terminal colouring (matches existing CLI style) |
| `better-sqlite3` | Optional, only if reading evidence-ledger directly (vs. shelling out to `ledger`) |

Language-service dependencies:

- `typescript` (dev)
- `tsx` (dev) — fast TS execution without build for local iteration
- `vitest` (dev) — test framework matching existing repos

Package layout: single package `harness` in Phase 1 (single source tree, single binary). If `harness` grows a library surface for external tools to consume (e.g. agent-tasks wants to read the effective manifest programmatically), it becomes a monorepo at Phase 3+ boundary. Deferred until concrete consumer exists.

Build:

- `tsc` produces `dist/cli.js`
- `bin` entry in `package.json` points at compiled output
- `npm run build` / `npm test` / `npm run typecheck` — standard scripts matching existing repos

## 11. Versioning and backwards compatibility

Manifest version is an integer in the top-level `version:` key. Semver does not map cleanly here because the manifest has one consumer (the `harness` CLI) and breaking changes are migrations, not interface shifts.

Rules:

- **`version: 1`** is the shape defined in this document. `harness` CLI 0.x targets manifest `version: 1`.
- **Adding new optional fields** is backwards-compatible — does not bump `version`.
- **Adding new sub-blocks under an existing pillar** (e.g. `tools.containers`) is backwards-compatible — does not bump `version`.
- **Adding a new enum value** (e.g. a new `blocking` level, a new `event` type) is backwards-compatible — does not bump `version`.
- **Removing a field, removing an enum value, changing a default semantically, or changing merge rules** is a breaking change — bumps `version` to `2`. `harness validate` on `version: 1` manifests still works (read-compatible) for at least one major CLI version.
- **`harness apply` on a `version: 1` manifest after CLI upgrade** migrates in-place if possible; otherwise fails with a specific migration guide.
- **Unknown keys inside a known version**: `harness validate` rejects them with exit 1 in Phase 1. This is the strict default — typos should surface loud, not silently ignore. Once the manifest schema is stable (post Phase 3), a `--lenient` mode may accept and warn instead.
- **Unknown `version:` value** (e.g. the CLI is `version: 1`-only but the manifest declares `version: 2`): `harness validate` exits 66 (`EX_NOINPUT`) with a message pointing at the CLI upgrade. No partial parsing is attempted — forward-compatibility in the other direction is not a promise.

The intent is that a user's `harness.yaml` written against `version: 1` keeps working for as long as practical without editing. That promise is load-bearing because this file is the human-facing surface of the whole project.

CLI versioning follows normal SemVer (`harness --version` → `0.1.0` etc.).

## 12. Out of scope for this document

Explicitly deferred:

- **Phase-by-phase acceptance criteria.** That's `ROADMAP.md`.
- **Concrete hook scripts.** `git-preflight.sh`, `require-review-evidence.sh`, etc. get written in Phase 2 against this spec. The shape of the scripts is constrained by §5; the content is not.
- **The claim-gate policies DSL.** `policies_source: …` points at a separate file; its schema lives in `agent-grounding/packages/claim-gate` and evolves there.
- **Team / multi-tenant scopes.** `memory.scopes.allowed` lists only `project` and `user` for Phase 1. Team and public scopes require coordination (auth, identity) that a local control plane cannot provide alone.
- **Runtime integration with non-Claude-Code harnesses.** The hook-event vocabulary in §5 is Claude-Code-specific. Porting to another runtime requires mapping, not just re-implementation.
- **`harness dry-run "<prompt>"`** requires runtime cooperation (the harness must be able to stub the agent loop). Deferred to Phase 4.
- **UI.** Any graphical or web-based presentation of the manifest. The CLI is the whole interface.

---

## Appendix A — Full example manifest

```yaml
# ~/.claude/harness.yaml
version: 1

grounding:
  session:
    auto_start: true
    id_format: "gs-{repo}-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db
    retention_days: 90
  policies_source: ~/.claude/harness.d/policies/claim-gate.yaml

tools:
  mcp:
    - name: codebase-oracle
      command: [npx, tsx, ~/git/pandora/codebase-oracle/src/mcp-server.ts]
      health:
        verb: oracle_list_repos
        timeout_ms: 5000
      enabled: true
    - name: agent-tasks
      command: [node, ~/git/pandora/agent-tasks/mcp-server/dist/server.js]
      env:
        AGENT_TASKS_URL: https://agent-tasks.opentriologue.ai
      health:
        verb: projects_list
        timeout_ms: 5000
      enabled: true

  cli:
    - name: git-batch
      binary: git-batch
      min_version: "0.2.0"
      required: true
    - name: gh
      binary: gh
      required: true
    - name: ledger
      binary: ledger
      required: false

  skills:
    enabled:
      - simplify
      - init
      - review
      - security-review
    source_dirs:
      - ~/.claude/skills

  builtin:
    known: [Read, Edit, Write, Bash, Agent, Skill, TaskCreate]

memory:
  directories:
    - path: ~/.claude/projects/{project}/memory
      scope: project
  router:
    command: [node, ~/git/pandora/agent-memory/packages/memory-router/dist/hooks/user-prompt-submit.js]
    enabled: true
  retention:
    staleness_days: 180
    broken_refs: warn
  scopes:
    default: project
    allowed: [project, user]

hooks:
  - name: git-preflight
    event: SessionStart
    command: ~/.claude/hooks/git-preflight.sh
    blocking: false
    budget_ms: 30000
    description: "Fetch watchlist repos and surface drift on session start."

  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: ~/.claude/hooks/require-review-evidence.sh
    blocking: hard
    budget_ms: 2000

  - name: require-dogfood-evidence
    event: PreToolUse
    match: "Bash"
    command: ~/.claude/hooks/require-dogfood-evidence.sh
    blocking: hard
    budget_ms: 2000

policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "^(npm publish|git tag v.*)"
    requires:
      ledger_tag: "dogfood:${SESSION_ID}"
    hook: require-dogfood-evidence
    enforcement: block
```

## Appendix B — Full override example

```yaml
# ~/.claude/projects/agent-grounding/harness.overrides.yaml
version: 1

grounding:
  evidence_ledger:
    retention_days: 30        # this project prunes more aggressively

tools:
  mcp:
    - name: codebase-oracle
      enabled: false          # too noisy in this repo

  cli:
    - name: git-batch
      required: false         # this repo doesn't need it

hooks:
  - name: require-review-evidence
    blocking: hard            # explicitly reinforce; inherited already hard

policies:
  - name: dogfood-before-release
    enforcement: block        # same as user default; listed for clarity
```
