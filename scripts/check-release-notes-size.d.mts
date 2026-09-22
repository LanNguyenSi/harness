// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types - same rationale as
// check-changelog-coverage.d.mts (typecheck:tests needs this sibling
// .d.mts to type tests/scripts/check-release-notes-size.test.ts's import
// without `any`).
// Keep in sync with the exports in check-release-notes-size.mjs.

export const CEILING: number;

export function extractVersionSectionLines(changelogText: string, version: string): string[];

export function extractVersionSection(changelogText: string, version: string): string;

export function measureExtractedSize(lines: string[]): number;

export function main(repoDir?: string): void;
