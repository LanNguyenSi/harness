// Removed manifest roots (task f3f15290). The `session_start_preflight`,
// `toolchain_parity` and `stale_base_check` top-level sections configured the
// now-deleted SessionStart producers. They live in REMOVED_MANIFEST_PATHS so a
// manifest that still carries one is stripped with a posture warning instead of
// hard-failing the strict parse. Pin the table entries and the strip behaviour.
import { describe, expect, it } from "vitest";
import {
  REMOVED_MANIFEST_PATHS,
  parseManifest,
  stripRemovedManifestEntries,
} from "../../src/schema/index.js";

const PRODUCER_ROOTS = ["session_start_preflight", "toolchain_parity", "stale_base_check"] as const;

describe("REMOVED_MANIFEST_PATHS carries the removed producer roots (task f3f15290)", () => {
  for (const root of PRODUCER_ROOTS) {
    it(`lists ${root} with a version and a reason`, () => {
      const entry = REMOVED_MANIFEST_PATHS.find((p) => p.path === root);
      expect(entry, `${root} present`).toBeDefined();
      expect(entry!.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry!.reason.length).toBeGreaterThan(0);
    });
  }
});

describe("stripRemovedManifestEntries removes the producer roots", () => {
  it("drops each producer root with one warning each, and leaves the input untouched", () => {
    const raw = {
      version: 1,
      hooks: [],
      policies: [],
      session_start_preflight: { setup: true },
      toolchain_parity: { enabled: true },
      stale_base_check: { enabled: false },
    };
    const before = JSON.stringify(raw);
    const { raw: stripped, warnings } = stripRemovedManifestEntries(raw);

    expect(JSON.stringify(raw)).toBe(before);
    expect(warnings.map((w) => w.path).sort()).toEqual([...PRODUCER_ROOTS].sort());
    for (const w of warnings) {
      expect(w.message).toMatch(/^removed in \d+\.\d+\.\d+ and ignored \(.+\); delete it from the manifest$/);
    }
    const obj = stripped as Record<string, unknown>;
    for (const root of PRODUCER_ROOTS) expect(obj).not.toHaveProperty(root);
    // The rest of the manifest survives.
    expect(obj["version"]).toBe(1);
  });

  it("leaves a manifest without producer roots as the same object with no warnings", () => {
    const raw = { version: 1, hooks: [], policies: [] };
    const r = stripRemovedManifestEntries(raw);
    expect(r.raw).toBe(raw);
    expect(r.warnings).toEqual([]);
  });

  it("a stripped manifest parses cleanly, so the roots never reach the strict parser", () => {
    const { raw } = stripRemovedManifestEntries({
      version: 1,
      hooks: [],
      policies: [],
      session_start_preflight: { setup: true },
    });
    expect(() => parseManifest(raw)).not.toThrow();
  });
});
