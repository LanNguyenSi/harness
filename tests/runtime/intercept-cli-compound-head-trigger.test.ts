import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { MAX_NORMALIZE_LENGTH } from "../../src/runtime/command-normalize.js";
import {
  OPAQUE_TARGET_REASON,
  UNPARSED_COMMAND_REASON,
  type LedgerClient,
  type PolicyDecision,
} from "../../src/runtime/intercept.js";
import { pendingApprovalPath } from "../../src/runtime/pending-approval.js";
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
  { label: "arithmetic for, do without separator", command: (v) => `for ((i=0;i<1;i++)) do ${v}; done` },
  { label: "arithmetic for, multi-line do", command: (v) => `for ((i=0;i<1;i++))\ndo ${v}\ndone` },
  { label: "arithmetic for, brace body", command: (v) => `for ((;;)) { ${v}; break; }` },
  { label: "for without in, do", command: (v) => `for x do ${v}; done` },
  { label: "for without in, brace body", command: (v) => `for x { ${v}; }` },
  { label: "arithmetic command before a brace group", command: (v) => `((1)) && { ${v}; }` },
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
  // BSD xargs options that take a value as the next word.
  { label: "xargs -J %", command: (v) => `echo x | xargs -J % ${v}` },
  { label: "xargs -R 1 -I %", command: (v) => `echo x | xargs -R 1 -I % ${v}` },
  { label: "xargs -S 255 -I %", command: (v) => `echo x | xargs -S 255 -I % ${v}` },
  { label: "xargs -E END", command: (v) => `echo x | xargs -E END ${v}` },
  { label: "xargs -s 100", command: (v) => `echo x | xargs -s 100 ${v}` },
  { label: "xargs by path", command: (v) => `echo x | /usr/bin/xargs ${v}` },
  { label: "env by path in a brace group", command: (v) => `{ /usr/bin/env ${v}; }` },
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

  // A command the shell model cannot lex hides whether a gated verb runs:
  // bash runs the complete lines before a syntax error on a later line, and
  // a compound head nested past the model's bounds hides the verb from the
  // text arms. Every bash_match policy the text arms missed is refused for
  // it, under its own enforcement, with no ledger query.
  describe.each(RUNTIMES)("%s PreToolUse event: a command the gate cannot parse is refused", (runtime) => {
    const UNPARSED: ReadonlyArray<{ label: string; command: (v: string) => string }> = [
      { label: "stray ) on a later line", command: (v) => `{ ${v}; }\n)` },
      { label: "unterminated quote on a later line", command: (v) => `${"! "}${v}\necho "x` },
      { label: "if nested past the compound bound", command: (v) => `${"if true; then ".repeat(40)}${v};${" fi".repeat(40)}` },
      {
        label: "subshells nested past the nesting bound",
        command: (v) => `${"( ".repeat(12)}if true; then ${v}; fi${" )".repeat(12)}`,
      },
      { label: "eval nested past the eval bound", command: (v) => `eval eval eval eval '${v}'` },
      { label: "eval string with a syntax error on a later line", command: (v) => `eval '${v}\necho "x'` },
    ];
    const CASES = UNPARSED.flatMap(({ label, command }) =>
      VERBS.map(({ verb, policy }) => ({ label, verb, policy, command: command(verb) })),
    );

    it.each(CASES)("$label, $verb: refused as unclassifiable", async ({ policy, command }) => {
      const block = await decide(runtime, command, "block");
      const d = block.decisions.find((x) => x.policyName === policy);
      expect(d?.reason, JSON.stringify(command)).toBe(UNPARSED_COMMAND_REASON);
      expect(d?.outcome).toBe("deny");
      expect(block.blocked).toBe(true);
      const warn = await decide(runtime, command, "warn");
      expect(warn.decisions.find((x) => x.policyName === policy)?.outcome).toBe("warn");
    });

    it("every policy the text arms missed is refused, even with no gated verb in the text", async () => {
      const { decisions, blocked } = await decide(runtime, 'echo "unterminated', "block");
      expect(decisions.map((d) => d.policyName).sort()).toEqual(VERBS.map((v) => v.policy).sort());
      expect(decisions.every((d) => d.reason === UNPARSED_COMMAND_REASON && d.outcome === "deny")).toBe(true);
      expect(blocked).toBe(true);
    });

    it("a syntax error of exactly MAX_NORMALIZE_LENGTH characters is refused, one character more is not", async () => {
      const head = 'echo "unterminated ';
      const atBound = head + "x".repeat(MAX_NORMALIZE_LENGTH - head.length);
      expect(atBound.length).toBe(MAX_NORMALIZE_LENGTH);
      const refused = await decide(runtime, atBound, "block");
      expect(refused.decisions.map((d) => d.policyName).sort()).toEqual(VERBS.map((v) => v.policy).sort());
      expect(refused.decisions.every((d) => d.reason === UNPARSED_COMMAND_REASON)).toBe(true);
      const past = await decide(runtime, `${atBound}x`, "block");
      expect(past.decisions).toEqual([]);
      expect(past.blocked).toBe(false);
    });

    it("above MAX_NORMALIZE_LENGTH the documented raw-only matching stays (no refusal)", async () => {
      const command = `{ git push origin main; }; ${"echo hi; ".repeat(Math.ceil(MAX_NORMALIZE_LENGTH / 9))}`;
      expect(command.length).toBeGreaterThan(MAX_NORMALIZE_LENGTH);
      const { decisions } = await decide(runtime, command, "block");
      expect(decisions).toEqual([]);
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

// The FULL_TEMPLATE `bash_match` policies, every one of which declares a
// `ux:` remedy (`Run: harness record ...`) and `producers:`.
const FULL_BASH = parseManifest(parseYaml(FULL_TEMPLATE)).policies.filter((p) => p.trigger.bash_match !== undefined);

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        buf += String(chunk);
        cb();
      },
    }),
    text: () => buf,
  };
}

