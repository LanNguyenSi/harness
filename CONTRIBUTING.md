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
   npm run check:boundaries          # import layering (dependency-cruiser, .dependency-cruiser.cjs)
   npm run check:duplication         # clone-count pin (jscpd, scripts/check-duplication.mjs)
   npm run check:changelog-coverage  # every non-skipped commit since the last tag needs a citable entry (scripts/check-changelog-coverage.mjs)
   ```

   `check:boundaries` and `check:duplication` are architecture fitness
   functions CI enforces: layering is schema → policies → runtime →
   policy-packs → cli (grandfathered shared-util edges are listed in the
   config), and the duplication pin fails when `src/` grows a new clone —
   extract instead, or raise the pin with a justification in the same PR.

   `check:changelog-coverage` enforces that every commit since the last
   tag is cited in the `## [Unreleased]` section (or, on a release-prep
   branch, in the not-yet-tagged rolled-up version section above it):
   reference the commit's 8-hex task id (`` `<id8>` ``), its PR number
   (`#NNN`), a GHSA advisory id, or — for a commit already pushed without
   a citable token — the commit's own SHA. A purely numeric task id (no
   hex letter, e.g. `13919613`; agent-tasks issues those too) only counts
   as a citable id when the word `task` or `commit` sits directly before
   it in the commit's own message (e.g. `task 13919613`); if the commit's
   message does not already say that, cite its SHA or its PR number
   (`#NNN`) instead. A commit whose conventional-commit type is `chore`,
   `ci`, `docs`, `refactor`, `style`, or `test` needs no entry. This
   applies to EVERY commit pushed to a
   branch under review, not just the eventual squash-merge subject — a
   `pull_request` CI run grades the whole branch, including review-round
   commits, so give each one a task id (or a skipped type) as you make it.

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

## Canonical manifests

Two files describe the example policy surface and must stay in sync:

- `docs/examples/full-manifest.yaml`: canonical schema-coverage reference. Use this file as the source of truth when adding or editing an example policy or policy_pack entry.
- `src/cli/init/templates.ts` (`FULL_TEMPLATE`): the runnable manifest emitted by `harness init --template full`. Intentionally different on `tools.mcp` commands, hook commands, and the optional `workflows` / `review_templates` / `audit` blocks, but its `policies` and `policy_packs` sections must mirror the reference.

The parity vitest `tests/cli/init-full-template-parity.test.ts` fails the build on drift in policy names, load-bearing policy fields (`trigger.match`, `trigger.extract`, `requires.*`, `enforcement`, `hook`), or `policy_packs` definitions. If you add a policy to one file, add it to the other in the same PR.

## Releasing

Publishing is driven by `.github/workflows/publish-npm.yml`. Pushing a `v*` tag triggers it; the workflow checks the tag against `package.json`, builds, tests, then runs `npm publish --provenance`.

The publish step retries up to 3 times with exponential backoff: Sigstore Rekor occasionally returns a transient `TLOG_CREATE_ENTRY` 409 (npm/cli#6892) that fails `--provenance` even when the tarball is fine. It also short-circuits when the version is already on the registry, so a re-run is safe.

If a publish still fails after the retries, re-run it without re-tagging: Actions -> Publish to npm -> Run workflow, passing the release tag (e.g. `v0.10.0`).
