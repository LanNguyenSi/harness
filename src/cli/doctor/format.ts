import type { DoctorReport, McpProbeResult } from "./types.js";
import { VERSION } from "../../version.js";

function mcpLines(r: McpProbeResult, shallow: boolean): string[] {
  switch (r.outcome.kind) {
    case "healthy":
      return [
        shallow
          ? `    ~ ${r.name}  manifest-only (probe skipped)`
          : `    ✓ ${r.name}  healthy in ${r.outcome.latencyMs}ms`,
      ];
    case "error": {
      const out = [`    ✗ ${r.name}  FAILED: ${r.outcome.message}`];
      if (r.outcome.pathHint) out.push(`      ${r.outcome.pathHint}`);
      return out;
    }
    case "no-response": {
      // Render distinct from `error` so a clean exit-0 ("config issue")
      // is not framed as a process crash. The visual marker stays ✗
      // because the server still failed to answer the doctor.
      const phase =
        r.outcome.phase === "initialize"
          ? "initialize"
          : `${r.outcome.verb ?? "verb"} call`;
      return [`    ✗ ${r.name}  no JSON-RPC response (process exited cleanly during ${phase})`];
    }
    case "missing-verb":
      return [`    ? ${r.name}  unknown — no health verb declared`];
    case "disabled":
      return [`    ✓ ${r.name}  disabled (skipped)`];
  }
}

function describeStaleness(date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return `last touched ${iso}`;
}

function formatHeader(report: DoctorReport): string {
  const project = report.project ? `, project: ${report.project}` : "";
  const shallow = report.shallow ? " [shallow]" : "";
  return `harness ${VERSION} — checking ${report.manifestPath} (version ${report.manifestVersion}${project})${shallow}`;
}

function formatManifestSection(report: DoctorReport): string[] {
  // The previous "✓ syntax valid" and "✓ schema valid" lines were
  // tautological: loadManifest exits EX_NOINPUT (66) on parse / schema
  // failures before doctor() ever runs, so both rendered ✓ in every
  // observable doctor invocation. The structural signal is now the
  // load-time exit code; the section just reports the topLevelKeysPresent
  // count and any soft warnings.
  const out: string[] = ["", "Manifest"];
  out.push(
    `  ✓ ${report.manifest.topLevelKeysPresent} top-level keys present, all required present`,
  );
  for (const w of report.manifest.warnings) {
    out.push(`  ⚠ ${w}`);
  }
  return out;
}

