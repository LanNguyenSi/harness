# harness

**Declarative control plane for agent harnesses.**

One zod-validated YAML manifest for grounding, tools, memory, hooks, and policies — plus a CLI that describes, validates, diffs, applies, audits, and *enforces*.

> Most config tools tell you what an agent is configured to use. `harness` tells you what an agent is *allowed to do*, under this exact context, and why.

`harness` collapses the six-to-eight surfaces a working agent harness leaks across (`settings.json`, `CLAUDE.md`, memory frontmatter, MCP registrations, per-project overrides, hook scripts) into a single source of truth. Today (`v0.5.0`) policies fire end-to-end: a `mcp__agent-tasks__pull_requests_merge` call against a session without a `review:${PR_NUMBER}` ledger entry refuses; `harness explain review-before-merge --trace` shows exactly why. Phase 6 adds an *Understanding Gate* (agents confirm task interpretation before editing); Phase 7 adds a *Risk Gate* that blocks `DROP TABLE` against a prod target, even when the model would happily run it.

## Install

```bash
npm i -g @lannguyensi/harness
```

The CLI binary is `harness`. Node ≥ 20 required.

## Try it in 60 seconds

```bash
# Statically predict which policies fire for a tool call (no ledger, no LLM).
# Uses the bundled reference manifest from the npm package.
harness dry-run "merge PR 42" \
  --tool mcp__agent-tasks__pull_requests_merge \
  --tool-args '{"prNumber":42}' \
  --config "$(npm root -g)/@lannguyensi/harness/dist/../docs/examples/full-manifest.yaml"
```

Or from a checkout:

```bash
git clone https://github.com/LanNguyenSi/harness && cd harness
npm install && npm run build
node dist/cli/main.js dry-run "merge PR 42" \
  --tool mcp__agent-tasks__pull_requests_merge \
  --tool-args '{"prNumber":42}' \
  --config docs/examples/full-manifest.yaml
```

`dry-run` reads the reference manifest, runs the trigger matcher, substitutes `${PR_NUMBER}=42` through the JSONPath-restricted extract DSL, and tells you exactly which hooks would fire and which policies would match — before any ledger I/O.

## What a run looks like

```yaml
prompt: merge PR 42
tool: mcp__agent-tasks__pull_requests_merge
toolArgs:
  prNumber: 42
Hooks that would fire:
  - event: SessionStart
    name: git-preflight
  - event: PreToolUse
    name: require-review-evidence
  - event: PreToolUse
    name: require-dogfood-evidence
  - event: PreToolUse
    name: require-preflight-evidence
Policies that match:
  - name: review-before-merge
    ledgerQuery: review:42
    requires:
      ledger_tag: review:${PR_NUMBER}
    enforcement: block
    triggerEvent: PreToolUse
  - name: two-reviewers-required
    ledgerQuery: review:42
    requires:
      ledger_tag: review:${PR_NUMBER}
      count:
        min: 2
    enforcement: warn
    triggerEvent: PreToolUse
Policies that COULD match (need --tool):
  - name: dogfood-before-release
    triggerEvent: PreToolUse
    reason: --tool "mcp__agent-tasks__pull_requests_merge" does not contain trigger.match "Bash"
  - name: preflight-before-investigation
    triggerEvent: PreToolUse
    reason: --tool "mcp__agent-tasks__pull_requests_merge" does not contain trigger.match "Bash"
Memories that would route:
  - path: ~/.claude/projects/{project}/memory
    scope: project
```

When the matching policy actually fires (via `harness policy intercept`, wired by `harness apply` into `settings.json` as a `PreToolUse` hook), and the evidence ledger has no `review:42` entry, the runtime emits Claude Code's deny shape on stdout:

```json
{"decision":"deny","reason":"review-before-merge: no matching ledger entry for tag `review:42`"}
```

With `--verbose` (or `HARNESS_POLICY_VERBOSE=1`), stderr also carries a structured diagnostic block — policy name, ledger_tag, matched count, reason, sorted extract values — so the user sees *why* without a follow-up `explain --trace`.

After the entry is recorded, the same call is silently allowed. Every fire writes a `policy_decision` row that `harness audit` and `harness explain --trace` replay:

