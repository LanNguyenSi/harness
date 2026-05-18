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

## Read this first (three tripwires)

These three things bite people who skip ahead to the YAML:

1. **Custom *policies* are supported; custom policy *packs* are not (yet).**
   Anything you put in `policies:` is first-class: any name, any
   trigger, any `requires`. Only `policy_packs:` is gated to the two
   builtins (`understanding-before-execution`, `branch-protection`).
   `source: path:` / `npm:` / `git:` for packs is reserved vocabulary
   in v1, see [`policy-packs/understanding-before-execution.md`](policy-packs/understanding-before-execution.md)
   for the future contract.

2. **`grounding-mcp` must be wired in `tools.mcp[]`, or every policy
   silently degrades to warn-mode.** The `requires` evaluator queries
   the evidence ledger through grounding-mcp; without it, no policy
   ever blocks. `harness validate` warns when this is missing, treat
   the warning as load-bearing.

3. **Hook wiring is not auto-generated for custom policies.** The
   `harness init` wizard only knows about its five named patterns
   (`review-before-merge`, `preflight-before-investigation`, etc.).
   For a custom policy, you write the matching `hooks:` entry
   yourself: a hook with `command: harness policy intercept` and a
   `match:` (or `bash_match:`) that fires on the same tool the
   policy's `trigger` is watching.

## Anatomy of a custom policy

Every block-enforcement policy is four parts:

| Part | Where | What |
|------|-------|------|
| **trigger** | `policies[].trigger` | which tool call should the policy look at (event + match + optional bash_match + optional extract) |
| **requires** | `policies[].requires` | which ledger evidence must exist (`ledger_tag`, optional `within`, optional `count.min`) |
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
        - "have the reviewer write review:${PR_NUMBER} via mcp__agent-grounding__ledger_add"
```

`harness dry-run "merge PR 42" --tool mcp__agent-tasks__pull_requests_merge --tool-args '{"prNumber":42}' --config docs/examples/policies/01-review-before-merge.yaml`
reports `review-before-merge` as the matching policy and prints the
substituted `review:42` tag it would look for.

At runtime, the first merge fires `harness policy intercept`, which
looks up `review:42` in the ledger for the current session, finds
nothing, and returns the `ux:` envelope. The reviewer (or a review
subagent) calls `mcp__agent-grounding__ledger_add` with content
`review:42:approved`. The next merge call lets through, and both
decisions (deny then allow) land in `harness audit` as
`policy_decision` rows.

## Recipe B: gate `git push` on a custom clean-check

The same shape works for any check that produces a per-branch ledger
tag. The example below uses [`slop-detector`](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/slop-detector)
(a content linter from `agent-dx`) as the producer, but the policy
itself does not name that tool: substitute your own check (linter,
typechecker, fuzzer, secrets-scan, `harness preflight`) by changing
the producer command in `ux.run` and the ledger tag.

Full file: [`docs/examples/policies/02-clean-check-before-push.yaml`](examples/policies/02-clean-check-before-push.yaml).
Core:

```yaml
policies:
  - name: clean-check-before-push
    description: Block git push unless a clean-check:${BRANCH} ledger entry was written in the last 10 minutes.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b"
    requires:
      ledger_tag: "clean-check:${BRANCH}"
      within: 10m
    hook: require-clean-check
    enforcement: block
    ux:
      cannot: "You cannot push branch ${BRANCH} without a recent clean check."
      required: ["a clean-check:${BRANCH} ledger entry from the last 10 minutes"]
      run:
        - "slop-detector check . && mcp__agent-grounding__ledger_add { tag: clean-check:${BRANCH} }"
```

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
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*gh pr merge\b'
    requires:
      ledger_tag: "review:${BRANCH}"
    hook: require-review-evidence-bash
    enforcement: block
    ux:
      cannot: "You cannot merge the PR for branch ${BRANCH} via `gh pr merge` yet."
      required:
        - "a recorded review of the PR for branch ${BRANCH}"
      run:
        - 'mcp__agent-grounding__ledger_add { type: "fact", content: "review:${BRANCH} — <verdict + key findings + nits>" }'
```

If your workflow only uses one surface, ship only that policy. The
parallel definitions are a per-surface opt-in, not a coupled pair.

### `ux:` versus `producers:`

`ux:` is what the agent reads. `producers:` is a structured
remediation hint that gets appended to the engine-vocabulary deny
envelope when `ux:` is *not* set. Set one or the other; if you set
both, `producers:` is hidden from the agent (it still feeds
`explain --trace` for operator-side debugging). Default to `ux:`
for anything an agent will see.

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
| `policies[].trigger.bash_match` | optional | Regex against `toolArgs.command` when `match: Bash`. Anchor at command start (`^` or `(^|\n|;|\\||&&|\\()`) to catch env-prefixes and subshells. |
| `policies[].trigger.path_match` | optional | Regex against file paths for Edit/Write/MultiEdit triggers. |
| `policies[].trigger.extract` | optional | Map of `${VAR}` → JSONPath against the tool payload. Required if `ledger_tag` references a non-builtin `${VAR}`. |
| `policies[].requires.ledger_tag` | yes | Tag the runtime queries grounding-mcp for. Substring/regex against ledger `content`. |
| `policies[].requires.within` | optional | Duration string (`10m`, `1h`, `24h`, `PT1H`, `86400s`). Filters to entries created in this window. |
| `policies[].requires.count.min` | optional | Minimum number of matching entries. `0` is rejected. |
| `policies[].hook` | yes | Name of a `hooks[]` entry whose `command: harness policy intercept` actually invokes the runtime. |
| `policies[].enforcement` | yes | `block` or `warn`. `warn` logs a `policy_decision` row but lets the tool call through. |
| `policies[].ux.cannot` | optional | One-line block message for the agent. `${VAR}` references substitute. |
| `policies[].ux.required` | optional | Array of plain-words preconditions. |
| `policies[].ux.run` | optional | Array of literal commands the agent can run to satisfy the gate. |
| `policies[].producers` | optional | Structured remediation hint shown when `ux:` is unset. At least one `kind: mcp` producer is required if set (so a Bash-locked-down agent still has a recovery path). |

Schema source of truth: [`src/schema/policies.ts`](../src/schema/policies.ts).
Acceptance criteria for each `requires` shape:
[`ROADMAP.md` Phase 4](ROADMAP.md#phase-4--policy-layer).

## See also

- [`for-agents.md`](for-agents.md): how agents read the policy/ledger contract, the audit triumvirate, the `ux:` rendering spec.
- [`for-humans.md`](for-humans.md): operator path from install to first `apply`.
- [`policy-packs/understanding-before-execution.md`](policy-packs/understanding-before-execution.md), [`policy-packs/branch-protection.md`](policy-packs/branch-protection.md): the two builtin packs, plus the future contract for custom-pack sources.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) Appendix A: full reference manifest.
- [`examples/pandora-bootstrap.md`](examples/pandora-bootstrap.md): walkthrough of an end-to-end real harness setup.
