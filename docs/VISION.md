# Vision

This document explains *why* `harness` exists. It argues that the current agent-harness configuration surface is fragmented in a way that causes specific, repeat failure modes, and that the right response is a declarative control plane — not more individual tools.

It deliberately does **not** fix a YAML schema, CLI flag, or file layout. Those belong in `ARCHITECTURE.md`, which comes next. The goal here is a shared understanding of the problem and the direction, so that architecture decisions downstream have something principled to point at.

---

## 1. The problem, stated plainly

An agent harness — the runtime around a coding agent like Claude Code — is assembled from configuration files, hook scripts, memory corpora, tool registrations, and skill definitions. A human configures it. The agent consumes it. In principle, these two actors are collaborating on the same system.

In practice, every piece of configuration sits in a different file with a different schema and a different lifecycle:

- Some things live in JSON (`~/.claude/settings.json`, the MCP registrations in `~/.claude.json`, keybindings).
- Some things live in markdown with YAML frontmatter (`~/.claude/projects/*/memory/*.md`).
- Some things live in pure prose (`CLAUDE.md` at user-level, repo-level, both).
- Some things live in filesystem conventions (skills are directories with a specific layout).
- Some things live in external systems (GitHub Apps for tokens, MCP servers as external processes, CLIs on `$PATH`).

No single surface describes the whole. A human wanting to add a capability — say, "on session start, warn me about repos that are behind origin" — has to decide where the hook script lives, register it in `settings.json`, possibly write a helper memory, make sure the hook's dependencies are on `$PATH`, and test the whole thing by restarting a session. Half of that is obvious in hindsight; none of it is obvious in advance. Most humans do this once, get it working for their own setup, and never revisit — which means the next fresh clone of the harness quietly loses capabilities and nobody notices.

The agent has an even worse time. It discovers its own configuration by running into it: a tool call fails because a permission isn't set, a memory routes unexpectedly, a skill turns out to live at a path the agent didn't know about. There is no API for "what can you do, and why is that configured that way?". The agent's self-model of its own harness is reconstructed from leftover evidence every session.

This fragmentation produces three symptoms that repeatedly cost time:

**Silent drift.** Two sessions of the same agent, on the same machine, can have different capabilities available because one of them fetched a newer memory corpus, or one of them was started after a `settings.json` edit that the other wasn't. There is no diff-against-yesterday.

**Inconsistent enforcement.** We have written down rules like "always run a review subagent before merging" and "always fetch before declaring code stale" — but enforcement lives in memory notes, which the agent reads heuristically. When the rule doesn't fire (because the router didn't match, or the agent was under time pressure), the rule didn't do its job. The harness has no deterministic place to *make* the rule fire.

**Invisible gaps.** It's not discoverable that a capability is missing. If the MCP server for `codebase-oracle` is dead, the agent tries, fails, and moves on; no dashboard shows "your oracle is broken" until you notice you're getting no results. If a memory corpus has frontmatter errors that prevent routing, the memories silently don't apply.

Each of these symptoms is individually annoying and occasionally expensive. Together they cap how much trust can be placed in the harness, and that cap is the real cost: you can't hand the agent a non-trivial autonomous task and trust it to not trip on its own setup.

## 2. Why the obvious answer is not right

The obvious response to "configuration is fragmented" is either (a) write more documentation or (b) write more individual tools.

**Documentation** doesn't work because the fragmentation isn't about missing knowledge — it's about missing coherence. You can document every surface exhaustively and you still have eight surfaces.

**More tools** — a better memory linter, a better MCP-health checker, a better hook manager — don't work because each of those tools only sees its own surface. The value of a control plane is that it sees across them. A "memory linter" that doesn't know about hooks can't tell you that a memory mentions a hook script that no longer exists.

The right answer is something that *owns* the question "what is this harness configured to do?" and can, over time, own the question "what should it be configured to do, given the rules the human agreed to?". That thing is a control plane.

