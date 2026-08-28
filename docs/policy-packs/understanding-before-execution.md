# Policy Pack: `understanding-before-execution`

> **Status:** shipped and live. The pack is default-enabled in every init template except `minimal` (`full`, `solo`, and `team`), runtime enforcement runs through the pack's PreToolUse blocker (`harness pack hook pre-tool-use`), and `harness apply`, `harness doctor`, and `harness approve understanding` all honour it (Phase 6 released; see [`ROADMAP.md`](../ROADMAP.md#phase-6-understanding-gate-policy-pack)).

## What this pack does

Forces an agent to expose its task interpretation, an *Understanding Report*, before any write-capable tool fires. The user confirms, corrects, or "grills" the understanding until it is precise enough. Only after explicit human approval is recorded as evidence may the agent edit files, run shell commands, commit, push, or open PRs.

The motivating failure mode: an agent reads a task, picks an interpretation, and starts editing. The user notices three commits in that the scope is wrong. The Understanding Gate cuts this off at the point of interpretation, not at code review.

Long-form design and rationale: [`lava-ice-logs/2026-04-30/harness-pre-execution-understanding-integration.md`](https://github.com/LanNguyenSi/lava-ice-logs/blob/master/2026-04-30/harness-pre-execution-understanding-integration.md).

## How it works

```
User prompt
    │
    ▼
UserPromptSubmit hook        (from @lannguyensi/understanding-gate)
    │  injects the Understanding-Gate instruction template
    ▼
Agent emits an Understanding Report
    │
    ▼
Stop hook persists report     (from @lannguyensi/understanding-gate)
    │  → .understanding-gate/reports/<iso>-<slug>-<hash>.json
    ▼
Human reviews and approves
    │  via `harness approve understanding`  (Phase 6 #4, shipped)
    │  writes approval marker: harness.generated/.approvals/${SESSION_ID}
    │  flips approvalStatus=approved on the persisted report
    │  also writes ledger tag understanding-approved:${SESSION_ID} (audit only)
    ▼
PreToolUse hook               (Phase 6 #4, shipped; harness-side blocker)
    │  consults the signed approval marker (the persisted report is evidence only)
    │  passes for Edit / Write / Bash / commit / push / PR creation
    ▼
Agent executes
```

### Read-only Bash bypasses this blocker without an approved report — deliberate, and widening

The PreToolUse blocker admits a provably read-only Bash command or `|`-pipeline
(`isReadOnlyBashPipeline` in `src/runtime/read-only-bash.ts`) WITHOUT an
approved Understanding Report — the same shared classifier that gives the
Risk Classifier its built-in read-only floor (`docs/risk-gate.md`, "Built-in
read-only commands"). This is intentional, not an oversight: open task
`f28d9071` ("read-only Bash vor Approval nicht pauschal als write-capable
blocken") asks for exactly this relaxation, and `git status`/`git diff`/`git
fetch`/`git ls-remote` and the read-only `gh` verbs (`view`, `list`, `diff`,
`checks`, `status`) already bypassed this gate before task `fb67b402` widened
the shared classifier to additionally recognize `cd` (pure navigation form
only) and a curated npm read-only subcommand set — `ls` / `list`, `view` /
`info` / `show`, `outdated`, `why` / `explain`, `ping`, and `npm audit` /
`npm audit signatures` (never `npm audit fix`, whose mutating tail is
detected by a positive shape, not a denylist, so shell-quoting cannot
launder it through). `cd`, `npm audit`, and `npm ls` now also pass this hard
gate pre-approval, exactly as `git status` already did.

**Consciously accepted residual: a pre-report NETWORK READ.** `git fetch`
and `gh <noun> view/list/checks/status` already made a live network call
before this pack's approval gate ever engaged; widening the same floor to
`npm audit` / `npm ls` / `npm view` / `npm outdated` continues that same
class of residual (an outbound registry round-trip, not a local write or a
git-state mutation) rather than introducing a new one. What the floor
refuses, in both the old and the widened form, is letting any of these
commands smuggle a WRITE: shell chaining, redirection, and command
substitution all still forfeit the read-only classification and fall back
to requiring an approved report, and an npm invocation carrying an
untrusted `--registry` / `--userconfig` / `--globalconfig` flag forfeits it
too (`docs/risk-gate.md` has the exact rules and the quoting-bypass
analysis for `npm audit fix`).

## Requirements

- `@lannguyensi/understanding-gate@>=0.2.0` available on PATH (the package ships `understanding-gate-claude-hook`, `understanding-gate-claude-stop`, `understanding-gate-claude-pre-tool-use`, plus the `understanding-gate` CLI). The package owns templates, parser, schema, persistence, and the minimal standalone PreToolUse blocker. Harness owns ledger glue, permission profiles, doctor wiring.
- An evidence ledger reachable via `grounding-mcp` (per [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §6) when running in *ledger-canonical* mode (the default for harness users). Solo users without harness can still run the pack against the persisted JSON file alone.

## Manifest reference

```yaml
policy_packs:
  - name: understanding-before-execution
    source: builtin           # default; resolves to the bundled pack definition
    enabled: true             # default
    description: "..."        # optional, falls back to the pack's own description
    config:
      mode: grill_me          # fast_confirm | grill_me | strict
      ux:                     # optional; agent-facing block message (v0.17.0+)
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)"
          - "Run `harness approve understanding` and approve the prompt"
```

### `config.ux`

Optional. When set, both PreToolUse pack hooks (`hook-pre-tool-use.ts` for Claude Code, `hook-codex-pre-tool-use.ts` for Codex) render the agent-facing `{ cannot, required, run }` shape in place of the legacy `Understanding Gate: ...` envelope. The engine-vocabulary BLOCK reason (naming session id and which approval sources failed) stays on stderr for operator audit. Reuses `PolicyUxSchema` from the policy layer; malformed configs fall back to the legacy envelope with a stderr warning.

`${SESSION_ID}` is the typical substitution variable for this pack; `cannot` / `required[]` / `run[]` strings are otherwise plain text. The `init --template solo / team / full` and Custom-composer paths all ship the `ux:` default shown above so wizard users get the plain-language form out of the box (v0.17.1+).

When `config.ux` is set, `config.producers` (the `ask` / `bash` recipes shipped on the pack) is suppressed on the agent surface for the same reason it is suppressed on policies: the `run:` list is the canonical remedy, and showing both would give the agent two different command suggestions for the same block. `producers` still feeds `harness explain --trace`.

Full reference for the verbatim three-section form, `${VAR}` substitution context, and the agent / operator surface split: [`docs/for-agents.md`](../for-agents.md#agent-facing-block-messages-ux-block).

### Refreshing `config.ux` after a harness upgrade (`harness pack reseed`, task `68b9ad9c`)

`config.ux` is captured into `harness.yaml` once, at `harness init` time (or whenever `harness pack add` seeds it). A later harness release can improve the shipped wording — for example the heredoc submission form the `run:` line above teaches, added after some manifests had already been generated with the older bare-command wording — but `harness apply` only ever projects the manifest OUT to `settings.json`; it never reads a fix back INTO an already-installed manifest's `config.ux`. Without an explicit step, an operator who installed before a wording fix keeps seeing the stale deny message indefinitely, even after upgrading the `harness` CLI itself.

Two verbs close that gap:

- **`harness doctor`** warns when an enabled pack's `config.ux` (or `config.producers`) textually diverges from the CLI's shipped default for that pack (compared against the pack's own configured `mode`, not a hardcoded one — a `strict`-mode manifest is compared against `strict`'s wording). The warning names the pack and points at the fix. A pack that never declared `config.ux` at all is not flagged by this check — that is the separate, pre-existing "no `ux:` declared, falls back to the legacy envelope" case, not a stale copy of the shipped text.
- **`harness pack reseed <name>`** pulls the shipped default `config.ux` (and `config.producers`, for packs that ship one) into the manifest, leaving every other key on the pack entry — `mode`, `approval_lifecycle`, `permission_profile`, `min_version`, ... — untouched. Run `harness pack reseed <name> --dry-run` first to review the exact diff; the bare command writes it. A pack whose `config.ux` already matches the shipped default is a no-op (nothing to write). Reseed also seeds `config.ux` for a pack that never declared one, since running the verb is itself the operator's explicit request.

```console
$ harness doctor
...
Policy Packs
  ⚠ understanding-before-execution.config.ux  pack "understanding-before-execution" config.ux diverges from the shipped builtin template; a supported update exists. Review with `harness pack reseed understanding-before-execution --dry-run` and apply with `harness pack reseed understanding-before-execution`.

Note that the warning is scoped to `config.ux`, but applying `reseed` also seeds or updates `config.producers` where the pack ships one — the `--dry-run` diff shows the full set of fields the write would touch.

$ harness pack reseed understanding-before-execution --dry-run
--- current
+++ proposed
...
$ harness pack reseed understanding-before-execution
reseeded config.ux, config.producers for policy_packs entry "understanding-before-execution" in ~/.harness/harness.yaml
```

`reseed` is deliberately explicit-only: it is never invoked by `apply`, `doctor`, or any automatic path, so an operator's own deliberate customisation of `config.ux` (a house style for the deny message, a stricter `required:` line, ...) is never silently overwritten by an upgrade — the same reasoning `harness adopt` exists for in the opposite direction (on-disk hand-edits flowing back into the manifest). If the CLI's own comparison says a declared `config.ux` "diverges", that only means it textually differs from the shipped default; it does not distinguish "predates a fix" from "operator customised" — review the `--dry-run` diff before running the write.

### `config.mode`

| Mode | Friction | When the gate fires |
|---|---|---|
| `fast_confirm` | low | Only on prompts the classifier recognises as execution-relevant. Brief Understanding Report; one-line approval. |
| `grill_me` | medium (default) | On any prompt that the agent might respond to with a write. Full Understanding Report (assumptions, openQuestions, outOfScope, risks, verificationPlan). User is encouraged to push back. |
| `strict` | high | On every prompt. Report must include `verificationPlan` and `outOfScope`; `requiresHumanApproval` is forced to `true`. |

The mode lives under `config:` rather than at the top level because it is pack-specific. Other packs will define their own `config:` shape.

#### Mode resolution and enforcement (harness task `5d73d78d`)

Before this task, `config.mode` only drove prose: the audit-copy
`instructions.md` and `harness doctor`'s UX-drift comparison read it
correctly, but the ACTUAL enforcement never received it:

- The Claude-runtime `UserPromptSubmit` injector and `Stop` capture are bins
  shipped by `@lannguyensi/understanding-gate`
  (`understanding-gate-claude-hook` / `understanding-gate-claude-stop`).
  Harness invoked them bare — no `UNDERSTANDING_GATE_MODE` env var — so the
  package's own resolver (env → `/grill` prompt marker → default
  `fast_confirm`) always fell through to its default, regardless of
  `config.mode`.
- `harness approve understanding`'s stdin-heredoc capture path
  (`persistStdinReport`) filled in a report's missing `mode` field with a
  hardcoded `"fast_confirm"` literal, also independent of `config.mode`.

A `config.mode: grill_me` manifest therefore validated agent reports as
`fast_confirm` in practice — `derivedTodos` / `acceptanceCriteria` /
`priorArt` were never enforced — while `instructions.md` and `harness
doctor` both reported `grill_me` as if it were in effect.

**Two resolvers, two different contracts — not one.** A first fix round
routed every consumer through a single env-aware resolver; a review
fix-round split it in two, because that single resolver let an operator's
*ambient* shell state leak into artefacts that must only ever reflect
`harness.yaml`:

| Resolver | Priority | Used by |
|---|---|---|
| `resolveModeFromConfig()` | `config.mode` > default (`grill_me`) — **never reads the env var** | The GENERATION path: `resolve()`/`buildHooks` (what `harness apply` bakes into `settings.json` and `instructions.md`), and `resolveBuiltinDefaultConfig()` in `registry.ts` (`harness doctor`'s UX-drift comparison, `harness pack reseed`). |
| `resolveMode()` | `UNDERSTANDING_GATE_MODE` env var > `config.mode` > default (`grill_me`) | LIVE runtime consumers that resolve at invocation time, with the real process environment available: `harness approve understanding`'s stdin-report gap-fill (`approve/understanding.ts`), and the Codex `UserPromptSubmit` injector (`harness pack hook codex-user-prompt-submit`). |

The env var name (`UNDERSTANDING_GATE_MODE`) is the same one
`@lannguyensi/understanding-gate` reads on its own (its "ENV wins because
operators set it consciously" rule) — harness does not invent a second
name for the same concept. Why generation must NOT read it: `harness
apply`/`harness pack reseed` write an artefact that then persists,
frozen, until the NEXT apply/reseed. If that write depended on whatever
happened to be exported in the operator's shell at that moment, the
artefact would drift from `config.mode` the instant the shell's env
changed — silently reopening the exact class of bug this task closes, one
layer up, and making `harness doctor` flag false "drift" purely because
of ambient state. Live consumers are different: `approve understanding`
and the Codex injector run once, at the moment they are invoked, with the
real environment in front of them, so honoring a one-off
`UNDERSTANDING_GATE_MODE=... harness approve understanding` override is
exactly the intended, momentary escape hatch.

`buildHooks` (the generation path) still bakes the resolved mode into the
two npm-backed Claude bin commands via the same env-var *name*
(`wrapMode`) — but the *value* baked in is `resolveModeFromConfig`'s
config-only result, frozen at apply time, and the prefix is **omitted
entirely** when that resolved mode already coerces to the package's own
default (`fast_confirm`). Baking it unconditionally (the first round's
behavior) made the package's own in-prompt `/grill` / "grill me"
per-prompt escalation marker permanently dead: the package's own
resolver (`pickMode`) checks its env var FIRST and returns before ever
reaching the marker check, so a permanently-set
`UNDERSTANDING_GATE_MODE=fast_confirm` silently defeated the one
per-prompt escalation mechanism the package ships. Omitting the prefix
when the effective mode is already `fast_confirm` changes nothing about
the outcome (the package already defaults to `fast_confirm` on its own)
while restoring the marker's liveness on a `fast_confirm`-effective host;
a `grill_me`/`strict`-resolved mode still gets the unconditional prefix.

**Doctor advisory for a diverging env override (task `24abdecb`).**
Because the env var only feeds the LIVE runtime path, an operator who
carries `UNDERSTANDING_GATE_MODE` in their shell profile (rather than
setting it inline for a one-off command) silently downgrades live
enforcement relative to what `harness.yaml` declares, with nothing to
flag the drift. `harness doctor` now warns (advisory, never an error —
the env override is a legitimate, documented mechanism, not a
misconfiguration) whenever `UNDERSTANDING_GATE_MODE` is set and diverges
from `policy_packs[understanding-before-execution].config.mode`, naming
both values so the operator can see at a glance which mode is actually
being enforced. This check is agent-unreachable by design (it only
reads the operator's own process environment) and renders in doctor's
`Environment` section. It only fires when the pack itself is declared
AND enabled: a pack that never runs has no live enforcement for the env
var to downgrade, so there is nothing to warn about.

**Rejection enforcement.** `harness approve understanding`'s stdin-report
path also now genuinely REFUSES the approval marker when the submitted
report is rejected under the resolved mode (e.g. a `fast_confirm`-shaped
report submitted against a `grill_me`-configured host) and no report
matching this session id exists — no marker, no ledger tag, no report
flip, unless `--force` (mirroring the pre-existing
`priorArt`-content-validation short-circuit; a forced bypass is stamped
`:forced:stdinReport` into the ledger tag for audit). The first fix round
resolved the correct mode but still wrote the marker in this case: a
rejected submission with no fallback report fell through to a `{ skipped:
true }` validation outcome rather than `ok: false`, so the enforcement
short-circuit never triggered. A second review round then found that
"matching this session id" also had to exclude the sessionId-null
tolerant fallback's adoptions: a rejected submission with only a fresh,
unrelated, sessionId-less leftover report on disk was silently riding on
that leftover's already-valid content and getting it stamped with the
live session's id — the guard now treats a fallback-adopted report the
same as no report at all.

**Upgrade note — corrected blast radius.** The mode actually enforced now
matches `config.mode` in all three possible cases, not only the one the
first round's changelog entry called out:

- `config.mode: fast_confirm` — was already effectively `fast_confirm`;
  unaffected except for the marker-liveness fix above.
- `config.mode: grill_me` / `strict` — now genuinely enforced; was
  silently `fast_confirm`.
- **No `config:` block at all, or a `config:` block with no `mode:`
  key** — now genuinely enforced at `grill_me` (the package default).
  This is the WIDEST blast radius of the three, and the one the first
  round's upgrade note did not mention: every unconfigured host is
  affected, not only hosts with an explicit non-`fast_confirm` setting.

For any host in the latter two buckets, previously-accepted reports
missing `derivedTodos` / `acceptanceCriteria` / `priorArt` are now
rejected until the agent supplies them. This is a real behavior change
for such hosts, not a bug in the fix: it closes the gap between the
declared (or default) config and what was actually running.

`strict` has no upstream equivalent — `@lannguyensi/understanding-gate`'s
own mode type is two-valued (`fast_confirm` | `grill_me`). Where the
resolved mode must cross into the package (the env var, and the
stdin-heredoc gap-fill), `toPackageMode()` coerces `strict` to `grill_me`
(the closest available rigor); this does not change what `strict` means
inside harness itself (`modeFriction`, `understandingApprovalRequirement`
are untouched).

### Source

`source: builtin` resolves to the pack definition that ships with harness itself. Future values (`path:./packs/foo`, `npm:@scope/pack@1.2.3`, `git:https://...`) are reserved for community-authored packs and are **not** part of the v1 vocabulary; they parse as an opaque string today and will gain dedicated resolution in Phase 6 #3 (the `harness pack add` validate-on-write step) or later.

### Config schema

Since task `d78fb3c7`, the pack's `config:` block is validated by `harness validate` and `harness doctor` against a strict zod schema. Typo'd keys (`permision_profile` instead of `permission_profile`) and bad enum values (`mode: fastConfirm` instead of `mode: fast_confirm`) now fail at lint time instead of silently falling back to the default at runtime. The accepted keys are:

| Key | Type | Notes |
|---|---|---|
| `mode` | enum `fast_confirm` / `grill_me` / `strict` | default `grill_me` |
| `permission_profile` | enum `safe-start` / `implementation-after-approval` / `high-risk-grill-me` | optional; see the table above |
| `approval_lifecycle.mode` | literal `session` | optional; opts out of the PostToolUse marker-expiry hook |
| `approval_lifecycle.expire_on_tool_match` | array of tool-name strings | optional override for the default agent-tasks tool list |
| `approval_lifecycle.expire_on_bash_match` | array of regex strings | optional; clear the marker when a Bash call matches any of these (gh-cli workflows); see "expire_on_bash_match: start-anchored, with a documented fail-open limitation" below for the shipped defaults' known gap |
| `approval_lifecycle.max_age` | duration string (`1h`, `30m`, ...) | optional safety net for sessions that never hit a listed tool / Bash boundary |
| `auto_approve.when` | array of permission-mode strings | optional; allowlist of `permission_mode` values eligible for a hook-written signed auto-marker |
| `auto_approve.harnesses` | non-empty array of `claude-code` / `codex`, no duplicates | optional; which runtimes' PreToolUse hooks may take the auto path. Absent means `[claude-code]` |
| `auto_approve.require_report` | literal `true` | required when `auto_approve` is present; `false` or missing is a schema error |
| `ux` | `PolicyUxSchema` (`cannot` + `required[]` + `run[]`) | optional; renders agent-facing remediation when the PreToolUse blocker fires |
| `producers` | array of `ProducerSchema` (`kind` + recipe) | optional; companion to `ux:` for the same blocker render path |

Any other top-level key is rejected as a typo. New keys land in this schema (`src/policy-packs/builtin/understanding-before-execution.ts`) first, then in the pack's runtime resolver.

### `auto_approve`: opt-in auto-approval for a listed permission mode

`auto_approve` lets an operator opt a specific permission mode into a hook-written, signed auto-marker instead of a human `harness approve understanding` call. It is a rule-only opt-in: the PreToolUse hook still requires a pending Understanding Report for the session and writes the marker through the same signing path a human approval uses. See `docs/decisions/2026-08-27-ug-auto-mode-approval.md` for the full design, the auto path's decision-order placement, and its threat model.

Which runtimes the opt-in covers is a separate, explicit key: `auto_approve.harnesses` lists the harnesses whose PreToolUse hook may take the auto path at all, and an absent key means `[claude-code]`. Codex must therefore be named (`harnesses: [claude-code, codex]`, or `[codex]` alone) before a Codex session can auto-approve anything; an `auto_approve` block that predates the Codex hook keeps exactly the meaning it had, and widening it to a second runtime stays a visible config edit rather than a side effect of both hooks sharing one code path. An empty array, an unknown value, a duplicate entry, or a non-array is a schema error, and the runtime parser treats the same shapes as "not opted in" rather than defaulting.

Both PreToolUse hooks, Claude Code's `harness pack hook pre-tool-use` and Codex's `harness pack hook codex-pre-tool-use`, run the same `auto_approve` attempt at the same point in their decision order and against the same `when` block; only the minted marker's `approvedBy` prefix differs (`auto-mode:claude-code:<mode>` vs `auto-mode:codex:<mode>`), because the two runtimes hand the attempt different session-consistency evidence: Claude Code's hook environment carries `$CLAUDE_CODE_SESSION_ID`, while Codex exports no session-id environment variable to hook processes at all, so the Codex attempt is instead checked against the payload's `transcript_path` (the file's own name must carry the session id, and the file must exist on disk). On Codex, an allowlisted `bypassPermissions` covers every shape where the effective approval policy issues no prompts at all (`never`, `--dangerously-bypass-approvals-and-sandbox`, the Full Access profile, and any headless `codex exec` run without `--approve-for-me`) regardless of sandbox mode; a sandboxed, read-only headless run still reports `bypassPermissions` if it prompts for nothing. This differs from Claude Code, where `bypassPermissions` means the permission system itself is off. On-request shapes on Codex report `default`. See `docs/okf/understanding-gate-auto-mode-signals.md` for the measured evidence behind this.

A literal listed in `auto_approve.when` must be one that a checked-in dogfood fixture shows some harness actually emitting; the measured set lives in the registry module `src/policy-packs/builtin/understanding-before-execution/measured-permission-modes.ts` and `harness validate` rejects any other literal at lint time (`checkUnderstandingBeforeExecutionAutoApproveMeasured`, `src/cli/validate/checks.ts`).

Recommended shape:

```yaml
auto_approve:
  when: [bypassPermissions]
  harnesses: [claude-code] # add `codex` to opt that runtime in as well
  require_report: true
```

Only list a mode in `when` that the operator actually intends to run unattended; `plan`, `auto` and `dontAsk` are not supported values here and should not be listed (nor are they in the measured registry above, so `harness validate` rejects them anyway). Because report validation strength is mode-dependent, pair `auto_approve` with `mode: grill_me` so the report the auto path consumes was actually checked, rather than merely present. `harness doctor` warns when `auto_approve` is configured and the resolved effective mode is not `grill_me` (agent-tasks `abfad738`); a manifest that skips this pairing does not do so silently. A missing `config.mode` resolves to the `grill_me` default and does not trigger this warning. A session-level `UNDERSTANDING_GATE_MODE` override that diverges from the resolved `config.mode` is a separate gap, already covered by the mode/env divergence advisory line above, not by this check.

When `harnesses` lists `codex`, `harness doctor` (and `harness doctor --target codex`) additionally warns if `$CODEX_HOME/config.toml` or `<repo>/.codex/config.toml` sets `approval_policy = "never"` or a full-access `default_permissions` selection; either key pre-sets the trusted `permission_mode` signal the Codex auto path consumes for every session. `approval_policy = "never"` is the measured signal (`dogfood/ug-auto-mode-signals/README.md`, section (l): `tui-config-never` reports `bypassPermissions` where the comparable `tui-default` shape reports `default`); the full-access `default_permissions` check is a threat-model heuristic on a key the operator can set, not a measured signal: section (k) shows this key does not actually move `permission_mode` under `codex exec` (`config-perm-fullaccess` and `config-perm-readonly` both report `bypassPermissions`), and section (l) has no `default_permissions`-via-`config.toml` row at all. The scanner reads only ROOT-LEVEL keys (bare or quoted, e.g. `approval_policy = ...` or `"approval_policy" = ...`); a profile-scoped setting under `[profiles.<name>]` is not detected today. Every warning line carries a constant suffix noting harness keeps no apply-time snapshot of the operator's Codex config, so the line reports presence, not "appeared since the last apply" (unlike the Claude Code settings-drift line below, there is no baseline to diff against for this file). This is the Codex counterpart of the `permissions.defaultMode` / hook-roster settings-drift warning `harness doctor` already prints for Claude Code (threat model (c) in the auto-mode ADR); it stays a warning, never a block, and is silent for a repo that never opted Codex into `auto_approve`.

### `expire_on_bash_match`: start-anchored, with a documented fail-open limitation (task `fb80b5bb`, measured 2026-08-19)

The shipped `SOLO_TEMPLATE` / `TEAM_TEMPLATE` / `FULL_TEMPLATE` defaults (and the interactive Custom composer's, see "Closed gap" below) for `approval_lifecycle.expire_on_bash_match` are, and remain:

```
^gh pr (merge|close)\b
^git push origin (master|main)\b
```

These two patterns are **deliberately `^`-anchored**: they match only at
the start of the Bash command string, not anywhere inside it.

**Known fail-open forms.** Because the anchor sits at command start, a
boundary command behind a common shell prefix, or with a flag inserted
between its own words, does not expire the marker — the approval stays
valid past the real merge/push until `approval_lifecycle.max_age`
finally catches up. Measured misses, several of them everyday shapes
rather than deliberate evasion:

- `cd repo && gh pr merge 42` (leading `cd <dir> &&`)
- `GH_TOKEN=x gh pr merge 42` (env-var assignment prefix)
- `(gh pr merge 42)` (subshell parens)
- `git -C repo push origin main`, `git -c user.name=x push origin main` (a flag inserted between `git` and `push`)
- `git push --force origin main`, `git push -u origin main` (a flag inserted between `push` and `origin`)
- `git push origin HEAD:main` (a refspec instead of a bare branch name)
- `gh --repo owner/repo pr merge 42` (a flag inserted between `gh` and `pr`)
- doubled/irregular whitespace between tokens (the pattern's literal single space does not tolerate it)

`approval_lifecycle.max_age` (`1h` on `SOLO_TEMPLATE`, `4h` on
`TEAM_TEMPLATE`/`FULL_TEMPLATE`) is the named safety net for all of the
above: a miss here is bounded, not unbounded.

**Why this stays anchored instead of being widened.** A first attempt on
this branch (task `fb80b5bb`) widened both patterns to a `\b`-scoped,
un-anchored version (never released) to close the fail-open forms
above. A follow-up review measured that change end-to-end against the
real PostToolUse hook and found it made things worse, not better:

- The `harness approve understanding <<'RPT' ... RPT` approval flow
  became self-revoking under the widened patterns: the report body
  legitimately quotes a boundary command as part of the stated plan
  (e.g. "then run `gh pr merge 42`"), so the SAME Bash call that writes
  the freshly-approved marker also matches the widened pattern and
  expires it — flipping the persisted report to `expired` in the same
  breath it was approved. Recovery from that state is operator-only,
  which is worse than the fail-open gap the widening was meant to
  close.
- At least 8 everyday false positives were observed during the round-2
  review probe (corpus not retained) — `grep`/`echo` invocations that
  quote a boundary command, and commit messages that mention one in
  prose, all expired the marker with nothing actually merged or pushed.
- Even widened, at least 20 fail-open forms were still observed
  uncaught in that same probe (corpus not retained) — further
  prefix/flag placements, quoting, and shell-obfuscation shapes — so the
  widening did not close the class of gap, it only moved it, while
  adding the self-revocation regression on top.
- A scoped exemption via `isEscapeCommand` (to let the approve-heredoc
  bypass its own trigger) was considered and rejected: it imports a
  documented divergence class (4 prior halts) into a new consumer, and
  any further widening variant without real shell-awareness keeps
  re-hitting the same heredoc/quoted-text shape.

Closing this class of miss for real needs shell-aware command matching
(distinguishing an executed command from quoted/heredoc text,
understanding shell word-splitting well enough to see past inserted
flags and prefixes). That is the same open design question already
tracked for command-matching in general in
`docs/okf/quote-model-divergence.md` — this task does not attempt to
solve it here; `approval_lifecycle.max_age` remains the intended
mitigation until it is.

Pinned against the actual shipped regexes (not hand-copied literals) by
the `"expire_on_bash_match: anchored-pattern behavior (task fb80b5bb,
round 2)"` describe block in `tests/cli/init-full-template-pins.test.ts`
— positive matches, the documented known-miss forms, and the documented
false-positive-avoidance forms are all pinned there, so a future edit
that re-widens the anchor without updating this section reddens.

**Closed gap: the interactive custom profile (task `90eae119`).**
`harness init --interactive`'s composer (`src/cli/init/composer.ts`, the
`understanding-before-execution` branch of `composeCustom()`) used to set
`approval_lifecycle.expire_on_tool_match` and `max_age` but never set
`expire_on_bash_match` at all — a session built through the interactive
composer had NO Bash-boundary expiry whatsoever, relying solely on
`max_age` and the tool-match list. This was a pre-existing oversight from
the same sweep that introduced `expire_on_bash_match` on
SOLO_TEMPLATE/TEAM_TEMPLATE/FULL_TEMPLATE (task `f54e0ecb`, PR #181), not a
deliberate design choice. Closed by task
`90eae119-cb77-4941-975c-7d2930e685d8`: the composer now emits the same
`expire_on_bash_match` patterns TEAM_TEMPLATE/FULL_TEMPLATE ship (Custom
already matched their `expire_on_tool_match` list and `max_age: 4h`, so it
inherits their Bash boundary too), with the same anchored-pattern and
fail-open limitations documented above; this change adds no shell-aware
matching. Pinned in `tests/cli/init-composer.test.ts` (the composed
manifest's `approval_lifecycle` carries `expire_on_tool_match`,
`expire_on_bash_match`, and `max_age` matching TEAM/FULL), so a future edit
that drops or narrows this list turns that pin red rather than drifting
silently.

### Pack-level `min_version` (task `bd154095`)

`policy_packs[].min_version` is an optional floor on the canonical package-side bin (`understanding-gate --version`). `harness doctor` probes that version and renders a warning when the installed binary is below the floor: the pack still runs in degraded mode; only `config:` keys that require the newer release are silently ignored. The hook-level `min_version` on the pack-emitted Hook entries covers each individual hook command; this pack-level floor catches a `config:`-schema-vs-runtime gap that no single hook can express.

```yaml
policy_packs:
  - name: understanding-before-execution
    source: builtin
    min_version: 0.25.0    # require the --task variadic flag (v0.25.0+)
```

Missing `min_version` is silent (legacy manifest). Warn-not-error: doctor's `warningCount` increments, `errorCount` does not.

### Prior Art is required by the Stop-capture parser (`@lannguyensi/understanding-gate@0.4.0+`)

`@lannguyensi/understanding-gate@0.4.0` (filed from harness task `798d7173`, agent-grounding PR #85) adds a required 10th section, "Prior Art", to the Understanding Report contract:

- In `grill_me` / full mode: a report missing or with an empty Prior Art section is rejected by the Stop-capture parser with `schema_violation` / `missing: ["priorArt"]`. The agent must state what channels were checked for an existing solution (web, package registries, MCP directories, the org's own repos, the project's existing modules), the closest existing tool or pattern found, and an explicit "adopt" / "extend" / "build new" judgment with a reason.
- In `fast_confirm` mode: Prior Art is NOT required. The five-bullet shape (currentUnderstanding, intendedOutcome, outOfScope, verificationPlan, assumptions) does not carry it. The failure class this section guards against (multi-turn build of an unnecessary tool) is intrinsically a grill_me / full situation.
- Origin: `pattern-scout` 2026-05-22, a ~5000-line agent-dx package that shipped before anyone noticed `opensrc-mcp` already solved the problem better. The existing nine sections all framed the task as given; none forced the question "should this be built at all?".

The pack's hook-level `min_version` floor on the npm-backed bins (`UG_MIN_VERSION` in the pack source) is bumped to `0.4.0`. `harness doctor` flags installs below it via its "Policy-pack hooks" section (task `ab634898`); earlier releases declared this floor but doctor never actually probed a pack-expanded hook against it, so a below-floor install produced a clean report until that task shipped. Operators on 0.3.x produce reports that pre-0.4.0 parsers accept silently; on 0.4.0+ the section is enforced.

## Suggested permission profiles (Phase 6 #5)

Three reference profiles ship as Phase 6 #5 builtins. Select one via the pack's `config.permission_profile`:

```yaml
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      permission_profile: safe-start    # or implementation-after-approval / high-risk-grill-me
```

`harness apply` translates the active profile into Claude Code's `permissions: { allow, ask, deny }` block in the generated `settings.json`. Action keys map to tool patterns at translate time:

| Action | Patterns emitted into settings.json |
|---|---|
| `read` | `Read`, `Glob`, `Grep` |
| `edit` | `Edit`, `Write`, `MultiEdit` |
| `bash` | `Bash` |
| `commit` | `Bash(git commit*)` |
| `push` | `Bash(git push*)` |
| `pr` | `mcp__agent-tasks__pull_requests_create`, `Bash(gh pr create*)` |
| `deploy` | `Bash(kubectl*)`, `Bash(terraform destroy*)`, `Bash(npm publish*)` |

`allow:` enum:

- `true` and `false` map to `permissions.allow` and `permissions.deny`.
- `ask` maps to `permissions.ask`.
- `limited` and `ask_or_deny` collapse to `ask` for v1; finer-grained shaping is a Phase 6 #5 follow-up.

### The three v1 profiles

`safe-start` (pre-approval default):

```yaml
read:   { allow: true }
edit:   { allow: ask }
bash:   { allow: ask }
commit: { allow: false }
push:   { allow: false }
pr:     { allow: false }
deploy: { allow: false }
```

`implementation-after-approval` (post-approval working profile; activate by re-running `harness apply` after `harness approve understanding`):

```yaml
read:   { allow: true }
edit:   { allow: true }
bash:   { allow: ask }
commit: { allow: ask }
push:   { allow: ask }
pr:     { allow: ask }
deploy: { allow: false }
```

`high-risk-grill-me` (high-friction profile for security/infra surfaces; asks per-Edit and per-Bash even after approval):

```yaml
read:   { allow: true }
edit:   { allow: ask }
bash:   { allow: ask }
commit: { allow: false }
push:   { allow: false }
pr:     { allow: ask }
deploy: { allow: false }
```

Profile composition with the harness PreToolUse blocker (Phase 6 #4): the static `permissions` block sets the always-applies floor; the blocker handles the conditional approval gate on top. A request denied by `permissions.deny` is refused before the blocker runs; a request matched by `permissions.ask` still goes through the blocker, which can additionally refuse based on approval state.

Phase 6 #5 follow-ups still queued: an inline `requires:` shape on profile actions (the schema parses it today; runtime evaluation lands later); `permissions.allow` overrides for finer-grained `limited` semantics; per-pack profile overrides via `harness pack profile activate <name>` so the user does not need a manual re-apply.

## Approval state

One approval authority and two evidence records, by design (since task `7402301d`; before it the marker and the persisted report were two parallel sources with equal authority, see "Persisted report: evidence, not authority" below):

1. **Filesystem approval marker** at `harness.generated/.approvals/<sessionId>` (or `task-<taskId>`). Owned by harness; **the only source the gate accepts**. Written by `harness approve understanding` from the operator's shell. Edit / Write / Bash are all gated by this same PreToolUse hook, and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes. This is what closes the self-approval boundary (agent-tasks/88ca4bb3). **As of harness/f9485cc7 this invariant is also cryptographically enforced, not merely assumed** (see "Marker signing" below): the marker carries an HMAC signature, so even if a future MCP tool silently reopened a local filesystem-write path the blocker's `Edit|Write|Bash` matcher doesn't cover, a marker written through it still fails the gate without the operator-side signing key.
2. **Persisted JSON report** at `.understanding-gate/reports/<iso>-<slug>-<hash>.json`. Owned by `@lannguyensi/understanding-gate`. Flipped to `approvalStatus: "approved"` by the same `harness approve understanding` call and to `expired` by the post-tool-use boundary hook, so it tracks the marker as an audit record. **Evidence, not authority**: the gate never opens on it. The agent's Stop hook only writes `pending` reports, and an approved-looking report that no validly-signed marker backs is rejected with its own audit reason (below).
3. **Evidence-ledger row** `understanding-approved:${SESSION_ID}`, written by the same call via `grounding-mcp`. Audit only: the agent has direct MCP access to the same ledger, so the row never satisfies the gate; it is surfaced in the diagnostic output, labelled `(no longer satisfies the gate)`, so an operator chasing a flapping approval can see when an approval was actually recorded.

The harness-side PreToolUse blocker (Phase 6 #4, both the Claude and the Codex hook through the shared runtime) consults the marker for the decision (task-scoped marker first, then the session marker, both under `approval_lifecycle`) and the persisted report for the diagnostic only. When the report on disk says `approved` but no validly-signed marker matches, the block reason carries the distinct phrase `unsigned persisted-report approval rejected: report <file> has approvalStatus=approved ... but the persisted report is evidence, not authority`, the counterpart of `forged/unsigned marker rejected`, so an operator or auditor can tell a report-side forgery attempt (or an approval that bypassed `harness approve understanding`) apart from the routine "never approved" case.

`harness approve understanding` round-trips all three so the audit records stay in step with the marker, and a solo `understanding-gate` user can adopt harness later without losing approval history. It does not make the report a fallback authority: under harness, the package's own `understanding-gate approve` CLI flips the report but writes no signed marker, so it does not open the gate; `harness approve understanding` is the approval path.

`harness apply` regeneration does NOT touch `harness.generated/.approvals/`. The apply path only writes its own known files into `harness.generated/`; sibling state (the approval marker, the signing key, and the `.pending-approval` staging file) survives a re-apply byte-for-byte. Pinned by `tests/cli/apply/apply.test.ts` "apply preserves sibling state under harness.generated/" so live sessions stay approved across re-applies.

### Marker signing (harness/f9485cc7)

**Why**: the marker's integrity used to rest entirely on an UNENFORCED invariant — "no configured MCP exposes a filesystem-write primitive". Nothing checked that it stayed true; one future MCP tool with local file-write silently reopens the marker, because its tool name would not match the blocker's `Edit|Write|Bash` matcher. Before this change the marker's contract was "existence is enough" — exactly the shape a forger only needs a bare filesystem-write for.

**What changed**: `harness approve understanding` now writes an HMAC-SHA256 signature into the marker, over `(markerId, approvedAt, approvedBy, reportContentHash)` — `markerId` is the marker's lookup key (the raw sessionId for the session marker, `task-<id>` for a task-scoped marker, `branch-protection-<sessionId>` for the branch-protection twin), and `reportContentHash` is the sha256 of the persisted Understanding Report's raw content at approval time (`null` when no report exists to bind, e.g. `harness approve branch-protection`). The gate-side check (`checkApprovalMarker` in `src/policy-packs/builtin/understanding-before-execution/markers.ts`) verifies this signature; a marker with a missing or invalid signature is treated as **NOT approved** — the same `matched: false` outcome as no marker at all, but with a distinct diagnostic (`forged/unsigned marker rejected: ...`) so an operator or auditor can tell an active forgery attempt (or a pre-signing legacy marker) apart from the routine "never approved" case. Binding `markerId` into the signature also means a validly-signed marker can no longer be copied/renamed onto a different session id and still verify — the "manually copy a marker between session ids" admin trick this doc used to describe **no longer works** after upgrading; write a fresh marker for the new id instead. Binding `reportContentHash` is **groundwork only, not yet enforced at gate-check time**: nothing today cross-checks the hash carried in a signed marker against the CURRENTLY-selected persisted report, so it does not by itself stop a stale-report adoption; the live cross-check is the C1 staleness follow-up, task `fa423e9b`, out of scope here.

The same primitive covers the `branch-protection` policy pack's override marker (`writeBranchProtectionMarker` / `checkBranchProtectionMarker` in `src/policy-packs/builtin/branch-protection-runtime.ts`) — both delegate to the shared `writeApprovalMarker` / `checkApprovalMarker` functions, so signing and verification are identical, not a parallel reimplementation. The `solution-acceptance` pack's verdict marker is **not yet signed**; CHANGELOG 0.32.0 already flagged cryptographic signing as a tracked follow-up for it, and it remains a scoped follow-up here.

**Persisted report: evidence, not authority (task `7402301d`).** Marker signing left one path open: `checkPersistedReport` was the second of two parallel approval sources, consulted by both PreToolUse hooks with equal authority immediately after a forged marker had been rejected, and the report was not signed at all. Under the same threat model, a single unsigned JSON file carrying `approvalStatus: "approved"` dropped into the reports directory was an equal-or-easier forgery than the marker used to be (no key, and no session id either, since the gate-read selection adopts a sessionId-less report for any session). The closure is structural rather than a second signature: gate-time approval authority flows **only** through the signed marker, in both runtimes. `checkPersistedReport` (`src/policy-packs/builtin/understanding-before-execution/persisted-reports.ts`) now returns `PersistedReportEvidence`, a shape with no `approved` field, and both hooks use it for the block diagnostic and the parse-error lookup only; a report whose on-disk status says `approved` yields the distinct `unsigned persisted-report approval rejected: ...` reason. Consequences: a hand-written approved report satisfies nothing; `approval_lifecycle.max_age` now really expires an approval (a still-approved report used to keep the gate open past it; the recovery-git-commit exemption is the way a bare `git commit` passes after expiry); and, **strictly and without a migration window** (the same policy as marker signing), an approval that only ever flipped the report (the standalone `understanding-gate approve` CLI, or a `harness approve understanding` run whose marker write failed) no longer opens the harness gate: run `harness approve understanding` once after upgrading on a machine with a live approval. Named residuals, pinned by `tests/cli/pack-hook-persisted-report-evidence.test.ts`: a valid marker plus a report swapped after approval still allows (the operator did approve the session; the marker's `reportContentHash` is not cross-checked at gate time, task `fa423e9b`, which under this design is an audit-fidelity gap rather than an authority gap), and the key-read-plus-uncovered-write forgery of a valid marker described in the trust model below is unchanged.

**Key storage**: a raw 32-byte secret at `<generatedDir>/.approval-signing.key` (a sibling of `.approvals/`), mode `0600`, generated lazily via `crypto.randomBytes(32)` on first use (the first `harness approve understanding` / `harness approve branch-protection` invocation after upgrading; nothing to run by hand). It lives alongside `harness.generated/` rather than under a separate home-dir path so it is: gitignored by the same existing convention as the rest of `harness.generated/` (a home-dir-anchored path could land inside a version-controlled tree when `harness.yaml` is resolved via `--config` into a repo); untouched by `harness apply` (apply only ever writes its own known files, same guarantee `.approvals/` already relies on); and automatically test-isolated (every call site already threads an explicit, test-injectable `generatedDir`, so there is no new way to leak a key write into a real `~/.harness/` during a test run). `harness uninstall` DOES remove it (it recursively deletes the whole `generatedDir`) — a deliberate, rare, operator-initiated teardown; losing the key along with every marker it signed is the intended blast radius, not a silent regression.

**Rotation**: delete `<generatedDir>/.approval-signing.key` (or call `rotateSigningKey` from `src/runtime/approval-signing.ts` directly — there is no dedicated CLI verb for this in v1). The next marker write or check lazily regenerates it. Every marker signed under the old key immediately fails verification and the gate demands re-approval everywhere — this is the intended, documented cost of a rotation, not a bug.

**Back-compat: strict, no migration window.** A marker written before this feature shipped (no `signature` field at all) is rejected exactly like a forgery — `harness approve understanding` (and/or `harness approve branch-protection`) needs to run once more after upgrading on a machine with a live, previously-approved session. A migration/grace-period window was considered and rejected: such a window is, by construction, a window where the exact vulnerability this closes — an unsigned marker satisfying the gate — still holds.

**Honest trust model — read this before assuming more than it delivers.** This does **not** create a read boundary. The `understanding-before-execution` PreToolUse blocker matches tool names `Edit|Write|Bash` only; it does not gate `Read`, and no permission profile in this repo scopes `Read` away from any path (`read` maps to `["Read", "Glob", "Grep"]` with `allow:true` in every v1 profile — see "Suggested permission profiles" above). So **any** file on local disk — including the signing key, wherever it lives — is readable by the ordinary, always-available `Read` tool, approved or not; storing the key outside `harness.generated/` would not change this, since the write barrier is per-tool-name, not per-path. The residual this leaves: an agent (or anything running as the same OS user) that can (a) read arbitrary local files — true today, by design, via `Read` — **and** (b) write to `harness.generated/.approvals/` through some primitive not covered by the `Edit|Write|Bash` blocker matcher, can forge a validly-signed marker: read the key with `Read`, compute the HMAC, write the result through the uncovered path. Signing does not close this combined case. What it closes is the narrower (and, before this change, entirely undefended) case where a forger has a write primitive but not a matching way to also recompute a valid signature for it — and it makes any forgery attempt one step more expensive and forensically visible (a key read is a distinguishable event; a bare unsigned-JSON write no longer is). Given the agent and operator share one OS user account on this machine, this is deliberately pragmatic defense-in-depth, not a hard authorization boundary — documented in full in `src/runtime/approval-signing.ts` rather than oversold.

An interim mitigation the M10 task considered — an `init`/smoke-time scan of the configured MCP catalog for filesystem-write-capable tools, so the "no configured MCP exposes a write primitive" assumption gets an active warning instead of silent trust — did not fall out naturally from this change and is not implemented. It is a candidate follow-up task, tracked separately from marker signing.

### Marker lifetime and session-id reuse

The approval marker has no TTL: once `harness approve understanding` writes `harness.generated/.approvals/<sessionId>`, the gate is satisfied for the lifetime of that session id. The contract is "one Understanding Report approved per session, not per tool call"; a time-bounded shape similar to `within: 1h` on other policies is a possible v2 feature, not v1 behaviour.

Claude Code session ids are UUIDs so accidental collision is not a concern. One operator-controlled path that DOES carry approval across logical session boundaries, worth flagging as a known property:

- **Scripted runs that reuse a session id.** If your test harness or wrapper pins a fixed session id and approves once, every subsequent run under that id is pre-approved. That is the intended shape for some CI flows, but make it deliberate.

(Manually copying a marker file onto a *different* session id — `cp harness.generated/.approvals/<old> harness.generated/.approvals/<new>` — used to work as a "yes I really mean it" admin trick. As of harness/f9485cc7 it no longer does: the signature binds the marker's own lookup key, so a marker copied onto a new id fails verification. Write a fresh marker for the new id via `harness approve understanding --session <new>` instead.)

Delete the marker (`rm harness.generated/.approvals/<sessionId>`) to force a re-approval on the next tool call. Symlinks at the marker path are refused (see `checkApprovalMarker` in `src/policy-packs/builtin/understanding-before-execution/markers.ts`), so a symlinked marker cannot be used to redirect approval at a target the operator did not write directly.

## Adapter notes

### Claude Code (first-class target)

The `understanding-gate` package's existing claude-code adapter handles UserPromptSubmit (instruction injection) and Stop (report persistence). Phase 6 #4 adds the harness-side PreToolUse blocker on top of the package's minimal blocker (which only checks the persisted JSON). No changes required in `~/.claude/settings.json` beyond what `harness apply` regenerates.

### OpenCode

The package ships an OpenCode plugin (`message.updated` for the auto-capture path; `tool.execute.before` for the standalone blocker). Harness orchestration on top is the same shape as for Claude Code; no new harness-side surface is required for OpenCode v1.

### Codex

Shipped in Phase 6 #6. Apply the pack with the Codex runtime selector:

```sh
harness apply --runtime codex --install --config <path>/harness.yaml
```

This emits `harness.generated/codex/config.toml` (instead of `settings.json`) with harness-managed Codex hook groups such as `[[hooks.UserPromptSubmit]]`, `[[hooks.Stop]]`, `[[hooks.PreToolUse]]`, and `[[hooks.PostToolUse]]`. Each group contains a nested command hook entry (`hooks = [{ type = "command", command = "...", timeout = 5 }]`); the PreToolUse blocker uses the expanded matcher `apply_patch|Bash|shell|exec_command|functions.exec_command`. With `--install`, harness replaces only the marked harness-managed block under `~/.codex/config.toml`; harness owns hook wiring only, not the operator-owned model/auth/sandbox config.

The `PostToolUse` group (task a1348c89) is the Codex parity counterpart of the Claude `post-tool-use` marker-expiry hook (see "What the pack ships" below): `harness pack hook codex-post-tool-use` clears the approval marker (and expires the persisted report) once a configured task-boundary tool completes, so a Codex session's approval no longer only dies via `approval_lifecycle.max_age`. It shares its match/clear implementation with the Claude hook (`matchPostToolUseBoundary` / `applyPostToolUseExpiry` in `post-tool-use-boundary.ts`) and is emitted/suppressed under the exact same `approval_lifecycle` rules (default tool list, `mode: session` opt-out, custom `expire_on_tool_match`). Its `match` field is built by a Codex-specific `codexPostToolUseMatchPattern` (a bare `|`-joined list), NOT the Claude `postToolUseMatchPattern` helper (an anchored `^(?:...)$` regex): the anchor form defeats the Codex generator's `expandCodexHookMatchPattern` alias expansion, so the bare form is what lets the emitted `config.toml` matcher — and therefore Codex's own hook dispatcher — recognize the server hyphen/underscore and `mcp__server__.tool` dotted variants Codex may send for an `expire_on_tool_match` MCP tool, same as the Codex PreToolUse blocker's matcher already does.

**`expire_on_bash_match` routing (task bea04a03, fixed):** the trigger's `match` field is now widened with the Codex shell-tool aliases (`Bash`/`shell`/`exec_command`/`functions.exec_command`) whenever `approval_lifecycle.expire_on_bash_match` carries at least one pattern, so a real shell call actually reaches this hook, whose body evaluates `expire_on_bash_match` against the command via `matchPostToolUseBoundary`. Before this fix the trigger was built only from `expire_on_tool_match`, so a shell call never reached the hook at all regardless of `expire_on_bash_match` — the hook body's bash-regex check was correct but unreachable. The widened aliases are never folded into `expire_on_tool_match`'s own tool-name semantics.

**Active-claim tracker + stay-in-scope reminder on Codex (task cf4cdc93, closed the former "Out of scope for v1" residual):** the Codex branch now also emits `[[hooks.PostToolUse]]` groups running `harness pack hook track-active-claim` and `harness pack hook stay-in-scope` — the SAME command as the Claude branch (see "What the pack ships at apply time" below); no Codex-specific CLI verb was needed. Their `match` fields use Codex-specific bare `|`-joined sibling constants (`TRACK_ACTIVE_CLAIM_MATCH_CODEX`, `STAY_IN_SCOPE_MATCH_CODEX`), not the Claude anchored `^(?:...)$` forms, for the same `expandCodexHookMatchPattern` alias-expansion reason as the marker-expiry hook above; both hook bodies were also made alias-aware (`toolNameMatchesAny`) so an MCP tool-name variant that the widened matcher routes to the hook is recognized once inside it too. Both hook bodies also tolerate the same field-name synonyms as `codex-post-tool-use` (task cf4cdc93 review finding, MEDIUM): `tool` alongside `tool_name`, and `raw_input` alongside `tool_input` (see the wire-format block below) — a Codex shim sending either synonym used to silently no-op in these two hooks even though the marker-expiry hook already tolerated it; both now resolve them via the same shared `pickString` / `resolveToolInput` helpers (`src/cli/pack/hook-bootstrap.ts`). `stay-in-scope`'s `tool_response` taskId fallback (a Claude-side convenience) is unaffected: the Codex envelope may not carry that field at all, and the fallback correctly stays a no-op in that case.

Wire format for the Codex adapter scripts (stdin):

```jsonc
{
  "session_id": "<string>",   // no alias: "id" is deliberately NOT
                               // accepted (it collides with the
                               // event/message id in most event-bus
                               // shapes; see hook-codex-pre-tool-use.ts)
  "tool_name":  "<string>",   // also tolerated: "tool"
  "raw_input":  {  /* tool args, opaque */  },
  "event":      "<string>"    // optional event name
}
```

Block contract (PreToolUse): exit 2 + reason on stderr. Allow contract: exit 0, optional diagnostic on stderr. Injector contract (UserPromptSubmit): instruction template on stdout for Codex to prepend to `additional_instructions`.

`codex-post-tool-use` reads the same envelope but prefers `tool_input` over `raw_input` when both are present (`tool_input` is the field name the published Codex `PostToolUse` payload actually sends, matching Claude Code's own convention; `raw_input` remains accepted for any shim built against harness's earlier portable wire format). It also resolves `session_id` from `$CODEX_SESSION_ID` ahead of `$CLAUDE_CODE_SESSION_ID` / `$CLAUDE_SESSION_ID` when the event omits it.

`codex-pre-tool-use` now (slice 2, agent-tasks 57058364) prefers `tool_input` over `raw_input` the same way, via the same shared `resolveToolInput` helper, so the real Codex payload reaches the read-only Bash and recovery-commit exemptions; it also reads `permission_mode` and `transcript_path` off the envelope for the `auto_approve` attempt (see "`auto_approve`: opt-in auto-approval for a listed permission mode" above).

`--target` and `--runtime codex` are mutually exclusive: `--target` wires the Claude-Code-shaped settings.json into a destination path, which the codex runtime does not produce. The two runtimes are mutually exclusive for v1; running apply against a single manifest under both runtimes requires two invocations into separate generated trees.

### Doctor wiring

`harness doctor --target codex` (Phase 6 #6 follow-up, shipped) evaluates the harness side of the integration:

- The `harness` binary itself is on `$PATH` (so the `harness pack hook codex-*` subcommands resolve).
- `harness.generated/codex/config.toml` exists and carries the harness-managed banner.
- Every contributed Codex hook group has a command first-token that resolves on `$PATH` (bare `harness` subcommands inherit the binary check above).
- `.understanding-gate/reports/` is writable, or its parent is (the directory is created on first persisted report).

`--json` emits the structured `DoctorReport` with a `codexTarget` block; the codex error/warning counts roll into the top-level totals. `harness doctor` without `--target codex` is unchanged (back-compat).

### Stop-equivalent (report capture)

`harness pack hook codex-stop` (Phase 6 #6 follow-up, shipped) captures the agent's Understanding Report into `.understanding-gate/reports/<iso>-codex-<sessionhash>.json` with `approvalStatus: "pending"`. Wire format on stdin:

```jsonc
{
  "session_id":              "<string>",
  "last_assistant_message":  "<string>",   // preferred shortcut
  "messages":                [ /* { role, content } rows; last assistant entry used as fallback */ ]
}
```

The parser is heading-driven and lenient: it recognises markdown headings (`## Interpretation`), bold labels (`**Interpretation:**`), and plain colon-prefixed labels (`Interpretation:`). Field names accept `assumptions`, `openQuestions` / `Questions`, `outOfScope` / `Exclusions` / `Scope Exclusions`, `risks`, `verificationPlan` / `Validation` / `Verification`. Bullet lines (starting with `-`, `*`, or `•`) collect into the list-typed fields (`assumptions`, `openQuestions`, `outOfScope`, `risks`); non-bullet lines under a list-typed heading are silently dropped. Lines under a scalar-typed heading (`interpretation`, `verificationPlan`) accumulate into one paragraph until the next heading or a blank line.

Failure mode: any error (malformed input, missing session id, unwritable reports dir, parser yielded zero recognisable fields) resolves to exit 0 + a stderr diagnostic. Stop must never block the agent's response path.

After capture, `harness approve understanding --session <id>` flips `approvalStatus` to `approved` on the captured file and writes the ledger tag, identical to the Claude Code path. Cross-runtime approval is automatic since both runtimes share the same persisted-report directory.

### Out of scope for v1 (still tracked as follow-ups)

- A Codex-side permission-profile translator. `harness apply --runtime codex` warns when `policy_packs[].config.permission_profile` is set; the codex generator does not yet emit a Codex sandbox stanza.

## What the pack ships at apply time

`harness apply` against a manifest with this pack enabled writes:

- Six hooks in the harness-managed `settings.json`:
  - `UserPromptSubmit` injector: bare bin `understanding-gate-claude-hook` (from the npm package; user must `npm i -g`).
  - `Stop` capture: bare bin `understanding-gate-claude-stop` (same).
  - `PreToolUse` blocker on `Edit|Write|Bash`: `harness pack hook pre-tool-use` (Phase 6 #4). The harness-side blocker opens only on the signed approval marker `harness.generated/.approvals/${SESSION_ID}` (or the task-scoped `task-<id>` twin; agent-tasks/88ca4bb3, harness/f9485cc7); the persisted JSON report under `.understanding-gate/reports/` is consulted for the block diagnostic only and never grants approval (task 7402301d, see "Approval state"). The npm package's standalone `understanding-gate-claude-pre-tool-use` blocker remains available for solo users without harness. The blocker also probes the evidence ledger for the historic `understanding-approved:${SESSION_ID}` tag as forensics; that probe never grants approval but surfaces in the diagnostic so an operator can see the audit trail. On every block or ask it stages the session id to `harness.generated/.pending-approval` so `harness approve` can resolve it without a flag (see [Session-id resolution](#session-id-resolution)).
  - `PostToolUse` marker-expiry: `harness pack hook post-tool-use` clears the approval marker (and expires the persisted report) after a configurable task-boundary tool fires (default: agent-tasks `task_finish` / `task_abandon` / `pull_requests_merge` / `tasks_transition`), or after a Bash call whose command matches `approval_lifecycle.expire_on_bash_match` — the emitted `matcher` widens to include `Bash` whenever that list is configured (task bea04a03) so a real `gh pr merge` / `git push` actually reaches the hook.
  - `PostToolUse` active-claim tracker: `harness pack hook track-active-claim` writes `harness.generated/active-claim` on `task_start` and clears it on `task_finish` / `task_abandon` (harness/494fd1e5). Lets `harness approve understanding` auto-resolve the current task id without `--task`.
  - `PostToolUse` stay-in-scope reminder: `harness pack hook stay-in-scope` emits a one-line stderr reminder + JSONL audit row when a `task_create` / `tasks_create` / `tasks_update` payload looks like a review-derived follow-up. Soft (does not block); surfaces the rule that small reviewer findings should be fixed inline in the parent PR rather than carved out as separate tasks. See [Stay-in-scope reminder](#stay-in-scope-reminder).
  - Hook names are namespaced (`policy-pack:understanding-before-execution:<role>`) to avoid collisions with operator-authored hooks.
- Six hooks in the harness-managed `codex/config.toml` (`--runtime codex`), same roster as the Claude branch above: `UserPromptSubmit` injector, `Stop` capture, `PreToolUse` blocker, the `PostToolUse` marker-expiry hook (`harness pack hook codex-post-tool-use`, task a1348c89) — same default task-boundary tool list as the Claude `post-tool-use` hook above, widened with the Codex shell-tool aliases when `expire_on_bash_match` is configured (task bea04a03, see "Adapter notes / Codex" above) — and, as of task cf4cdc93, the `PostToolUse` active-claim tracker and stay-in-scope reminder, running the exact same commands (`harness pack hook track-active-claim` / `harness pack hook stay-in-scope`) as the Claude branch, with Codex-specific alias-expandable matchers (see "Adapter notes / Codex" above).
- An operator audit copy at `harness.generated/policy-packs/understanding-before-execution/instructions.md`. This file documents what the pack is doing in the operator's voice (mode, hook list, approval flow); the agent-facing prompt is injected at runtime by the `UserPromptSubmit` hook and lives in the npm package, not here. Drift on the audit copy means an operator edited something they shouldn't have, and `harness diff --since-apply` flags it.

## Approving an Understanding Report

```sh
harness approve understanding [--session <id>] [--task <ids...>] [--reports-dir <path>]
```

Round-trips all three approval-state sinks:

- Writes the approval marker `harness.generated/.approvals/${SESSION_ID}` (canonical gate signal, agent-tasks/88ca4bb3). A failed marker write is a HARD error in the CLI output; the gate will keep blocking until the marker exists.
- Flips `approvalStatus: "approved"` on the latest matching persisted JSON report (audit evidence; the gate does not open on it, task 7402301d). When the report lacks a `sessionId`, the current session id is stamped onto it so a later lookup strict-matches it (agent-tasks/0dce3880).
- Writes the `understanding-approved:${SESSION_ID}` tag via `grounding-mcp`'s `ledger_add` for audit / forensics. A degraded ledger surfaces as a warning, not a hard failure.

The blocker on the next tool call sees the new approval through the signed marker; the flipped report and the ledger row are the audit records beside it.

### Pre-approving a batch of tasks

`--task` is variadic. Passing several ids (`--task a b c`, or comma-joined `--task a,b,c`) writes one task-scoped marker per id in a single operator action. The understanding gate is task-scoped (its `expire_on_tool_match` hook expires the approval on every `task_finish`), so without this a multi-task session needs one `harness approve understanding` per task. Pre-approving the batch up front means each `task_start` finds its marker already present. This does not weaken the gate: the operator's Understanding Report still has to enumerate every task it covers; only the round-trip count collapses. With no `--task` flag the active-claim file is auto-resolved as before (single task).

### Session-id resolution

`harness approve` needs the running session's id. Operators usually run it from a fresh `!`-shell where none of `$CLAUDE_CODE_SESSION_ID`, `$CLAUDE_SESSION_ID`, or `$CODEX_SESSION_ID` is set, so the id is resolved in this precedence order:

1. `--session <id>` flag.
2. `$CLAUDE_CODE_SESSION_ID` env: the canonical Claude Code variable, exported by the runtime into the agent shell. Read first so an in-session call resolves to the runtime's id (rather than to a hand-typed `$CLAUDE_SESSION_ID` that may not match).
3. `$CLAUDE_SESSION_ID` env: legacy / docs-name peer, kept for the Codex pre-tool-use hook's own fallback chain and for operators who set it by hand in older `!`-shell recipes.
4. `$CODEX_SESSION_ID` env (live Codex session, symmetric with the Codex pre-tool-use hook's own fallback chain).
5. `harness.generated/.pending-approval`: both the PreToolUse blocker (Claude AND Codex variants) and `harness session-start preflight` write the resolved session's id here, so an arg-less `harness approve understanding` picks it up with no guessing.
6. The freshest persisted Understanding Report under `<reportsDir>` whose JSON `sessionId` field is non-null. Runtime-neutral fallback that covers the post-Understanding-Report-pre-block window: the agent has produced a report, no tool call has yet tripped the gate to stage `.pending-approval`, and the operator wants to approve right away.

The CLI prints which tier supplied the id (e.g. `session: <id> (resolved from .pending-approval ...)`, `(from $CLAUDE_CODE_SESSION_ID)`, `(from $CODEX_SESSION_ID)`, `(resolved from sessionId field of the newest persisted Understanding Report)`), so a wrong id is visible before it lands. After a successful resolve from `.pending-approval` with the marker write landed, the staging file is deleted so a later arg-less call cannot revive a stale id; a failed marker write keeps it for a retry. When all six tiers come up empty, the command exits with the retrieval-path hint instead of a guess.

Phase 6 #2 follow-ups still queued: an automatically-injected stanza into the per-project `CLAUDE.md` for human discoverability, and a `harness doctor` wiring check that validates the package binaries are on `$PATH`.

## Stay-in-scope reminder

A small soft hook bundled with this pack (harness/2ba06030). When the agent creates or updates a task whose payload looks like a follow-up carved out of a code review, the hook writes one stderr line and appends one JSONL row to an audit log. It does not block, decline, or alter the task in any way.

The intent: surface the rule that small reviewer findings should be fixed inline in the parent PR, while leaving the agent (and the operator) to judge whether a given follow-up is genuinely scope-out (trigger-bound work, larger refactors, hypotheticals waiting for data). The audit log answers, after a few weeks of dogfood, whether the reminder ever changes behaviour or whether the rule needs a harder enforcement layer.

**When it fires.** PostToolUse on one of `mcp__agent-tasks__task_create`, `mcp__agent-tasks__tasks_create`, `mcp__agent-tasks__tasks_update`, when EITHER:

1. `tool_input.labels` contains a token matching `/(from-review|followup|reviewer-finding|review-finding)/i`, OR
2. `tool_input.description` contains an explicit marker (`Vorgaenger-PR:`, `Vorgänger-PR:`, `Review-Subagent`), OR
3. `tool_input.description` contains `## Hintergrund` with `Review` mentioned inside the next 200 characters.

**Second-order escalation.** When both a review-shaped label AND a `Vorgaenger-PR.*#<n>` reference are present, the stderr prefix upgrades to `[stay-in-scope: SECOND-ORDER]`. A follow-up that traces back to another follow-up violates the explicit rule that follow-ups must not spawn further follow-ups.

**Audit log.** One JSONL row per fire, default location `~/.harness/reminders/stay-in-scope.log`. Schema:

```json
{
  "ts": "2026-05-26T11:55:07.820Z",
  "taskId": "44269f36-...",
  "title": "fix cosmetic phase_status thing",
  "labels": ["from-review", "cosmetic"],
  "parentPrUrl": "https://github.com/owner/repo/pull/91",
  "secondOrder": false,
  "matchedRule": "label"
}
```

`parentPrUrl` is best-effort: a fully qualified GitHub PR URL when present in the description, otherwise the `#<n>` shorthand pulled from a `Vorgaenger-PR` line, otherwise `null`.

**Knobs.**

- `STAY_IN_SCOPE_DISABLED=1` in the hook's env short-circuits to no-op after the pause sentinel is evaluated. Use this if the reminder noise is unhelpful in a specific run; the operator pause path (`harness pause`) silences it the same way it silences every other hook.
- `STAY_IN_SCOPE_LOG=/path/to/audit.jsonl` overrides the log path. Use for separating per-project logs.

**Analyzing the log.**

```sh
# Hit profile by match rule.
jq -s 'group_by(.matchedRule) | map({rule: .[0].matchedRule, count: length})' \
  ~/.harness/reminders/stay-in-scope.log

# Second-order hits only (the ones that violate the no-cascade rule).
jq -c 'select(.secondOrder)' ~/.harness/reminders/stay-in-scope.log
```

To act on a hit: cross-reference the logged `taskId` against agent-tasks to see whether the task was later abandoned (suggesting the reminder worked) or completed (suggesting the follow-up was legitimately scope-out, OR the agent ignored the reminder; the description body answers which).

## See also

- [`docs/ROADMAP.md` Phase 6](../ROADMAP.md#phase-6-understanding-gate-policy-pack) for the sub-task decomposition.
- [`docs/ARCHITECTURE.md` §6](../ARCHITECTURE.md) for the policies/requires/grounding-mcp wiring this pack composes on top of.
- `@lannguyensi/understanding-gate` source: <https://www.npmjs.com/package/@lannguyensi/understanding-gate>.
