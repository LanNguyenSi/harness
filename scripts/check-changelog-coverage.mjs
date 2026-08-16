#!/usr/bin/env node
// CI gate: every release-notable commit since the last tag must be
// represented in CHANGELOG.md's `## [Unreleased]` section (task 3ed3d333).
//
// Why: the release pipeline converts [Unreleased] into the tagged version's
// section, and release.yml extracts THAT section as the GitHub release
// notes. Historically (pre-0.42.0, e.g. checkout 5b7a36f) the Unreleased
// section lagged many shipped commits, so the gap was only discoverable at
// release time by a human diffing `git log`. This script makes the same
// comparison fail fast in CI, before Build, in the check-no-only /
// check-duplication idiom.
//
// HOW A COMMIT COUNTS AS COVERED — mechanical linkage, precision-first
// (a false positive gets a gate bypassed instead of repaired, same
// rationale as check-no-only): a commit is covered when the Unreleased
// text contains at least one of the commit's link tokens:
//   1. an 8-hex task id appearing anywhere in the commit message
//      (subject or body), e.g. `fb67b402` — the repo's dominant changelog
//      citation style is "(task `<id8>`)";
//   2. the commit's PR number from the squash-merge subject suffix
//      `(#NNN)`, matched as the literal `#NNN`;
//   3. a GHSA advisory id (`GHSA-xxxx-xxxx-xxxx`) from the commit message
//      — links dependency-advisory commits to their advisory-citing entry;
//   4. the commit's own SHA (first 7+ chars) — rare, but a changelog
//      entry citing the commit directly is unambiguous.
//
// SKIP CONVENTION — explicit and closed (no other escape hatch exists):
// a commit whose conventional-commit TYPE is one of
//   test, docs, ci, style, refactor, chore
// needs no changelog entry. These classes carry no release-notable
// behavior by this repo's own conventions; release-notable dependency
// work ships as `fix(deps)` here (see 0.41.0's postcss/fast-uri entries),
// NOT `chore(deps)`. The convention is enforceable but not clairvoyant:
// a release-notable change mislabeled with a skipped type is invisible to
// this gate — the fix is to use the right type, not to widen the skip
// list. Merge commits are excluded via --no-merges (squash-merge PRs are
// regular commits). There is deliberately NO per-commit override marker
// (no `[skip-changelog]` trailer): a bypass that costs one commit-message
// token becomes ritual; retyping the commit or writing the entry is the
// intended cost.
//
// A non-skipped commit with NO recognizable link token at all fails the
// gate with a message saying exactly that — cite the task id or PR number
// in the entry, or use a skipped type if the commit is genuinely not
// release-notable. Note the deliberate consequence: an entry that
// DESCRIBES the change but cites neither a task id nor the PR number
// still fails (seen once in the historical 5b7a36f probe: the
// `init-mcp-wiring-claude-code` entry existed, uncited). Prose matching
// would be guesswork; citing the id is the convention this gate enforces.
//
// Runtime: one `git describe`, one `git log`, one file read — well under
// the 2s budget (measured ~50ms; see task 3ed3d333's report).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Conventional-commit types that need no changelog entry. Closed list —
 * see the module header before adding to it. */
export const SKIPPED_TYPES = new Set(["test", "docs", "ci", "style", "refactor", "chore"]);

const FIELD_SEP = "\u001f"; // US — unit separator
const RECORD_SEP = "\u001e"; // RS — record separator

/**
 * Extracts the `## [Unreleased]` section body (everything until the next
 * `## [` heading). Returns null when the heading itself is missing — the
 * caller distinguishes "no section" from "empty section".
 */
