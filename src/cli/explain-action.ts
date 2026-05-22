// Phase 7 #2 — `harness explain-action` CLI entrypoint.
//
// Debug verb for the Risk Gate. Reads a tool-event JSON file (the
// Claude Code PreToolUse hook payload shape), builds the Action
// Envelope, and prints it. This is the inspection surface for the
// envelope normalization that Phase 7 #3-#5 build the classifier,
// resolver, and policy evaluator on top of.
//
// File read, JSON guards, and envelope build live in the shared
// `event-input` front end; this module only renders the result.

import { stringify as stringifyYaml } from "yaml";
import type { ActionEnvelope } from "../runtime/index.js";
import { loadEventEnvelope, type EventInputSeams } from "./event-input.js";

export interface ExplainActionOptions extends EventInputSeams {
  /** Path to the tool-event JSON file. */
  eventPath: string;
  /** Emit JSON instead of YAML. */
  json?: boolean;
}

export interface ExplainActionResult {
  output: string;
  envelope: ActionEnvelope;
}

/**
 * Build and render the Action Envelope for a tool-event JSON file.
 *
 * Throws `HarnessExitError(EX_NOINPUT)` when the file is missing, is not
 * valid JSON, or does not decode to a JSON object (see
 * `loadEventEnvelope`). A well-formed but sparse event is accepted.
 */
export function explainAction(opts: ExplainActionOptions): ExplainActionResult {
  const { envelope } = loadEventEnvelope(opts.eventPath, opts, "explain-action");
  const output = opts.json
    ? `${JSON.stringify(envelope, null, 2)}\n`
    : stringifyYaml(envelope, { lineWidth: 0 });
  return { output, envelope };
}
