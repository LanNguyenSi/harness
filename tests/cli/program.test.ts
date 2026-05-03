import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

async function exec(argv: string[]): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, code };
}

describe("CLI program — validate command", () => {
  it("returns 0 with success message on the reference manifest happy path", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-program-validate-"));
    try {
      fs.writeFileSync(
        path.join(home, "harness.yaml"),
        `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read, Edit, Write, Bash, Agent, Skill, TaskCreate, Glob, Grep]
`,
        "utf8",
      );
      const r = await exec(["validate", "--config", path.join(home, "harness.yaml")]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/no validation findings/);
      expect(r.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns 1 and prints diagnostics to stderr when an invalid fixture is supplied", async () => {
    const r = await exec([
      "validate",
      "--config",
      path.resolve(REPO_ROOT, "docs/examples/invalid/03-policy-undeclared-variable.yaml"),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PR_NUMBER/);
    expect(r.stdout).toBe("");
  });
});

describe("CLI program — --version + --help", () => {
  it("--version writes 0.6.0 to stdout and returns 0 with no stderr noise", async () => {
    const r = await exec(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("0.6.0");
    expect(r.stderr).toBe("");
  });

  it("--help writes the help banner to stdout and returns 0 with no stderr noise", async () => {
    const r = await exec(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stderr).toBe("");
  });

  it("an unknown top-level option exits 64 (EX_USAGE) with no duplicated message", async () => {
    const r = await exec(["--bogus-flag"]);
    expect(r.code).toBe(64);
    // Commander writes the human-readable error itself; our exitOverride
    // throws HarnessExitError("", EX_USAGE) so run()'s catch does NOT
    // re-print on top. Asserts a single non-blank stderr line that came
    // from Commander, not from us.
    const lines = r.stderr.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/unknown option/i);
  });

  it("an unknown subcommand exits 64 with a single Commander-sourced stderr line", async () => {
    const r = await exec(["unknown-cmd"]);
    expect(r.code).toBe(64);
    const lines = r.stderr.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/unknown command/i);
  });
});

describe("CLI program — list + explain commands", () => {
  it("list mcp emits a name-keyed table on stdout", async () => {
    const r = await exec(["list", "mcp", "--config", FULL_MANIFEST]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/codebase-oracle/);
    expect(r.stdout).toMatch(/agent-tasks/);
  });

  it("list policies --json emits a parseable JSON array", async () => {
    const r = await exec(["list", "policies", "--config", FULL_MANIFEST, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("review-before-merge");
  });

  it("list with an unknown category exits 64", async () => {
    const r = await exec(["list", "bogus", "--config", FULL_MANIFEST]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown list category/i);
  });

  it("explain on a known policy exits 0 with structured YAML", async () => {
    const r = await exec(["explain", "review-before-merge", "--config", FULL_MANIFEST]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^name: review-before-merge/);
  });

  it("explain on an unknown policy exits 64 and lists available", async () => {
    const r = await exec(["explain", "nope", "--config", FULL_MANIFEST]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/no policy named "nope"/);
    expect(r.stderr).toMatch(/review-before-merge/);
  });
});

describe("CLI program — audit command", () => {
  it("rejects an invalid --since duration with EX_USAGE", async () => {
    const r = await exec([
      "audit",
      "--since",
      "yesterday",
      "--config",
      FULL_MANIFEST,
    ]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/--since/);
  });
});

describe("CLI program — doctor command", () => {
  it("prints the Appendix D structure on stdout and returns 0 in --shallow mode", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-program-doctor-"));
    try {
      fs.writeFileSync(
        path.join(home, "harness.yaml"),
        `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read]
`,
        "utf8",
      );
      const r = await exec([
        "doctor",
        "--config",
        path.join(home, "harness.yaml"),
        "--shallow",
      ]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^harness 0\.4\.0/);
      expect(r.stdout).toContain("Manifest");
      expect(r.stdout).toContain("Tools");
      expect(r.stdout).toContain("Memory");
      expect(r.stdout).toContain("Hooks");
      expect(r.stdout).toContain("Policies");
      expect(r.stdout).toContain("Summary");
      expect(r.stdout).toContain("[shallow]");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI program — describe command", () => {
  it("returns 0 and writes YAML on success", async () => {
    const r = await exec(["describe", "--config", FULL_MANIFEST]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^version: 1\n/);
  });

  it("emits JSON when --json is set", async () => {
    const r = await exec(["describe", "--config", FULL_MANIFEST, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.version).toBe(1);
  });

  it("rejects an unknown --pillar value with EX_USAGE", async () => {
    const r = await exec(["describe", "--config", FULL_MANIFEST, "--pillar", "nope"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown pillar/i);
  });

  it("returns EX_NOINPUT when the manifest file is missing", async () => {
    const r = await exec(["describe", "--config", "/nonexistent/harness.yaml"]);
    expect(r.code).toBe(66);
    expect(r.stderr).toMatch(/not found/);
  });

  it("supports filtering to one pillar", async () => {
    const r = await exec([
      "describe",
      "--config",
      FULL_MANIFEST,
      "--pillar",
      "hooks",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\nhooks:\n/);
    expect(r.stdout).not.toMatch(/\ntools:\n/);
  });
});

describe("CLI program — apply --quiet / --json", () => {
  async function withTmpManifest(
    fn: (homeDir: string) => Promise<void>,
  ): Promise<void> {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-apply-cli-"));
    try {
      fs.writeFileSync(
        path.join(home, "harness.yaml"),
        `version: 1
hooks:
  - { name: h, event: SessionStart, command: /h.sh, blocking: false, budget_ms: 30000 }
policies: []
tools:
  builtin: { known: [] }
memory:
  directories: []
`,
      );
      await fn(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it("default apply prints the Next-steps hint", async () => {
    await withTmpManifest(async (home) => {
      const r = await exec([
        "apply",
        "--config",
        `${home}/harness.yaml`,
      ]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("applied 2 file(s)");
      expect(r.stdout).toContain("Next steps to wire into Claude Code:");
      // Regression for the 2026-05-03 hallucination incident: an agent
      // suggested `claude -p ... --output-dir`, a flag that does not exist.
      // The hint must not contain it.
      expect(r.stdout).not.toContain("--output-dir");
    });
  });

  it("--quiet suppresses the Next-steps hint but keeps the summary", async () => {
    await withTmpManifest(async (home) => {
      const r = await exec([
        "apply",
        "--config",
        `${home}/harness.yaml`,
        "--quiet",
      ]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("applied 2 file(s)");
      expect(r.stdout).not.toContain("Next steps to wire into Claude Code:");
    });
  });

  it("--json emits machine-readable JSON with no prose tail", async () => {
    await withTmpManifest(async (home) => {
      const r = await exec([
        "apply",
        "--config",
        `${home}/harness.yaml`,
        "--json",
      ]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("Next steps to wire into Claude Code:");
      expect(r.stdout).not.toContain("applied 2 file(s)");
      const parsed = JSON.parse(r.stdout);
      expect(parsed.outcome).toBe("applied");
      expect(parsed.files).toBeDefined();
      expect(parsed.lockPath).toBeDefined();
    });
  });

  it("--json on target-exists-refuse exits non-zero with JSON outcome", async () => {
    await withTmpManifest(async (home) => {
      const fs = await import("node:fs");
      const target = `${home}/settings.local.json`;
      fs.writeFileSync(target, "{}");
      const r = await exec([
        "apply",
        "--config",
        `${home}/harness.yaml`,
        "--target",
        target,
        "--json",
      ]);
      expect(r.code).not.toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.outcome).toBe("target-exists-refuse");
    });
  });

  it("with --target the Next-steps hint collapses to a verify line that includes --settings", async () => {
    await withTmpManifest(async (home) => {
      const target = `${home}/settings.local.json`;
      const r = await exec([
        "apply",
        "--config",
        `${home}/harness.yaml`,
        "--target",
        target,
      ]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`wired into ${target}`);
      // Regression: a non-canonical target (e.g. /tmp/...) is not picked up
      // by Claude Code's settings discovery, so the verify hint must
      // include `--settings <target>` explicitly.
      expect(r.stdout).toContain(`--settings ${target}`);
      expect(r.stdout).not.toContain("Next steps to wire into Claude Code:");
    });
  });

  it("--target --json: JSON includes targetWritten:true and stdout has no prose", async () => {
    await withTmpManifest(async (home) => {
      const target = `${home}/settings.local.json`;
      const r = await exec([
        "apply",
        "--config",
        `${home}/harness.yaml`,
        "--target",
        target,
        "--json",
      ]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.outcome).toBe("applied");
      expect(parsed.targetWritten).toBe(true);
      expect(parsed.targetPath).toBe(target);
      expect(r.stdout).not.toContain("wired into");
    });
  });
});
