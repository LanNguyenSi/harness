import { isMap, isSeq, parseDocument, type Document } from "yaml";

export type AddType = "mcp" | "cli" | "skill" | "hook";

export interface McpEntry {
  name: string;
  command: string | string[];
  env?: Record<string, string>;
  health?: { verb: string; timeout_ms?: number };
  enabled?: boolean;
  min_version?: string;
  version_command?: string[];
}

export interface CliEntry {
  name: string;
  binary: string;
  required?: boolean;
  min_version?: string;
}

export interface HookEntry {
  name: string;
  event: string;
  command: string;
  match?: string;
  blocking: boolean | "soft" | "hard";
  budget_ms?: number;
}

export type AddEntry =
  | { type: "mcp"; entry: McpEntry }
  | { type: "mcp_replace"; name: string; entry: McpEntry }
  | { type: "cli"; entry: CliEntry }
  | { type: "skill"; entry: string }
  | { type: "hook"; entry: HookEntry };

export function applyAdd(yamlText: string, action: AddEntry): string {
  const doc = parseDocument(yamlText);
  switch (action.type) {
    case "mcp":
      addToSequence(doc, ["tools", "mcp"], action.entry);
      break;
    case "mcp_replace":
      replaceOrAppendByName(doc, ["tools", "mcp"], action.name, action.entry);
      break;
    case "cli":
      addToSequence(doc, ["tools", "cli"], action.entry);
      break;
    case "skill":
      addToSequence(doc, ["tools", "skills", "enabled"], action.entry);
      break;
    case "hook":
      addToSequence(doc, ["hooks"], action.entry);
      break;
  }
  // Match the conventions used elsewhere in the codebase so a no-op round-trip
  // on a manifest authored in our style stays byte-equivalent (lineWidth:0
  // disables 80-col folding on long flow sequences; flowCollectionPadding:false
  // matches the [a, b] style without inner spaces).
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

function addToSequence(
  doc: Document.Parsed,
  pathSegments: string[],
  entry: unknown,
): void {
  const node = doc.getIn(pathSegments);
  if (node === undefined || node === null) {
    doc.setIn(pathSegments, [entry]);
    return;
  }
  if (isSeq(node)) {
    node.add(entry);
    return;
  }
  throw new Error(
    `expected a YAML sequence at ${pathSegments.join(".")}, got ${typeof node}`,
  );
}

// Find the first item in the sequence whose `name:` matches; replace it. If
// no match is found, append (so the call site doesn't need to branch on
// "exists vs new"). Comments and other YAML niceties on the original node are
// dropped on replace; that is acceptable for the adopt round-trip use case
// (the replacement is the user's hand-edit becoming the new source of truth).
function replaceOrAppendByName(
  doc: Document.Parsed,
  pathSegments: string[],
  name: string,
  entry: unknown,
): void {
  const node = doc.getIn(pathSegments);
  if (node === undefined || node === null) {
    doc.setIn(pathSegments, [entry]);
    return;
  }
  if (!isSeq(node)) {
    throw new Error(
      `expected a YAML sequence at ${pathSegments.join(".")}, got ${typeof node}`,
    );
  }
  for (let i = 0; i < node.items.length; i++) {
    const item = node.items[i];
    if (!isMap(item)) continue;
    const itemName = item.get("name");
    if (typeof itemName === "string" && itemName === name) {
      node.set(i, entry);
      return;
    }
  }
  node.add(entry);
}
