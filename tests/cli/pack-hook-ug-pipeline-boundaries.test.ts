// Pipeline stage boundaries through the understanding-gate PreToolUse hooks
// (tracker task 25c56a0f). `isReadOnlyBashPipeline` used to cut the command
// at EVERY `|`, so a `|` inside a quote, after a backslash or inside an
// expansion turned one write into fragments that each looked read-only and
// the gate allowed it without an approved report. Each construct below is
// run through both the Claude Code and the Codex hook; every row in
// `FORMERLY_ALLOWED` was allowed by the hooks before the scan was quote- and
// expansion-aware (measured against the base commit by the differential
// recorded with the task).

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-pipeline-boundaries-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function manifestWithPack(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
  });
}

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

interface HookVerdict {
  blocked: boolean;
  stderr: string;
}

async function runClaude(command: string): Promise<HookVerdict> {
  const stdout = bufferStream();
  const stderr = bufferStream();
  const result = await runPackHookPreToolUseCli({
    manifest: manifestWithPack(),
    stdin: readableFromString(
      JSON.stringify({
        session_id: "sess-1",
        tool_name: "Bash",
        tool_input: { command },
      }),
    ),
    stdout: stdout.stream,
    stderr: stderr.stream,
    reportsDir: path.join(tmp, "no-reports"),
    generatedDir: path.join(tmp, "harness.generated"),
    ledgerQuery: async (): Promise<LedgerEntry[]> => [],
  });
  return { blocked: result.blocked, stderr: stderr.read() };
}

async function runCodex(command: string): Promise<HookVerdict> {
  const stderr = bufferStream();
  const result = await runPackHookCodexPreToolUseCli({
    manifest: manifestWithPack(),
    stdin: readableFromString(
      JSON.stringify({
        session_id: "sess-codex",
        tool_name: "Bash",
        raw_input: { command },
      }),
    ),
    stderr: stderr.stream,
    reportsDir: path.join(tmp, "no-reports"),
    generatedDir: path.join(tmp, "harness.generated"),
    ledgerQuery: async (): Promise<LedgerEntry[]> => [],
  });
  return { blocked: result.blocked, stderr: stderr.read() };
}

const RUNTIMES: ReadonlyArray<readonly [string, (c: string) => Promise<HookVerdict>]> = [
  ["claude", runClaude],
  ["codex", runCodex],
];

// A real write whose only `|` sits inside one word. Cut at that `|` the text
// becomes two read-only-looking fragments (`find <dir> -name 'a` and
// `cat -x' -delete`), which is why the hooks used to allow it.
const FORMERLY_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["single quote", "find d -name 'a|cat -x' -delete"],
  ["double quote", 'find d -name "a|cat -x" -delete'],
  ["backslash escape", "find d -name a\\|cat -delete"],
  ["parameter expansion ${..}", "find d -name ${x//a|cat -x} -delete"],
  ["arithmetic bracket $[..]", "find d -name $[1|cat -x] -delete"],
  ["ANSI-C quote $'..'", "find d -name $'a|cat -x' -delete"],
  ["locale double quote $\"..\"", 'find d -name $"a|cat -x" -delete'],
  ["extglob group @(..)", "find d -name @(a|cat -x) -delete"],
  ["double-quoted ${..}", 'find d -name "${x//a|cat -x}" -delete'],
  ["unterminated single quote", "find d -name 'a|cat -x -delete"],
  ["unterminated double quote", 'find d -name "a|cat -x -delete'],
  ["unbalanced ${", "find d -name ${x//a|cat -x -delete"],
  ["quoted pipe as a middle stage", "cat x | find d -name 'a|cat -x' -delete | head"],
  ["quoted pipe as the last stage", "cat x | find d -name 'a|cat -x' -delete"],
  ["ANSI-C run with an escaped quote", "find d -name $'a\\'|cat -x' -delete"],
  // A quote or expansion nested in another one: the inner opener must be
  // read inside the outer construct, otherwise the quote that follows closes
  // the wrong run and exposes the `|` as a boundary. The five rows with a
  // quote or `${..}` reach a stub `find` as a single word holding the `|` under
  // both bash 3.2.57 and zsh 5.9 (measured); the `$[` row is a bad
  // substitution under bash and one word under zsh.
  ["$' inside double quotes is a literal", "find d \"$'\" '\"| cat '\\' -delete"],
  ["${..} opened inside double quotes", 'find d -name "${x:-"a|cat -x"}" -delete'],
  ["$[..] opened inside double quotes", 'find d -name "$["1|cat -x"]" -delete'],
  ["single quotes inside ${..}", "find d -name ${x:-'}|cat -x'}\\' -delete"],
  ["double quotes inside ${..}", "find d -name ${x:-\"}|cat -x\"}'\"'\\' -delete"],
  ["ANSI-C quote inside ${..}", "find d -name ${x:-$'\\'}|cat -x'}\\' -delete"],
  // zsh executes code from these without any `$(`, backtick or write token.
  ["zsh glob qualifier e.'..'. in a pipeline", "cat *(e.'touch pwned'.) | head"],
  ["zsh glob qualifier e:'..': alone", "ls *(e:'touch pwned':)"],
  ["zsh process substitution =(..) in a pipeline", "cat =(touch pwned) | head"],
  ["zsh glob qualifier +func", "cat *(+touch) | head"],
];

// Still refused up front, before any scan (unchanged by the scan).
const STILL_BLOCKED: ReadonlyArray<readonly [string, string]> = [
  ["command substitution", "find d -name $(echo a|cat -x) -delete"],
  ["backtick substitution", "find d -name `echo a|cat -x` -delete"],
  ["a write stage", "git status | tee out"],
  ["a real boundary before a write", "cat x | find d -delete"],
];

// Real stage boundaries stay allowed: nothing here has a `|` that is not an
// operator.
const STILL_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["plain pipeline", "gh pr checks 123 | head"],
  ["three stages", "cat a | grep x | head"],
  ["no spaces around the pipe", "ls|head"],
  ["no pipe at all", "git status"],
  ["quotes without a pipe", "cat 'a b' | head"],
  ["double quotes without a pipe", 'cat "a b" | head'],
  ["escaped space", "cat a\\ b | head"],
  ["plain variable", "cat $HOME/x | head"],
  ["escaped parentheses", "find . \\( -name a \\) | head"],
  ["quoted parentheses", "grep '(x)' f | head"],
  ["double-quoted parentheses", 'grep "(x)" f | head'],
];

describe.each(RUNTIMES)("understanding-gate %s hook: a `|` that is not a stage boundary", (runtime, run) => {
  it.each(FORMERLY_ALLOWED)(`blocks (${runtime}): %s`, async (_label, command) => {
    const verdict = await run(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.stderr).not.toMatch(/read-only Bash command, allowing/);
  });

  it.each(STILL_BLOCKED)(`keeps blocking (${runtime}): %s`, async (_label, command) => {
    const verdict = await run(command);
    expect(verdict.blocked).toBe(true);
  });

  it.each(STILL_ALLOWED)(`keeps allowing (${runtime}): %s`, async (_label, command) => {
    const verdict = await run(command);
    expect(verdict.blocked).toBe(false);
    expect(verdict.stderr).toMatch(/read-only Bash command, allowing/);
  });
});
