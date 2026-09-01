---
type: overview
title: Understanding gate, auto-mode signal sources (measured)
description: What signals exist for detecting an agent's own permission/auto-approval mode across Claude Code, Codex, and opencode, measured where possible, doc-only where not, with a trust-class table. Covers both launch shapes for Claude Code, headless and interactive, plus how a hook ask resolves in each and what a subagent's tool call looks like to the same hook. The rule and the decision on which signals gate anything live in the ADR, not here.
tags: [understanding-gate, permission-mode, auto-mode, hooks, measurement, trust-boundary]
timestamp: 2026-09-01T06:45:00Z
sources:
  - src/cli/pack/auto-approve-path.ts
  - dogfood/ug-auto-mode-signals/README.md
  - dogfood/ug-auto-mode-signals/delegate-e2e.sh
  - src/cli/pack/hook-pre-tool-use.ts
  - src/policy-packs/builtin/understanding-before-execution/permission-mode-observations.ts
  - src/cli/pack/hook-bootstrap.ts
  - src/runtime/session-id.ts
  - src/cli/smoke/runner.ts
  - src/cli/session-export/transcript.ts
  - src/cli/apply/generate-opencode-config.ts
  - src/runtime/read-only-bash.ts
  - docs/policy-packs/understanding-before-execution.md
  - dogfood/ug-auto-mode-signals/codex-capture.sh
  - dogfood/ug-auto-mode-signals/codex-interactive-capture.sh
  - dogfood/ug-auto-mode-signals/opencode/README-evidence.txt
---

# Understanding gate, auto-mode signal sources (measured)

This records what signal sources actually exist for "is this agent running
in an auto-approval mode" across the three adapters, and what each one is
worth as evidence. It is the evidence layer only: which signals, if any,
should be allowed to relax the understanding gate is a decision, and that
decision (with its rationale, its threat model, and its rollout plan)
lives in `docs/decisions/2026-08-27-ug-auto-mode-approval.md`, not here.

## What this records

Measured data for all three adapters (`dogfood/ug-auto-mode-signals/`,
captured 2026-08-27): Claude Code 2.1.247 on macOS, Codex CLI 0.150.1 on
Linux/WSL2, and opencode 1.18.18 against a local Ollama model. Every number
below is derived from the raw files in that dogfood directory; where this
doc's predecessor plan draft disagreed with a raw file, the raw file wins
(none of the numbers below needed correcting against the raw captures).

A second capture wave the same day, on the same machine and version, added
the three Claude Code shapes the first wave had left open: an interactive
(non `-p`) session, the interactive resolution of a hook `ask`, and a
subagent's own tool call. Those sections say so, and the entries they close
have left the "Unverified / not measured" list. A third wave added the
Codex and opencode captures below, closing the "doc-only" status this
section used to carry for both.

## Claude Code

### Measured: `permission_mode` in the hook payload, by event x mode

| Event | default | acceptEdits | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` |
| ----- | ------- | ----------- | -------------------------------------- | --------------------------------- |
| SessionStart | no field | no field | no field | no field |
| UserPromptSubmit | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| PreToolUse | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| PostToolUse | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| Stop | `default` | `acceptEdits` | `bypassPermissions` | `bypassPermissions` |
| SessionEnd | no field | no field | no field | no field |

Full field lists per event, the hook process env and parent chain
findings, the four runs' session ids, and the transcript-visibility probe
table are in `dogfood/ug-auto-mode-signals/README.md` (sections a to e);
this doc does not repeat them, only the parts load-bearing for the trust
discussion below.

### Measured: the same field in an interactive (non `-p`) session

Two fresh interactive sessions launched with `--permission-mode
bypassPermissions` inside a detached terminal multiplexer, driven by
keystrokes, one Bash call each (README results section (h); script
`interactive-capture.sh`; fixtures
`payloads/interactive-bypass.<Event>.json`):

- `PreToolUse` carries `permission_mode: "bypassPermissions"`, the same
  value and spelling as the `-p` runs, 2/2. So do `UserPromptSubmit` and
  `Stop`; `SessionStart` and `SessionEnd` carry no such field, again as
  under `-p`. So the trusted signal the design rests on is present in both
  launch shapes, not only headless ones.
- The hook process's own `CLAUDE_CODE_SESSION_ID` equals the payload's
  `session_id`, 2/2. The session-consistency check therefore holds for the
  interactive launch shape as well as the `-p` one; a `--session-id`-pinned
  launch is still not exercised.
- `CLAUDE_CODE_ENTRYPOINT` is `cli` interactively against `sdk-cli` under
  `-p`, and `AI_AGENT` carries the same `_harness` suffix in both. The
  entrypoint value is the one env-level discriminator between the two
  launch shapes seen here; it stays corroboration-only, in the same trust
  class as the rest of the hook env.
- Two per-event field differences from the `-p` capture, same mode:
  interactive `SessionStart` additionally carries a `model` field, and
  interactive `SessionEnd` reports `reason: "prompt_input_exit"` where the
  `-p` run reported `"other"`. Neither event carries `permission_mode` in
  either shape.

A third session, run with the script's default scratch directories to check
it needs no path editing, reproduced the first three readings; its payloads
are not checked in.

Claude Code's own hook documentation (code.claude.com/docs/en/hooks)
describes `permission_mode` as a common hook input field with values
`default` / `plan` / `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions`,
and states "Not all events receive this field", consistent with what was
measured (SessionStart and SessionEnd carry no such field). `auto` and
`dontAsk` were not observed in this measurement; only `default`,
`acceptEdits`, and `bypassPermissions` (from both the flag of that name
and `--dangerously-skip-permissions`, which the payload cannot distinguish
from it) were exercised.

### Measured: hook process environment

The hook process (a `PreToolUse` hook under `bypassPermissions`) runs as
`claude -> /bin/sh -> hook`, carries `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (this
was a `claude -p` run), and `AI_AGENT=claude-code_2-1-247_harness`. A
separate capture run in default mode (the `PostToolUse` payload's
`tool_response.stdout`, a different session) shows the agent-driven Bash
tool shell reporting `AI_AGENT=claude-code_2-1-247_agent`: same process
family, different `AI_AGENT` suffix (`_harness` vs `_agent`), observed
across runs, not within one. No permission-mode variable appears in
either environment. Full env dump in the README's section (c).

