# harness, for agents

You are an agent (or the contributor onboarding one). harness is the
thing your hooks are configured by. You do not speak to it directly at
runtime; you read its outputs (`audit`, `session-export`) and you
obey the hooks it wires.
This doc is the integration contract.

For the operator's view of the same system (install, `apply`, drift
handling), see [`for-humans.md`](for-humans.md).

## Orientation in three sentences

1. The manifest declares hooks and policy packs. `harness
   apply` materialises them into `settings.json`. Claude Code loads
   that and fires hooks at the events the manifest listed.
2. When a gate hook fires, it decides from its own source of truth.
   The shipped one, branch-protection, asks git for the branch of the
   directory the call writes into and refuses `Write` / `Edit` (or
   `apply_patch` on Codex) when git names a protected branch; it
   consults no ledger and keeps no override marker.
3. Your job, as the agent, is to work the way the gate expects: cut a
   feature branch (`git checkout -b <feature>`) before editing source
   in a repository whose default branches are protected, and read the
   deny message for the exact command to run.

(The policy engine, its ledger-tag gates and the `workflows:` block
that derived review-gate policies were removed in 1.0.0; nothing
ships `policies:` or policy-intercept hooks any more.)

## Agent-facing block messages (`ux:` block)

When a gate hook denies your tool call, a pack blocker renders the
deny envelope from the pack's `config.ux:` block if the manifest
declares one (branch-protection ships one by default).

**Agent-facing shape** (`ux:` declared): three sections, verbatim from
`renderAgentFacing` in `src/runtime/agent-facing.ts`:

```
You cannot edit files on protected branch main yet.

Required:
- a checkout of a non-protected branch (current `main` is protected)

Run:
  git checkout -b feat/<your-task>
```

The three sections always appear in the same order, with `- ` prefixes
under `Required:` and a two-space indent under `Run:`. Read them as
state (what is blocked), requirement (in plain words), remedy (the
exact command to type).

### What changes between the two readers

The `ux:` shape replaces only the agent surface. The operator-facing
diagnostic (which names the directory git was asked about and the
protected list) stays on stderr, so the operator keeps the engine
detail the plain-language message leaves out.

### `${VAR}` substitution context

`cannot`, `required[]`, and `run[]` are templates. `branch-protection`
substitutes `${BRANCH}` with the branch git names for the target, plus
`${TOOL_NAME}` and `${SESSION_ID}`. Unresolved references are left
literal so the agent can still read what was expected.

### When you encounter a block

1. Read the three sections in order: state, requirement, remedy.
2. Run the `Run:` command (for branch-protection: `git checkout -b
   feat/<your-task>`).
3. Retry the original tool call. The same call goes straight through
   once the requirement is satisfied, no restart needed.
4. If you cannot satisfy the requirement, ask the operator. The
   stderr diagnostic gives them the detail to debug from.

## CLI cheat sheet

Everything in **read-only** is safe to call without side effects:
the manifest is parsed, files are read, ledger queries are read-only,
nothing is rendered or written. Use them freely from agent tooling.

**Mutating** verbs change files on disk. Reserve them for explicit
operator-driven flows.

