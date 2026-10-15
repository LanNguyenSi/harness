import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ManifestParseError, parseManifest, parseManifestWithWarnings } from "../src/schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const EXAMPLES_DIR = path.join(REPO_ROOT, "docs", "examples");
const INVALID_DIR = path.join(EXAMPLES_DIR, "invalid");

function loadYaml(p: string): unknown {
  return parseYaml(fs.readFileSync(p, "utf8"));
}

function expectIssueMatching(err: unknown, pattern: RegExp): void {
  expect(err).toBeInstanceOf(ManifestParseError);
  const issues = (err as ManifestParseError).issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
  expect(issues).toMatch(pattern);
}

describe("parseManifest — happy path", () => {
  it("parses the full reference manifest into a typed object", () => {
    const raw = loadYaml(path.join(EXAMPLES_DIR, "full-manifest.yaml"));
    const manifest = parseManifest(raw);
    expect(manifest.version).toBe(1);
    expect(manifest.tools.mcp).toHaveLength(3);
    expect(manifest.tools.mcp[0]?.name).toBe("codebase-oracle");
    expect(manifest.tools.mcp[2]?.name).toBe("grounding-mcp");
    // The reference manifest ships no hooks any more (task bcdcde36).
    expect(manifest.hooks).toHaveLength(0);
    expect(manifest.policy_packs).toHaveLength(1);
    expect(manifest.policy_packs[0]?.name).toBe("branch-protection");
    expect(manifest.policy_packs[0]?.source).toBe("builtin");
    expect(manifest.policy_packs[0]?.enabled).toBe(true);
  });

  it("applies defaults when optional sections are omitted", () => {
    const m = parseManifest({ version: 1 });
    expect(m.grounding.session.auto_start).toBe(true);
    expect(m.grounding.evidence_ledger.path).toBe("~/.evidence-ledger/ledger.db");
    // Removed in task a4d8adc5 (reserved keys without a consumer): no
    // default is filled in any more.
    expect(m.grounding.evidence_ledger).not.toHaveProperty("retention_days");
    expect(m.grounding).not.toHaveProperty("policies_source");
    expect(m.tools.mcp).toEqual([]);
    expect(m.tools.builtin.known).toEqual([]);
    expect(m.memory.retention.staleness_days).toBe(180);
    expect(m.memory.scopes.default).toBe("project");
    expect(m.hooks).toEqual([]);
    expect(m.policy_packs).toEqual([]);
    // The policy keys are removed (task 10e2ff0a): no default is filled in.
    for (const key of ["policies", "workflows", "review_templates", "doctor"]) {
      expect(m).not.toHaveProperty(key);
    }
    // The Risk Gate keys are removed (task 39c112e0): no default is filled in.
    expect(m).not.toHaveProperty("risk");
    expect(m).not.toHaveProperty("environments");
  });

  it("accepts a string command for tools.mcp[].command", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [{ name: "x", command: "node /tmp/x.js" }] },
    });
    expect(m.tools.mcp[0]?.command).toBe("node /tmp/x.js");
  });
});

describe("parseManifest — invalid fixtures", () => {
  const cases: Array<{ file: string; pattern: RegExp }> = [
    { file: "01-unknown-version.yaml", pattern: /version/i },
    { file: "02-unknown-toplevel-key.yaml", pattern: /unrecognized key|foo/i },
    { file: "08-duplicate-mcp-name.yaml", pattern: /duplicate mcp/i },
    { file: "09-skills-required-not-enabled.yaml", pattern: /required.*subset.*enabled/i },
    { file: "10-memory-default-not-allowed.yaml", pattern: /default.*allowed/i },
    { file: "11-bad-blocking-enum.yaml", pattern: /blocking|invalid/i },
    { file: "12-missing-version.yaml", pattern: /version/i },
    {
      file: "17-policy-pack-duplicate-name.yaml",
      pattern: /duplicate policy_pack name/i,
    },
    { file: "18-policy-pack-unknown-key.yaml", pattern: /unrecognized key|bogus_field/i },
  ];

  for (const c of cases) {
    it(`rejects ${c.file}`, () => {
      const raw = loadYaml(path.join(INVALID_DIR, c.file));
      let caught: unknown;
      try {
        parseManifest(raw);
      } catch (e) {
        caught = e;
      }
      expect(caught, `expected ${c.file} to throw`).toBeDefined();
      expectIssueMatching(caught, c.pattern);
    });
  }
});