// Environment section: render only when there is something worth
// reporting. `ok` stays silent (no point in a ✓ line for a check that
// hits zero issues), `warn` is the actionable case we want loud, and
// `unknown` stays silent because if npm is missing the other dep
// checks already failed loudly.
function formatEnvironmentSection(report: DoctorReport): string[] {
  const bin = report.npmGlobalBin;
  const modeEnv = report.understandingModeEnv;
  const ugAuto = report.ugAutoApprovals;
  const autoApproveMode = report.ugAutoApproveMode;
  const bypassWithoutAutoApprove = report.ugBypassWithoutAutoApprove;
  // "nothing when `.approvals/` is absent" (ug-auto-approvals.ts's AC 1):
  // stay silent unless the directory actually exists, mirroring the rest
  // of this section's "no line for a check that found nothing" style.
  const showUgAuto = ugAuto !== undefined && ugAuto.approvalsDirPresent;
  const ugDeleg = report.ugDelegations;
  // Same "no line for a check that found nothing" convention as
  // showUgAuto: silent unless `.delegations/` actually exists. A
  // present-but-empty directory still renders the zero-count line
  // (ug-delegations.ts's own doc comment on `delegationsDirPresent`).
  const showUgDeleg = ugDeleg !== undefined && ugDeleg.delegationsDirPresent;
  const ugInflight = report.ugInflight;
  // Same "no line for a check that found nothing" convention as
  // showUgAuto / showUgDeleg: silent unless `.inflight/` actually exists.
  const showUgInflight = ugInflight !== undefined && ugInflight.inflightDirPresent;
  const drift = report.settingsDrift;
  const hasDriftContent = drift !== undefined && (drift.notes.length > 0 || drift.warnings.length > 0);
  const codexDrift = report.codexConfigDrift;
  const hasCodexDriftContent = codexDrift !== undefined && codexDrift.warnings.length > 0;
  if (
    (!bin || bin.status !== "warn") &&
    !modeEnv &&
    !autoApproveMode &&
    !bypassWithoutAutoApprove &&
    !showUgAuto &&
    !showUgDeleg &&
    !showUgInflight &&
    !hasDriftContent &&
    !hasCodexDriftContent
  )
    return [];
  const out: string[] = ["", "Environment"];
  if (bin && bin.status === "warn") {
    out.push(
      `  ⚠ npm global bin (${bin.binDir}) is not on PATH`,
      `      harness install commands wrote binaries here but your shell will not find them.`,
      `      Add to your shell rc (e.g. ~/.bashrc, ~/.zshrc):  ${bin.pathPatchSuggestion}`,
    );
  }
  if (modeEnv) {
    out.push(`  ⚠ ${modeEnv.message}`);
    for (const line of modeEnv.detail) out.push(`      ${line}`);
  }
  if (autoApproveMode) {
    out.push(`  ⚠ ${autoApproveMode.message}`);
    for (const line of autoApproveMode.detail) out.push(`      ${line}`);
  }
  if (bypassWithoutAutoApprove) {
    out.push(`  ⚠ ${bypassWithoutAutoApprove.message}`);
    for (const line of bypassWithoutAutoApprove.detail) out.push(`      ${line}`);
  }
  if (showUgAuto && ugAuto) {
    const modeParts = Object.keys(ugAuto.byMode)
      .sort()
      .map((m) => `${m}: ${ugAuto.byMode[m]}`)
      .join(", ");
    const modeSuffix = modeParts.length > 0 ? ` (${modeParts})` : "";
    out.push(
      `  ℹ auto approvals in the last ${ugAuto.windowSize} sessions: ${ugAuto.autoApprovedCount}${modeSuffix}`,
    );
    for (const e of ugAuto.entries) {
      out.push(`      ${e.sessionId}  ${e.mode}  ${e.approvedAt}`);
    }
    const harnessKeys = Object.keys(ugAuto.byHarness);
    if (harnessKeys.length > 1) {
      const harnessParts = harnessKeys
        .sort()
        .map((h) => `${h}: ${ugAuto.byHarness[h]}`)
        .join(", ");
      out.push(`      by harness: ${harnessParts}`);
    }
    if (ugAuto.unreadableCount > 0) {
      out.push(
        `      ${ugAuto.unreadableCount} marker${ugAuto.unreadableCount === 1 ? "" : "s"} unreadable, excluded from the count`,
      );
    }
  }
  if (showUgDeleg && ugDeleg) {
    const marker = ugDeleg.unreadable > 0 ? "⚠" : "ℹ";
    const line =
      ugDeleg.total === 0
        ? `  ${marker} delegations on disk: 0`
        : `  ${marker} delegations on disk: ${ugDeleg.total} (${ugDeleg.expired} expired, ${ugDeleg.unreadable} unreadable)`;
    out.push(line);
  }
  if (showUgInflight && ugInflight) {
    out.push(`  ℹ in-flight subagent records on disk: ${ugInflight.total} (${ugInflight.stale} stale)`);
  }
  if (drift) {
    for (const n of drift.notes) out.push(`  ℹ ${n}`);
    for (const w of drift.warnings) out.push(`  ⚠ ${w}`);
  }
  if (codexDrift) {
    for (const w of codexDrift.warnings) out.push(`  ⚠ ${w}`);
  }
  return out;
}

