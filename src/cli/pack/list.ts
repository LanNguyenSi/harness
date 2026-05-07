// `harness pack list` — flat read of policy_packs[] for shell consumption.
//
// Output rows match the existing `harness list <category>` shape so the
// rendering helper (renderText vs JSON) stays consistent across categories.
// Today the columns are: name, source, enabled, mode, description.

import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

export interface PackListOptions extends LoaderOptions {
  enabledOnly?: boolean;
  json?: boolean;
}

export interface PackListResult {
  output: string;
  rows: Record<string, unknown>[];
}

function modeOf(pack: Manifest["policy_packs"][number]): string {
  const raw = pack.config["mode"];
  return typeof raw === "string" ? raw : "";
}

function buildRows(manifest: Manifest, opts: PackListOptions): Record<string, unknown>[] {
  let entries = manifest.policy_packs;
  if (opts.enabledOnly) entries = entries.filter((p) => p.enabled);
  return entries.map((p) => ({
    name: p.name,
    source: p.source,
    enabled: p.enabled,
    mode: modeOf(p),
    description: p.description ?? "",
  }));
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
    lines.push(headers.map((h, i) => pad(String(row[h] ?? ""), widths[i]!)).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

export function packList(opts: PackListOptions = {}): PackListResult {
  const { manifest } = loadManifest(opts);
  const rows = buildRows(manifest, opts);
  const output = opts.json ? `${JSON.stringify(rows, null, 2)}\n` : renderText(rows);
  return { output, rows };
}
