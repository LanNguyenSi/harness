// Pack `source:` strings parse here. v1 only resolves `builtin`; future
// values (`path:./foo`, `npm:@scope/pack@1.0.0`, `git:https://...`) are
// reserved for community-authored packs and surface as `kind: "unknown"`
// today, with the canonical-doc-pointer in the warning.

export type PackSourceKind = "builtin" | "unknown";

export interface PackSourceParseResult {
  kind: PackSourceKind;
  raw: string;
}

export function parsePackSource(source: string): PackSourceParseResult {
  if (source === "builtin") return { kind: "builtin", raw: source };
  return { kind: "unknown", raw: source };
}
