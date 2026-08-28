# Understanding-gate auto-mode signals, measured

Evidence for `docs/decisions/2026-08-27-ug-auto-mode-approval.md` (written
in parallel with this dogfood; see that path for the decision). This
directory holds only the measured signals and the scripts that produced
them: what fields the Claude Code hook payload actually carries per
permission mode and event, what the hook process's own environment looks
like, whether a report written mid-turn is visible to a `PreToolUse` hook
versus to `Stop`, how a hook `ask` resolves headlessly and interactively,
and what a subagent's tool call looks like to the same hook.

## Method

Claude Code 2.1.247 on macOS, captured 2026-08-27, against an isolated
`CLAUDE_CONFIG_DIR` (a fresh directory holding only a `settings.json` with
command hooks of the form `{ cat; echo; } >> <file>` on `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`).
Each run was invoked as:

```sh
env -u CLAUDECODE CLAUDE_CONFIG_DIR=$DIR claude -p "<prompt>" \
  --max-turns 4 --output-format json <mode flags>
```

from a scratch `cwd`. The prompt asked for exactly one Bash call
(`env | grep -i -E 'claude|permission' | sort`), then the single word
"done". Mode flags:

| Mode | Flags |
| ---- | ----- |
| default | (none), plus `--allowedTools Bash` |
| acceptEdits | `--permission-mode acceptEdits --allowedTools Bash` |
| bypass | `--permission-mode bypassPermissions` |
| dangerously | `--dangerously-skip-permissions` |

Hook env probe: a `PreToolUse` hook (under `--permission-mode
bypassPermissions`) that dumps `env | grep -E '^(CLAUDE|AI_AGENT|SHLVL|PPID|_=)'`
and `ps -o pid=,ppid=,comm= -p $PPID` / `-p $$`, alongside the raw hook
payload for the same tool call.

Transcript probe (second version, see section (e) for the withdrawn first
version): a Python `PreToolUse` + `Stop` hook (`transcript-probe.py`) that
reads `transcript_path` from the payload and parses it line by line,
counting only entries of `type: "assistant"` whose text contains both the
heading `# Understanding Report` and the token `gnidnatsrednu` (the word
"understanding" reversed, which the prompt asks for and never spells out).
At t0 it records the line count and whether such an entry exists; if not,
it polls every 100 ms for up to 3 s and records when it first appears.
Five positive runs (prompt: write the report, then run `echo probe`, then
say "done") plus two negative controls (prompt: run `echo probe` only, no
report), all under `--permission-mode bypassPermissions`.