## 3. Three pillars — what already exists

A control plane is only useful if it stands on real primitives. `harness` is not starting from a blank page; substantial pieces already exist. They are strong individually and underused collectively.

### Grounding

[`agent-grounding`](https://github.com/LanNguyenSi/agent-grounding) is the most mature pillar. It contains:

- `evidence-ledger` — a SQLite-backed record of facts, hypotheses, rejected hypotheses, and unknowns, tagged by session. Retention was recently added.
- `claim-gate` — a policy engine that decides whether a claim of a given type (e.g. "this is the root cause") is allowed given the evidence collected so far.
- `review-claim-gate` — a composite GitHub Action that reads the ledger and gates merges.
- `grounding-mcp` — an MCP wrapper exposing the grounding primitives to the agent at runtime.
- `grounding-sdk` — a library for other consumers.

What's missing from the grounding pillar is not primitives but **wiring**. The policies in `claim-gate` are hardcoded; they should be configurable per project. Sessions must be started manually with `grounding_start`; they should begin automatically. Policy enforcement today is voluntary — the agent has to remember to invoke `claim-gate`. The enforcement mechanism exists; the deterministic triggering does not.

A control plane's job on this pillar is to take the primitives that exist and tell the harness: *when the agent attempts action X, require evidence of type Y; when session Z ends, archive its ledger*.

### Tools

The tools an agent uses day-to-day are strikingly heterogeneous. Some are built into Claude Code (Read, Edit, Write, Bash, the Agent subagent tool, the Skill tool). Some are MCP servers (`agent-tasks`, `codebase-oracle`, and others). Some are external CLIs expected to be on `$PATH` (`git`, `gh`, `npm`, `docker`, plus per-project CLIs like `git-batch` and `ledger`). Some are skills, which are themselves defined as directory conventions.

Registration is scattered. Built-in tools are inherent to the runtime. MCP servers are registered in `~/.claude.json`. External CLIs are assumed to exist. Skills are discovered by filesystem scan. Per-project tool settings can override user-level settings. There is no inventory. There is no health check. When an MCP server is broken, the agent finds out by trying it.

The control plane's job on this pillar is to produce a single authoritative answer to *what tools are available, from where, and are they healthy right now*. That answer is the precondition to any downstream capability: policies that say "before destructive tool X, log evidence", hooks that say "before tool Y is invoked in prod context, confirm", skills that say "for problem class Z, use tool W". None of those can be built deterministically against a tool inventory that is implicit.

### Memory

Memory as it exists today — file-based markdown with frontmatter, routed on `UserPromptSubmit` by `memory-router` (inside the `agent-memory` monorepo), with `codebase-oracle` as a semantic extension over code — works well for what it does. The router matches prompts against topics and surfaces relevant memories. Writing a memory is low-ceremony.

The gaps are lifecycle and provenance. There is no retention: a memory from six months ago still matches today, even if the code it references has been refactored away. There is no cross-linking: one memory referencing another is done by prose, not by structure, so the graph of memories is invisible. There is no scope: memories live per-project, but some lessons should be user-wide, team-wide, or even public. There is no validation: nothing tells you that your Memory mentions a function that no longer exists.

The control plane's job on this pillar is to treat memory as a first-class state that has lifecycle rules, can be validated, can be scoped, and whose provenance is introspectable — without forcing a rewrite of the memory format, which works.

### Hooks as cross-cutting glue

Hooks — the Claude Code runtime's extensibility points — are not a pillar but a cross-cut. Every pillar eventually needs hooks: grounding wants to inject policy checks, tools want to announce their health, memory wants to inject context. Today hooks live in `settings.json` as a list of shell commands keyed by event type. They are minimally introspectable; a fresh session sees them only by running them.

The control plane treats hooks as the machinery by which the pillars interact with the runtime, not as a pillar of their own. A well-configured hook is a *consequence* of a policy in the grounding pillar, or an inventory decision in the tools pillar, or a scope rule in the memory pillar.

## 4. What a unified control plane adds

Given the three pillars plus hooks, what does a control plane add that is greater than the sum?

**Introspection.** The single most valuable capability is answering "what is this harness configured to do, right now, comprehensively" — across pillars, without the agent or the human having to walk four surfaces by hand. This alone would have *surfaced* the 16-commit drift that originated this project; deterministically *catching* it requires the policy layer on top, but surfacing-on-demand is already a large step from where we are.

**Validation.** Once configuration has a single schema, it can be linted. Stale memory references, dead MCP servers, hook scripts without `+x`, skills with invalid frontmatter, policies referencing tool names that no longer exist — all surfaceable deterministically.

**Diff-over-time.** Knowing what changed between last session and this one is currently impossible. With a canonical representation of "the harness as configured", diffing is a file diff.

**Dry-run.** Before applying a change, simulating what it would do is straightforward if the effect of a configuration is computable. This is the hardest capability to build well, and the most valuable one long-term: it's the difference between "edit and pray" and "edit, preview, commit".

**Policies as data.** The rules we write in memory notes — "always review before merge", "always fetch before starting work in a repo", "never ship without dogfood" — become machine-readable YAML entries that bind to hook triggers, rather than prose the agent might or might not act on. This is where the "system enforcement" theme joins the "control plane" theme.

## 5. Positioning — what `harness` is and isn't

`harness` is **additive**, not replacing. It does not delete `settings.json`, `CLAUDE.md`, memory files, or MCP registrations. It reads them, represents them in its own manifest, and — in later phases — generates them from the manifest. Existing tools keep working unmodified.

`harness` is **per-installation**, not per-runtime. A user has one harness configuration; it can have per-project overrides, but the scope is "this human's setup of their tools". It is not a cloud service and does not pretend to be.

`harness` is **runtime-agnostic in intent, Claude-Code-first in practice**. The vocabulary of hooks, MCP, skills is specific to Claude Code. The abstractions — grounding, tools, memory, policies — are not. If a second compatible runtime emerges, `harness` should not require a rewrite to target it, but we don't pay abstraction cost today for speculative portability.

`harness` is **for humans and agents jointly**. The manifest is hand-editable because humans need to reason about it. It is machine-readable because agents need to act on it. It commits to neither side exclusively.

`harness` is **not a framework**. The temptation with any control-plane project is to build a new framework that absorbs everything it touches. We will resist that. Each pillar stays in its own repo, evolves on its own schedule, and is consumed by `harness` through stable interfaces.

## 6. Out of scope for this document

The following deliberately do not appear here. They belong in later documents and should not be litigated on the basis of this one:

- The exact YAML schema of the manifest.
- The concrete CLI subcommands, flags, and outputs.
- The file layout under `~/.claude/` or equivalent.
- The implementation language (Go, Node, Rust, ...).
- The phased implementation plan and acceptance criteria per phase.

`ARCHITECTURE.md` will address the first four. `ROADMAP.md` will address the last.

## 7. What readers should take away

If you read only this document, you should believe three things:

1. The current harness is functional but fragmented, and the fragmentation has a cost that is roughly proportional to how much autonomy the agent is given.
2. The primitives needed to fix this already exist across `agent-grounding`, `agent-memory`, the MCP ecosystem, and Claude Code's hook surface. What is missing is the layer that makes them coherent.
3. That layer is a declarative control plane with a single source of truth, read-first capabilities (describe, validate, diff), write-later capabilities (apply, generate), and a policy layer on top. It is additive to existing tools and deliberately limited in scope.

Everything that follows in `ARCHITECTURE.md` and the phased roadmap is downstream of those three beliefs. If one of them is wrong, the downstream design is wrong — which is why it is worth putting this vision on paper before writing code.
