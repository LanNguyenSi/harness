// Phase 7 #2 — `harness explain-action` CLI entrypoint.
//
// Debug verb for the Risk Gate. Reads a tool-event JSON file (the
// Claude Code PreToolUse hook payload shape), builds the Action
// Envelope, and prints it. This is the inspection surface for the
// envelope normalization that Phase 7 #3-#5 build the classifier,
// resolver, and policy evaluator on top of.
//
// The wrapper does the I/O — file read, git/host/user/now resolution —
// and hands a pure `EnvelopeContext` to `buildActionEnvelope`.

import * as fs from "node:fs";
import * as os from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  buildActionEnvelope,
  resolveGitContext,
  type ActionEnvelope,
  type GitRepoContext,
  type ToolEvent,
} from "../runtime/index.js";
import { EX_NOINPUT, HarnessExitError } from "./exit-codes.js";

export interface ExplainActionOptions {
  /** Path to the tool-event JSON file. */
  eventPath: string;
  /** Emit JSON instead of YAML. */
  json?: boolean;
  // --- test seams: all default to the real, non-deterministic source ---
  /** Override the envelope timestamp. */
  now?: Date;
  /** Override the resolved host name. */
  host?: string;
  /** Override the resolved OS user. */
  user?: string;
  /** Override git-context resolution. */
  resolveGit?: (cwd: string) => GitRepoContext;
  /** Override the cwd fallback used when the event omits `cwd`. */
  cwdFallback?: string;
}

export interface ExplainActionResult {
  output: string;
  envelope: ActionEnvelope;
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

function safeHost(): string {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

/**
 * Build and render the Action Envelope for a tool-event JSON file.
 *
 * Throws `HarnessExitError(EX_NOINPUT)` when the file is missing, is not
 * valid JSON, or does not decode to a JSON object. A well-formed but
 * sparse event (e.g. `{}`) is accepted: the envelope builder fills
 * absent fields with empty values rather than throwing.
 */
export function explainAction(opts: ExplainActionOptions): ExplainActionResult {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.eventPath, "utf8");
  } catch {
    throw new HarnessExitError(
      `explain-action: event file not found or unreadable: ${opts.eventPath}`,
      EX_NOINPUT,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HarnessExitError(
      `explain-action: malformed event JSON in ${opts.eventPath}: ${(err as Error).message}`,
      EX_NOINPUT,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const got =
      parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new HarnessExitError(
      `explain-action: event JSON must be an object, got ${got}`,
      EX_NOINPUT,
    );
  }
  const event = parsed as ToolEvent;

  const fallbackCwd = opts.cwdFallback ?? process.cwd();
  const cwd =
    typeof event.cwd === "string" && event.cwd.length > 0
      ? event.cwd
      : fallbackCwd;
  const resolveGit = opts.resolveGit ?? resolveGitContext;

  const envelope = buildActionEnvelope(event, {
    cwd,
    git: resolveGit(cwd),
    user: opts.user ?? safeUser(),
    host: opts.host ?? safeHost(),
    now: opts.now ?? new Date(),
  });

  const output = opts.json
    ? `${JSON.stringify(envelope, null, 2)}\n`
    : stringifyYaml(envelope, { lineWidth: 0 });

  return { output, envelope };
}