async function hook(
  runtime: Runtime,
  command: string,
  policies: Policy[],
  cwd: string = repo,
): Promise<{ stdout: string; stderr: string; blocked: boolean; decisions: PolicyDecision[] }> {
  const out = capture();
  const err = capture();
  const result = await runInterceptCli({
    stdin: Readable.from([JSON.stringify(eventFor(runtime, command, cwd))]),
    stdout: out.stream,
    stderr: err.stream,
    manifest: makeManifest({ policies }),
    ledger: emptyLedger,
    generatedDir,
    verbose: false,
  });
  return { stdout: out.text(), stderr: err.text(), blocked: result.blocked, decisions: result.decisions };
}

describe("the agent envelope of a refusal names its cause, not the policy's evidence remedy (task d11762ce)", () => {
  describe.each(RUNTIMES)("%s PreToolUse event", (runtime) => {
    const UNPARSED_COMMANDS = [
      'git commit -m "it is unterminated',
      "{ git push origin main; }\n)",
      `${"if true; then ".repeat(40)}npm publish;${" fi".repeat(40)}`,
      "eval eval eval eval 'gh pr merge 1'",
    ];

    it.each(UNPARSED_COMMANDS)("%j: the hook stdout carries the parse failure, not a ux `Run:` remedy", async (command) => {
      const r = await hook(runtime, command, FULL_BASH);
      expect(r.blocked).toBe(true);
      expect(r.decisions.some((d) => d.refusal === "unparsed")).toBe(true);
      const envelope = JSON.parse(r.stdout) as {
        reason: string;
        hookSpecificOutput: { permissionDecisionReason: string };
      };
      for (const reason of [envelope.reason, envelope.hookSpecificOutput.permissionDecisionReason]) {
        expect(reason).toContain(UNPARSED_COMMAND_REASON);
        expect(reason).toContain("Fix the syntax or flatten the nesting");
        expect(reason).not.toContain("Run:");
        expect(reason).not.toContain("To satisfy");
        expect(reason).not.toContain("harness record");
        // Every refused policy is named in the one envelope.
        for (const d of r.decisions.filter((x) => x.refusal === "unparsed")) expect(reason).toContain(d.policyName);
      }
      // One operator line on stderr, naming the parse failure.
      expect(r.stderr.match(/unparsed command:/g)).toHaveLength(1);
      expect(r.stderr).toContain(UNPARSED_COMMAND_REASON);
    });

    it("a warn refusal renders no envelope and still writes the one stderr line", async () => {
      const warn = FULL_BASH.map((p) => ({ ...p, enforcement: "warn" }) as Policy);
      const r = await hook(runtime, 'echo "unterminated', warn);
      expect(r.blocked).toBe(false);
      expect(r.stdout).toBe("");
      expect(r.decisions.every((d) => d.outcome === "warn" && d.refusal === "unparsed")).toBe(true);
      expect(r.stderr.match(/unparsed command:/g)).toHaveLength(1);
      expect(r.stderr).toContain(UNPARSED_COMMAND_REASON);
    });

    it("a command that parses gets no unparsed stderr line, and the ux remedy as before", async () => {
      const r = await hook(runtime, "{ gh pr merge 1; }", FULL_BASH);
      expect(r.blocked).toBe(true);
      expect(r.stderr).not.toContain("unparsed command:");
      expect(JSON.parse(r.stdout).reason).toContain("Run:");
    });

    it("an unattributable target refusal names its own cause, not the ux remedy", async () => {
      const r = await hook(runtime, "git -C `pwd` push origin main", FULL_BASH);
      expect(r.blocked).toBe(true);
      const refused = r.decisions.find((d) => d.policyName === "preflight-before-push");
      expect(refused?.refusal).toBe("opaque-target");
      const reason = JSON.parse(r.stdout).reason as string;
      expect(reason).toContain(OPAQUE_TARGET_REASON);
      expect(reason).not.toContain("Run:");
      expect(r.stderr).not.toContain("unparsed command:");
    });

    it("a require_approval refusal stages no pending approval (no approval tag is read for it)", async () => {
      const approval = FULL_BASH.map((p) => ({ ...p, enforcement: "require_approval" }) as Policy);
      const marker = pendingApprovalPath(generatedDir);
      fs.rmSync(marker, { force: true });
      const refused = await hook(runtime, 'echo "unterminated', approval);
      expect(refused.blocked).toBe(true);
      expect(refused.decisions.every((d) => d.outcome === "require_approval" && d.refusal === "unparsed")).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      // Control: the same policies stage it for a command that parses.
      const parsed = await hook(runtime, "gh pr merge 1", approval);
      expect(parsed.blocked).toBe(true);
      expect(fs.existsSync(marker)).toBe(true);
      fs.rmSync(marker, { force: true });
    });
  });
});

