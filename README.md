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
npm i -g @lannguyensi/harness                            # Node 20 or newer
harness init                                             # minimal manifest, no policies
harness pack add branch-protection                       # the one recommended pack
harness validate
harness apply --target ~/.claude/settings.json --merge   # Claude Code; then restart it
harness apply --runtime codex --install                  # Codex, if you use it; then restart it
```

From then on, while an agent works in a repository on `master`, `main`
or `develop`, its edits there through the file-editing tools (`Write`
and `Edit` under Claude Code, `apply_patch` under Codex) are refused
until it cuts a feature branch (`git checkout -b <feature>`). Codex runs
the new hooks only once you trust them in its startup hook review. The
step-by-step version, with what each command writes:
[`docs/quickstart.md`](docs/quickstart.md). Full operator walkthrough:
[`docs/for-humans.md`](docs/for-humans.md) (it still starts from the
wizard and the `solo` template, so the note below applies to it).

The `solo`, `team` and `full` templates and the
`harness init --interactive` wizard still offer the understanding gate,
`solution-acceptance`, the risk gate and the
reference policies. harness 1.0.0 removes all of these, so a new
install should not adopt them.

The `post-merge-gate` pack is already removed: a manifest that still
names it loads with a warning and the entry is ignored.

## Usage

See the gate decide without starting an agent: from inside a
repository, pipe a sample `Write` event into the hook Claude Code runs
before every `Write` or `Edit`.

```bash
echo '{"session_id":"demo","tool_name":"Write","tool_input":{"file_path":"README.md"}}' \
  | harness pack hook branch-protection
```

On a protected branch it prints a deny decision naming the branch and
the protected list; on a feature branch it allows the edit and says why
on stderr. The protected-branch list, the agent-facing message and the
operator controls are documented in
[`docs/policy-packs/branch-protection.md`](docs/policy-packs/branch-protection.md).

## Documentation

- [`docs/for-humans.md`](docs/for-humans.md): operator path, install through first real policy, diagnostics cheat sheet (still starts from the wizard and the `solo` template; the Quick start note applies).
- [`docs/for-agents.md`](docs/for-agents.md): agent integration contract, workflow lifecycle, CLI cheat sheet by side-effect class.
- [`docs/quickstart.md`](docs/quickstart.md): five-minute bare-command path to the `branch-protection` gate.
- [`docs/init-interactive.md`](docs/init-interactive.md): the `harness init --interactive` wizard, walkthrough and limitations.
- [`docs/CLI.md`](docs/CLI.md): every CLI verb, grouped by purpose.
- [`docs/risk-gate.md`](docs/risk-gate.md): the four-way `allow / warn / require_approval / deny` Risk Gate.
- [`docs/writing-custom-policies.md`](docs/writing-custom-policies.md): tripwires, worked recipes, and the policy field reference.
- [`docs/runtime-reality-hook.md`](docs/runtime-reality-hook.md): blocking destructive runtime commands when live process state has drifted from what the docs expect.
- [`docs/policy-packs/README.md`](docs/policy-packs/README.md): the built-in policy packs (`understanding-before-execution`, `branch-protection`).
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
- [`agent-preflight`](https://github.com/LanNguyenSi/agent-preflight): standalone local preflight validator; harness no longer ships a preflight hook or policy that wires it (task `f3f15290`), but an operator can still call it directly or from a custom hook.
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

The current release is `v0.64.0`. All seven planned phases have
shipped; phase acceptance criteria are in
[`docs/ROADMAP.md`](docs/ROADMAP.md), and what shipped in each version
is in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
