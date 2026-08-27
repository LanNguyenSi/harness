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
```

All eight scripts default `UG_SIG_OUT` / `UG_SIG_CONFIG_DIR` / `UG_SIG_WORK`
to fresh `mktemp -d` directories when unset, so they run standalone without
any path editing. None of them touch the operator's default
`CLAUDE_CONFIG_DIR`. The three added ones take `UG_SIG_RUNS` (run count,
default 2) and `UG_SIG_CLAUDE` (binary, default `claude` from `PATH`) as
well; `interactive-ask-probe.sh` also takes `UG_SIG_SETTLE`.
`interactive-lib.sh` is sourced by the two interactive scripts and is not
run on its own. The two interactive scripts need `tmux` on `PATH` and kill
every session they create through a `trap ... EXIT INT TERM`.

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
the same pane 20 s later untouched, the pane after `Escape`, and run 2's
pane at the prompt).

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
