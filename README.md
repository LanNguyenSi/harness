# harness

> Declarative control plane for agent harnesses — one YAML for grounding, tools, memory, and hooks. Describe, validate, diff, apply.

**Status: Phase 4 shipped (`v0.4.0`).** Read-only inventory + managed edits + declarative truth + **policy layer**: fifteen CLI verbs (`describe`, `validate`, `doctor`, `list`, `explain --trace`, `diff`, `init`, `add`, `remove`, `adopt`, `export`, `apply`, `audit`, `dry-run`, `policy intercept`) backed by a single zod-validated YAML manifest. Policies fire end-to-end: `harness policy intercept` runs as a `PreToolUse` hook and emits `{"decision":"deny", ...}` when a `requires.ledger_tag` query against grounding-mcp returns no matching evidence; each fire writes a `policy_decision` entry to the evidence ledger that `harness explain --trace` and `harness audit` replay. The founding-incident killer-test is wired: `mcp__agent-tasks__pull_requests_merge` against a session without a `review:${PR_NUMBER}` ledger entry refuses; the same call after recording the entry is allowed. See [`CHANGELOG.md`](CHANGELOG.md) for what shipped and what is still deferred.

## What

`harness` is a control plane that unifies how an agent harness (today: [Claude Code](https://docs.claude.com/en/docs/claude-code); in principle any comparable runtime) is configured. Instead of scattering decisions across `settings.json`, `CLAUDE.md`, memory markdown files, MCP registrations, per-project overrides and hook scripts, `harness` collapses them into a single human-editable YAML manifest. The manifest is read, validated, diffed, and applied by a small CLI.

The point is not to replace those surfaces — it is to **make them coherent**. The existing files stay where they are; `harness` becomes the single source of truth that generates them.

## Why

A working agent harness today has six to eight configuration surfaces, each with its own schema and lifecycle:

- `~/.claude/settings.json` — hooks, permissions, env
- `CLAUDE.md` (per repo + root) — prose instructions
- `~/.claude/projects/*/memory/*.md` — memories with frontmatter
- `~/.claude/keybindings.json` — key bindings
- MCP server registrations in `~/.claude.json`
- Skill directories
- Per-project overrides that shadow user settings
- External tool CLIs that behave differently per project

There is no single place that answers *"what can this agent do right now, and why is that configured that way?"*. Drift between sessions is invisible until it breaks something. Humans editing one surface don't know which other surfaces they need to touch. A fresh agent instance has no way to audit its own setup.

Our entry point into this problem: on 2026-04-23, an `agent-grounding` checkout that was 16 commits behind origin led two tasks to be incorrectly called "stale". The check that would have caught it already exists — [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight) runs `git fetch` + `git status` (alongside lint, typecheck, test, audit) and emits a structured `ready` + confidence-score result. The missing piece wasn't the check itself, it was the deterministic *trigger*: a `SessionStart` hook that invokes `preflight run` and a policy that gates further work on the result. Building that wiring needs an agreed-upon place for harness config to live first. That conversation is the origin of this repo. The long-form writeup lives in the internal `lava-ice-logs` logbook at `docs/system-enforcement-analysis-2026-04-23.md`.

## Scope

See [`docs/VISION.md`](docs/VISION.md) for the "why" in long form — three pillars (grounding, tools, memory), what already exists across the ecosystem, and where the gaps are.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describes the concrete YAML shape, CLI surface, drift handling, per-machine override layer, and the v1 `requires` schema. [`docs/ROADMAP.md`](docs/ROADMAP.md) turns the four phases into testable acceptance criteria with explicit exit gates per phase.

## Try it

```bash
git clone https://github.com/LanNguyenSi/harness && cd harness
npm install && npm run build
HC=/tmp/harness-demo
node dist/cli/main.js init --template full --config "$HC/harness.yaml"
node dist/cli/main.js describe --config "$HC/harness.yaml" --pillar tools
node dist/cli/main.js add cli git-batch --binary git-batch --config "$HC/harness.yaml"
node dist/cli/main.js add mcp my-server --command "node,/tmp/server.js" \
  --health-verb status --config "$HC/harness.yaml"
node dist/cli/main.js remove cli git-batch --config "$HC/harness.yaml" --dry-run
node dist/cli/main.js export --config "$HC/harness.yaml" --sanitize -o "$HC/share.yaml"
node dist/cli/main.js apply --config "$HC/harness.yaml"   # regenerate settings.json + MEMORY.md, write harness.lock
node dist/cli/main.js diff --since-apply --config "$HC/harness.yaml"
```

Read-only inspection still works against the reference manifest at `docs/examples/full-manifest.yaml` (covers every field in `ARCHITECTURE.md` Appendix A):

```bash
node dist/cli/main.js doctor   --config docs/examples/full-manifest.yaml --shallow
node dist/cli/main.js validate --config docs/examples/full-manifest.yaml
node dist/cli/main.js list policies --config docs/examples/full-manifest.yaml --json | jq
```

## Status

- [x] Repo bootstrap (LICENSE, .gitignore)
- [x] README + VISION — repo legible
- [x] ARCHITECTURE — YAML shape + CLI surface agreed
- [x] ROADMAP — phases 1–4 with acceptance criteria
- [x] Phase 1 — read-only inventory (`describe`, `validate`, `doctor`, `list`, `explain`, `diff`) — released as [`v0.1.0`](CHANGELOG.md#010---2026-04-29)
- [x] Phase 2 — managed edits (`init`, `add`, `remove`, `adopt`, `export`) — released as [`v0.2.0`](CHANGELOG.md#020---2026-04-29)
- [x] Phase 3 — declarative truth (`apply`, `diff --since-apply`, `harness.lock`) — released as [`v0.3.0`](CHANGELOG.md#030---2026-04-30)
- [x] Phase 4 — policy layer (`policy intercept`, `explain --trace`, `audit`, `dry-run`, requires-evaluator + extract DSL + grounding-mcp adapter) — released as [`v0.4.0`](CHANGELOG.md#040---2026-04-30)

## Related

- [`agent-grounding`](https://github.com/LanNguyenSi/agent-grounding) — grounding primitives (evidence-ledger, claim-gate, review-claim-gate) this project will expose through the YAML layer
- [`agent-memory`](https://github.com/LanNguyenSi/agent-memory) — memory surfaces the control plane inventories
- [`agent-tasks`](https://github.com/LanNguyenSi/agent-tasks) — the MCP-registered task platform whose registration + health will appear in `harness describe`
- [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight) — local preflight validator (lint, typecheck, test, audit, secret-scan, optional `act`-driven CI sim) that returns a `ready` flag plus confidence score. The canonical implementation of preflight hook content harness wires — see `docs/ARCHITECTURE.md` §5 for the canonical hook-script shape and §6 for the Phase 4 policy that gates further work on a `preflight:${REPO}` ledger entry. Not a sibling tool, *the* hook content for the founding-incident's missing check.
- [`codebase-oracle`](https://github.com/LanNguyenSi/codebase-oracle) — one of the MCP surfaces being registered
- [`dev-tools`](https://github.com/LanNguyenSi/dev-tools) — `git-batch-cli`, a day-to-day tool whose inventory should appear in `harness describe`

## License

MIT — see [LICENSE](LICENSE).