### What harness reads today

A repo-wide grep for `permission_mode|permissionMode|permission-mode`
(the hyphenated form is the CLI flag) finds the sites below. Since slice 1
of the ADR (agent-tasks `74b4b17d`) exactly one of them is gate logic, and
it is confined to the last step of the hook's decision order:

- `src/cli/pack/hook-pre-tool-use.ts` reads `permission_mode` from the
  payload into its event type and hands it, together with the payload's
  raw `session_id`, to `src/cli/pack/auto-approve-path.ts`, the
  decision-order step 9 auto-approval attempt that runs only when the
  marker check and every exemption branch have declined and only when
  the pack config carries `auto_approve`. No other decision path
  consults the field; `src/cli/pack/hook-bootstrap.ts` (the shared
  payload-parsing helpers) still has zero occurrences. Before that slice
  the gate did not read the field at all. Task `8f637efd` adds a second,
  non-gating read of the same field at the same call site: right before
  the auto-approval attempt, the hook also persists a small per-session
  observation record of the field's value under
  `harness.generated/.permission-mode-observations/`
  (`permission-mode-observations.ts`), consumed only by `harness
  doctor`'s missing-`auto_approve` finding, never by any gate decision.
- `src/cli/smoke/runner.ts:69-70`: `CLAUDE_FLAGS` hard-codes
  `--permission-mode bypassPermissions` as an argv flag the smoke driver
  passes to the `claude -p` subprocess it spawns; this sets the mode, it
  does not read it back as a gate signal.
- `src/cli/session-export/transcript.ts:13,43,152-153`: parses a
  `permission-mode` transcript line into a `TranscriptEvent` with
  `kind: "permission_mode"` and `data: { mode: raw.permissionMode }`,
  for session-export purposes. Not consulted by any gate.
- `src/cli/smoke/stream-parser.ts:23`: an optional `permissionMode` field
  on the parsed `InitEvent` from `claude -p --output-format
  stream-json`'s `system`/`init` line; also smoke-only, not gate logic.

### Transcript visibility of a mid-turn report

Question: when a `claude -p` agent writes its Understanding Report before
its first tool call, is that report already in the transcript JSONL at the
instant the `PreToolUse` hook fires? Measured with a role-aware,
token-based probe (only `assistant` entries count, and a hit needs a token
the prompt never spells out), 5 positive runs and 2 negative controls, all
under `bypassPermissions`. Result (per-run table in the README, section
(e); raw rows in `payloads/transcript-probe.jsonl`):

- At the instant `PreToolUse` fires, the transcript holds 9 lines and the
  assistant's report is not among them, 5/5. The report lands at line 11
  and is present at the first poll 100 ms later, 5/5 (first seen after
  110 to 111 ms). Negative controls: 0/2 false positives.
- At `Stop` the report is in the transcript (5/5) but the payload's
  `last_assistant_message` carries only the turn's final text, never the
  report, 5/5.

