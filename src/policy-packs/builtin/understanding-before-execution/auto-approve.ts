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

/** The only harness identifier slice 1 mints markers for. */
export const CLAUDE_CODE_HARNESS = "claude-code";

/**
 * Build the `approvedBy` value the hook writes into a signed auto-marker:
 * `auto-mode:<harness>:<mode>`, for example `auto-mode:claude-code:bypassPermissions`
 * ("Audit and doctor" in the ADR). Neither `harness` nor `mode` is
 * validated here; callers pass already-known-good values (the fixed
 * `CLAUDE_CODE_HARNESS` constant and a `when`-matched mode string).
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

/** Parsed, validated `auto_approve` pack-config block. */
export interface AutoApproveConfig {
  /** Allowlist of `permission_mode` payload literals eligible for auto-approval. */
  when: string[];
}

const KNOWN_AUTO_APPROVE_KEYS = new Set(["when", "require_report"]);

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
 */
export function parseAutoApprove(
  raw: unknown,
  stderr?: { write(s: string): void } | null,
): AutoApproveConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    stderr?.write(
      `harness pack hook: config.auto_approve ignored (expected object, got ${typeof raw})\n`,
    );
    return null;
  }
  const obj = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter((k) => !KNOWN_AUTO_APPROVE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    stderr?.write(
      `harness pack hook: config.auto_approve ignored (unknown key(s): ${unknownKeys.join(", ")})\n`,
    );
    return null;
  }

  const whenRaw = obj["when"];
  if (!Array.isArray(whenRaw) || whenRaw.length === 0) {
    stderr?.write(
      `harness pack hook: config.auto_approve.when ignored (expected a non-empty string[], got ${
        Array.isArray(whenRaw) ? "empty array" : typeof whenRaw
      })\n`,
    );
    return null;
  }
  const when: string[] = [];
  for (const v of whenRaw) {
    if (typeof v !== "string" || v.length === 0) {
      stderr?.write(
        `harness pack hook: config.auto_approve.when ignored (every entry must be a non-empty string, got ${typeof v})\n`,
      );
      return null;
    }
    when.push(v);
  }

  const requireReport = obj["require_report"];
  if (requireReport !== true) {
    stderr?.write(
      `harness pack hook: config.auto_approve ignored (require_report must be true, got ${
        requireReport === false ? "false" : typeof requireReport
      })\n`,
    );
    return null;
  }

  return { when };
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
