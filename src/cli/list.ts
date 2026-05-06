import { inspectMemory } from "../probes/memory.js";
import type { Manifest } from "../schema/index.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export type ListCategory =
  | "mcp"
  | "cli"
  | "skills"
  | "memories"
  | "hooks"
  | "policies"
  | "workflows";

const CATEGORIES: readonly ListCategory[] = [
  "mcp",
  "cli",
  "skills",
  "memories",
  "hooks",
  "policies",
  "workflows",
];

export function isListCategory(s: string): s is ListCategory {
  return (CATEGORIES as readonly string[]).includes(s);
}

export interface ListOptions extends LoaderOptions {
  filter?: string;
  json?: boolean;
}

export interface ListResult {
  output: string;
  rows: Record<string, unknown>[];
}

function applyFilter<T extends { name?: string; path?: string }>(
  rows: T[],
  filter: string | undefined,
): T[] {
  if (!filter) return rows;
  const needle = filter.toLowerCase();
  return rows.filter((r) => {
    const haystack = (r.name ?? r.path ?? "").toString().toLowerCase();
    return haystack.includes(needle);
  });
}

function buildMcpRows(manifest: Manifest): Record<string, unknown>[] {
  return manifest.tools.mcp.map((m) => ({
    name: m.name,
    enabled: m.enabled !== false,
    health_verb: m.health?.verb ?? null,
    timeout_ms: m.health?.timeout_ms ?? null,
    command: Array.isArray(m.command) ? m.command.join(" ") : m.command,
  }));
}

function buildCliRows(manifest: Manifest): Record<string, unknown>[] {
  return manifest.tools.cli.map((c) => ({
    name: c.name,
    binary: c.binary,
    required: !!c.required,
    min_version: c.min_version ?? null,
  }));
}

function buildSkillRows(manifest: Manifest): Record<string, unknown>[] {
  const required = new Set(manifest.tools.skills.required ?? []);
  return manifest.tools.skills.enabled.map((name) => ({
    name,
    required: required.has(name),
  }));
}

function buildMemoryRows(manifest: Manifest, opts: ListOptions): Record<string, unknown>[] {
  const report = inspectMemory(manifest, {
    homeDir: opts.homeDir,
    project: opts.project,
  });
  const out: Record<string, unknown>[] = [];
  for (const dir of report.directories) {
    out.push({
      path: dir.path,
      scope: dir.scope,
      exists: dir.exists,
      stale_count: report.staleMemories.filter((s) => s.path.startsWith(dir.path)).length,
    });
  }
  return out;
}

function buildHookRows(manifest: Manifest): Record<string, unknown>[] {
  return manifest.hooks.map((h) => ({
    name: h.name,
    event: h.event,
    blocking: h.blocking === false ? "false" : h.blocking,
    match: h.match ?? null,
    command: h.command,
  }));
}

function buildPolicyRows(manifest: Manifest): Record<string, unknown>[] {
  return manifest.policies.map((p) => ({
    name: p.name,
    enforcement: p.enforcement,
    event: p.trigger.event,
    hook: p.hook,
    requires_tag: p.requires.ledger_tag,
  }));
}

function buildWorkflowRows(manifest: Manifest): Record<string, unknown>[] {
  return manifest.workflows.map((wf) => {
    const review = wf.steps.find((s) => s.kind === "review_subagent");
    const merge = wf.steps.find((s) => s.kind === "merge");
    return {
      name: wf.name,
      steps: wf.steps.length,
      review_spawn: review?.kind === "review_subagent" ? review.spawn : "",
      review_template: review?.kind === "review_subagent" ? (review.template ?? "") : "",
      merge_gate: merge?.kind === "merge" ? merge.gate : "",
      task_label: wf.when.task_label?.join(",") ?? "",
    };
  });
}

function buildRows(category: ListCategory, manifest: Manifest, opts: ListOptions) {
  switch (category) {
    case "mcp":
      return buildMcpRows(manifest);
    case "cli":
      return buildCliRows(manifest);
    case "skills":
      return buildSkillRows(manifest);
    case "memories":
      return buildMemoryRows(manifest, opts);
    case "hooks":
      return buildHookRows(manifest);
    case "policies":
      return buildPolicyRows(manifest);
    case "workflows":
      return buildWorkflowRows(manifest);
  }
}

function renderText(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no entries)\n";
  const headers = Object.keys(rows[0]!);
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h] ?? "").length)),
  );
  const pad = (s: string, w: number) => s.padEnd(w, " ");
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i]!)).join("  "));
  lines.push(headers.map((_, i) => "-".repeat(widths[i]!)).join("  "));
  for (const row of rows) {
    lines.push(
      headers.map((h, i) => pad(String(row[h] ?? ""), widths[i]!)).join("  "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function list(category: ListCategory, opts: ListOptions = {}): ListResult {
  const { manifest } = loadManifest(opts);
  const all = buildRows(category, manifest, opts);
  const rows = applyFilter(all, opts.filter);
  const output = opts.json ? `${JSON.stringify(rows, null, 2)}\n` : renderText(rows);
  return { output, rows };
}
