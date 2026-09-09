import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Guard for task `6f719bb4` (agent-tasks): every source citation in
// docs/decisions/*.md must resolve to the code it describes, on the
// CURRENT tree, in anchored, repo-relative form. It also checks the
// anchored citations in docs/okf/*.md, including the historical entries in
// log.md. A separate ratchet further below (task `898f9925`) additionally
// ratchets BARE (unanchored) `path:N` line citations into non-Markdown
// sources to zero outside log.md, whose bare count is reported in a
// computed test title only (history, not asserted). Written after a sweep
// found citations pointing at whitespace hints and envelope comments
// instead of the code the sentence actually named, plus an 11-line
// shift from an unrelated constant move, drift a bare `path:N` citation
// cannot self-report.
//
// CITATION GRAMMAR this guard enforces (see the "Citation convention"
// note near the top of docs/decisions/2026-08-27-ug-auto-mode-approval.md):
// a citation is a single backtick-wrapped token of the shape
//   `repo/relative/path.ext:N` or `repo/relative/path.ext:N-M`
// optionally followed by an anchor:
//   `repo/relative/path.ext:N-M#"text on line M"`
// The path is REPO-ROOT-RELATIVE (no basename-only forms), ext is one of
// ts/md/js/sh/mjs, and N/M are 1-based line numbers. A continuation
// (`, N2-M2` tacked onto an existing citation) is not part of the
// grammar: each citation is its own backtick span.
//
// WHAT THIS PATTERN DELIBERATELY DOES NOT MATCH (so a false positive
// cannot make the guard flag prose it was never meant to touch):
//   - bare prose like "line 771" (no backticks, no file extension);
//   - a URL (no bare `path.ext:N` shape inside backticks);
//   - a shell `:`-use inside a code span, e.g. `` `git commit -m "x"` ``
//     (no recognised extension immediately before the colon).
//
// HONEST COVERAGE CLAIM: this is a mechanical extractor over a fixed
// grammar, not a markdown or prose parser. A citation typo'd outside
// this exact shape (extra whitespace inside the backticks, a path with
// an unlisted extension) will silently not be extracted and so not be
// checked; that is a gap in the grammar's reach, not a bug in the
// checks below, which run against everything the extractor DOES find.
// A prose "line N" reference OUTSIDE backticks is not a citation under
// this grammar at all and is invisible to this guard entirely.
//
// What resolution actually pins: the END line (M) is anchored, and its text
// must contain the anchor string, and (per check (f) below) that string
// may occur at most once across the whole [N, M] span, so a citation
// cannot be silently widened to include unrelated lines while keeping
// its old end-line anchor. The START line (N) is NOT independently
// anchored: a widened-at-the-front citation whose anchor text still
// occurs exactly once in the new, larger range still passes. So a
// citation cannot silently drift onto different code that changes what
// the END line says, but a range that grows without disturbing the
// uniqueness of its own anchor can still drift at the start.

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISIONS_DIR = path.join(REPO_ROOT, "docs", "decisions");
const OKF_DIR = path.join(REPO_ROOT, "docs", "okf");

const CITED_EXTENSIONS = ["ts", "md", "js", "sh", "mjs"] as const;

// One backtick-wrapped citation token: path:N[-M][#"anchor"].
const CITATION_RE = new RegExp(
  "`([A-Za-z0-9_./-]+\\.(?:" +
    CITED_EXTENSIONS.join("|") +
    ")):(\\d+)(?:-(\\d+))?(?:#\"([^\"]*)\")?`",
  "g",
);

interface Citation {
  file: string; // ADR file, repo-relative, for error messages
  adrLine: number; // 1-based line number within the ADR
  raw: string; // the full matched token, for error messages
  citedPath: string; // repo-relative path the citation names
  startLine: number;
  endLine: number;
  anchor: string | undefined;
}

function listDocs(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function extractCitations(adrFile: string, text: string): Citation[] {
  const citations: Citation[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, idx) => {
    CITATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITATION_RE.exec(lineText)) !== null) {
      const [raw, citedPath, startStr, endStr, anchor] = m;
      citations.push({
        file: adrFile,
        adrLine: idx + 1,
        raw: raw ?? "",
        citedPath: citedPath ?? "",
        startLine: Number(startStr),
        endLine: endStr !== undefined ? Number(endStr) : Number(startStr),
        anchor,
      });
    }
  });
  return citations;
}

/**
 * Resolves and checks one `path:N[-M]#"anchor"` line citation against
 * `repoRoot`. Returns `null` when it resolves cleanly, else a
 * human-readable problem string. Factored out of the `it.each` body below
 * (task `898f9925`) so the docs/okf-shaped fixtures further down can drive
 * the SAME resolution logic the real bundle is checked against, mirroring
 * how `checkHeadingCitation` already backs both the real-bundle describe
 * block and its own fixtures.
 */
