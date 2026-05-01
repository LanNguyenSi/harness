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
| 4a | `04a-audit-5m.stdout` | empty result — **regression witness for Phase 5 #8**. The 5-minute window silently excludes fresh entries on any non-UTC host. |
| 4b | `04b-audit-24h.stdout` | both fires visible — the 24h window masks the TZ bug. The driver asserts ≥1 deny row and ≥1 allow row before passing. |
| 5  | `05-explain.stdout` | YAML trace against the live ledger; the driver asserts `name: review-before-merge`, `ledgerTag: review:42`, and `sessionId: $SESSION` are all present. The selected `decision` field is timing-dependent: when the deny and the post-`ledger_add` allow happen to land in the same SQL second, Phase 5 #9 picks the deny; otherwise the allow. The committed baseline shows the allow path; an independent run that happened to collide showed the deny — see Phase 5 #9 task body for that capture. The smoke driver intentionally does NOT gate on which decision is picked; the trace's *liveness* against the smoke session is the acceptance. |

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
