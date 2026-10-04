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

import * as fs from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import type { ActionEnvelope, ToolEvent } from "../runtime/index.js";
import { parseBashPrefix } from "../runtime/bash-prefix-parse.js";
import { parseManifest, type Manifest } from "../schema/index.js";
import { enrichLoadedEvent, type EnrichmentSeams } from "./enriched-event.js";
import { loadEventEnvelope, type EventInputSeams } from "./event-input.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "./loader.js";
import { readBashCommand } from "./policy/risk-envelope-enrichment.js";

export interface ExplainActionOptions extends EventInputSeams, EnrichmentSeams, LoaderOptions {
  /** Inject the resolved manifest (tests); bypasses `loadManifest`. */
  manifest?: Manifest;
  /** Path to the tool-event JSON file. */
  eventPath: string;
  /** Emit JSON instead of YAML. */
  json?: boolean;
}

export interface ExplainActionResult {
  output: string;
  envelope: ActionEnvelope;
}

function manifestFor(event: ToolEvent, opts: ExplainActionOptions): Manifest {
  if (opts.manifest) return opts.manifest;
  const command = event.tool_name === "Bash" ? readBashCommand(event.tool_input) : null;
  const branchTarget = command === null ? null : parseBashPrefix(command).branchTarget;
  if (branchTarget === null) return parseManifest({ version: 1 });
  // With no `--config` and no manifest at the default location there are no
  // resolvers, so the branch-switch upgrade is a no-op: use the empty
  // manifest, as for any other command. An explicit `--config` that is
  // missing, and a manifest that is invalid, still fail loudly.
  if (opts.configPath === undefined && !fs.existsSync(resolvePaths(opts).base)) {
    return parseManifest({ version: 1 });
  }
  return loadManifest(opts).manifest;
}

/**
 * Build and render the Action Envelope for a tool-event JSON file.
 *
 * Throws `HarnessExitError(EX_NOINPUT)` when the file is missing, is not
 * valid JSON, or does not decode to a JSON object (see
 * `loadEventEnvelope`). A well-formed but sparse event is accepted.
 */
export function explainAction(opts: ExplainActionOptions): ExplainActionResult {
  const loaded = loadEventEnvelope(opts.eventPath, opts, "explain-action");
  // Print the envelope the hook builds: after its Bash-prefix enrichment
  // (leading `cd`, `git switch|checkout`; task 8b891e83). The manifest is
  // consulted only by the branch-switch upgrade (it compares what the
  // resolvers say for the two branches), so it is loaded only for a
  // command with a leading `git switch|checkout`; every other event, and a
  // machine with no manifest at the default location, keeps working with
  // the empty manifest, as before.
  const { envelope } = enrichLoadedEvent(loaded, manifestFor(loaded.event, opts), opts);
  const output = opts.json
    ? `${JSON.stringify(envelope, null, 2)}\n`
    : stringifyYaml(envelope, { lineWidth: 0 });
  return { output, envelope };
}
