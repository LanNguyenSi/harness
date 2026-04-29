export type ChangeKind = "added" | "removed" | "modified";

export interface Change {
  kind: ChangeKind;
  path: string;
  before?: unknown;
  after?: unknown;
}

const PILLAR_ORDER = ["version", "grounding", "tools", "memory", "hooks", "policies"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNameKeyedList(arr: unknown[]): arr is Array<Record<string, unknown> & { name: string }> {
  if (arr.length === 0) return false;
  return arr.every((item) => isPlainObject(item) && typeof item.name === "string");
}

function fmtPath(parts: Array<string | number>): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "number") {
      out += `[${p}]`;
    } else if (out === "") {
      out = p;
    } else {
      out += `.${p}`;
    }
  }
  return out;
}

function fmtPathWithName(parts: Array<string | number | { name: string }>): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "number") {
      out += `[${p}]`;
    } else if (typeof p === "object") {
      out += `[${p.name}]`;
    } else if (out === "") {
      out = p;
    } else {
      out += `.${p}`;
    }
  }
  return out;
}

function diffArrays(
  before: unknown[],
  after: unknown[],
  pathParts: Array<string | number | { name: string }>,
  out: Change[],
): void {
  const beforeNamed = isNameKeyedList(before);
  const afterNamed = isNameKeyedList(after);
  if (beforeNamed && afterNamed) {
    const byName = new Map<string, Record<string, unknown>>();
    for (const item of before) byName.set(item.name, item);
    const seen = new Set<string>();
    for (const item of after) {
      const prev = byName.get(item.name);
      seen.add(item.name);
      if (!prev) {
        out.push({ kind: "added", path: fmtPathWithName([...pathParts, { name: item.name }]), after: item });
      } else {
        diffValue(prev, item, [...pathParts, { name: item.name }], out);
      }
    }
    for (const [name, item] of byName) {
      if (!seen.has(name)) {
        out.push({ kind: "removed", path: fmtPathWithName([...pathParts, { name }]), before: item });
      }
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ kind: "modified", path: fmtPathWithName(pathParts), before, after });
  }
}

function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  pathParts: Array<string | number | { name: string }>,
  out: Change[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (a === undefined && b !== undefined) {
      out.push({ kind: "added", path: fmtPathWithName([...pathParts, key]), after: b });
    } else if (b === undefined && a !== undefined) {
      out.push({ kind: "removed", path: fmtPathWithName([...pathParts, key]), before: a });
    } else if (!equal(a, b)) {
      diffValue(a, b, [...pathParts, key], out);
    }
  }
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffValue(
  before: unknown,
  after: unknown,
  pathParts: Array<string | number | { name: string }>,
  out: Change[],
): void {
  if (equal(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, pathParts, out);
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    diffObjects(before, after, pathParts, out);
    return;
  }
  out.push({ kind: "modified", path: fmtPathWithName(pathParts), before, after });
}

export function diffManifests(before: unknown, after: unknown): Change[] {
  const out: Change[] = [];
  diffValue(before, after, [], out);
  return out;
}

function pillarOf(changePath: string): string {
  for (const pillar of PILLAR_ORDER) {
    if (changePath === pillar || changePath.startsWith(`${pillar}.`) || changePath.startsWith(`${pillar}[`)) {
      return pillar;
    }
  }
  return "(other)";
}

export function groupByPillar(changes: Change[]): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  for (const pillar of PILLAR_ORDER) out.set(pillar, []);
  out.set("(other)", []);
  for (const c of changes) {
    const p = pillarOf(c.path);
    out.get(p)!.push(c);
  }
  for (const [k, v] of out) if (v.length === 0) out.delete(k);
  return out;
}

function renderValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function formatDiff(changes: Change[]): string {
  if (changes.length === 0) return "no changes\n";
  const lines: string[] = [];
  const grouped = groupByPillar(changes);
  for (const [pillar, group] of grouped) {
    lines.push(`## ${pillar}`);
    for (const c of group) {
      switch (c.kind) {
        case "added":
          lines.push(`+ ${c.path}: ${renderValue(c.after)}`);
          break;
        case "removed":
          lines.push(`- ${c.path}: ${renderValue(c.before)}`);
          break;
        case "modified":
          lines.push(`~ ${c.path}: ${renderValue(c.before)} → ${renderValue(c.after)}`);
          break;
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

export const __testables = { isNameKeyedList, fmtPath, pillarOf };
