// Manifest posture for removed keys and removed packs (task a4d8adc5): they
// warn and are ignored, never fail the load. `harness validate` and `harness
// doctor` print the warnings, `harness validate --strict` fails on them, and a
// key that was never valid still fails the parse.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, format } from "../../src/cli/doctor/index.js";
import { loadManifest } from "../../src/cli/loader.js";
import { formatReport, validate } from "../../src/cli/validate/index.js";
import type { ClaudeMcpExec } from "../../src/io/claude-mcp.js";
import {
  ManifestParseError,
  REMOVED_MANIFEST_PATHS,
  REMOVED_PACK_NAMES,
  parseManifest,
  parseManifestWithWarnings,
  stripRemovedManifestEntries,
} from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeManifest(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-posture-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "harness.yaml");
  fs.writeFileSync(file, text, "utf8");
  return file;
}

// The shape of a live manifest that predates the removal: both removed
// grounding keys, MCP servers, an empty hook and policy list, and the
// branch-protection pack whose ux still names the removed producer.
const LIVE_SHAPED = `version: 1

grounding:
  session:
    auto_start: true
    id_format: "gs-{repo}-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db
    retention_days: 90
  policies_source: ~/.claude/harness.d/policies/claim-gate.yaml

tools:
  mcp:
    - name: grounding-mcp
      command: [grounding-mcp]
      min_version: "0.2.0"
      health:
        verb: ledger_status
        timeout_ms: 5000
      enabled: true
  builtin:
    known: [Read, Edit, Write, Bash]

hooks: []

policies: []

policy_packs:
  - name: branch-protection
    source: builtin
    enabled: true
    config:
      ux:
        cannot: "You cannot edit files on protected branch \${BRANCH} yet."
        required:
          - "a checkout of a non-protected branch (current \`\${BRANCH}\` is protected)"
        run:
          - "git checkout -b feat/<your-task>"
          - "harness session-start branch-check"
`;

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
  gitIgnoreProbe: () => null,
};

const NO_CLAUDE_CLI: ClaudeMcpExec = async () => ({ code: 127, stdout: "", stderr: "", enoent: true, timedOut: false });

