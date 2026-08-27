# Understanding-gate auto-mode signals, measured

Evidence for `docs/decisions/2026-08-27-ug-auto-mode-approval.md` (written
in parallel with this dogfood; see that path for the decision). This
directory holds only the measured signals and the scripts that produced
them: what fields the Claude Code hook payload actually carries per
permission mode and event, what the hook process's own environment looks
like, and whether a report written mid-turn is visible to a `PreToolUse`
hook versus to `Stop`.

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
```

All five scripts default `UG_SIG_OUT` / `UG_SIG_CONFIG_DIR` / `UG_SIG_WORK`
to fresh `mktemp -d` directories when unset, so they run standalone without
any path editing. None of them touch the operator's default
`CLAUDE_CONFIG_DIR`.

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
