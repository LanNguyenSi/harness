# Quickstart

From nothing to a Claude Code or Codex session that refuses to edit
files on a protected branch, in about five minutes. This is the bare
command path. For the *why* behind each step, read
[`for-humans.md`](for-humans.md).

The recommended setup is one policy pack:
[`branch-protection`](policy-packs/branch-protection.md). It refuses
`Write` / `Edit` (Claude Code) and `apply_patch` (Codex) while the
target repository is on a protected branch (`master`, `main` or
`develop` by default), so an agent branches before its first edit.

## 1. Install

```bash
npm i -g @lannguyensi/harness   # Node 20 or newer
```

The generated hooks call `harness` by name, so the binary has to be on
the `PATH` the agent runtime sees.

## 2. Generate a manifest

```bash
harness init
```

With no `--template`, `init` uses the `minimal` template: a header and
`version: 1`, no policies and no policy packs. It writes to the default
state root (`~/.harness/harness.yaml`).

## 3. Add the branch-protection pack

```bash
harness pack add branch-protection
```

This appends one entry to the manifest:

```yaml
policy_packs:
  - name: branch-protection
```

## 4. Check it

```bash
harness validate
```

Expect `0 errors` and exit code 0. The minimal manifest does not list
the runtime's built-in tools, so `validate` also prints one
`tools.builtin.known` warning per built-in (`Read`, `Edit`, `Write`,
...). Those warnings do not affect the gate.

## 5. Wire it into Claude Code

```bash
harness apply --target ~/.claude/settings.json --merge
```

This adds two hooks to `settings.json`: a `PreToolUse` hook on
`Write|Edit` that runs `harness pack hook branch-protection`, and a
`SessionStart` hook that runs `harness session-start branch-check`.
`--merge` replaces only the harness-owned keys (`hooks`, `mcpServers`)
and preserves everything else in your `settings.json`. Restart Claude
Code so it reloads the file.

Prefer to see the generated files first? Run `harness apply` with no
`--target`: it writes them to `harness.generated/` next to the manifest,
records a `harness.lock`, and touches nothing else.

## 6. Wire it into Codex

```bash
harness apply --runtime codex --install
```

This installs a marked, harness-managed hook block into
`~/.codex/config.toml`: a `PreToolUse` hook on `apply_patch` and the
same `SessionStart` hook. The installer replaces only that marked block;
your own Codex settings stay as they are. Skip this step if you do not
use Codex.

## What you see

In a repository on `master`, `main` or `develop`, the agent's file edit
is refused. The deny message names the branch and the protected list,
and tells the agent to cut a feature branch:

```bash
git checkout -b <feature>
```

On that branch the next edit goes through. Edits outside any git
repository are not gated.

To watch the gate decide without starting an agent, pipe a sample
`Write` event into the hook from inside a repository:

```bash
echo '{"session_id":"demo","tool_name":"Write","tool_input":{"file_path":"README.md"}}' \
  | harness pack hook branch-protection
```

On a protected branch it prints a JSON decision with
`"permissionDecision":"deny"`. On a feature branch it prints nothing on
stdout and notes on stderr that the branch is not in the protected list.

The protected-branch list, the agent-facing message and the
operator-only override are configured per pack; see
[`policy-packs/branch-protection.md`](policy-packs/branch-protection.md).

## A note on the other templates and packs

`harness init --template solo|team|full` and the
`harness init --interactive` wizard still offer more than
branch-protection: the understanding gate
(`understanding-before-execution`), `solution-acceptance`,
`post-merge-gate`, the risk gate and the reference policies (review,
dogfood, preflight and deny policies). harness 1.0.0 removes all of
these, so a new install should not adopt them. Start from the path above
instead.

## Next

- The gate itself, its configuration and its escape hatches:
  [`policy-packs/branch-protection.md`](policy-packs/branch-protection.md).
- What an agent needs to know about the gates:
  [`for-agents.md`](for-agents.md).
- Removing everything again: [`uninstall.md`](uninstall.md).
