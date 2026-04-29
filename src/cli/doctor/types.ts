import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";

export interface ManifestSection {
  syntaxValid: boolean;
  schemaValid: boolean;
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
  errorCount: number;
  warningCount: number;
}

export type { Manifest, McpProbeResult, MemoryReport, StaleMemory };
