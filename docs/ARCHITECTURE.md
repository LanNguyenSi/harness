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
| `min_version` | string | no | semver floor; `harness doctor` runs `version_command` against the first command token and emits a `⚠ outdated` line when the parsed version is below this value |
| `version_command` | `string[]` | no | defaults to `[<first command token>, --version]` |

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
- **`router.min_version`** (optional, string) and **`router.version_command`** (optional, `string[]`) follow the same contract as `tools.mcp[]`: `harness doctor` runs `version_command` (defaults to `[<resolved router path>, --version]`) and emits a `⚠ outdated` line when the parsed version is below the floor. The check skips when the router is disabled or its executable was not located.
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
| `min_version` | string | no | semver floor; `harness doctor` runs `version_command` and emits a `⚠ outdated` line when the parsed version is below this value. Requires `version_command` (validate rejects min_version alone): hook commands are arbitrary shell strings (`harness session-start preflight`, `~/.claude/hooks/foo.sh`, etc.), so no useful default exists. |
| `version_command` | `string[]` | no | argv to spawn for the version probe; required when `min_version` is set. Point this at the **source-of-truth binary** whose version your `min_version` floor pins, not at a wrapper or launcher: for `understanding-gate-claude-hook` that wraps the `understanding-gate` CLI, use `[understanding-gate, --version]`, not `[understanding-gate-claude-hook, --version]`. |

Blocking semantics, three levels:

- **`false`** (non-blocking): hook may inject `additionalContext` via stdout-JSON but the tool call always proceeds. Default choice when the hook's job is to inform.
- **`soft`**: hook may warn; agent sees the warning but the tool call still proceeds. For patterns like "you probably shouldn't `rm -rf` here" that have legitimate exceptions.
- **`hard`**: hook's non-zero exit or explicit `decision: "block"` (with `hookSpecificOutput.permissionDecision: "deny"` for PreToolUse, per Claude Code 2.1+) aborts the tool call. Reserved for cases where false positives are tolerable — e.g. review-evidence-gate, dogfood-trace-gate.

Pick the softest level that solves the problem. Hard-blocking is a commitment that false positives will not happen under reasonable inputs; if you're not sure, start at `soft` and promote.

### Hook content is shell, by design

Hooks are referenced by `command:` and execute as opaque shell. `harness validate` and `harness doctor` can confirm the file exists, is `+x`, and was reachable on the last run; they cannot reason about the script's behaviour. This is a deliberate scope boundary: harness owns the *wiring* (which hook fires on which event with which budget and blocking level), not the *content*. Hook content is in source control alongside any other shell script in `~/.claude/hooks/` and reviewed there.

The trade-off this makes explicit: VISION §4's "diff-over-time" capability tells you "this hook is wired to a different event than yesterday" or "this hook now has `blocking: hard` where it had `soft`", but it does not tell you "this hook now `rm -rf`s your home directory where yesterday it ran `git status`". That latter question is a code-review question against the script's git history, not a manifest-diff question. Trying to re-invent shell as a YAML DSL is its own swamp; we don't.

In practice, "hook content is shell" does not mean "hook content is a bespoke script written from scratch every time". The realistic shape of `~/.claude/hooks/git-preflight.sh` is a thin wrapper around an existing tool — typically [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight), which already runs the check the founding-incident needed:

```bash
#!/usr/bin/env bash
# ~/.claude/hooks/git-preflight.sh
set -euo pipefail
result=$(preflight run "${PWD}" --json)
ready=$(echo "$result" | jq -r '.ready')
confidence=$(echo "$result" | jq -r '.confidence')
# write a ledger entry the Phase 4 policy gates on
ledger record "preflight:${REPO:-$(basename "$PWD")}" \
  --ready "$ready" --confidence "$confidence" \
  --payload "$result"
[ "$ready" = "true" ]
```

That's the canonical shape: harness wires the hook, the hook calls a named tool (`preflight`, `ledger`, `gh`, `git-batch`), the tool does the work. Bespoke shell logic shows up only when no existing tool fits. The hook-opacity trade-off above is unchanged; what's sharpened is the expectation that hook scripts should *look thin* — if a script grows substantial logic, that logic belongs in a named tool with its own repo and tests, not buried in `~/.claude/hooks/`.

