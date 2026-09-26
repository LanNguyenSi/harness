# harness

**Declarative control plane for agent harnesses.**

## Overview

A coding agent like Claude Code is configured across half a dozen
files: `settings.json`, `CLAUDE.md`, memory notes, MCP registrations,
hook scripts, per-project overrides. No single file answers "what can
this agent do right now, and why is it set up that way?" `harness`
puts all of it in one zod-validated YAML manifest you read, validate,
and diff; generates the config the agent runtime loads from it; and at
runtime blocks tool calls that violate the declared rules while
recording every decision to an evidence ledger. Most config tools
describe what an agent is configured to use; `harness` decides what it
is allowed to do, under the exact context, and records why.

## Key concepts

| Term | What it is |
|------|-----------|
| **manifest** | The one YAML file (`harness.yaml`) where you declare everything: tools, hooks, policies, memory. |
| **apply** | `harness apply` renders the manifest into the config files the agent runtime actually reads. |
| **policy** | A rule of the form *when the agent does X, require evidence Y*. Evaluated at runtime; can block the call. |
| **evidence ledger** | An append-only log of facts an agent records during a session. Policies check it; `audit` / `explain` replay it. |
| **hook** | A script the agent runtime runs at a lifecycle event (session start, before every tool call, ...). How policies get enforced. |
| **policy pack** | A reusable bundle of policies, hooks, and templates shipped under one name and enabled with a single manifest key. |

## Quick start

```bash
npm i -g @lannguyensi/harness   # Node 20 or newer
harness init --interactive      # guided wizard, or: --template solo|team|full
```

The wizard detects your `~/.claude/` and `~/.codex/` setup, MCP
servers already wired in `settings.json`, and the harness binary
version, then writes a starting `harness.yaml`. Full operator
walkthrough: [`docs/for-humans.md`](docs/for-humans.md); a five-minute
non-interactive path plus a profile comparison table:
[`docs/quickstart.md`](docs/quickstart.md).

## Usage

Preview which policies would fire for a tool call, before any ledger
I/O or file write:

```bash
harness dry-run "merge PR 42" \
  --tool mcp__agent-tasks__pull_requests_merge \
  --tool-args '{"prNumber":42}'
```

Once a manifest is applied, the same shape runs live as
`harness policy intercept` (invoked by the runtime's PreToolUse hook),
and `harness explain <policy> --trace` / `harness audit --since 1h`
replay what actually fired and why. The full install-to-audit
walkthrough is in [`docs/quickstart.md`](docs/quickstart.md).

## Documentation

- [`docs/for-humans.md`](docs/for-humans.md): operator path, install through first real policy, diagnostics cheat sheet.
- [`docs/for-agents.md`](docs/for-agents.md): agent integration contract, workflow lifecycle, CLI cheat sheet by side-effect class.
- [`docs/quickstart.md`](docs/quickstart.md): five-minute bare-command path and profile comparison.
- [`docs/init-interactive.md`](docs/init-interactive.md): the `harness init --interactive` wizard, walkthrough and limitations.
- [`docs/CLI.md`](docs/CLI.md): every CLI verb, grouped by purpose.
- [`docs/risk-gate.md`](docs/risk-gate.md): the four-way `allow / warn / require_approval / deny` Risk Gate.
- [`docs/writing-custom-policies.md`](docs/writing-custom-policies.md): tripwires, worked recipes, and the policy field reference.
- [`docs/runtime-reality-hook.md`](docs/runtime-reality-hook.md): blocking destructive runtime commands when live process state has drifted from what the docs expect.
- [`docs/policy-packs/README.md`](docs/policy-packs/README.md): the built-in policy packs (`understanding-before-execution`, `branch-protection`, `solution-acceptance`, `post-merge-gate`).
- [`docs/uninstall.md`](docs/uninstall.md): the single-command teardown, dry-run by default.
- [`docs/examples/full-manifest.yaml`](docs/examples/full-manifest.yaml): a schema-coverage reference (not a runnable config; its header explains why).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): manifest schema, file layout, CLI surface (historical design intent; see its own note for the current shape).
- [`docs/VISION.md`](docs/VISION.md): why a declarative control plane, not more individual tools.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): the phase-by-phase plan and the acceptance criteria each phase shipped against.
- [`CHANGELOG.md`](CHANGELOG.md): what shipped in each version.

### Related projects

- [`agent-grounding`](https://github.com/LanNguyenSi/agent-grounding): evidence-ledger, claim-gate, review-claim-gate; `grounding-mcp` is the canonical client surface harness queries.
- [`agent-memory`](https://github.com/LanNguyenSi/agent-memory): the memory surfaces the control plane inventories.
- [`agent-tasks`](https://github.com/LanNguyenSi/agent-tasks): MCP-registered task platform whose registration and health appear in `harness describe`.
- [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight): local preflight validator; the canonical implementation of preflight-hook content harness wires.
- [`codebase-oracle`](https://github.com/LanNguyenSi/codebase-oracle): opt-in MCP for multi-repo RAG search; wire via `harness add mcp codebase-oracle --command codebase-oracle,mcp`.
- [`agent-dx`](https://github.com/LanNguyenSi/agent-dx): ships `git-batch-cli`, a day-to-day tool whose inventory appears in `harness describe`.

## Development and contributing

```bash
npm install
npm run build
npm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full PR checklist
(import-boundary and duplication gates, changelog coverage, release
steps).

## Status

The current release is `v0.59.0`. All seven planned phases have
shipped; phase acceptance criteria are in
[`docs/ROADMAP.md`](docs/ROADMAP.md), and what shipped in each version
is in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
