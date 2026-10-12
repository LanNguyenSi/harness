## Summary

<!-- One or two sentences. What changed? -->

## Motivation

<!-- Why this change? Link the issue if applicable. -->

## Test plan

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] the `check:*` scripts that `.github/workflows/ci.yml` runs (`check:boundaries`, `check:duplication`, `check:no-only`, `check:no-raw-control-bytes`, `check:changelog-coverage`, `check:shipped-unreleased-pointer`, `check:readme-release-version`, `check:release-notes-size`, `check:memory-frontmatter-contract`)
- [ ] Dogfooded against `dogfood/` examples
- [ ] Manual smoke check: <!-- command or scenario -->

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs, follow-ups, open questions. -->
