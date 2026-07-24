// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (tests/ cannot declare it — TS
// rejects both an in-file "augmentation" of an already-resolved untyped
// module and a same-string declaration from a different file), so
// typecheck:tests (tsconfig.test.json) needs this sibling .d.mts to type
// tests/scripts/check-no-only.test.ts's import without `any`.
// Keep in sync with the exports in check-no-only.mjs.

export function collectTestSourceFiles(dir: string, out?: string[]): string[];

export interface OnlyViolation {
  line: number;
  column: number;
  holder: string;
}

export function findOnlyViolations(source: string, fileName?: string): OnlyViolation[];
