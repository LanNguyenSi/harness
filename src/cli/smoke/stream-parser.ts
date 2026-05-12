// Phase 7 follow-up: `harness smoke` stream-json parser.
//
// `claude -p --output-format stream-json --include-hook-events` emits a
// JSONL stream where each line is one of:
//
//   { type: "system",  subtype: "init",          ... }   // session start
//   { type: "system",  subtype: "hook_started",  ... }   // hook begins
//   { type: "system",  subtype: "hook_response", ... }   // hook returns
//   { type: "assistant", message: {...},         ... }   // model reply chunk
//   { type: "result",  subtype: "success",       ... }   // terminal
//
// This module classifies those lines into a structured summary that the
// assertion engine can probe without re-reading the stream. Unknown event
// shapes are kept in `unrecognised` (capped) so a future Claude Code
// release that adds new subtypes does not silently swallow regressions.

export interface InitEvent {
  type: "system";
  subtype: "init";
  session_id?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

export interface HookStartedEvent {
  type: "system";
  subtype: "hook_started";
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface HookResponseEvent {
  type: "system";
  subtype: "hook_response";
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  session_id?: string;
  result?: string;
  [key: string]: unknown;
}

export interface HookPair {
  hookId: string;
  hookName: string;
  hookEvent: string;
  started: HookStartedEvent;
  response: HookResponseEvent | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outcome: string | null;
}

export interface StreamSummary {
  init: InitEvent | null;
  hooks: HookPair[];
  result: ResultEvent | null;
  totalLines: number;
  malformedLines: number;
  /** Up to 20 unrecognised event shapes (truncated past that to bound memory). */
  unrecognised: Array<{ type?: string; subtype?: string }>;
}

const UNRECOGNISED_CAP = 20;

export function parseStreamJsonl(text: string): StreamSummary {
  const summary: StreamSummary = {
    init: null,
    hooks: [],
    result: null,
    totalLines: 0,
    malformedLines: 0,
    unrecognised: [],
  };

  const pending = new Map<string, HookStartedEvent>();

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    summary.totalLines += 1;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      summary.malformedLines += 1;
      continue;
    }

    const type = msg.type;
    const subtype = msg.subtype;

    if (type === "system" && subtype === "init") {
      summary.init = msg as InitEvent;
      continue;
    }

    if (type === "system" && subtype === "hook_started") {
      const ev = msg as HookStartedEvent;
      if (typeof ev.hook_id === "string") {
        pending.set(ev.hook_id, ev);
      }
      continue;
    }

    if (type === "system" && subtype === "hook_response") {
      const ev = msg as HookResponseEvent;
      const hookId = typeof ev.hook_id === "string" ? ev.hook_id : "";
      const started = pending.get(hookId);
      // Some hook_responses arrive without a matching hook_started in the
      // same stream (e.g. session-resume edge cases). Synthesise a minimal
      // started shell so the pair is still consumable by assertions.
      const startedFallback: HookStartedEvent = started ?? {
        type: "system",
        subtype: "hook_started",
        hook_id: hookId,
        hook_name: ev.hook_name,
        hook_event: ev.hook_event,
      };
      pending.delete(hookId);
      summary.hooks.push({
        hookId,
        hookName: typeof ev.hook_name === "string" ? ev.hook_name : "",
        hookEvent: typeof ev.hook_event === "string" ? ev.hook_event : "",
        started: startedFallback,
        response: ev,
        stdout: typeof ev.stdout === "string" ? ev.stdout : "",
        stderr: typeof ev.stderr === "string" ? ev.stderr : "",
        exitCode: typeof ev.exit_code === "number" ? ev.exit_code : null,
        outcome: typeof ev.outcome === "string" ? ev.outcome : null,
      });
      continue;
    }

    if (type === "result") {
      summary.result = msg as ResultEvent;
      continue;
    }

    // Anything else: kept terse for forensics, capped.
    if (type === "assistant" || type === "rate_limit_event" || type === "user") {
      // Known noise we do not surface in the summary.
      continue;
    }
    if (summary.unrecognised.length < UNRECOGNISED_CAP) {
      summary.unrecognised.push({
        type: typeof type === "string" ? type : undefined,
        subtype: typeof subtype === "string" ? subtype : undefined,
      });
    }
  }

  // Flush hook_started events that never got a response (claude killed
  // mid-hook). We surface them as pairs with response=null so an
  // assertion can fail loudly rather than silently miss the hook fire.
  for (const started of pending.values()) {
    summary.hooks.push({
      hookId: typeof started.hook_id === "string" ? started.hook_id : "",
      hookName: typeof started.hook_name === "string" ? started.hook_name : "",
      hookEvent: typeof started.hook_event === "string" ? started.hook_event : "",
      started,
      response: null,
      stdout: "",
      stderr: "",
      exitCode: null,
      outcome: null,
    });
  }

  return summary;
}
