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
      command: [node, ~/git/pandora/agent-tasks/mcp/dist/server.js]
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
| `source_dirs` | `string[]` | where to scan for SKILL.md — first match wins |

### `tools.builtin`

Inventory only — listed so `harness describe` reports which built-ins the manifest recognises. No `enabled:` flag (built-ins can't be disabled by harness today); the field exists to make drift against runtime-available built-ins detectable.

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
    event: session_start
    command: ~/.claude/hooks/git-preflight.sh
    blocking: false
    budget_ms: 30000
    description: "Fetch watchlist repos and surface drift on session start."

  - name: require-review-evidence
    event: pre_tool_use
    match: "mcp__agent-tasks__pull_requests_merge"
    command: ~/.claude/hooks/require-review-evidence.sh
    blocking: hard
    budget_ms: 2000
    description: "Block PR merges without a ledger review entry."

  - name: entrypoint-pattern-lint
    event: pre_tool_use
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
| `match` | regex | no | runtime-event-scoped filter (e.g. tool name for `pre_tool_use`) |
| `path_match` | glob | no | additional filter for file-path-bearing events |
| `blocking` | enum | yes | `false` / `soft` / `hard` |
| `budget_ms` | integer | no (default 30000) | timeout before hook is killed |
| `description` | string | no | surfaced by `harness describe` |

Blocking semantics match VISION §2 Enforcement-Härtegrade:

- **`false`** (non-blocking): hook may `additionalContext` via stdout-JSON but the tool call always proceeds.
- **`soft`**: hook may warn; agent sees the warning but tool call still proceeds. For patterns like "you probably shouldn't `rm -rf` here" that have legitimate exceptions.
- **`hard`**: hook's non-zero exit or explicit `decision: deny` aborts the tool call. Reserved for cases where false positives are tolerable (review-evidence, dogfood-trace).

## 6. `policies:` section

Named rules. Each policy names a trigger (matching the same event/match shape as `hooks`) and declares what the trigger *requires* — typically an evidence-ledger entry of a given tag. Policies reference hooks by name; the hook is the machinery, the policy is the rule.

```yaml
policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: pre_tool_use
      match: "mcp__agent-tasks__pull_requests_merge"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block `npm publish` or `git tag v*` without a dogfood ledger entry.
    trigger:
      event: pre_tool_use
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

**Template variables** in `requires.ledger_tag`:

- `${PR_NUMBER}` — the PR number being merged (extracted from tool args)
- `${SESSION_ID}` — the current grounding session id
- `${REPO}` — the cwd's git repo name
- `${BRANCH}` — the current git branch

More may be added as needed; each one documented.

## 7. File layout

```
~/.claude/
├── harness.yaml                          ← user-level manifest; hand-edited
├── harness.lock                          ← locked resolutions (SHAs, paths) — generated, committed optional
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
- **`harness.lock`** is optional in Phase 1, required for Phase 3. It pins the resolved paths/SHAs of hook scripts, MCP commands, etc. so drift is deterministic.
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
  would-be diff without writing.
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

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | validation/lint error, or user-visible assertion failure |
| 2 | configuration not found or unreadable |
| 3 | external tool/process failure (MCP unreachable, CLI missing, git command failed) |
| 64 | bad CLI arguments |

Codes above 64 follow BSD `sysexits.h` conventions where applicable (`64 EX_USAGE`).

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
- **Removing a field, changing a default semantically, or changing merge rules** is a breaking change — bumps `version` to `2`, and `harness validate` on `version: 1` manifests still works (read-compatible) for at least one major CLI version.
- **`harness apply` on a `version: 1` manifest after CLI upgrade** migrates in-place if possible; otherwise fails with a specific migration guide.

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
      command: [node, ~/git/pandora/agent-tasks/mcp/dist/server.js]
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
    event: session_start
    command: ~/.claude/hooks/git-preflight.sh
    blocking: false
    budget_ms: 30000
    description: "Fetch watchlist repos and surface drift on session start."

  - name: require-review-evidence
    event: pre_tool_use
    match: "mcp__agent-tasks__pull_requests_merge"
    command: ~/.claude/hooks/require-review-evidence.sh
    blocking: hard
    budget_ms: 2000

  - name: require-dogfood-evidence
    event: pre_tool_use
    match: "Bash"
    command: ~/.claude/hooks/require-dogfood-evidence.sh
    blocking: hard
    budget_ms: 2000

policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: pre_tool_use
      match: "mcp__agent-tasks__pull_requests_merge"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a dogfood ledger entry.
    trigger:
      event: pre_tool_use
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
