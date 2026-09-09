/**
 * Numeric semver compare for `min_version` gates in `harness doctor`.
 * Used by the `tools.mcp[]`, `tools.cli[]`, `memory.router`, `hooks[]`,
 * and `policy_packs[]` version checks. Lives in `src/io/` (a leaf
 * module with no domain imports) so `runtime/`-, `policies/`-, and
 * `cli/`-side consumers can all depend on it without re-creating the
 * runtime/policies module-init cycle that task 1272feb6 just broke.
 *
 * Returns +1 if `a > b`, -1 if `a < b`, 0 on equality or on any parse
 * failure. Pads short components with zeros (`1.2` is treated as
 * `1.2.0` for the purposes of comparison with `1.2.0`).
 *
 * NUMERIC_VERSION_PATTERN is the schema-level guard that ensures
 * `min_version` values feeding this comparator are well-formed numeric
 * semver. Without it, a malformed value (`"latest"`, `"v1.0"`,
 * `"1.0.0-alpha"`) parses to `NaN` components below, which the NaN
 * branch then maps to 0 (equality), silently swallowing the version
 * floor. Schema fields that feed `compareNumericVersions` must wear
 * this pattern, and `NUMERIC_VERSION_MESSAGE` provides a stable
 * operator-facing error string shared across schemas.
 */
export const NUMERIC_VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

export const NUMERIC_VERSION_MESSAGE =
  'min_version must be numeric semver-shape: digits separated by up to three dots (e.g. "1", "1.2", "1.2.3", "1.2.3.4"). Pre-release suffixes and leading "v" are rejected.';

export function compareNumericVersions(a: string, b: string): number {
  const aa = a.split(".").map((n) => Number.parseInt(n, 10));
  const bb = b.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const ai = aa[i] ?? 0;
    const bi = bb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/**
 * Extracts a numeric-semver-shape version from free-form `--version`
 * probe output (e.g. "preflight 0.6.0-rc.1\n"), plus whether the
 * matched numeric run was immediately followed by a `-` prerelease/
 * build suffix. Matches ONLY the leading numeric run itself (mirrors
 * the pre-existing `/(\d+(?:\.\d+){0,3})/` extraction every version
 * floor check used before task 65952a0c), so `version` here is exactly
 * what a plain, non-prerelease-aware caller would have parsed; the
 * `isPrerelease` flag is the new information a caller can act on.
 *
 * Returns `null` when no numeric run is found at all (unparseable
 * probe output), matching the pre-existing "no match" contract.
 *
 * Two suffix strings are returned, deliberately different:
 * - `raw` is the regex's own match (`m[0]`): the numeric run plus a
 *   `-` suffix restricted to `[0-9A-Za-z.]`, so it TRUNCATES a suffix
 *   containing any other character (a git-describe suffix's second
 *   hyphen, e.g. "0.6.0-4-gabc123" matches only as far as "0.6.0-4";
 *   a platform suffix, e.g. "0.6.0-linux-x64" matches only as far as
 *   "0.6.0-linux"). Kept only because `isPrerelease` is derived from
 *   whether `m[2]` (the restricted suffix group) matched at all.
 * - `token` is the full probed version token as printed: everything
 *   from the start of the numeric run up to the next whitespace
 *   character (or end of string), with no character-class
 *   restriction. This is what a human-facing message should quote;
 *   `raw`'s truncation would otherwise misreport what the probe
 *   actually printed. See docs/decisions/2026-09-08-preflight-floors.md.
 */
export function parseProbedVersion(
  stdout: string,
): { version: string; isPrerelease: boolean; raw: string; token: string } | null {
  const m = stdout.match(/(\d+(?:\.\d+){0,3})(-[0-9A-Za-z.]+)?/);
  if (!m || !m[1] || m.index === undefined) return null;
  const rest = stdout.slice(m.index);
  const wsIndex = rest.search(/\s/);
  const token = wsIndex === -1 ? rest : rest.slice(0, wsIndex);
  return { version: m[1], isPrerelease: m[2] !== undefined, raw: m[0], token };
}

/**
 * `compareNumericVersions`, but a prerelease `a` (as reported by
 * `parseProbedVersion`'s `isPrerelease`) is treated as strictly BELOW
 * a numerically-equal `b` floor, matching semver precedence
 * (`0.6.0-rc.1 < 0.6.0`) and the intent every `min_version` floor in
 * this codebase already carries: `NUMERIC_VERSION_PATTERN` rejects a
 * prerelease shape for `b` itself (a `min_version` field can never
 * BE a prerelease), so `aIsPrerelease` is the only side this can ever
 * apply to. When the base numeric comparison is not a tie, the
 * prerelease flag is irrelevant and the numeric result wins outright
 * (a genuinely older release, prerelease or not, is still older).
 *
 * Decision: docs/decisions/2026-09-08-preflight-floors.md (see the
 * Reopen criteria section for task db44ab46, which extended the rule
 * from its original two consumers to all `min_version` floor checks in
 * this codebase). Consumers as of task db44ab46: `checkHookVersion` and
 * `checkCli`'s `tools.cli[]` check plus `checkMcpVersions`'s
 * `tools.mcp[]` check (all in src/cli/doctor/index.ts),
 * `checkSessionStartPreflightSetupVersion`
 * (src/cli/doctor/session-start-preflight-setup-version.ts), validate's
 * `tools.cli[]` check (src/cli/validate/checks.ts), `memory.router`'s
 * version probe (src/probes/memory.ts), and the pack-level floor
 * (src/policy-packs/version-check.ts).
 */
export function compareVersionFloor(a: string, aIsPrerelease: boolean, b: string): number {
  const cmp = compareNumericVersions(a, b);
  if (cmp !== 0) return cmp;
  return aIsPrerelease ? -1 : 0;
}
