---
type: overview
title: Understanding gate, auto-mode signal sources (measured)
description: What signals exist for detecting an agent's own permission/auto-approval mode across Claude Code, Codex, and opencode, measured where possible, doc-only where not, with a trust-class table. Covers both launch shapes for Claude Code, headless and interactive, plus how a hook ask resolves in each and what a subagent's tool call looks like to the same hook. The rule and the decision on which signals gate anything live in the ADR, not here.
tags: [understanding-gate, permission-mode, auto-mode, hooks, measurement, trust-boundary]
timestamp: 2026-08-27T18:21:56Z
sources:
  - src/cli/pack/auto-approve-path.ts
  - dogfood/ug-auto-mode-signals/README.md
  - src/cli/pack/hook-pre-tool-use.ts
  - src/cli/pack/hook-bootstrap.ts
  - src/runtime/session-id.ts
  - src/cli/smoke/runner.ts
  - src/cli/session-export/transcript.ts
  - src/cli/apply/generate-opencode-config.ts
  - src/runtime/read-only-bash.ts
  - docs/policy-packs/understanding-before-execution.md
---

# Understanding gate, auto-mode signal sources (measured)

This records what signal sources actually exist for "is this agent running
in an auto-approval mode" across the three adapters, and what each one is
worth as evidence. It is the evidence layer only: which signals, if any,
should be allowed to relax the understanding gate is a decision, and that
decision (with its rationale, its threat model, and its rollout plan)
lives in `docs/decisions/2026-08-27-ug-auto-mode-approval.md`, not here.

## What this records

Measured Claude Code data (`dogfood/ug-auto-mode-signals/`, captured
2026-08-27, Claude Code 2.1.247, macOS), plus doc-only findings for Codex
and opencode where no live capture was taken. Every number below is
derived from the raw files in that dogfood directory; where this doc's
predecessor plan draft disagreed with a raw file, the raw file wins (none
of the numbers below needed correcting against the raw captures).

A second capture wave the same day, on the same machine and version, added
the three shapes the first wave had left open: an interactive (non `-p`)
session, the interactive resolution of a hook `ask`, and a subagent's own
tool call. Those sections say so, and the entries they close have left the
"Unverified / not measured" list.

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
  the gate did not read the field at all.
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

## Codex

Doc-only; Codex is not installed on the measuring machine, no live capture
was taken. learn.chatgpt.com/docs/hooks lists `permission_mode` as a
common input field with the same vocabulary
(`default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`) on
`SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop`.
`transcript_path` may be `null` per that documentation. Whether or how
this value is derived from Codex's own `approval_policy` / `sandbox_mode`
settings is not documented there and was not otherwise verified.

## opencode

Doc-only. opencode's `--auto` flag (available on both the TUI and
`opencode run`) auto-approves everything not explicitly denied. The
plugin surface exposes `tool.execute.before` / `tool.execute.after` hooks
and `permission.asked` / `permission.replied` events. Harness's own
opencode adapter (`src/cli/apply/generate-opencode-config.ts`) projects no
hooks into the generated `opencode.json` at all ("hooks -> NOT PROJECTED",
documented no-op in that file's header), so today nothing in the harness
pipeline could read an opencode-side auto-mode signal even if one existed.
Whether an opencode plugin can itself observe that `--auto` is active for
the running session is unverified.

## Signal sources by trust class

| Signal | Origin process | Agent can alter it for the running session? | Evidence | Class |
| ------ | --------------- | -------------------------------------------- | -------- | ----- |
| Hook payload `permission_mode` (Claude Code) | Claude Code CLI process, written into the hook's stdin | No for the running `-p` session (the mode is set at launch by a CLI flag or by `permissions.defaultMode` in a settings file, before the agent runs; interactive sessions can switch mode mid-session by operator action, which is not measured here) | Measured, this doc, in both launch shapes: `-p` (four modes) and an interactive session under `bypassPermissions` (two runs) | decision-grade (harness-process-originated) |
| Hook process env: `CLAUDE_CODE_ENTRYPOINT`, `AI_AGENT` suffix | Claude Code CLI process | No | Measured, this doc | corroboration only |
| Agent's own Bash-tool shell env | Spawned by the agent's own tool call | Yes, in principle (it is the agent's own execution context) | Measured, this doc | untrusted |
| Operator launch env (e.g. shell env when starting `claude`) | Operator | Not for the running session, but any process the agent spawns inherits or overrides it, and at the hook it is indistinguishable from an agent-set variable | Not captured here | unverified (corroboration at most; never a decision input on its own) |
| Manifest opt-in in `harness.yaml` (and, by the same write class, `permissions.defaultMode` in `.claude/settings*.json`) | Repo config, operator-authored | Agent can edit the file post-approval (existing residue class); pre-approval it is gated | Not measured here | corroboration only |
| Agent claim in text (e.g. "I am in auto mode") | Agent output | Yes, fully | n/a | untrusted |
| Codex payload `permission_mode` | Codex CLI process (per Codex hook docs) | Not documented; no live capture | Doc-only, this doc | unverified |
| opencode `--auto` flag / plugin visibility | opencode CLI process | Not documented whether a plugin can read it | Doc-only, this doc | unverified |

## Unverified / not measured

- Block-and-retry under `-p`: one deny text, one turn budget (6), one
  mode; two independent 3-run samples disagree on the unprompted third
  attempt (1/3 vs 3/3), so no rate is claimed for it.
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
- Codex live payload values and the approval_policy/sandbox_mode to
  permission_mode mapping: doc-only, no installation available on the
  measuring machine.
- Whether an opencode plugin can observe `--auto`: doc-only, unverified.
- `auto` and `dontAsk` values for `permission_mode`: never observed in
  this measurement (only `default`, `acceptEdits`, `bypassPermissions`
  were exercised).
- Single machine, single Claude Code version (2.1.247, macOS): no
  cross-version or cross-OS comparison was made.
- Transcript-visibility probe: n=5, all under `bypassPermissions`; not
  repeated under other modes, and not repeated interactively.
- The interactive probes need the isolated config directory seeded with
  first-run onboarding flags, otherwise the session stops on a login
  screen (README, "Interactive capture"). The seeding is setup, not a
  measured value, but it means the interactive runs were not made against
  a genuinely untouched config directory.