describe("the removed-entry table", () => {
  it("lists the reserved grounding keys and the removed producer roots, each with a version and a reason", () => {
    expect(REMOVED_MANIFEST_PATHS.map((p) => p.path)).toEqual([
      "grounding.evidence_ledger.retention_days",
      "grounding.policies_source",
      "session_start_preflight",
      "toolchain_parity",
      "stale_base_check",
    ]);
    for (const p of REMOVED_MANIFEST_PATHS) {
      expect(p.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  it("lists every removed builtin pack with a version and a reason", () => {
    expect(REMOVED_PACK_NAMES.length).toBeGreaterThan(0);
    for (const p of REMOVED_PACK_NAMES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("stripRemovedManifestEntries", () => {
  it("strips both removed grounding keys with one warning each, and leaves the input untouched", () => {
    const raw = parseYaml(LIVE_SHAPED) as Record<string, unknown>;
    const before = JSON.stringify(raw);
    const r = stripRemovedManifestEntries(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(r.warnings.map((w) => w.path)).toEqual([
      "grounding.evidence_ledger.retention_days",
      "grounding.policies_source",
    ]);
    expect(r.warnings[0]!.message).toMatch(/^removed in 1\.0\.0 and ignored \(.+\); delete it from the manifest$/);
    const grounding = (r.raw as { grounding: Record<string, unknown> }).grounding;
    expect(grounding).not.toHaveProperty("policies_source");
    expect(grounding["evidence_ledger"]).toEqual({ path: "~/.evidence-ledger/ledger.db" });
    expect(grounding["session"]).toEqual({ auto_start: true, id_format: "gs-{repo}-{rand:8}" });
  });

  it("leaves a manifest without removed entries as it is (same object, no warnings)", () => {
    const raw = { version: 1, grounding: { evidence_ledger: { path: "/x" } } };
    const r = stripRemovedManifestEntries(raw);
    expect(r.raw).toBe(raw);
    expect(r.warnings).toEqual([]);
  });

  it("does not follow a path through a non-object (the strict parse reports that)", () => {
    const raw = { version: 1, grounding: "not an object" };
    expect(stripRemovedManifestEntries(raw)).toEqual({ raw, warnings: [] });
  });

  it("skips an entry of a removed pack name with a warning, and keeps every other pack (injected table)", () => {
    const raw = {
      version: 1,
      policy_packs: [{ name: "branch-protection" }, { name: "old-pack", enabled: true }, { name: "other" }],
    };
    const before = JSON.stringify(raw);
    const r = stripRemovedManifestEntries(raw, {
      paths: [],
      packs: [{ name: "old-pack", removedIn: "9.9.9", reason: "gone for the test" }],
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect((r.raw as { policy_packs: Array<{ name: string }> }).policy_packs.map((p) => p.name)).toEqual([
      "branch-protection",
      "other",
    ]);
    expect(r.warnings).toEqual([
      {
        path: "policy_packs[1]",
        message: 'pack "old-pack" was removed in 9.9.9 and is skipped (gone for the test); delete the entry from the manifest',
      },
    ]);
  });
});

describe("parsing", () => {
  it("the live-shaped manifest parses with exactly the two warnings", () => {
    const { manifest, warnings } = parseManifestWithWarnings(parseYaml(LIVE_SHAPED));
    expect(warnings).toHaveLength(2);
    expect(manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
    // The plain parser accepts it too (callers that do not report warnings).
    expect(() => parseManifest(parseYaml(LIVE_SHAPED))).not.toThrow();
  });

  it.each([
    ["a misspelled grounding key", "version: 1\ngrounding:\n  policies_sauce: x\n"],
    ["a misspelled ledger key", "version: 1\ngrounding:\n  evidence_ledger:\n    retention_dayz: 90\n"],
    ["an unknown top-level key", "version: 1\nnot_a_key: true\n"],
  ])("%s that was never valid still fails the parse", (_name, text) => {
    expect(() => parseManifestWithWarnings(parseYaml(text))).toThrow(ManifestParseError);
  });

  it("the loader returns the warnings beside the manifest", () => {
    const file = writeManifest(LIVE_SHAPED);
    const loaded = loadManifest({ configPath: file });
    expect(loaded.warnings.map((w) => w.path)).toEqual([
      "grounding.evidence_ledger.retention_days",
      "grounding.policies_source",
    ]);
  });
});

describe("harness validate", () => {
  const postureDiags = (diags: Array<{ path: string; severity: string }>) =>
    diags.filter((d) => d.path.startsWith("grounding.evidence_ledger.retention_days") || d.path === "grounding.policies_source");

  it("prints the two removed keys as warnings and loads the manifest", () => {
    const file = writeManifest(LIVE_SHAPED);
    const result = validate({ configPath: file, ...NOOP_PROBES });
    expect(result.manifest).not.toBeNull();
    const diags = postureDiags(result.diagnostics);
    expect(diags.map((d) => [d.path, d.severity])).toEqual([
      ["grounding.evidence_ledger.retention_days", "warning"],
      ["grounding.policies_source", "warning"],
    ]);
    expect(formatReport(result)).toContain("WARN  grounding.policies_source: removed in 1.0.0 and ignored (");
  });

  it("--strict fails on them", () => {
    const file = writeManifest(LIVE_SHAPED);
    const result = validate({ configPath: file, strict: true, ...NOOP_PROBES });
    const diags = postureDiags(result.diagnostics);
    expect(diags.map((d) => d.severity)).toEqual(["error", "error"]);
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
  });

  it("a manifest without removed keys has no posture diagnostics", () => {
    const file = writeManifest("version: 1\ngrounding:\n  evidence_ledger:\n    path: /x.db\n");
    const result = validate({ configPath: file, strict: true, ...NOOP_PROBES });
    expect(postureDiags(result.diagnostics)).toEqual([]);
  });
});

describe("harness doctor", () => {
  it("prints the two removed keys in the Manifest section and counts them as warnings", async () => {
    const file = writeManifest(LIVE_SHAPED);
    const home = path.dirname(file);
    const report = await doctor({
      configPath: file,
      homeOverride: home,
      shallow: true,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: NO_CLAUDE_CLI,
    });
    expect(report.manifest.warnings).toEqual([
      expect.stringMatching(/^grounding\.evidence_ledger\.retention_days: removed in 1\.0\.0 and ignored/),
      expect.stringMatching(/^grounding\.policies_source: removed in 1\.0\.0 and ignored/),
    ]);
    expect(report.warningCount).toBeGreaterThanOrEqual(2);
    const text = format(report);
    expect(text).toContain("⚠ grounding.policies_source: removed in 1.0.0 and ignored");
    // Its ux.run still names the removed `harness session-start branch-check`:
    // reported as drift from the shipped default, which `pack reseed` fixes.
    expect(report.policyPacks.uxDrift.map((d) => d.name)).toContain("branch-protection");
  });
});
