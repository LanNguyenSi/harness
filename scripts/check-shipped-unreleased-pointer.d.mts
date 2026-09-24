// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (tests/ cannot declare it - TS
// rejects both an in-file "augmentation" of an already-resolved untyped
// module and a same-string declaration from a different file), so
// typecheck:tests (tsconfig.test.json) needs this sibling .d.mts to type
// tests/scripts/check-shipped-unreleased-pointer.test.ts's import without
// `any`. Keep in sync with the exports in check-shipped-unreleased-pointer.mjs.

export const REPO_ROOT: string;

export function collectFiles(dir: string, out?: string[]): string[];

export function resolveScannedFiles(rootDir?: string): string[];

export function findPointerHit(absPath: string): boolean;

export function run(rootDir?: string): number;

export function main(rootDir?: string): void;