This agrees with, and refines, the existing statements that mid-turn
assistant text is not reliably persisted to the transcript
(`src/cli/pack/approve-escape.ts:20-24`; the lockout runbook): at the hook
instant it is not there; shortly afterwards it is, in this sample. A first
version of this probe matched the bare string "Understanding Report"
anywhere in the transcript, which the prompt itself contained, and
therefore reported "visible at t0"; that result was an artifact and is
withdrawn (README section (e) keeps the note). Not measured: other modes,
interactive sessions, longer reports, other machines or versions.

### Measured: hook `permissionDecision: "ask"` resolution under `-p`

Under `claude -p`, a PreToolUse hook that answers `permissionDecision:
"ask"` resolves to a denial in every mode measured (default, acceptEdits,
`--permission-mode bypassPermissions`, `--dangerously-skip-permissions`):
the tool call does not run, no PostToolUse fires, and the run's result
JSON lists the call under `permission_denials`. One run per mode; table
and fixtures in `dogfood/ug-auto-mode-signals/README.md`, results section
(f), script `ask-probe.sh`. Relevance: the harness escape path returns
`ask` for a bare `harness approve ...` Bash call
(`src/cli/pack/hook-pre-tool-use.ts`, escape branch), so under headless
runs that path is fail-closed.

### Measured: the same `ask`, resolved interactively under `bypassPermissions`

Two fresh interactive sessions, same hook answer byte-for-byte as the `-p`
probe (README results section (i); script `interactive-ask-probe.sh`;
fixtures `payloads/interactive-ask-bypass.PreToolUse.json`,
`payloads/interactive-ask-bypass.PermissionRequest.json`, and
`payloads/interactive-ask-bypass.pane.txt`, which holds the screen at the
prompt, the same screen 20 s later untouched, and the screen after the
prompt was dismissed):

- 2/2 the hook `ask` surfaces a real permission dialog, quoting the hook's
  own reason string, and waits. It is NOT auto-allowed by
  `bypassPermissions`: the dialog was still unchanged after 20 s with no
  key sent, and the tool never ran (the `PostToolUse` recorder wrote no
  file, where the same recorder wrote one in every interactive run of the
  capture probe). The probe dismissed the prompt rather than answering it.
- The `PermissionRequest` hook fires interactively, where it never fired in
  the four `-p` runs; its payload carries the same `permission_mode`,
  `session_id`, `prompt_id` and `tool_input` as the `PreToolUse` payload of
  the same call and no `tool_use_id`. `PermissionDenied` fired in neither
  shape.

So the resolution of a hook `ask` under `bypassPermissions` differs by
launch shape, a denial under `-p` and an operator prompt interactively, and
neither shape is an auto-allow. Consequence for the escape path: the
conditional hardening item (return `deny` whenever `permission_mode` names
a non-prompting mode) has no measured case to fire on here, because
`bypassPermissions` is not prompt-less for a hook `ask`. Not measured:
`auto` and `dontAsk`, which the payload vocabulary allows and this
measurement never produced.

### Measured: block-and-retry under `-p`

Question: when a PreToolUse hook denies a `claude -p` child's gated call
with an instruction to (re-)emit its Understanding Report and retry, does
the child retry, and does the retry find the report? Three runs with the
report requested before the first tool call, three without (README,
results section (g); script `retry-probe.sh`; rows in
`payloads/retry-probe.jsonl`):

- Report written before the first call: first call denied (report not yet
  in the transcript), child retries the same command, second PreToolUse
  finds the report, allows, command runs: 3/3.
- No report before the first call: the child writes the report and retries
  as instructed, 3/3, but the retry sits in the same turn as the freshly
  written report and the second PreToolUse does not see it yet (transcript
  lag, 3/3). Two runs stopped after the single retry the deny text asked
  for and never executed the command; one retried a third time, the report
  was then visible, and the command ran.

Independent re-run (review round 3, same script unmodified, same machine;
rows in `payloads/retry-probe.rerun.jsonl`, result objects
`payloads/retry-probe-rerun-<kind><n>.result.json`): report first,
identical, 3/3. No report first: first and second attempts identical
(deny at 9 lines, deny at 13 lines), but all 3/3 made an unprompted third
attempt, found the report at line 14, and ran (2 denials, 4 turns each).
Combined over both samples of the one-retry deny text: 2/6 runs stopped
after the single retry, 4/6 tried again and succeeded.

Reading: the instruction channel (deny reason) reaches the child and it
acts on it, 6/6; a retry succeeds once the report is flushed, 6/6; a retry
issued in the same turn as the report does not, 6/6; whether the child
then tries again unprompted varies from run to run (2/6 stop, 4/6
continue), so a block-and-retry capture shape depends on either the deny
text asking for repeated retries or the hook waiting for the flush
itself, and a single retry is reliable in neither direction. Not
measured: other modes, interactive sessions, larger turn budgets, deny
texts that ask for more than one retry, a sample large enough to put a
rate on the third attempt.