function formatToolsSection(report: DoctorReport): string[] {
  const out: string[] = ["", "Tools"];
  out.push(`  MCP servers (${report.tools.mcp.length} declared)`);
  for (const m of report.tools.mcp) out.push(...mcpLines(m, report.shallow));
  // Only render the version-check sub-block when at least one MCP server
  // declared `min_version`; an empty list otherwise would be noise.
  if (report.tools.mcpVersions.length > 0) {
    out.push(`    versions:`);
    for (const v of report.tools.mcpVersions) {
      const marker = v.status === "ok" ? "✓" : v.status === "warn" ? "⚠" : "✗";
      out.push(`      ${marker} ${v.name}  ${v.message}`);
    }
  }

  const cliCount = report.tools.cli.length;
  out.push(`  CLI tools (${cliCount} declared)`);
  for (const c of report.tools.cli) {
    const marker = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
    out.push(`    ${marker} ${c.name}  ${c.message}`);
    if (c.pathHint) out.push(`      ${c.pathHint}`);
  }

  const skillsLine = report.tools.skillsEnabled.join(", ") || "(none)";
  out.push(
    `  Skills (${report.tools.skillsEnabled.length} enabled${report.tools.skillsRequiredMissing.length === 0 ? ", all required by manifest" : `, ${report.tools.skillsRequiredMissing.length} required missing`})`,
  );
  if (report.tools.skillsRequiredMissing.length === 0) {
    out.push(`    ✓ ${skillsLine}`);
  } else {
    out.push(`    ✗ missing: ${report.tools.skillsRequiredMissing.join(", ")}`);
    out.push(`      enabled: ${skillsLine}`);
  }
  return out;
}

function formatMemorySection(report: DoctorReport): string[] {
  const out: string[] = ["", "Memory"];
  if (report.memory.routerExecutable) {
    if (report.memory.routerExecutable.exists) {
      out.push(`  ✓ memory-router executable found (${report.memory.routerExecutable.path})`);
    } else {
      out.push(`  ✗ memory-router not found at ${report.memory.routerExecutable.path}`);
    }
  } else {
    out.push(`  ⚠ no memory router declared`);
  }
  if (report.memory.routerVersion) {
    const marker = report.memory.routerVersion.status === "ok" ? "✓" : "⚠";
    out.push(`    ${marker} version: ${report.memory.routerVersion.message}`);
  }
  for (const d of report.memory.directories) {
    if (d.unresolved) {
      out.push(`  ℹ memory directory pattern: ${d.path} (resolved per-project at runtime)`);
    } else if (!d.exists) {
      out.push(`  ⚠ memory directory missing: ${d.path}`);
    }
  }
  if (report.memory.staleMemories.length > 0) {
    out.push(
      `  ⚠ ${report.memory.staleMemories.length} memories haven't been touched in > retention.staleness_days threshold`,
    );
    for (const m of report.memory.staleMemories) {
      out.push(`    ${m.path} (${describeStaleness(m.lastTouched)})`);
    }
  }
  if (
    report.memory.routerExecutable?.exists &&
    report.memory.directories.every((d) => d.exists) &&
    report.memory.staleMemories.length === 0
  ) {
    // OK section already rendered the router line; nothing else to add
  }
  return out;
}

function formatHooksSection(report: DoctorReport): string[] {
  const out: string[] = ["", "Hooks"];
  for (const h of report.hooks) {
    const marker = h.status === "ok" ? "✓" : h.status === "warn" ? "⚠" : "✗";
    const tail = h.message ? `  ${h.message}` : "";
    out.push(`  ${marker} ${h.name}  ${h.event}, blocking: ${h.blocking}${tail}`);
    if (h.version) {
      const vMarker = h.version.status === "ok" ? "✓" : "⚠";
      out.push(`      ${vMarker} version: ${h.version.message}`);
    }
  }
  if (report.hooks.length === 0) out.push(`  (no hooks declared)`);
  return out;
}

