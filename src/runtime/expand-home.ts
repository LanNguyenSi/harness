// Expand a leading `~/` (or bare `~`) to the operator's HOME directory.
// Defense-in-depth: MCP `env:` values and `command:` array entries in
// the manifest are passed verbatim to Node's `spawn`, which does NOT
// shell-interpolate. A literal `~/.evidence-ledger/ledger.db` in env
// scatters a cwd-relative `./~/...` rogue path; the
// agent-tasks/42d224a6 incident was caused by exactly this. The
// validate-time warning (src/cli/validate/checks.ts) catches the
// common case at apply, but a manifest that bypasses validate (or
// that the operator ignored the warning on) still has the footgun.
// Expanding here turns it into a non-issue.
//
// Scope:
//   - Leading `~/` substring or bare `~` expands.
//   - Anywhere-else `~/` in the middle of a string stays literal
//     (e.g. an SSH-style `git@github.com:user/repo~/tag` would not
//     be touched, though such shapes don't appear in practice).
//   - `${HOME}` shell-style interpolation is NOT supported here; that
//     is a separate scope (shell-style would invite further surprises
//     like `${USER}` and unset-var ambiguity).
//   - Inherited `process.env` values are NOT expanded by callers
//     (only the manifest's `mcpEnv` overrides are). The operator's
//     shell owns its own exports; harness only owns what the manifest
//     declares.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Expand `~` / `~/...` in `value` against `home`. Returns `value`
 * unchanged when no leading tilde is present. `home` defaults to
 * `os.homedir()` so callers don't need to pass it; tests inject a
 * fixed home for determinism.
 */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/**
 * Map every value in an env-style record through {@link expandHome}.
 * Returns a new object; the input is not mutated. `undefined` input
 * returns `undefined` so callers can pass through optional configs
 * without a guard.
 */
export function expandHomeInEnv(
  env: Record<string, string> | undefined,
  home: string = os.homedir(),
): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = expandHome(v, home);
  }
  return out;
}
