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

Three packs ship today:

- [`understanding-before-execution`](understanding-before-execution.md): forces an Understanding Report before any write-capable tool fires.
- [`branch-protection`](branch-protection.md): blocks source mutations when git names a protected branch for the target directory, or cannot answer.

Custom packs from `path:`, `npm:`, or `git:` sources are out of scope
for v1; see each pack's own doc for the future-vocabulary contract.