describe("parseManifest — uniqueness checks", () => {
  it("rejects duplicate hook names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          { name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false },
          { name: "h", event: "PostToolUse", command: "/usr/bin/true", blocking: false },
        ],
      }),
    ).toThrow(/duplicate hook/i);
  });

  it("rejects hook names starting with reserved `memory:` prefix (PR #204)", () => {
    // `harness apply` injects a synthetic Hook with `name: "memory:router"`
    // for the memory-router projection. Without this check, an operator
    // who happened to name their own hook with the same prefix would
    // produce a duplicate entry in the generated settings.json silently.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "memory:router",
            event: "UserPromptSubmit",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).toThrow(/reserved prefix.*"memory:"/);
  });

  it("rejects any hook name starting with `memory:` even when not literally `memory:router`", () => {
    // Prefix reservation is whole-namespace, not exact-string. Future
    // memory-* synthetic projections (e.g. memory:retention) are
    // pre-reserved without needing another schema bump.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "memory:my-custom-thing",
            event: "PreToolUse",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).toThrow(/reserved prefix.*"memory:"/);
  });

  it("reserved-prefix check is case-sensitive (`Memory:router` parses, intentional)", () => {
    // startsWith is case-sensitive; we deliberately do not normalize.
    // Claude Code and Codex hook keys are compared verbatim, so a
    // capital-M variant cannot collide with the lowercase synthetic.
    // Pin the intent here so a future "let's be lenient and lowercase
    // both sides" refactor breaks this test explicitly.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "Memory:router",
            event: "UserPromptSubmit",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts hook names that merely contain `memory:` as a substring", () => {
    // Prefix check is `startsWith`, not `includes`. A hook named
    // `xmemory:y` or `policy-pack:memory:router` does not collide with
    // the synthetic projection and must continue to parse.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "policy-pack:memory:router",
            event: "UserPromptSubmit",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects duplicate cli tool names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        tools: {
          cli: [
            { name: "git-batch", binary: "git-batch" },
            { name: "git-batch", binary: "git-batch-other" },
          ],
        },
      }),
    ).toThrow(/duplicate cli/i);
  });
});

describe("parseManifest — policy_packs", () => {
  it("defaults policy_packs to an empty array when absent", () => {
    const m = parseManifest({ version: 1 });
    expect(m.policy_packs).toEqual([]);
  });

  it("parses a minimal pack with only a name; source defaults to 'builtin'", () => {
    const m = parseManifest({
      version: 1,
      policy_packs: [{ name: "branch-protection" }],
    });
    expect(m.policy_packs[0]).toEqual({
      name: "branch-protection",
      source: "builtin",
      enabled: true,
      config: {},
    });
  });

  it("preserves an opaque config payload on the pack entry", () => {
    const m = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "branch-protection",
          config: { protected_branches: ["main"], custom_extra: { nested: 42 } },
        },
      ],
    });
    expect(m.policy_packs[0]?.config).toEqual({
      protected_branches: ["main"],
      custom_extra: { nested: 42 },
    });
  });

  it("rejects an empty name", () => {
    expect(() =>
      parseManifest({ version: 1, policy_packs: [{ name: "" }] }),
    ).toThrow();
  });

  it("rejects names containing path separators or parent-dir refs", () => {
    for (const bad of ["../etc", "foo/bar", "..", "/abs", "name with space", "-leading-dash"]) {
      expect(() =>
        parseManifest({ version: 1, policy_packs: [{ name: bad }] }),
      ).toThrow(/path separators are rejected|alphanumeric/i);
    }
  });

  it("accepts conservative name shapes (alphanumeric + dash + dot + underscore)", () => {
    for (const ok of ["pack", "pack_v2", "pack-name", "pack.v1", "Pack123"]) {
      expect(() =>
        parseManifest({ version: 1, policy_packs: [{ name: ok }] }),
      ).not.toThrow();
    }
  });

  it("rejects unknown keys on a pack entry (.strict())", () => {
    expect(() =>
      parseManifest({
        version: 1,
        policy_packs: [{ name: "x", source: "builtin", surprise: true }],
      }),
    ).toThrow(/unrecognized key|surprise/i);
  });

  it("rejects duplicate pack names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        policy_packs: [{ name: "p" }, { name: "p" }],
      }),
    ).toThrow(/duplicate policy_pack name/i);
  });
});