### Measured: subagents (Agent tool) and the parent session id

Two `claude -p --permission-mode bypassPermissions` runs whose only job was
to delegate one Bash call to a `general-purpose` subagent (README results
section (j); script `subagent-capture.sh`; fixtures
`payloads/subagent-bypass.<Event>.json` and
`payloads/subagent-bypass.transcript-shape.json`):

- The subagent's own tool call reaches the SAME `PreToolUse` hook carrying
  the parent's `session_id`, the parent's `prompt_id`, the parent's
  `transcript_path` and `permission_mode: "bypassPermissions"`, 2/2. So a
  subagent is not a separate session as far as the hook payload is
  concerned, and a marker bound to the parent's session id covers it.
- That payload additionally carries two fields no non-subagent payload in
  this measurement carries: `agent_id` (an opaque id) and `agent_type`
  (here `general-purpose`). `agent_id` is therefore the field that tells a
  subagent's tool call apart from a main-line one, if a gate ever needs to.
- `SubagentStart` and `SubagentStop` both fire, once each, on the parent's
  session id. `SubagentStart` carries no `permission_mode`; `SubagentStop`
  does, along with `agent_id`, `agent_type` and `agent_transcript_path`.
- Transcript shape, and this is the part that does not match the shape a
  sidechain filter assumes: the subagent's turns are NOT in the transcript
  the payload names. In both runs the payload's `transcript_path` holds no
  entry with `isSidechain: true` (every entry carrying the field has
  `false`), and the subagent's entries sit in a separate file named by
  `SubagentStop`'s `agent_transcript_path`
  (`<transcript-dir>/<session-id>/subagents/agent-<agent_id>.jsonl`), where
  every entry has `isSidechain: true`. In this version, a scan restricted to
  the payload's own `transcript_path` therefore never sees a subagent entry
  in the first place; the separation is by file, not by a flag inside one
  file.

### Measured: lag distribution under `-p` (README section (o))

Ten positive runs plus two negative controls, `--permission-mode
bypassPermissions` (README results section (o); script
`dogfood/ug-auto-mode-signals/lag-probe.sh`; fixtures
`payloads/lag-probe.jsonl`). Same role-aware, token-based detector as the
transcript-visibility probe above, polling every 25 ms for up to 5 s
instead of section (e)'s 100 ms / 3 s:

- p50 67.5 ms, max 139 ms, min 62 ms across the ten positive runs, in two
  latency bands (62-70 ms, 7/10; 104-139 ms, 3/10). `lines_t0` is 9 in all
  twelve runs, matching section (e): the report is never visible at the
  instant `PreToolUse` fires. 0/2 negative controls false-positived within
  the bound.
- The winning transcript entry carries `isSidechain: false` and a
  `sessionId` equal to the payload's own `session_id` in 10/10 runs,
  confirming the entry the timer stops on is a main-line entry of the same
  session, not a sidechain or a foreign one.

### Measured: retry distribution by deny text (README section (p))

Question left open by the block-and-retry sample above (two independent
n=3 samples of one deny text disagreeing 1/3 vs 3/3 on an unprompted third
attempt): is that split explained by the text's wording or by sample size?
Re-run at n=10 per text for the "no report first" shape (n=3 per text for
"report first", already established not to lag; README results section
(p); script `dogfood/ug-auto-mode-signals/retry-probe-v2.sh`; fixtures
`payloads/retry-probe-v2.jsonl`,
`payloads/retry-probe-v2-<text>-<kind><n>.result.json`). Two texts, quoted
verbatim in the README: `single` (byte-identical to the original text) and
`repeated` (asks explicitly for a further retry if denied again).

- "Report first": 2 attempts (1 deny, 1 allow), 3/3 for both texts.
- "No report first": 3 attempts (2 deny, 1 allow), 10/10 for BOTH texts,
  20/20 combined. 0/20 stopped after the single retry either text asked
  for.
- Reading: sample size, not text, explains the earlier disagreement; at
  n=10 the "retry again unprompted" behaviour is universal for both texts,
  so this sample gives no evidence that the deny text's wording changes
  the retry count. What tracks the attempt count is the lag itself: a
  retry succeeds once the report has had real time to flush (a further
  model turn after the first), and fails when the retry is still inside
  the turn that wrote the report.

### Measured: interactive lag distribution (README section (q))

Same 25 ms / 5 s detector as the previous section, wired as the
`PreToolUse` hook of an interactive (non `-p`) session via the tmux driver
(README results section (q); script
`dogfood/ug-auto-mode-signals/interactive-lag-probe.sh`; fixtures
`payloads/interactive-lag-probe.jsonl`,
`payloads/interactive-lag-probe.transcript-shape-at-bound.json`,
`payloads/interactive-lag-probe.ilag1-pane.txt`). Three fresh
`bypassPermissions` sessions:

