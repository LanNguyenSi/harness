import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";
import type { CodexTargetReport } from "./codex.js";
import type { RogueLedgerDb } from "./rogue-ledger.js";

/**
 * Phase 6 #6 follow-up — doctor target identifier. Distinct from
 * `Runtime` (which gates `harness apply --runtime`): doctor only adds
 * a target when the corresponding adapter-health check module exists.
 * Reusing the apply Runtime enum here would silently accept
 * `--target claude-code` and do nothing, since there is no
 * claude-code-specific doctor module today.
 */
export const KNOWN_DOCTOR_TARGETS = ["codex"] as const;
export type DoctorTarget = (typeof KNOWN_DOCTOR_TARGETS)[number];

export function isDoctorTarget(value: unknown): value is DoctorTarget {
  return typeof value === "string" && (KNOWN_DOCTOR_TARGETS as readonly string[]).includes(value);
}

export interface ManifestSection {
  topLevelKeysPresent: number;
  warnings: string[];
}

export interface CliEntryReport {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
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
export interface HookVersionReport {
  status: "ok" | "warn";
  message: string;
}

export interface HookEntryReport {
  name: string;
  event: string;
  blocking: string;
  status: "ok" | "warn" | "error";
  message?: string;
  version?: HookVersionReport;
}

/**
 * A `block`-enforcement policy whose required ledger tag carries a
 * `within` freshness window, but no manifest hook produces that tag
 * AND the policy itself declares no `producers:` array. The gate will
 * wall off whatever it triggers on until the tag is supplied
 * out-of-band, with no in-manifest way to keep it satisfied or any
 * recovery path visible to the agent. Policies that document the
 * recovery in `producers:` (e.g. dogfood-before-release deliberately
 * wanting an operator-driven manual smoke summary) are NOT flagged
 * here, since that producer is the schema-blessed manual path. See
 * tasks ce50df99 (initial check) and f97e152f (producers-respect
 * refinement).
 */
export interface PolicyProducerGap {
  /** The unresolved `requires.ledger_tag`, e.g. `preflight:${REPO}`. */
  ledgerTag: string;
  /** The `requires.within` window the tag must stay fresh inside. */
  within: string;
}

export interface PolicyEntryReport {
  name: string;
  schemaValid: boolean;
  caveat: string;
  /** Present when this policy has an unproduced freshness-gated tag. */
  producerGap?: PolicyProducerGap;
}

export interface WorkflowEntryReport {
  name: string;
  steps: number;
  reviewSpawn: "required" | "optional" | "skip" | null;
  reviewTemplate: string | null;
  mergeGate: "solo" | "agent_tasks_label" | "none" | null;
  taskLabels: string[];
}

export interface WorkflowsSectionReport {
  declared: number;
  templates: number;
  entries: WorkflowEntryReport[];
}

export interface DoctorReport {
  manifestPath: string;
  manifestVersion: number;
  project: string | null;
  shallow: boolean;
  manifest: ManifestSection;
  tools: ToolsSection;
  memory: MemoryReport;
  hooks: HookEntryReport[];
  policies: PolicyEntryReport[];
  workflows: WorkflowsSectionReport;
  /**
   * Phase 6 #6 follow-up: present when `--target codex` is passed.
   * Aggregates harness-side codex adapter health checks (binary
   * resolution, generated config presence, hook command resolution,
   * persisted-report dir writability). Counts roll into the top-level
   * errorCount / warningCount.
   */
  codexTarget?: CodexTargetReport;
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

export type {
  Manifest,
  McpProbeResult,
  MemoryReport,
  StaleMemory,
  CodexTargetReport,
  RogueLedgerDb,
};