// Policy-pack hooks section (task ab634898): the hook-level `min_version`
// floor on hooks a builtin policy pack contributes (understanding-gate's
// UserPromptSubmit/Stop hooks, floored at 0.5.0, are the motivating
// case). Distinct from the "Hooks" section above (which only walks
// `manifest.hooks[]`, never the pack-expanded ones) and from "Policy
// Packs" below (the pack-LEVEL `policy_packs[].min_version` floor).
// Stays silent when there is nothing to report, same convention as
// "Policy Packs".
function formatPolicyPackHookVersionsSection(report: DoctorReport): string[] {
  if (report.policyPackHookVersions.length === 0) return [];
  const out: string[] = ["", "Policy-pack hooks"];
  for (const gap of report.policyPackHookVersions) {
    out.push(`  ⚠ ${gap.name}.min_version  ${gap.message}`);
    if (gap.kind === "below_floor") {
      out.push(
        `      this pack-contributed hook runs in degraded mode below its declared min_version ${gap.declaredMinVersion}. Upgrade the package-side bin.`,
      );
    } else if (gap.kind === "probe_failed") {
      const bin = gap.versionCommand[0] ?? "the probe binary";
      out.push(
        `      ${bin} is not on PATH, failed, or does not support --version (declared floor ${gap.declaredMinVersion}).`,
      );
    } else {
      const bin = gap.versionCommand[0] ?? "the probe binary";
      out.push(
        `      the probe ran but its output did not contain a version for ${bin} (declared floor ${gap.declaredMinVersion}).`,
      );
    }
  }
  return out;
}

function formatPoliciesSection(report: DoctorReport): string[] {
  const out: string[] = ["", "Policies"];
  for (const p of report.policies) {
    // F7 (review round 2): mark derived-from-workflows[] provenance so
    // this list does not read as though every policy was hand-authored.
    const provenance = p.derived ? " (derived from workflows[])" : "";
    if (p.producerGap) {
      out.push(
        `  ⚠ ${p.name}${provenance}  requires fresh \`${p.producerGap.ledgerTag}\` (within ${p.producerGap.within}) but no manifest hook produces it AND the policy declares no \`producers:\` array`,
      );
      out.push(
        `      the gate will block its trigger until the tag is supplied out-of-band; add a producer hook (e.g. a SessionStart runner) OR document the manual recovery path in the policy's \`producers:\` array`,
      );
    } else {
      out.push(`  ✓ ${p.name}${provenance}  ${p.caveat}`);
    }
  }
  if (report.policies.length === 0) out.push(`  (no policies declared)`);
  return out;
}

// Policy Packs section: declared-but-not-live + per-pack `config:`
// shape gaps. A pack whose `source` or builtin `name` doesn't resolve
// gets silently skipped by `expandPolicyPacks`; a pack whose `config:`
// keys typo (`permision_profile`, `mode: "fastConfirm"`) falls through
// to runtime fallbacks and only surfaces when the hook finally fires.
// Both render ✗ here. Section stays silent when both lists are empty
// (the healthy case is common; a noisy ✓ would dilute doctor's signal).
function formatPolicyPacksSection(report: DoctorReport): string[] {
  const { unresolved, configIssues, versionGaps, uxDrift, solutionAcceptance } =
    report.policyPacks;
  if (
    unresolved.length === 0 &&
    configIssues.length === 0 &&
    versionGaps.length === 0 &&
    uxDrift.length === 0 &&
    solutionAcceptance.length === 0
  ) {
    return [];
  }
  const out: string[] = ["", "Policy Packs"];
  for (const u of unresolved) {
    out.push(`  ✗ ${u.name}  ${u.detail}`);
    out.push(
      `      the pack is declared but not live; its hooks will not fire at runtime. Fix \`source:\` or the pack \`name:\`, then re-run \`harness apply\`.`,
    );
  }
  for (const issue of configIssues) {
    const where =
      issue.configPath.length > 0 ? `.config.${issue.configPath}` : `.config`;
    out.push(`  ✗ ${issue.name}${where}  ${issue.message}`);
    out.push(
      `      the value is rejected by the pack's config schema; the runtime would fall back to a default and the misconfig would only surface when the hook fires.`,
    );
  }
  for (const gap of versionGaps) {
    out.push(`  ⚠ ${gap.name}.min_version  ${gap.message}`);
    out.push(
      `      the pack runs in degraded mode; any \`config:\` key that requires the newer release is silently ignored. Upgrade the package-side bin or lower the declared \`min_version\`.`,
    );
  }
  for (const drift of uxDrift) {
    out.push(`  ⚠ ${drift.name}.config.${drift.fields.join("/")}  ${drift.message}`);
  }
  for (const d of solutionAcceptance) {
    if (d.severity === "error") {
      out.push(`  ✗ ${d.path}  ${d.message}`);
    } else {
      out.push(`  ⚠ ${d.path}  ${d.message}`);
    }
  }
  return out;
}