| Verb | Side effect | Notes |
|------|------|------|
| `describe` | read-only | effective merged manifest as YAML or JSON. `--pillar` filters. |
| `list <category>` | read-only | flat row-per-entry table. categories: mcp, cli, skills, memories, hooks (`policies` and `workflows` were removed in 1.0.0). |
| `validate` | read-only | schema + asset checks. `--check-lock` adds drift detection. |
| `doctor` | read-only | health summary. `--shallow` skips MCP probes. |
| `diff` | read-only | manifest vs git ref or `--since-apply` last-rendered output. |
| `audit` | read-only | replays `policy_decision` rows from the ledger (written by pre-1.0.0 releases). |
| `session-export <sid>` | read-only | joins the on-disk transcript JSONL with ledger rows for the session, redacts secrets, emits json/jsonl. |
| `apply` | mutating | renders manifest to `harness.generated/` (or `--target`), updates `harness.lock`. |
| `add` | mutating | mutates `harness.yaml` in place to add an mcp / cli / skill / hook entry. |
| `remove` | mutating | removes an entry by type + name from the manifest. |
| `init --template <name>` | mutating | scaffolds a manifest non-interactively. Templates: `minimal`, `solo`, `team`, `full`. |
| `init --interactive` | mutating | operator-facing wizard (`@inquirer/prompts`). Detects env, picks a profile, writes the manifest. Not for agent driver scripts. |
| `init --probe` | read-only | prints a JSON snapshot of detected runtimes + MCPs + manifest; no writes. |
| `adopt` | mutating | reverse engineers a manifest from an existing settings.json. |
| `export` | read-only (writes a file only with `-o <file>`) | prints the operator-declared manifest (overrides merged) to stdout; `-o <file>` writes it to a file instead. |
| `pack add / remove / list / reseed` | mutating (add/remove/reseed), read-only (list) | manages `policy_packs:` entries in the manifest. One builtin pack: `branch-protection`. `reseed <name>` pulls the shipped template's config back onto a drifted entry. |
| `doctor --target codex` | read-only | verifies Codex adapter wiring after `apply --runtime codex`. `--json` for machine-readable output. |
| `doctor --target opencode` | read-only | verifies opencode adapter wiring after `apply --runtime opencode` (config artefact presence/banner + every projected MCP server's command resolves on PATH). `--json` for machine-readable output. |

## Reading the ledger back

Two CLI surfaces read the evidence ledger. Pick the right one for the
question you are asking.

- `harness audit --since 1h [--policy <name>] [--outcome deny]`. "What
  decisions were recorded?" Returns one row per `policy_decision`,
  sorted chronologically. The policy engine that wrote those rows was
  removed in 1.0.0, so this now replays the historical ledger.
- `harness session-export <sessionId>`. "Reconstruct the entire
  session as one chronological audit artifact." Joins the on-disk
  Claude Code transcript JSONL (prompts, tool_use blocks, tool_result
  blocks, assistant text) with ledger rows for the same session.
  Default-on regex redaction strips obvious secrets; `audit.redact[]`
  in the manifest extends the denylist. Good for "show me what
  actually happened in session X".

If a teammate asks "what did the agent do in this session", reach
for `session-export`. If they ask "why did this gate fire", read the
hook's stderr: the shipped gates decide at call time and say their
reason there.

## Things you must NOT do as an agent

- Do not bypass hook scripts with `--no-verify` or by editing the
  generated `settings.json` directly. If a hook is failing, the fix
  is to fix the hook, not to silence it.
- Do not swallow hook stderr. It carries the reason a gate refused or
  degraded, and it is the first thing the operator will ask for.
- Do not force-push to `master`, even when you "are sure". The
  workflow always cuts a fresh branch off the latest master.
- Do not hand-edit `harness.generated/`. The next `apply` refuses
  until the edit is captured with `harness adopt` or discarded with
  `--overwrite-drift`. Edit `harness.yaml` instead.
- Do not commit secrets in tool_use input. The default
  `audit.redact[]` regex catches the obvious patterns at
  `session-export` time, but the safer move is to never put a token
  in a tool argument in the first place.

## Where to read next

- [`docs/for-humans.md`](for-humans.md): operator-side guide. Useful
  when you need to ask the operator for a manifest change.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md): the original design
  (historical); [`docs/CLI.md`](CLI.md) is the current command
  reference and `src/schema/` the current schema.
- [`docs/examples/full-manifest.yaml`](examples/full-manifest.yaml):
  a manifest exercising every field, including `audit.redact[]`.
- [`CHANGELOG.md`](../CHANGELOG.md): what shipped when, with the PR
  number that introduced each surface.
