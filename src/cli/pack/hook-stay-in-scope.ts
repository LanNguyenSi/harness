// `harness pack hook stay-in-scope` is an optional, informational
// PostToolUse integration. It reads its complete behavior from the current
// pack configuration so a stale generated hook safely no-ops after disable.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { toolNameMatchesAny } from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  evaluateStayInScopeMatch,
  extractConfiguredParentUrl,
  resolveStayInScopeConfig,
  type StayInScopeMatchedRule,
} from "../../policy-packs/builtin/understanding-before-execution/stay-in-scope-config.js";
import type { Manifest } from "../../schema/index.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  pickString,
  readStdin,
  resolveToolInput,
} from "./hook-bootstrap.js";
import type { LoaderOptions } from "../loader.js";

const PACK_NAME = "understanding-before-execution";
export const STAY_IN_SCOPE_DISABLED_ENV = "STAY_IN_SCOPE_DISABLED";
export const STAY_IN_SCOPE_LOG_ENV = "STAY_IN_SCOPE_LOG";
export const REMINDERS_SUBDIR = "reminders";
export const STAY_IN_SCOPE_LOG_BASENAME = "stay-in-scope.log";

export type MatchedRule = StayInScopeMatchedRule;

export interface StayInScopeAuditRecord {
  ts: string;
  taskId: string | null;
  title: string | null;
  labels: string[];
  parentPrUrl: string | null;
  secondOrder: boolean;
  matchedRule: MatchedRule;
}

export interface PackHookStayInScopeOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  logPath?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  manifest?: Manifest;
}

export interface PackHookStayInScopeResult {
  exitCode: number;
  matched: boolean;
  matchedRule: MatchedRule;
  logged: boolean;
  secondOrder: boolean;
  logPath: string | null;
  diagnostic: string;
}

interface ToolEventLite {
  tool_name?: unknown;
  tool?: unknown;
  tool_input?: unknown;
  raw_input?: unknown;
  tool_response?: unknown;
}

function noop(diagnostic: string, stderr: NodeJS.WritableStream, partial: Partial<PackHookStayInScopeResult> = {}): PackHookStayInScopeResult {
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, matched: false, matchedRule: "none", logged: false, secondOrder: false, logPath: null, diagnostic, ...partial };
}

function objectValue(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function extractLabels(toolInput: unknown): string[] {
  const labels = objectValue(toolInput, "labels");
  return Array.isArray(labels) ? labels.filter((value): value is string => typeof value === "string") : [];
}

function extractDescription(toolInput: unknown): string {
  const description = objectValue(toolInput, "description");
  return typeof description === "string" ? description : "";
}

function extractTitle(toolInput: unknown): string | null {
  const title = objectValue(toolInput, "title");
  return typeof title === "string" && title.length > 0 ? title : null;
}

function extractTaskId(toolInput: unknown, toolResponse: unknown): string | null {
  const taskId = objectValue(toolInput, "taskId");
  if (typeof taskId === "string" && taskId.length > 0) return taskId;
  const wrappedId = objectValue(objectValue(toolResponse, "task"), "id");
  if (typeof wrappedId === "string" && wrappedId.length > 0) return wrappedId;
  const directId = objectValue(toolResponse, "id");
  return typeof directId === "string" && directId.length > 0 ? directId : null;
}

function resolveLogPath(opts: PackHookStayInScopeOptions, env: NodeJS.ProcessEnv): string {
  if (typeof opts.logPath === "string" && opts.logPath.length > 0) return opts.logPath;
  const configured = env[STAY_IN_SCOPE_LOG_ENV];
  if (typeof configured === "string" && configured.length > 0) return configured;
  const home = resolveHomeDir(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir });
  return path.join(home.path, REMINDERS_SUBDIR, STAY_IN_SCOPE_LOG_BASENAME);
}

function appendAuditRow(logPath: string, record: StayInScopeAuditRecord): { ok: true } | { ok: false; reason: string } {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export async function runPackHookStayInScopeCli(opts: PackHookStayInScopeOptions = {}): Promise<PackHookStayInScopeResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  let event: ToolEventLite;
  try {
    const parsed: unknown = JSON.parse((await readStdin(stdin)).trim() || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return noop("harness pack hook stay-in-scope: malformed event JSON, skipping", stderr);
    }
    event = parsed as ToolEventLite;
  } catch {
    return noop("harness pack hook stay-in-scope: malformed event JSON, skipping", stderr);
  }
  if (checkHookPause("stay-in-scope", stderr, opts, opts.generatedDir).paused) {
    return noop("harness paused; stay-in-scope skipping without evaluating.", stderr);
  }
  if (env[STAY_IN_SCOPE_DISABLED_ENV] === "1") {
    return noop(`harness pack hook stay-in-scope: ${STAY_IN_SCOPE_DISABLED_ENV}=1, skipping`, stderr);
  }
  let manifest: Manifest;
  try {
    ({ manifest } = loadManifestOrInjected(opts, opts.manifest));
  } catch (error) {
    return noop(`harness pack hook stay-in-scope: manifest load failed (${(error as Error).message}), skipping`, stderr);
  }
  const declared = manifest.policy_packs.find((pack) => pack.name === (opts.pack ?? PACK_NAME));
  const config = declared?.enabled ? resolveStayInScopeConfig(declared.config["stay_in_scope"]) : null;
  if (config === null) {
    return noop("harness pack hook stay-in-scope: integration absent, disabled, or invalid, skipping", stderr);
  }
  const toolName = pickString(event.tool_name, event.tool) ?? "";
  if (!toolNameMatchesAny(toolName, config.tools)) {
    return noop(`harness pack hook stay-in-scope: tool ${toolName || "(missing)"} not in watch list, skipping`, stderr);
  }
  const toolInput = resolveToolInput(event);
  const labels = extractLabels(toolInput);
  const description = extractDescription(toolInput);
  const evaluation = evaluateStayInScopeMatch(config, labels, description);
  if (!evaluation.matched) {
    return noop(`harness pack hook stay-in-scope: ${toolName} payload carries no configured marker, skipping`, stderr);
  }
  const taskId = extractTaskId(toolInput, event.tool_response);
  const record: StayInScopeAuditRecord = {
    ts: (opts.now ?? new Date()).toISOString(), taskId, title: extractTitle(toolInput), labels,
    parentPrUrl: extractConfiguredParentUrl(config, description, evaluation.parentReference),
    secondOrder: evaluation.secondOrder, matchedRule: evaluation.matchedRule,
  };
  const logPath = resolveLogPath(opts, env);
  const appendResult = appendAuditRow(logPath, record);
  const prefix = evaluation.secondOrder ? "[stay-in-scope: SECOND-ORDER]" : "[stay-in-scope]";
  const taskIdNote = taskId === null ? "" : ` task=${taskId}`;
  const configuredMessage = evaluation.secondOrder ? config.messages.secondOrder : config.messages.reminder;
  stderr.write(`${prefix} follow-up created from review context${taskIdNote}. ${configuredMessage}\n`);
  const logNote = appendResult.ok ? `; audit appended to ${logPath}` : `; audit append FAILED (${appendResult.reason})`;
  const diagnostic = `harness pack hook stay-in-scope: matched=${evaluation.matchedRule} secondOrder=${evaluation.secondOrder}${logNote}`;
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, matched: true, matchedRule: evaluation.matchedRule, logged: appendResult.ok, secondOrder: evaluation.secondOrder, logPath: appendResult.ok ? logPath : null, diagnostic };
}
