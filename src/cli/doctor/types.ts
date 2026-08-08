import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";
import type { Diagnostic } from "../validate/types.js";
import type { ClaudeMcpRegistrationSection } from "./claude-mcp.js";
import type { CodexTargetReport } from "./codex.js";
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
 * Doctor surface for the pack-level `min_version` floor. Mirrors the
 * hook-level `HookEntryReport.version` shape so operators see a
 * consistent warning vocabulary regardless of which layer raised the
 * gap. Always warn-not-error: a below-floor pack still runs in degraded
 * mode; the operator just loses any feature gated on the newer release.
 */
export interface PolicyPackVersionGapReport {
  name: string;
  declaredMinVersion: string;
  actualVersion: string | null;
  message: string;
}

/**
 * A pack's declared `config.ux` / `config.producers` that textually
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
  /** Which sub-field(s) diverge: `ux`, `producers`, or both. */
  fields: string[];
  message: string;
}

export interface PolicyPacksSection {
  unresolved: PolicyPackUnresolved[];
  configIssues: PolicyPackConfigIssue[];
  versionGaps: PolicyPackVersionGapReport[];
  uxDrift: PolicyPackUxDriftReport[];
  solutionAcceptance: Diagnostic[];
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

/**
 * Phase 7 #6 — Risk Gate wiring health. Reports whether the three Risk
 * Gate surfaces (`risk.classifiers[]`, `environments.resolvers[]`, and
 * policies carrying a `when:` block) compose coherently. The `warnings`
 * catch the inert / fail-closed misconfigurations: `when:`-policies with
 * no classifier (every action unclassified), `when:`-policies with no
 * resolver (every environment `unknown`), or classifiers / resolvers
 * declared but no policy consuming them. The per-decision audit log
 * lives in `harness audit` (`policy_decision` rows carry the classifier
 * + environment as of Phase 7 #5); doctor reports wiring, not history.
 */
export interface RiskGateSection {
  /** Count of `risk.classifiers[]`. */
  classifiers: number;
  /** Count of `environments.resolvers[]`. */
  resolvers: number;
  /** Count of policies that declare a `when:` block. */
  whenPolicies: number;
  /** Coherence warnings; each rolls into the doctor `warningCount`. */
  warnings: string[];
}

/**
 * Grounding wiring health (task 129e1b94). Present only when the manifest
 * declares an enabled `tools.mcp[grounding-mcp]` entry — without one there
 * is no consumer to check (validate's checkPolicyGroundingMcp owns the
 * "policies without grounding-mcp" warning). Doctor verifies the projected
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

/**
 * Template-policy drift (task adf037c1). `errors` names shipped
 * `operator_only` (kill-switch / security) policies this installed
 * manifest either lacks entirely or carries in a DOWNGRADED (no longer
 * operator_only) shape — a defense an aged manifest never received or
 * silently weakened, since `harness apply` does not retroactively add or
 * repair default policies. Each rolls into `errorCount` (a real defense
 * gap, doctor-convention exit failure). `warnings` names stale
 * `doctor.ignore_template_drift` entries that match no shipped policy and
 * therefore suppress nothing; each rolls into `warningCount`. Names
 * acknowledged via a valid `doctor.ignore_template_drift` entry are
 * filtered out of `errors` upstream.
 */
export interface TemplateDriftSection {
  /** Missing-or-downgraded shipped operator_only policies (each → errorCount). */
  errors: string[];
  /** Stale/typo'd ignore_template_drift entries that suppress nothing (each → warningCount). */
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
  policies: PolicyEntryReport[];
  /**
   * Declared-but-not-live policy packs. Each entry is a pack the
   * operator listed in `policy_packs[]` whose `source` or builtin
   * name doesn't resolve at apply time — silently skipped today,
   * surfaced loudly here. Errors count toward `errorCount`.
   */
  policyPacks: PolicyPacksSection;
  workflows: WorkflowsSectionReport;
  /** Phase 7 #6 — Risk Gate wiring health (classifiers / resolvers / `when:`). */
  riskGate: RiskGateSection;
  /**
   * Template-policy drift (task adf037c1): shipped operator_only security
   * policies missing from this installed manifest. Always present; empty
   * `missing` when the manifest carries every shipped kill-switch policy
   * (or has acknowledged the gap via doctor.ignore_template_drift).
   */
  templateDrift: TemplateDriftSection;
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
export type { ClaudeMcpRegistrationSection, ClaudeMcpEntryReport } from "./claude-mcp.js";

export type {
  Manifest,
  McpProbeResult,
  MemoryReport,
  StaleMemory,
  CodexTargetReport,
  RogueLedgerDb,
};
