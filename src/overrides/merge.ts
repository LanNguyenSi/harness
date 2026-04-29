export class OverrideMergeError extends Error {
  constructor(message: string, public readonly path: string[]) {
    super(`override merge failed at ${formatPath(path)}: ${message}`);
    this.name = "OverrideMergeError";
  }
}

function formatPath(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

const TOMBSTONE: unique symbol = Symbol("override-tombstone");
type Tombstone = typeof TOMBSTONE;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isNameKeyedEntry(v: unknown): v is Record<string, unknown> & { name: string } {
  return isPlainObject(v) && typeof v.name === "string" && v.name.length > 0;
}

function classifyList(
  list: unknown[],
  pathLabel: string,
  path: string[],
): "named" | "plain" | "empty" {
  if (list.length === 0) return "empty";
  let named = 0;
  let plain = 0;
  for (const item of list) {
    if (isNameKeyedEntry(item)) named++;
    else plain++;
  }
  if (named > 0 && plain > 0) {
    throw new OverrideMergeError(
      `${pathLabel} list mixes entries that have a "name" field with entries that do not; lists must be uniformly name-keyed or not`,
      path,
    );
  }
  return named > 0 ? "named" : "plain";
}

function mergeNamedList(
  base: unknown[],
  override: unknown[],
  path: string[],
): unknown[] {
  const baseShape = classifyList(base, "base", path);
  const overrideShape = classifyList(override, "override", path);

  if (baseShape !== "empty" && overrideShape !== "empty" && baseShape !== overrideShape) {
    throw new OverrideMergeError(
      `cannot merge override ${overrideShape}-list onto base ${baseShape}-list; declare the override as the same shape or omit it`,
      path,
    );
  }

  if (overrideShape !== "named") {
    if (overrideShape === "empty") return [];
    return [...override];
  }

  const result: unknown[] = [];
  const seenNames = new Set<string>();

  if (baseShape === "named") {
    for (const baseEntry of base as Array<Record<string, unknown> & { name: string }>) {
      const matching = (override as Array<Record<string, unknown> & { name: string }>).find(
        (o) => o.name === baseEntry.name,
      );
      if (!matching) {
        result.push(baseEntry);
        seenNames.add(baseEntry.name);
        continue;
      }
      seenNames.add(baseEntry.name);
      if (matching._delete === true) continue;
      const merged = mergeValue(baseEntry, matching, [...path, baseEntry.name]);
      if (merged === TOMBSTONE) continue;
      result.push(merged);
    }
  }

  for (const overrideEntry of override as Array<Record<string, unknown> & { name: string }>) {
    if (seenNames.has(overrideEntry.name)) continue;
    if (overrideEntry._delete === true) continue;
    const cleaned = stripTombstones(overrideEntry, [...path, overrideEntry.name]);
    if (cleaned === TOMBSTONE) continue;
    result.push(cleaned);
  }

  return result;
}

function stripTombstones(value: unknown, path: string[]): unknown | Tombstone {
  if (value === null) return TOMBSTONE;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      const child = stripTombstones(v, [...path, String(i)]);
      if (child === TOMBSTONE) continue;
      result.push(child);
    }
    return result;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "_delete") continue;
      const child = stripTombstones(v, [...path, k]);
      if (child === TOMBSTONE) continue;
      out[k] = child;
    }
    return out;
  }
  return value;
}

function mergeValue(base: unknown, override: unknown, path: string[]): unknown | Tombstone {
  if (override === null) return TOMBSTONE;
  if (Array.isArray(override)) {
    if (Array.isArray(base)) {
      return mergeNamedList(base, override, path);
    }
    return stripTombstones(override, path);
  }
  if (isPlainObject(override)) {
    if (!isPlainObject(base)) {
      const cleaned = stripTombstones(override, path);
      return cleaned === TOMBSTONE ? TOMBSTONE : cleaned;
    }
    const out: Record<string, unknown> = { ...base };
    for (const [key, overrideChild] of Object.entries(override)) {
      if (key === "_delete") continue;
      const baseChild = out[key];
      const merged = mergeValue(baseChild, overrideChild, [...path, key]);
      if (merged === TOMBSTONE) {
        delete out[key];
      } else {
        out[key] = merged;
      }
    }
    return out;
  }
  return override;
}

export function mergeManifest(base: unknown, override: unknown): unknown {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const result = mergeValue(base, override, []);
  return result === TOMBSTONE ? undefined : result;
}

export function applyLayers(base: unknown, ...layers: Array<unknown | undefined>): unknown {
  let acc = base;
  for (const layer of layers) {
    if (layer === undefined) continue;
    acc = mergeManifest(acc, layer);
  }
  return acc;
}
