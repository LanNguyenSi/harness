# Uninstalling harness

`harness uninstall` is the single-command teardown. Dry-run by default,
`--apply` to mutate. `--apply` backs up `settings.json` (to
`settings.json.bak.uninstall.<TS>`) before editing it, and records what
it removed in `harness.uninstall.<TS>.json`. It deletes `harness.yaml`,
`harness.lock` and `harness.generated/` without a backup; copy them
first if you may want them back.

## What gets removed

`harness uninstall` inventories two roots. Most of the state lives under
the harness state root (`~/.harness/` by default, legacy `~/.claude/`
for pre-`v0.24.0` installs; `HARNESS_HOME` and `--state` override it):

- `harness.yaml` (the manifest itself).
- `harness.lock` (the post-`apply` content-hash record).
- `harness.generated/` (the rendered tree: `settings.json` overlays,
  hook scripts, policy-pack assets).
- `.understanding-gate/` (legacy cleanup: the persisted reports and
  parse-error logs of the removed understanding gate).

The remaining items live under the Claude Code config dir `~/.claude/`,
where `settings.json` itself lives:

- Hook groups in `settings.json` whose every command starts with
  `harness ` or `npx @lannguyensi/harness ` (a mixed group is left in
  place with a warning).
- MCP servers named `agent-tasks`, `codebase-oracle`, `grounding-mcp`
  or any `tools.mcp[]` name in the manifest, both from `settings.json`
  and from the claude CLI user-scope registry (`~/.claude.json`, via
  `claude mcp remove --scope user`), even if you registered one of
  those names yourself; the dry-run lists them first.

Any `settings.json.pre-harness-<TS>` copies you made yourself before
installing (harness never writes one) are listed but never deleted. Your own hook groups and your own
memory notes are left alone. See
[`migration/v0.24.0-home-dir.md`](migration/v0.24.0-home-dir.md) for the
state-root move that split these two locations.

## Codex

`harness uninstall` does not edit `~/.codex/config.toml`. Before
`npm uninstall -g`, delete the
`# Harness Codex hook wiring. Generated source: ...` line and the lines
from `# BEGIN harness-managed codex hooks` through
`# END harness-managed codex hooks` that `harness apply --runtime codex
--install` wrote, then restart Codex.

## Commands

```bash
harness uninstall                                      # list, exit 0
harness uninstall --apply                              # tear down
harness uninstall --restore-from <settings-backup>     # restore settings.json
npm uninstall -g @lannguyensi/harness                  # drop the CLI itself
```

`--restore-from <file>` copies a settings file over `settings.json`.
Use a `settings.json.pre-harness-<TS>` copy you made before installing,
or the `settings.json.bak.uninstall.<TS>` file that `--apply` printed, never
the `harness.uninstall.<TS>.json` record. The source must be a JSON
object, and a file with the snapshot record's shape is refused, so the
record cannot replace `settings.json`: any top-level
`removedHookGroups`, `removedMcpServers`, `settingsBackupPath`,
`settingsBeforeSha256`, `settingsAfterSha256` or `restoredFrom` key (in any
shape, with or without `version`), or an object whose only key holds an
object carrying one of those keys (one wrapper level, no deeper). A restore also removes the manifest, lock
and generated tree and deregisters harness-owned MCP servers.

Flags: `--home <path>` overrides the settings home `~/.claude/` (and,
without `--state`, the state root too); `--state <path>` overrides the
state root; `--settings <path>` overrides `~/.claude/settings.json`.

## Recommended order

1. `harness uninstall` (no flags), read the inventory.
2. `harness uninstall --apply`, take the backup path it prints.
3. Verify your agent runtime starts cleanly without harness.
4. `npm uninstall -g @lannguyensi/harness` once you are sure.

If anything looks wrong between steps 2 and 4, run
`harness uninstall --restore-from <backup>` to get back the
`settings.json` from before step 2.

## See also

- [`for-humans.md`](for-humans.md) for the install + first-`apply`
  path that this command reverses.
