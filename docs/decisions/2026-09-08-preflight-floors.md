# Preflight version floors: split the hook floor from the setup floor, reject prereleases

- **Date**: 2026-09-08
- **Status**: Accepted
- **Decision tracker**: agent-tasks/65952a0c (batch 44, T-006; residual of task 6993d9b5, batch 41 round 2, `05-review-findings.md`)
- **Implementation context**: `src/schema/session-start-preflight.ts`, `src/cli/init/templates.ts`, `src/cli/init/dependencies.ts`, `src/cli/doctor/session-start-preflight-setup-version.ts`, `src/cli/doctor/index.ts`, `src/io/version-compare.ts`

## Context

Task `6993d9b5` (batch 41) introduced one constant,
`SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION`, and had two
consumers read it: `harness doctor`'s advisory for
`session_start_preflight.setup` (warns when the resolved `preflight`
binary cannot yet build, needs agent-preflight 0.6.0), and the `init`
template's `git-preflight` `SessionStart` hook, which renders the SAME
literal as that hook's generic `min_version` floor. The round-2 review
of that task named three residuals:

1. **Coupled bump.** The next time the setup-build floor moves (because
   agent-preflight ships a NEW `--setup` capability), the hook floor
   moves with it automatically, even for an operator who never sets
   `session_start_preflight.setup: true` and so never benefits from, or
   cares about, that bump. That operator's `git-preflight` hook now
   warns on a stale `preflight` for a reason unrelated to why the floor
   moved.
2. **Double report by design.** A freshly generated manifest with
   `setup: true`, probed against a preflight below the shared floor,
   fires BOTH the generic `hooks[]` `min_version` walk
   (`checkHookVersion`, `src/cli/doctor/index.ts:475-514#"message: `v${token} ≥ ${hook.min_version}` };"`)
   and the setup-specific check
   (`checkSessionStartPreflightSetupVersion`,
   `src/cli/doctor/session-start-preflight-setup-version.ts:145-182#"return undefined;"`).
   Documented in `docs/CLI.md`'s VERSION CAVEAT, not a bug, but worth
   naming as a design cost of one constant feeding two independently
   fired findings.
3. **Prerelease pass-through.** Both checks extract the probed version
   with `/(\d+(?:\.\d+){0,3})/`, which matches only the leading numeric
   run of a version string. Given `preflight 0.6.0-rc.1`, the match is
   `0.6.0`, indistinguishable from a real 0.6.0 release, so a release
   candidate that does NOT yet carry the build step passes both floors.

## Options considered

- **A. Keep one constant.** No code change beyond documenting the bump
  rule. Who pays: every operator without `setup` enabled pays a
  spurious-seeming hook warning on every future setup-floor bump, since
  the coupling is invisible to them (the hook's own comment would need
  to explain a rationale that has nothing to do with the hook).
- **B. Split into two constants, one per consumer, with a stated bump
  rule for each.** Who pays: maintainers now track two floors instead
  of one and must reason about whether a given agent-preflight release
  changes hook-generic behaviour, `--setup` behaviour, or both, before
  bumping either. In exchange, an operator who never enables `setup`
  never sees a warning caused by a `--setup`-only change, and a
  maintainer who ships a hook-generic preflight fix (unrelated to
  `--setup`) can bump the hook floor alone.