export function extractUnreleased(changelogText) {
  const lines = changelogText.split("\n");
  let inSection = false;
  const out = [];
  let sawHeading = false;
  for (const line of lines) {
    if (/^## \[Unreleased\]/i.test(line)) {
      inSection = true;
      sawHeading = true;
      continue;
    }
    if (inSection && /^## \[/.test(line)) break;
    if (inSection) out.push(line);
  }
  return sawHeading ? out.join("\n") : null;
}

/**
 * Parses `git log --format=%H<US>%s<US>%B<RS>` output into
 * `{ sha, subject, message }` records.
 */
export function parseCommits(rawLog) {
  return rawLog
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((record) => {
      const [sha, subject, message] = record.split(FIELD_SEP);
      return { sha: sha?.trim() ?? "", subject: subject ?? "", message: message ?? "" };
    })
    .filter((c) => c.sha.length > 0);
}

/** Conventional-commit type of a subject line, or null when the subject
 * has no `type(scope)!?:` / `type:` prefix (e.g. "doctor: fix ..." parses
 * as type "doctor" — unknown types are simply never in SKIPPED_TYPES). */
export function commitType(subject) {
  const m = /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(subject);
  return m ? m[1].toLowerCase() : null;
}

/** All link tokens of a commit — see the module header for the four
 * classes. 8-hex extraction requires non-hex boundaries so a 40-hex SHA
 * embedded in a message does not shed spurious 8-hex windows. */
export function linkTokens(commit) {
  const taskIds = new Set(
    (commit.message.match(/(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/g) ?? []).filter(
      // A task id of only digits does not exist in practice, but a pure
      // number (e.g. a timestamp fragment) would: require a hex letter.
      (t) => /[a-f]/.test(t),
    ),
  );
  const prNumbers = new Set(commit.subject.match(/#\d+/g) ?? []);
  const ghsaIds = new Set(commit.message.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/g) ?? []);
  return { taskIds: [...taskIds], prNumbers: [...prNumbers], ghsaIds: [...ghsaIds], shortSha: commit.sha.slice(0, 7) };
}

/**
 * Splits commits into { skipped, covered, uncovered } against the
 * Unreleased section text. `uncovered` entries carry their tokens so the
 * failure output can show what was looked for.
 */
export function classifyCommits(commits, unreleasedText) {
  const text = unreleasedText ?? "";
  const skipped = [];
  const covered = [];
  const uncovered = [];
  for (const commit of commits) {
    const type = commitType(commit.subject);
    if (type !== null && SKIPPED_TYPES.has(type)) {
      skipped.push(commit);
      continue;
    }
    const tokens = linkTokens(commit);
    const hit =
      tokens.taskIds.some((t) => text.includes(t)) ||
      tokens.prNumbers.some((t) => text.includes(t)) ||
      tokens.ghsaIds.some((t) => text.includes(t)) ||
      (tokens.shortSha.length >= 7 && text.includes(tokens.shortSha));
    if (hit) covered.push(commit);
    else uncovered.push({ ...commit, tokens });
  }
  return { skipped, covered, uncovered };
}

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function main(repoDir = process.cwd()) {
  let lastTag;
  try {
    lastTag = git(repoDir, ["describe", "--tags", "--abbrev=0", "HEAD"]).trim();
  } catch {
    // Fail loud, never silently green: a repo without a reachable tag has
    // no release baseline to compare against.
    console.error("check-changelog-coverage: FAIL — no tag reachable from HEAD (git describe --tags failed); cannot determine the release baseline.");
    process.exitCode = 1;
    return;
  }

  const rawLog = git(repoDir, ["log", "--no-merges", `--format=%H%x1f%s%x1f%B%x1e`, `${lastTag}..HEAD`]);
  const commits = parseCommits(rawLog);

  const changelog = readFileSync(join(repoDir, "CHANGELOG.md"), "utf8");
  const unreleased = extractUnreleased(changelog);
  if (unreleased === null && commits.length > 0) {
    console.error(`check-changelog-coverage: FAIL — CHANGELOG.md has no '## [Unreleased]' section but ${commits.length} commit(s) exist since ${lastTag}.`);
    process.exitCode = 1;
    return;
  }

  const { skipped, covered, uncovered } = classifyCommits(commits, unreleased);

  if (uncovered.length > 0) {
    console.error(`check-changelog-coverage: FAIL — ${uncovered.length} commit(s) since ${lastTag} without an [Unreleased] entry:`);
    for (const c of uncovered) {
      const sought = [...c.tokens.taskIds, ...c.tokens.prNumbers, ...c.tokens.ghsaIds];
      const detail = sought.length > 0 ? `looked for ${sought.join(", ")}` : "no task id / PR number / GHSA id in the commit message at all";
      console.error(`  ${c.sha.slice(0, 7)} ${c.subject}\n          (${detail})`);
    }
    console.error(
      "check-changelog-coverage: add an [Unreleased] entry citing the commit's task id (`<id8>`) or PR number (#NNN), " +
        "or — only if the commit is genuinely not release-notable — give it one of the skipped conventional types: " +
        [...SKIPPED_TYPES].join(", ") + ".",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-changelog-coverage: OK — ${commits.length} commit(s) since ${lastTag} (${covered.length} covered, ${skipped.length} skipped by type).`,
  );
}

// Only auto-run when invoked directly (not when imported by tests) — same
// guard as scripts/check-no-only.mjs. Optional argv[2] = repo dir, so the
// gate can be pointed at another checkout (used for the historical probe).
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main(process.argv[2] ?? process.cwd());
}
