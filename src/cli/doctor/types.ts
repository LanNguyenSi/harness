import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";
import type { ClaudeMcpRegistrationSection } from "./claude-mcp.js";
import type { CodexTargetReport } from "./codex.js";
import type { OpencodeTargetReport } from "./opencode.js";
import type { NpmBinReport } from "./npm-bin-path.js";
import type { RogueLedgerDb } from "./rogue-ledger.js";

/**
 * Phase 6 #6 follow-up — doctor target identifier. Distinct from
 * `Runtime` (which gates `harness apply --runtime`): doctor only adds
 * a target when the corresponding adapter-health check module exists.
 * Reusing the apply Runtime enum here would silently accept
 * `--target claude-code` and do nothing, since there is no
 * claude-code-specific doctor module today.
 */
export const KNOWN_DOCTOR_TARGETS = ["codex", "opencode"] as const;
export type DoctorTarget = (typeof KNOWN_DOCTOR_TARGETS)[number];

export function isDoctorTarget(value: unknown): value is DoctorTarget {
  return (
    typeof value === "string" &&
    (KNOWN_DOCTOR_TARGETS as readonly string[]).includes(value)
  );
}

export interface ManifestSection {
  topLevelKeysPresent: number;
  warnings: string[];
}

export interface CliEntryReport {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  /**
   * PATH-shadow remediation (task 7f8fb4bc): set when the binary is not
   * resolvable on PATH but a file of the same name exists under the
   * resolved npm global bin dir — the nvm-drift footgun the `npmGlobalBin`
   * check (task 4ddd78ed) diagnoses independently. Names the directory and
   * tells the operator to add it to PATH instead of leaving "not found" as
   * the only signal.
   */
  pathHint?: string;
}

/**
 * Outcome of a `min_version` check against an MCP server's first command
 * token. Distinct from `McpProbeResult` (which probes the running server's
 * health verb), this runs `<bin> --version` (or `version_command` when
 * overridden) and compares the parsed version against `min_version`. Below
 * threshold maps to `warn`, not `error`: the binary still works, the gap
 * is informational so the operator can decide to upgrade.
 */
