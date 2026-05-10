// Phase 6 #6 — `harness pack hook codex-user-prompt-submit` runtime verb.
//
// Codex variant of the Understanding-Gate UserPromptSubmit injector.
// The Claude Code adapter delegates to `@lannguyensi/understanding-gate`'s
// `understanding-gate-claude-hook` bin (the npm package owns the
// instruction template). The Codex adapter mirrors that contract here:
// reads the upstream prompt JSON on stdin, writes a system-style
// instruction block on stdout that Codex will prepend to its system
// prompt before the agent runs.
//
// Wire format on stdin (envelope harness publishes; Codex CLI
// integration wraps its native event into this shape):
//
//   { session_id?: string, prompt?: string }
//
// stdout: a plain-text instruction block (no JSON wrapper) that Codex
// concatenates into `additional_instructions`. The block is identical
// across modes for v1; finer-grained per-mode templating is an
// upstream-package concern.
//
// Failure mode: any error → exit 0, no stdout, diagnostic on stderr.
// A missing injector text must never fail the agent's prompt path.

import { type Mode, resolveMode } from "../../policy-packs/builtin/understanding-before-execution.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookCodexUserPromptSubmitOptions extends LoaderOptions {
  pack?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
}

export interface PackHookCodexUserPromptSubmitResult {
  exitCode: number;
  emitted: boolean;
  /** The exact text written to stdout (empty when not emitted). */
  text: string;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", (err) => reject(err));
  });
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

  // Drain stdin so the parent isn't blocked. We don't actually need any
  // field from it for v1 — the instruction block is prompt-independent.
  await readStdin(stdin).catch(() => "");

  let manifest: Manifest;
  try {
    manifest = opts.manifest ?? loadManifest(opts).manifest;
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