function formatWorkflowsSection(report: DoctorReport): string[] {
  const w = report.workflows;
  if (w.declared === 0 && w.templates === 0) return [];
  const out: string[] = ["", "Workflows"];
  out.push(
    `  ${w.declared} declared, ${w.templates} review template${w.templates === 1 ? "" : "s"}`,
  );
  for (const e of w.entries) {
    const review = e.reviewSpawn
      ? `review: ${e.reviewSpawn}${e.reviewTemplate ? ` (${e.reviewTemplate})` : ""}`
      : "no review_subagent step";
    const merge = e.mergeGate ? `, merge.gate: ${e.mergeGate}` : "";
    const labels = e.taskLabels.length > 0 ? `, labels: ${e.taskLabels.join(",")}` : "";
    out.push(`  ✓ ${e.name}  ${e.steps} steps, ${review}${merge}${labels}`);
  }
  // Runtime merge-gate wiring health (F3 errors / F1 warnings, review
  // round 2, 99f47307 Slice 1). Rendered inline in the same section as
  // the declared workflows, above.
  for (const m of w.errors) out.push(`  ✗ ${m}`);
  for (const m of w.warnings) out.push(`  ⚠ ${m}`);
  return out;
}

// Risk Gate section: render only when at least one Risk Gate surface
// is configured (a classifier, a resolver, or a `when:`-policy).
// A manifest that uses none stays silent — no point in a section for
// an unused feature.
function formatRiskGateSection(report: DoctorReport): string[] {
  const rg = report.riskGate;
  if (rg.classifiers === 0 && rg.resolvers === 0 && rg.whenPolicies === 0) {
    return [];
  }
  const out: string[] = ["", "Risk Gate"];
  out.push(
    `  ${rg.classifiers} classifier${rg.classifiers === 1 ? "" : "s"}, ` +
      `${rg.resolvers} environment resolver${rg.resolvers === 1 ? "" : "s"}, ` +
      `${rg.whenPolicies} ${rg.whenPolicies === 1 ? "policy" : "policies"} with when:`,
  );
  if (rg.warnings.length === 0) {
    out.push(`  ✓ wiring coherent`);
  } else {
    for (const w of rg.warnings) out.push(`  ⚠ ${w}`);
  }
  // Bash command-prefix parsing is unconditionally on since v0.30.1; the
  // stat line is informational so the next "why didn't the gate fire?"
  // debugging session does not have to grep the source for it.
  out.push(`  ℹ resolver reads inline \`VAR=value\` env + leading \`cd <path> &&\` from Bash commands`);
  out.push(
    `  ℹ recent Risk Gate decisions: \`harness audit\` (filter with --outcome require_approval / deny)`,
  );
  return out;
}

// Template-policy drift section (task adf037c1): shipped operator_only
// security policies missing from an aged installed manifest. Render only
// when something is missing — a caught-up manifest stays silent, like the
// Risk Gate section.
function formatTemplateDriftSection(report: DoctorReport): string[] {
  const { errors, warnings } = report.templateDrift;
  if (errors.length === 0 && warnings.length === 0) return [];
  const out: string[] = ["", "Template drift (shipped security policies)"];
  for (const m of errors) out.push(`  ✗ ${m}`);
  for (const w of warnings) out.push(`  ⚠ ${w}`);
  return out;
}

// Trigger-boundary drift section (task 037cfb7c): shipped-by-name
// bash_match triggers whose boundary alternation has fallen behind
// FULL_TEMPLATE's. Render only when something is stale, a caught-up
// manifest stays silent, like the template-drift section immediately
// above.
function formatTriggerBoundaryDriftSection(report: DoctorReport): string[] {
  const { errors, warnings } = report.triggerBoundaryDrift;
  if (errors.length === 0 && warnings.length === 0) return [];
  const out: string[] = ["", "Trigger boundary drift (shipped bash_match triggers)"];
  for (const m of errors) out.push(`  ✗ ${m}`);
  for (const w of warnings) out.push(`  ⚠ ${w}`);
  return out;
}