function checkLineCitation(repoRoot: string, c: Citation): string | null {
  const errPrefix = `citation \`${c.raw}\``;

  // (a) path exists relative to the repo root.
  const abs = path.join(repoRoot, c.citedPath);
  const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
  if (!exists) {
    return `${errPrefix}: ${c.citedPath} does not exist relative to the repo root`;
  }

  const fileLines = fs.readFileSync(abs, "utf8").split("\n");
  const lineCount = fileLines.length;

  // (b) 1 <= N <= M <= line count.
  if (c.startLine < 1) {
    return `${errPrefix}: start line ${c.startLine} is not >= 1`;
  }
  if (c.startLine > c.endLine) {
    return `${errPrefix}: start line ${c.startLine} is greater than end line ${c.endLine}`;
  }
  if (c.endLine > lineCount) {
    return `${errPrefix}: end line ${c.endLine} exceeds ${c.citedPath}'s line count (${lineCount})`;
  }

  // (c) line N is not blank.
  const startText = fileLines[c.startLine - 1] ?? "";
  if (startText.trim().length === 0) {
    return `${errPrefix}: start line ${c.startLine} of ${c.citedPath} is blank`;
  }

  // (d) an anchor is present.
  if (c.anchor === undefined || c.anchor.length === 0) {
    return `${errPrefix}: no anchor (expected \`${c.citedPath}:${c.startLine}${
      c.startLine === c.endLine ? "" : `-${c.endLine}`
    }#"..."\`)`;
  }

  // (e) the anchor text occurs on line M (the LAST line of the range).
  const endText = fileLines[c.endLine - 1] ?? "";
  if (!endText.includes(c.anchor)) {
    return `${errPrefix}: anchor "${c.anchor}" does not occur on line ${c.endLine} of ${c.citedPath} (found: ${JSON.stringify(
      endText,
    )})`;
  }

  // (f) the anchor text occurs at most once across the WHOLE cited
  // range [N, M], not just on line M. Without this, a citation can be
  // silently widened at the START (`path:1-M#"anchor"` instead of
  // `path:N-M#"anchor"`) and still pass (e) as long as the anchor is
  // still on line M; that widened range can then include code the
  // citation never described. Requiring the anchor to be unique in the
  // range makes a widened-but-still-matching range fail as soon as the
  // anchor text (which is usually short and generic, e.g. a single
  // token) recurs somewhere in the newly-included lines. This does NOT
  // constrain the start line on its own: a widened range whose anchor
  // happens to still be unique in the wider span passes here too. See
  // the HONEST COVERAGE CLAIM above.
  let anchorOccurrences = 0;
  for (let ln = c.startLine; ln <= c.endLine; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    let searchFrom = 0;
    while (true) {
      const found = lineText.indexOf(c.anchor, searchFrom);
      if (found === -1) break;
      anchorOccurrences++;
      searchFrom = found + 1;
    }
  }
  if (anchorOccurrences !== 1) {
    return `${errPrefix}: anchor "${c.anchor}" occurs ${anchorOccurrences} times within lines ${c.startLine}-${c.endLine} of ${c.citedPath} (expected exactly 1); pick text unique to the line it anchors, or narrow the range`;
  }

  return null;
}

describe("docs/decisions citations resolve on the current tree", () => {
  const docFiles = listDocs(DECISIONS_DIR);
  const allCitations: Citation[] = [];
  for (const f of docFiles) {
    const text = fs.readFileSync(path.join(DECISIONS_DIR, f), "utf8");
    allCitations.push(...extractCitations(f, text));
  }
  // log.md is intentionally included: its historical citations are maintained
  // as repo-relative anchored references when the cited source moves.
  for (const f of listDocs(OKF_DIR)) {
    const text = fs.readFileSync(path.join(OKF_DIR, f), "utf8");
    allCitations.push(
      ...extractCitations(`docs/okf/${f}`, text).filter((citation) => citation.anchor !== undefined),
    );
  }

  it("finds citations to check, including anchored OKF citations from log.md", () => {
    expect(allCitations.length).toBeGreaterThan(0);
    expect(allCitations.some((citation) => citation.file === "docs/okf/log.md")).toBe(true);
  });

  it.each(allCitations.map((c) => [`${c.file}:${c.adrLine} ${c.raw}`, c] as const))(
    "%s",
    (_label, c) => {
      const problem = checkLineCitation(REPO_ROOT, c);
      expect(problem, problem ? `${c.file}:${c.adrLine}: ${problem}` : undefined).toBeNull();
    },
  );
});

