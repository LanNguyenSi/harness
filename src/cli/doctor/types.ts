import type { McpProbeResult } from "../../probes/mcp.js";
import type { MemoryReport, StaleMemory } from "../../probes/memory.js";
import type { Manifest } from "../../schema/index.js";
import type { Diagnostic } from "../validate/types.js";
import type { ClaudeMcpRegistrationSection } from "./claude-mcp.js";
import type { CodexTargetReport } from "./codex.js";
import type { OpencodeTargetReport } from "./opencode.js";
import type { NpmBinReport } from "./npm-bin-path.js";
import type { RogueLedgerDb } from "./rogue-ledger.js";
import type { UnderstandingModeEnvDivergence } from "./understanding-mode-env.js";
import type { ToolchainParitySection } from "./toolchain-parity.js";
import type { UgAutoApprovalsSection } from "./ug-auto-approvals.js";
import type { SettingsDriftSection } from "./settings-drift.js";
import type { AutoApproveModeWarning } from "./auto-approve-mode.js";

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
export type HookVersionReport =
  | {
      status: "ok";
      message: string;
    }
  | {
      status: "warn";
      /**
       * Which outcome the probe hit, mirroring `PolicyPackVersionGapKind`
       * (`src/policy-packs/version-check.ts`) so both hook-level and
       * pack-level gaps share one warning vocabulary. Required on
       * `warn`: every warn-producing branch of `checkHookVersion`
       * classifies its outcome, so there is no warn case without one.
       */
      kind: "below_floor" | "probe_failed" | "parse_failed";
      /** Parsed installed version, when the probe succeeded. Null when the probe failed or its stdout didn't parse. */
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
  /**
   * True when this policy object was derived from `workflows[]`
   * (`isDerivedPolicy`, F7, review round 2) rather than hand-authored
   * under `policies:`. Rendered as "(derived from workflows[])" so an
   * operator reading `harness doctor` output can tell provenance apart
   * without cross-referencing `workflows:` themselves.
   */
  derived?: boolean;
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

/**
 * Doctor surface for the HOOK-level `min_version` floor on a
 * policy-pack-EXPANDED hook (task ab634898). Distinct from
 * `PolicyPackVersionGapReport` (the pack-level `policy_packs[].min_version`
 * floor, a different mechanism checked by `checkPolicyPackVersions`):
 * this covers an individual hook a builtin pack contributes, e.g.
 * understanding-before-execution's UserPromptSubmit/Stop hooks, each
 * declaring its own `min_version` + `version_command`
 * (`src/policy-packs/builtin/understanding-before-execution.ts`).
 * `expandPolicyPacks` produces the hooks Claude Code actually runs, but
 * `manifest.hooks[]` (what `HookEntryReport`/`checkHooks` walk) never
 * includes them, so without this section an operator below a pack
 * hook's floor saw a clean doctor report. Always warn, never error;
 * mirrors the manifest-hook floor (`HookVersionReport`) and the
 * pack-level floor. Empty array when every pack-expanded hook that
 * declares a floor meets it (or none declare one).
 */
export interface PolicyPackHookVersionGapReport {
  /** The pack-expanded hook's name, e.g. `policy-pack:understanding-before-execution:user-prompt-submit`. */
  name: string;
  event: string;
  declaredMinVersion: string;
  /**
   * Which outcome the probe hit; mirrors `PolicyPackVersionGapKind`
   * (`src/policy-packs/version-check.ts`) so the hook-level and
   * pack-level sections classify gaps the same way instead of the
   * renderer having to regex `message` back apart.
   */
  kind: "below_floor" | "probe_failed" | "parse_failed";
  /** Parsed installed version when the probe succeeded; null for `probe_failed` / `parse_failed`, where it is unknown. */
  actualVersion: string | null;
  /** The `version_command` that was probed, e.g. `["understanding-gate", "--version"]`. */
  versionCommand: readonly string[];
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
  /**
   * `checkWorkflowGateWiring` errors (F3, review round 2, 99f47307 Slice
   * 1): a `spawn: "required"` review-then-merge workflow whose runtime
   * merge gate is not correctly wired (a missing evidence hook, or one
   * declared under the right name but the wrong trigger surface/command).
   * `harness doctor` previously imported checks selectively and never ran
   * this one, so it showed green on exactly this misconfiguration.
   * Delegates to the shared validate check, mirroring `templateDrift`.
   * Each rolls into `errorCount`.
   */
  errors: string[];
  /**
   * `checkWorkflowGateWeakOverlap` warnings (F1, review round 2): a
   * hand-authored policy sharing a derived gate's trigger surface but
   * weaker than it (does not suppress the derived gate, just worth
   * flagging). Each rolls into `warningCount`.
   */
  warnings: string[];
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

/**
 * Trigger-boundary drift (task 037cfb7c, follow-up to adf037c1):
 * shipped-by-name `bash_match` triggers (hook-level `hooks[].bash_match`
 * or policy-level `policies[].trigger.bash_match`) missing a boundary
 * alternative the template has, or missing a boundary group entirely.
 * Rule and rationale live on `checkTriggerBoundaryDrift` in
 * `validate/checks.ts`; the measured incident that motivated this check
 * is in CHANGELOG.md's [Unreleased] entry for task 037cfb7c. Shape
 * mirrors `TemplateDriftSection` immediately above: every `error`
 * diagnostic rolls into `errorCount`, every `warning` diagnostic (none
 * emitted today; the field exists so a future non-error diagnostic from
 * `checkTriggerBoundaryDrift` surfaces here instead of being silently
 * dropped by `buildTriggerBoundaryDrift`) rolls into `warningCount`.
 * Always present; both arrays empty when every shipped-named trigger's
 * boundary covers the template's (or the manifest has none of those
 * triggers, or every drift is acknowledged via
 * doctor.ignore_template_drift).
 */
export interface TriggerBoundaryDriftSection {
  /** Stale-boundary bash_match triggers, hook- or policy-level (each → errorCount). */
  errors: string[];
  /** Reserved for a future non-error diagnostic shape (each → warningCount); empty today. */
  warnings: string[];
}

/**
 * Hook-budget-vs-ledger-timeout margin (task d20a7e0c, follow-up to
 * f1aea826/7bf47554): blocking, ledger-consulting hooks (both directly
 * declared `harness policy intercept` hooks and enabled policy-pack
 * blockers) whose `budget_ms` does not clear
 * `requiredHookBudgetMs(health.timeout_ms)` — see
 * `checkHookBudgetLedgerMargin` in `validate/checks.ts` for the full
 * derivation. Every entry is a real fail-open gap (a merely SLOW ledger
 * can get the hook killed before it can write its fail-closed verdict),
 * so each rolls into `errorCount`, mirroring `templateDrift.errors`
 * above. Always present; empty when every such hook clears the margin
 * (or none exist, or grounding-mcp is not wired).
 */
export interface HookBudgetLedgerMarginSection {
  /** Each entry names an under-budgeted hook; rolls into errorCount. */
  errors: string[];
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
  /**
   * Understanding-gate mode env/config divergence (task 24abdecb).
   * Present only when `UNDERSTANDING_GATE_MODE` is set in the operator
   * environment AND diverges from
   * `policy_packs[understanding-before-execution].config.mode`. Always
   * advisory (rolls into `warningCount`, never `errorCount`) — see
   * `understanding-mode-env.ts` for the full rationale.
   */
  understandingModeEnv?: UnderstandingModeEnvDivergence;
  /**
   * Auto-approval listing + last-N metric (ADR
   * docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1,
   * agent-tasks 74b4b17d, "Audit and doctor"). Present only when the
   * `understanding-before-execution` pack is declared and enabled
   * (mirrors `understandingModeEnv`'s gate) — a manifest that never
   * uses the pack has no `.approvals/` markers this listing owns an
   * opinion about. Purely informational (`ℹ`); never rolls into
   * `warningCount`.
   */
  ugAutoApprovals?: UgAutoApprovalsSection;
  /**
   * `auto_approve` configured without `mode: grill_me` (agent-tasks
   * abfad738, follow-up of ADR
   * docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1).
   * Present only when the pack is declared and enabled AND
   * `config.auto_approve` parses as a valid opt-in block. Always
   * advisory (rolls into `warningCount`, never `errorCount`) — see
   * `auto-approve-mode.ts` for the full rationale.
   */
  ugAutoApproveMode?: AutoApproveModeWarning;
  /**
   * Settings-drift compensating control (same ADR, threat model (c)): a
   * `permissions.defaultMode` or hook entry present in a live Claude
   * Code settings file but absent from harness's own last-apply
   * snapshot. Present only when the understanding-gate pack is enabled
   * AND `harness apply` has run at least once for this manifest
   * (`harness.generated/` exists) — otherwise there is no baseline to
   * compare against and nothing to say. `warnings` roll into
   * `warningCount`; `notes` never do.
   */
  settingsDrift?: SettingsDriftSection;
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
  /**
   * Hook-level `min_version` floors on policy-pack-expanded hooks (task
   * ab634898). See `PolicyPackHookVersionGapReport` for why this is
   * separate from both `hooks[].version` (manifest-declared hooks only)
   * and `policyPacks.versionGaps` (the pack-level floor). Always
   * present; empty when every pack-expanded hook that declares a floor
   * meets it.
   */
  policyPackHookVersions: PolicyPackHookVersionGapReport[];
  workflows: WorkflowsSectionReport;
  /** Phase 7 #6 — Risk Gate wiring health (classifiers / resolvers / `when:`). */
  riskGate: RiskGateSection;
  /**
   * Template-policy drift (task adf037c1): shipped operator_only security
   * policies missing-or-downgraded in this installed manifest (`errors`)
   * and stale `doctor.ignore_template_drift` entries (`warnings`). Always
   * present; both arrays empty when the manifest carries every shipped
   * kill-switch policy in operator_only form (or has acknowledged the gap
   * via a valid doctor.ignore_template_drift entry).
   */
  templateDrift: TemplateDriftSection;
  /**
   * Trigger-boundary drift (task 037cfb7c). Always present; `errors`
   * empty when every shipped-named `bash_match` trigger's boundary
   * matches the template (or every drift is acknowledged via
   * doctor.ignore_template_drift).
   */
  triggerBoundaryDrift: TriggerBoundaryDriftSection;
  /**
   * Hook-budget-vs-ledger-timeout margin (task d20a7e0c). Always
   * present; `errors` empty when every blocking, ledger-consulting hook
   * clears the derived margin.
   */
  hookBudgetLedgerMargin: HookBudgetLedgerMarginSection;
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
   * On-demand toolchain-parity comparison (task 13919613), reusing the
   * Collector/Comparator core from `harness session-start
   * toolchain-parity` (src/cli/doctor/toolchain-parity.ts). Present only
   * when `toolchain_parity.enabled` is true in the manifest — absent
   * otherwise, mirroring `grounding`'s "only when the feature is in use"
   * gating. Always read-only: never writes a snapshot file or a ledger
   * fact. Only `"drift"`-status peers roll into `warningCount`; the
   * section is never an `errorCount` source (advisory, not a gate).
   */
  toolchainParity?: ToolchainParitySection;
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
export type { ClaudeMcpRegistrationSection, ClaudeMcpEntryReport } from "./claude-mcp.js";
export type { UnderstandingModeEnvDivergence } from "./understanding-mode-env.js";
export type { UgAutoApprovalsSection, AutoApprovalListingEntry } from "./ug-auto-approvals.js";
export type { AutoApproveModeWarning } from "./auto-approve-mode.js";
export type { SettingsDriftSection } from "./settings-drift.js";
export type { ToolchainParitySection, ToolchainParityPeerReport } from "./toolchain-parity.js";

export type {
  Manifest,
  McpProbeResult,
  MemoryReport,
  StaleMemory,
  CodexTargetReport,
  RogueLedgerDb,
};
