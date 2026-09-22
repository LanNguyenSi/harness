<!--
Negative-control fixture for task `ea733314`: a minimal excerpt
reproducing the historical comma-chained continuation spelling
`docs/okf/pause-vs-gate-kill-switch.md` actually carried before PR #537
re-anchored it (see `docs/okf/log.md`'s `8765987a` entry: "3 unanchored
full citations in `pause-vs-gate-kill-switch.md`", the source paragraph
carrying the disable.ts settings-gate citation, a single backtick span
chaining a second range onto the governing citation's own first range
by comma -- reproduced verbatim, in its own backtick span, in this
fixture's body excerpt below). This header deliberately does not
spell the citation out in its own backtick span (a live continuation
citation in the header would double up what the body excerpt alone is
meant to plant); this file is a fixture only -- it is never read by
the real docs/okf ratchet describe block (which reads `docs/okf/`
itself, not `tests/fixtures/`); it exists solely so the negative-control
test below can copy it into a scratch docs/okf-shaped directory under
its real historical filename and assert the continuation extractor
still finds and flags it.
-->

**What it is.** Reads `~/.claude/settings.json` (override: `--settings
<path>`; default resolved via `os.homedir()` + `.claude/settings.json`,
`src/cli/gate/disable.ts:31,82-88`), removes hook groups whose `matcher`
field substring-matches `--matcher <pattern>`.