// Hook-budget-vs-ledger-timeout margin section (task d20a7e0c): blocking,
// ledger-consulting hooks whose budget_ms cannot clear the derived
// worst-case ledger round-trip. Render only when something is under-
// budgeted — a compliant manifest stays silent, like the template-drift
// section immediately above.
function formatHookBudgetLedgerMarginSection(report: DoctorReport): string[] {
  const { errors } = report.hookBudgetLedgerMargin;
  if (errors.length === 0) return [];
  const out: string[] = ["", "Hook budget vs ledger timeout margin"];
  for (const m of errors) out.push(`  ✗ ${m}`);
  return out;
}

function formatCodexTargetSection(report: DoctorReport): string[] {
  if (!report.codexTarget) return [];
  const out: string[] = ["", "Target: codex"];
  for (const c of report.codexTarget.checks) {
    const marker = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
    out.push(`  ${marker} ${c.name}  ${c.message}`);
  }
  return out;
}

function formatOpencodeTargetSection(report: DoctorReport): string[] {
  if (!report.opencodeTarget) return [];
  const out: string[] = ["", "Target: opencode"];
  for (const c of report.opencodeTarget.checks) {
    const marker = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
    out.push(`  ${marker} ${c.name}  ${c.message}`);
  }
  return out;
}

/**
 * Wrap a filesystem path for safe inclusion inside a single-quoted shell
 * argument. Repo directory names under $HOME/git/* can contain quotes or
 * metacharacters (rare but possible: `foo's-repo`, `weird;name`); the
 * cleanup hint we render is meant to be copy-pasted into a shell, so the
 * quoted form must survive that round trip without rewriting other
 * directories. Standard POSIX recipe: close the open quote, insert an
 * escaped quote, reopen.
 */
