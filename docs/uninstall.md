# Uninstalling harness

`harness uninstall` is the single-command teardown. Dry-run by default,
`--apply` to mutate. Every mutating invocation writes a reversible
backup + JSON snapshot next to `settings.json` before touching anything,
so any step on this page can be reversed with `--restore-from`.

## What gets removed

`harness uninstall` inventories two roots. Most of the state lives under
the harness state root (`~/.harness/` by default, legacy `~/.claude/`
for pre-`v0.24.0` installs; `HARNESS_HOME` and `--state` override it):

- `harness.yaml` (the manifest itself).
- `harness.lock` (the post-`apply` content-hash record).
- `harness.generated/` (the rendered tree: `settings.json` overlays,
  hook scripts, policy-pack assets, `.approvals/` markers).
- `.understanding-gate/` (the persisted understanding-gate reports and
  parse-error logs).

The remaining items live under the Claude Code config dir `~/.claude/`,
where `settings.json` itself lives:

- Harness-owned hook groups inside `settings.json` (identified by the
  `# harness:owned` marker block).
- Harness-owned `mcpServers` entries inside `settings.json`
  (`grounding-mcp`, `agent-tasks`, anything else `apply` wired).
- Any leftover `settings.json.pre-harness-<TS>` backups from prior
  `apply` runs.

Nothing else is touched. Your own hook groups, your own MCP entries,
your own memory notes are left alone. See
[`migration/v0.24.0-home-dir.md`](migration/v0.24.0-home-dir.md) for the
state-root move that split these two locations.

## Commands

```bash
harness uninstall                                      # list, exit 0
harness uninstall --apply                              # tear down
harness uninstall --restore-from <pre-harness-backup>  # atomic restore
npm uninstall -g @lannguyensi/harness                  # drop the CLI itself
```

`--restore-from` accepts either a `settings.json.pre-harness-<TS>`
backup (from a prior `apply`) or the JSON snapshot `--apply` writes.
Restore is atomic: either the previous state is fully reinstated or
nothing changes.

## Recommended order

1. `harness uninstall` (no flags), read the inventory.
2. `harness uninstall --apply`, take the backup path it prints.
3. Verify your agent runtime starts cleanly without harness.
4. `npm uninstall -g @lannguyensi/harness` once you are sure.

If anything looks wrong between steps 2 and 4, run
`harness uninstall --restore-from <backup>` to get back to the exact
state before step 2.

## See also

- [`for-humans.md`](for-humans.md) for the install + first-`apply`
  path that this command reverses.
