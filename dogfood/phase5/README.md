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

`run-smoke.sh` renders a per-run manifest (`transcript/effective-manifest.yaml`)
from `harness.yaml`, substituting `HARNESS_DIR` / `GROUNDING_DIR`. Defaults match
the canonical `~/git/pandora/{harness,agent-grounding}` layout; override either
variable to run against a different checkout.

Every run uses a fresh, timestamped `sessionId` (`phase5-dogfood-<unix>-<pid>`)
scoped inside `~/.evidence-ledger/ledger.db`. **The smoke does NOT isolate the
ledger file** — it writes real rows to your live ledger. To clean up:

```sh
sqlite3 ~/.evidence-ledger/ledger.db \
  "DELETE FROM evidence_ledger WHERE session LIKE 'phase5-dogfood-%';"
```

Each run writes to `dogfood/phase5/transcript/` (gitignored). The first-run
evidence is preserved in `dogfood/phase5/transcript-baseline-2026-05-01/` so
PR reviewers can read the exact output cited below.

## Acceptance evidence

| Step | Artifact | What it shows |
| ---- | -------- | ------------- |
| 1 | `01-deny.stdout` | `{"decision":"deny","reason":"review-before-merge: no matching ledger entry for tag \`review:42\`"}`. Asserted non-empty by the smoke driver. |
| 2 | `02-ledger-add.stdout` | grounding-mcp returns the new ledger entry id. Asserted by the driver via `grep '"id":2'`. |
| 3 | `03-allow.stdout` | empty file. Asserted by the driver via `[ -s "$ALLOW_STDOUT" ]`. |
| 4a | `04a-audit-5m.stdout` | both fires visible — Phase 5 #8 is fixed (the 5m window correctly returns fresh entries on non-UTC hosts). The driver asserts ≥1 deny row and ≥1 allow row before passing; an empty 5m result here is now a regression. |
| 4b | `04b-audit-24h.stdout` | both fires visible — the 24h window kept as a belt-and-braces gate. Same ≥1 deny / ≥1 allow assertion. |
| 5  | `05-explain.stdout` | YAML trace against the live ledger; the driver asserts `name: review-before-merge`, `ledgerTag: review:42`, and `sessionId: $SESSION` are all present. With Phase 5 #9 fixed, the selected `decision` is the latest by `evaluatedAt` (ms-precision) regardless of whether the two fires share an SQL second — so the allow consistently wins. |

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

- **Phase 5 #8** (FIXED, PR #40) — `audit --since` was parsing UTC
  ledger timestamps as local time, so windows narrower than the host
  TZ offset returned empty. Originally reproduced by `--since 5m`
  showing no rows seconds after the fires; the smoke now asserts the
  5m window contains both fires.
- **Phase 5 #9** (FIXED, PR #41) — `explain --trace` was picking the
  wrong decision when two fires shared an SQL second, because
  `selectLatestForPolicy` sorted on ledger `createdAt` (1-second
  precision) instead of the decoded payload's `evaluatedAt` (ms
  precision). Same fix applied to `audit` row order.
- **Phase 5 #4** (existing) — added a comment with concrete evidence:
  `policy_decision` entries are reachable by `ledger_summary` and
  trip `filterEntriesByTag`'s `.includes(tag)` substring check, so a
  past deny inflates `matchedCount` for the same tag on the next fire.
  Observed: `"matchedCount":2` after one ledger_add. Vote for the
  first-class entry-type / table option.

## Out of scope

`run-smoke.sh` directly invokes the same binary with the same stdin
shape that Claude Code's hook protocol provides; the complementary
headless `claude -p` smoke (`transcript-claude-p-2026-05-03/`) covers
Claude Code's own hook driver. Together they cover the runtime and
the harness side of the contract.

What remains optional is a fully-interactive Claude Code session
attempting `mcp__agent-tasks__pull_requests_merge` against PR 42 in a
sandbox repo (copy `dogfood/phase5/harness.yaml` to `~/.claude/`,
`harness apply`, then make the call by hand). The expectation matches
Step 1 above. The two automated smokes should catch any regression
before that manual run is needed.
