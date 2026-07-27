# Policy Pack: `understanding-before-execution`

> **Status (Phase 6 anchor):** vocabulary only. The `policy_packs:` manifest key parses and validates; nothing in `harness apply`, `harness doctor`, or runtime enforcement honours it yet. Sub-tasks #2 through #6 in [`ROADMAP.md`](../ROADMAP.md#phase-6--understanding-gate-policy-pack) wire those surfaces in. Until they ship, this doc describes the **target shape**, with the implementation status of each piece called out inline.

## What this pack does

Forces an agent to expose its task interpretation, an *Understanding Report*, before any write-capable tool fires. The user confirms, corrects, or "grills" the understanding until it is precise enough. Only after explicit human approval is recorded as evidence may the agent edit files, run shell commands, commit, push, or open PRs.

The motivating failure mode: an agent reads a task, picks an interpretation, and starts editing. The user notices three commits in that the scope is wrong. The Understanding Gate cuts this off at the point of interpretation, not at code review.

Long-form design and rationale: [`lava-ice-logs/2026-04-30/harness-pre-execution-understanding-integration.md`](https://github.com/LanNguyenSi/lava-ice-logs/blob/master/2026-04-30/harness-pre-execution-understanding-integration.md).

## How it works (target architecture)

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
    │  via `harness approve understanding`  ← Phase 6 #4
    │  writes approval marker: harness.generated/.approvals/${SESSION_ID}
    │  flips approvalStatus=approved on the persisted report
    │  also writes ledger tag understanding-approved:${SESSION_ID} (audit only)
    ▼
PreToolUse hook               ← Phase 6 #4 (harness-side blocker)
    │  consults the approval marker file OR the persisted report
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
| `approval_lifecycle.expire_on_bash_match` | array of regex strings | optional; clear the marker when a Bash call matches any of these (gh-cli workflows) |
| `approval_lifecycle.max_age` | duration string (`1h`, `30m`, ...) | optional safety net for sessions that never hit a listed tool / Bash boundary |
| `ux` | `PolicyUxSchema` (`cannot` + `required[]` + `run[]`) | optional; renders agent-facing remediation when the PreToolUse blocker fires |
| `producers` | array of `ProducerSchema` (`kind` + recipe) | optional; companion to `ux:` for the same blocker render path |

Any other top-level key is rejected as a typo. New keys land in this schema (`src/policy-packs/builtin/understanding-before-execution.ts`) first, then in the pack's runtime resolver.

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

The pack's hook-level `min_version` floor on the npm-backed bins (`UG_MIN_VERSION` in the pack source) is bumped to `0.4.0` so `harness doctor` flags installs below it. Operators on 0.3.x produce reports that pre-0.4.0 parsers accept silently; on 0.4.0+ the section is enforced.

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

Two parallel sources of truth, by design:

1. **Filesystem approval marker** at `harness.generated/.approvals/<sessionId>`. Owned by harness; the canonical source for harnessed sessions. Written by `harness approve understanding` from the operator's shell. Edit / Write / Bash are all gated by this same PreToolUse hook, and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes. This is what closes the self-approval boundary (agent-tasks/88ca4bb3). **As of harness/f9485cc7 this invariant is also cryptographically enforced, not merely assumed** — see "Marker signing" below: the marker carries an HMAC signature, so even if a future MCP tool silently reopened a local filesystem-write path the blocker's `Edit|Write|Bash` matcher doesn't cover, a marker written through it still fails the gate without the operator-side signing key.
2. **Persisted JSON report** at `.understanding-gate/reports/<iso>-<slug>-<hash>.json`. Owned by `@lannguyensi/understanding-gate`; the canonical source for solo users running the package without harness. Flipped to `approvalStatus: "approved"` by the same `harness approve understanding` call. The agent's Stop hook only writes `pending` reports; the operator-side flip has no agent-reachable equivalent. **Not currently signed** — the anti-forgery hardening below covers the filesystem marker (and its branch-protection twin) only; the persisted report is a tracked follow-up, task `7402301d-14bb-4b03-8d88-a2bb8bad8084` (see "Marker signing" below).

The harness-side PreToolUse blocker (Phase 6 #4) consults both: marker beats persisted-report. `harness approve understanding` round-trips both, plus writes a `understanding-approved:${SESSION_ID}` row to the evidence ledger as a forensics audit trail. The ledger row no longer satisfies the gate on its own (the agent has direct MCP access to the same ledger); it is surfaced in the diagnostic output, labelled `(no longer satisfies the gate)`, so an operator chasing a flapping approval can see when an approval was actually recorded.

This avoids the failure mode where one source goes stale relative to the other. It also means a solo `understanding-gate` user can adopt harness later without losing approval history.

`harness apply` regeneration does NOT touch `harness.generated/.approvals/`. The apply path only writes its own known files into `harness.generated/`; sibling state (the approval marker, the signing key, and the `.pending-approval` staging file) survives a re-apply byte-for-byte. Pinned by `tests/cli/apply/apply.test.ts` "apply preserves sibling state under harness.generated/" so live sessions stay approved across re-applies.

### Marker signing (harness/f9485cc7)

**Why**: the marker's integrity used to rest entirely on an UNENFORCED invariant — "no configured MCP exposes a filesystem-write primitive". Nothing checked that it stayed true; one future MCP tool with local file-write silently reopens the marker, because its tool name would not match the blocker's `Edit|Write|Bash` matcher. Before this change the marker's contract was "existence is enough" — exactly the shape a forger only needs a bare filesystem-write for.

**What changed**: `harness approve understanding` now writes an HMAC-SHA256 signature into the marker, over `(markerId, approvedAt, approvedBy, reportContentHash)` — `markerId` is the marker's lookup key (the raw sessionId for the session marker, `task-<id>` for a task-scoped marker, `branch-protection-<sessionId>` for the branch-protection twin), and `reportContentHash` is the sha256 of the persisted Understanding Report's raw content at approval time (`null` when no report exists to bind, e.g. `harness approve branch-protection`). The gate-side check (`checkApprovalMarker` in `src/policy-packs/builtin/understanding-before-execution-runtime.ts`) verifies this signature; a marker with a missing or invalid signature is treated as **NOT approved** — the same `matched: false` outcome as no marker at all, but with a distinct diagnostic (`forged/unsigned marker rejected: ...`) so an operator or auditor can tell an active forgery attempt (or a pre-signing legacy marker) apart from the routine "never approved" case. Binding `markerId` into the signature also means a validly-signed marker can no longer be copied/renamed onto a different session id and still verify — the "manually copy a marker between session ids" admin trick this doc used to describe **no longer works** after upgrading; write a fresh marker for the new id instead. Binding `reportContentHash` is **groundwork only, not yet enforced at gate-check time**: nothing today cross-checks the hash carried in a signed marker against the CURRENTLY-selected persisted report, so it does not by itself stop a stale-report adoption; the live cross-check is the C1 staleness follow-up, task `fa423e9b`, out of scope here.

The same primitive covers the `branch-protection` policy pack's override marker (`writeBranchProtectionMarker` / `checkBranchProtectionMarker` in `src/policy-packs/builtin/branch-protection-runtime.ts`) — both delegate to the shared `writeApprovalMarker` / `checkApprovalMarker` functions, so signing and verification are identical, not a parallel reimplementation. The `solution-acceptance` pack's verdict marker is **not yet signed**; CHANGELOG 0.32.0 already flagged cryptographic signing as a tracked follow-up for it, and it remains a scoped follow-up here.

**What this task does NOT close: the persisted-report approval path.** `checkPersistedReport` (the second of the two parallel approval sources above) is consulted by both PreToolUse hooks with EQUAL authority, immediately after a forged marker is correctly rejected — and it is **not signed at all**. Under this task's own threat model (a future write primitive the `Edit|Write|Bash` blocker matcher doesn't cover), the persisted report is an **equal-or-easier** forgery target than the marker used to be: no signing key to obtain or read, no strict sessionId match required (the gate-read path's tolerant fallback mode is `"any"`, with no age limit), just a JSON file carrying `approvalStatus: "approved"` dropped into the reports directory. Tracked as follow-up **task `7402301d-14bb-4b03-8d88-a2bb8bad8084`**.

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

Delete the marker (`rm harness.generated/.approvals/<sessionId>`) to force a re-approval on the next tool call. Symlinks at the marker path are refused (see `checkApprovalMarker` in `src/policy-packs/builtin/understanding-before-execution-runtime.ts`), so a symlinked marker cannot be used to redirect approval at a target the operator did not write directly.

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

The `PostToolUse` group (task a1348c89) is the Codex parity counterpart of the Claude `post-tool-use` marker-expiry hook (see "What the pack ships" below): `harness pack hook codex-post-tool-use` clears the approval marker (and expires the persisted report) once a configured task-boundary tool completes, so a Codex session's approval no longer only dies via `approval_lifecycle.max_age`. It shares its match/clear implementation with the Claude hook (`matchPostToolUseBoundary` / `applyPostToolUseExpiry` in `understanding-before-execution-runtime.ts`) and is emitted/suppressed under the exact same `approval_lifecycle` rules (default tool list, `mode: session` opt-out, custom `expire_on_tool_match`). Its `match` field is built by a Codex-specific `codexPostToolUseMatchPattern` (a bare `|`-joined list), NOT the Claude `postToolUseMatchPattern` helper (an anchored `^(?:...)$` regex): the anchor form defeats the Codex generator's `expandCodexHookMatchPattern` alias expansion, so the bare form is what lets the emitted `config.toml` matcher — and therefore Codex's own hook dispatcher — recognize the server hyphen/underscore and `mcp__server__.tool` dotted variants Codex may send for an `expire_on_tool_match` MCP tool, same as the Codex PreToolUse blocker's matcher already does.

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
  - `PreToolUse` blocker on `Edit|Write|Bash`: `harness pack hook pre-tool-use` (Phase 6 #4). The harness-side blocker consults the approval marker file `harness.generated/.approvals/${SESSION_ID}` (canonical for harnessed sessions, agent-tasks/88ca4bb3) and the persisted JSON report under `.understanding-gate/reports/` (fallback for solo users). Either source approves. The npm package's standalone `understanding-gate-claude-pre-tool-use` blocker remains available for solo users; the harness blocker is the superset (it covers the marker file and persisted-report cases). The blocker also probes the evidence ledger for the historic `understanding-approved:${SESSION_ID}` tag as forensics; that probe never grants approval but surfaces in the diagnostic so an operator can see the audit trail. On every block or ask it stages the session id to `harness.generated/.pending-approval` so `harness approve` can resolve it without a flag (see [Session-id resolution](#session-id-resolution)).
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
- Flips `approvalStatus: "approved"` on the latest matching persisted JSON report (canonical for solo users without `grounding-mcp`). When the report lacks a `sessionId`, the current session id is stamped onto it so a later lookup strict-matches it (agent-tasks/0dce3880).
- Writes the `understanding-approved:${SESSION_ID}` tag via `grounding-mcp`'s `ledger_add` for audit / forensics. A degraded ledger surfaces as a warning, not a hard failure.

The blocker on the next tool call sees the new approval from whichever operator-authored source landed (marker or persisted report).

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

- [`docs/ROADMAP.md` Phase 6](../ROADMAP.md#phase-6--understanding-gate-policy-pack) for the sub-task decomposition.
- [`docs/ARCHITECTURE.md` §6](../ARCHITECTURE.md) for the policies/requires/grounding-mcp wiring this pack composes on top of.
- `@lannguyensi/understanding-gate` source: <https://www.npmjs.com/package/@lannguyensi/understanding-gate>.