A v2 schema may add a higher-level `command_pattern:` field for the most common shapes ("script-exit-zero", "command-on-PATH", "file-exists") that compiles down to shell. v1 keeps the surface small: write the shell script, reference it by path, version it in git like everything else.

## 6. `policies:` section

Named rules. Each policy names a trigger (matching the same event/match shape as `hooks`) and declares what the trigger *requires* — typically an evidence-ledger entry of a given tag. Policies reference hooks by name; the hook is the machinery, the policy is the rule.

```yaml
policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block `npm publish` or `git tag v*` without a recent dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*(npm publish\b|git( -C \S+)* tag v)'
    requires:
      ledger_tag: "dogfood:${SESSION_ID}"
      within: 24h
    hook: require-dogfood-evidence
    enforcement: block
```

Schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | unique |
| `description` | string | yes | surfaced by `harness describe` |
| `trigger` | object | yes | `event`, `match`, optional `path_match` / `bash_match`, optional `extract` (see below) |
| `requires` | object | yes | evidence shape; discriminated union, see below |
| `hook` | string | yes | must reference a `hooks[].name` |
| `enforcement` | enum | yes | `block` / `warn` — higher level than hook's `blocking` flag |

### `requires` shapes shipped in v1

Phase 1 ships three discriminated shapes, picked because they together cover the real-world policy patterns observed across this ecosystem (review-before-merge, dogfood-before-release, confidence-gating). Adding a fourth shape post-v1 is a `version: 2` bump with the migration table at the end of this section.

```yaml
# Shape 1 — ledger entry must exist (the common case).
requires:
  ledger_tag: "review:${PR_NUMBER}"

# Shape 2 — ledger entry must exist AND be recent.
requires:
  ledger_tag: "dogfood:${SESSION_ID}"
  within: 24h           # freshness window; ISO-8601 duration or shorthand (s/m/h/d)

# Shape 3 — at least N matching entries exist.
requires:
  ledger_tag: "review:${PR_NUMBER}"
  count: { min: 2 }     # supports min, max, or exact: { min: 2 } / { max: 5 } / { exact: 1 }
```

The three shapes compose orthogonally: shape 2 + shape 3 (`ledger_tag` + `within` + `count`) is a single requires-object, not three separate policies. The discriminator is which optional keys are present.

### Why three shapes, not one

The earlier draft of this document shipped only shape 1. The 2026-04-27 design review surfaced four real policies that shape 1 alone cannot express:

- "review subagent must have run with confidence ≥ 0.7" — needs a confidence-floor predicate (deferred to v2; see migration table).
- "at least 2 distinct reviewers" — needs shape 3 (`count`).
- "last dogfood run within 24h" — needs shape 2 (`within`).
- "no merge if open security findings tagged HIGH+" — needs negation + tag-filter on the ledger; deferred to v2.

Shape 2 and shape 3 land in v1 because they are the minimum that prevents the most obvious workaround ("just put it in a shell hook"). Without `within`, "dogfood-before-release" would be expressed as a shell script that `grep`s the ledger and reasons about timestamps — exactly the prose-rule-in-shell pattern VISION §4 promises to eliminate.

### Migration to v2 `requires` shapes

For the four predicates not shipping in v1, the v2 schema is sketched here so today's policy authors know how to structure their workarounds and what the migration looks like.

| v2 shape | Use case | Phase 1 workaround |
|---|---|---|
| `confidence_floor: 0.7` | "Reviewer claimed confidence ≥ N" | Embed confidence in the ledger tag string (`review:hi:42`) and match with shape 3's `count` against a regex form. Workaround is brittle but exists. |
| `not_present: ledger_tag: ...` | Negation, "no open <thing>" | Inverted-shape policy that fires when the tag *is* present, with `enforcement: warn` instead of `block`. Imperfect but the same incident surfaces. |
| `tag_filter: { severity: "HIGH" }` | Filter ledger entries by structured payload field | Encode severity into the tag string (`finding:HIGH:CVE-2026-1234`); shape-1 match plus a regex on the tag value. |
| `aggregate: sum: ...` | "Total estimate across all matching entries" | No clean v1 workaround; users with this need hold off on the policy until v2 or write a one-off shell hook bypassing `requires`. |