describe("parseManifest: permission_profiles (removed key)", () => {
  it("no longer declares the key: a manifest without it parses to a manifest without it", () => {
    const m = parseManifest({ version: 1 });
    expect("permission_profiles" in m).toBe(false);
  });

  it.each([
    ["well-formed", { custom: { actions: { read: { allow: true }, deploy: { allow: "ask_or_deny" } } } }],
    ["malformed", { bad: { actions: { unknown_action: { allow: "maybe" } } } }],
    ["empty", {}],
  ])("a %s permission_profiles block is stripped with one warning, never a parse failure", (_label, value) => {
    const { manifest, warnings } = parseManifestWithWarnings({ version: 1, permission_profiles: value });
    expect("permission_profiles" in manifest).toBe(false);
    expect(warnings.map((w) => w.path)).toEqual(["permission_profiles"]);
    expect(warnings[0]?.message).toContain("removed in 1.0.0");
  });
});

describe("parseManifest — min_version numeric pattern", () => {
  // Five schema fields feed `compareNumericVersions`: hooks[].min_version,
  // policy_packs[].min_version, tools.mcp[].min_version,
  // tools.cli[].min_version, memory.router.min_version. Without a schema
  // pattern, a malformed value (`"latest"`, `"v1.0"`, `"1.0.0-alpha"`)
  // parses to NaN inside the comparator, which maps NaN to 0 (equality)
  // and silently swallows the version floor. Lock the schema rejection
  // explicitly per field so a future refactor that loosens any of the
  // five surfaces breaks loud.
  const REJECTED = ["latest", "v1.0", "1.0.0-alpha", "1.2.3+meta", "1..2", "."];
  const ACCEPTED = ["1", "1.0", "1.0.0", "1.0.0.0", "0.2.0"];

  function withHookMinVersion(value: string): unknown {
    return {
      version: 1,
      hooks: [
        {
          name: "h",
          event: "PreToolUse",
          command: "/usr/bin/true",
          blocking: false,
          min_version: value,
          version_command: ["/usr/bin/true", "--version"],
        },
      ],
    };
  }

  function withPolicyPackMinVersion(value: string): unknown {
    return {
      version: 1,
      policy_packs: [{ name: "branch-protection", min_version: value }],
    };
  }

  function withMcpMinVersion(value: string): unknown {
    return {
      version: 1,
      tools: {
        mcp: [
          {
            name: "x",
            command: "node /tmp/x.js",
            min_version: value,
            version_command: ["node", "--version"],
          },
        ],
      },
    };
  }

  function withCliMinVersion(value: string): unknown {
    return {
      version: 1,
      tools: {
        cli: [
          {
            name: "x",
            binary: "x",
            min_version: value,
            version_command: ["x", "--version"],
          },
        ],
      },
    };
  }

  function withMemoryRouterMinVersion(value: string): unknown {
    return {
      version: 1,
      memory: {
        router: {
          command: ["node", "/tmp/router.js"],
          min_version: value,
          version_command: ["node", "/tmp/router.js", "--version"],
        },
      },
    };
  }

  const surfaces: Array<{ name: string; build: (v: string) => unknown }> = [
    { name: "hooks[]", build: withHookMinVersion },
    { name: "policy_packs[]", build: withPolicyPackMinVersion },
    { name: "tools.mcp[]", build: withMcpMinVersion },
    { name: "tools.cli[]", build: withCliMinVersion },
    { name: "memory.router", build: withMemoryRouterMinVersion },
  ];

  for (const { name, build } of surfaces) {
    for (const bad of REJECTED) {
      it(`rejects ${name}.min_version = ${JSON.stringify(bad)}`, () => {
        expect(() => parseManifest(build(bad))).toThrow(/min_version must be numeric semver/i);
      });
    }
    for (const good of ACCEPTED) {
      it(`accepts ${name}.min_version = ${JSON.stringify(good)}`, () => {
        expect(() => parseManifest(build(good))).not.toThrow();
      });
    }
  }
});

