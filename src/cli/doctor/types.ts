import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";

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

export interface PolicyEntryReport {
  name: string;
  schemaValid: boolean;
  caveat: string;
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
  errorCount: number;
  warningCount: number;
}

export type { Manifest, McpProbeResult, MemoryReport, StaleMemory };