- **C. Keep one constant, add a documented bump rule** (bump both
  together always, note in the constant's doc comment why). Who pays:
  same as A for operators without `setup`; maintainers get a documented
  rule instead of a silent coupling, but the coupling itself, and its
  cost to setup-off operators, is unchanged.

## Decision

**B: split.** Two constants:

- `SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION`
  (`src/schema/session-start-preflight.ts`): the **setup floor**. Bump
  this alone when agent-preflight ships a change to what `--setup`
  itself does (a new `--setup` capability, a fix to the conditional
  build decision, etc.). Consumers: `harness doctor`'s
  `session_start_preflight.setup` version check
  (`src/cli/doctor/session-start-preflight-setup-version.ts`).
- `GIT_PREFLIGHT_HOOK_MIN_VERSION` (`src/cli/init/templates.ts`): the
  **hook floor**, the `min_version` the `init`-generated `git-preflight`
  `SessionStart` hook renders into a fresh manifest. Bump this alone
  when agent-preflight ships a change relevant to the hook GENERICALLY
  (a fix to what `harness session-start preflight` needs from the
  underlying `preflight run`, independent of `--setup`). Consumers:
  `FULL_TEMPLATE`'s `git-preflight` hook
  (`src/cli/init/templates.ts`), and the `init` wizard's dependency
  table for the `preflight` binary (`src/cli/init/dependencies.ts`),
  which must never advertise a floor lower than what the generated
  manifest itself declares.

Both constants are `"0.6.0"` today: agent-preflight 0.6.0 is, so far,
the release both rationales point at simultaneously. A fresh manifest
therefore warns exactly as it did before this change. The two are
independent named exports from this point forward and CAN diverge on
the next bump; when a bump applies to only one rationale, only that
constant moves.

Who pays under the adopted option: maintainers carry two floors and two
rationales instead of one; in exchange, an operator who never enables
`setup` stops paying for setup-only bumps, and the double-report
behaviour (residual 2) stays exactly as documented today (unchanged by
this decision; it is a property of two independently-firing checks, not
of one-constant-vs-two).

## Prerelease handling

**Decision: a prerelease is BELOW its base release, for both the hook
floor and the setup floor.** `preflight 0.6.0-rc.1` does not meet a
`0.6.0` floor on either check: it does not carry the build step the
floor exists to guarantee, and semver precedence already puts a
prerelease below its release (`0.6.0-rc.1 < 0.6.0`).

Both checks (`checkHookVersion` and
`checkSessionStartPreflightSetupVersion`) already share the same
underlying comparator,
`compareNumericVersions` (`src/io/version-compare.ts:27#"export function compareNumericVersions(a: string, b: string): number {"`,
at the time of this decision also reached through a same-file
`compareVersions` alias in `src/cli/doctor/index.ts` that task
`db44ab46` later removed once its last call sites moved off it, see the
Update below), and both duplicate the same `/(\d+(?:\.\d+){0,3})/`
extraction regex.
The fix is made ONCE in the shared leaf module,
`src/io/version-compare.ts`: a new `parseProbedVersion` extracts the
numeric run AND whether a `-`-prefixed suffix followed it, and a new
`compareVersionFloor` treats a prerelease `actual` as strictly below an
equal-numeric `required` floor. `checkHookVersion` and
`checkSessionStartPreflightSetupVersion` are switched to the new pair;
the existing `compareNumericVersions`/`NUMERIC_VERSION_PATTERN` contract
(2-argument, no prerelease awareness) is UNCHANGED and untouched call
sites keep their existing behaviour.

**Scope note, cross-consumer effect.** `checkHookVersion` is generic:
every `hooks[]` entry that declares `min_version` + `version_command`
(not only `git-preflight`) now also rejects a prerelease actual version
at an equal-numeric floor. This is an intentional, in-scope behaviour
change for the shared hook-version check (asked for by this task's
brief: "if the existing hook-version comparison is shared code, fix it
once and cover both consumers"), not limited to `git-preflight`.

**Boundary: `hooks[]` only, for now (as shipped by this task; reopened
and resolved by task `db44ab46`, see the Update below).** Prerelease
rejection was NOT extended to the other five `min_version` floor checks
in this codebase at the time of this decision; they kept their
pre-existing raw-regex extraction and `compareNumericVersions`
comparison, unchanged, and so stayed prerelease-blind (a probed
`X.Y.Z-rc.1` parsed as `X.Y.Z` and could satisfy an `X.Y.Z` floor on
every one of them): `tools.cli[]` and `tools.mcp[]` in `harness doctor`,
`tools.cli[]` in `harness validate` (a separate implementation of the
same `tools.cli[]` contract for a different verb), `memory.router`'s
version floor, and policy-pack-level floors.

One consequence at the time: a single `harness doctor` run against a
probed `0.6.0-rc.1` rejected it for the `git-preflight` hook (and any
other `hooks[]` entry with a `min_version`) but accepted it for
`tools.mcp[]`, `memory.router`, and any `policy_packs[]` floor: the same
probed version read `below_floor` on one check and clean on another,
side-by-side in the same report. That inconsistency was an accepted
cost of this task's narrow scope (see Who pays above), not a bug. Task
`db44ab46` (see Update below) has since closed it.

## Update (task db44ab46): the boundary is resolved, extend to all five

**Decision: extend.** All five previously prerelease-blind
`min_version` floor checks now use `parseProbedVersion` plus
`compareVersionFloor`, the same pair `checkHookVersion` and
`checkSessionStartPreflightSetupVersion` already used, so a probed
`X.Y.Z-rc.1` reads `below_floor` against an equal-numeric `X.Y.Z` floor
on every `min_version` check in this codebase, not only `hooks[]`:

- `tools.cli[]` in `harness doctor`
  (`checkCli`, `src/cli/doctor/index.ts:270#"const parsed = parseProbedVersion(stdout);"`).
- `tools.mcp[]` in `harness doctor`
  (`checkMcpVersions`, `src/cli/doctor/index.ts:344#"const parsed = parseProbedVersion(stdout);"`).
- `tools.cli[]` in `harness validate`
  (`src/cli/validate/checks.ts:163#"const parsed = parseProbedVersion(stdout);"`),
  a separate implementation of the same `tools.cli[]` contract for a
  different verb.
- `memory.router`'s version floor
  (`src/probes/memory.ts:184#"const parsed = parseProbedVersion(stdout);"`).
- Policy-pack-level floors
  (`src/policy-packs/version-check.ts:104#"const parsed = parseProbedVersion(stdout);"`).

Who pays: operators running a release candidate of any of these five
tools now see a below-floor diagnostic until the release ships, and the
severity differs by surface. `tools.cli[]` in `harness doctor`
(`checkCli`) and `tools.cli[]` in `harness validate` both push
`severity`/`status: "error"`, so an RC there is a hard failure: it is
counted into doctor's `errorCount` and validate's `errorCount`, not
merely surfaced as a warning. `tools.mcp[]` in `harness doctor`
(`checkMcpVersions`) and `memory.router`'s version probe both push
`status: "warn"`, counted into `warningCount`, matching what
`git-preflight` and `session_start_preflight.setup` already did. The
policy-pack-level floor pushes a `below_floor` gap counted into
`harness doctor`'s `warningCount`
(`src/cli/doctor/index.ts:1074#"warningCount += report.policyPacks.versionGaps.length;"`),
the same footing as `tools.mcp[]` and `memory.router`, not a hard
failure. This is correct under semver precedence (an RC is not the
release), not a regression, but it means the two `tools.cli[]` checks
can flip an operator's `doctor`/`validate` exit code non-zero on an RC
where they previously passed silently. Maintainers keep exactly one
comparator instead of two.
The accepted cost this ADR's Consequences section named for `hooks[]`
(a `version_command` reporting a git-describe or platform suffix now
also reads `below_floor` on an exact numeric tie) applies identically to
all five; see `docs/CLI.md`'s VERSION CAVEAT.

## Reopen criteria

- A third consumer needs the hook-generic floor value cited independent
  of `git-preflight`'s own hook entry (currently only `templates.ts`'s
  `FULL_TEMPLATE` and `dependencies.ts` read it).
- The two constants diverge in practice and the resulting double-warning
  UX (residual 2, still by design) turns out to confuse operators enough
  to warrant collapsing the generic hook floor check for
  `git-preflight` specifically into the setup check (would need its own
  design, not assumed here).
- RESOLVED by task `db44ab46` (see the Update section above): all five
  previously prerelease-blind `min_version` floor checks now reject
  prereleases the same way `hooks[]` does.

## Consequences

- `src/schema/session-start-preflight.ts` keeps
  `SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION` as the setup floor
  only; its VERSION CAVEAT comment is rewritten to describe the split
  instead of claiming one shared constant.
- `src/cli/init/templates.ts` gains its own exported
  `GIT_PREFLIGHT_HOOK_MIN_VERSION` constant and renders it, not the
  setup floor, into `FULL_TEMPLATE`'s `git-preflight` hook.
- `src/cli/init/dependencies.ts`'s wizard-facing `preflight` dependency
  entry reads `GIT_PREFLIGHT_HOOK_MIN_VERSION` (what the generated
  manifest declares), not the setup floor.
- `docs/CLI.md`'s VERSION CAVEAT bullet is revised to name both
  constants and restate the double-report note against the split.
- The tying tests from task `6993d9b5`
  (`tests/cli/init-full-template-pins.test.ts`,
  `tests/cli/init-dependencies.test.ts`) are rewritten to pin each
  floor to its actual consumer by source identity (a static check of
  which constant's interpolation appears in the rendered template's
  source, not only a value comparison, since both constants share the
  value `"0.6.0"` today and a value-only assertion would not discriminate
  a swap between them).
- New tests pin the prerelease decision for both `checkHookVersion` and
  `checkSessionStartPreflightSetupVersion` (`0.6.0-rc.1` reported as
  `below_floor` against a `0.6.0` floor on both).
- Accepted cost: a `hooks[]` entry whose `version_command` reports a
  git-describe suffix (`0.6.0-4-gabc123`) or a platform suffix
  (`0.6.0-linux-x64`) now also reads `below_floor` even when the
  underlying release genuinely meets the floor, when its numeric run
  exactly equals the floor (`compareVersionFloor` returns the numeric
  comparison outright whenever it is non-zero, so the prerelease
  tie-break only bites on an exact numeric tie), since both shapes
  carry a `-` suffix the same way a real prerelease does. Workaround:
  lower that hook's `min_version` below its currently-installed
  version, or drop `version_command`/`min_version` from that hook entry
  entirely.
