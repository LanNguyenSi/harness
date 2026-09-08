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
  kind: "below_floor" | "probe_failed" | "parse_failed";
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
}

/**
 * Pure: manifest + versionProbe in, a finding out (or `undefined` when
 * there is nothing to flag). Mirrors `checkHookVersion`'s probe/parse
 * idiom (src/cli/doctor/index.ts) so the warning vocabulary
 * (`below_floor` / `probe_failed` / `parse_failed`) and version-regex
 * parsing stay consistent across both checks, without importing from
 * index.ts (which would create a cycle back into this module's own
 * caller).
 */
export function checkSessionStartPreflightSetupVersion(
  manifest: Manifest,
  versionProbe: (cmd: readonly string[]) => string | null,
): SessionStartPreflightSetupVersionFinding | undefined {
  if (!manifest.session_start_preflight.setup) return undefined;

  const required = SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION;
  const stdout = versionProbe(PREFLIGHT_SETUP_VERSION_COMMAND);
  if (stdout === null) {
    return {
      kind: "probe_failed",
      actualVersion: null,
      requiredVersion: required,
      message:
        `session_start_preflight.setup is enabled but the installed preflight version could not ` +
        `be determined (probe for "${PREFLIGHT_SETUP_VERSION_COMMAND.join(" ")}" failed); the ` +
        `build step needs preflight >= ${required}`,
    };
  }
  // parseProbedVersion/compareVersionFloor (not plain compareNumericVersions):
  // a preflight release candidate of the floor (e.g. "0.6.0-rc.1") must not
  // count as build-capable. See docs/decisions/2026-09-08-preflight-floors.md.
  const parsed = parseProbedVersion(stdout);
  if (!parsed) {
    return {
      kind: "parse_failed",
      actualVersion: null,
      requiredVersion: required,
      message:
        `session_start_preflight.setup is enabled but the installed preflight version could not ` +
        `be parsed from "${stdout.trim()}"; the build step needs preflight >= ${required}`,
    };
  }
  const { version: actual, isPrerelease, token } = parsed;
  if (compareVersionFloor(actual, isPrerelease, required) < 0) {
    return {
      kind: "below_floor",
      actualVersion: actual,
      requiredVersion: required,
      message:
        `session_start_preflight.setup is enabled but installed preflight v${token} < ${required}: ` +
        `--setup on v${token} is dependency-install only (no build step); upgrade preflight ` +
        `(npm i -g @lannguyensi/agent-preflight) or set session_start_preflight.setup: false`,
    };
  }
  return undefined;
}
