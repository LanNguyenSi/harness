// Shared tool-event input handling for the Risk Gate debug verbs
// (`harness explain-action`, `harness test-risk`).
//
// Both verbs take a tool-event JSON file path, apply the same
// not-found / malformed / non-object guards, resolve the same ambient
// `EnvelopeContext` (git, host, user, now), and build the Action
// Envelope. This module is that shared front end so the two verbs stay
// byte-identical in how they read and normalize their input.

import * as fs from "node:fs";
import * as os from "node:os";
import {
  buildActionEnvelope,
  resolveGitContext,
  type ActionEnvelope,
  type GitRepoContext,
  type ToolEvent,
} from "../runtime/index.js";
import { EX_NOINPUT, HarnessExitError } from "./exit-codes.js";

/** Injectable seams so callers (and tests) can make resolution deterministic. */
export interface EventInputSeams {
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

export interface LoadedEvent {
  event: ToolEvent;
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
 * Read a tool-event JSON file and build its Action Envelope.
 *
 * Throws `HarnessExitError(EX_NOINPUT)` when the file is missing, is not
 * valid JSON, or does not decode to a JSON object. A well-formed but
 * sparse event (e.g. `{}`) is accepted: the envelope builder fills
 * absent fields with empty values rather than throwing. `verb` only
 * prefixes the error messages so the operator sees which command failed.
 */
export function loadEventEnvelope(
  eventPath: string,
  seams: EventInputSeams = {},
  verb = "explain-action",
): LoadedEvent {
  let raw: string;
  try {
    raw = fs.readFileSync(eventPath, "utf8");
  } catch {
    throw new HarnessExitError(
      `${verb}: event file not found or unreadable: ${eventPath}`,
      EX_NOINPUT,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HarnessExitError(
      `${verb}: malformed event JSON in ${eventPath}: ${(err as Error).message}`,
      EX_NOINPUT,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const got =
      parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new HarnessExitError(
      `${verb}: event JSON must be an object, got ${got}`,
      EX_NOINPUT,
    );
  }
  const event = parsed as ToolEvent;

  const fallbackCwd = seams.cwdFallback ?? process.cwd();
  const cwd =
    typeof event.cwd === "string" && event.cwd.length > 0
      ? event.cwd
      : fallbackCwd;
  const resolveGit = seams.resolveGit ?? resolveGitContext;

  const envelope = buildActionEnvelope(event, {
    cwd,
    git: resolveGit(cwd),
    user: seams.user ?? safeUser(),
    host: seams.host ?? safeHost(),
    now: seams.now ?? new Date(),
  });

  return { event, envelope };
}
