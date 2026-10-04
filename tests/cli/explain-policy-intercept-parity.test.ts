// Divergence guard (task 7c3919a2): `harness explain-policy` and
// `harness policy intercept` must resolve the same environment for the
// same Bash command, including the leading-prefix idioms (inline
// `VAR=value`, quoted values, several assignments, `cd <path> &&`,
// `git switch <branch> &&`). Before the shared enrichment, explain-policy
// reported `unknown` for a command the hook resolved to `production`.
//
// Each fixture runs through both surfaces with identical seams. The hook's
// verdict is observed as block/allow of a `block`-enforced policy whose
// `when:` needs production; explain-policy's as `applies`. The explicit
// `expectedEnv` pins the resolved name so a drift in BOTH surfaces at once
// also fails.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import type { Manifest, Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Any ledger session opened from explain-policy's code path would go
// through this export; the guard test below asserts it is never reached.
const ledgerSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/policies/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/policies/index.js")>();
  return {
    ...actual,
    openLedgerSession: (...args: unknown[]) => {
      ledgerSpy(...args);
      throw new Error("explain-policy must not open a ledger session");
    },
  };
});

const GATE_PROD: Policy = {
  name: "gate-prod-destructive",
  description: "require approval for destructive production actions",
  trigger: { event: "PreToolUse", match: "Bash" },
  when: {
    "risk.severity_at_least": "high",
    "environment.name": "production",
  },
  requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
  hook: "risk-gate",
  enforcement: "block",
} as Policy;

const manifest: Manifest = makeManifest({
  policies: [GATE_PROD],
  classifiers: [
    {
      name: "dangerous-shell",
      tool: "Bash",
      patterns: [
        {
          pattern: "DROP\\s+TABLE|rm\\s+-rf",
          categories: ["destructive"],
          severity: "critical",
        },
      ],
    },
  ],
  resolvers: [
    {
      name: "production-signals",
      environment: "production",
      signals: {
        branch_patterns: ["main"],
        env_var_patterns: [{ var: "DATABASE_URL", patterns: ["prod"] }],
      },
    },
  ],
});

const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeGitRepo(branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-parity-"));
  fs.mkdirSync(path.join(root, ".git", "refs", "heads", path.dirname(branch)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(
    path.join(root, ".git", "refs", "heads", branch),
    "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeEvent(command: string, cwd: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-parity-ev-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "event.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      session_id: "sess-parity",
      cwd,
    }),
  );
  return file;
}

async function hookBlocks(eventPath: string): Promise<boolean> {
  const chunks: string[] = [];
  const result = await runInterceptCli({
    stdin: Readable.from([fs.readFileSync(eventPath, "utf8")]),
    stdout: new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString("utf8"));
        cb();
      },
    }),
    manifest,
    ledger: emptyLedger,
    env: {},
    kubeContext: "",
    kubeNamespace: "",
  });
  return result.blocked;
}

function explain(eventPath: string) {
  return explainPolicy("gate-prod-destructive", {
    eventPath,
    manifest,
    env: {},
    kubeContext: "",
    kubeNamespace: "",
  }).projection;
}

interface Fixture {
  name: string;
  command: (repos: { prod: string }) => string;
  expectedEnv: "production" | "unknown";
}

const FIXTURES: Fixture[] = [
  {
    name: "no prefix, non-prod cwd",
    command: () => 'psql -c "DROP TABLE users"',
    expectedEnv: "unknown",
  },
  {
    name: "inline dev URL (negative control)",
    command: () =>
      'DATABASE_URL=postgres://u@localhost:5432/app_dev psql -c "DROP TABLE users"',
    expectedEnv: "unknown",
  },
  {
    name: "inline prod URL",
    command: () =>
      'DATABASE_URL=postgres://u@prod-db:5432/app psql -c "DROP TABLE users"',
    expectedEnv: "production",
  },
  {
    name: "inline prod URL, double-quoted value",
    command: () =>
      'DATABASE_URL="postgres://u@prod-db:5432/app" psql -c "DROP TABLE users"',
    expectedEnv: "production",
  },
  {
    name: "inline prod URL, single-quoted value",
    command: () =>
      "DATABASE_URL='postgres://u@prod-db:5432/app' rm -rf /var/lib/appdata",
    expectedEnv: "production",
  },
  {
    name: "several assignments, prod one in the middle",
    command: () =>
      'A=1 DATABASE_URL=postgres://u@prod-db:5432/app B="x y" psql -c "DROP TABLE users"',
    expectedEnv: "production",
  },
  {
    name: "several assignments, later dev value overrides earlier prod",
    command: () =>
      'DATABASE_URL=postgres://u@prod-db:5432/app DATABASE_URL=postgres://u@dev-db:5432/app psql -c "DROP TABLE users"',
    expectedEnv: "unknown",
  },
  {
    name: "cd into a repo on main",
    command: ({ prod }) => `cd ${prod} && rm -rf /var/lib/appdata`,
    expectedEnv: "production",
  },
  {
    name: "git switch main",
    command: () => "git switch main && rm -rf /var/lib/appdata",
    expectedEnv: "production",
  },
];

describe("explain-policy vs policy intercept: same environment resolution", () => {
  it("has at least five fixtures including a quoted prefix and multiple assignments", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
    expect(FIXTURES.some((f) => f.command({ prod: "" }).includes('DATABASE_URL="'))).toBe(true);
    expect(FIXTURES.some((f) => /^A=1 .*B=/.test(f.command({ prod: "" })))).toBe(true);
  });

  for (const fx of FIXTURES) {
    it(`agrees on: ${fx.name}`, async () => {
      const cwd = makeGitRepo("feature/work");
      const prod = makeGitRepo("main");
      const eventPath = writeEvent(fx.command({ prod }), cwd);

      const projection = explain(eventPath);
      const blocked = await hookBlocks(eventPath);

      expect(projection.environment.name).toBe(fx.expectedEnv);
      expect(projection.applies).toBe(fx.expectedEnv === "production");
      // The hook's verdict must match explain-policy's `applies`.
      expect(blocked).toBe(projection.applies);
    });
  }

  it("marks what explain-policy deliberately does not mirror from the hook", () => {
    const cwd = makeGitRepo("feature/work");
    const projection = explain(writeEvent('psql -c "DROP TABLE users"', cwd));
    expect(projection.parity.envelope_enrichment).toEqual([
      "inline_env",
      "cd_git_context",
      "branch_switch_upgrade",
    ]);
    expect(projection.parity.not_evaluated).toEqual(["ledger_requires", "kubectl_target"]);
  });
});

describe("explain-policy stays ledger-free", () => {
  it("never opens a ledger session, even for a gating production fixture", () => {
    ledgerSpy.mockClear();
    const cwd = makeGitRepo("feature/work");
    const projection = explain(
      writeEvent(
        'DATABASE_URL=postgres://u@prod-db:5432/app psql -c "DROP TABLE users"',
        cwd,
      ),
    );
    expect(projection.applies).toBe(true);
    expect(ledgerSpy).not.toHaveBeenCalled();
  });

  it("neither verb-side source imports the ledger or evidence modules", () => {
    for (const rel of [
      "../../src/cli/explain-policy.ts",
      "../../src/cli/policy/risk-envelope-enrichment.ts",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      expect(src).not.toMatch(/from\s+"[^"]*policies\//);
      expect(src).not.toMatch(/ledger-client|openLedgerSession/);
    }
  });
});
