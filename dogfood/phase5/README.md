# Phase 5 #1 — Real grounding-mcp + real evidence-ledger dogfood

The killer-test from the founding incident:

> deny on missing review evidence → ledger_add review:42 → allow

run end-to-end against the **real** grounding-mcp binary
(`agent-grounding/packages/grounding-mcp/dist/server.js`) and the **real**
SQLite evidence-ledger at `~/.evidence-ledger/ledger.db`. No fakes, no
mocks — the same code path Claude Code's `PreToolUse` hook would
execute via the settings.json that `harness apply` generates.

## What this proves vs. the v0.4.0 unit-test surface

v0.4.0 ran the runtime pipeline against three hand-rolled stdio scripts
simulating grounding-mcp. The v0.4.0 review subagents (PR #33, PR #37)
flagged that the integration boundary was untested. This dogfood closes
that gap by:

- spawning the real grounding-mcp subprocess from the live ledger client,
- recording `policy_decision` entries through `ledger_add`,
- replaying them via `harness audit` and `harness explain --trace`.

## Reproducing

```sh
cd <repo-root>
npm run build                         # rebuild dist/
./dogfood/phase5/run-smoke.sh
```

Every run uses a fresh, timestamped `sessionId` (`phase5-dogfood-<unix>-<pid>`)
so it does not collide with prior runs or pollute existing sessions.
Each run writes to `dogfood/phase5/transcript/` (gitignored). The
first-run evidence is preserved in
`dogfood/phase5/transcript-baseline-2026-05-01/` so PR reviewers can read
the exact output cited below.

## Acceptance evidence

| Step | Artifact | Expectation |
| ---- | -------- | ----------- |
| 1 | `01-deny.stdout` | `{"decision":"deny","reason":"review-before-merge: no matching ledger entry for tag \`review:42\`"}` |
| 2 | `02-ledger-add.stdout` | grounding-mcp returns a ledger entry id (id 41 in the captured run) |
| 3 | `03-allow.stdout` | empty (silent allow) |
| 4 | `04-audit.stdout` (run with `--since 24h`) | both fires visible — see Bug A in Findings below |
| 5 | `05-explain.stdout` | YAML trace including `decision`, `extract`, `requiresEval`, `ledgerQuery.sessionId` |

Settings.json wiring is regenerated (not hand-written) by:

```sh
cp dogfood/phase5/harness.yaml /tmp/phase5-claude/harness.yaml
node dist/cli/main.js apply --config /tmp/phase5-claude/harness.yaml
cat /tmp/phase5-claude/harness.generated/settings.json
```

The generated `command` field is the exact `node ... policy intercept ...`
string the smoke driver pipes events into.

## Findings filed as follow-ups

The dogfood surfaced two new bugs and one concrete instance of an
already-filed concern. Per Phase 5 #1 acceptance, these were filed
before any silent fix:

- **Phase 5 #8** — `audit --since` parses UTC ledger timestamps as local
  time, so windows narrower than the host TZ offset return empty.
  Reproduced by `--since 5m` showing no rows seconds after the fires;
  `--since 24h` showing both.
- **Phase 5 #9** — `explain --trace` picks the wrong decision when two
  fires share an SQL second, because `selectLatestForPolicy` sorts on
  ledger `createdAt` (1-second precision) instead of payload
  `evaluatedAt` (ms precision).
- **Phase 5 #4** (existing) — added a comment with concrete evidence:
  `policy_decision` entries are reachable by `ledger_summary` and
  trip `filterEntriesByTag`'s `.includes(tag)` substring check, so a
  past deny inflates `matchedCount` for the same tag on the next fire.
  Observed: `"matchedCount":2` after one ledger_add. Vote for the
  first-class entry-type / table option.

## Out of scope

`run-smoke.sh` is **not** a substitute for a proper Claude Code session
spawning the hook. The smoke directly invokes the same binary with the
same stdin shape that Claude Code's hook protocol provides; what it does
not exercise is Claude Code's own hook driver. A manual confirmation
remains useful — copy `dogfood/phase5/harness.yaml` to `~/.claude/`,
`harness apply`, then in a fresh Claude Code session attempt
`mcp__agent-tasks__pull_requests_merge` against PR 42 in a sandbox repo.
The expectation matches Step 1 above.