The promise is: v1 manifests with shape 1/2/3 keep working under the v2 CLI. Adding any v2 shape to a v1 manifest is a bumping action (`version: 2`).

### `trigger.extract:` — generic variable extraction

Template variables used in `requires` (`${PR_NUMBER}`, `${BRANCH}`, etc.) need to be sourced from somewhere. The earlier draft hardcoded `${PR_NUMBER}` to extract `toolArgs.prNumber` for one specific MCP tool. That doesn't scale: every new variable would need bespoke extraction logic.

The generic shape: `trigger.extract` declares a map of variable name → extraction expression.

```yaml
policies:
  - name: review-before-merge
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
        REPO: "toolArgs.repo"
    requires:
      ledger_tag: "review:${REPO}:${PR_NUMBER}"
```

The expression is a JSONPath-like dotted accessor against a fixed event-context object: `toolArgs.*`, `event.*`, `session.*`, `git.*`. The full grammar is restricted (no function calls, no array slicing) so `validate` can statically check that every `${VAR}` referenced in `requires` either has an `extract` entry or is one of the seven built-in variables (§6 template variables table below).

The five built-in variables (`SESSION_ID`, `REPO`, `BRANCH`, `TOOL_NAME`, `CWD`) keep working without an `extract` block; they are convenience defaults. `PR_NUMBER` was special-cased in the previous draft and is now uniformly handled through `extract` — the per-tool-special-case is gone. The example policies in this document use `extract:` accordingly.

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
| `${PR_NUMBER}` | Phase 1 | requires a `trigger.extract: { PR_NUMBER: ... }` entry. No tool-specific hardcoding; the policy author writes the JSONPath against the event context. `validate` rejects a policy that references `${PR_NUMBER}` in `requires` without an `extract` entry. |
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
- **`harness.lock`** is a Phase-3 artefact. It pins resolved paths/SHAs of hook scripts, MCP commands, etc. so drift between "what the manifest referenced" and "what was actually applied" is deterministic. The exact schema (fields per category, hash algorithm, version pinning rules) is decided when Phase 3 starts, not here. Phase 1–2 implementations do not produce or consume it. Phase 1's "single source of truth" claim therefore applies at the **manifest** layer only — asset-content drift (a hook script edited under your feet) is detectable only after the lock ships in Phase 3. VISION §4's "diff-over-time" is layered for the same reason: manifest diffs in Phase 1, asset diffs in Phase 3. This is documented as a known limitation, not a hidden one.
- **`harness.d/`** is for fragments imported into the main manifest. Used by `claim-gate.yaml` per §2 `policies_source`, and optionally by `hooks:` / `policies:` extension files. Imports are explicit (`policies_source: …`, not auto-scanned).
- **`harness.generated/`** is treated as a build artefact. It is `.gitignore`d and regenerated; hand-edits are overwritten on next `apply` *after the drift handling rules below run*.
- **`projects/<proj>/harness.overrides.yaml`** is optional. Present only when a project needs to deviate from user-level defaults.

### Drift handling on `apply`

Generated runtime files (today: `~/.claude/settings.json`, `~/.claude/MEMORY.md` index) are owned by harness once the user opts in to generation. But those files exist before harness is installed; they are also written by Claude Code itself, by hand-edits during testing, and potentially by other tools. Silently regenerating them on `apply` is the failure mode VISION §5 explicitly avoids.

`harness apply` therefore runs a three-state comparison before writing each generated file:

1. **manifest-expected** — what the file *should* look like, derived from the current manifest.
2. **last-applied** — what harness wrote on the previous `apply`, recorded in `harness.generated/.last-apply` (a hash + a copy of the file).
3. **on-disk-current** — what the file actually contains right now.

The decision tree:

| `last-applied` exists? | `on-disk` matches `last-applied`? | Action |
|---|---|---|
| no (first run) | n/a | If on-disk file exists, refuse with a `harness adopt` invocation hint. If absent, write manifest-expected. |
| yes | yes | No drift. Write manifest-expected (overwriting the on-disk file is safe). |
| yes | no | **Drift detected.** Refuse, print a diff between `last-applied` and `on-disk`, instruct the user to either (a) `harness adopt <file>` to capture the on-disk changes into the manifest, or (b) re-run with `--overwrite-drift` to discard them. Exit 1. |

