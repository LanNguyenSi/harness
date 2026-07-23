// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (tests/ cannot declare it — TS
// rejects both an in-file "augmentation" of an already-resolved untyped
// module and a same-string declaration from a different file), so
// typecheck:tests (tsconfig.test.json) needs this sibling .d.mts to type
// tests/scripts/check-ug-schema-drift.test.ts's import without `any`.
// Keep in sync with the exports in check-ug-schema-drift.mjs.

export function labelToCamelKey(label: string): string;

export function extractUpstreamSectionKeys(parserSource: string): string[];

export function walkSectionsArray(parserSource: string, openIdx: number): number;

export interface KeyDiff {
  onlyLocal: string[];
  onlyUpstream: string[];
  orderMismatch: boolean;
}

export function diffKeys(localKeys: string[], upstreamKeys: string[]): KeyDiff | null;

export function loadHarnessMirror(): Promise<string[]>;
