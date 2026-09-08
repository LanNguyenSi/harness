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
   (`checkHookVersion`, `src/cli/doctor/index.ts:466-506#": { status: \"ok\", message: \`v${actual} ≥ ${hook.min_version}\` };"`)
   and the setup-specific check
   (`checkSessionStartPreflightSetupVersion`,
   `src/cli/doctor/session-start-preflight-setup-version.ts:83-122#"return undefined;"`).
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
underlying comparator, `compareNumericVersions` (aliased `compareVersions`
in `src/cli/doctor/index.ts:359-361#"const compareVersions = compareNumericVersions;"`),
and both duplicate the same `/(\d+(?:\.\d+){0,3})/` extraction regex.
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
once and cover both consumers"), not limited to `git-preflight`. It is
NOT extended to the `tools.cli[]` and `tools.mcp[]` version checks in
the same file (`src/cli/doctor/index.ts:261#"const m = stdout.match"`
and `src/cli/doctor/index.ts:331#"const m = stdout.match"`), which keep
the old extraction/comparison unchanged: those are a different, out-of-scope
feature surface for this task, and their own operators may rely on a
`-rc`/`-beta` version passing (npm prerelease tags are common for CLI
tools in a way agent-preflight's release process is not). Extending
prerelease rejection to those two checks, if desired, is future work,
not decided here.

## Reopen criteria

- A third consumer needs the hook-generic floor value cited independent
  of `git-preflight`'s own hook entry (currently only `templates.ts`'s
  `FULL_TEMPLATE` and `dependencies.ts` read it).
- The two constants diverge in practice and the resulting double-warning
  UX (residual 2, still by design) turns out to confuse operators enough
  to warrant collapsing the generic hook floor check for
  `git-preflight` specifically into the setup check (would need its own
  design, not assumed here).
- The `tools.cli[]` / `tools.mcp[]` checks are asked to also reject
  prereleases; revisit the scope note above rather than assuming the
  same fix applies unexamined.

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
