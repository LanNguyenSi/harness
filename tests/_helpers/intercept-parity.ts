// Shared fixtures for hook-side tests of `harness policy intercept`: one
// manifest, one leading-prefix fixture corpus, and the hook-side observation
// (block/allow of a `block`-enforced policy whose `when:` needs production).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import type { Manifest, Policy } from "../../src/schema/index.js";
import { makeManifest } from "./manifest.js";
import { addGitDirSkeleton } from "./git-dir-fixture.js";

export const GATE_PROD: Policy = {
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

export const manifest: Manifest = makeManifest({
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

export const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

let cleanups: Array<() => void> = [];
/** Remove every temp dir the helpers created; call from `afterEach`. */
export function runParityCleanups(): void {
  for (const c of cleanups) c();
  cleanups = [];
}

export function makeGitRepo(branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-parity-"));
  fs.mkdirSync(path.join(root, ".git", "refs", "heads", path.dirname(branch)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  addGitDirSkeleton(path.join(root, ".git"));
  fs.writeFileSync(
    path.join(root, ".git", "refs", "heads", branch),
    "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function writeEvent(command: string, cwd: string): string {
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

export async function hookBlocks(
  eventPath: string,
  over: { manifest?: Manifest; kubeContext?: string } = {},
): Promise<boolean> {
  const chunks: string[] = [];
  const result = await runInterceptCli({
    stdin: Readable.from([fs.readFileSync(eventPath, "utf8")]),
    stdout: new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString("utf8"));
        cb();
      },
    }),
    manifest: over.manifest ?? manifest,
    ledger: emptyLedger,
    env: {},
    kubeContext: over.kubeContext ?? "",
    kubeNamespace: "",
  });
  return result.blocked;
}

export interface Fixture {
  name: string;
  command: (repos: { prod: string }) => string;
  expectedEnv: "production" | "unknown";
}

export const FIXTURES: Fixture[] = [
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