// Negative-grammar fixture: pins CITATION_RE against future loosening. Each
// line below looks citation-adjacent (a colon, digits, a path-ish string)
// but must NOT be extracted, because none supplies the exact shape the
// grammar comment above requires: a backtick-wrapped
// `repo/relative/path.ext:N[-M]` with a recognised extension immediately
// before the colon.
describe("CITATION_RE does not extract citation-shaped non-citations", () => {
  const fixtureLines = [
    "A config line `key=value:123` looks like a citation but has no",
    "recognised extension immediately before the colon, so it must not",
    "resolve as one.",
    "",
    "A URL with a port, `http://host:8080/x`, has a colon followed by",
    "digits but no `path.ext` before it, so it must not resolve either.",
    "",
    "A bare timestamp range `12:34-13:00` has digits and a dash but no",
    "path or extension at all.",
    "",
    "```ts",
    "// A citation-shaped string with no backticks of its own, inside a",
    "// fenced code block, must not resolve: the grammar requires its own",
    "// backtick delimiters, which a fence does not supply.",
    'const notACitation = "src/example.ts:1-2";',
    "```",
  ];
  const fixtureText = fixtureLines.join("\n");

  it("finds zero citations in the fixture (guards CITATION_RE against loosening)", () => {
    const found = extractCitations("fixture.md", fixtureText);
    expect(
      found,
      `expected zero citations in the negative-grammar fixture, found: ${JSON.stringify(found)}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Heading-section citation guard (task `ee494719`).
//
// Tasks `419ecfad` (PR #514) and `4f0abbc8` (PR #516) replaced `CHANGELOG.md`
// as a frontmatter `sources:` entry on five bundle docs with okf-kit's
// heading-section citation form, `` `CHANGELOG.md:#0.x.y` `` (see
// docs/okf/index.md's "Do not list CHANGELOG.md under a doc's frontmatter
// sources:" note). CITATION_RE above only extracts `path:N[-M]` citations,
// so none of these 28 heading citations was covered by a BLOCKING check;
// only okf-kit's `citations-resolve` rule, run through the warn-only
// `okf-staleness` CI job, resolves them, so a renamed or removed
// `## [x.y.z]` CHANGELOG section only warns, never blocks. This section
// closes that gap in-repo.
//
// Grammar mirrored from okf-kit (agent-dx/packages/okf-kit's
// src/rules/citations-resolve.ts, `HEADING_SECTION_CITATION_RE` and
// `findHeadingSection`): a backtick-wrapped `path.md:#heading` citation,
// where `heading` is a bare or single-`[...]`-wrapped token. Resolution
// mirrors that rule's semantics: the target's nearest Markdown heading of
// level <= 2 (subsection headings are transparent, same
// `ANCHOR_HEADING_MAX_LEVEL` reasoning: a Keep-a-Changelog CHANGELOG.md
// nests identically-named `### Added`/`### Changed`/`### Fixed`
// subsections inside every `## [x.y.z]` release) whose text CONTAINS the
// anchor text, scanning only actual heading lines (never a whole-file
// substring search, which would also match the anchor text sitting in
// ordinary prose that is not a heading at all).
//
// STRICTER-THAN-OKF-KIT rule, deliberately scoped to this guard only: for
// a target file whose basename is exactly `CHANGELOG.md`, the matched
// heading line must additionally take the file's own canonical
// `## [x.y.z]` bracket form (optionally followed by more text, e.g. a
// trailing " - 2026-09-05" date). okf-kit's own "contains" semantics stay
// deliberately loose across the whole OKF spec (a heading-section
// citation can point at any `.md` target, not just a CHANGELOG), so this
// extra check lives here, not upstream: it is specific to how THIS repo's
// CHANGELOG.md is shaped, not a spec-level requirement every heading-form
// consumer must satisfy.
//
// MIRROR PIN: this section mirrors okf-kit@0.10.0's
// `HEADING_SECTION_CITATION_RE` / `findHeadingSection` /
// `checkHeadingSectionTarget` (agent-dx's `packages/okf-kit`, the exact
// version this repo's `.github/workflows/okf-staleness.yml` pins via
// `npx okf-kit@0.10.0`), not "okf-kit" generically; a future okf-kit bump
// that changes this rule's semantics does not automatically update this
// guard.
//
// SCOPE CUT vs okf-kit (a real, deliberate gap, not an oversight): path
// resolution here is repo-root-relative ONLY. okf-kit instead tries, in
// order, the citing doc's own frontmatter `sources:`, doc-relative, each
// ancestor directory up to the repo root, repo-root-relative, and finally
// a repo-wide suffix search -- so a sibling-relative citation written
// from inside `docs/okf/`, e.g. `` `log.md:#Overview` `` referring to
// `docs/okf/log.md`, resolves upstream (through the doc-relative /
// ancestor steps) but is reported `missing file` here, since this guard
// never tries anything but the literal repo-root-relative path. Every
// heading citation actually written in this bundle already uses a full
// repo-root-relative path (or a bare `CHANGELOG.md`, which needs no
// resolving either way), so this gap has not yet produced a false
// `missing-file` in practice; it would if a future citation used a
// sibling-relative form instead.
//
// SECOND SCOPE CUT vs okf-kit: malformed heading-section forms are
// extracted-and-reported upstream (`HEADING_SECTION_MALFORMED_RE` /
// `collectHeadingSectionMalformedMatches` flags an unterminated
// content-anchor quote, an unquoted third segment, or a non-`.md`
// target), silently ignored here -- `HEADING_CITATION_RE` below simply
// does not match those shapes, so a malformed citation extracts zero
// heading citations rather than one flagged problem (the negative-
// grammar fixture at the bottom of this file pins exactly that: zero
// extractions for citation-shaped-but-not-quite text).
//
// COVERAGE ADDED IN task `ee494719`: the optional content anchor,
// `` `path.md:#heading#"text"` ``, is now also extracted and checked --
// the quoted text must occur on exactly one line inside the resolved
// heading's section body, mirroring okf-kit's
// `heading-section-content-anchor-not-found` /
// `-ambiguous` findings. Before this round, a content-anchored citation
// silently matched nothing (the regex required the closing backtick
// immediately after the heading token) and so was never checked here at
// all -- a doc author reaching for the stronger, content-anchored form
// silently LOST this guard's blocking coverage rather than gaining
// precision.
//
// COVERAGE ADDED THIS ROUND (task `9fec3839`): a resolved heading's
// section is now also checked for emptiness, mirroring okf-kit's
// `heading-section-empty` (`checkHeadingSectionTarget`,
// `isSectionEmpty`): a section whose body (from the line right after the
// heading up to, but not including, the next heading at or above the
// same level, or EOF) is blank -- every line empty or whitespace-only,
// fenced lines included, since only HEADING matching itself excludes
// fenced `#`-led lines, not this body scan -- now fails here, before this
// round it silently resolved (this guard checked only that the heading
// existed and, when given, that a content anchor occurred in the body;
// an emptied section with no content anchor passed either way). See
// `isHeadingSectionEmpty` below.
const HEADING_CITATION_RE =
  /`([A-Za-z0-9_./-]+\.md):#(\[?[\w.-]+\]?)(?:#("[^"\n`]+"))?`/g;
const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;
const HEADING_MAX_LEVEL = 2;
const MD_FENCE_DELIM_RE = /^(?:`{3,}\S*|~{3,}\S*)$/;

interface HeadingCitation {
  file: string; // citing doc, repo-relative, for error messages
  docLine: number; // 1-based line number within the citing doc
  raw: string; // the full matched token, for error messages
  citedPath: string; // repo-relative path the citation names
  headingText: string; // anchor text with a single wrapping [...] stripped
  contentAnchor: string | undefined; // quoted text with quotes stripped, if given
}

function parseHeadingAnchorText(raw: string): string {
  return raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
}

function parseContentAnchorText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // raw is the quoted match INCLUDING its surrounding double quotes.
  return raw.slice(1, -1);
}

function extractHeadingCitations(docFile: string, text: string): HeadingCitation[] {
  const citations: HeadingCitation[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, idx) => {
    HEADING_CITATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEADING_CITATION_RE.exec(lineText)) !== null) {
      const [raw, citedPath, anchorRaw, contentAnchorRaw] = m;
      citations.push({
        file: docFile,
        docLine: idx + 1,
        raw: raw ?? "",
        citedPath: citedPath ?? "",
        headingText: parseHeadingAnchorText(anchorRaw ?? ""),
        contentAnchor: parseContentAnchorText(contentAnchorRaw),
      });
    }
  });
  return citations;
}

// True per line for every line lying inside a fenced code block (``` or
// ~~~, delimiters included), so a `#`-led comment inside a fenced example
// is never mistaken for a real Markdown heading -- mirrors okf-kit's own
// `computeFencedLineIndices`/`scanFenceLines`.
function computeFencedLines(lines: string[]): boolean[] {
  const fenced: boolean[] = [];
  let marker: string | undefined;
  for (const lineText of lines) {
    const trimmed = lineText.trim();
    if (!marker && MD_FENCE_DELIM_RE.test(trimmed)) {
      marker = trimmed.slice(0, 3);
      fenced.push(true);
    } else if (marker && trimmed.startsWith(marker)) {
      fenced.push(true);
      marker = undefined;
    } else {
      fenced.push(marker !== undefined);
    }
  }
  return fenced;
}

interface HeadingLine {
  level: number;
  text: string;
  lineNo: number; // 1-based
}

// Every Markdown heading up to HEADING_MAX_LEVEL, outside fenced code
// blocks, in document order.
function collectHeadings(lines: string[], fencedLines: boolean[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  lines.forEach((lineText, idx) => {
    if (fencedLines[idx]) return;
    const m = lineText.match(HEADING_LINE_RE);
    if (m && m[1]!.length <= HEADING_MAX_LEVEL) {
      headings.push({ level: m[1]!.length, text: m[2]!.trim(), lineNo: idx + 1 });
    }
  });
  return headings;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Section body of a matched heading: from the line right after the
// heading up to (not including) the next heading at or above the same
// level, or EOF -- mirrors okf-kit's `findHeadingSection` bodyEnd scan,
// which matches heading lines of ANY level (not just the level <=
// HEADING_MAX_LEVEL ones `collectHeadings` returns) but breaks only at
// one whose level is <= the cited heading's own level; a deeper
// subheading (e.g. a `### Added` under a `## [2.0.0]`) does NOT end the
// section -- it is body content, so a section whose only body is such a
// subheading is still non-empty.
function findSectionBody(
  lines: string[],
  fencedLines: boolean[],
  heading: HeadingLine,
): { bodyStart: number; bodyEnd: number } {
  const bodyStart = heading.lineNo; // 0-based index of the first body line
  let bodyEnd = lines.length;
  for (let i = heading.lineNo; i < lines.length; i++) {
    if (fencedLines[i]) continue;
    const m = (lines[i] ?? "").match(HEADING_LINE_RE);
    if (m && m[1]!.length <= heading.level) {
      bodyEnd = i;
      break;
    }
  }
  return { bodyStart, bodyEnd };
}

// Count of lines in `[bodyStart, bodyEnd)` containing `text` -- a content
// anchor must occur on exactly one such line, mirroring okf-kit's
// `countAnchorOccurrences` for `heading-section-content-anchor-*`.
function countSectionAnchorOccurrences(
  lines: string[],
  bodyStart: number,
  bodyEnd: number,
  text: string,
): number {
  let count = 0;
  for (let i = bodyStart; i < bodyEnd; i++) {
    if ((lines[i] ?? "").includes(text)) count++;
  }
  return count;
}

// True when every line in `[bodyStart, bodyEnd)` is empty or
// whitespace-only, mirroring okf-kit's `isSectionEmpty` (guards
// `heading-section-empty`): a section whose body is entirely blank up to
// the next heading of the same or higher level (or EOF) resolves the
// heading itself but names nothing, so a citation to it is as useless as
// one to a heading that does not exist. Like okf-kit's own version, this
// does NOT special-case fenced lines inside the body: a fenced code block
// with actual content still counts as non-blank content (trim() !== ""),
// only fenced lines are excluded from HEADING matching itself, never from
// this body scan.
function isHeadingSectionEmpty(
  lines: string[],
  bodyStart: number,
  bodyEnd: number,
): boolean {
  for (let i = bodyStart; i < bodyEnd; i++) {
    if ((lines[i] ?? "").trim() !== "") return false;
  }
  return true;
}

/**
 * Resolves and checks one heading-section citation against `repoRoot`.
 * Returns `null` when it resolves cleanly, else a human-readable problem
 * string naming exactly one of: a `..` path segment (rejected outright,
 * never resolved), missing target file, no matching heading, an
 * ambiguous (>1) match, (CHANGELOG.md targets only) a matching heading
 * that is not the file's own exact `## [x.y.z]` bracket form, a section
 * whose body has no non-blank content before the next heading, or (when a
 * content anchor was given) the anchor text missing from, or ambiguous
 * within, the resolved section's body.
 */
function checkHeadingCitation(repoRoot: string, c: HeadingCitation): string | null {
  if (c.citedPath.split("/").includes("..")) {
    return `${c.citedPath} contains a ".." path segment and is rejected without resolution`;
  }
  const abs = path.join(repoRoot, c.citedPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return `${c.citedPath} does not exist relative to the repo root`;
  }
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const fencedLines = computeFencedLines(lines);
  const headings = collectHeadings(lines, fencedLines);
  const matches = headings.filter((h) => h.text.includes(c.headingText));
  if (matches.length === 0) {
    return `no heading (level <= ${HEADING_MAX_LEVEL}) in ${c.citedPath} contains "${c.headingText}"`;
  }
  if (matches.length > 1) {
    return `heading "${c.headingText}" is ambiguous in ${c.citedPath} (${matches.length} matching headings, at lines ${matches
      .map((h) => h.lineNo)
      .join(", ")})`;
  }
  const heading = matches[0]!;
  if (path.basename(c.citedPath) === "CHANGELOG.md") {
    const exactFormRe = new RegExp(`^## \\[${escapeRegExp(c.headingText)}\\]`);
    const headingLineText = (lines[heading.lineNo - 1] ?? "").trim();
    if (!exactFormRe.test(headingLineText)) {
      return `CHANGELOG.md heading at line ${heading.lineNo} ("${headingLineText}") is not the exact "## [${c.headingText}]" form this guard requires for CHANGELOG.md sections`;
    }
  }
  const { bodyStart, bodyEnd } = findSectionBody(lines, fencedLines, heading);
  if (isHeadingSectionEmpty(lines, bodyStart, bodyEnd)) {
    return `section under heading "${heading.text}" (line ${heading.lineNo}) of ${c.citedPath} has no non-blank content before the next heading`;
  }
  if (c.contentAnchor !== undefined) {
    const count = countSectionAnchorOccurrences(lines, bodyStart, bodyEnd, c.contentAnchor);
    if (count === 0) {
      return `content anchor "${c.contentAnchor}" does not occur in the section under heading "${heading.text}" (line ${heading.lineNo}) of ${c.citedPath}`;
    }
    if (count > 1) {
      return `content anchor "${c.contentAnchor}" occurs on ${count} lines in the section under heading "${heading.text}" (line ${heading.lineNo}) of ${c.citedPath}; expected exactly one`;
    }
  }
  return null;
}

describe("docs/okf heading-section (`path.md:#heading`) citations resolve", () => {
  const headingCitations: HeadingCitation[] = [];
  for (const f of listDocs(OKF_DIR)) {
    const text = fs.readFileSync(path.join(OKF_DIR, f), "utf8");
    headingCitations.push(...extractHeadingCitations(`docs/okf/${f}`, text));
  }

  it("finds heading-section citations to check", () => {
    expect(headingCitations.length).toBeGreaterThan(0);
  });

  it.each(headingCitations.map((c) => [`${c.file}:${c.docLine} ${c.raw}`, c] as const))(
    "%s",
    (_label, c) => {
      const problem = checkHeadingCitation(REPO_ROOT, c);
      expect(problem, problem ?? undefined).toBeNull();
    },
  );
});

describe("heading-section citation guard: fixtures pinning discriminating checks", () => {
  // Isolated fixture tree (own repoRoot), so these checks never depend on
  // the real CHANGELOG.md's exact content -- only on this guard's own
  // matching logic.
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "heading-citation-guard-fixtures-"),
  );
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const fixtureChangelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "Nothing yet.",
    "",
    "## [1.2.4] - 2026-01-02",
    "",
    "Mentions version 9.9.9 in prose here, but 9.9.9 is not a heading",
    "in this fixture: it only ever appears inside this paragraph.",
    "",
    "## [1.2.3] - 2026-01-01",
    "",
    "Real content for the 1.2.3 release. The word canary appears exactly",
    "once in this section, for the content-anchor fixtures below.",
    "",
    "## Version 1.2.5 notes",
    "",
    "A heading that names 1.2.5 but not in the file's own exact",
    "`## [x.y.z]` bracket form.",
    "",
    "```",
    "## [1.2.6] - fenced, not a real heading",
    "```",
    "",
    "Mentioning 1.2.6 in prose here does not make the fenced line above",
    "a real heading either.",
    "",
    "### [1.2.7] - 2026-01-03",
    "",
    "A level-3 heading naming 1.2.7; above HEADING_MAX_LEVEL, so this",
    "must not resolve as a match.",
    "",
    "## Release 1.2.8 (part one)",
    "",
    "First of two level-2 headings mentioning 1.2.8.",
    "",
    "## Also about 1.2.8 (part two)",
    "",
    "Second of two level-2 headings mentioning 1.2.8: ambiguous.",
    "",
    "../escape.md fixture path segment lives only in the test string below,",
    "not in this file.",
    "",
    "## [1.2.9] - 2026-01-06",
    "",
    "   ",
    "",
    "## [1.2.10] - 2026-01-07",
    "",
    "Real content for the 1.2.10 release, so this section is the non-empty",
    "control paired with the 1.2.9 empty-section fixture above.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(tmpDir, "CHANGELOG.md"), fixtureChangelog, "utf8");

  it("resolves a citation to a real, exact-form `## [x.y.z]` CHANGELOG section", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.3`.",
    )[0]!;
    expect(checkHeadingCitation(tmpDir, c)).toBeNull();
  });

  it("fails a citation to a version with no heading at all (mutation probe (a)/(b) target: heading extraction/matching must be restricted to real heading lines, not a whole-file substring search)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#9.9.9`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("no heading");
  });

  it("fails a citation to a CHANGELOG.md heading that names the version but is not the exact `## [x.y.z]` bracket form", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.5`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("is not the exact");
  });

  it("fails a citation to a version whose only heading sits inside a fenced code block (mutation probe (c) target: the fence guard must exclude a fenced `#`-led line from heading matching)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.6`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("no heading");
  });

  it("fails a citation to a version present only as a level-3 heading (mutation probe (d) target: HEADING_MAX_LEVEL must stay 2, not widen to include level-3+ headings)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.7`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("no heading");
  });

  it("fails a citation to a version named by two level-2 headings (mutation probe (e) target: the ambiguity check must fire, never silently pick the first match)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.8`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("is ambiguous");
  });

  it("resolves a content-anchored citation whose quoted text occurs exactly once in the resolved section", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      'See `CHANGELOG.md:#1.2.3#"canary"`.',
    )[0]!;
    expect(checkHeadingCitation(tmpDir, c)).toBeNull();
  });

  it("fails a content-anchored citation whose quoted text does not occur in the resolved section (mutation probe (f) target: the content-anchor check must run when a content anchor is given)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      'See `CHANGELOG.md:#1.2.3#"does-not-occur-anywhere"`.',
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("does not occur");
  });

  it("rejects a citedPath containing a \"..\" path segment outright, without resolving it (mutation probe (g) target)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `../escape.md:#1.2.3`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain('".."');
  });

  it("fails a citation to a heading whose section body has no non-blank content before the next heading (mutation probe (h) target: the empty-section check must run and reject a blank body; mutation probe (i) target: the body-end boundary must stop at the NEXT heading, not read past it into a later section's content)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.9`.",
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("no non-blank content");
  });

  it("resolves a citation to a heading whose section body has real, non-blank content (control paired with the 1.2.9 empty-section fixture; mutation probe (j) target: the empty-section check must not fire on a real, non-blank section -- the false-positive direction)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      "See `CHANGELOG.md:#1.2.10`.",
    )[0]!;
    expect(checkHeadingCitation(tmpDir, c)).toBeNull();
  });

  it("fails a content-anchored citation to a heading whose section body has no non-blank content, with the empty-section problem (not the content-anchor problem), mirroring okf-kit's own check order (mutation probe (k) target: the empty-section check must run before the content-anchor check even when a content anchor is given, not be gated behind `c.contentAnchor === undefined`)", () => {
    const c = extractHeadingCitations(
      "fixture.md",
      'See `CHANGELOG.md:#1.2.9#"anything"`.',
    )[0]!;
    const problem = checkHeadingCitation(tmpDir, c);
    expect(problem).not.toBeNull();
    expect(problem).toContain("no non-blank content");
  });
});