- 3/3: the report is NOT visible within the 5 s bound in any run, unlike
  the `-p` result above (10/10 within 139 ms). At the moment each run's
  poll gives up, the transcript holds 11 lines and none is an
  `assistant`-type entry; all eleven are startup/preamble entries written
  before the model's own turn (`mode`, `permission-mode`, `atis-latch`,
  `file-history-snapshot`, one `user`, five `attachment`, `ai-title`),
  identical across all three runs.
- The pane fixture (captured after the session ended) shows the model did
  write the report, run the gated command, and reply "done", so the turn
  is not lost; the transcript write for it happens later than this hook's
  own 5 s wait, or possibly only once this same hook lets the gated call
  proceed. This measurement's bounded poll, run from inside the
  `PreToolUse` invocation it is trying to inform, cannot distinguish those
  two readings without a channel outside the hook itself, which was out of
  scope for this round.
- Building this probe surfaced a version-dependent startup-driver fix,
  unrelated to the lag question itself: on this machine's Claude Code
  2.1.250, the workspace-trust dialog defaults to "No, exit", where the
  shared interactive driver (`interactive-lib.sh`) previously sent a bare
  `Enter` there; every run of this probe failed at startup until the
  driver was changed to send `Down` then `Enter`, the same pattern it
  already used for the bypassPermissions warning. Recorded in the README's
  Method section; not itself a finding about the gate.

### Measured: delegation end to end under `-p` (README section (r))

Real `claude -p` children against the REAL production hook chain, not a
recorder or a synthetic token-detector hook: `harness pack hook
pre-tool-use` (the built harness CLI) for `PreToolUse`, the real
`@lannguyensi/understanding-gate` npm package bins for `UserPromptSubmit`
/ `Stop`, the same roster `harness apply` writes for Claude Code, over
an isolated manifest/generated dir/`CLAUDE_CONFIG_DIR` (README section
(r); script `dogfood/ug-auto-mode-signals/delegate-e2e.sh`; fixture
`payloads/delegate-e2e.jsonl`). Four shapes, n=3+3+1+1:

- (a) valid delegation, report before the gated call: 3/3 succeeded, all
  via the delegation's own transcript-scan-and-persist (slice 1's
  mode-allowlist check alone never reads the transcript, and nothing
  else persists a report mid-session, the real Stop-capture bin fires
  once, at the very end of the whole invocation).
- (b) valid delegation, prompt told the child NOT to write a report:
  3/3 wrote one anyway once blocked, and succeeded the same way as (a),
  a measured negative-control finding about a cooperative model's own
  behaviour under this prompt, not evidence the gate opens without a
  report.
