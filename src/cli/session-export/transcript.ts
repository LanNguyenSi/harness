import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TranscriptEventKind =
  | "user_prompt"
  | "user_tool_result"
  | "assistant_text"
  | "assistant_thinking"
  | "assistant_tool_use"
  | "attachment"
  | "permission_mode"
  | "file_history_snapshot";

export interface TranscriptEvent {
  source: "transcript";
  kind: TranscriptEventKind;
  timestamp: string | null;
  uuid?: string | undefined;
  parentUuid?: string | undefined;
  cwd?: string | undefined;
  data: Record<string, unknown>;
}

export interface TranscriptParseResult {
  events: TranscriptEvent[];
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  malformedLines: number;
}

interface RawRecord {
  type?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
  attachment?: unknown;
  snapshot?: unknown;
  permissionMode?: unknown;
  isSnapshotUpdate?: unknown;
  messageId?: unknown;
}

export function parseTranscript(jsonl: string): TranscriptParseResult {
  const events: TranscriptEvent[] = [];
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let malformedLines = 0;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let raw: RawRecord;
    try {
      raw = JSON.parse(line) as RawRecord;
    } catch {
      malformedLines += 1;
      continue;
    }
    const ts = typeof raw.timestamp === "string" ? raw.timestamp : null;
    if (ts !== null) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }
    if (typeof raw.cwd === "string" && cwd === null) cwd = raw.cwd;

    const baseFields: Pick<TranscriptEvent, "uuid" | "parentUuid" | "cwd"> = {
      ...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
      ...(typeof raw.parentUuid === "string" ? { parentUuid: raw.parentUuid } : {}),
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    };
    const base: Omit<TranscriptEvent, "kind" | "data"> = {
      source: "transcript",
      timestamp: ts,
      ...baseFields,
    };

    switch (raw.type) {
      case "user": {
        const content = raw.message?.content;
        if (typeof content === "string") {
          events.push({ ...base, kind: "user_prompt", data: { text: content } });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result") {
              events.push({
                ...base,
                kind: "user_tool_result",
                data: {
                  tool_use_id: b.tool_use_id,
                  is_error: b.is_error,
                  content: b.content,
                },
              });
            } else if (b.type === "text") {
              events.push({
                ...base,
                kind: "user_prompt",
                data: { text: b.text },
              });
            }
          }
        }
        break;
      }
      case "assistant": {
        const content = raw.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              events.push({
                ...base,
                kind: "assistant_text",
                data: { text: b.text },
              });
            } else if (b.type === "thinking") {
              events.push({
                ...base,
                kind: "assistant_thinking",
                data: { text: b.thinking ?? b.text },
              });
            } else if (b.type === "tool_use") {
              events.push({
                ...base,
                kind: "assistant_tool_use",
                data: { id: b.id, name: b.name, input: b.input },
              });
            }
          }
        }
        break;
      }
      case "attachment": {
        events.push({
          ...base,
          kind: "attachment",
          data: { attachment: raw.attachment },
        });
        break;
      }
      case "permission-mode": {
        events.push({
          ...base,
          kind: "permission_mode",
          data: { mode: raw.permissionMode },
        });
        break;
      }
      case "file-history-snapshot": {
        events.push({
          ...base,
          kind: "file_history_snapshot",
          data: {
            messageId: raw.messageId,
            isSnapshotUpdate: raw.isSnapshotUpdate,
            snapshot: raw.snapshot,
          },
        });
        break;
      }
      default:
        // Ignore unknown record types; future Claude Code versions may add new ones.
        break;
    }
  }
  return { events, startedAt, endedAt, cwd, malformedLines };
}

export interface LocateTranscriptOptions {
  homeDir?: string;
  projectsRoot?: string;
}

export function locateTranscript(
  sessionId: string,
  opts: LocateTranscriptOptions = {},
): string | null {
  const projectsRoot =
    opts.projectsRoot ?? path.join(opts.homeDir ?? os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function readTranscript(filePath: string): TranscriptParseResult {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseTranscript(raw);
}
