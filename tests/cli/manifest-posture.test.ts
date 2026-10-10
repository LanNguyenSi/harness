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
  REMOVED_POLICY_FIELDS,
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
// branch-protection pack whose ux still names the removed producer (a removed
// command, which warns too since task f3f15290).
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
      "permission_profiles",
      "risk",
      "environments",
    ]);
    for (const p of REMOVED_MANIFEST_PATHS) {
      expect(p.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  it("lists the removed per-policy field when:, with a version and a reason", () => {
    expect(REMOVED_POLICY_FIELDS.map((f) => f.field)).toEqual(["when"]);
    for (const f of REMOVED_POLICY_FIELDS) {
      expect(f.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(f.reason.length).toBeGreaterThan(0);
    }
  });

  it("lists every removed builtin pack with a version and a reason", () => {
    expect(REMOVED_PACK_NAMES.map((p) => p.name)).toEqual([
      "post-merge-gate",
      "solution-acceptance",
      "understanding-before-execution",
    ]);
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
      policyFields: [],
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
  it("the live-shaped manifest parses with the two removed-key warnings and the removed-command one", () => {
    const { manifest, warnings } = parseManifestWithWarnings(parseYaml(LIVE_SHAPED));
    expect(warnings.map((w) => w.path)).toEqual([
      "grounding.evidence_ledger.retention_days",
      "grounding.policies_source",
      "policy_packs[0].config.ux.run[1]",
    ]);
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
      "policy_packs[0].config.ux.run[1]",
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
  it("prints the two removed keys and the removed command in the Manifest section and counts them as warnings", async () => {
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
      expect.stringMatching(/^policy_packs\[0\]\.config\.ux\.run\[1\]: calls "harness session-start", removed in 1\.0\.0/),
    ]);
    expect(report.warningCount).toBeGreaterThanOrEqual(3);
    const text = format(report);
    expect(text).toContain("⚠ grounding.policies_source: removed in 1.0.0 and ignored");
    // Its ux.run still names the removed `harness session-start branch-check`:
    // reported as drift from the shipped default, which `pack reseed` fixes.
    expect(report.policyPacks.uxDrift.map((d) => d.name)).toContain("branch-protection");
  });
});

// Removed Risk Gate keys (task 39c112e0): top-level `risk` and `environments`
// are stripped with a warning, and a policy that carries `when:` is dropped
// whole, never stripped to its trigger (that would widen a scoped gate).
describe("removed Risk Gate keys", () => {
  const HOOK = { name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false };
  const policy = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: `policy ${name}`,
    trigger: { event: "PreToolUse", match: "Bash" },
    requires: { ledger_tag: `ok-${name}:\${SESSION_ID}` },
    hook: "h",
    enforcement: "block",
    ...extra,
  });
  const WHEN = { "risk.severity_at_least": "high", "environment.name": "production" };
  const policiesOf = (raw: unknown) => (raw as { policies: Array<{ name: string }> }).policies;

  it("strips risk and environments with one warning each, and leaves the input untouched", () => {
    const raw = {
      version: 1,
      risk: { classifiers: [{ name: "x" }], safe_deletion_roots: ["/tmp"] },
      environments: { resolvers: [] },
    };
    const before = JSON.stringify(raw);
    const r = stripRemovedManifestEntries(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(r.raw).toEqual({ version: 1 });
    expect(r.warnings.map((w) => w.path)).toEqual(["risk", "environments"]);
    for (const w of r.warnings) expect(w.message).toMatch(/^removed in 1\.0\.0 and ignored \(.+\); delete it from the manifest$/);
  });

  it("says fail_open is no longer honoured when the stripped risk block carried it", () => {
    const r = stripRemovedManifestEntries({ version: 1, risk: { degraded_fail_posture: "fail_open" } });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.path).toBe("risk");
    expect(r.warnings[0]!.message).toContain("risk.degraded_fail_posture: fail_open is no longer honoured");
    expect(r.warnings[0]!.message).toContain("block and require_approval policies fail closed");
  });

  it.each([
    ["preserve_enforcement", { degraded_fail_posture: "preserve_enforcement" }],
    ["no posture key", { classifiers: [] }],
    ["a non-object value", "fail_open"],
  ])("adds no fail_open sentence for a risk block with %s", (_name, risk) => {
    const r = stripRemovedManifestEntries({ version: 1, risk });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.message).not.toContain("fail_open");
  });

  it("drops a policy carrying when: whole, with one named warning at its original index", () => {
    const raw = {
      version: 1,
      hooks: [HOOK],
      policies: [policy("keep-a"), policy("scoped", { when: WHEN }), policy("keep-b"), policy("scoped-2", { when: { "action.reversible": false } })],
    };
    const before = JSON.stringify(raw);
    const r = stripRemovedManifestEntries(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(policiesOf(r.raw).map((p) => p.name)).toEqual(["keep-a", "keep-b"]);
    expect(r.warnings.map((w) => w.path)).toEqual(["policies[1]", "policies[3]"]);
    expect(r.warnings[0]!.message).toBe(
      'policy "scoped" dropped whole: when: clauses are removed in 1.0.0 (the Risk Gate is removed, and keeping only the trigger would widen the policy\'s scope); delete the policy from the manifest, or re-create it without when:',
    );
    expect(r.warnings[1]!.message).toContain('policy "scoped-2" dropped whole');
  });

  it("never strips only the when key: no trigger-only copy of the policy survives, and the dropped policy leaves no gate", () => {
    const { manifest, warnings } = parseManifestWithWarnings({
      version: 1,
      hooks: [HOOK],
      policies: [policy("gate-prod-destructive", { when: WHEN })],
    });
    expect(manifest.policies).toEqual([]);
    expect(warnings.map((w) => w.path)).toEqual(["policies[0]"]);
  });

  it.each([
    ["an empty when: {}", {}],
    ["a null when", null],
  ])("drops a policy with %s as well (the key alone decides)", (_name, when) => {
    const r = stripRemovedManifestEntries({ version: 1, policies: [policy("p", { when })] });
    expect(policiesOf(r.raw)).toEqual([]);
    expect(r.warnings.map((w) => w.path)).toEqual(["policies[0]"]);
  });

  it("keeps a policy that has no when: key, and an entry that is not an object for the strict parse to reject", () => {
    const raw = { version: 1, policies: [policy("plain")] };
    const r = stripRemovedManifestEntries(raw);
    expect(r.raw).toBe(raw);
    expect(r.warnings).toEqual([]);
    expect(() => parseManifestWithWarnings({ version: 1, policies: [5] })).toThrow(ManifestParseError);
  });

  it("a manifest carrying every removed Risk Gate key loads with one warning each and the live policies intact", () => {
    const { manifest, warnings } = parseManifestWithWarnings({
      version: 1,
      hooks: [HOOK],
      risk: { degraded_fail_posture: "fail_open", classifiers: [] },
      environments: { resolvers: [] },
      policies: [policy("scoped", { when: WHEN }), policy("plain", { enforcement: "warn" })],
    });
    expect(manifest.policies.map((p) => p.name)).toEqual(["plain"]);
    expect(manifest).not.toHaveProperty("risk");
    expect(manifest).not.toHaveProperty("environments");
    expect(warnings.map((w) => w.path)).toEqual(["risk", "environments", "policies[0]"]);
  });

  it("a misspelled risk-like key that was never valid still fails the parse", () => {
    expect(() => parseManifestWithWarnings({ version: 1, risks: {} })).toThrow(ManifestParseError);
    expect(() => parseManifestWithWarnings({ version: 1, policies: [policy("p", { whenn: WHEN })] })).toThrow(ManifestParseError);
  });

  it("harness validate warns on each, and --strict fails on each", () => {
    const file = writeManifest(
      [
        "version: 1",
        "hooks:",
        "  - { name: h, event: PreToolUse, command: /usr/bin/true, blocking: false }",
        "risk:",
        "  degraded_fail_posture: fail_open",
        "environments:",
        "  resolvers: []",
        "policies:",
        "  - name: scoped",
        "    description: scoped",
        "    trigger: { event: PreToolUse, match: Bash }",
        "    requires: { ledger_tag: 'ok:${SESSION_ID}' }",
        "    hook: h",
        "    enforcement: block",
        "    when: { environment.name: production }",
        "",
      ].join("\n"),
    );
    const paths = ["risk", "environments", "policies[0]"];
    const lenient = validate({ configPath: file, ...NOOP_PROBES });
    expect(lenient.manifest).not.toBeNull();
    const warn = lenient.diagnostics.filter((d) => paths.includes(d.path));
    expect(warn.map((d) => [d.path, d.severity])).toEqual(paths.map((p) => [p, "warning"]));
    const strict = validate({ configPath: file, strict: true, ...NOOP_PROBES });
    const err = strict.diagnostics.filter((d) => paths.includes(d.path));
    expect(err.map((d) => [d.path, d.severity])).toEqual(paths.map((p) => [p, "error"]));
    expect(formatReport(lenient)).toContain('policy "scoped" dropped whole');
  });
});
