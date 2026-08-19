import { z } from "zod";

// `toolchain_parity` (task: PATH-Shim-Vorfall 2026-07-22) — optional,
// default-OFF config block for `harness session-start toolchain-parity`.
// The producer itself lives in src/cli/session-start/toolchain-parity.ts;
// this schema only carries the manifest-declared knobs it reads.
//
// Every field is optional: the producer resolves its own sane defaults
// (machine_state_dir -> ~/.harness/machine-state, profile ->
// os.hostname(), workspace_root -> the session cwd) when a field is
// omitted, so declaring `toolchain_parity: { enabled: true }` alone is a
// complete, valid config. `enabled` itself defaults to `false`: an
// ABSENT `toolchain_parity:` block and a PRESENT-but-`enabled: false`
// block behave identically (both skip), so existing manifests parse
// unchanged and the new companion is strictly opt-in.
export const ToolchainParitySchema = z
  .object({
    enabled: z.boolean().default(false),
    // Directory the per-machine snapshot JSON files live in. Shared by
    // every machine that wants to compare toolchains — agent-memory-sync
    // (agent-memory PR #64) is what actually transports files in and out
    // of this directory across machines; this producer only reads/writes
    // it locally.
    machine_state_dir: z.string().min(1).optional(),
    // This machine's own profile name — the snapshot is written to
    // `<machine_state_dir>/<profile>.json` and every OTHER `*.json` in
    // the directory is treated as a peer to compare against. Defaults to
    // a filename-sanitized os.hostname() when omitted.
    profile: z.string().min(1).optional(),
    // Root directory `.ai/workflow/manifest.json` (the orchestrator-
    // workflow kit's own version marker) is read from, for the OW-Kit
    // version drift check. Defaults to the session cwd.
    workspace_root: z.string().min(1).optional(),
    // Advisory staleness threshold, in days, for a peer snapshot's own
    // `timestamp` (task c1b5ade5, hardening follow-up to the initial
    // 690fba7c drop). Undefined (default) disables the check entirely —
    // no snapshot is ever "too old" to compare. When set, a peer whose
    // snapshot age exceeds this threshold gets an EXTRA stderr note
    // flagging it as stale; the comparison itself (and `driftCount`) is
    // unchanged — staleness is a caveat on trustworthiness, not a drift
    // finding, so it never inflates the drift count.
    stale_after_days: z.number().positive().optional(),
  })
  .strict();

export type ToolchainParityConfig = z.infer<typeof ToolchainParitySchema>;