// Negative-grammar fixture: pins HEADING_CITATION_RE against future
// loosening, mirroring the CITATION_RE negative-grammar fixture above.
// Each line below looks heading-citation-adjacent (a `.md` path, a `#`,
// a heading-ish token) but must NOT be extracted, because none supplies
// the exact shape HEADING_CITATION_RE requires: a backtick-wrapped
// `path.md:#heading` token.
describe("HEADING_CITATION_RE does not extract heading-citation-shaped non-citations", () => {
  const fixtureLines = [
    "A Markdown link fragment, [x](docs/okf/log.md#Overview), has a `.md`",
    "path and a `#`-led fragment but is not backtick-wrapped and has no",
    "`:` before the `#`, so it must not resolve as a heading citation.",
    "",
    "A non-.md path with the same shape, `src/example.ts:#Overview`, has",
    "no `.md` extension immediately before the `:#`, so it must not",
    "resolve either.",
    "",
    "An unbackticked CHANGELOG.md:#0.1.0 in prose has no backtick",
    "delimiters of its own, so it must not resolve.",
  ];
  const fixtureText = fixtureLines.join("\n");

  it("finds zero heading citations in the fixture (guards HEADING_CITATION_RE against loosening)", () => {
    const found = extractHeadingCitations("fixture.md", fixtureText);
    expect(
      found,
      `expected zero heading citations in the negative-grammar fixture, found: ${JSON.stringify(found)}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// docs/okf line-citation-into-source guard (task `898f9925`).
//
// Batch-44 miss this closes: `docs/okf/quote-model-divergence.md` cited
// `src/cli/init/templates.ts:928` (a BARE line citation, no anchor) while
// the described sentence had shifted to line 940 after an earlier edit;
// nothing checked it (okf-kit's `sources-fresh` compares commit
// timestamps only), the doc was re-stamped as "verified" anyway, and only
// a reviewer's manual sweep caught the drift (pandora run
// 2026-09-08-open-pool-batch44, D-012 / the T-006 round-1 high). The
// `docs/decisions citations resolve` describe block above already checks
// EVERY anchored docs/okf citation (line 120's `anchor !== undefined`
// filter); what it does NOT check is a BARE `path:N[-M]` citation with no
// anchor at all, because check (d) above treats "no anchor" as the
// failure and returns before checks (e)/(f) ever run against the line
// text -- so a bare citation into a source file can drift onto any other
// line and nothing here would catch it. This section pins that the
// resolver, once a citation IS anchored, actually catches a shifted line
// (the fixtures below), and separately ratchets the bare form itself to
// zero outside log.md (the describe block further down).
describe("docs/okf line-citation guard: fixture pinning discrimination against a shifted line", () => {
  // Isolated fixture tree (own repoRoot, docs/okf-shaped): a doc under
  // docs/okf/ citing a fixture source file with an anchor, mirroring the
  // real bundle's shape rather than calling checkLineCitation with a
  // hand-built Citation object -- this exercises extractCitations AND
  // checkLineCitation together, the same pipeline the real describe block
  // above runs, per the docs/okf-shaped fixture the tracker asks for.
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "okf-line-citation-guard-fixtures-"),
  );
  fs.mkdirSync(path.join(tmpDir, "docs", "okf"), { recursive: true });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The distinctive anchor token "widgetDistinctiveToken" occurs on line 5
  // ONLY -- lines 1-3 are filler, line 4 is the function signature, line 6
  // is the closing brace. A citation claiming line 3 (shifted, mutation
  // probe P1's target) must fail; a citation claiming line 5 (corrected)
  // must pass.
  const fixtureSourceLines = [
    "// filler line 1",
    "// filler line 2",
    "// filler line 3 (a shifted citation wrongly claims this line)",
    "export function widgetFactory() {",
    '  return "widgetDistinctiveToken";',
    "}",
  ];
  fs.writeFileSync(
    path.join(tmpDir, "fixture-source.ts"),
    fixtureSourceLines.join("\n"),
    "utf8",
  );

  function firstOkfCitation(docText: string): Citation {
    fs.writeFileSync(path.join(tmpDir, "docs", "okf", "x.md"), docText, "utf8");
    const citations = extractCitations("docs/okf/x.md", docText);
    if (citations.length !== 1) {
      throw new Error(`fixture setup error: expected exactly 1 citation, found ${citations.length}`);
    }
    return citations[0]!;
  }

  it("fails a docs/okf citation whose line has shifted off the anchor text (mutation probe P1 target: the line-resolution/anchor check above must actually run, not be disabled)", () => {
    // Also pins the property mutation probe P3 relies on (a whole-file
    // substring mutant of check (e)): the fixture's anchor text
    // "widgetDistinctiveToken" is ABSENT from every line of
    // fixtureSourceLines except line 5, so a whole-file-substring mutant of
    // check (e) is the only way this shifted citation (claiming line 3)
    // could wrongly pass, and there is exactly one place in the file where
    // the mutant's widened search would find it. `agent-primitives probe`
    // simulates that mutant directly against the real check (e)
    // implementation; this test alone already kills it, since a
    // whole-file `.includes()` on "widgetDistinctiveToken" would find the
    // real occurrence on line 5 and wrongly report the shifted citation as
    // resolved.
    const c = firstOkfCitation(
      'See `fixture-source.ts:3#"widgetDistinctiveToken"` for the factory.',
    );
    const problem = checkLineCitation(tmpDir, c);
    expect(problem, "expected the shifted-line citation to fail").not.toBeNull();
    expect(problem).toContain("does not occur on line 3");
  });

  it("resolves the corrected docs/okf citation once the line number matches the anchor's real location", () => {
    const c = firstOkfCitation(
      'See `fixture-source.ts:5#"widgetDistinctiveToken"` for the factory.',
    );
    expect(checkLineCitation(tmpDir, c)).toBeNull();
  });
});