**`harness adopt`** (Phase 2 verb) reads the on-disk file, diffs against manifest-expected, and proposes a manifest patch that captures the difference. The user reviews and commits the patch. This is the supported path from "I hand-edited settings.json to test something" back to "the manifest reflects reality".

The combination of last-applied tracking + adopt is what makes the slogan "additive at the manifest layer; generative at the runtime layer" true in practice. Without it, the slogan would be marketing.

For files that harness does *not* generate (`CLAUDE.md`, memory markdown files under `projects/*/memory/`, hook scripts under `~/.claude/hooks/`), drift handling does not apply — those files stay user-owned. Harness reads them, validates them, and warns about staleness, but does not write them.

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

### Per-machine overrides

The user-level manifest at `~/.claude/harness.yaml` lives in `$HOME` and is therefore single-machine by default. Real harness configurations are not — the same human runs harness on a WSL2 host, a native Linux laptop, and one or more deployment VPS, and the absolute paths differ on each. `~/git/pandora/codebase-oracle/src/mcp-server.ts` exists on the developer machine but not on a VPS; an MCP-server `command` referencing that path must therefore vary per machine.

Per-machine overrides live in `~/.claude/machines/<discriminator>.harness.overrides.yaml`. The discriminator is one of: `<hostname>` (most specific), `<os>` (`linux` / `darwin` / `wsl2`), or the literal `default`. Discovery and merge order:

1. Read `~/.claude/harness.yaml` (user-level base).
2. Layer `~/.claude/machines/<os>.harness.overrides.yaml` if present.
3. Layer `~/.claude/machines/<hostname>.harness.overrides.yaml` if present.
4. Then layer `~/.claude/projects/<proj>/harness.overrides.yaml` (existing per-project layer).

The merge rules per layer are the same as §8's rules above (scalar replace, name-keyed merge, `_delete: true`, etc.). All layers must declare the same `version:` integer.

`<hostname>` is sourced from `os.hostname()` at apply time. `<os>` discriminator: WSL2 is detected via `/proc/version` containing `microsoft`, otherwise the platform is `process.platform`. The discriminator strings are case-insensitive.

```yaml
# ~/.claude/machines/wsl2.harness.overrides.yaml — applies on any WSL2 host
version: 1
tools:
  mcp:
    - name: codebase-oracle
      command: [npx, tsx, /home/lan/git/pandora/codebase-oracle/src/mcp-server.ts]
```

```yaml
# ~/.claude/machines/vps-01.harness.overrides.yaml — applies only on the host whose os.hostname() is "vps-01"
version: 1
tools:
  mcp:
    - name: codebase-oracle
      _delete: true       # oracle isn't installed on this VPS
```

This keeps the user-level manifest portable (no absolute paths) while still allowing each machine to inject its own truth. The user-level manifest can use placeholders (`{{HARNESS_HOME}}/codebase-oracle/...`) that the machine layer resolves; placeholder semantics are deferred to Phase 2 since the per-machine layer alone is enough to express variation today.

**Versioning the manifest itself.** `~/.claude/harness.yaml` and `~/.claude/machines/*.harness.overrides.yaml` are intended to be checked into a git repo (typically a personal dotfiles repo) so the same configuration replicates across machines. `harness.generated/` and `harness.lock` (Phase 3) are gitignored — they are the local resolution artefacts. This is the supported multi-machine workflow and is documented in `harness init`'s output once it ships.

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

harness list <mcp|cli|skills|memories|hooks|policies> [--filter <substr>] [--json]
  Flat listing of one category, filter-friendly. `describe --pillar` prints the
  full nested tree; `list` prints a single denormalised table suited for piping
  to grep / awk. Categories map directly to the manifest sub-blocks: `mcp` /
  `cli` / `skills` are the three `tools:` sub-types; `memories` lists files
  surfaced by the memory router; `hooks` and `policies` list those top-level
  sections.

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

