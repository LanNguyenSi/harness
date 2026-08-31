import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for task `6f719bb4` (agent-tasks): every source citation in
// docs/decisions/*.md must resolve to the code it describes, on the
// CURRENT tree, in anchored, repo-relative form. Written after a sweep
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

function listDecisionDocs(): string[] {
  return fs
    .readdirSync(DECISIONS_DIR)
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

describe("docs/decisions citations resolve on the current tree", () => {
  const docFiles = listDecisionDocs();
  const allCitations: Citation[] = [];
  for (const f of docFiles) {
    const text = fs.readFileSync(path.join(DECISIONS_DIR, f), "utf8");
    allCitations.push(...extractCitations(f, text));
  }

  it("finds at least one citation to check (guards against a vacuous pass)", () => {
    expect(allCitations.length).toBeGreaterThan(0);
  });

  it.each(allCitations.map((c) => [`${c.file}:${c.adrLine} ${c.raw}`, c] as const))(
    "%s",
    (_label, c) => {
      const errPrefix = `${c.file}:${c.adrLine}: citation \`${c.raw}\``;

      // (a) path exists relative to the repo root.
      const abs = path.join(REPO_ROOT, c.citedPath);
      const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      expect(exists, `${errPrefix}: ${c.citedPath} does not exist relative to the repo root`).toBe(
        true,
      );
      if (!exists) return;

      const fileLines = fs.readFileSync(abs, "utf8").split("\n");
      const lineCount = fileLines.length;

      // (b) 1 <= N <= M <= line count.
      expect(
        c.startLine >= 1,
        `${errPrefix}: start line ${c.startLine} is not >= 1`,
      ).toBe(true);
      expect(
        c.startLine <= c.endLine,
        `${errPrefix}: start line ${c.startLine} is greater than end line ${c.endLine}`,
      ).toBe(true);
      expect(
        c.endLine <= lineCount,
        `${errPrefix}: end line ${c.endLine} exceeds ${c.citedPath}'s line count (${lineCount})`,
      ).toBe(true);
      if (c.startLine < 1 || c.startLine > c.endLine || c.endLine > lineCount) return;

      // (c) line N is not blank.
      const startText = fileLines[c.startLine - 1] ?? "";
      expect(
        startText.trim().length > 0,
        `${errPrefix}: start line ${c.startLine} of ${c.citedPath} is blank`,
      ).toBe(true);

      // (d) an anchor is present.
      expect(
        c.anchor !== undefined && c.anchor.length > 0,
        `${errPrefix}: no anchor (expected \`${c.citedPath}:${c.startLine}${
          c.startLine === c.endLine ? "" : `-${c.endLine}`
        }#"..."\`)`,
      ).toBe(true);
      if (c.anchor === undefined || c.anchor.length === 0) return;

      // (e) the anchor text occurs on line M (the LAST line of the range).
      const endText = fileLines[c.endLine - 1] ?? "";
      expect(
        endText.includes(c.anchor),
        `${errPrefix}: anchor "${c.anchor}" does not occur on line ${c.endLine} of ${c.citedPath} (found: ${JSON.stringify(
          endText,
        )})`,
      ).toBe(true);
      if (!endText.includes(c.anchor)) return;

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
      expect(
        anchorOccurrences,
        `${errPrefix}: anchor "${c.anchor}" occurs ${anchorOccurrences} times within lines ${c.startLine}-${c.endLine} of ${c.citedPath} (expected exactly 1); pick text unique to the line it anchors, or narrow the range`,
      ).toBe(1);
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