// Shared predicate: a citation is "bare into a non-Markdown source" when it
// carries no anchor AND its cited path is not itself a `.md` file (a bare
// `path.md:N` heading-shaped reference is out of THIS guard's scope; only
// heading-section (`path.md:#heading`) citations reach it, checked further
// above). Factored out (rather than inlined per call site) so the mutation
// probe P2 fixture below shares the EXACT SAME predicate the real ratchet
// loop uses: a mutant that neutralises this function (e.g. always returning
// `false`) is caught by the fixture alone, without depending on the live
// bundle carrying a planted bare citation.
function isBareNonMdCitation(c: Citation): boolean {
  return c.anchor === undefined && !c.citedPath.endsWith(".md");
}

interface BareNonMdCollection {
  outsideLog: Citation[];
  logMdCount: number;
}

/**
 * Collects bare (unanchored) non-Markdown-target line citations across every
 * `.md` doc in `dir`, exempting `log.md` (historical prose, reported as a
 * count only -- see the describe block below). Factored out of the ratchet's
 * own loop (task `898f9925` round 2) so the loop itself is pinned by a
 * fixture over a scratch, docs/okf-shaped directory, not just by the live
 * bundle's citations: a mutant that widens the log.md exemption to every doc
 * (or drops the exemption, or drops the collection entirely) is caught by
 * `collectBareNonMd`'s OWN fixture below, independent of whether the real
 * bundle happens to carry any live bare citations at the time.
 */
