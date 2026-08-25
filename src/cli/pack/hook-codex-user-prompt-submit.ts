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
//
// Two short-circuits happen before any manifest/mode logic runs, both
// producing the same "no stdout, no injection" outcome:
//
//   1. Pause sentinel (task 63fefe3a): honoured the same way every other
//      pack hook honours it (`checkHookPause`, mirrored from
//      `hook-pre-tool-use.ts`) — an active, unexpired
//      `harness pause` must silence this injector exactly like it silences
//      the PreToolUse/PostToolUse gates. Checked BEFORE manifest load so a
//      broken install still respects an active pause.
//   2. No real user input (task 63fefe3a, corrected same task after an
//      advisor review caught the first cut fail-closed): a notification
//      turn — subagent completion, a Monitor event, a background-bash
//      finishing — carries no operator text, and injecting the full
//      instruction block on it is pure noise (and, per the pack's own
//      contract, prompts the agent to write a fresh Understanding Report
//      against nothing). BUT the module's own documented envelope
//      (`{ session_id?, prompt? }` above) is unverified against a real
//      Codex payload: the generated `config.toml` header for every other
//      Codex hook documents the wire shape as `{ session_id?, tool_name?,
//      raw_input?, event? }` — no `prompt` field at all — and the sibling
//      hooks (`hook-codex-pre-tool-use.ts` etc.) never trust a single
//      field name, they alias-tolerate (`tool`/`tool_name`,
//      `raw_input`/`tool_input`) via `pickString`. So this check is
//      FAIL-OPEN-TO-INJECT: it only suppresses when a recognized
//      prompt-carrying field is POSITIVELY present and empty. A missing
//      field, an unrecognized envelope shape, or unparsable stdin is not
//      evidence of "no user input" — it is evidence the real Codex wire
//      format is not what this module assumed, and the safe default in
//      that case is the pre-task-63fefe3a behavior: inject. See
//      `hasRealUserPrompt` below.

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

/**
 * Field names that could plausibly carry the operator's actual prompt
 * text on a Codex UserPromptSubmit envelope. `prompt` is this module's
 * own documented guess; the others are tolerated the same way the
 * sibling Codex hooks tolerate `tool`/`tool_name` and
 * `raw_input`/`tool_input` — a real integration may use a different
 * name than the one this package assumed. None of this is confirmed
 * against a real Codex payload (see module header); the alias list only
 * WIDENS which fields can prove a real prompt, it never narrows what
 * counts as "unknown, so inject".
 */
const REAL_PROMPT_FIELD_ALIASES = [
  "prompt",
  "text",
  "input",
  "message",
  "user_prompt",
  "user_input",
] as const;

/**
 * True when the UserPromptSubmit envelope should trigger injection.
 *
 * FAIL-OPEN TO INJECT: this only returns `false` (suppress) when a
 * recognized prompt-carrying field (see `REAL_PROMPT_FIELD_ALIASES`) is
 * POSITIVELY present on the parsed envelope and is empty or
 * whitespace-only — a real signal that the sender explicitly marked
 * this turn as carrying no operator text. Everything else defaults to
 * `true` (inject, i.e. the pre-task-63fefe3a behavior):
 *
 *   - unparsable / non-JSON stdin,
 *   - a parsed value that is not an object,
 *   - an object that carries none of the known aliases at all (this is
 *     the documented `{ session_id?, tool_name?, raw_input?, event? }`
 *     shape from the generated config.toml header — no prompt field by
 *     design, not evidence of a notification turn),
 *   - an alias present but holding a non-string value.
 *
 * An envelope harness cannot parse, or cannot recognize, is not
 * evidence that there was no real user input; it is evidence this
 * module's assumption about the wire format was wrong, and the correct
 * failure direction for a governance-adjacent injector is to keep
 * injecting, not to go silently dark.
 */
export function hasRealUserPrompt(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return true;
  const obj = parsed as Record<string, unknown>;
  for (const key of REAL_PROMPT_FIELD_ALIASES) {
    const value = obj[key];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
  }
  return true;
}

export async function runPackHookCodexUserPromptSubmitCli(
  opts: PackHookCodexUserPromptSubmitOptions = {},
): Promise<PackHookCodexUserPromptSubmitResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin).catch(() => "");

  // Pause sentinel — operator-only kill switch. Honoured BEFORE manifest
  // load, same ordering as every other pack hook (see module header).
  if (checkHookPause("codex-user-prompt-submit", stderr, opts, opts.generatedDir, opts.now).paused) {
    return { exitCode: 0, emitted: false, text: "" };
  }

  // No real user input on this turn: nothing to react to, so nothing to
  // inject. See `hasRealUserPrompt` above.
  if (!hasRealUserPrompt(raw)) {
    stderr.write(
      "harness pack hook codex-user-prompt-submit: no real user prompt on this turn, suppressing injection.\n",
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
