// `auto_approve` pack-config parsing and shared conventions, split out
// alongside lifecycle.ts (structural sibling of the former monolithic
// understanding-before-execution-runtime.ts, agent-tasks 348a4d42).
// Implements slice 1 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks 74b4b17d): the strict pack-config block that lets an
// operator opt a permission mode into the hook-written signed
// auto-marker path, plus the shared `approvedBy` / ledger-tag
// conventions the hook and doctor consume so there is one authority
// for the string shapes instead of each caller reimplementing them.
//
// This module owns no gate decision and no marker write: it only
// parses the opt-in config (fail-closed: any malformed shape is
// treated as "not opted in", never as a partial default) and builds /
// parses the string conventions the ADR's "Audit and doctor" section
// documents. The PreToolUse hook (auto-path condition checks) and
// `harness doctor` (auto-approval listing) are the consumers; both
// land in later slice-1 tasks and import from here.

/**
 * Prefix every auto-minted marker's `approvedBy` carries, distinguishing
 * it from a human `harness approve understanding` marker (which carries
 * the operator's own identity string, never this prefix).
 */
export const AUTO_APPROVED_BY_PREFIX = "auto-mode:";

/** The harness identifier the Claude Code PreToolUse hook mints markers for. */
export const CLAUDE_CODE_HARNESS = "claude-code";

/**
 * The harness identifier the Codex PreToolUse hook mints markers for
 * (slice 2 of the ADR: same auto path, same fail-closed conditions, a
 * distinct `approvedBy` segment so an audit can tell the two runtimes
 * apart). Deliberately NOT re-exported through
 * `understanding-before-execution/index.ts`: its only consumer is
 * `src/cli/pack/hook-codex-pre-tool-use.ts`, and widening the runtime
 * shim's pinned public surface (tests/policy-packs/ube-export-surface.test.ts)
 * is a separate, conscious act.
 */
export const CODEX_HARNESS = "codex";

/**
 * Build the `approvedBy` value the hook writes into a signed auto-marker:
 * `auto-mode:<harness>:<mode>`, for example `auto-mode:claude-code:bypassPermissions`
 * or `auto-mode:codex:bypassPermissions` ("Audit and doctor" in the ADR).
 * Neither `harness` nor `mode` is validated here; callers pass
 * already-known-good values (one of the fixed harness constants above and
 * a `when`-matched mode string).
 */
export function autoApprovedByFor(harness: string, mode: string): string {
  return `${AUTO_APPROVED_BY_PREFIX}${harness}:${mode}`;
}

/** Parsed shape of an `approvedBy` string minted by {@link autoApprovedByFor}. */
export interface ParsedAutoApprovedBy {
  harness: string;
  mode: string;
}

/**
 * Parse an `approvedBy` string back into its harness/mode pair. Returns
 * `null` for anything that is not exactly `auto-mode:<harness>:<mode>`
 * with both segments non-empty, including a human marker's `approvedBy`
 * (which never carries this prefix) and a malformed or truncated auto
 * value. A slice 3 delegation suffix (`;delegated:<parent-sid>`) is
 * tolerated: it is stripped before parsing and otherwise ignored, per
 * the ADR's "Audit and doctor" convention that the delegation binding
 * packs into the same field without changing the harness/mode shape.
 */
export function parseAutoApprovedBy(approvedBy: unknown): ParsedAutoApprovedBy | null {
  if (typeof approvedBy !== "string") return null;
  if (!approvedBy.startsWith(AUTO_APPROVED_BY_PREFIX)) return null;
  const withoutPrefix = approvedBy.slice(AUTO_APPROVED_BY_PREFIX.length);
  const [withoutDelegation] = withoutPrefix.split(";delegated:");
  const segments = (withoutDelegation ?? "").split(":");
  if (segments.length !== 2) return null;
  const [harness, mode] = segments;
  if (!harness || !mode) return null;
  return { harness, mode };
}