// Structural parity: a compound spelling of a command reaches every policy
// the bare command reaches, whatever wrapper option grammar the text
// normalisers read, because the trigger is also tested against the
// normalisations of the command's own head text.
describe("a compound spelling reaches every policy its bare command reaches (task d11762ce)", () => {
  const BARE = [
    "sudo --user root git push origin main",
    "sudo -E -u root git push origin main",
    "doas -u root git push origin main",
    "nice --adjustment=5 git push origin main",
    "nice -n 5 -- git push origin main",
    "nice -10 npm publish",
    "timeout --kill-after 5 10 git push origin main",
    "timeout -s KILL 5 gh pr merge 1",
    "nohup nice -n 5 git push origin main",
    "command -p git push origin main",
    "env -u X git push origin main",
    "env -u CLAUDE_SESSION_ID true",
    "/usr/bin/env git push origin main",
    "CLAUDE_SESSION_ID= ",
    "A=1 B=2 git push origin main",
    "git -c core.x=y push origin main",
    "git -C . log",
    "harness pause",
    "npx harness resume",
  ];
  const WRAP: ReadonlyArray<{ label: string; command: (b: string) => string }> = [
    { label: "brace group", command: (b) => `{ ${b}; }` },
    { label: "if-then", command: (b) => `if true; then ${b}; fi` },
    { label: "bang", command: (b) => `! ${b}` },
  ];

  describe.each(RUNTIMES)("%s PreToolUse event", (runtime) => {
    it.each(BARE)("%j", async (bare) => {
      const control = await hook(runtime, bare, FULL_BASH);
      const gated = control.decisions.filter((d) => d.outcome !== "allow");
      expect(gated.length, `the bare ${JSON.stringify(bare)} is gated`).toBeGreaterThan(0);
      for (const { label, command } of WRAP) {
        const form = await hook(runtime, command(bare), FULL_BASH);
        for (const d of gated) {
          expect(
            form.decisions.find((x) => x.policyName === d.policyName)?.outcome,
            `${label} ${JSON.stringify(command(bare))}: ${d.policyName}`,
          ).toBe(d.outcome);
        }
        expect(form.blocked).toBe(control.blocked);
      }
    });
  });
});
