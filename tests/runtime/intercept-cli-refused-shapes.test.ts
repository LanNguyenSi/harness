import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import {
  OPAQUE_TARGET_REASON,
  unparsedCommandReason,
  type LedgerClient,
  type PolicyDecision,
} from "../../src/runtime/intercept.js";
import { REFUSAL_CONSTRUCTS, type RefusalKind } from "../../src/runtime/shell-command-model.js";
import { parseManifest, type Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";
import {
  BENIGN_ROWS,
  CDPATH_ROWS,
  DYNAMIC_TARGET_ROWS,
  MODEL_ARM_ROWS,
  RESOLVED_TARGET_ROWS,
  SHARED_ROWS,
  SOLE_ROWS,
  STACK_INDEX_PATH_ROWS,
  STEERED_ROWS,
  UNLEXABLE_BRACE_ROWS,
} from "../fixtures/shell-model-refusals/rows.js";

// Task 9238cc27: a command line the shell command model refuses fails closed
// for a per-repository `bash_match` policy, under both runtime event shapes,
// even when the ledger holds the evidence of every repository of the world;
// a directory-search row fails closed as an opaque target; the benign rows are decided
// on attributed evidence as before. The real `preflight-before-push` policy
// of FULL_TEMPLATE runs from an outer repository with a nested one at
// `vendor/libplain`.

const POLICY = "preflight-before-push";

function pushPolicy(enforcement: "block" | "warn"): Policy {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === POLICY);
  if (policy === undefined) throw new Error(`${POLICY} missing from FULL_TEMPLATE`);
  return { ...policy, enforcement } as Policy;
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

function ledgerWith(tags: readonly string[]): LedgerClient {
  const entries = tags.map((tag, i) => ({ id: `e${i}`, content: `${tag} ev`, createdAt: new Date().toISOString() }));
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

const OUTER_ONLY = ["preflight:main"];
const EVERY_REPO = ["preflight:main", "preflight:nbplain"];

let root = "";
let outer = "";

function makeRepo(dir: string, branch: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-9238cc27-")));
  outer = path.join(root, "outerrepo");
  makeRepo(outer, "main");
  makeRepo(path.join(outer, "vendor", "libplain"), "nbplain");
});

afterAll(() => {
  if (root.length > 0) fs.rmSync(root, { recursive: true, force: true });
});

type Runtime = "claude" | "codex";

async function decide(
  command: string,
  tags: readonly string[],
  runtime: Runtime,
  enforcement: "block" | "warn" = "block",
): Promise<{ blocked: boolean; decisions: PolicyDecision[] }> {
  const event =
    runtime === "codex"
      ? { hook_event_name: "PreToolUse", tool_name: "exec_command", raw_input: { cmd: command, workdir: outer }, session_id: "s" }
      : { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s", cwd: outer };
  const result = await runInterceptCli({
    stdin: Readable.from([JSON.stringify(event)]),
    stdout: sink(),
    stderr: sink(),
    manifest: makeManifest({ policies: [pushPolicy(enforcement)] }),
    ledger: ledgerWith(tags),
  });
  return { blocked: result.blocked, decisions: result.decisions.filter((d) => d.policyName === POLICY) };
}

const RUNTIMES: Runtime[] = ["claude", "codex"];

const REFUSED: Array<{ command: string; kind: RefusalKind }> = [
  ...(Object.entries(SOLE_ROWS) as Array<[RefusalKind, readonly string[]]>).flatMap(([kind, rows]) =>
    rows.map((command) => ({ command, kind })),
  ),
  ...SHARED_ROWS.map(({ command, first }) => ({ command, kind: first })),
  ...UNLEXABLE_BRACE_ROWS.map((command) => ({ command, kind: "command-word-brace" as RefusalKind })),
  ...MODEL_ARM_ROWS,
];

describe("runInterceptCli: a command line the shell command model refuses fails closed (task 9238cc27)", () => {
  for (const runtime of RUNTIMES) {
    it(`denies every refused row with the refused construct named (${runtime}), with outer-only and with every repository's evidence`, async () => {
      // Every row the gate does not deny this way, with how it decided, listed in full on a failure.
      const problems: string[] = [];
      for (const { command, kind } of REFUSED) {
        for (const [ledger, tags] of [["outer-only", OUTER_ONLY], ["every-repo", EVERY_REPO]] as const) {
          const { blocked, decisions } = await decide(command, tags, runtime);
          const denied =
            blocked &&
            decisions.length === 1 &&
            decisions[0]!.outcome === "deny" &&
            decisions[0]!.reason === unparsedCommandReason(REFUSAL_CONSTRUCTS[kind]) &&
            decisions[0]!.ledgerTag.startsWith("(unparsed command: ");
          if (!denied) {
            const seen = decisions.map((d) => `${d.ledgerTag}=${d.outcome}`).join(", ");
            problems.push(`[${kind}] ${ledger} ${blocked ? "blocked" : "ALLOWED"} {${seen}} ${command}`);
          }
        }
      }
      expect(problems).toEqual([]);
    }, 30_000);
  }

  it("warns instead of denying under a warn policy", async () => {
    const { blocked, decisions } = await decide(SOLE_ROWS["case-fall-through"][0]!, OUTER_ONLY, "claude", "warn");
    expect(blocked).toBe(false);
    expect(decisions.map((d) => d.outcome)).toEqual(["warn"]);
  });

  it("names the construct and tells the agent to split the command", () => {
    const text = unparsedCommandReason(REFUSAL_CONSTRUCTS.coproc);
    expect(text).toContain(REFUSAL_CONSTRUCTS.coproc);
    expect(text).toContain("Split it into separate commands");
  });

  for (const runtime of RUNTIMES) {
    it(`fails closed on every directory-search row as an opaque target (${runtime})`, async () => {
      for (const command of CDPATH_ROWS) {
        const { blocked, decisions } = await decide(command, EVERY_REPO, runtime);
        expect(blocked, command).toBe(true);
        expect(decisions.map((d) => d.reason), command).toEqual([OPAQUE_TARGET_REASON]);
      }
    }, 30_000);
  }

  for (const runtime of RUNTIMES) {
    it(`never refuses a benign row, and allows the plainly placed ones on their evidence (${runtime})`, async () => {
      for (const command of BENIGN_ROWS) {
        const { decisions } = await decide(command, EVERY_REPO, runtime);
        for (const d of decisions) expect(d.ledgerTag, command).not.toMatch(/^\(unparsed command/);
      }
      for (const command of [
        "arr=(a b c); git push origin main",
        "[[ -n x && ( -n y || -n z ) ]] && git push origin main",
        "(( x * (1 + 1) )) && git push origin main",
        'echo "CDPATH note"; cd vendor/libplain; git push origin main',
        "case $x in (a) cd vendor/libplain;; (b) cd vendor;; esac; git push origin main",
        "if [[ -f x ]]; then cd vendor/libplain; else cd vendor; fi; git push origin main",
      ]) {
        const { blocked, decisions } = await decide(command, EVERY_REPO, runtime);
        expect(blocked, command).toBe(false);
        expect(decisions.length, command).toBeGreaterThan(0);
      }
      // A row that runs in the working directory only needs its evidence.
      const { blocked } = await decide("arr=(a b c); git push origin main", OUTER_ONLY, runtime);
      expect(blocked).toBe(false);
    }, 30_000);
  }
});

// Task e927e903: a directory that depends on a value the shell command model
// cannot resolve (a dynamic `cd` / `pushd` / `git -C` / `env -C` target, a
// `HOME` or `OLDPWD` the line assigns before a directory change reads it, a
// `cd` stack index bash reads as a path) fails closed as an opaque target
// for a per-repository policy, under both runtime event shapes, whatever the
// ledger holds; the controls stay decided on attributed evidence.
describe("runInterceptCli: a directory target that depends on an unresolved value fails closed (task e927e903)", () => {
  const UNRESOLVED = [...DYNAMIC_TARGET_ROWS, ...STEERED_ROWS, ...STACK_INDEX_PATH_ROWS];

  for (const runtime of RUNTIMES) {
    it(`denies every row as an opaque target (${runtime}), with outer-only and with every repository's evidence`, async () => {
      // Every row the gate does not deny this way, with how it decided, listed in full on a failure.
      const problems: string[] = [];
      for (const command of UNRESOLVED) {
        for (const [ledger, tags] of [["outer-only", OUTER_ONLY], ["every-repo", EVERY_REPO]] as const) {
          const { blocked, decisions } = await decide(command, tags, runtime);
          const denied =
            blocked &&
            decisions.length === 1 &&
            decisions[0]!.outcome === "deny" &&
            decisions[0]!.reason === OPAQUE_TARGET_REASON &&
            decisions[0]!.ledgerTag.startsWith("(opaque target");
          if (!denied) {
            const seen = decisions.map((d) => `${d.ledgerTag}=${d.outcome}`).join(", ");
            problems.push(`${ledger} ${blocked ? "blocked" : "ALLOWED"} {${seen}} ${command}`);
          }
        }
      }
      expect(problems).toEqual([]);
    }, 60_000);
  }

  it("names the unresolved value in the reason", async () => {
    const { decisions } = await decide(DYNAMIC_TARGET_ROWS[0]!, OUTER_ONLY, "claude");
    expect(decisions.map((d) => d.reason)).toEqual([OPAQUE_TARGET_REASON]);
    expect(OPAQUE_TARGET_REASON).toContain("a directory that depends on a value the gate cannot resolve");
  });

  for (const runtime of RUNTIMES) {
    it(`keeps the controls attributed: allowed on every repository's evidence, never an opaque target (${runtime})`, async () => {
      const problems: string[] = [];
      for (const command of RESOLVED_TARGET_ROWS) {
        const { blocked, decisions } = await decide(command, EVERY_REPO, runtime);
        if (blocked || decisions.length === 0 || decisions.some((d) => d.reason === OPAQUE_TARGET_REASON)) {
          const seen = decisions.map((d) => `${d.ledgerTag}=${d.outcome}`).join(", ");
          problems.push(`${blocked ? "blocked" : "allowed"} {${seen}} ${command}`);
        }
      }
      expect(problems).toEqual([]);
      // A literal nested target still demands the nested repository's evidence.
      expect((await decide(RESOLVED_TARGET_ROWS[0]!, OUTER_ONLY, runtime)).blocked).toBe(true);
      // The home directory keeps the working directory's evidence when the
      // line assigns nothing a directory change reads.
      for (const command of ["cd; git push origin main", "HOME=/tmp true; cd; git push origin main"]) {
        expect((await decide(command, OUTER_ONLY, runtime)).blocked, command).toBe(false);
      }
    }, 30_000);
  }
});
