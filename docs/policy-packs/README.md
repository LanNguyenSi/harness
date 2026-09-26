# Policy Packs

A *Policy Pack* is a reusable bundle of hooks, policies, instruction
template, and permission profiles shipped under one name and enabled
from `harness.yaml` with a single key:

```yaml
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me                  # fast_confirm | grill_me | strict
      permission_profile: safe-start  # safe-start | implementation-after-approval | high-risk-grill-me
```

Manage packs with `harness pack add / remove / list`.

Four packs ship today:

- [`understanding-before-execution`](understanding-before-execution.md): forces an Understanding Report before any write-capable tool fires.
- [`branch-protection`](branch-protection.md): blocks source mutations on protected branches without an explicit override.
- [`solution-acceptance`](solution-acceptance.md): opt-in completion gate (added in `v0.32.0`); holds a task done until an accepted solution verdict is logged.
- [`post-merge-gate`](post-merge-gate.md): opt-in (added in `v0.42.0`); denies mutating git/gh work on a branch whose tip has already been merged.

Custom packs from `path:`, `npm:`, or `git:` sources are out of scope
for v1; see each pack's own doc for the future-vocabulary contract.
