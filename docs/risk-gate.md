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
its approval gate through `requires:` — the `risk-approved:${SESSION_ID}`
ledger tag — so the Phase 4 requires-evaluator is reused unchanged. A
pure risk policy that decides from `when:` alone, without ledger
evidence, would be a structural change to the policy model and is not
Phase 7 scope; it remains a possible future relaxation.

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

**Degraded mode.** When the evidence ledger is unreachable (grounding-mcp
absent or unresponsive), a `require_approval` / `deny` policy cannot be
evaluated and the decision degrades to a non-blocking `warn-degraded`:
the tool call proceeds and the un-evaluated policy is recorded. This is
the same fail-open contract Phase 4 already applies to `block` policies
(`ROADMAP.md` Phase 4) — the Risk Gate does not invent a stricter one.
An operator who needs the gate to fail closed must keep grounding-mcp
healthy; `harness doctor` surfaces an unreachable ledger.

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