/**
 * Build the audit-only ledger fact the ADR's "Audit and doctor" section
 * names: `understanding-auto-approved:<sid>`, distinct from the human
 * `understanding-approved:<sid>` tag (`ledger.ts`), following the same
 * `...:forced:<field>` suffix precedent the ADR cites. Ledger only, never
 * consulted for the gate decision itself.
 */
export function autoApprovedLedgerTagFor(sessionId: string): string {
  return `understanding-auto-approved:${sessionId}`;
}

/**
 * The harness identifiers `auto_approve.harnesses` accepts, in the order
 * the schema and every diagnostic list them. Shared with the pack's zod
 * `configSchema` (`../understanding-before-execution.ts`) so the lint-time
 * enum and this runtime parser cannot drift apart.
 */
export const AUTO_APPROVE_HARNESS_VALUES = [CLAUDE_CODE_HARNESS, CODEX_HARNESS] as const;

/**
 * What `auto_approve.harnesses` resolves to when the key is ABSENT.
 * Claude Code only, deliberately: slice 1 shipped `auto_approve` as a
 * Claude-only opt-in, so a repo that opted in before slice 2 must keep
 * exactly the meaning it had — adding the Codex hook to the shared body
 * must not silently extend an existing opt-in to a second runtime
 * (reviewer round-1 finding on slice 2). Opting Codex in is an explicit,
 * visible config edit.
 */
export const DEFAULT_AUTO_APPROVE_HARNESSES: readonly string[] = [CLAUDE_CODE_HARNESS];

/** Parsed, validated `auto_approve` pack-config block. */
export interface AutoApproveConfig {
  /** Allowlist of `permission_mode` payload literals eligible for auto-approval. */
  when: string[];
  /**
   * Allowlist of HARNESSES whose PreToolUse hook may take the auto path
   * at all. Always non-empty: an absent key resolves to
   * {@link DEFAULT_AUTO_APPROVE_HARNESSES}, and every malformed shape
   * fails the whole block closed rather than defaulting.
   */
  harnesses: string[];
}

const KNOWN_AUTO_APPROVE_KEYS = new Set(["when", "harnesses", "require_report"]);

/**
 * Parse the optional `auto_approve` pack-config block
 * (docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Option A").
 *
 * FAIL CLOSED, unlike {@link parseApprovalLifecycle}'s best-effort
 * fallback: this block is an opt-IN to a hook-side signing path
 * (hardening item 3 in the ADR's threat model (b) — `require_report:
 * false` must be a schema error, not a silently-ignored key), so any
 * malformed shape here means "not opted in" (`null`), never a partial
 * or default-filled config that could still enable the auto path. The
 * `configSchema` zod block in `../understanding-before-execution.ts` is
 * the first line of defence (`harness validate` / `harness doctor`
 * reject a malformed manifest at lint time); this parser is the second,
 * defensive line for the runtime hook, which must not trust that every
 * config it sees on disk passed the schema.
 *
 * `undefined` / `null` (the block is simply absent) returns `null`
 * silently — that is the ordinary "not opted in" case, not a warning.
 * Every other malformed shape writes exactly one stderr line and
 * returns `null`.
 *
 * `label` is the stderr prefix of the calling hook, so a Codex-side
 * warning reads `harness pack hook codex: ...` like every other line
 * that hook writes. The default reproduces the Claude Code hook's
 * wording byte-for-byte.
 */
