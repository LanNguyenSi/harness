// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types — same rationale as
// check-no-only.d.mts (typecheck:tests needs this sibling .d.mts to type
// tests/scripts/check-changelog-coverage.test.ts's import without `any`).
// Keep in sync with the exports in check-changelog-coverage.mjs.

export const SKIPPED_TYPES: Set<string>;

export interface CommitRecord {
  sha: string;
  subject: string;
  message: string;
}

export interface LinkTokens {
  taskIds: string[];
  prNumbers: string[];
  ghsaIds: string[];
  shortSha: string;
}

export interface UncoveredCommit extends CommitRecord {
  tokens: LinkTokens;
}

export interface Classification {
  skipped: CommitRecord[];
  covered: CommitRecord[];
  uncovered: UncoveredCommit[];
}

export function extractUnreleased(changelogText: string): string | null;

export function parseCommits(rawLog: string): CommitRecord[];

export function commitType(subject: string): string | null;

export function linkTokens(commit: CommitRecord): LinkTokens;

export function classifyCommits(commits: CommitRecord[], unreleasedText: string | null): Classification;

export function main(repoDir?: string): void;
