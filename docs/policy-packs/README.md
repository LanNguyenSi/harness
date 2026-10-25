# Policy Packs

A *Policy Pack* is a reusable bundle of hooks and an instruction
template shipped under one name and enabled from `harness.yaml` with a
single key:

```yaml
policy_packs:
  - name: branch-protection
    config:
      protected_branches: [master, main, develop]  # the default list
```

Manage packs with `harness pack add / remove / list`.

One pack ships today:

- [`branch-protection`](branch-protection.md): blocks source mutations when git names a protected branch for the target directory, or cannot answer.

A manifest that still names a pack that has been removed, or a key such a pack alone consumed, loads with a warning and the entry is ignored (`harness validate --strict` fails on it); the removed list and what to delete are in the removed section of [`docs/CLI.md`](../CLI.md).

Custom packs from `path:`, `npm:`, or `git:` sources are out of scope
for v1; see each pack's own doc for the future-vocabulary contract.
