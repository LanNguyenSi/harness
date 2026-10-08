// The removed post-merge-gate pack loads with a warning and is ignored
// (task 2ce6933f, the removed-pack posture of task a4d8adc5 applied to the
// first entry of REMOVED_PACK_NAMES): the manifest parses, the pack entry is
// stripped before the strict schema parse, `harness validate` prints the
// warning (exit 0) and `harness validate --strict` fails on it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../../src/cli/loader.js";
import { validate } from "../../src/cli/validate/index.js";

const PMG_MANIFEST = `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read, Edit, Write, Bash]
policy_packs:
  - name: branch-protection
  - name: post-merge-gate
    enabled: true
    config:
      anything: 1
`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeManifest(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-removed-pmg-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "harness.yaml");
  fs.writeFileSync(file, text, "utf8");
  return file;
}

// The same NOOP_PROBES tests/cli/manifest-posture.test.ts passes to
// validate() for the removed-key posture.
const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
  gitIgnoreProbe: () => null,
};

const PMG_DIAG_PATH = "policy_packs[1]";

describe("a manifest that still names the removed post-merge-gate pack", () => {
  it("loads, warns once at policy_packs[1], and drops the pack entry", () => {
    const file = writeManifest(PMG_MANIFEST);
    const loaded = loadManifest({ configPath: file });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.path).toBe(PMG_DIAG_PATH);
    expect(loaded.warnings[0]?.message).toContain("removed in 1.0.0");
    expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
  });

  it("harness validate warns and exits 0; --strict makes it an error (non-zero exit)", () => {
    const file = writeManifest(PMG_MANIFEST);
    const plain = validate({ configPath: file, ...NOOP_PROBES });
    expect(plain.manifest).not.toBeNull();
    const pmg = plain.diagnostics.filter((d) => d.path === PMG_DIAG_PATH);
    expect(pmg.map((d) => d.severity)).toEqual(["warning"]);
    expect(plain.errorCount).toBe(0);

    const strict = validate({ configPath: file, strict: true, ...NOOP_PROBES });
    const strictPmg = strict.diagnostics.filter((d) => d.path === PMG_DIAG_PATH);
    expect(strictPmg.map((d) => d.severity)).toEqual(["error"]);
    // The CLI wrapper exits non-zero whenever errorCount > 0
    // (src/cli/register-inspect-group.ts).
    expect(strict.errorCount).toBeGreaterThanOrEqual(1);
  });
});
