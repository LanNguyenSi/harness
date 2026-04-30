import { stringify as stringifyYaml } from "yaml";
import {
  queryLedgerByTag,
  type LedgerEntry,
  type LedgerQueryResult,
} from "../policies/index.js";
import {
  decodeLedgerContent,
  type PolicyDecisionPayload,
} from "../runtime/ledger-record.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface ExplainOptions extends LoaderOptions {
  json?: boolean;
  trace?: boolean;
  /** Session whose audit log to inspect for `--trace`. */
  sessionId?: string;
  /** Override the ledger fetcher (tests). */
  fetchLedger?: (sessionId: string) => Promise<LedgerQueryResult>;
}

export interface ExplainResult {
  output: string;
}

interface TraceProjection {
  name: string;
  decision: PolicyDecisionPayload["outcome"];
  enforcement: PolicyDecisionPayload["enforcement"];
  reason: string;
  ledgerTag: string;
  evaluatedAt: string;
  triggerMatched: { event: string; match?: string; bashMatch?: string };
  extract: Record<string, string>;
  requiresEval?: PolicyDecisionPayload["requiresEval"];
  ledgerQuery: { verb: "ledger_summary"; sessionId: string };
}

function defaultFetcher(opts: ExplainOptions) {
  return async (sessionId: string): Promise<LedgerQueryResult> => {
    const { manifest } = loadManifest(opts);
    const server = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
    if (!server) {
      return { kind: "degraded", reason: "grounding-mcp not declared in manifest" };
    }
    const command = Array.isArray(server.command)
      ? server.command
      : server.command.trim().split(/\s+/);
    return queryLedgerByTag({
      mcpCommand: command,
      ...(server.env && { mcpEnv: server.env }),
      sessionId,
      timeoutMs: server.health?.timeout_ms ?? 5_000,
    });
  };
}

function selectLatestForPolicy(
  entries: LedgerEntry[],
  policyName: string,
): { entry: LedgerEntry; payload: PolicyDecisionPayload } | null {
  const matches = entries
    .map((e) => {
      const payload = decodeLedgerContent(e.content);
      if (!payload) return null;
      if (payload.name !== policyName) return null;
      return { entry: e, payload };
    })
    .filter((x): x is { entry: LedgerEntry; payload: PolicyDecisionPayload } => x !== null);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const at = Date.parse(a.entry.createdAt as string);
    const bt = Date.parse(b.entry.createdAt as string);
    return bt - at;
  });
  return matches[0]!;
}

export async function explain(
  policyName: string,
  opts: ExplainOptions = {},
): Promise<ExplainResult> {
  const { manifest } = loadManifest(opts);
  const policy = manifest.policies.find((p) => p.name === policyName);
  if (!policy) {
    const available = manifest.policies.map((p) => p.name).join(", ") || "(none)";
    throw new HarnessExitError(
      `no policy named "${policyName}" declared; available: ${available}`,
      EX_USAGE,
    );
  }

  if (!opts.trace) {
    const projection = {
      name: policy.name,
      description: policy.description,
      trigger: policy.trigger,
      requires: policy.requires,
      hook: policy.hook,
      enforcement: policy.enforcement,
      note: "run with --trace to see the last evaluation's full decision trail",
    };
    const output = opts.json
      ? `${JSON.stringify(projection, null, 2)}\n`
      : stringifyYaml(projection, { lineWidth: 0 });
    return { output };
  }

  const sessionId = opts.sessionId ?? "default";
  const fetch = opts.fetchLedger ?? defaultFetcher(opts);
  const result = await fetch(sessionId);
  if (result.kind === "degraded") {
    throw new HarnessExitError(
      `cannot read audit log: ${result.reason}`,
      EX_FAIL,
    );
  }
  const latest = selectLatestForPolicy(result.entries, policyName);
  if (!latest) {
    throw new HarnessExitError(
      `no recorded evaluations for policy \`${policyName}\`; the policy may not have fired yet, or grounding-mcp is unreachable`,
      EX_FAIL,
    );
  }

  const projection: TraceProjection = {
    name: latest.payload.name,
    decision: latest.payload.outcome,
    enforcement: latest.payload.enforcement,
    reason: latest.payload.reason,
    ledgerTag: latest.payload.ledgerTag,
    evaluatedAt: latest.payload.evaluatedAt,
    triggerMatched: {
      event: policy.trigger.event,
      ...(policy.trigger.match !== undefined && { match: policy.trigger.match }),
      ...(policy.trigger.bash_match !== undefined && {
        bashMatch: policy.trigger.bash_match,
      }),
    },
    extract: latest.payload.extractValues,
    ...(latest.payload.requiresEval && { requiresEval: latest.payload.requiresEval }),
    // sessionId default mirrors recordPolicyDecision's caller fallback in
    // src/cli/policy/intercept.ts (uses event.session_id ?? "default").
    ledgerQuery: { verb: "ledger_summary", sessionId },
  };

  const output = opts.json
    ? `${JSON.stringify(projection, null, 2)}\n`
    : stringifyYaml(projection, { lineWidth: 0 });
  return { output };
}