function shellQuoteSingle(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function formatRogueLedgerSection(report: DoctorReport): string[] {
  if (report.rogueLedgerDbs.length === 0) return [];
  const out: string[] = ["", "Rogue evidence-ledger DBs"];
  for (const r of report.rogueLedgerDbs) {
    out.push(`  ⚠ rogue evidence-ledger db found: ${r.path}`);
    out.push(
      `      left over from the EVIDENCE_LEDGER_DB literal-tilde bug (agent-tasks/42d224a6).`,
    );
    out.push(`      safe to delete: \`rm -rf ${shellQuoteSingle(r.rogueDir)}\``);
  }
  return out;
}

function formatSummary(report: DoctorReport): string[] {
  const out: string[] = ["", "Summary"];
  const errLabel = report.errorCount === 1 ? "error" : "errors";
  const warnLabel = report.warningCount === 1 ? "warning" : "warnings";
  out.push(`  ${report.errorCount} ${errLabel}`);
  out.push(`  ${report.warningCount} ${warnLabel}`);
  return out;
}

// Grounding wiring section (task 129e1b94): rendered only when the report
// carries a grounding section, i.e. an enabled grounding-mcp entry exists.
// Manifests that don't use grounding stay silent, same policy as the Risk
// Gate section above.
function formatGroundingSection(report: DoctorReport): string[] {
  const g = report.grounding;
  if (g === undefined) return [];
  const out: string[] = ["", "Grounding"];
  const source = g.envOverride !== null ? "operator env override" : "grounding.evidence_ledger.path";
  out.push(`  evidence ledger: ${g.ledgerPath} (${source})`);
  if (g.warnings.length === 0) {
    out.push("  ✓ ledger path writable; grounding: projects EVIDENCE_LEDGER_DB onto grounding-mcp");
  } else {
    for (const w of g.warnings) out.push(`  ⚠ ${w}`);
  }
  return out;
}

/**
 * Single choke point for peer-controlled strings reaching doctor's
 * plain-text output (task 13919613, mirroring the CR/LF strip
 * `note()` in src/cli/session-start/toolchain-parity.ts applies at ITS
 * own choke point). A peer snapshot's `profile` field, and every value
 * (npm package name/version, node version, OW-Kit version, MCP server
 * name) baked into a `compareToPeer` drift `message`, is untrusted,
 * cross-machine-synced content — agent-memory-sync populates the
 * machine-state directory from other machines this repo does not
 * control. A crafted `\n`/`\r` inside any of those could otherwise forge
 * a fake standalone doctor line (e.g. a spoofed "0 errors" Summary).
 * Applied at render time, not at collection time, so it protects every
 * site below regardless of which reused field the value flows through.
 */
function stripCrLf(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}

function formatToolchainParitySection(report: DoctorReport): string[] {
  const tp = report.toolchainParity;
  if (tp === undefined) return [];
  const out: string[] = ["", "Toolchain Parity"];
  if (tp.status === "skipped" || tp.status === "no-peers") {
    out.push(`  ~ ${stripCrLf(tp.message)}`);
    return out;
  }
  for (const p of tp.peers) {
    const marker = p.status === "ok" ? "✓" : "⚠";
    const label = p.status === "ok" ? "ok" : `drift:${p.driftCount}`;
    out.push(
      `  ${marker} ${stripCrLf(p.peerProfile)}  ${label} (snapshot age ${p.ageLabel})`,
    );
    for (const d of p.drift) out.push(`      drift — ${stripCrLf(d.message)}`);
  }
  if (tp.unparseablePeers.length > 0) {
    out.push(
      `  ⚠ ${tp.unparseablePeers.length} peer snapshot(s) could not be parsed: ` +
        tp.unparseablePeers.map(stripCrLf).join(", "),
    );
  }
  return out;
}

function formatClaudeMcpSection(report: DoctorReport): string[] {
  const c = report.claudeMcp;
  if (c === undefined) return [];
  const out: string[] = ["", "Claude Code MCP Registration"];
  out.push(
    "  ℹ verified via `claude mcp list` (user scope); assumes Claude Code is the effective " +
      "MCP runtime — doctor has no per-runtime gate for this check yet",
  );
  switch (c.listStatus) {
    case "skipped":
      out.push(`  ~ not probed (${c.listMessage ?? "--shallow"})`);
      break;
    case "cli-missing":
      out.push("  ~ claude CLI not found on PATH — skipping live registration check");
      break;
    case "timeout":
    case "error":
      // The explanatory line is rendered via the `warnings` loop below
      // (it also needs to roll into warningCount, so it lives there —
      // rendering it twice would just duplicate the same text).
      break;
    case "ok":
      if (c.entries.length === 0) {
        out.push("  (no enabled tools.mcp[] servers to check)");
      } else {
        for (const e of c.entries) {
          const marker = e.status === "ok" ? "✓" : e.status === "warn" ? "⚠" : "✗";
          out.push(`  ${marker} ${e.name}  ${e.message}`);
        }
      }
      break;
  }
  for (const w of c.warnings) out.push(`  ⚠ ${w}`);
  return out;
}

export function format(report: DoctorReport): string {
  const lines: string[] = [formatHeader(report)];
  lines.push(...formatManifestSection(report));
  lines.push(...formatEnvironmentSection(report));
  lines.push(...formatToolsSection(report));
  lines.push(...formatMemorySection(report));
  lines.push(...formatHooksSection(report));
  lines.push(...formatPolicyPackHookVersionsSection(report));
  lines.push(...formatPoliciesSection(report));
  lines.push(...formatPolicyPacksSection(report));
  lines.push(...formatWorkflowsSection(report));
  lines.push(...formatRiskGateSection(report));
  lines.push(...formatTemplateDriftSection(report));
  lines.push(...formatTriggerBoundaryDriftSection(report));
  lines.push(...formatHookBudgetLedgerMarginSection(report));
  lines.push(...formatGroundingSection(report));
  lines.push(...formatClaudeMcpSection(report));
  lines.push(...formatToolchainParitySection(report));
  lines.push(...formatCodexTargetSection(report));
  lines.push(...formatOpencodeTargetSection(report));
  lines.push(...formatRogueLedgerSection(report));
  lines.push(...formatSummary(report));
  lines.push("");
  return lines.join("\n");
}
