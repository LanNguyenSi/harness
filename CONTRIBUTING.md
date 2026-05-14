# Contributing to harness

Thanks for your interest. harness is a declarative control plane for agent harnesses: one YAML for grounding, tools, memory, hooks, and policies. The PreToolUse hook denies tool calls without ledger evidence.

## Issues

- Bug reports: include repro steps, expected vs. actual, the YAML schema section involved, and the harness version (CLI command output).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks:

   ```bash
   npm install
   npm run build
   npm test
   ```

4. For schema or hook changes, dogfood against the `dogfood/` examples and verify the gate behaviour does not regress.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/harness.git
cd harness
npm install
npm run build
```

## Style

Match the surrounding code. Prefer small, reviewable diffs.

## Releasing

Publishing is driven by `.github/workflows/publish-npm.yml`. Pushing a `v*` tag triggers it; the workflow checks the tag against `package.json`, builds, tests, then runs `npm publish --provenance`.

The publish step retries up to 3 times with exponential backoff: Sigstore Rekor occasionally returns a transient `TLOG_CREATE_ENTRY` 409 (npm/cli#6892) that fails `--provenance` even when the tarball is fine. It also short-circuits when the version is already on the registry, so a re-run is safe.

If a publish still fails after the retries, re-run it without re-tagging: Actions -> Publish to npm -> Run workflow, passing the release tag (e.g. `v0.10.0`).
