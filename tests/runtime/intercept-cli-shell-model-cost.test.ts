import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { OPAQUE_TARGET_REASON, type LedgerClient } from "../../src/runtime/intercept.js";
import { MAX_NORMALIZE_LENGTH } from "../../src/runtime/command-normalize.js";
import { parseManifest } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Task 7d4abf84: the end-to-end cost of the shell model's attribution at the
// input bound. A command that names one long composed path for thousands of
// gated commands once cost minutes (each command resolved the whole path
// again, step by step, for every per-repo policy), past the hook budget,
// and a hook past its budget is an allow. These shapes run through
// `runInterceptCli` with the FULL_TEMPLATE Bash policies. The bound
// asserted is a third of the shipped hook budget (FULL_TEMPLATE's
// `budget_ms: 15000`), far above the measured cost (well under one
// second on a laptop) and far below the regression (tens of seconds and
// more); the verdicts pin that a path the per-event work budget cannot
// cover fails closed instead of being skipped.

const HOOK_BUDGET_MS = 15_000;
const ASSERTED_BOUND_MS = HOOK_BUDGET_MS / 3;

const policies = parseManifest(parseYaml(FULL_TEMPLATE)).policies.filter(
  (p) => p.trigger.match === "Bash" && p.trigger.bash_match !== undefined,
);

let root = "";
let outer = "";

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-7d4abf84-cost-")));
  outer = path.join(root, "outerrepo");
  for (const [dir, branch] of [
    [outer, "main"],
    [path.join(outer, "vendor", "libplain"), "nbplain"],
  ] as const) {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  }
});

afterAll(() => {
  if (root.length > 0) fs.rmSync(root, { recursive: true, force: true });
});

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

function ledgerWith(tags: readonly string[]): LedgerClient {
  const entries = tags.map((content, i) => ({ id: `e${i}`, content, createdAt: new Date().toISOString() }));
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

/** `prefix`, then `unit` as often as fits, then `tail`, at most `MAX_NORMALIZE_LENGTH` characters. */
function fill(prefix: string, unit: string, tail: string): string {
  const room = MAX_NORMALIZE_LENGTH - 10 - prefix.length - tail.length;
  return prefix + unit.repeat(Math.floor(room / unit.length)) + tail;
}

async function timed(command: string, tags: readonly string[]) {
  const started = performance.now();
  const result = await runInterceptCli({
    stdin: Readable.from([
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        session_id: "sess-7d4abf84-cost",
        cwd: outer,
      }),
    ]),
    stdout: sink(),
    stderr: sink(),
    manifest: makeManifest({ policies }),
    ledger: ledgerWith(tags),
  });
  return { result, ms: performance.now() - started };
}

const OUTER_TAGS = ["preflight:outerrepo", "preflight:main"];

describe("runInterceptCli: the shell model's attribution cost at the input bound (task 7d4abf84)", () => {
  // `a` and `b` do not exist: every step is resolved, and the composed
  // path never names a repository of its own (it resolves into the cwd
  // repository). Within the per-event work budget the verdict is the cwd
  // repository's; past it the policy fails closed.
  const SHAPES: Array<{ label: string; command: () => string; failsClosed: boolean }> = [
    {
      label: "a 2000-step composed path, then git log until the bound (past the work budget)",
      command: () => fill("cd -P a && cd b && ".repeat(1000), "git log && ", "git log"),
      failsClosed: true,
    },
    {
      label: "a 400-step composed path, then git log until the bound",
      command: () => fill("cd -P a && cd b && ".repeat(200), "git log && ", "git log"),
      failsClosed: false,
    },
    {
      label: "a 1000-step composed path, then 1001 git log (20k characters)",
      command: () => "cd -P a && cd b && ".repeat(500) + "git log && ".repeat(1000) + "git log",
      failsClosed: false,
    },
    {
      label: "a 2-step composed path, then git log until the bound",
      command: () => fill("cd -P a && cd b && ", "git log && ", "git log"),
      failsClosed: false,
    },
    {
      label: "a path that grows by one step per git log (past the work budget)",
      command: () => fill("", "cd -P a && git log && cd b && git log && ", "git log"),
      failsClosed: true,
    },
    {
      label: "a distinct git -C directory per command until the bound (past the work budget)",
      command: () => {
        let s = "";
        for (let i = 0; s.length < MAX_NORMALIZE_LENGTH - 40; i++) s += `git -C d${i} log; `;
        return `${s}git log`;
      },
      failsClosed: true,
    },
  ];

  for (const shape of SHAPES) {
    it(`${shape.label}: decided within a third of the hook budget`, { timeout: 120_000 }, async () => {
      const command = shape.command();
      expect(command.length).toBeLessThanOrEqual(MAX_NORMALIZE_LENGTH);
      const { result, ms } = await timed(command, OUTER_TAGS);
      expect(ms).toBeLessThan(ASSERTED_BOUND_MS);
      const own = result.decisions.filter((d) => d.policyName === "preflight-before-investigation");
      if (shape.failsClosed) {
        // The per-event work budget cannot cover these paths: fail closed.
        expect(own.map((d) => d.reason)).toEqual([OPAQUE_TARGET_REASON]);
        expect(result.blocked).toBe(true);
      } else {
        expect(own.map((d) => [d.ledgerTag, d.outcome])).toEqual([["preflight:outerrepo", "allow"]]);
        expect(result.blocked).toBe(false);
      }
    });
  }
});
