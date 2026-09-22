// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types - same rationale as
// check-changelog-coverage.d.mts (typecheck:tests needs this sibling
// .d.mts to type tests/scripts/check-readme-release-version.test.ts's
// import without `any`).
// Keep in sync with the exports in check-readme-release-version.mjs.

export function extractReadmeVersion(readmeText: string): string | null;

export function main(repoDir?: string): void;
