import type { DoctorReport, McpProbeResult } from "./types.js";
import { VERSION } from "../../version.js";

function mcpLine(r: McpProbeResult, shallow: boolean): string {
  switch (r.outcome.kind) {
    case "healthy":
      return shallow
        ? `    ~ ${r.name}  manifest-only (probe skipped)`
        : `    ✓ ${r.name}  healthy in ${r.outcome.latencyMs}ms`;
    case "error":
      return `    ✗ ${r.name}  FAILED: ${r.outcome.message}`;
    case "no-response": {
      // Render distinct from `error` so a clean exit-0 ("config issue")
      // is not framed as a process crash. The visual marker stays ✗
      // because the server still failed to answer the doctor.
      const phase =
        r.outcome.phase === "initialize"
          ? "initialize"
          : `${r.outcome.verb ?? "verb"} call`;
      return `    ✗ ${r.name}  no JSON-RPC response (process exited cleanly during ${phase})`;
    }
    case "missing-verb":
      return `    ? ${r.name}  unknown — no health verb declared`;
    case "disabled":
      return `    ✓ ${r.name}  disabled (skipped)`;
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

function formatToolsSection(report: DoctorReport): string[] {
  const out: string[] = ["", "Tools"];
  out.push(`  MCP servers (${report.tools.mcp.length} declared)`);
  for (const m of report.tools.mcp) out.push(mcpLine(m, report.shallow));

  const cliCount = report.tools.cli.length;
  out.push(`  CLI tools (${cliCount} declared)`);
  for (const c of report.tools.cli) {
    const marker = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
    out.push(`    ${marker} ${c.name}  ${c.message}`);
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
  for (const d of report.memory.directories) {
    if (!d.exists) {
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
  }
  if (report.hooks.length === 0) out.push(`  (no hooks declared)`);
  return out;
}

function formatPoliciesSection(report: DoctorReport): string[] {
  const out: string[] = ["", "Policies"];
  for (const p of report.policies) {
    out.push(`  ✓ ${p.name}  ${p.caveat}`);
  }
  if (report.policies.length === 0) out.push(`  (no policies declared)`);
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

export function format(report: DoctorReport): string {
  const lines: string[] = [formatHeader(report)];
  lines.push(...formatManifestSection(report));
  lines.push(...formatToolsSection(report));
  lines.push(...formatMemorySection(report));
  lines.push(...formatHooksSection(report));
  lines.push(...formatPoliciesSection(report));
  lines.push(...formatWorkflowsSection(report));
  lines.push(...formatSummary(report));
  lines.push("");
  return lines.join("\n");
}