- (c) NO delegation, otherwise identical to (a): 0/1. The child tried
  the `harness approve` escape twice (denied, matching README section
  (f)'s `-p`-`ask`-resolves-to-denial finding) and then gave up. This is
  the ADR's own premise (no operator, `Stop` fires once, too late)
  reproduced end to end, a measured negative, not a slice 3 defect.
- (d) delegation bound to a different cwd than the child's own: 0/1,
  `cwd_mismatch` on both `PreToolUse` attempts.
- `report_scan.max_wait` (retuned default 2 s, was 500 ms during this
  round's own runs): 6/6 of the (a)/(b) FIRST attempts exhausted the
  500 ms bound then in force without finding the report (waited
  519-524 ms), where sections (e)/(o) below (a much shorter probe
  report) measured a comfortable 139 ms max across 15 samples. See
  "Chosen `report_scan.max_wait` default" immediately below for the
  retuning this produced.

## Chosen `report_scan.max_wait` default

Drawing sections (o) through (q) above AND the real end-to-end runs
("Measured: delegation end to end under `-p`" above, README section
(r)) into the one number and the one verdict the ADR's slice 3
acceptance criterion 6 asks for. The two data sets disagree on
magnitude but agree on shape, and the second one is the one that
decides the number: the probe reports (sections (e)/(o), max 139 ms
across 15 samples, a first-guess 500 ms default at roughly 3-4x that
max) were short synthetic text, while the real end-to-end runs (README
section (r)) carried the actual ten-section grill_me report this
gate's own schema produces, and every one of those 6/6 first attempts
exhausted the full 500 ms bound (waited 519-524 ms) before the report
was visible. Report length measurably changes how long the transcript
flush takes, and the probe-derived 500 ms default was anchored to a
report far shorter than a real one.

- **Default: 2 s (2000 ms), retuned from an initial 500 ms.**
  Derivation: the observed first-poll overrun with a full-length
  report (519-524 ms, the point at which the OLD bound was already
  exhausted with the report still not visible) times roughly the same
  3-4x safety factor the original derivation used, rounded to a
  human-friendly value, gives 2 s. This covers the deciding case, a
  full-length report written in the same turn as the call that needs
  it, not only the shorter probe reports the first-guess default was
  anchored to.
- **Schema ceiling: 5000 ms (5 s)**, unchanged. Nothing measured in
  either data set justifies asking a hook to hold a tool call open
  longer than that, and the interactive finding below argues against
  leaning on the poll at all past a `-p` launch.
- **Verdict (iv), `-p`: bounded, and not felt as a hang.** The retuned
  2 s default is roughly four times the point at which the old 500 ms
  bound was already short on a full-length report (519-524 ms
  overrun), and the retry-and-instruct fallback the ADR designed for
  exactly this case is what carries the remainder: all 6/6 real
  end-to-end runs succeeded on the retry attempt regardless of which
  bound was in force. This is not a contradiction of the original `-p`
  verdict's core claim (a bounded poll, not an unbounded one, is the
  right shape); it is a correction of the SPECIFIC number, now
  anchored to the real-report data instead of the shorter probe
  reports. The real-report lag distribution at n >= 10 is not measured
  here; see the follow-up bullet below.
- **Verdict (iv), interactive: does NOT hold, unchanged.** Section (q)
  found the report unreachable within 5 s in 3/3 interactive runs, and
  the transcript-shape fixture shows why a longer bound would not
  obviously fix it: the assistant's own turn had written zero entries
  to the transcript file by the bound, even though the pane fixture
  confirms the turn had already completed content-wise. No bound
  measured in this round covers the interactive case. Per the ADR's
  own fallback clause ("If no bound satisfies both, this slice
  switches to the launcher-supplied report file"): the
  launcher-supplied report file, bound by hash in the delegation's
  `reportContentHash`, is the intended channel for the interactive
  case rather than the transcript scan; wiring it into the child's
  PreToolUse hook is a named follow-up (the hook does not yet read
  `--report` back, see the pack doc). The `-p` case keeps the bounded
  poll (2 s default, 5 s ceiling) as retuned above.
- **Not measured here: the real-report lag distribution at n >= 10.**
  The real end-to-end runs above are n=6 (a)/(b) first attempts, all
  against the same fixture report; a larger sample of real-report
  first-poll latencies, ideally across report lengths, is a follow-up
  measurement, not something this round's data supports concluding
  further.

## Codex

### Measured: Codex `permission_mode` by launch shape

Codex CLI 0.150.1, Linux/WSL2, captured 2026-08-27
(`dogfood/ug-auto-mode-signals/README.md`, sections k to m; scripts
`codex-capture.sh` and `codex-interactive-capture.sh`; fixtures
`payloads/codex-exec-<shape>.*` and `payloads/codex-tui-<shape>.*`). 14
successful `codex exec` shapes plus the `untrusted` error case, and 11 TUI
shapes over `tmux`.

`permission_mode` follows the effective APPROVAL policy only:
`never` (as a flag, a config key, `--dangerously-bypass-approvals-and-sandbox`,
the TUI's "Full Access" permission profile, or any headless `codex exec`
run without `--approve-for-me`) maps to `bypassPermissions`; `on-request` /
the TUI's "Ask for approval" and "Approve for me" profiles / `--approve-for-me`
map to `default`. `sandbox_mode` (`read-only`, `workspace-write`,
`danger-full-access`) does not change the value in any of the 25 runs.
Observed vocabulary: `bypassPermissions`, `default`; `plan`, `acceptEdits`
and `dontAsk` (in the Codex hooks documentation's vocabulary) were never
produced by any shape exercised here. `approval_policy = "untrusted"` is no
longer accepted in 0.150.1 (`payloads/codex-exec-untrusted.events.jsonl`:
"approval_policy = \"untrusted\" is no longer supported; remove this
setting"), so that value cannot occur.

Payload shape: identical to Claude Code's `PreToolUse` payload (this doc's
Claude Code section above) minus `prompt_id`/`effort`, plus `turn_id`/`model`
(`payloads/codex-exec-default.PreToolUse.json`). It sends `tool_input`, the
same field name the current Claude Code payload uses, not harness's older
portable `raw_input` name.

Hook environment: the hook process's own environment
(`payloads/codex-exec-default.PreToolUse.env.txt`, consistent across all 25
runs) carries only `CODEX_HOME`, `CODEX_MANAGED_BY_NPM`,
`CODEX_MANAGED_PACKAGE_ROOT`, `PWD`, `SHLVL`; there is NO session-id
variable of any name. Consequence: the session-consistency check this doc
relies on for Claude Code (hook-env `CLAUDE_CODE_SESSION_ID` vs payload
`session_id`) has no Codex counterpart at all, since Codex never exposes a
session id to the hook process's environment; a Codex-side design would have
to use the payload's own `transcript_path` (present on disk at hook time,
per shape) instead.

Semantic difference from Claude Code: on Codex, `bypassPermissions` means
"no approval prompts are issued for this call", nothing about sandboxing.
It is produced by every headless `codex exec` shape regardless of
`sandbox_mode`, including `-s read-only` (`payloads/codex-exec-readonly.PreToolUse.json`)
and `-s danger-full-access` alike, and it does not imply the process is
unsandboxed the way Claude Code's `bypassPermissions` implies the
permission system itself is off.

## opencode

### Measured: `--auto` plugin observability

opencode 1.18.18, local Ollama model, captured 2026-08-27
(`dogfood/ug-auto-mode-signals/README.md`, section n;
`dogfood/ug-auto-mode-signals/opencode/`). Five run shapes: `project`
(default permissions) with and without `--auto`; `project-ask`
(`"permission": {"bash": "ask"}`) with `--auto`, without `--auto`, and
under `opencode serve` + a separate `--attach --auto` run.

`--auto` (aliases `--yolo`, `--dangerously-skip-permissions`,
`opencode/binary-context.txt`) is implemented purely client-side: the CLI's
own `permission.asked` handler replies `{reply:"once"}` when its internal
mode is `"auto"`, or otherwise queues a prompt (TUI) or replies
`{reply:"reject"}` (`opencode run` without `--auto`)
(`opencode/binary-context.txt`, the `reply:"once"` excerpt). No config
field, env var, `PluginInput` field, or hook input carries the mode;
`config.permission` in the `config` hook payload is identical with and
without `--auto`, differing only in `argv` (`opencode/diff-a-vs-b.txt`).
The typed `permission.ask` plugin hook does not exist in the installed
1.18.18 binary at all: `count '"permission.ask"': 0`
(`opencode/binary-context-permission-ask.txt`); the real internal events
are `permission.asked` / `permission.replied`, and this probe's plugin
never received either in any of the five runs, because the default
permissions in both scratch projects allow `bash` and no permission was
ever actually asked (`opencode/probe-{a,b,c,d,e-serve}.jsonl`).

Verdict: no decision-grade signal and no hook projection to build on.
Harness's own opencode adapter
(`src/cli/apply/generate-opencode-config.ts`) projects no hooks into the
generated `opencode.json` at all ("hooks -> NOT PROJECTED", documented
no-op in that file's header, unchanged by this measurement), so even if a
decision-grade `--auto` signal existed, nothing in the harness pipeline is
positioned to read it today. Two indirect channels exist for a plugin to
infer `--auto`, and both have a named limit: `process.argv` contains the
literal `--auto` token when the plugin runs in the same process as the CLI
invocation carrying the flag (present in runs a and c; absent in run e,
where the flag belongs to the separate `--attach`ed `run` process rather
than the `serve` process the plugin lives in); and a `permission.replied`
event with `reply: "once"` arriving without a preceding human action would
suggest `--auto`, but that only exists when a permission was actually asked
(none of these five runs triggered one), and even then is
indistinguishable at the plugin level from a human choosing "Allow once" in
the TUI. Out of scope for auto-approval; design note only.

## Signal sources by trust class

| Signal | Origin process | Agent can alter it for the running session? | Evidence | Class |
| ------ | --------------- | -------------------------------------------- | -------- | ----- |
| Hook payload `permission_mode` (Claude Code) | Claude Code CLI process, written into the hook's stdin | No for the running `-p` session (the mode is set at launch by a CLI flag or by `permissions.defaultMode` in a settings file, before the agent runs; interactive sessions can switch mode mid-session by operator action, which is not measured here) | Measured, this doc, in both launch shapes: `-p` (four modes) and an interactive session under `bypassPermissions` (two runs) | decision-grade (harness-process-originated) |
| Hook process env: `CLAUDE_CODE_ENTRYPOINT`, `AI_AGENT` suffix | Claude Code CLI process | No | Measured, this doc | corroboration only |
| Agent's own Bash-tool shell env | Spawned by the agent's own tool call | Yes, in principle (it is the agent's own execution context) | Measured, this doc | untrusted |
| Operator launch env (e.g. shell env when starting `claude`) | Operator | Not for the running session, but any process the agent spawns inherits or overrides it, and at the hook it is indistinguishable from an agent-set variable | Not captured here | unverified (corroboration at most; never a decision input on its own) |
| Manifest opt-in in `harness.yaml` (and, by the same write class, `permissions.defaultMode` in `.claude/settings*.json`) | Repo config, operator-authored | Agent can edit the file post-approval (existing residue class); pre-approval it is gated | Not measured here | corroboration only |
| Agent claim in text (e.g. "I am in auto mode") | Agent output | Yes, fully | n/a | untrusted |
| Codex payload `permission_mode` | Codex CLI process, written into the hook's stdin | Not agent-settable for the running session; derivable from `config.toml`'s `approval_policy` in `$CODEX_HOME` or a trusted project's `.codex/config.toml`, the same operator-owned, post-approval-agent-writable class as Claude Code's `permissions.defaultMode` above | Measured, this doc: 25 runs across `codex exec` (14 shapes) and the TUI (11 shapes) | decision-grade (harness-process-originated), config-derived note: same write class as `permissions.defaultMode`, not the agent-settable-for-the-running-session class the ADR's Codex reopen criterion names |
| opencode `--auto` flag / plugin visibility | opencode CLI process (client-side only; not projected into any hook input) | Yes, in principle, via the two indirect channels named in the opencode section above, neither decision-grade | Measured, this doc: 5 runs; the typed plugin-facing permission hook does not exist in the 1.18.18 binary | indirect only, not decision-grade |

## Unverified / not measured

- Block-and-retry under `-p`: now measured at n=10 per deny text for the
  "no report first" shape ("Measured: retry distribution by deny text"
  above); the earlier 1/3 vs 3/3 split is resolved as sample-size noise,
  not a text effect (20/20 combined retried again unprompted and
  succeeded). Still not exercised: turn budgets other than 6, modes other
  than `bypassPermissions`, deny texts other than the two named there.
- Hook-env `CLAUDE_CODE_SESSION_ID` agreement with the payload
  `session_id` is now measured for two launch shapes whose session id
  Claude Code generated, a `-p` run and an interactive session (2/2). The
  `--session-id`-pinned launch shape was still not exercised, so a design
  that relies on that agreement for a launcher-pinned child rests on an
  untested case.
- Interactive mid-session mode switching (shift+tab through the permission
  modes, or `permissions.defaultMode` changing under a running session):
  not exercised. Each interactive run here was launched with
  `--permission-mode bypassPermissions` and left in that mode.
- Subagents: measured for one subagent type (`general-purpose`), one
  subagent per run, under `-p bypassPermissions`. Nested subagents, an
  interactive parent, and other subagent types were not exercised, and no
  probe here reads the separate agent transcript file for report content.
- Codex: interactive mid-session `/permissions` switching AFTER a tool call
  already ran in the same session (every TUI shape here switched, if at
  all, before the probe's one Bash call); `codex exec` with a pinned
  session id or `--resume`; Codex versions other than 0.150.1 or platforms
  other than Linux/WSL2. `PermissionRequest` never fired in any of the 25
  Codex runs, so its payload shape is unmeasured for Codex (the Claude Code
  section above measured it interactively, section (i); Codex's equivalent
  was never exercised into firing).
- opencode: a human's "Allow once" in the TUI vs `--auto`'s `reply:"once"`
  is, per the opencode section above, indistinguishable at the plugin
  event level; that conclusion rests on reading the event shape
  (`opencode/binary-context.txt`) and on the fact that no run here actually
  triggered a `permission.asked` event, not on a TUI run that compared the
  two side by side. No TUI run was captured for this probe at all (only
  `opencode run` and `opencode serve`).
- `auto` and `dontAsk` values for Claude Code's `permission_mode`, and
  `plan`/`acceptEdits`/`dontAsk` for Codex's: never observed in this
  measurement (Claude Code exercised `default`, `acceptEdits`,
  `bypassPermissions`; Codex exercised `default`, `bypassPermissions`).
- Single machine throughout; two Claude Code versions (2.1.247 for
  sections (a)-(n), 2.1.250 for (o)-(q)), noted where it mattered (the
  interactive startup-driver fix); no cross-OS comparison was made.
- Transcript-visibility lag: measured at finer grain under `-p` (n=10,
  "Measured: lag distribution under `-p`" above) and, separately,
  interactively (n=3, "Measured: interactive lag distribution" above); the
  interactive case did not resolve within the same 5 s bound in any run,
  and no probe here established whether or when it resolves at all past
  that bound (see "Chosen `report_scan.max_wait` default"). Not repeated
  under permission modes other than `bypassPermissions`.
- The interactive probes need the isolated config directory seeded with
  first-run onboarding flags, otherwise the session stops on a login
  screen (README, "Interactive capture"). The seeding is setup, not a
  measured value, but it means the interactive runs were not made against
  a genuinely untouched config directory.