harness adopt <file>
  Read a hand-edited generated file (today: ~/.claude/settings.json), diff against
  manifest-expected, and propose a manifest patch that captures the difference.
  The user reviews and accepts/rejects. The supported path from "I hand-edited
  to test something" back to "the manifest reflects reality"; complement to the
  drift-detection in §7. Phase 2.

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
| `better-sqlite3` | **Reserved / unused in v1.** Earlier drafts kept direct evidence-ledger reads as a fallback; the Phase 4 evaluator now goes through `grounding-mcp` (per ROADMAP Phase 4 §Library-side) so harness does not re-open the SQLite ledger directly. Row kept here so a future v2 reader sees the option was considered and rejected. |

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
    - name: grounding-mcp
      # The MCP wrapper around agent-grounding's evidence-ledger + claim-gate +
      # session primitives. Phase 4's `requires` evaluator queries the ledger
      # through this server's `ledger_summary` / `claim_evaluate_from_session`
      # verbs, which is why grounding-mcp is the load-bearing MCP for the
      # policy story even though Phase 1 only inventories it.
      command: [node, ~/git/pandora/agent-grounding/packages/grounding-mcp/dist/server.js]
      env:
        EVIDENCE_LEDGER_DB: ~/.evidence-ledger/ledger.db
      health:
        # `ledger_status` is the no-arg liveness verb. Pending in agent-grounding
        # (filed as task 453d86f4); until merged, `harness doctor` reports this
        # MCP as unhealthy with a JSON-RPC validation error from one of the
        # session-scoped verbs. Swap to `ledger_status` once shipped upstream.
        verb: ledger_status
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
    # Thin wrapper: `exec preflight run "$PWD" --json` + `ledger record preflight:${REPO}`.
    # See §5 "Hook content is shell, by design" for the canonical script shape.
    command: ~/.claude/hooks/git-preflight.sh
    blocking: false
    budget_ms: 30000
    description: "Run agent-preflight on session start; record `ready` + confidence into the ledger."

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

  - name: require-preflight-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*git( -C \S+)* (status|log|diff|branch)\b'
    # Shell wrapper that reads ${REPO} from the latest preflight ledger entry
    # and exits non-zero if it's missing, stale, or `ready: false`.
    command: ~/.claude/hooks/require-preflight-evidence.sh
    blocking: hard
    budget_ms: 1000

policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a recent dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*(npm publish\b|git( -C \S+)* tag v)'
    requires:
      ledger_tag: "dogfood:${SESSION_ID}"
      within: 24h
    hook: require-dogfood-evidence
    enforcement: block

  - name: preflight-before-investigation
    # Founding-incident policy. The `git-preflight` hook above writes
    # `preflight:${REPO}` to the ledger on SessionStart with the agent-preflight
    # ready/confidence payload; this policy gates investigative `git` reads on
    # a fresh, ready entry. Without it, the 2026-04-23 stale-checkout failure
    # mode reproduces.
    description: Block investigative git reads (status/log/diff/branch) when agent-preflight has not run recently with ready:true for the current repo.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*git( -C \S+)* (status|log|diff|branch)\b'
    requires:
      ledger_tag: "preflight:${REPO}"
      within: 1h
    hook: require-preflight-evidence
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

## Appendix C — Design decisions from the 2026-04-27 review

A discussion-mode review on 2026-04-27 surfaced six structural weaknesses plus a smaller bonus item. This appendix maps each to its resolution in the current document so the design intent is auditable post hoc. Future reviewers should challenge specific resolutions here; the table below is the contract.

