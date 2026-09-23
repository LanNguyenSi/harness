// Phase 6 #6 — `harness pack hook codex-user-prompt-submit` runtime verb.
//
// Codex variant of the Understanding-Gate UserPromptSubmit injector.
// The Claude Code adapter delegates to `@lannguyensi/understanding-gate`'s
// `understanding-gate-claude-hook` bin (the npm package owns the
// instruction template). The Codex adapter mirrors that contract here:
// reads the upstream prompt JSON on stdin, writes a system-style
// instruction block on stdout as developer context before the agent runs.
//
// Wire format on stdin: Codex invokes this hook for an operator prompt.
// The adapter deliberately does not inspect the envelope to infer which
// kind of turn caused it. The hook event itself is the protocol boundary:
// if Codex invokes UserPromptSubmit, inject the instruction block.
//
// stdout: a plain-text developer-context instruction block (no JSON wrapper).
// The block is identical across modes for v1; finer-grained per-mode
// templating is an upstream-package concern.
//
// Failure mode: any error → exit 0, no stdout, diagnostic on stderr.
// A missing injector text must never fail the agent's prompt path.
//
// One short-circuit happens before any manifest/mode logic runs,
// producing "no stdout, no injection":
//
//   1. Pause sentinel (task 63fefe3a): honoured the same way every other
//      pack hook honours it (`checkHookPause`, mirrored from
//      `hook-pre-tool-use.ts`), an active, unexpired
//      `harness pause` must silence this injector exactly like it silences
//      the PreToolUse/PostToolUse gates. Checked BEFORE manifest load so a
//      broken install still respects an active pause.

import { type Mode, resolveMode } from "../../policy-packs/builtin/understanding-before-execution.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { checkHookPause, loadManifestOrInjected, readStdin } from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookCodexUserPromptSubmitOptions extends LoaderOptions {
  pack?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
  /** Test-injected generatedDir for the pause-sentinel check; bypasses
   *  path resolution when supplied (mirrors `hook-pre-tool-use.ts`). */
  generatedDir?: string;
  /** Override "now" for deterministic pause-expiry tests. Forwarded to
   *  `checkHookPause` / `checkPauseFromLoader`. */
  now?: Date;
}

export interface PackHookCodexUserPromptSubmitResult {
  exitCode: number;
  emitted: boolean;
  /** The exact text written to stdout (empty when not emitted). */
  text: string;
}

export function buildInstructionBlock(mode: Mode): string {
  // Self-contained instruction text. The richer template owned by
  // @lannguyensi/understanding-gate is a Claude-specific surface; the
  // Codex variant ships a sibling block that names the same artefacts
  // (Understanding Report, .understanding-gate/reports/) so the agent's
  // expected output is byte-shaped to land in the persisted-report
  // directory the Codex stop-hook captures into.
  const base = [
    "## Understanding Gate (mode: " + mode + ")",
    "",
    "Before you call any write-capable tool (apply_patch, Bash/shell, file edits),",
    "produce an *Understanding Report* with these fields:",
    "",
    "- **interpretation**: one paragraph explaining what you understand the task to be.",
    "- **assumptions**: bullet list of assumptions you are making about scope, environment, intent.",
    "- **openQuestions**: bullet list of things you still need clarification on.",
    "- **outOfScope**: bullet list of things you will explicitly NOT do.",
    "- **risks**: bullet list of failure modes / things that could go wrong.",
    "- **verificationPlan**: how you will know whether the change worked.",
    "",
    "Wait for explicit human approval before invoking apply_patch, Bash, or shell tools.",
    "Approval is recorded by the operator running `harness approve understanding`.",
    "",
    "If you are unsure whether the gate applies, ask. Do not pre-emptively edit.",
  ].join("\n");
  return base + "\n";
}

export async function runPackHookCodexUserPromptSubmitCli(
  opts: PackHookCodexUserPromptSubmitOptions = {},
): Promise<PackHookCodexUserPromptSubmitResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  await readStdin(stdin).catch(() => "");

  // Pause sentinel, operator-only kill switch. Honoured BEFORE manifest
  // load, same ordering as every other pack hook (see module header).
  if (checkHookPause("codex-user-prompt-submit", stderr, opts, opts.generatedDir, opts.now).paused) {
    stderr.write(
      "harness pack hook codex-user-prompt-submit: harness paused, skipping injection.\n",
    );
    return { exitCode: 0, emitted: false, text: "" };
  }

  let manifest: Manifest;
  try {
    ({ manifest } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    stderr.write(
      `harness pack hook codex-user-prompt-submit: manifest load failed (${
        (err as Error).message
      }), suppressing injection.\n`,
    );
    return { exitCode: 0, emitted: false, text: "" };
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared || !declared.enabled) {
    stderr.write(
      `harness pack hook codex-user-prompt-submit: pack "${packName}" not enabled, suppressing injection.\n`,
    );
    return { exitCode: 0, emitted: false, text: "" };
  }

  const { mode, warning } = resolveMode(declared);
  if (warning) stderr.write(`${warning}\n`);
  const text = buildInstructionBlock(mode);
  stdout.write(text);
  return { exitCode: 0, emitted: true, text };
}
