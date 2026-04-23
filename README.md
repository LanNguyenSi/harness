# harness

> Declarative control plane for agent harnesses — one YAML for grounding, tools, memory, and hooks. Describe, validate, diff, apply.

**Status: Phase 0 — design. No code yet.**

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

Our entry point into this problem: on 2026-04-23, an `agent-grounding` checkout that was 16 commits behind origin led two tasks to be incorrectly called "stale" — a preflight hook would have caught it instantly, but building hooks requires agreeing where config lives first. That conversation is the origin of this repo. The long-form writeup lives in the internal `lava-ice-logs` logbook at `docs/system-enforcement-analysis-2026-04-23.md`.

## Scope

See [`docs/VISION.md`](docs/VISION.md) for the "why" in long form — three pillars (grounding, tools, memory), what already exists across the ecosystem, and where the gaps are.

`ARCHITECTURE.md` (concrete YAML shape, CLI surface, file layout) and `ROADMAP.md` (phase-by-phase acceptance criteria) follow in the next commits.

## Status

- [x] Repo bootstrap (LICENSE, .gitignore)
- [x] README + VISION — repo legible
- [ ] ARCHITECTURE — YAML shape + CLI surface agreed
- [ ] ROADMAP — phases 1–4 with acceptance criteria
- [ ] Phase 1 — read-only inventory (`describe`, `validate`, `doctor`)
- [ ] Phase 2 — managed edits
- [ ] Phase 3 — declarative truth (YAML → settings.json)
- [ ] Phase 4 — policy layer (grounding wiring)

## Related

- [`agent-grounding`](https://github.com/LanNguyenSi/agent-grounding) — grounding primitives (evidence-ledger, claim-gate, review-claim-gate) this project will expose through the YAML layer
- [`agent-memory`](https://github.com/LanNguyenSi/agent-memory) — memory surfaces the control plane inventories
- [`agent-tasks`](https://github.com/LanNguyenSi/agent-tasks) — the MCP-registered task platform whose registration + health will appear in `harness describe`
- [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight) — CI preflight validator; a natural consumer of the hook layer once it's written
- [`codebase-oracle`](https://github.com/LanNguyenSi/codebase-oracle) — one of the MCP surfaces being registered
- [`dev-tools`](https://github.com/LanNguyenSi/dev-tools) — `git-batch-cli`, a day-to-day tool whose inventory should appear in `harness describe`

## License

MIT — see [LICENSE](LICENSE).
