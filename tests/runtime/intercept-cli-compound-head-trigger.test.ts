import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import type { LedgerClient, PolicyDecision } from "../../src/runtime/intercept.js";
import { parseManifest, type Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Task d11762ce: a gated verb written inside a compound command (`{ V; }`,
// `if ...; then V; fi`, `! V`, `xargs V`, a loop body, a wrapper the text
// normalisers do not peel) used to match no `bash_match` policy at all, so
// the call ran ungated. Each form must reach the policy the bare verb
// reaches, with the bare verb's outcome, through both runtime shapes the
// one `harness policy intercept` entrypoint serves: the Claude Code
// PreToolUse event (`Bash`, `tool_input.command`, `cwd`) and the Codex one
// (`exec_command`, `raw_input.cmd`, `raw_input.workdir`, no `cwd`).

/** Gated verb -> the FULL_TEMPLATE policy its bare spelling reaches. */
const VERBS: ReadonlyArray<{ verb: string; policy: string }> = [
  { verb: "git push origin main", policy: "preflight-before-push" },
  { verb: "gh pr merge 1", policy: "review-before-merge-bash" },
  { verb: "npm publish", policy: "dogfood-before-release" },
  { verb: "harness pause", policy: "deny-kill-switch-bypass" },
  { verb: "env -u CLAUDE_SESSION_ID true", policy: "deny-session-env-strip" },
];

/** Compound and wrapper spellings of one gated verb `V`. */
const FORMS: ReadonlyArray<{ label: string; command: (v: string) => string }> = [
  { label: "brace group", command: (v) => `{ ${v}; }` },
  { label: "multi-line brace group", command: (v) => `{\n${v}\n}` },
  { label: "subshell", command: (v) => `( ${v} )` },
  { label: "if-then", command: (v) => `if true; then ${v}; fi` },
  { label: "if-then multi-line", command: (v) => `if true\nthen ${v}\nfi` },
  { label: "if-else", command: (v) => `if false; then :; else ${v}; fi` },
  { label: "if-cd condition", command: (v) => `if cd .; then ${v}; fi` },
  { label: "verb as if condition", command: (v) => `if ${v}; then :; fi` },
  { label: "while-do", command: (v) => `while true; do ${v}; done` },
  { label: "until-do", command: (v) => `until false; do ${v}; done` },
  { label: "verb as while condition", command: (v) => `while ${v}; do :; done` },
  { label: "for-do", command: (v) => `for i in 1; do ${v}; done` },
  { label: "case arm", command: (v) => `case a in a) ${v};; esac` },
  { label: "function body", command: (v) => `f() { ${v}; }; f` },
  { label: "bang", command: (v) => `! ${v}` },
  { label: "bang brace group", command: (v) => `! { ${v}; }` },
  { label: "brace group after &&", command: (v) => `true && { ${v}; }` },
  { label: "xargs", command: (v) => `xargs ${v}` },
  { label: "xargs -I{} in a pipeline", command: (v) => `echo x | xargs -I{} ${v}` },
  { label: "xargs -I {}", command: (v) => `echo x | xargs -I {} ${v}` },
  { label: "xargs -0 -n 1 -P2", command: (v) => `printf 'x\\0' | xargs -0 -n 1 -P2 ${v}` },
  { label: "xargs clustered -rn1", command: (v) => `echo x | xargs -rn1 ${v}` },
  { label: "xargs --max-args=1", command: (v) => `echo x | xargs --max-args=1 -- ${v}` },
  { label: "time", command: (v) => `time ${v}` },
  { label: "time -p", command: (v) => `time -p ${v}` },
  { label: "nohup", command: (v) => `nohup ${v}` },
  { label: "env", command: (v) => `env ${v}` },
  { label: "command", command: (v) => `command ${v}` },
  { label: "exec", command: (v) => `exec ${v}` },
  { label: "coproc", command: (v) => `coproc ${v}` },
  { label: "nohup env xargs chain", command: (v) => `nohup env A=1 xargs ${v}` },
];

const RUNTIMES = ["claude", "codex"] as const;
type Runtime = (typeof RUNTIMES)[number];

function templatePolicies(enforcement: "block" | "warn"): Policy[] {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  return VERBS.map(({ policy: name }) => {
    const policy = parsed.policies.find((p) => p.name === name);
    if (policy === undefined) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
    return { ...policy, enforcement } as Policy;
  });
}

const POLICIES = { block: templatePolicies("block"), warn: templatePolicies("warn") };

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

let root = "";
let repo = "";
let outside = "";
let generatedDir = "";

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-d11762ce-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  outside = path.join(root, "plain");
  fs.mkdirSync(outside, { recursive: true });
  generatedDir = path.join(root, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
});

afterAll(() => {
  if (root.length > 0) fs.rmSync(root, { recursive: true, force: true });
});

function eventFor(runtime: Runtime, command: string, cwd: string): Record<string, unknown> {
  if (runtime === "claude") {
    return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "sess-d117", cwd };
  }
  return {
    hook_event_name: "PreToolUse",
    tool_name: "exec_command",
    raw_input: { cmd: command, workdir: cwd },
    session_id: "sess-d117",
  };
}

