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
    },
  );
});