```
$ harness audit --since 1h --policy review-before-merge

timestamp                 policy               outcome  reason
------------------------  -------------------  -------  ---------------------------------------------
2026-04-30T18:30:00.000Z  review-before-merge  deny     no matching ledger entry for tag `review:42`
2026-04-30T18:31:00.000Z  review-before-merge  allow    1 matching ledger entries for tag `review:42`
```

Inside a Claude Code session, `--session` defaults to `$CLAUDE_SESSION_ID`, so the read path automatically lines up with what the runtime hook wrote.

For post-hoc audits across an entire Claude Code session, `harness session-export <sessionId>` joins the on-disk transcript JSONL (prompts, tool calls, tool results, assistant text) with the evidence-ledger rows for that session and emits a single chronologically-ordered artifact (`--format json` or `--format jsonl`). Default-on regex redaction catches the obvious key/token patterns; `audit.redact[]` in the manifest extends the denylist with custom regexes or `env_var:` entries that auto-resolve at export time.

## Wire into Claude Code

By default, `harness apply` writes the rendered settings to `harness.generated/settings.json` next to your manifest. To make Claude Code actually use it, point `apply` at a settings discovery path with `--target`:

```bash
# Project scope: write straight to .claude/settings.local.json (created if missing).
harness apply --target .claude/settings.local.json

# User scope: merge harness-owned keys into your existing ~/.claude/settings.json,
# preserving env, permissions, enabledPlugins, and any other top-level keys.
harness apply --target ~/.claude/settings.json --merge
```

`--merge` does a 3-way merge: harness-owned top-level keys (today: `hooks`) get replaced wholesale; everything else in the existing target file is preserved verbatim. Re-applying is idempotent: running twice produces the same target, and the second run reports `no changes`.

If the target exists and you pass neither `--merge` nor `--force`, apply refuses with a clear hint instead of clobbering. `--force` overwrites with the generated content as-is (no merge).

`harness.lock` records the target path + a sha256 of the merged output, so `harness validate --check-lock` flags out-of-band edits.

## Next steps

| If you want to... | Read |
|------|------|
| Understand the YAML shape, CLI surface, drift handling, `requires` schema | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| See phase-by-phase scope, deliverables, acceptance criteria, exit gates | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| Read the long-form positioning (three pillars, ecosystem map, gaps) | [`docs/VISION.md`](docs/VISION.md) |
| Browse a manifest covering every field | [`docs/examples/full-manifest.yaml`](docs/examples/full-manifest.yaml) |
| Track what's shipping and what's deferred | [`CHANGELOG.md`](CHANGELOG.md) |

## Common commands

```bash
harness init --template full --config /tmp/harness-demo/harness.yaml
harness describe        --config /tmp/harness-demo/harness.yaml --pillar tools
harness doctor          --config /tmp/harness-demo/harness.yaml --shallow
harness validate        --config /tmp/harness-demo/harness.yaml
harness apply           --config /tmp/harness-demo/harness.yaml   # regenerate settings.json + MEMORY.md, write harness.lock
harness diff --since-apply --config /tmp/harness-demo/harness.yaml
harness explain review-before-merge --trace
harness audit --since 24h
```

## What's next

Two structurally larger themes are queued after Phase 5's polish:

**Phase 6 — Understanding Gate.** Before an agent edits files, runs shell, commits, or opens a PR, it must produce an *Understanding Report* (its interpretation of the task: derived todos, acceptance criteria, assumptions, out-of-scope, risks). The user confirms, corrects, or "grills me until precise enough". Only after explicit approval is recorded in the evidence ledger may write-capable tools fire. Ships as the first `harness` *Policy Pack* — a reusable bundle of instruction template + hooks + policies + permission profiles. Long-form design lives in the internal `lava-ice-logs` logbook (2026-04-30).

**Phase 7 — Risk Gate.** Today's policy model evaluates a rule per matching trigger and returns a binary block/allow. Phase 7 makes harness reason about *the action itself*: an Action Envelope (tool + raw input + session + runtime context) is enriched by a Context Resolver (production / staging / dev / unknown), classified by a Risk Classifier (severity + categories + reversibility), then matched against policies whose `when:` clauses can reference `risk.severity_at_least`, `environment.name`, and similar. The decision space extends to `allow / warn / require_approval / deny`. Motivating use case: prevent `DROP TABLE users`, `kubectl delete namespace prod`, `terraform destroy` against an unverified production target before they reach the runtime — even if the model would have happily run them. Long-form design lives in the internal `lava-ice-logs` logbook (2026-04-30).