function collectBareNonMd(dir: string, labelPrefix: string): BareNonMdCollection {
  const outsideLog: Citation[] = [];
  let logMdCount = 0;
  for (const f of listDocs(dir)) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const bare = extractCitations(`${labelPrefix}/${f}`, text).filter(isBareNonMdCitation);
    if (f === "log.md") {
      logMdCount = bare.length;
    } else {
      outsideLog.push(...bare);
    }
  }
  return { outsideLog, logMdCount };
}

describe("docs/okf bare (unanchored) line citations into non-Markdown sources: ratchet", () => {
  const { outsideLog: bareNonMdOutsideLog, logMdCount: logMdBareNonMdCount } = collectBareNonMd(
    OKF_DIR,
    "docs/okf",
  );

  it(`log.md carries ${logMdBareNonMdCount} bare (unanchored) line citation(s) into non-Markdown sources (historical prose, exempt, not asserted here)`, () => {
    // Intentionally not asserted against the count: this test name IS the
    // visible residual (task 898f9925 / D-006). A change to log.md's own
    // historical citations does not fail this suite.
    expect(true).toBe(true);
  });

  it("finds zero bare (unanchored) line citations into non-Markdown sources in docs/okf outside log.md", () => {
    expect(
      bareNonMdOutsideLog,
      bareNonMdOutsideLog
        .map(
          (c) =>
            `${c.file}:${c.adrLine}: bare citation \`${c.raw}\` into ${c.citedPath} carries no anchor`,
        )
        .join("\n"),
    ).toHaveLength(0);
  });

  // Mutation probe P2 target: a mutant that neutralises the ratchet's own
  // bare-citation filter (e.g. always returning `[]`) would make the
  // assertion above pass vacuously. This fixture plants a bare non-md
  // citation in a scratch, docs/okf-shaped string (never written into the
  // real bundle) and asserts the SAME filter this describe block uses
  // still finds it, so a neutralised filter fails here even when the real
  // bundle carries zero live bare citations.
  it("fixture: the bare-citation filter still catches a planted bare non-md citation in a scratch doc (mutation probe P2 target)", () => {
    const plantedDocText = 'Planted drift: see `src/planted-example.ts:12` for detail.\n';
    const planted = extractCitations("fixture-scratch.md", plantedDocText).filter(isBareNonMdCitation);
    expect(
      planted,
      "expected the planted bare non-md citation to be found by the ratchet's own filter",
    ).toHaveLength(1);
  });

  // Mutation probe P4 target: a mutant that widens `collectBareNonMd`'s
  // log.md exemption to every doc (e.g. `if (true)` in place of
  // `if (f === "log.md")`) would make `bareNonMdOutsideLog` above swallow a
  // real bare citation that a doc author needs to see flagged. This fixture
  // runs `collectBareNonMd` itself (not the filter alone, unlike the P2
  // fixture above) over a scratch, docs/okf-shaped temp directory: one doc
  // carrying a planted bare `src/x.ts:12` citation, plus a log.md carrying
  // its own planted bare citation, and asserts the non-log citation is
  // collected (doc, line, and citation text preserved) while the log.md one
  // is not -- so a widened exemption fails here even when the real bundle
  // carries zero live bare citations outside log.md.
  it("fixture: collectBareNonMd collects a planted non-log bare citation and exempts log.md's own (mutation probe P4 target)", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "collect-bare-non-md-fixtures-"),
    );
    try {
      const okfDir = path.join(tmpDir, "docs", "okf");
      fs.mkdirSync(okfDir, { recursive: true });
      fs.writeFileSync(
        path.join(okfDir, "planted.md"),
        "Planted drift: see `src/x.ts:12` for detail.\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(okfDir, "log.md"),
        "Historical re-point: see `src/y.ts:34` for detail.\n",
        "utf8",
      );

      const { outsideLog, logMdCount } = collectBareNonMd(okfDir, "docs/okf");

      expect(outsideLog, JSON.stringify(outsideLog)).toHaveLength(1);
      expect(outsideLog[0]?.file).toBe("docs/okf/planted.md");
      expect(outsideLog[0]?.adrLine).toBe(1);
      expect(outsideLog[0]?.citedPath).toBe("src/x.ts");
      expect(
        outsideLog.some((c) => c.citedPath === "src/y.ts"),
        "log.md's planted citation must not be collected into outsideLog",
      ).toBe(false);
      expect(logMdCount, "log.md's own planted bare citation must still be counted").toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Anchor-quality guard (task `898f9925` round 2, reviewer finding: eight of
// the 48 live re-anchorings in round 1 were punctuation-only anchors, e.g.
// `#"}"`, `#");"`, `#"};"`, on a bare-delimiter end line -- such an anchor
// passes checks (d)-(f) above (it is present, occurs on the end line, and is
// unique in the range, since a lone closing brace usually IS unique within a
// short range) but pins NOTHING against the class of drift this whole guard
// exists to catch: the range can grow or shrink by any number of lines and
// still end on some closing delimiter, silently re-validating a citation
// that no longer points at the content the doc's sentence describes. This
// describe block closes that gap with a mechanical check the resolver above
// does not perform: every anchored docs/okf citation's anchor must contain
// at least one word character.
describe("docs/okf citation anchors are not punctuation-only (contain a word character)", () => {
  const anchoredOkfCitations: Citation[] = [];
  for (const f of listDocs(OKF_DIR)) {
    const text = fs.readFileSync(path.join(OKF_DIR, f), "utf8");
    anchoredOkfCitations.push(
      ...extractCitations(`docs/okf/${f}`, text).filter((c) => c.anchor !== undefined),
    );
  }

  it("finds anchored docs/okf citations to check", () => {
    expect(anchoredOkfCitations.length).toBeGreaterThan(0);
  });

  it("every anchored docs/okf citation's anchor contains at least one word character (mutation probe P5 target: a punctuation-only anchor, e.g. a bare closing delimiter, pins nothing against a line shift)", () => {
    const punctuationOnly = anchoredOkfCitations.filter((c) => !/\w/.test(c.anchor ?? ""));
    expect(
      punctuationOnly,
      punctuationOnly
        .map(
          (c) =>
            `${c.file}:${c.adrLine}: citation \`${c.raw}\` has a punctuation-only anchor "${c.anchor}"`,
        )
        .join("\n"),
    ).toHaveLength(0);
  });

  it("fixture: a punctuation-only anchor fails the word-character check, a word anchor passes", () => {
    const punctuationCitation = extractCitations(
      "fixture.md",
      'See `src/example.ts:1-2#"}"` for the closing brace.',
    )[0]!;
    const wordCitation = extractCitations(
      "fixture.md",
      'See `src/example.ts:1-2#"token"` for the named token.',
    )[0]!;
    expect(/\w/.test(punctuationCitation.anchor ?? "")).toBe(false);
    expect(/\w/.test(wordCitation.anchor ?? "")).toBe(true);
  });
});