export function parseAutoApprove(
  raw: unknown,
  stderr?: { write(s: string): void } | null,
  label = "harness pack hook",
): AutoApproveConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    stderr?.write(
      `${label}: config.auto_approve ignored (expected object, got ${typeof raw})\n`,
    );
    return null;
  }
  const obj = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter((k) => !KNOWN_AUTO_APPROVE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    stderr?.write(
      `${label}: config.auto_approve ignored (unknown key(s): ${unknownKeys.join(", ")})\n`,
    );
    return null;
  }

  const whenRaw = obj["when"];
  if (!Array.isArray(whenRaw) || whenRaw.length === 0) {
    stderr?.write(
      `${label}: config.auto_approve.when ignored (expected a non-empty string[], got ${
        Array.isArray(whenRaw) ? "empty array" : typeof whenRaw
      })\n`,
    );
    return null;
  }
  const when: string[] = [];
  for (const v of whenRaw) {
    if (typeof v !== "string" || v.length === 0) {
      stderr?.write(
        `${label}: config.auto_approve.when ignored (every entry must be a non-empty string, got ${typeof v})\n`,
      );
      return null;
    }
    when.push(v);
  }

  // `harnesses`: absent means the slice-1 default (Claude Code only).
  // Present means an exact, non-empty, duplicate-free list of the known
  // harness identifiers — anything else fails the whole block closed,
  // like every other malformed shape here, so a typo'd entry can never
  // widen the opt-in to a runtime the operator did not name.
  const harnessesRaw = obj["harnesses"];
  let harnesses: string[] = [...DEFAULT_AUTO_APPROVE_HARNESSES];
  if (harnessesRaw !== undefined) {
    if (!Array.isArray(harnessesRaw) || harnessesRaw.length === 0) {
      stderr?.write(
        `${label}: config.auto_approve.harnesses ignored (expected a non-empty array of ${AUTO_APPROVE_HARNESS_VALUES.join(
          " | ",
        )}, got ${Array.isArray(harnessesRaw) ? "empty array" : typeof harnessesRaw})\n`,
      );
      return null;
    }
    const seen: string[] = [];
    for (const v of harnessesRaw) {
      if (typeof v !== "string" || !AUTO_APPROVE_HARNESS_VALUES.includes(v as never)) {
        stderr?.write(
          `${label}: config.auto_approve.harnesses ignored (every entry must be one of ${AUTO_APPROVE_HARNESS_VALUES.join(
            ", ",
          )}, got ${typeof v === "string" ? `"${v}"` : typeof v})\n`,
        );
        return null;
      }
      if (seen.includes(v)) {
        stderr?.write(
          `${label}: config.auto_approve.harnesses ignored (duplicate entry "${v}")\n`,
        );
        return null;
      }
      seen.push(v);
    }
    harnesses = seen;
  }

  const requireReport = obj["require_report"];
  if (requireReport !== true) {
    stderr?.write(
      `${label}: config.auto_approve ignored (require_report must be true, got ${
        requireReport === false ? "false" : typeof requireReport
      })\n`,
    );
    return null;
  }

  return { when, harnesses };
}

/**
 * ADR "Additional hardening to specify" item 2: `when` is an allowlist
 * of payload literals, membership by exact string equality, no case
 * folding, no substring, no wildcards. `mode` absent, empty, or not a
 * string means no auto-approval, and `cfg === null` (block absent or
 * malformed) means no auto-approval regardless of `mode`.
 */
export function permissionModeAllowed(cfg: AutoApproveConfig | null, mode: unknown): boolean {
  if (cfg === null) return false;
  if (typeof mode !== "string" || mode.length === 0) return false;
  return cfg.when.includes(mode);
}

/**
 * Per-harness opt-in membership, the same exact-string-equality
 * discipline {@link permissionModeAllowed} applies to `when`. `cfg ===
 * null` (block absent or malformed) means no auto-approval regardless of
 * the harness, and an unlisted harness means no auto-approval regardless
 * of `when` — the two allowlists are independent AND conditions, not
 * alternatives.
 *
 * Re-exported through `understanding-before-execution/index.ts` (round-2
 * review finding on slice 2): its call site (`src/cli/pack/auto-approve-path.ts`)
 * imports every sibling symbol it needs (`parseAutoApprove`,
 * `permissionModeAllowed`, ...) through the runtime shim already, so this
 * one was pulled onto the pinned shim surface
 * (tests/policy-packs/ube-export-surface.test.ts) to match, unlike
 * {@link CODEX_HARNESS} which still has exactly one consumer and stays a
 * direct import.
 */
export function harnessAllowed(cfg: AutoApproveConfig | null, harness: unknown): boolean {
  if (cfg === null) return false;
  if (typeof harness !== "string" || harness.length === 0) return false;
  return cfg.harnesses.includes(harness);
}
