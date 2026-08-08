import { z } from "zod";

// `stale_base_check` (task ce3903b0, incident ea8becf5) — optional,
// default-OFF config block for `harness session-start stale-base-check`.
// The producer itself lives in
// src/cli/session-start/stale-base-check.ts; this schema only carries the
// manifest-declared knobs it reads.
//
// Every field is optional: the producer resolves its own sane defaults
// (remote -> "origin", default_branch -> resolved from
// refs/remotes/origin/HEAD, fetch_timeout_ms -> 8000) when a field is
// omitted, so declaring `stale_base_check: { enabled: true }` alone is a
// complete, valid config. `enabled` itself defaults to `false`: an ABSENT
// `stale_base_check:` block and a PRESENT-but-`enabled: false` block
// behave identically (both skip, and — the point of opt-in here — neither
// ever spends a network round-trip), so existing manifests parse
// unchanged and this companion never surprises an operator with new
// session-start network I/O until they explicitly ask for it. See the
// producer module's header comment for the full WHERE/SCHÄRFE rationale.
export const StaleBaseCheckSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Remote name to fetch the live default-branch tip from. Defaults to
    // "origin" when omitted.
    remote: z.string().min(1).optional(),
    // Explicit default-branch override (e.g. "main"). When omitted, the
    // producer resolves it from `refs/remotes/origin/HEAD` on disk — that
    // lookup is safe to trust for the branch NAME (which essentially never
    // changes after initial repo setup), unlike trusting that ref's SHA
    // for staleness, which is exactly the bug this task closes.
    default_branch: z.string().min(1).optional(),
    // Per-`git` subprocess timeout in ms (applied individually to the
    // fetch, and to each follow-up rev-list/log call). Defaults to 8000
    // when omitted.
    fetch_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

export type StaleBaseCheckConfig = z.infer<typeof StaleBaseCheckSchema>;
