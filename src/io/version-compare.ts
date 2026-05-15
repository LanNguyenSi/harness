/**
 * Numeric semver compare for `min_version` gates in `harness doctor`.
 * Used by the `tools.mcp[]`, `memory.router`, and `hooks[]` version
 * checks. Lives in `src/io/` (a leaf module with no domain imports) so
 * `runtime/`-, `policies/`-, and `cli/`-side consumers can all depend
 * on it without re-creating the runtime/policies module-init cycle that
 * task 1272feb6 just broke.
 *
 * Returns +1 if `a > b`, -1 if `a < b`, 0 on equality or on any parse
 * failure. Pads short components with zeros (`1.2` is treated as
 * `1.2.0` for the purposes of comparison with `1.2.0`).
 */
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
