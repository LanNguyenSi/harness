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
