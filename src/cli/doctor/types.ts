import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";
import type { CodexTargetReport } from "./codex.js";

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

export interface ToolsSection {
  mcp: McpProbeResult[];
  cli: CliEntryReport[];
  skillsEnabled: string[];
  skillsRequiredMissing: string[];
}

export interface HookEntryReport {
  name: string;
  event: string;
  blocking: string;
  status: "ok" | "warn" | "error";
  message?: string;
}

/**
 * A `block`-enforcement policy whose required ledger tag carries a
 * `within` freshness window, but no manifest hook produces that tag.
 * The gate will wall off whatever it triggers on until the tag is
 * supplied out-of-band (a manual `ledger_add`, an external tool), with
 * no in-manifest way to keep it satisfied. See task ce50df99.
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
  errorCount: number;
  warningCount: number;
}

export type { Manifest, McpProbeResult, MemoryReport, StaleMemory, CodexTargetReport };
