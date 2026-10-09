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

The `understanding-before-execution` pack is removed. A manifest that still
carries it, or the `permission_profiles` key it alone consumed, loads with a
warning and the entry is ignored; `harness validate --strict` fails on it.
Delete the entry (`harness pack remove --force understanding-before-execution`
also drops the generated instructions file) and delete `permission_profiles`
by hand, then re-run `harness apply` for each runtime. If you applied with
`--target <file> --merge` while a `permission_profile` was selected, also
delete the `permissions` block harness wrote into that file: harness no
longer generates or manages it, so `--merge` keeps it as an operator key.

Custom packs from `path:`, `npm:`, or `git:` sources are out of scope
for v1; see each pack's own doc for the future-vocabulary contract.
