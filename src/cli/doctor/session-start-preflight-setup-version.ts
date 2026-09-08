// Doctor finding for task 6993d9b5 (tracker id, harness repo): warns
// when `session_start_preflight.setup: true` is set but the resolved
// `preflight` binary is below the release that made `--setup` build
// code, not just install dependencies (agent-preflight 0.6.0, tag
// v0.6.0). On 0.5.0 `--setup` is dependency-install only, so an
// operator who enabled the knob against that version pays install time
// plus the `--setup` trust exposure (see session-start-preflight.ts's
// SECURITY note) for zero build benefit, with nothing today telling
// them so.
//
// Deliberately independent of the `git-preflight` manifest hook's own
// `min_version`/`version_command` (checked generically by
// `checkHookVersion` in ./index.ts): that floor is whatever the
// operator's own manifest declares, and existing manifests generated
// before task 6993d9b5 still carry the pre-existing 0.2.0 floor (bumped
// to `GIT_PREFLIGHT_HOOK_MIN_VERSION`, src/cli/init/templates.ts, in the
// `init` template only going forward, task 6993d9b5's second commit).
// This check hardcodes the build-capable floor so an operator on an
// unregenerated manifest still gets the warning the moment they flip
// `setup: true`, rather than only after re-running `harness init`.
//
// BY DESIGN: on a freshly generated manifest with `setup: true` probed
// against a stale preflight, this check and the generic `hooks[]`
// `min_version` walk both fire and both count toward `warningCount` (see
// `docs/CLI.md`'s VERSION CAVEAT). The two are not a duplicate of the
// same finding: the hook floor guards the `git-preflight` hook itself,
// this check guards the `--setup` build-step feature specifically, and
// a stale preflight breaks both independently.
//
// SPLIT FROM THE HOOK FLOOR (task 65952a0c, docs/decisions/2026-09-08-
// preflight-floors.md): this check's floor,
// `SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION`, and the hook
// floor above, `GIT_PREFLIGHT_HOOK_MIN_VERSION`, were ONE shared
// constant through task 6993d9b5. Both are `"0.6.0"` today and can
// diverge on a future bump that applies to only one rationale; see the
// ADR for the bump rule each carries.
//
// Silent (returns `undefined`) whenever `session_start_preflight.setup`
// is `false`/absent: the trust exposure and the install/build cost only
// exist once the knob is actually on, mirroring every other advisory
// doctor check's "no opinion when the feature isn't in use" gate.

import { parseProbedVersion, compareVersionFloor } from "../../io/version-compare.js";
import { PREFLIGHT_BIN } from "../session-start/index.js";
import { SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION } from "../../schema/session-start-preflight.js";
import type { Manifest } from "../../schema/index.js";

/**
 * The probe command run against the `preflight` binary on PATH. Matches
 * the `version_command` the shipped `git-preflight` hook template
 * declares (src/cli/init/templates.ts), same binary and `--version`
 * flag, but is not read FROM the manifest's hook entry: an operator
 * could rename/remove that hook while `session_start_preflight.setup`
 * stays on, and the check should still probe the binary the producer
 * (`harness session-start preflight`) actually spawns.
 */
export const PREFLIGHT_SETUP_VERSION_COMMAND = [PREFLIGHT_BIN, "--version"] as const;