| # | Weakness | Resolution | Where in this doc |
|---|---|---|---|
| 1 | Founding incident is in Phase 4 (enforcement), Phase 1 ships introspection — perceived gap between problem statement and first deliverable | **Defended.** Introspection is a precondition for enforcement; Phase 1 has independent value via `harness doctor`. Worked example walks through what Phase 1's user-visible value looks like. | VISION §8 (new); ARCHITECTURE Appendix D |
| 2 | `requires` schema shipped only `ledger_tag` — too narrow for real policies (recency, count, confidence floor, negation) | **Partially fixed, partially deferred.** v1 ships three discriminated shapes (`ledger_tag`, `+ within`, `+ count`) covering the common patterns. Four further shapes (confidence floor, not-present, tag-filter, aggregate) named with v2 migration path and explicit Phase 1 workarounds for each. | ARCHITECTURE §6 — "`requires` shapes shipped in v1", "Migration to v2 `requires` shapes" |
| 3 | `apply` regenerating `settings.json` contradicted "additive, not replacing" promise — no story for hand-edits | **Fixed.** VISION §5 reworded ("additive at the manifest layer; generative at the runtime layer for surfaces it owns"). ARCHITECTURE §7 adds three-state drift detection (manifest-expected / last-applied / on-disk-current) with explicit decision tree. New `harness adopt` verb (Phase 2) is the supported path from hand-edits to manifest. | VISION §5; ARCHITECTURE §7 — "Drift handling on `apply`" |
| 4 | Hook scripts opaque shell — `validate`/`doctor` can't reason about behaviour, undermining "diff-over-time" | **Defended explicitly.** Harness owns wiring, not content. v1 keeps shell. v2 may add `command_pattern:` for common shapes that compile to shell. Trade-off named in writing. | ARCHITECTURE §5 — "Hook content is shell, by design" |
| 5 | Single-machine assumption — manifest in `$HOME`, no per-machine overrides, no story for multi-machine workflow | **Fixed.** Per-machine override layer added at `~/.claude/machines/<discriminator>.harness.overrides.yaml`. Three discriminator types: `hostname`, `os` (linux/darwin/wsl2), `default`. Merge order spelled out. Multi-machine git workflow documented. | ARCHITECTURE §8 — "Per-machine overrides" |
| 6 | `harness.lock` deferred to Phase 3 — Phase 1 "single source of truth" claim half-true, asset-content drift undetectable | **Defended with explicit scoping.** Phase 1 source-of-truth is at the manifest layer; asset drift is a Phase 3 concern. VISION §4 and ARCHITECTURE §7 both made this layering explicit instead of leaving it implicit. | VISION §4; ARCHITECTURE §7 — `harness.lock` bullet |
| Bonus | `${PR_NUMBER}` hardcoded to extract `toolArgs.prNumber` for one MCP tool — doesn't scale | **Fixed.** Generic `trigger.extract:` field added. Five auto-resolved built-ins (SESSION_ID, REPO, BRANCH, TOOL_NAME, CWD) keep working without `extract`; `PR_NUMBER` and any other custom variable goes through `extract`. `validate` rejects references that lack an extraction source. | ARCHITECTURE §6 — "`trigger.extract:` — generic variable extraction"; updated examples + variables table |

The pattern across the seven items: **fix where the cost is bounded** (drift handling, machine layer, extract field — all small additions), **defend with explicit trade-off** where the alternative is worse than the cost (introspection-first, hook opacity, lock-file scoping), **partially fix and migrate the rest** where v1 needs movement but v2 will need to do more (`requires` shapes).

If a future reviewer disagrees with a specific resolution, the right venue is a follow-up ADR that names this appendix and argues for the alternative — not a silent rewrite of the affected section.

## Appendix D — Phase 1 value demonstration

This appendix answers the killer-test challenge: *can `harness` solve a real problem in 20 lines without policy enforcement?* The answer is `harness doctor` plus `validate`. Below is a worked walkthrough of what these commands deliver in Phase 1, against the actual configuration patterns seen in this ecosystem.

### Scenario

The user has a `~/.claude/harness.yaml` declaring three MCP servers (`agent-tasks`, `codebase-oracle`, `grounding-mcp`), two CLIs, four enabled skills, two memory directories, four hooks, and four policies (matching Appendix A). Yesterday everything was healthy. Overnight someone (or the user, last week, then forgot) edited `git-preflight.sh` and the `codebase-oracle` MCP server crashed. The user starts a fresh session.

### Without harness — today

The agent tries `oracle_search` mid-investigation. The MCP call fails. The agent logs an error, moves on, falls back to grep. Two hours later the user notices "why are oracle answers empty?" and starts debugging the MCP layer. The drift in `git-preflight.sh` is invisible until something it was supposed to catch slips through.

