// The removed understanding-before-execution pack and the permission_profiles
// key it alone consumed load with a warning and are ignored (task 9389707f,
// the removed-entry posture applied to the third entry of REMOVED_PACK_NAMES
// and the permission_profiles path in REMOVED_MANIFEST_PATHS): the manifest
// parses, the pack entry and the key are stripped before the strict schema
// parse, `harness validate` prints one warning per entry (exit 0) and
// `harness validate --strict` fails on them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../../src/cli/loader.js";
import { validate } from "../../src/cli/validate/index.js";

const HEADER = `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read, Edit, Write, Bash]
`;

// Every case keeps branch-protection first, so the removed pack is
// policy_packs[1] and the surviving entry is the only one left after the strip.
const BP = `policy_packs:
  - name: branch-protection
`;

const UG_ENABLED = `${HEADER}${BP}  - name: understanding-before-execution
    enabled: true
    config:
      mode: grill_me
      permission_profile: safe-start
`;

const UG_DISABLED = `${HEADER}${BP}  - name: understanding-before-execution
    enabled: false
`;

// Config the pack's own schema would have rejected: the entry is stripped
// before any config check, so junk never fails the load.
const UG_JUNK_CONFIG = `${HEADER}${BP}  - name: understanding-before-execution
    enabled: true
    config:
      mode: not-a-mode
      bogus_key: [1, 2, 3]
      auto_approve: { when: [], harnesses: 5 }
      stay_in_scope: 7
`;

const PROFILES_WELL_FORMED = `${HEADER}${BP}permission_profiles:
  custom:
    description: test
    actions:
      read: { allow: true }
      edit: { allow: false }
      deploy: { allow: ask_or_deny }
`;

const PROFILES_MALFORMED = `${HEADER}${BP}permission_profiles:
  bad:
    actions:
      unknown_action: { allow: maybe }
`;

const UG_AND_PROFILES = `${HEADER}permission_profiles:
  custom:
    actions:
      read: { allow: true }
${BP}  - name: understanding-before-execution
    config:
      permission_profile: custom
`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeManifest(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-removed-ug-"));
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
};

const PACK_PATH = "policy_packs[1]";
const PROFILES_PATH = "permission_profiles";

describe("a manifest that still names the removed understanding-before-execution pack", () => {
  it.each([
    ["enabled", UG_ENABLED],
    ["disabled", UG_DISABLED],
    ["with junk config", UG_JUNK_CONFIG],
  ])("%s: loads, warns once at policy_packs[1], and drops the pack entry", (_label, manifest) => {
    const file = writeManifest(manifest);
    const loaded = loadManifest({ configPath: file });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.path).toBe(PACK_PATH);
    expect(loaded.warnings[0]?.message).toContain("understanding-before-execution");
    expect(loaded.warnings[0]?.message).toContain("removed in 1.0.0");
    expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
  });

  it.each([
    ["enabled", UG_ENABLED],
    ["disabled", UG_DISABLED],
    ["with junk config", UG_JUNK_CONFIG],
  ])("%s: harness validate warns and exits 0; --strict makes it an error (non-zero exit)", (_label, manifest) => {
    const file = writeManifest(manifest);
    const plain = validate({ configPath: file, ...NOOP_PROBES });
    expect(plain.manifest).not.toBeNull();
    const ug = plain.diagnostics.filter((d) => d.path === PACK_PATH);
    expect(ug.map((d) => d.severity)).toEqual(["warning"]);
    expect(plain.errorCount).toBe(0);

    const strict = validate({ configPath: file, strict: true, ...NOOP_PROBES });
    const strictUg = strict.diagnostics.filter((d) => d.path === PACK_PATH);
    expect(strictUg.map((d) => d.severity)).toEqual(["error"]);
    // The CLI wrapper exits non-zero whenever errorCount > 0
    // (src/cli/register-inspect-group.ts).
    expect(strict.errorCount).toBeGreaterThanOrEqual(1);
  });
});

describe("a manifest that still carries the removed permission_profiles key", () => {
  it.each([
    ["well-formed", PROFILES_WELL_FORMED],
    ["malformed", PROFILES_MALFORMED],
  ])("%s: loads, warns once at permission_profiles, and drops the key", (_label, manifest) => {
    const file = writeManifest(manifest);
    const loaded = loadManifest({ configPath: file });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.path).toBe(PROFILES_PATH);
    expect(loaded.warnings[0]?.message).toContain("removed in 1.0.0");
    expect("permission_profiles" in loaded.manifest).toBe(false);
    expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
  });

  it.each([
    ["well-formed", PROFILES_WELL_FORMED],
    ["malformed", PROFILES_MALFORMED],
  ])("%s: harness validate warns and exits 0; --strict makes it an error (non-zero exit)", (_label, manifest) => {
    const file = writeManifest(manifest);
    const plain = validate({ configPath: file, ...NOOP_PROBES });
    expect(plain.manifest).not.toBeNull();
    expect(plain.diagnostics.filter((d) => d.path === PROFILES_PATH).map((d) => d.severity)).toEqual(["warning"]);
    expect(plain.errorCount).toBe(0);

    const strict = validate({ configPath: file, strict: true, ...NOOP_PROBES });
    expect(strict.diagnostics.filter((d) => d.path === PROFILES_PATH).map((d) => d.severity)).toEqual(["error"]);
    expect(strict.errorCount).toBeGreaterThanOrEqual(1);
  });
});

describe("a manifest that carries both the removed pack and permission_profiles", () => {
  it("loads with exactly two warnings, one per entry, and strips both", () => {
    const file = writeManifest(UG_AND_PROFILES);
    const loaded = loadManifest({ configPath: file });
    expect(loaded.warnings.map((w) => w.path)).toEqual([PROFILES_PATH, PACK_PATH]);
    expect("permission_profiles" in loaded.manifest).toBe(false);
    expect(loaded.manifest.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
  });
});