Both build on Phase 4's `policy intercept` runtime backbone; neither replaces it.

> Bring your favorite agent harness. Add governance.

## Status

- [x] Repo bootstrap (LICENSE, .gitignore)
- [x] README + VISION — repo legible
- [x] ARCHITECTURE — YAML shape + CLI surface agreed
- [x] ROADMAP — phases 1–7 with acceptance criteria
- [x] Phase 1 — read-only inventory (`describe`, `validate`, `doctor`, `list`, `explain`, `diff`) — released as [`v0.1.0`](CHANGELOG.md#010---2026-04-29)
- [x] Phase 2 — managed edits (`init`, `add`, `remove`, `adopt`, `export`) — released as [`v0.2.0`](CHANGELOG.md#020---2026-04-29)
- [x] Phase 3 — declarative truth (`apply`, `diff --since-apply`, `harness.lock`) — released as [`v0.3.0`](CHANGELOG.md#030---2026-04-30)
- [x] Phase 4 — policy layer (`policy intercept`, `explain --trace`, `audit`, `dry-run`, requires-evaluator + extract DSL + grounding-mcp adapter) — released as [`v0.4.0`](CHANGELOG.md#040---2026-04-30)
- [x] Phase 5 — polish + dogfood lessons (`--verbose` policy diagnostics, `$CLAUDE_SESSION_ID` env fallback, server-side `audit` filter pushdown, `policy_decision` first-class entry type, audit `--since` UTC parse fix, `explain --trace` ms-precision sort, npm distribution as `@lannguyensi/harness`) — released as [`v0.5.0`](CHANGELOG.md#050---2026-05-01)
- [ ] Phase 6 — Understanding Gate Policy Pack (agents must expose and confirm task understanding before write-capable tools fire)
- [ ] Phase 7 — Risk Gate (Action Envelope + Risk Classifier + `allow / warn / require_approval / deny` for destructive-action prevention)

## Why this exists

A working agent harness today has six to eight configuration surfaces, each with its own schema and lifecycle: `~/.claude/settings.json`, `CLAUDE.md` (per repo + root), `~/.claude/projects/*/memory/*.md` with frontmatter, `~/.claude/keybindings.json`, MCP server registrations in `~/.claude.json`, skill directories, per-project overrides, and external CLIs that behave differently per project.

There is no single place that answers *"what can this agent do right now, and why is that configured that way?"*. Drift between sessions is invisible until it breaks something. Humans editing one surface don't know which other surfaces they need to touch. A fresh agent instance has no way to audit its own setup.

Our entry point into this problem: on 2026-04-23, an `agent-grounding` checkout that was 16 commits behind origin led two tasks to be incorrectly called "stale". The check that would have caught it already exists — [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight) runs `git fetch` + `git status` (alongside lint, typecheck, test, audit) and emits a structured `ready` + confidence-score result. The missing piece wasn't the check itself, it was the deterministic *trigger*: a `SessionStart` hook that invokes `preflight run` and a policy that gates further work on the result. Building that wiring needs an agreed-upon place for harness config to live first. That conversation is the origin of this repo.

## Related

- [`agent-grounding`](https://github.com/LanNguyenSi/agent-grounding) — grounding primitives (evidence-ledger, claim-gate, review-claim-gate); `grounding-mcp` is the canonical client surface harness queries through `queryLedgerByTag` (Phase 4 #3).
- [`agent-memory`](https://github.com/LanNguyenSi/agent-memory) — memory surfaces the control plane inventories.
- [`agent-tasks`](https://github.com/LanNguyenSi/agent-tasks) — the MCP-registered task platform whose registration + health appear in `harness describe`.
- [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight) — local preflight validator; the canonical implementation of preflight-hook content harness wires (see `docs/ARCHITECTURE.md` §5 for the canonical hook-script shape and §6 for the Phase 4 policy that gates further work on a `preflight:${REPO}` ledger entry).
- [`codebase-oracle`](https://github.com/LanNguyenSi/codebase-oracle) — one of the MCP surfaces being registered.
- [`agent-dx`](https://github.com/LanNguyenSi/agent-dx) — ships `git-batch-cli` (under `packages/git-batch-cli`), a day-to-day tool whose inventory appears in `harness describe`.

## License

MIT — see [LICENSE](LICENSE).
