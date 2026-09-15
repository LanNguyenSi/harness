// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (tests/ cannot declare it — TS
// rejects both an in-file "augmentation" of an already-resolved untyped
// module and a same-string declaration from a different file), so
// typecheck:tests (tsconfig.test.json) needs this sibling .d.mts to type
// tests/scripts/check-no-raw-control-bytes.test.ts's import without `any`.
// Keep in sync with the exports in check-no-raw-control-bytes.mjs.

export const REPO_ROOT: string;
export const SCAN_DIRS: string[];
export const SKIPPED_DIRECTORY_NAMES: Set<string>;
export const ROOT_FILE_EXTENSIONS: Set<string>;
export const BINARY_EXTENSIONS: Set<string>;
export const EXIT_VIOLATION: number;
export const EXIT_IO_ERROR: number;

export interface AllowedControlByteEntry {
  count: number;
  reason: string;
}

export const ALLOWED_CONTROL_BYTE_FILES: Map<string, AllowedControlByteEntry>;

export function collectScanFiles(dir: string, out?: string[]): string[];
export function collectRootFiles(rootDir: string): string[];
export function findControlByteOffsets(buffer: Buffer): number[];

export type ControlByteEvaluation =
  | { status: "clean"; offsets: number[] }
  | { status: "unlisted-violation"; offsets: number[] }
  | { status: "count-mismatch"; offsets: number[]; expectedCount: number; actualCount: number }
  | { status: "count-match"; offsets: number[]; expectedCount: number; actualCount: number };

export function evaluateFile(
  relPath: string,
  offsets: number[],
  allowlist?: Map<string, AllowedControlByteEntry>,
): ControlByteEvaluation;

export function main(rootDir?: string): void;
