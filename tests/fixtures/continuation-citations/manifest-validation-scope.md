<!--
Negative-control fixture for task `ea733314`: a minimal excerpt
reproducing the historical bare-continuation spelling
`docs/okf/manifest-validation-scope.md` actually carried before PR #537
re-anchored it (see `docs/okf/log.md`'s `8765987a` entry: "27
comma/continuation-form citations chained off a governing anchored
citation in `manifest-validation-scope.md`"). A standalone, path-less
bare line-range token continues a governing citation stated earlier in
the same paragraph -- reproduced verbatim, in its own backtick span, in
this fixture's body excerpt below. This header deliberately does not
spell either citation out in its own backtick span (a live continuation
citation in the header would double up what the body excerpt alone is
meant to plant); this file is a fixture only -- it is never read by the
real docs/okf ratchet describe block (which reads `docs/okf/` itself,
not `tests/fixtures/`); it exists solely so the negative-control test
below can copy it into a scratch docs/okf-shaped directory under its
real historical filename and assert the continuation extractor still
finds and flags it.
-->

2. **Asset gate** (add ONLY, `src/cli/add/index.ts:77-125#"newErrors.length"`):
   runs against the full manifest, diffed against a baseline (`:103-116`)
   and keys each error-severity diagnostic as `severity|path|message`
   (`:110`). Only diagnostics not present in the baseline set block.
