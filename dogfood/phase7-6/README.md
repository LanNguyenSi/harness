# Phase 7 #6 dogfood — Risk Gate enforcement

`run-smoke.sh` drives `harness policy intercept` against the real
grounding-mcp and the live `~/.evidence-ledger/ledger.db` and verifies
every Risk Gate decision outcome end-to-end:

| Step | Outcome | What it proves |
|---|---|---|
| 1 | `deny` | a `block` policy aborts the tool call (`decision: block`). |
| 2 | `warn` | a `warn` policy proceeds (empty stdout); the `--verbose` stderr records the `warn` decision. |
| 3 | `require_approval` | a `require_approval` policy blocks pending approval. |
| 4 | canonical case | `kubectl delete namespace prod` blocks through the built-in `dangerous-shell` classifier (severity `high`) + a `require_approval` policy — the ROADMAP Phase 7 exit-gate line. |
| 5 | — | `harness approve risk` records `risk-approved:<session>`. |
| 6 | `allow` | the `require_approval` action, rerun, now passes. |
| 7 | `allow` | the canonical `kubectl delete` case, rerun, now passes. |

## Running

```sh
cd dogfood/phase7-6
HARNESS_DIR=/path/to/harness GROUNDING_DIR=/path/to/agent-grounding ./run-smoke.sh
```

Both env vars default to the canonical Pandora checkout layout, so on a
standard checkout a bare `./run-smoke.sh` works. `harness` must be built
(`npm run build`) and grounding-mcp must be built at
`$GROUNDING_DIR/packages/grounding-mcp/dist/server.js`.

The script exits non-zero on any unexpected step, so a release gate or
CI wrapper can trust the exit code. Per-run output lands under
`transcript/` (git-ignored). Each run writes one ledger entry,
`risk-approved:<session>`, scoped to a unique `sessionId`; drop rows
where `session = '<session>'` from `evidence_ledger` to clean up.

`harness.yaml` is the smoke manifest: four policies, each pinned to a
distinct `trigger.bash_match` so a smoke command hits exactly one of
them — no cross-matching, one clean decision per outcome.