export interface SessionStartPreflightSetupVersionFinding {
  /**
   * `layer_unresolvable` (task `1c4eb3ea`, round 2, D-027 item 3):
   * `doctor()`'s own project-scoped SECOND `loadManifest` call threw
   * (a malformed or unreadable cwd-derived project layer), so this
   * check could not even determine whether `setup` is on. Built
   * directly by `doctor()` (`src/cli/doctor/index.ts`), never by this
   * module's own `checkSessionStartPreflightSetupVersion`: that
   * function only ever sees a manifest that already degraded to
   * `setup: false` on such a failure, and bails out before producing
   * ANY finding for a `setup: false` manifest, which is exactly the
   * silence this kind replaces.
   */
  kind: "below_floor" | "probe_failed" | "parse_failed" | "layer_unresolvable";
  /**
   * Parsed installed version, when the probe succeeded and parsed.
   * Null otherwise. Always the NUMERIC run (`parseProbedVersion`'s
   * `version` field, e.g. "0.6.0"), never the probed prerelease/build
   * suffix: for a `below_floor` finding caused by a prerelease of the
   * floor (e.g. probed "0.6.0-rc.1" against a "0.6.0" `requiredVersion`),
   * `actualVersion` therefore equals `requiredVersion` even though
   * `kind` is `"below_floor"`: the numeric components tie, and
   * `compareVersionFloor`'s prerelease tie-break is what actually
   * failed the floor. `message` carries the full probed token
   * (including the suffix) for the human-facing distinction; this
   * field's JSON shape does not gain a new field for it. See
   * docs/decisions/2026-09-08-preflight-floors.md.
   */
  actualVersion: string | null;
  /** Always `SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION` today; carried on the finding so format.ts never re-imports the constant. */
  requiredVersion: string;
  message: string;
  /**
   * The cwd-derived (or explicit `--project`) project name `doctor`
   * fed its scoped, project-aware `loadManifest` call from when this
   * finding's `manifest` was resolved (task c88461c1, review round 3
   * residual). `null` when no project layer FILE actually decided the
   * result: no project name was derivable for that cwd (not inside a
   * git work tree, and no explicit `--project`), OR a name WAS
   * derivable but no matching `<home>/projects/<name>/harness.overrides.yaml`
   * exists on disk (task `1c4eb3ea`, round 2, D-027 item 1: `doctor()`
   * only sets this to a non-null name when `resolvePaths(...).projectLayer`
   * resolved, not merely whenever a name was attempted, so a
   * base/machine-decided warning stays genuinely distinguishable from
   * a project-decided one). Present only when the CALLER passes a
   * `projectName` argument (see below); `checkSessionStartPreflightSetupVersion`'s
   * own unit tests call it with just `manifest`/`versionProbe`, so
   * their findings carry no `projectName` key at all, not an
   * `undefined` value. The report's own top-level `project` field only
   * ever reflects an EXPLICIT `--project` (`opts.project ?? null`,
   * `doctor/index.ts`), never this derived name.
   */
  projectName?: string | null;
}

/**
 * Pure: manifest + versionProbe in, a finding out (or `undefined` when
 * there is nothing to flag). Mirrors `checkHookVersion`'s probe/parse
 * idiom (src/cli/doctor/index.ts) so the warning vocabulary
 * (`below_floor` / `probe_failed` / `parse_failed`) and version-regex
 * parsing stay consistent across both checks, without importing from
 * index.ts (which would create a cycle back into this module's own
 * caller).
 *
 * `projectName` (task c88461c1, review round 3 residual; task
 * `1c4eb3ea`): OPTIONAL third argument, carried onto every returned finding
 * unchanged (see {@link SessionStartPreflightSetupVersionFinding.projectName}'s
 * doc comment). `doctor()` always passes it (the SAME name it derived
 * for its own scoped load, or `null`); every pre-existing direct call
 * to this pure function in its own unit tests omits it, so those
 * findings' shape is unchanged.
 */
export function checkSessionStartPreflightSetupVersion(
  manifest: Manifest,
  versionProbe: (cmd: readonly string[]) => string | null,
  projectName?: string | null,
): SessionStartPreflightSetupVersionFinding | undefined {
  if (!manifest.session_start_preflight.setup) return undefined;

  const withProjectName = (
    finding: Omit<SessionStartPreflightSetupVersionFinding, "projectName">,
  ): SessionStartPreflightSetupVersionFinding =>
    projectName !== undefined ? { ...finding, projectName } : finding;

  const required = SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION;
  const stdout = versionProbe(PREFLIGHT_SETUP_VERSION_COMMAND);
  if (stdout === null) {
    return withProjectName({
      kind: "probe_failed",
      actualVersion: null,
      requiredVersion: required,
      message:
        `session_start_preflight.setup is enabled but the installed preflight version could not ` +
        `be determined (probe for "${PREFLIGHT_SETUP_VERSION_COMMAND.join(" ")}" failed); the ` +
        `build step needs preflight >= ${required}`,
    });
  }
  // parseProbedVersion/compareVersionFloor (not plain compareNumericVersions):
  // a preflight release candidate of the floor (e.g. "0.6.0-rc.1") must not
  // count as build-capable. See docs/decisions/2026-09-08-preflight-floors.md.
  const parsed = parseProbedVersion(stdout);
  if (!parsed) {
    return withProjectName({
      kind: "parse_failed",
      actualVersion: null,
      requiredVersion: required,
      message:
        `session_start_preflight.setup is enabled but the installed preflight version could not ` +
        `be parsed from "${stdout.trim()}"; the build step needs preflight >= ${required}`,
    });
  }
  const { version: actual, isPrerelease, token } = parsed;
  if (compareVersionFloor(actual, isPrerelease, required) < 0) {
    return withProjectName({
      kind: "below_floor",
      actualVersion: actual,
      requiredVersion: required,
      message:
        `session_start_preflight.setup is enabled but installed preflight v${token} < ${required}: ` +
        `--setup on v${token} is dependency-install only (no build step); upgrade preflight ` +
        `(npm i -g @lannguyensi/agent-preflight) or set session_start_preflight.setup: false`,
    });
  }
  return undefined;
}
