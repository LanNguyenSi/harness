// YAML-document mutators for `harness pack` add/remove. Pure functions over
// the on-disk `harness.yaml` text, mirroring src/cli/add/mutate.ts and
// src/cli/remove/mutate.ts.

import { isMap, isSeq, parseDocument } from "yaml";

export interface PackAddEntry {
  name: string;
  source?: string;
  enabled?: boolean;
  description?: string;
  config?: Record<string, unknown>;
}

export interface PackRemovePlan {
  found: boolean;
  availableNames: string[];
}

export function applyPackAdd(yamlText: string, entry: PackAddEntry): string {
  const doc = parseDocument(yamlText);
  // Build a YAML-friendly plain object. Only emit fields the caller set so the
  // resulting manifest stays minimal (the schema fills in defaults at parse
  // time).
  const plain: Record<string, unknown> = { name: entry.name };
  if (entry.source !== undefined) plain["source"] = entry.source;
  if (entry.enabled !== undefined) plain["enabled"] = entry.enabled;
  if (entry.description !== undefined) plain["description"] = entry.description;
  if (entry.config !== undefined && Object.keys(entry.config).length > 0) {
    plain["config"] = entry.config;
  }
  const node = doc.getIn(["policy_packs"]);
  if (node === undefined || node === null) {
    // setIn with `[plain]` materialises a YAML Seq containing the entry.
    // Doing setIn(path, []) followed by getIn(path) returns the JS array
    // unchanged — same footgun src/cli/add/mutate.ts already navigates
    // around. Match that pattern: create-with-entry in one step.
    doc.setIn(["policy_packs"], [plain]);
  } else if (isSeq(node)) {
    node.add(plain);
  } else {
    throw new Error(`expected a YAML sequence at policy_packs, got ${typeof node}`);
  }
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

export function planPackRemove(yamlText: string, name: string): PackRemovePlan {
  const doc = parseDocument(yamlText);
  const node = doc.getIn(["policy_packs"]);
  if (!isSeq(node)) {
    return { found: false, availableNames: [] };
  }
  const names: string[] = [];
  let found = false;
  for (const item of node.items) {
    if (!isMap(item)) continue;
    const itemName = item.get("name");
    if (typeof itemName !== "string") continue;
    names.push(itemName);
    if (itemName === name) found = true;
  }
  return { found, availableNames: names };
}

export function applyPackRemove(yamlText: string, name: string): string {
  const doc = parseDocument(yamlText);
  const node = doc.getIn(["policy_packs"]);
  if (!isSeq(node)) return yamlText;
  for (let i = 0; i < node.items.length; i++) {
    const item = node.items[i];
    if (!isMap(item)) continue;
    const itemName = item.get("name");
    if (typeof itemName === "string" && itemName === name) {
      node.delete(i);
      // If the array became empty, leave it as `policy_packs: []` rather
      // than removing the key entirely. Keeping the key surface visible
      // helps the next `harness pack add` round-trip cleanly.
      return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
    }
  }
  return yamlText;
}