export interface McpVersionReport {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

export interface ToolsSection {
  mcp: McpProbeResult[];
  mcpVersions: McpVersionReport[];
  cli: CliEntryReport[];
  skillsEnabled: string[];
  skillsRequiredMissing: string[];
}

/**
 * Result of the optional `min_version` probe for a hook entry. Populated
 * only when the hook declares both `min_version` and `version_command`;
 * absent otherwise (the path-existence check on the hook command still
 * runs unconditionally and surfaces via the main `status` field).
 */
export type HookVersionReport =
  | {
      status: "ok";
      message: string;
    }
  | {
      status: "warn";
      /**
       * Which outcome the probe hit. Required on `warn`: every
       * warn-producing branch of `checkHookVersion` classifies its
       * outcome, so there is no warn case without one.
       */
      kind: "below_floor" | "probe_failed" | "parse_failed";
      /**
       * Parsed installed version, when the probe succeeded. Null when
       * the probe failed or its stdout didn't parse. Always the
       * NUMERIC run (`parseProbedVersion`'s `version` field, e.g.
       * "0.6.0"), never the probed prerelease/build suffix: for a
       * `below_floor` finding caused by a prerelease of the floor
       * (e.g. probed "0.6.0-rc.1" against a "0.6.0" `min_version`),
       * `actualVersion` therefore equals `hook.min_version` even
       * though `kind` is `"below_floor"`: the numeric components tie,
       * and `compareVersionFloor`'s prerelease tie-break is what
       * actually failed the floor. `message` carries the full probed
       * token (including the suffix) for the human-facing distinction;
       * this field's JSON shape does not gain a new field for it. See
       * docs/decisions/2026-09-08-preflight-floors.md.
       */
      actualVersion: string | null;
      message: string;
    };

export interface HookEntryReport {
  name: string;
  event: string;
  blocking: string;
  status: "ok" | "warn" | "error";
  message?: string;
  version?: HookVersionReport;
}

/**
 * A declared policy pack whose `source` or builtin name does not
 * resolve. The pack appears in `manifest.policy_packs[]` (so the
 * operator believes it is active) but `expandPolicyPacks` silently
 * skips it at apply time — its hooks never reach `settings.json`, so
 * none of its policies actually fire. The founding silent-allow class:
 * the harness reports green while the gate is inert. Doctor surfaces
 * the gap as an error so the misconfig is impossible to miss.
 */
export interface PolicyPackUnresolved {
  name: string;
  reason: "unknown_source" | "unknown_builtin_name";
  source: string;
  detail: string;
}

/**
 * A `config:` key/value that this pack's registered `configSchema`
 * rejects. The pack itself resolves (`source:` and `name:` are fine),
 * but a key is typo'd or carries the wrong shape; the runtime would
 * silently fall back to a default, masking the misconfig. Doctor
 * surfaces each rejection so the operator sees the gap at health-
 * check time instead of at the first hook firing. See
 * `src/policy-packs/config-check.ts` for the shared check shared with
 * `harness validate`.
 */
export interface PolicyPackConfigIssue {
  name: string;
  /** Dotted path inside `pack.config`, e.g. `mode`, `approval_lifecycle.mode`. */
  configPath: string;
  message: string;
}

/**
 * Doctor surface for the pack-level `min_version` floor: a declared floor on
 * a pack that has no version probe, so it cannot be enforced. Always
 * warn-not-error.
 */
export interface PolicyPackVersionGapReport {
  name: string;
  declaredMinVersion: string;
  /**
   * Always null: a builtin pack has no probe, so no installed version is
   * known. Kept so the doctor JSON shape of `versionGaps` is unchanged.
   */
  actualVersion: string | null;
  message: string;
}

/**
 * A pack's declared `config.ux` that textually
 * diverges from the shipped builtin template for that pack (task
 * 68b9ad9c). Unlike `PolicyPackConfigIssue`, the value is still SCHEMA-
 * valid — the gap is that it teaches stale wording (e.g. a pre-fix
 * submission form) rather than an invalid shape. Always a warning:
 * the pack still functions, the operator is just missing a wording
 * improvement. See `src/policy-packs/ux-drift-check.ts` and
 * `harness pack reseed` (the opt-in fix).
 */
export interface PolicyPackUxDriftReport {
  name: string;
  /** Which sub-field(s) diverge (today only `ux`). */
  fields: string[];
  message: string;
}

/** The runtime policy packs were expanded against; see `DoctorReport.packExpansionRuntime`. */
export interface PackExpansionRuntimeReport {
  runtime: string;
  /** How apply's `selectRuntime` chose it: last-apply, inferred, unrecorded or default. */
  source: string;
  /** The runtime the last apply recorded or that its files imply, when there is one. */
  previousRuntime?: string;
  /** Set when the last apply's `.last-apply` could not be read; names the file. */
  warning?: string;
}

export interface PolicyPacksSection {
  unresolved: PolicyPackUnresolved[];
  configIssues: PolicyPackConfigIssue[];
  versionGaps: PolicyPackVersionGapReport[];
  uxDrift: PolicyPackUxDriftReport[];
}

/**
 * Grounding wiring health (task 129e1b94). Present only when the manifest
 * declares an enabled `tools.mcp[grounding-mcp]` entry — without one there
 * is no consumer to check. Doctor verifies the projected
 * evidence-ledger path is usable and that an operator env override does
 * not silently diverge from `grounding.evidence_ledger.path`.
 */
export interface GroundingSection {
  /** `grounding.evidence_ledger.path` after `~` expansion. */
  ledgerPath: string;
  /** False when neither the DB file nor its nearest existing ancestor is writable. */
  ledgerPathWritable: boolean;
  /** Operator-declared env override on the grounding-mcp entry, when set. */
  envOverride: string | null;
  /** Wiring warnings; each rolls into the doctor `warningCount`. */
  warnings: string[];
}

export interface DoctorReport {
  manifestPath: string;
  manifestVersion: number;
  project: string | null;
  shallow: boolean;
  manifest: ManifestSection;
  tools: ToolsSection;
  /**
   * Resolution + PATH-membership check for the npm global bin
   * directory. Surfaces the nvm-drift footgun where an `npm i -g` runs
   * against one Node's prefix but the shell PATH points at a different
   * one, so installed binaries are silently invisible to subsequent
   * doctor / harness probes. See task 4ddd78ed.
   */
  npmGlobalBin?: NpmBinReport;
  memory: MemoryReport;
  hooks: HookEntryReport[];
  /**
   * Declared-but-not-live policy packs. Each entry is a pack the
   * operator listed in `policy_packs[]` whose `source` or builtin
   * name doesn't resolve at apply time — silently skipped today,
   * surfaced loudly here. Errors count toward `errorCount`.
   */
  policyPacks: PolicyPacksSection;
  /**
   * The runtime policy packs were expanded against for the pack checks:
   * the one a plain `harness apply` would select (recorded in
   * `.last-apply`, inferred from its files, else the default; task
   * 04b8abcf). Always present.
   */
  packExpansionRuntime: PackExpansionRuntimeReport;
  /**
   * Grounding wiring health (task 129e1b94). Absent when no enabled
   * grounding-mcp entry is declared.
   */
  grounding?: GroundingSection;
  /**
   * Claude Code MCP registration health (task
   * init-mcp-wiring-claude-code/T-003). Present whenever `tools.mcp[]`
   * is non-empty; verifies the live `claude mcp` user-scope registry
   * instead of the inert settings.json `mcpServers` block. See
   * `claude-mcp.ts` for the full rationale, including why the gate
   * isn't further scoped by runtime.
   */
  claudeMcp?: ClaudeMcpRegistrationSection;
  /**
   * Phase 6 #6 follow-up: present when `--target codex` is passed.
   * Aggregates harness-side codex adapter health checks (binary
   * resolution, generated config presence, hook command resolution,
   * persisted-report dir writability). Counts roll into the top-level
   * errorCount / warningCount.
   */
  codexTarget?: CodexTargetReport;
  /**
   * Batch 18 / task f34eb233: present when `--target opencode` is
   * passed. Aggregates harness-side opencode adapter health checks
   * (generated config presence + banner, projected MCP server command
   * resolution). Counts roll into the top-level errorCount /
   * warningCount, same as `codexTarget`.
   */
  opencodeTarget?: OpencodeTargetReport;
  /**
   * Leftover `<parent>/~/.evidence-ledger/ledger.db` files from the
   * literal-tilde `EVIDENCE_LEDGER_DB` env leak (agent-tasks/42d224a6,
   * harness PR #101). Always scanned; harmless when empty. Each entry
   * rolls into `warningCount`. The scan walks `$HOME`, `$HOME/git/*`
   * (one level deep), and `$PWD`; see `rogue-ledger.ts` for rationale.
   */
  rogueLedgerDbs: RogueLedgerDb[];
  errorCount: number;
  warningCount: number;
}

export type { NpmBinReport } from "./npm-bin-path.js";
export type {
  ClaudeMcpRegistrationSection,
  ClaudeMcpEntryReport,
} from "./claude-mcp.js";

export type {
  Manifest,
  McpProbeResult,
  MemoryReport,
  StaleMemory,
  CodexTargetReport,
  RogueLedgerDb,
};