async function decide(
  runtime: Runtime,
  command: string,
  enforcement: "block" | "warn",
  cwd: string = repo,
): Promise<{ blocked: boolean; decisions: PolicyDecision[] }> {
  const result = await runInterceptCli({
    stdin: Readable.from([JSON.stringify(eventFor(runtime, command, cwd))]),
    stdout: sink(),
    stderr: sink(),
    manifest: makeManifest({ policies: POLICIES[enforcement] }),
    ledger: emptyLedger,
    generatedDir,
  });
  return { blocked: result.blocked, decisions: result.decisions };
}

function outcomeOf(decisions: readonly PolicyDecision[], policy: string): string | undefined {
  return decisions.find((d) => d.policyName === policy)?.outcome;
}

describe("compound-command heads reach the bare verb's bash_match policy (task d11762ce)", () => {
  describe.each(RUNTIMES)("%s PreToolUse event", (runtime) => {
    it("controls: every bare verb is gated (deny under block, warn under warn)", async () => {
      for (const { verb, policy } of VERBS) {
        const block = await decide(runtime, verb, "block");
        expect(outcomeOf(block.decisions, policy), `${verb} under block`).toBe("deny");
        expect(block.blocked).toBe(true);
        const warn = await decide(runtime, verb, "warn");
        expect(outcomeOf(warn.decisions, policy), `${verb} under warn`).not.toBe("allow");
        expect(outcomeOf(warn.decisions, policy), `${verb} under warn`).not.toBeUndefined();
      }
    });

    const CASES = FORMS.flatMap(({ label, command }) =>
      VERBS.map(({ verb, policy }) => ({ label, verb, policy, command: command(verb) })),
    );

    it.each(CASES)("$label, $verb: same policy and outcome as the bare verb", async ({ verb, policy, command }) => {
      for (const enforcement of ["block", "warn"] as const) {
        const bare = await decide(runtime, verb, enforcement);
        const form = await decide(runtime, command, enforcement);
        expect(outcomeOf(form.decisions, policy), `${JSON.stringify(command)} under ${enforcement}`).toBe(
          outcomeOf(bare.decisions, policy),
        );
        expect(form.blocked, `${JSON.stringify(command)} under ${enforcement}`).toBe(bare.blocked);
      }
    });

    it("from a directory outside every repository the per-repo push gate still denies the compound forms", async () => {
      for (const { command } of FORMS) {
        const bare = await decide(runtime, "git push origin main", "block", outside);
        expect(outcomeOf(bare.decisions, "preflight-before-push")).toBe("deny");
        const form = await decide(runtime, command("git push origin main"), "block", outside);
        expect(outcomeOf(form.decisions, "preflight-before-push"), JSON.stringify(command("git push"))).toBe("deny");
      }
    });
  });

  it("a gated word that is only an argument, or heredoc data, still reaches no policy", async () => {
    for (const command of [
      "echo { git push origin main; }",
      "grep -r 'harness pause' docs",
      "cat <<'EOF'\n{ git push origin main; }\nEOF",
      "printf '%s\\n' 'if true; then npm publish; fi'",
    ]) {
      const { decisions } = await decide("claude", command, "block");
      expect(decisions, JSON.stringify(command)).toEqual([]);
    }
  });
});
