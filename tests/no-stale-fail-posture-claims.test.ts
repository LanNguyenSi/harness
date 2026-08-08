import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for task `f1aea826` (tier-aware degraded fail posture). Three
// review rounds each found a FRESH surface still describing the
// pre-0.45 contract ("every degraded evaluation is non-blocking
// warn-mode"): round 1 two OKF bundles, round 2 the fail-posture matrix
// paragraph and the validate message, round 3 six more surfaces — two
// of which were invalidated by round 2's own fix, because docs quoted
// message literals verbatim. This guard closes the CLASS mechanically:
// the stale-contract phrasings must not occur under `src/` or `docs/`
// outside the explicit allowlist below.
//
// Needles are chosen to be phrasings only the OLD contract used:
//   - "warn-mode": the pre-0.45 vocabulary for the universal fallback
//     (the live contract says `warn-degraded` / `deny-degraded`).
//   - "no policy ever blocks": the old absolute claim, inverted for
//     block/require_approval since f1aea826.
// Kept deliberately narrow so tier-aware sentences like "`warn-degraded`
// never blocks for `warn`" stay expressible.
const STALE_PHRASES = ["warn-mode", "no policy ever blocks"];

// Files that may keep the old phrasing:
//   - docs/ROADMAP.md: historical planning text; the superseded Phase 4
//     acceptance bullets carry explicit SUPERSEDED-by-f1aea826 notes.
//   - docs/ARCHITECTURE.md: self-declared historical document.
//   - docs/writing-custom-policies.md + src/cli/init/composer.ts: each
//     contains exactly one PAST-TENSE reference to the pre-0.35/0.45
//     era ("silently degraded to the then-universal warn-mode" /
//     "before 0.45 it was the universal warn-mode ... footgun") inside
//     an otherwise tier-aware sentence.
//   - CHANGELOG.md is not scanned at all (append-only history quotes
//     old wordings by design), and neither are tests (this file itself
//     carries the needles).
const ALLOWLIST = new Set([
  path.join("docs", "ROADMAP.md"),
  path.join("docs", "ARCHITECTURE.md"),
  path.join("docs", "writing-custom-policies.md"),
  path.join("src", "cli", "init", "composer.ts"),
]);

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function scanTree(root: string, rel: string): string[] {
  const hits: string[] = [];
  const dir = path.join(root, rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    const full = path.join(root, relPath);
    if (entry.isDirectory()) {
      hits.push(...scanTree(root, relPath));
    } else if (entry.isFile() && /\.(ts|md|ya?ml)$/.test(entry.name)) {
      if (ALLOWLIST.has(relPath)) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const phrase of STALE_PHRASES) {
        if (text.includes(phrase)) {
          hits.push(`${relPath}: ${phrase}`);
        }
      }
    }
  }
  return hits;
}

describe("pre-0.45 fail-posture claims must not reappear under src/ or docs/", () => {
  it("finds zero stale-contract phrasings outside the allowlist", () => {
    expect([...scanTree(REPO_ROOT, "src"), ...scanTree(REPO_ROOT, "docs")]).toEqual([]);
  });

  it("allowlisted files still contain the phrase they are allowlisted FOR (a stale allowlist entry must fail, not silently over-allow)", () => {
    for (const rel of [
      path.join("docs", "ROADMAP.md"),
      path.join("docs", "writing-custom-policies.md"),
      path.join("src", "cli", "init", "composer.ts"),
    ]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(text, `${rel} no longer needs its allowlist entry — remove it`).toContain(
        "warn-mode",
      );
    }
  });

  it("positive control: the scan detects a planted occurrence in a fixture tree (guard cannot rot into a no-op)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-posture-guard-"));
    try {
      fs.mkdirSync(path.join(tmp, "src", "nested"), { recursive: true });
      const planted = path.join("src", "nested", "planted.ts");
      fs.writeFileSync(
        path.join(tmp, planted),
        "// every policy will fire in degraded warn-mode at runtime\n",
      );
      expect(scanTree(tmp, "src")).toEqual([`${planted}: warn-mode`]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
