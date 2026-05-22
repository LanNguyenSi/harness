# Risk Gate

> **Status (Phase 7 #1 anchor):** vocabulary only. The `risk:`,
> `environments:`, and `policy.when:` manifest keys parse and validate,
> but nothing in `harness apply`, `harness doctor`, `harness policy
> intercept`, or runtime enforcement reads them yet. Sub-tasks #2
> through #6 in [`ROADMAP.md`](ROADMAP.md#phase-7--risk-gate) wire those
> surfaces in. Until they ship, this doc describes the **target shape**,
> with the implementation status of each piece called out inline.

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
into `harness policy intercept` in Phase 7 #5.*

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

### Environment resolvers (`environments:`)

*Status: parsed and validated (Phase 7 #1). Consumed by the Context
Resolver in Phase 7 #4.*

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

Pattern match semantics per signal kind (substring, glob, or regex) are
defined by the Phase 7 #4 resolver runtime. The anchor stores them as
plain non-empty strings; `branch_patterns` and `*_namespace_patterns`
are intended as globs, `kube_context_patterns` as regexes, env-var
patterns as substrings of the variable's value.

### Risk-aware match clauses (`policy.when:`)

*Status: parsed and validated (Phase 7 #1). Evaluated by `harness
policy intercept` in Phase 7 #5.*

A policy may carry an optional `when:` block. Today it is parsed and
inert: `harness policy intercept` still matches on `trigger:` alone. In
Phase 7 #5 a declared `when:` is ANDed onto the trigger match and
evaluated against the enriched envelope.

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

In Phase 7 #1 a `when:`-bearing policy still carries the Phase 4
`requires:`, `hook:`, and `enforcement:` fields, all of them required by
the schema today. Relaxing those (a pure risk policy that decides from
`when:` alone, without ledger evidence) is a structural change to the
policy model with runtime implications, and is deferred to Phase 7 #5
where the evaluator that needs it lands.

## Decision model (target, Phase 7 #5/#6)

The Phase 4 decision space is `allow` / `deny`, selected by
`enforcement: block | warn`. Phase 7 extends it to four outcomes:

| Decision | Meaning |
|---|---|
| `allow` | Action may proceed. |
| `warn` | Action proceeds; a warning is recorded and surfaced. |
| `require_approval` | Action is blocked until matching approval evidence exists in the ledger. |
| `deny` | Action is blocked. |

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