describe("parseManifest — removed Risk Gate vocabulary (task 39c112e0)", () => {
  it("does not validate the contents of a risk or environments block any more: any shape is stripped with a warning", () => {
    const { manifest, warnings } = parseManifestWithWarnings({
      version: 1,
      risk: { safe_deletion_roots: ["/"], degraded_fail_posture: "fail_closed_sometimes", classifiers: [{ severity: "nope" }] },
      environments: { resolvers: [{ name: "unknown" }, { name: "unknown" }] },
    });
    expect(manifest).not.toHaveProperty("risk");
    expect(manifest).not.toHaveProperty("environments");
    expect(warnings.map((w) => w.path)).toEqual(["risk", "environments"]);
  });
});

describe("parseManifest — friendly version-mismatch message (task 50a94127)", () => {
  it("replaces the bare literal error with upgrade guidance for version: 2", () => {
    try {
      parseManifest({ version: 2 });
      expect.unreachable("version: 2 must not parse");
    } catch (err) {
      expectIssueMatching(err, /this CLI supports manifest version 1/);
      expectIssueMatching(err, /your manifest declares version 2/);
      expectIssueMatching(err, /npm i -g @lannguyensi\/harness/);
      // Structure unchanged: still a version-pathed issue, so callers
      // branching on issue paths (and the exit-code mapping) are
      // unaffected.
      const issue = (err as ManifestParseError).issues.find(
        (i) => i.path.length === 1 && i.path[0] === "version",
      );
      expect(issue).toBeDefined();
    }
  });

  it("names the missing-version case instead of suggesting an upgrade", () => {
    try {
      parseManifest({ hooks: [] });
      expect.unreachable("missing version must not parse");
    } catch (err) {
      expectIssueMatching(err, /missing manifest version: add `version: 1`/);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/npm i -g/);
    }
  });

  it("leaves non-version issues untouched (control)", () => {
    try {
      parseManifest({ version: 1, bogus_key: true });
      expect.unreachable("unknown key must not parse");
    } catch (err) {
      expectIssueMatching(err, /bogus_key|unrecognized/i);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/supports manifest version/);
    }
  });
});

describe("parseManifest — version-message variants for non-newer values (task 50a94127 review)", () => {
  it("does not give upgrade advice for a LOWER numeric version", () => {
    try {
      parseManifest({ version: 0 });
      expect.unreachable("version: 0 must not parse");
    } catch (err) {
      expectIssueMatching(err, /unsupported manifest version 0/);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/npm i -g/);
    }
  });

  it("tells a quoted-string version to unquote, not to upgrade", () => {
    try {
      parseManifest({ version: "1" });
      expect.unreachable('version: "1" must not parse');
    } catch (err) {
      expectIssueMatching(err, /unsupported manifest version "1"/);
      expectIssueMatching(err, /unquoted/);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/npm i -g/);
    }
  });

  it("leaves a non-object root's issues untouched (no version rewrite on scalars)", () => {
    try {
      parseManifest("just a string");
      expect.unreachable("scalar root must not parse");
    } catch (err) {
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/supports manifest version/);
    }
  });
});
