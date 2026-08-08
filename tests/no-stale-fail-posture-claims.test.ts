import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for task `f1aea826` (tier-aware degraded fail posture). Four
// review rounds each found a FRESH surface still describing the
// pre-0.45 contract ("every degraded evaluation is non-blocking"):
// rounds 1-3 found doc/message surfaces quoting the old vocabulary;
// round 4 proved the class has a second, vocabulary-free variant —
// RESTATING the old mapping in current vocabulary ("ledger degradation
// → warn-degraded", "only ever blocks if grounding-mcp is wired").
// This guard catches BOTH variants under `src/` and `docs/` outside the
// per-phrase allowlist below.
//
// HONEST COVERAGE CLAIM (review 2026-08-08, round 4): this is a
// literal/pattern grep, not a semantic checker. It pins every phrasing
// any review round actually found, plus the restatement shapes round 4
// enumerated. A future paraphrase that avoids all needles still needs
// eyes — the guard reduces the class, it does not abolish prose review.
interface Needle {
  label: string;
  test: (text: string) => boolean;
}

const NEEDLES: Needle[] = [
  // Old vocabulary (rounds 1-3): the pre-0.45 term for the universal
  // non-blocking fallback.
  { label: "warn-mode", test: (t) => t.includes("warn-mode") },
  // Old absolute claim, inverted for block/require_approval tiers.
  {
    label: "no policy ever blocks",
    test: (t) => t.includes("no policy ever blocks"),
  },
  // Restatement variants (round 4): current vocabulary, wrong mapping.
  // "ledger degradation → warn-degraded" without the tier split; the
  // (->|→)\s*.{0,2} window is deliberately too small for the corrected
  // "→ tier-derived `warn-degraded`" phrasing to match.
  {
    label: "ledger degradation -> warn-degraded (untiered)",
    test: (t) => /ledger degradation\s*(?:->|→)\s*.{0,2}warn-degraded/i.test(t),
  },
  {
    label: "only ever blocks if grounding-mcp",
    test: (t) => /only ever blocks if grounding-mcp/i.test(t),
  },
  // "a degraded query yields warn-degraded ... fail-open for the
  // requires engine" — the untiered fail-open framing.
  {
    label: "warn-degraded ... fail-open for the",
    test: (t) => /warn-degraded[^.]{0,60}fail-open for the/i.test(t),
  },
];

// Per-PHRASE allowlist (round 4: a per-file allowlist granted
// writing-custom-policies.md a blanket pass on every needle, including
// the exact phrase round 3 had found in that exact file). Each entry
// names the ONLY needle labels the file may contain; the freshness test
// below fails when an entry stops matching, so entries cannot rot into
// blanket exemptions. `freshness: false` marks files exempted for
// historical-document status rather than for a specific live phrase.
const ALLOWLIST = new Map<string, { labels: string[]; freshness: boolean }>([
  [
    path.join("docs", "ROADMAP.md"),
    // Historical Phase 4 planning text; the superseded bullets carry
    // explicit SUPERSEDED-by-f1aea826 notes.
    { labels: ["warn-mode"], freshness: true },
  ],
  [
    path.join("docs", "ARCHITECTURE.md"),
    // Self-declared historical document; exempt without a freshness
    // pin so it may drop the phrasing at any time.
    { labels: ["warn-mode", "no policy ever blocks"], freshness: false },
  ],
  [
    path.join("docs", "writing-custom-policies.md"),
    // One PAST-TENSE pre-0.35-era reference inside a tier-aware bullet.
    { labels: ["warn-mode"], freshness: true },
  ],
  [
    path.join("src", "cli", "init", "composer.ts"),
    // One PAST-TENSE pre-0.45-era reference inside a tier-aware comment.
    { labels: ["warn-mode"], freshness: true },
  ],
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
      const allowed = ALLOWLIST.get(relPath);
      const text = fs.readFileSync(full, "utf8");
      for (const needle of NEEDLES) {
        if (allowed?.labels.includes(needle.label)) continue;
        if (needle.test(text)) {
          hits.push(`${relPath}: ${needle.label}`);
        }
      }
    }
  }
  return hits;
}

describe("pre-0.45 fail-posture claims must not reappear under src/ or docs/", () => {
  it("finds zero stale-contract phrasings outside the per-phrase allowlist", () => {
    expect([...scanTree(REPO_ROOT, "src"), ...scanTree(REPO_ROOT, "docs")]).toEqual([]);
  });

  it("allowlist freshness: each pinned entry still matches the needle it is allowlisted FOR (a stale entry must fail, not silently over-allow)", () => {
    for (const [rel, entry] of ALLOWLIST) {
      if (!entry.freshness) continue;
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      for (const label of entry.labels) {
        const needle = NEEDLES.find((n) => n.label === label);
        expect(needle, `unknown needle label in allowlist: ${label}`).toBeDefined();
        expect(
          needle!.test(text),
          `${rel} no longer contains "${label}" — remove its allowlist entry`,
        ).toBe(true);
      }
    }
  });

  it("positive control: the scan detects one planted occurrence PER NEEDLE in a fixture tree (guard cannot rot into a no-op)", () => {
    const planted: Array<[string, string]> = [
      ["a.ts", "// every policy will fire in degraded warn-mode at runtime\n"],
      ["b.md", "without it, no policy ever blocks\n"],
      ["c.md", "ledger degradation → `warn-degraded`, audit-write failure\n"],
      ["d.md", "A policies entry only ever blocks if grounding-mcp is wired\n"],
      ["e.md", "a degraded query yields warn-degraded for the policy, fail-open for the requires engine\n"],
    ];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-posture-guard-"));
    try {
      fs.mkdirSync(path.join(tmp, "src", "nested"), { recursive: true });
      for (const [name, content] of planted) {
        fs.writeFileSync(path.join(tmp, "src", "nested", name), content);
      }
      const hits = scanTree(tmp, "src");
      expect(hits).toHaveLength(planted.length);
      for (const needle of NEEDLES) {
        expect(
          hits.some((h) => h.endsWith(`: ${needle.label}`)),
          `needle "${needle.label}" caught nothing in the fixture — its pattern rotted`,
        ).toBe(true);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