### With harness Phase 1 — `harness doctor` output

```
$ harness doctor
harness 0.1.0 — checking ~/.claude/harness.yaml (version 1, project: pandora)

Manifest
  ✓ 5 top-level keys present, all required present
  ⚠ 1 warning: hooks[2].budget_ms unset, defaulting to 30000

Tools
  MCP servers (3 declared)
    ✓ agent-tasks       healthy in 412ms (projects_list)
    ✗ codebase-oracle   FAILED: process exited 1, "Cannot find module 'sqlite-vec'"
    ✓ grounding-mcp     healthy in 89ms (ledger_status)
  CLI tools (2 declared, 2 required)
    ✓ git-batch         v0.2.1 ≥ 0.2.0
    ✓ gh                v2.71.0 (no min_version configured)
  Skills (4 enabled, all required by manifest)
    ✓ simplify, init, review, security-review

Memory
  ✓ memory-router executable found (~/git/pandora/agent-memory/.../user-prompt-submit.js)
  ⚠ 3 memories haven't been touched in > 180 days (retention.staleness_days threshold)
    ~/.claude/projects/pandora/memory/feedback_old_workflow.md (last touched 2025-09-12)
    ~/.claude/projects/pandora/memory/reference_legacy_api.md (last touched 2025-08-30)
    ~/.claude/projects/pandora/memory/feedback_dropped_pattern.md (last touched 2025-07-04)

Hooks
  ✓ git-preflight                SessionStart, blocking: false
  ✓ require-review-evidence      PreToolUse mcp__agent-tasks__pull_requests_merge, blocking: hard
  ✓ require-dogfood-evidence     PreToolUse Bash, blocking: hard
  ✓ require-preflight-evidence   PreToolUse Bash (^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*git( -C \S+)* (status|log|diff|branch)\b, blocking: hard

Policies
  ✓ review-before-merge             last evaluated 2026-04-26T18:14Z (allowed)
  ✓ dogfood-before-release          last evaluated 2026-04-25T22:08Z (blocked, then released)
  ✓ two-reviewers-required          last evaluated 2026-04-26T18:14Z (warned, 1 of 2 entries)
  ✓ preflight-before-investigation  last evaluated 2026-04-29T07:02Z (allowed; preflight:pandora ledger entry 14m old, ready=true, confidence=0.91)

Summary
  1 error  (codebase-oracle MCP unhealthy — agent calls to it will fail)
  4 warnings
  Run `harness explain codebase-oracle --json` for the full health-probe payload.
```

### What this delivers

In ~25 lines of CLI output, the user learns:

1. **codebase-oracle is broken** — surfaced the moment they ran `harness doctor`, not two hours into a session. The cause (missing native dep) is in the error message.
2. **Three memories are stale** — flagged by retention rule, candidates for review or deletion.
3. **Policy enforcement history** — last fire times for both policies; if a policy hasn't fired in months it's a hint that the trigger isn't matching anymore.
4. **No claim about asset content** — the doctor does not say "git-preflight.sh hasn't changed". That capability requires `harness.lock` and ships in Phase 3. The user knows this is a known gap, not an oversight.

This is what Phase 1 ships against the killer-test: a single command that answers "what is broken right now and is anything stale". The 20-line bar is met. The enforcement layer comes later, but the floor is laid here. Without this floor, an enforcement layer would fire policies against a configuration nobody can fully read.

### What `harness validate --strict` adds

Where `doctor` is human-readable diagnostics, `validate` is exit-code-driven and CI-friendly:

```
$ harness validate --strict
ERROR  hooks[2]: command not executable: ~/.claude/hooks/require-dogfood-evidence.sh (mode 0644)
ERROR  policies[0].requires references ${PR_NUMBER} without trigger.extract entry
ERROR  tools.mcp[1]: command path does not exist: /opt/old/oracle.ts
WARN   memory.retention.staleness_days threshold passed by 3 memories (run `harness doctor` for the list)

3 errors, 1 warning. Exiting 1.
```

This is what gets wired into a pre-session hook in Phase 4 — but as a standalone Phase 1 capability, it already lets a CI pipeline fail loud when a manifest goes stale on a fresh checkout.