Block-and-retry probe: a `PreToolUse` + `PostToolUse` hook on `Bash`
(`retry-probe.py`) that uses the same role-aware, token-based detector as
the transcript probe and answers `allow` when the report is present in the
transcript, `deny` with an instruction ("if you already wrote one, retry
the same command once; if not, write it, then retry") otherwise. Three runs
with the report requested before the first tool call, three without, all
under `--permission-mode bypassPermissions`, `--max-turns 6`.

Interactive capture (sections (h) and (i)): an interactive `claude` needs a
TTY, so both interactive probes launch one inside a detached `tmux` session
(`tmux new-session -d -s ugsig-<kind>-<pid>-<n> -x 200 -y 50 "cd <work> &&
exec env -u CLAUDECODE CLAUDE_CONFIG_DIR=<dir> claude --permission-mode
bypassPermissions"`) and drive it with `tmux send-keys`, reading the screen
back with `tmux capture-pane -p`. Each run gets its own fresh config
directory and its own scratch cwd. Two things about that shape are worth
stating, because both could otherwise be mistaken for part of the
measurement:

- A fresh `CLAUDE_CONFIG_DIR` puts an interactive session into first-run
  onboarding, which stops on the theme picker and then on a login-method
  screen. A probe may not answer a login screen, so the isolated config
  directory is seeded with a minimal `.claude.json` carrying only the
  onboarding flags (`hasCompletedOnboarding`, `lastOnboardingVersion`,
  `theme`, `numStartups`, `installMethod`, `autoUpdates`). No account data
  is copied out of the operator's real config; authentication still comes
  from the copied `.credentials.json`, exactly as in the `-p` runs. If the
  login screen appears anyway the driver aborts the run.
- The only keys the driver sends are the acknowledgements for three known
  STARTUP dialogs (theme picker: Enter; workspace-trust "Is this a project
  you created or one you trust": Enter on the preselected "Yes, I trust this
  folder"; the bypassPermissions warning: Down then Enter to move off the
  preselected "No, exit" onto "Yes, I accept"), the prompt text, `Escape`
  and `/exit`. Any other screen aborts the run with the pane dumped. No
  permission prompt is ever answered with an approval. The shared driver is
  `interactive-lib.sh`, sourced by both interactive scripts.

Interactive payload capture (`interactive-capture.sh`, section (h)):
recorder hooks (`{ cat; echo; } >> <file>`) on `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`,
`SubagentStart` and `SubagentStop`, plus a SECOND `PreToolUse` hook that
dumps the hook process's own `env | grep -E '^(CLAUDE|AI_AGENT)'` next to
the payload for the same tool call, so the hook env's
`CLAUDE_CODE_SESSION_ID` can be compared against the payload's `session_id`
within one run. Prompt: exactly one Bash call (`echo interactive-probe`),
then the single word "done". Two runs, two fresh sessions.

Interactive `ask` probe (`interactive-ask-probe.sh`, section (i)): the same
tmux shape, with the ask-answering `PreToolUse` hook of `ask-probe.sh`
byte-for-byte (record the payload, then answer `permissionDecision: "ask"`
with reason `askprobe: hook asked for operator confirmation`) and plain
recorders on `PostToolUse`, `PermissionRequest`, `PermissionDenied` and
`Stop`. Prompt: exactly one Bash call (`echo askprobe-executed`), then
"done". The probe watches the pane for a permission dialog; if one appears
it is left untouched for a settle window (default 20 s, `UG_SIG_SETTLE`) to
show it does not auto-resolve, the pane is captured before and after, and
the run is ended with `Escape` and `/exit`. Two runs.

Subagent capture (`subagent-capture.sh`, section (j)): `claude -p
--permission-mode bypassPermissions --max-turns 6` with recorders on
`UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PreToolUse`,
`PostToolUse` and `Stop`. The prompt asks for the Agent tool
(`subagent_type general-purpose`) to run exactly one bash command (`echo
subagent-probe`) and forbids the parent from running bash itself. Two runs.

Credentials (`~/.claude/.credentials.json`) were copied into the isolated
config directory for the duration of each run and deleted afterward
(the scripts below do this via a `trap ... EXIT`, macOS-specific and
optional; skip it if your Claude Code auth is keychain-backed and does not
need this file).

Codex capture (sections (k) to (m)): machine class Linux/WSL2 x86_64 (host
redacted as `<host>`), Codex CLI 0.150.1 (`@openai/codex` from npm,
`payloads/codex.version.txt`), ChatGPT login, feature flag `hooks` =
stable/true (`codex features list`). Each run gets its own isolated
`CODEX_HOME` (exec: one per script invocation; TUI: one per run) holding a
`config.toml` (`[features]\nhooks = true` plus any per-run keys under test)
and a `hooks.json` with `{ cat; echo; } >> <file>` command hooks on
`SessionStart`, `UserPromptSubmit`, `PreToolUse` (plus a second `PreToolUse`
hook that dumps the hook process's own environment), `PermissionRequest`,
`PostToolUse`, `Stop` and `SessionEnd`, and a temporary copy of `auth.json`
removed by the scripts' `trap ... EXIT` cleanup (verified absent afterward).
Every run passes `--dangerously-bypass-hook-trust` (hooks from a fresh,
just-created `CODEX_HOME` are untrusted otherwise) and, for exec,
`--skip-git-repo-check --json`. Prompt: one shell command (exec:
`env | grep -i -E 'codex|claude|permission' | sort`; TUI: `echo tui-probe`),
then the word "done". Script `codex-capture.sh` drives the 14
`codex exec` shapes (flags/config matrix) plus the `untrusted` error case;
script `codex-interactive-capture.sh` drives the 11 TUI shapes over `tmux`.
The TUI driver's only keystrokes are: Enter on the directory-trust dialog for
the scratch cwd, an optional Shift+Tab (plan mode) or `/permissions`
navigation (arrow keys plus Enter to pick a profile) for the shapes that need
it, the prompt text, and `/quit`; no command-approval prompt is ever
answered.

opencode capture (section (n)): opencode 1.18.18 (`opencode/version.txt`)
against a local Ollama model (`ollama/gemma4-q8-64k`), probed in
`dogfood/ug-auto-mode-signals/opencode/`. Two isolated scratch projects, each
with its own `opencode.json` and a `.opencode/plugin/auto-probe.ts` plugin
that records every `plugin.init`, `config`, `tool.execute.before`,
`tool.execute.after` and `shell.env` hook call plus the raw event stream to a
`PROBE_LOG` file: `project` (default permissions) and `project-ask`
(`"permission": {"bash": "ask"}`). Five run shapes: (a) `project`,
`opencode run --auto`; (b) `project`, `opencode run` (no `--auto`); (c)
`project-ask`, `opencode run --auto`; (d) `project-ask`, `opencode run` (no
`--auto`); (e) `project-ask`, `opencode serve --port 4097` plus a separate
`opencode run --attach --auto` against that server. Static evidence
(`opencode/help-main.txt`, `help-run.txt`, `binary-context.txt`,
`binary-context-permission-ask.txt`) comes from `opencode --help` /
`opencode run --help` and `strings` grep over the installed
`opencode.exe` binary.

Slice 3 re-measurement (results sections (o) to (q), captured 2026-08-28 on
this machine, Claude Code 2.1.250; every section above was captured on
2.1.247):

Lag-distribution probe (`lag-probe.sh` / `lag-probe.py`, section (o)): the
same role-aware, token-based `PreToolUse` detector as the transcript probe
above, polling every 25 ms for up to 5 s instead of every 100 ms for up to
3 s, so the result is a distribution (p50, max) rather than one confirming
sample, and additionally recording the winning transcript entry's own
`isSidechain` and `sessionId` fields. Ten positive runs plus two negative
controls, all under `--permission-mode bypassPermissions`.

Retry-distribution probe (`retry-probe-v2.sh`, section (p)): the same
`retry-probe.py` detector and deny-and-instruct shape as the block-and-retry
probe above, now parameterised by deny text via `PROBE_DENY_KIND`. Two
texts: `single` (byte-identical to the original section (g) text, asking
for one retry) and `repeated` (asking for a retry, and, if denied again, to
retry again); both sentences are quoted verbatim in section (p) below.
Three "report first" runs plus ten "no report first" runs per text (the
"report first" shape was already established at n=3 in section (g); the
"no report first" shape, where section (g)'s two n=3 samples disagreed on
whether the child stops after one retry, is the one re-run at n=10 per
text to separate them). All under `--permission-mode bypassPermissions`,
`--max-turns 6`.

Interactive lag probe (`interactive-lag-probe.sh`, section (q)): the same
tmux-driven interactive shape as `interactive-capture.sh` (isolated
`CLAUDE_CONFIG_DIR`, onboarding seed, `env -u CLAUDECODE`), with
`lag-probe.py` wired as the `PreToolUse` hook (25 ms poll / 5 s bound, same
as (o)) in place of a plain recorder, plus a plain `Stop` recorder used only
to know when a run's turn has ended. Three fresh interactive
`bypassPermissions` sessions.

Building this probe surfaced a version-dependent change in
`interactive-lib.sh`'s shared startup driver, used by every interactive
script in this directory: on this machine's Claude Code 2.1.250, the
workspace-trust dialog's default selection is "No, exit", and a bare
`Enter` on that screen exits the session instead of accepting it (confirmed
live: `tmux capture-pane` before and after showed the session gone).
The driver previously sent only `Enter` for that dialog. Sections (h) and
(i) were captured successfully with that same bare-`Enter` driver on Claude
Code 2.1.247; this measurement did not independently re-test 2.1.247, so
that is evidence consistent with an earlier default of "Yes, I trust this
folder", not direct proof of one. The driver was changed to send `Down`
then `Enter` on the workspace-trust dialog, the same two keys it already
sent for the bypassPermissions warning, so both startup dialogs are now
answered identically; this reproduces current CLI behaviour on the dialog
that blocked every run of this probe before the fix, rather than choosing a
new answer for it.

## Reproducing

```sh
UG_SIG_OUT=$(mktemp -d) ./capture.sh          # the 4-mode x 6-event capture
UG_SIG_OUT=$(mktemp -d) ./hook-env-probe.sh   # hook process env + parent chain
UG_SIG_OUT=$(mktemp -d) ./transcript-probe.sh # 5+2 report-visibility probe
UG_SIG_OUT=$(mktemp -d) ./ask-probe.sh        # hook ask resolution, 4 modes
UG_SIG_OUT=$(mktemp -d) ./retry-probe.sh      # block-and-retry, 3+3 runs
UG_SIG_OUT=$(mktemp -d) ./interactive-capture.sh    # interactive payload capture, 2 runs
UG_SIG_OUT=$(mktemp -d) ./interactive-ask-probe.sh  # interactive ask resolution, 2 runs
UG_SIG_OUT=$(mktemp -d) ./subagent-capture.sh       # subagent session id, 2 runs
UG_SIG_OUT=$(mktemp -d) ./codex-capture.sh              # codex exec, 14 shapes + untrusted
UG_SIG_OUT=$(mktemp -d) ./codex-interactive-capture.sh  # codex TUI, 11 shapes via tmux
UG_SIG_OUT=$(mktemp -d) ./lag-probe.sh                   # lag distribution, 10+2 runs
UG_SIG_OUT=$(mktemp -d) ./retry-probe-v2.sh              # retry distribution, 2 texts x (3+10) runs
UG_SIG_OUT=$(mktemp -d) ./interactive-lag-probe.sh       # interactive lag distribution, 3 runs
UG_SIG_OUT=$(mktemp -d) ./delegate-e2e.sh                # delegation end to end, 3+3+1+1 runs
```

The three slice 3 scripts follow the same `UG_SIG_OUT` / `UG_SIG_CONFIG_DIR`
/ `UG_SIG_WORK` defaulting as the eight above; `interactive-lag-probe.sh`
additionally takes `UG_SIG_RUNS` (default 3) and `UG_SIG_CLAUDE`, and needs
`tmux` on `PATH` like the other two interactive scripts. All three cost API
usage per the run counts named above; do not raise them past what the
README documents.

`delegate-e2e.sh` (results section (r)) is the one script in this directory wired against the REAL production hook chain rather than a recorder or a synthetic token-detector: `harness pack hook pre-tool-use` (the built CLI under test) for `PreToolUse`, and the real `@lannguyensi/understanding-gate` npm package bins (`understanding-gate-claude-hook` / `understanding-gate-claude-stop`) for `UserPromptSubmit` / `Stop`, the same roster `harness apply` itself writes for Claude Code (`docs/policy-packs/understanding-before-execution.md`, "What the pack ships at apply time"). It additionally takes `UG_SIG_MANIFEST_DIR` (isolated `harness.yaml` + `harness.generated/`, default `mktemp -d`) and `UG_SIG_CLI` (path to the built `dist/cli/main.js`; no default, the script refuses to run without a real build). It needs `understanding-gate-claude-hook` and `understanding-gate-claude-stop` on `PATH` (`npm i -g @lannguyensi/understanding-gate`) in addition to `claude`. It costs 8 `claude -p` calls (3+3+1+1); do not raise the per-shape counts past what results section (r) documents.

All eight Claude Code scripts default `UG_SIG_OUT` / `UG_SIG_CONFIG_DIR` /
`UG_SIG_WORK` to fresh `mktemp -d` directories when unset, so they run
standalone without any path editing. None of them touch the operator's
default `CLAUDE_CONFIG_DIR`. The three added ones take `UG_SIG_RUNS` (run
count, default 2) and `UG_SIG_CLAUDE` (binary, default `claude` from `PATH`)
as well; `interactive-ask-probe.sh` also takes `UG_SIG_SETTLE`.
`interactive-lib.sh` is sourced by the two interactive scripts and is not
run on its own. The two interactive scripts need `tmux` on `PATH` and kill
every session they create through a `trap ... EXIT INT TERM`.

`codex-capture.sh` defaults `UG_SIG_OUT` to a fresh `mktemp -d` and takes
`UG_SIG_CODEX` (binary, default `codex` from `PATH`); it needs no
`CODEX_HOME` set beforehand, since it creates a fresh one per shape.
`codex-interactive-capture.sh` takes the same variables plus `UG_SIG_RUNS`
where a shape is re-run, and needs `tmux` on `PATH`; it kills every tmux
session it creates through a `trap ... EXIT INT TERM`, same as the Claude
Code interactive scripts. Neither Codex script touches the operator's
default `CODEX_HOME`. The opencode probe (`dogfood/ug-auto-mode-signals/opencode/`)
is not a standalone script; its five runs (`run-{a,b,c,d,e}.cmd`) were driven
by hand against the two scratch projects checked in under `opencode/project`
and `opencode/project-ask`, with `PROBE_LOG` set per run to the matching
`opencode/probe-<shape>.jsonl`.

## Redaction

Applied to everything under `payloads/` with a scripted find-and-replace,
verified afterward with `grep`:

| Match | Replacement |
| ----- | ----------- |
| the capture machine's scratch directory prefix | `<scratch>` |
| the slugged form of that prefix used in Claude Code's `projects/` transcript paths | `<scratch-slug>` |
| the capture user's home directory prefix | `<home>` |
| values of `CLAUDE_CODE_MESSAGING_TOKEN` | `<redacted>` |
| values of `CLAUDE_CODE_BRIDGE_SESSION_ID` | `<redacted>` |
| `/tmp/cc-socks/<pid>.sock` | kept as-is (throwaway pid, not sensitive) |
| the throwaway runs' own `session_id` values | kept as-is |

Verification command and result:

```sh
# <login> = the capture user's login name, <tmp-prefix> = the machine's
# per-user temp-dir prefix, <run-id> = the capture session's scratch-directory
# id; all three are machine-specific and deliberately not spelled out here.
grep -rn -E '<login>|<tmp-prefix>|<run-id>|MESSAGING_TOKEN=[0-9a-f]|session_01' dogfood/ug-auto-mode-signals
```

Zero hits at capture time.

Re-run unchanged after the interactive and subagent fixtures of sections
(h) to (j) were added (their per-run config and cwd directories map onto the
same `<scratch>/cc-config` and `<scratch>/cc-work` placeholders, and the
captured panes go through the same replace): zero hits again. The pattern's
only match anywhere under this directory is the line above, which spells the
pattern out; excluding that line the grep returns nothing. No new
secret-looking value appeared in the added fixtures, so the table above is
unchanged. The added hook-env dump redacts
`CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_BRIDGE_SESSION_ID` in the hook
command itself, before the value ever reaches a file.

Codex and opencode fixtures (`payloads/codex-*`, `opencode/`) apply the same
per-user, per-machine redactions plus these Codex/opencode-specific ones,
verified afterward with `grep`:

| Match | Replacement |
| ----- | ----------- |
| the Codex capture host's hostname (WSL2 machine) | `<host>` |
| the per-shape `CODEX_HOME` scratch directory (exec) | `<scratch>/codex-home` |
| the per-shape scratch cwd (exec) | `<scratch>/codex-work` |
| the per-run scratch directory holding `codex-capture.sh`'s own output | `<scratch>/codex-cap` |
| the opencode scratch probe root (`project`, `project-ask`) | `<scratch>/opencode-probe` |
| the opencode probe user's login (`username` field, `env`) | `<login>` |

Re-run after sections (k) to (n) were added, with the three placeholders
in the command above substituted by the Codex capture host's real values
(its login name, its scratch prefix `~/tmp/ug-codex*`, and its hostname,
none of which is spelled out here) and, for the opencode probe, by the
opencode host's login and scratch prefix: zero hits. Note that `<login>`
is now also a real placeholder VALUE in the five
`opencode/probe-*.jsonl` files (the opencode `config` payload's `username`
field), so the command must not be run with the literal token `<login>`
left in place; it would then match its own redaction output. Codex's own
`session_id` and `turn_id` values (throwaway, generated for this capture)
and opencode's `sessionID`/`callID`/`pid` values are kept as-is, the same
treatment as the Claude Code `session_id` values in the table above.

Slice 3 fixtures (`payloads/lag-probe.jsonl`, `payloads/retry-probe-v2.jsonl`
and its `payloads/retry-probe-v2-*.result.json` siblings,
`payloads/interactive-lag-probe.jsonl`, and
`payloads/interactive-lag-probe.transcript-shape-at-bound.json`) apply the
same per-user, per-machine redactions as the table above; the interactive
transcript fixture is checked in as a types-and-counts summary (the same
shape as `payloads/subagent-bypass.transcript-shape.json`) rather than the
raw JSONL, because the raw file also carries the session's full skill and
agent listing, which is noise for what this fixture demonstrates and not
worth reviewing line by line. Verified with the same grep command as above,
substituting this machine's real login and scratch-directory prefix for the
placeholders: zero hits.

The delegate-e2e fixture (`payloads/delegate-e2e.jsonl`, one row per
`claude -p` run) applies the same scratch-directory-prefix and login
redaction; unlike every fixture above, its `session_id`-shaped values
(child and parent session ids) are ALSO kept as-is where they appear
raw (matching the table's own "throwaway session_id" treatment), but
the `approved_by_redacted` field the collector emits additionally
replaces the child and parent ids with `<child-sid>` / `<parent-sid>`
literals inside that one field, per this task's own acceptance
criterion ("approvedBy matching ... (redact ids)"); the two are not in
conflict; `approved_by_redacted` is a stricter, additional redaction on
top of the row, not a replacement for the file-level rule above.
Verified with the same grep command, substituting this machine's real
scratch-directory prefix and login: zero hits.

## Results

### (a) `permission_mode` field, presence and value, by event x mode

| Event | default | acceptEdits | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` |
| ----- | ------- | ----------- | -------------------------------------- | --------------------------------- |
| SessionStart | no field | no field | no field | no field |
| UserPromptSubmit | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| PreToolUse | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| PostToolUse | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| Stop | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| SessionEnd | no field | no field | no field | no field |

Derived from `payloads/claude-p-<mode>.<Event>.json` for all 24
combinations. `--dangerously-skip-permissions` reports the same
`bypassPermissions` value as `--permission-mode bypassPermissions`; the
payload gives no way to tell the two flags apart.

### (b) Full field list per event (bypass run)

| Event | Fields present |
| ----- | --------------- |
| SessionStart | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` |
| UserPromptSubmit | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`, `prompt` |
| PreToolUse | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id` |
| PostToolUse | all of PreToolUse's fields plus `tool_response`, `duration_ms` |
| Stop | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` |
| SessionEnd | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `reason` |

`background_tasks` and `session_crons` were empty arrays in this run. See
`payloads/claude-p-bypass.<Event>.json` for the exact shapes.

### (c) Hook process env and parent chain

From `payloads/hook-env-probe.txt` (a `PreToolUse` hook under
`bypassPermissions`):

- Process chain: `claude -> /bin/sh -> hook` (the hook command runs as a
  child of a `/bin/sh` spawned by `claude`).
- `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (this is a `claude -p` run; an
  interactive session was not captured here).
- `AI_AGENT=claude-code_2-1-247_harness` in the hook's own environment.
  A separate capture run (`payloads/claude-p-default.PostToolUse.json`,
  default mode, a different session from the env probe) shows the Bash
  tool's own shell reporting `AI_AGENT=claude-code_2-1-247_agent`
  instead: across runs, the hook process and the agent's Bash-tool shell
  get different `AI_AGENT` suffixes (`_harness` vs `_agent`) with
  otherwise near-identical environments. No single run captured both
  values for the same tool call.
- Also present in the hook env: `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_PROJECT_DIR`, `CLAUDE_EFFORT`, `CLAUDE_CONFIG_DIR`.
- No permission-mode variable appears anywhere in the hook's own
  environment (`env | grep -E '^(CLAUDE|AI_AGENT|SHLVL|PPID|_=)'` covers
  every `CLAUDE*` variable present in the probe).

### (d) Session ids

Each `claude -p` run gets its own `session_id`; all four are distinct:

| Mode | session_id |
| ---- | ---------- |
| default | `74b10eba-4c5c-40fa-bf7d-a0fe6e710e0d` |
| acceptEdits | `7118ee4c-f906-4b97-ae1d-6bb50c032ae2` |
| bypass | `0436a933-86cb-42a5-b608-e6a87d49e3ee` |
| dangerously | `b582f71f-d60e-4f8b-be11-40298946fa6f` |

### (e) Transcript-probe result (n=5 positive runs + 2 negative controls, all `--permission-mode bypassPermissions`)

Method (second version): a PreToolUse and Stop hook (`transcript-probe.py`)
parses `transcript_path` line by line and counts only entries of
`type: "assistant"` whose text contains BOTH the heading
`# Understanding Report` and the token `gnidnatsrednu` (the word
"understanding" reversed; the prompt asks the model to produce it and
never spells it out). At t0 the hook records the line count and whether
such an entry exists; if not, it polls every 100 ms for up to 3 s and
records when the entry first appears. The two negative controls ask for
the Bash call only, with no report. Driver: `transcript-probe.sh`; raw
output: `payloads/transcript-probe.jsonl`.

The first version of this probe matched the bare string
"Understanding Report" anywhere in the transcript. The user prompt itself
contained that string (transcript line 3), so its "visible at t0" result
was an artifact of the prompt, not evidence about the assistant's report.
It was caught in review by an independent re-run and is superseded by the
table below.

| Run | Kind | Lines at PreToolUse t0 | Assistant report line at t0 | First seen after (ms) | Assistant report line (final) | Stop: `last_assistant_message` contains report |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | positive | 9 | none | 110 | 11 | no |
| 2 | positive | 9 | none | 110 | 11 | no |
| 3 | positive | 9 | none | 111 | 11 | no |
| 4 | positive | 9 | none | 110 | 11 | no |
| 5 | positive | 9 | none | 110 | 11 | no |
| 6 | negative | 9 | none | never (3 s) | none | no |
| 7 | negative | 9 | none | never (3 s) | none | no |

5/5 positive runs: at the instant the `PreToolUse` hook fires the
transcript holds 9 lines (the user prompt is line 3) and the assistant's
own report is NOT among them; it lands at line 11 and is present at the
first 100 ms poll in every run. 0/2 negative controls produced a false
positive. At `Stop` the report is in the transcript (line 11) in 5/5
positive runs, but `last_assistant_message` carries only the final text
("done"), never the report (5/5; 0/2 in the controls).

### (f) Hook `permissionDecision: "ask"` resolution under `-p` (one run per mode)

Method: a PreToolUse hook on matcher `Bash` records the payload and then
answers `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"askprobe: hook asked for operator confirmation"}}`;
PostToolUse, PermissionRequest and PermissionDenied hooks are plain
recorders. The prompt asks for exactly one Bash call (`echo askprobe-executed`).
Script: `ask-probe.sh`. Fixtures: `payloads/ask-probe-<mode>.PreToolUse.json`
(the recorded PreToolUse payload) and `payloads/ask-probe-<mode>.result.json`
(the trimmed `claude -p` result object).

| Mode | `permission_mode` in the PreToolUse payload | Command ran (PostToolUse fired) | `permission_denials` in the result | PermissionRequest / PermissionDenied recorder wrote a file |
| ---- | ---- | ---- | ---- | ---- |
| default (`--allowedTools Bash`) | `default` | no | 1 entry (the Bash call) | no / no |
| acceptEdits (`--allowedTools Bash`) | `acceptEdits` | no | 1 entry | no / no |
| `--permission-mode bypassPermissions` | `bypassPermissions` | no | 1 entry | no / no |
| `--dangerously-skip-permissions` | `bypassPermissions` | no | 1 entry | no / no |

4/4: under `-p` a hook `ask` resolves to a denial in every mode measured,
including both bypass spellings. In every run the model's final text
reported the command as blocked by a hook. stderr carried only Claude
Code's own "no stdin data received in 3s" warning (stdin was left
attached; harmless). The interactive (non-`-p`) resolution of a hook `ask`
under `bypassPermissions` was not measured.

### (g) Block-and-retry under `-p` (3 runs with the report written first, 3 without)

Method: see "Block-and-retry probe" above. Script: `retry-probe.sh`.
Fixtures: `payloads/retry-probe.jsonl` (one row per hook invocation) and
`payloads/retry-probe-<kind><n>.result.json` (trimmed `claude -p` result
objects).

| Run | Kind | 1st PreToolUse (lines, report found, decision) | 2nd PreToolUse | 3rd PreToolUse | Command ran (PostToolUse) | `permission_denials` | Turns |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | report first | 9, no, deny | 11, yes, allow | (none) | yes | 1 | 3 |
| 2 | report first | 9, no, deny | 11, yes, allow | (none) | yes | 1 | 3 |
| 3 | report first | 9, no, deny | 11, yes, allow | (none) | yes | 1 | 3 |
| 4 | no report first | 9, no, deny | 13, no, deny | (none) | no | 2 | 3 |
| 5 | no report first | 9, no, deny | 14, no, deny | (none) | no | 2 | 3 |
| 6 | no report first | 9, no, deny | 13, no, deny | 14, yes, allow | yes | 2 | 4 |

Report written first (runs 1-3): the first gated call is denied because
the report is not yet in the transcript (9 lines), the child retries the
same command, the second `PreToolUse` finds the report (line 11), allows,
and the command runs: 3/3. No report first (runs 4-6): in 3/3 runs the
child writes the report and retries as instructed, but the retry sits in
the same turn as the freshly written report, and the second `PreToolUse`
does not see it yet (13 to 14 lines, report absent): the transcript lag
hits again. Runs 4 and 5 stopped after the single retry the deny text
asked for (their final text reported the gate as not detecting the
report); run 6 retried a third time, the report was then visible (line
14), and the command ran. So the instruction channel works (the child
writes and retries, 3/3), the retry itself works when the report is
already flushed (3/3), and a single retry is not enough when the report
was written in the same turn (0/3 on the second attempt, 1/3 on a third).

Independent re-run (review round 3; same script unmodified, same
machine): `payloads/retry-probe.rerun.jsonl` and
`payloads/retry-probe-rerun-<kind><n>.result.json`.

| Run | Kind | 1st PreToolUse | 2nd PreToolUse | 3rd PreToolUse | Command ran | `permission_denials` | Turns |
| --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | report first | 9, no, deny | 11, yes, allow | (none) | yes | 1 | 3 |
| r2 | report first | 9, no, deny | 11, yes, allow | (none) | yes | 1 | 3 |
| r3 | report first | 9, no, deny | 11, yes, allow | (none) | yes | 1 | 3 |
| r4 | no report first | 9, no, deny | 13, no, deny | 14, yes, allow | yes | 2 | 4 |
| r5 | no report first | 9, no, deny | 13, no, deny | 14, yes, allow | yes | 2 | 4 |
| r6 | no report first | 9, no, deny | 13, no, deny | 14, yes, allow | yes | 2 | 4 |

The lag halves replicate exactly; the stop-after-one-retry half does not:
in the re-run all three no-report children made an unprompted third
attempt and succeeded. Combined over both samples of the same one-retry
deny text, 2/6 runs stopped after the single retry and 4/6 tried again;
a single retry is reliable in neither direction, which is the reading the
ADR carries.

### (h) Interactive (non `-p`) `bypassPermissions` capture (n=2 fresh sessions)

Method: see "Interactive payload capture" above. Script:
`interactive-capture.sh`. Fixtures: `payloads/interactive-bypass.<Event>.json`
(run 1's payloads), `payloads/interactive-bypass.hook-env.txt` (run 1's hook
process env for the same tool call), and
`payloads/interactive-bypass.session-agreement.json` (both runs' agreement
rows).

| Run | PreToolUse `permission_mode` | payload `session_id` | hook env `CLAUDE_CODE_SESSION_ID` | agree | `CLAUDE_CODE_ENTRYPOINT` | `AI_AGENT` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `bypassPermissions` | `90ab7a1e-1eb1-4399-a14a-41115a07cb9f` | same | yes | `cli` | `claude-code_2-1-247_harness` |
| 2 | `bypassPermissions` | `ef297ea0-7037-491a-90b2-4cada1e057a2` | same | yes | `cli` | `claude-code_2-1-247_harness` |

2/2. Three readings:

- The interactive `PreToolUse` payload carries `permission_mode:
  "bypassPermissions"`, the same value and spelling the `-p` runs of section
  (a) carry. So does `UserPromptSubmit` and `Stop`; `SessionStart` and
  `SessionEnd` carry no such field, again as under `-p`.
- The hook process's `CLAUDE_CODE_SESSION_ID` equals the payload's
  `session_id` in both runs. Section (c)'s agreement was captured only for a
  `claude -p` run; it now holds for the interactive launch shape too. Still
  not exercised: a `--session-id`-pinned launch.
- `CLAUDE_CODE_ENTRYPOINT` is `cli` interactively, against `sdk-cli` under
  `-p` (section (c)); `AI_AGENT` carries the same `_harness` suffix in both.
  The interactive hook env has no `CLAUDE_CODE_BRIDGE_SESSION_ID` and no
  `CLAUDE_CODE_EXECPATH` entry, where the `-p` probe of section (c) had
  both; note that this probe's grep is `^(CLAUDE|AI_AGENT)` where section
  (c)'s also took `SHLVL`, `PPID` and `_=`, so only the `CLAUDE*` and
  `AI_AGENT` variables are comparable between the two.

Two per-event differences from the `-p` field lists of section (b), same
events, same mode:

| Event | `-p` | interactive |
| --- | --- | --- |
| SessionStart | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` | the same plus `model` (value `claude-opus-5[1m]` in run 1) |
| SessionEnd | `reason: "other"` | `reason: "prompt_input_exit"` (the session was ended with `/exit`) |

`SubagentStart` and `SubagentStop` were registered in both runs and never
fired: this prompt spawns no subagent. Section (j) exercises them.

A third session was run afterwards with `UG_SIG_RUNS=1` and no other
environment variables, to check that the script needs no path editing (its
`UG_SIG_*` directories all came from `mktemp -d`). It reproduced all three
readings above: `permission_mode` `bypassPermissions`, hook env
`CLAUDE_CODE_SESSION_ID` equal to the payload `session_id`, and
`CLAUDE_CODE_ENTRYPOINT` `cli`. Its payloads are not checked in, so the
table above stays at the two recorded runs.

### (i) Interactive resolution of a hook `permissionDecision: "ask"` under `bypassPermissions` (n=2)

Method: see "Interactive `ask` probe" above; the hook answer is
`ask-probe.sh`'s, byte-for-byte. Script: `interactive-ask-probe.sh`.
Fixtures: `payloads/interactive-ask-bypass.PreToolUse.json`,
`payloads/interactive-ask-bypass.PermissionRequest.json`, and
`payloads/interactive-ask-bypass.pane.txt` (run 1's pane at the prompt,
the same pane 20 s later untouched, the pane after `Escape`, run 2's
pane at the prompt, and run 2's pane 20 s later untouched).

| Run | `permission_mode` in the PreToolUse payload | Permission dialog shown | Auto-resolved within 20 s | Command ran (PostToolUse fired) | PermissionRequest hook fired | PermissionDenied hook fired | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `bypassPermissions` | yes | no | no | yes | no | `prompted` |
| 2 | `bypassPermissions` | yes | no | no | yes | no | `prompted` |

2/2 `prompted`: interactively, and despite `bypassPermissions`, a hook `ask`
is NOT auto-allowed. It surfaces a real permission dialog carrying the
hook's own reason string, and that dialog waits for the operator. The
verbatim pane at the prompt (run 1, from the fixture):

```
⏺ Bash(echo askprobe-executed)
  ⎿  Waiting…

 Bash command

   echo askprobe-executed
   Echo test string

 │ Hook PreToolUse:Bash requires confirmation for this command:
 │ askprobe: hook asked for operator confirmation [settings]
 settings.json to update hooks

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

The evidence behind each column, so the classification can be checked rather
than taken on trust: the dialog text above is the pane fixture; "no
auto-resolve" is the second pane in that fixture, captured 20 s later with
no key sent in between and byte-identical to the first; "command did not
run" is the absent `iask<n>.PostToolUse.jsonl` recorder file (the same
recorder wrote a file in every section (h) run, so its absence is
informative and not a wiring accident); `Escape` was then sent, and the
third pane shows `Interrupted · What should Claude do instead?`, which is a
refusal, not an approval. No run of this probe ever answered a permission
prompt.

Two secondary observations: the `PermissionRequest` hook fires interactively
(it never fired in the four `-p` runs of section (f)), and its payload
carries the same `permission_mode: "bypassPermissions"`, `session_id`,
`prompt_id` and `tool_input` as the `PreToolUse` payload of the same call,
but no `tool_use_id`. `PermissionDenied` fired in neither section.

So the two resolutions of a hook `ask` under `bypassPermissions` differ by
launch shape: a denial under `-p` (section (f), 4/4 across modes),
an operator prompt interactively (here, 2/2). Neither is an auto-allow.

### (j) Subagent (Agent tool) capture under `-p bypassPermissions` (n=2)

Method: see "Subagent capture" above. Script: `subagent-capture.sh`.
Fixtures: `payloads/subagent-bypass.<Event>.json` (run 1;
`subagent-bypass.PreToolUse.json` is an array holding both `PreToolUse`
payloads of the run, the parent's `Agent` call and the subagent's own `Bash`
call) and `payloads/subagent-bypass.transcript-shape.json` (both runs'
transcript line counts by `type` and by `isSidechain`).

| Run | SubagentStart fired | SubagentStop fired | Subagent's Bash `PreToolUse` `session_id` == parent's | Extra fields on that payload | `agent_type` |
| --- | --- | --- | --- | --- | --- |
| 1 | yes (1) | yes (1) | yes | `agent_id`, `agent_type` | `general-purpose` |
| 2 | yes (1) | yes (1) | yes | `agent_id`, `agent_type` | `general-purpose` |

2/2. What the payloads say:

- The subagent's own tool call reaches the SAME `PreToolUse` hook with the
  parent's `session_id`, the parent's `prompt_id`, the parent's
  `transcript_path` and `permission_mode: "bypassPermissions"`, plus two
  fields no non-subagent payload in this dogfood carries: `agent_id` (an
  opaque id, e.g. `acbaf0d426cde00e9`) and `agent_type`
  (`general-purpose`). So a subagent is not a separate session as far as the
  hook payload is concerned, and `agent_id` is the field that tells a
  subagent call apart from a main-line one.
- `SubagentStart` carries `session_id`, `transcript_path`, `cwd`,
  `prompt_id`, `agent_id`, `agent_type`, `hook_event_name`, and no
  `permission_mode`. `SubagentStop` carries the `Stop` field set plus
  `agent_id`, `agent_type` and `agent_transcript_path`, and it does carry
  `permission_mode`.
- Transcript shape, and this is the part that matters beyond the session id:
  the subagent's turns are NOT in the transcript the payload names. In both
  runs the payload's `transcript_path` holds 16 to 17 lines of which every
  entry that carries the field has `isSidechain: false`, and zero have
  `isSidechain: true`; the subagent's 6 entries live in a separate file,
  `<transcript-dir>/<session-id>/subagents/agent-<agent_id>.jsonl`, named by
  `SubagentStop`'s `agent_transcript_path`, and there every entry has
  `isSidechain: true`. Counts per run in
  `payloads/subagent-bypass.transcript-shape.json`.

### (k) Codex exec, `permission_mode` by shape (14 successful runs plus `untrusted`)

Method: see "Codex capture" above. Script: `codex-capture.sh`. Fixtures:
`payloads/codex-exec-<shape>.<Event>.json` (six events per shape),
`payloads/codex-exec-<shape>.flags.txt` (the flags/config under test),
`payloads/codex-exec-<shape>.events.jsonl` (the raw `--json` event stream)
and `payloads/codex-exec-<shape>.PreToolUse.env.txt` (the hook process env
for that run's `PreToolUse` call).

| shape | flags / config (`payloads/codex-exec-<shape>.flags.txt`) | `PreToolUse` `permission_mode` | `SessionStart` |
| --- | --- | --- | --- |
| exec-default | (none) | `bypassPermissions` | `bypassPermissions` |
| exec-readonly | `-s read-only` | `bypassPermissions` | `bypassPermissions` |
| exec-workspace | `-s workspace-write` | `bypassPermissions` | `bypassPermissions` |
| exec-fullaccess | `-s danger-full-access` | `bypassPermissions` | `bypassPermissions` |
| exec-never-ws | `-c approval_policy="never" -s workspace-write` | `bypassPermissions` | `bypassPermissions` |
| exec-never-full | `-c approval_policy="never" -s danger-full-access` | `bypassPermissions` | `bypassPermissions` |
| exec-onfailure | `-c approval_policy="on-failure"` | `bypassPermissions` | `bypassPermissions` |
| exec-onrequest | `-c approval_policy="on-request"` | `bypassPermissions` | `bypassPermissions` |
| exec-bypass | `--dangerously-bypass-approvals-and-sandbox` | `bypassPermissions` | `bypassPermissions` |
| exec-approve-for-me | `--approve-for-me` | `default` | `default` |
| config-never-full | `config.toml`: `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` | `bypassPermissions` | `bypassPermissions` |
| config-never-ws | `config.toml`: `approval_policy = "never"`, `sandbox_mode = "workspace-write"` | `bypassPermissions` | `bypassPermissions` |
| config-perm-fullaccess | `config.toml`: `default_permissions = ":danger-full-access"` | `bypassPermissions` | `bypassPermissions` |
| config-perm-readonly | `config.toml`: `default_permissions = ":read-only"` | `bypassPermissions` | `bypassPermissions` |
| exec-untrusted | `-c approval_policy="untrusted"` | (no run) | error, `payloads/codex-exec-untrusted.events.jsonl`: `approval_policy = "untrusted" is no longer supported; remove this setting` |

Every value in this table was re-read directly from the fixture (`grep -o
'"permission_mode": "[^"]*"' payloads/codex-exec-<shape>.PreToolUse.json`),
not carried over from a prior summary. `codex exec` has no
`-a`/`--ask-for-approval` flag in 0.150.1 (only the TUI has it); a headless
run auto-approves (`bypassPermissions`) unless `--approve-for-me` routes
approvals through automatic review (`default`), regardless of
`sandbox_mode` or `default_permissions`. No `PermissionRequest` event fired
in any of the 14 runs. `tool_use_id` has the shape `exec-<uuid>`
(`payloads/codex-exec-default.PreToolUse.json`).

### (l) Codex TUI, `permission_mode` by shape (11 runs)

Method: see "Codex capture" above. Script: `codex-interactive-capture.sh`.
Fixtures: `payloads/codex-tui-<shape>.<Event>.json` (`SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`; no `SessionEnd`
recorder was registered for the TUI shapes), `payloads/codex-tui-<shape>.config.toml`,
`payloads/codex-tui-<shape>.pane.txt` and `payloads/codex-tui-<shape>.footer.txt`.

| shape | how (`payloads/codex-tui-<shape>.flags.txt` / config) | `PreToolUse` `permission_mode` | footer |
| --- | --- | --- | --- |
| tui-default | no flags ("Ask for approval" profile) | `default` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-plan | Shift+Tab once | `default` | `gpt-5.6-terra medium ... Plan mode` |
| tui-perm-approve-for-me | `/permissions` -> 2 "Approve for me" | `default` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-perm-full-access | `/permissions` -> 3 "Full Access" | `bypassPermissions` | `Press enter to confirm or esc to go back` |
| tui-never | `-a never` | `bypassPermissions` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-bypass | `--dangerously-bypass-approvals-and-sandbox` | `bypassPermissions` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-readonly | `-s read-only` | `default` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-fullaccess | `-s danger-full-access` | `default` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-approve-for-me | `--approve-for-me` | `default` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-config-never | `config.toml`: `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` | `bypassPermissions` | `gpt-5.6-terra default · <scratch>/codex-work` |
| tui-config-never-ws | `config.toml`: `approval_policy = "never"`, `sandbox_mode = "workspace-write"` | `bypassPermissions` | `gpt-5.6-terra default · <scratch>/codex-work` |

`tui-perm-full-access`'s footer file caught the `/permissions` menu's own
confirmation line ("Press enter to confirm or esc to go back") instead of
the usual status footer, because the recorder polled the pane at the moment
the menu was still open; `payloads/codex-tui-perm-full-access.permissions-menu.txt`
holds the full menu screen ("Update Model Permissions": 1. Ask for approval
(current), 2. Approve for me, 3. Full Access selected), and the pane after
confirmation shows the normal prompt with no menu. `tui-approve-for-me` was
re-run once: a first attempt was quit (`/quit`) before the probe's Bash call
completed, producing no `PreToolUse` fixture, and the row above is the
successful re-run.

The footer's mode label (`default` / `Plan mode`) reflects the Shift+Tab
collaboration mode, not `permission_mode`; only the `/permissions` menu
("Update Model Permissions": Ask for approval / Approve for me / Full
Access) moves `permission_mode`. Plan mode still reports `default` in the
payload. Combined with section (k), the vocabulary actually observed across
all 25 Codex runs is `bypassPermissions` and `default`; the Codex hooks
documentation's `plan`, `acceptEdits` and `dontAsk` values were never
produced by any shape tried here.

### (m) Codex payload shape and hook environment

`PreToolUse` fields, all 25 runs (`payloads/codex-exec-default.PreToolUse.json`,
confirmed identical field set across the other shapes): `session_id`,
`turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, `tool_name` (`Bash`), `tool_input` (`{command}`),
`tool_use_id`. `transcript_path` follows
`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl` and is
present on disk at hook time (verified against
`payloads/codex-exec-default.PreToolUse.json`'s `transcript_path` value).
Shape-identical to the Claude Code `PreToolUse` payload of README section
(b) minus `prompt_id`/`effort`, plus `turn_id`/`model`; the real payload
sends `tool_input`, not harness's older portable `raw_input` name.

Hook process environment (`payloads/codex-exec-default.PreToolUse.env.txt`,
same set in every `codex-exec-*`/`codex-tui-*.PreToolUse.env.txt`): only
`CODEX_HOME`, `CODEX_MANAGED_BY_NPM=1`, `CODEX_MANAGED_PACKAGE_ROOT`, `PWD`,
`SHLVL`, `_=/usr/bin/env`, and the `ps` line showing the parent chain
`codex -> bash`. NO session-id variable of any name in the hook's own
environment (the env probe covers everything the hook process sees). This
is the shape-level consequence: the Claude Code session-consistency check of
README sections (c) and (h) (payload `session_id` vs env
`CLAUDE_CODE_SESSION_ID`) has no Codex counterpart, since Codex never puts a
session id in the hook process's environment at all.

### (n) opencode `--auto` plugin observability (5 runs)

Method: see "opencode capture" above. Fixtures:
`opencode/probe-{a,b,c,d,e-serve}.jsonl` (per-hook event log),
`opencode/run-{a,b,c,d,e}.cmd`/`.stdout`/`.stderr`, `opencode/diff-a-vs-b.txt`
(field-level diff between the auto and non-auto runs against the default
project), `opencode/binary-context.txt` and
`opencode/binary-context-permission-ask.txt` (`strings` grep over the
installed `opencode.exe`).

| run | project | command | plugin-visible result |
| --- | --- | --- | --- |
| (a) | `project` (default permissions) | `opencode run --auto` | bash allowed, no permission event fired (`probe-a.jsonl`) |
| (b) | `project` | `opencode run` (no `--auto`) | bash allowed, no permission event fired (`probe-b.jsonl`); byte-identical to (a) except `argv`/`bunArgv` (`--auto` token), pids, session/call ids and `PROBE_*` env (`diff-a-vs-b.txt`) |
| (c) | `project-ask` (`"permission": {"bash": "ask"}`) | `opencode run --auto` | `tool.execute.before` fires directly (no `permission.asked`/`permission.replied` event reaches the plugin); tool ran (`probe-c.jsonl`) |
| (d) | `project-ask` | `opencode run` (no `--auto`) | `tool.execute.before` fires, tool ran (`probe-d.jsonl`); no distinguishing permission event visible to the plugin here either |
| (e) | `project-ask` | `opencode serve --port 4097` + separate `opencode run --attach --auto` | plugin runs inside the long-lived `serve` process; `argv` carries no `--auto` (it belongs to the detached `run --attach` invocation, a different process); tool ran (`probe-e-serve.jsonl`) |

`--auto` (client-side aliases `--yolo`, `--dangerously-skip-permissions`,
confirmed in `opencode/binary-context.txt`'s `yolo` and
`dangerously-skip-permissions` excerpts) is implemented purely in the CLI
client: `opencode/binary-context.txt`'s `reply:"once"` excerpt shows the
`permission.asked` event handler replying `{reply:"once"}` when
`u.mode==="auto"` and otherwise queuing the prompt or (for `run` without
`--auto`) replying `{reply:"reject"}`. No config field, env var, or
`PluginInput` field carries the mode; `config.permission` in every captured
`config` hook payload with `--auto` matches the payload without it, field
for field, except argv (`diff-a-vs-b.txt`). The typed `permission.ask`
plugin-facing hook name from the docs does not appear at all in the
installed 1.18.18 binary's source strings
(`opencode/binary-context-permission-ask.txt`: `count '"permission.ask"': 0`);
the real internal event names are `permission.asked` and
`permission.replied`, and this probe's plugin (`.opencode/plugin/auto-probe.ts`)
never received either for any of the five runs (defaults allow `bash`, so no
permission was ever actually asked for the plugin to observe, in `project`
or `project-ask`, `--auto` or not). Two indirect channels exist to observe
`--auto` from inside a plugin, and both have a named limit: `process.argv`
contains the literal `--auto` token when the plugin runs in the same
process as the CLI invocation that received the flag (runs a/c, absent in
run e where the flag belongs to a different, `--attach`ed process); and a
`permission.replied` event carrying `reply: "once"` without a preceding
human action would indicate `--auto`, but that only exists when a
permission is actually asked, which none of these five runs triggered
(defaults allow `bash`), and even then it is byte-identical to a human's
"Allow once" reply at the plugin level. Verdict: no decision-grade signal
and no hook projection to build on for opencode's `--auto`; harness's own
opencode adapter also does not project any hook (`src/cli/apply/generate-opencode-config.ts`
header, unchanged in this task) into the generated `opencode.json`, so even
if a decision-grade signal existed there is currently nothing in the
pipeline positioned to read it. Out of scope for auto-approval; design note
only.

### (o) Lag distribution under `-p` (n=10 positive runs + 2 negative controls, `bypassPermissions`)

Method: see "Lag-distribution probe" above. Script: `lag-probe.sh`.
Fixtures: `payloads/lag-probe.jsonl` (one row per run, in run order: 10
positive then 2 negative).

| Run | Kind | Lines at t0 | First seen after (ms) | Winning entry `isSidechain` | Winning entry `sessionId` == payload `session_id` |
| --- | --- | --- | --- | --- | --- |
| 1 | positive | 9 | 65 | false | yes |
| 2 | positive | 9 | 67 | false | yes |
| 3 | positive | 9 | 64 | false | yes |
| 4 | positive | 9 | 139 | false | yes |
| 5 | positive | 9 | 68 | false | yes |
| 6 | positive | 9 | 132 | false | yes |
| 7 | positive | 9 | 63 | false | yes |
| 8 | positive | 9 | 70 | false | yes |
| 9 | positive | 9 | 104 | false | yes |
| 10 | positive | 9 | 62 | false | yes |
| 11 | negative | 9 | never (5 s) | n/a | n/a |
| 12 | negative | 9 | never (5 s) | n/a | n/a |

p50 = 67.5 ms, max = 139 ms, min = 62 ms (median and extremes of the ten
positive latencies, sorted: 62, 63, 64, 65, 67, 68, 70, 104, 132, 139).
`lines_t0` is 9 in all 12 runs, matching section (e) exactly: the report is
never visible at the instant `PreToolUse` fires. The ten latencies cluster
in two bands, 62-70 ms in 7/10 runs and 104-139 ms in the remaining 3/10;
even the slowest of the twelve is comfortably inside the 5 s bound. Every
winning entry carries `isSidechain: false` and a `sessionId` equal to the
payload's own `session_id`, 10/10, confirming the entry the timer stops on
is a main-line entry of the same session, not a sidechain or a foreign
one. 0/2 negative controls produced a false positive within the bound.

### (p) Retry distribution by deny text (n=3 "report first" + n=10 "no report first", per text; `bypassPermissions`)

Method: see "Retry-distribution probe" above. Script: `retry-probe-v2.sh`.
Fixtures: `payloads/retry-probe-v2.jsonl` (one row per hook invocation,
both texts) and `payloads/retry-probe-v2-<text>-<kind><n>.result.json`
(trimmed `claude -p` result objects; `<kind>` is `pos` for "report first"
or `neg` for "no report first").

Deny texts, quoted verbatim and used verbatim in `retry-probe.py`:

- `single`: "Understanding gate: no Understanding Report is visible for
  this session yet. If you already wrote one, simply retry the same
  command once. If you have not, first write a section starting with the
  heading '# Understanding Report' containing the line 'Token: ' followed
  by the word understanding spelled backwards, then retry the command."
  (byte-identical to the section (g) text)
- `repeated`: "Understanding gate: no Understanding Report is visible for
  this session yet. If you already wrote one, simply retry the same
  command; if it is denied again, retry again. If you have not, first
  write a section starting with the heading '# Understanding Report'
  containing the line 'Token: ' followed by the word understanding spelled
  backwards, then retry the command; if it is denied again, retry again."

| Deny text | Shape | n | Attempts, every run | Success rate |
| --- | --- | --- | --- | --- |
| `single` | report first | 3 | 2 (1 deny, 1 allow) | 3/3 |
| `single` | no report first | 10 | 3 (2 deny, 1 allow) | 10/10 |
| `repeated` | report first | 3 | 2 (1 deny, 1 allow) | 3/3 |
| `repeated` | no report first | 10 | 3 (2 deny, 1 allow) | 10/10 |

Attempt histogram, "no report first" shape (the one section (g)'s two n=3
samples disagreed on): 0/10 stopped after the single retry (2 attempts),
10/10 needed exactly one further, unprompted retry (3 attempts total),
0/10 needed more than that, for BOTH texts, 20/20 combined.

Reading: at n=10 per text the two deny texts produce identical, invariant
behaviour. Every "no report first" run is denied twice (first call: report
absent; second call, the immediate retry the text asked for: report still
not flushed, the same lag section (e)/(o) measure) and allowed on an
unprompted third attempt, 20/20. This is a larger, decisive sample against
section (g)'s two n=3 runs of the `single` text alone (2/6 stopped after
the requested single retry, 4/6 tried again): at n=10 the "tries again
anyway" behaviour is universal, and the earlier split reads as small-sample
noise, not a text effect. The `repeated` text asks in words for the third
attempt the `single` text does not request; empirically the child performs
it either way, 10/10 per text, so this sample gives no evidence that the
wording changes the retry count. What the attempt count tracks instead is
the lag itself: a retry succeeds once the report has had enough real time
to flush (each attempt is a fresh model turn, so a second retry runs
seconds after the first, comfortably past the tens-of-milliseconds lag
section (o) measured under `-p`), and fails when it has not (the immediate
first retry, still inside that same turn).

### (q) Interactive lag distribution under `bypassPermissions` (n=3 fresh sessions)

Method: see "Interactive lag probe" above. Script:
`interactive-lag-probe.sh`. Fixtures: `payloads/interactive-lag-probe.jsonl`
(one row per run), `payloads/interactive-lag-probe.transcript-shape-at-bound.json`
(each run's transcript, by entry type and `isSidechain`, at the moment its
5 s poll bound elapsed), and `payloads/interactive-lag-probe.ilag1-pane.txt`
(run 1's terminal pane after the session ended).

| Run | Lines at t0 | First seen after (ms) | Assistant-type entries present at the 5 s bound |
| --- | --- | --- | --- |
| 1 | 11 | never (5 s) | 0 |
| 2 | 11 | never (5 s) | 0 |
| 3 | 11 | never (5 s) | 0 |

3/3: unlike the `-p` case, the report is not visible within the same 25 ms
/ 5 s bound in any interactive run. The transcript-shape fixture shows this
is not simply "slower": at the moment each run's poll gives up, the
transcript holds only 11 lines and NONE of them is an `assistant`-type
entry at all. All eleven are startup/preamble entries present before the
model even begins answering (`mode`, `permission-mode`, `atis-latch`,
`file-history-snapshot`, one `user` entry, five `attachment` entries, then
`ai-title`), identical across all three runs. The pane fixture shows the
same run's screen after the session ended: the model did write the report,
run the command, and reply "done", so the assistant's turn is not silently
lost, it is written to the transcript file later than this hook's own 5 s
wait, or possibly not until the gated tool call this same hook is deciding
is itself resolved (this measurement's bounded poll cannot distinguish
"later" from "only after this hook returns" without a channel outside the
hook itself, and building one was out of scope for this round). Either
reading gives the same answer for `report_scan.max_wait`: no poll bound
this hook can wait on, from inside a `PreToolUse` invocation, was observed
to see the report before giving up, up to 5 s. Not measured: a longer
bound, a longer report, or a session where the gated call is not the
child's first tool call of the turn.

### (r) Delegation end to end under `-p`: real `claude -p` children against the production hook chain (n=3+3+1+1)

Method: see "Reproducing" above and the script's own header comment.
Unlike every section above, `delegate-e2e.sh` wires the REAL production
chain rather than a recorder or a synthetic token-detector hook:
`harness pack hook pre-tool-use` (the built CLI under test) for
`PreToolUse` (matcher `Bash|Edit|Write`), and the real
`@lannguyensi/understanding-gate` npm package bins
(`understanding-gate-claude-hook` / `understanding-gate-claude-stop`) for
`UserPromptSubmit` / `Stop`, the same roster `harness apply` itself
writes for Claude Code. Isolated `harness.yaml`
(`auto_approve.when: [bypassPermissions]`, `harnesses: [claude-code]`,
`require_report: true`, `mode: grill_me`) and `harness.generated/`, never
`~/.harness` or `~/.claude`. A fixed parent session id is approved once
via `harness approve understanding --session <parent>` with a minimal
valid grill_me report on stdin (an OPERATOR act, targeting the isolated
generated dir only); each child then gets its own delegation
(`harness delegate --child-session <uuid> --cwd <work> --session-id
<parent>`, none at all for shape (c), or one bound to a DIFFERENT cwd for
shape (d)) before being launched as `claude -p ... --session-id <uuid>
--permission-mode bypassPermissions --output-format json --max-turns 6`.
The gated command is `touch delegate-e2e-ok-<child-sid>.txt`,
deliberately NOT `echo ...`: `echo` is in `SIMPLE_READ_ONLY_BINS`
(`src/runtime/read-only-bash.ts`) and is exempted from the gate entirely
at an earlier decision step, before the delegation/auto-approval logic
ever runs (confirmed during script development with a synthetic event:
`echo` allowed via "read-only Bash command, allowing without an approved
report" even with a VALID delegation and a VALID report both already
present). Every touch target is named per child session id rather than a
shared literal, so a stale file left by an earlier successful run in the
same shared `$WORK` cannot make a LATER run's "did the Bash call actually
run" check a false positive. Fixture: `payloads/delegate-e2e.jsonl` (one
row per run, produced by `delegate-e2e-collect.py`).

Four shapes:

| Shape | n | Delegation | Report before 1st tool call | Launch cwd |
| --- | --- | --- | --- | --- |
| (a) | 3 | valid, bound to the shared cwd | yes | shared |
| (b) | 3 | valid, bound to the shared cwd | prompt says NO | shared |
| (c) | 1 | none | yes | shared |
| (d) | 1 | valid, bound to a DIFFERENT cwd | yes | shared (mismatched) |

Results:

| Shape | Bash ran | Marker minted | `approvedBy` (redacted) | Turns | `permission_denials` |
| --- | --- | --- | --- | --- | --- |
| (a) runs 1-3 | 3/3 | 3/3 | `auto-mode:claude-code:bypassPermissions;delegated:<parent-sid>` | 3, 3, 5 | 1, 1, 3 |
| (b) runs 1-3 | 3/3 | 3/3 | same shape as (a) | 5, 5, 5 | 3, 3, 3 |
| (c) | 0/1 | 0/1 | n/a | 4 | 3 |
| (d) | 0/1 | 0/1 | n/a (refused `cwd_mismatch`) | 4 | 3 |

- **Delegation verification, phrasing.** Every shape here launches with
  `--permission-mode bypassPermissions`, which is itself listed in
  `auto_approve.when`, so the real hook payload's own `permission_mode`
  is ALSO `bypassPermissions` in every run: slice 1's ordinary
  mode-allowlist check passes independent of the delegation.
  `attemptAutoApproval` logs a DIFFERENT stderr phrasing in that case:
  `auto-approval key one: permission_mode "bypassPermissions" in
  auto_approve.when (a valid delegation from parent session <sid> is
  also present)`, rather than the delegation-ALONE phrasing
  (`auto-approval key one: valid delegation from parent session <sid>`)
  that only fires when the payload's mode is NOT `when`-listed. 6/6 of
  the shape (a)/(b) logs carry the additive form (0/6 the alone form);
  the delegation-alone form was exercised only by this script's
  pre-run synthetic smoke tests (`permission_mode: "default"`), not by
  any of the 8 counted `claude -p` runs. The `approvedBy` marker's
  `<mode>` segment follows the same rule: it carries the mode literal
  (`bypassPermissions`), not the neutral `delegated` literal reserved
  for an unlisted payload mode (`src/cli/pack/auto-approve-path.ts`'s
  own doc comment); the `;delegated:<parent-sid>` suffix is appended
  regardless of which form fired, so the marker still records that a
  delegation was present and held either way.
- **The delegation's transcript-scan-and-persist is what actually makes
  shape (a)/(b) succeed, not the mode-allowlist by itself.** Slice 1's
  own auto-approval branch only ever checks ALREADY-PERSISTED reports
  (`selectNewestStrictSessionReport` over `listPersistedReports`); it
  never reads the transcript itself. Nothing else in this wiring
  persists a report mid-session: the real `understanding-gate-claude-stop`
  bin fires once, at the very end of the WHOLE `claude -p` invocation,
  too late to help a same-invocation retry (confirmed by shape (c)
  below). Every one of the 6 shape (a)/(b) successes carries a
  `"harness pack hook: captured the Understanding Report ... from its
  own transcript"` line immediately before the marker is minted, and
  that line is written ONLY inside the delegation branch. So although
  the `approvedBy` mode segment reads as if slice 1 alone did the work,
  the delegation's own report-capture supplied key two in every one of
  these six runs.
- **Shape (c), the clean negative control: 0/1.** Same prompt, same
  already-`when`-listed `permission_mode`, NO delegation, the child
  could not unblock itself within the one invocation. Its own final
  text names why: the first `touch` was denied ("no approved
  Understanding Report for this session"), it tried the escape
  (`harness approve understanding <<'UNDERSTANDING_REPORT' ...`) twice,
  both resolved to a denial (`ASK: operator-approval command, deferring
  to the interactive permission prompt`, matching README section (f)'s
  `-p`-resolves-`ask`-to-denial finding), and it stopped rather than
  retrying the gated command itself a third time (`max-turns 6`
  exhausted at 4 turns of its own accord). This is the measured
  behaviour the ADR's own premise predicts (a `-p` child has no
  operator, and `Stop` fires only once, too late to help mid-session),
  reproduced end to end, a measured negative, not a slice 3 defect.
- **Shape (b) did not stay a clean "no report" negative control against
  a cooperative model: 3/3, not 0/3.** The prompt explicitly said "do
  not write any report or heading first"; all three children wrote a
  full report anyway once blocked (matching the npm package's own
  documented behaviour: "the agent typically reads the deny-reason and
  falls back to producing the report"). Attempt pattern, 3/3 identical:
  1st `touch` denied (no report anywhere yet) -> the `harness approve
  understanding` escape denied (one run tried it twice) -> a full report
  written inline and the `touch` retried, which the delegation's
  transcript scan then captured and approved. This is useful evidence
  about how a cooperative model responds to being blocked, not proof
  the gate opens without a report: every run that succeeded did so only
  after the model actually wrote and got a report checked, exactly
  what the gate requires. The prompt's instruction not to was simply not
  something the model honoured once it hit the gate.
- **`report_scan.max_wait` (default at the time of this measurement,
  500 ms, since retuned to 2 s, see below): 6/6 of the shape (a)/(b)
  FIRST attempts exhausted the full bound without finding the report**
  (waited 519-524 ms; the config's 5 s ceiling was never approached).
  This differs from the "well under a third of 500 ms" comfortable
  margin in "Chosen `report_scan.max_wait` default" below, derived from
  sections (e)/(o)'s much SHORTER probe report (max 139 ms across 15
  samples). Every one of these 6 real runs carried the full ten-section
  grill_me report this task's own fixture uses (several hundred words),
  and every one needed a SECOND attempt (a later retry, after the model
  did other work in between) to succeed, where the report was already
  flushed ("after 0-1 ms", matching sections (g)/(p)'s established retry
  pattern). It is the retry-and-instruct fallback the ADR designed for
  exactly this case, not a first-attempt hit inside the 500 ms bound,
  that carried every one of these six runs to success. See "Chosen
  `report_scan.max_wait` default" for the consequence for AC 4's
  refinement: the shipped default was retuned to 2 s off this finding
  (the 500 ms figure throughout this section is what was actually in
  force during these runs, not the current default).
- **The retry sentence's literal bytes were not captured from these six
  runs' own hook stdout.** Claude Code consumes a `PreToolUse` hook's
  stdout as the permission decision, and this script's `settings.json`
  wiring does not tee it to a file. `report_scan_timed_out: true` is
  code-traced proof the sentence was appended to that call's stdout
  regardless (`hook-pre-tool-use.ts`'s
  `reportScanTimedOut ? DELEGATION_REPORT_RETRY_INSTRUCTION : null` line
  runs unconditionally on a timeout); the sentence's current exact text
  was independently confirmed present in a direct, synthetic (non-
  `claude -p`) invocation of this same built binary during script
  validation, not one of the 8 counted runs.
- **Shape (d): `cwd_mismatch` on every attempt** (2/2 `PreToolUse`
  invocations across the one run). The child never reached the
  report-capture step at all, and gave up after trying (and being
  denied on) the same `harness approve` escape shapes (b)/(c) tried.
  Matches the acceptance criterion exactly.
- **Ledger facts** (`understanding-auto-approved:<child>`,
  `understanding-delegated:<child>:<parent>`) were not reachable in any
  run (`grounding-mcp not declared in manifest`), consistent with the
  isolated manifest's deliberately minimal shape; recorded per row as
  `"ledger not wired in the isolated dir"`.

Reading: end to end, against the real production hook chain rather than a
probe, the two-key design behaves exactly as designed, a delegation
without the child's own report mints nothing (0/1, shape (c) with no
delegation; every shape (a)/(b) attempt before its report was captured),
and a report without a valid delegation for a `-p` child that has not
already had one persisted some other way cannot unblock itself within one
invocation either (shape (c) again). Both keys together, even layered on
top of an already-`when`-listed `permission_mode`, is what carries a real
child through: the delegation's own transcript-scan-and-persist is the
mechanism that actually supplies the report in every success this run
produced, the mode-allowlist alone never would have. The one place this
run complicates the existing evidence rather than confirming it is
`report_scan.max_wait`'s default: a full-length grill_me report needed
the retry-and-instruct fallback in 6/6 real attempts, not a same-attempt
hit inside 500 ms, where the shorter probe reports of sections (e)/(o)
suggested a comfortable 3-4x margin. As a consequence, the shipped
default was retuned from 500 ms to 2 s (see
`docs/okf/understanding-gate-auto-mode-signals.md`, "Chosen
`report_scan.max_wait` default"); the ceiling stays 5 s.
