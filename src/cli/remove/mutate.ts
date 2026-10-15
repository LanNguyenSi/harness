import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export type RemoveType = "mcp" | "cli" | "skill" | "hook";

const TYPE_TO_PATH: Record<RemoveType, readonly string[]> = {
  mcp: ["tools", "mcp"],
  cli: ["tools", "cli"],
  skill: ["tools", "skills", "enabled"],
  hook: ["hooks"],
};

export interface RemovePlan {
  found: boolean;
  availableNames: string[];
}

export function planRemove(
  yamlText: string,
  type: RemoveType,
  name: string,
): RemovePlan {
  const doc = parseDocument(yamlText);
  const list = doc.getIn(TYPE_TO_PATH[type]);
  const availableNames = listEntryNames(list, type);
  const found = availableNames.includes(name);
  return { found, availableNames };
}

export function applyRemove(
  yamlText: string,
  type: RemoveType,
  name: string,
): string {
  const doc = parseDocument(yamlText);
  const list = doc.getIn(TYPE_TO_PATH[type]);
  if (!isSeq(list)) {
    throw new Error(
      `expected a YAML sequence at ${TYPE_TO_PATH[type].join(".")}, found none`,
    );
  }
  const idx = list.items.findIndex((item) => entryNameOf(item, type) === name);
  if (idx < 0) {
    throw new Error(`${type} entry "${name}" not found`);
  }
  list.items.splice(idx, 1);
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

function listEntryNames(list: unknown, type: RemoveType): string[] {
  if (!isSeq(list)) return [];
  return list.items
    .map((item) => entryNameOf(item, type))
    .filter((s): s is string => typeof s === "string");
}

function entryNameOf(item: unknown, type: RemoveType): string | undefined {
  if (type === "skill") {
    if (isScalar(item) && typeof item.value === "string") return item.value;
    if (typeof item === "string") return item;
    return undefined;
  }
  if (isMap(item)) {
    const n = item.get("name");
    if (typeof n === "string") return n;
  }
  return undefined;
}
