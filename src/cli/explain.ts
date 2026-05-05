import { stringify as stringifyYaml } from "yaml";
import {
  queryLedgerByTag,
  type LedgerEntry,
  type LedgerQueryResult,
} from "../policies/index.js";
import {
  decisionSortKey,
  decodeLedgerContent,
  type PolicyDecisionPayload,
} from "../runtime/ledger-record.js";
import { resolveSessionId } from "../runtime/session-id.js";
import { EX_FAIL, EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export type ExplainDecisionFilter = PolicyDecisionPayload["outcome"];

export interface ExplainOptions extends LoaderOptions {
  json?: boolean;
  trace?: boolean;
  /** Session whose audit log to inspect for `--trace`. */
  sessionId?: string;
  /**
   * When true, ignore the policy-name argument and trace the most recent
   * decision recorded in the ledger (any policy). Implies --trace.
   */
  last?: boolean;
  /** When `last` is set, only consider decisions of this outcome. */
  decisionFilter?: ExplainDecisionFilter;
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

type Decoded = { entry: LedgerEntry; payload: PolicyDecisionPayload };

function decodeAll(entries: LedgerEntry[]): Decoded[] {
  const out: Decoded[] = [];
  for (const entry of entries) {
    const payload = decodeLedgerContent(entry.content);
    if (!payload) continue;
    out.push({ entry, payload });
  }
  return out;
}

function selectLatestForPolicy(
  entries: LedgerEntry[],
  policyName: string,
): Decoded | null {
  const matches = decodeAll(entries).filter((d) => d.payload.name === policyName);
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) => decisionSortKey(b.entry, b.payload) - decisionSortKey(a.entry, a.payload),
  );
  return matches[0]!;
}

function selectLatestAny(
  entries: LedgerEntry[],
  decisionFilter?: ExplainDecisionFilter,
): Decoded | null {
  const matches = decodeAll(entries).filter(
    (d) => decisionFilter === undefined || d.payload.outcome === decisionFilter,
  );
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) => decisionSortKey(b.entry, b.payload) - decisionSortKey(a.entry, a.payload),
  );
  return matches[0]!;
}

export async function explain(
  policyName: string | undefined,
  opts: ExplainOptions = {},
): Promise<ExplainResult> {
  const { manifest } = loadManifest(opts);

  if (opts.last) {
    const sessionId = resolveSessionId(opts.sessionId);
    const fetch = opts.fetchLedger ?? defaultFetcher(opts);
    const result = await fetch(sessionId);
    if (result.kind === "degraded") {
      throw new HarnessExitError(
        `cannot read audit log: ${result.reason}`,
        EX_FAIL,
      );
    }
    const latest = selectLatestAny(result.entries, opts.decisionFilter);
    if (!latest) {
      const filterSuffix = opts.decisionFilter ? ` with outcome \`${opts.decisionFilter}\`` : "";
      throw new HarnessExitError(
        `no recorded policy decisions${filterSuffix} for session \`${sessionId}\`; the ledger may be empty or grounding-mcp is unreachable`,
        EX_FAIL,
      );
    }
    return { output: renderTrace(latest, manifest, sessionId, opts.json) };
  }

  if (policyName === undefined) {
    throw new HarnessExitError(
      "policy name is required (or pass --last to trace the most recent decision)",
      EX_USAGE,
    );
  }

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

  const sessionId = resolveSessionId(opts.sessionId);
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

  return { output: renderTrace(latest, manifest, sessionId, opts.json) };
}

function renderTrace(
  latest: Decoded,
  manifest: ReturnType<typeof loadManifest>["manifest"],
  sessionId: string,
  json: boolean | undefined,
): string {
  const policy = manifest.policies.find((p) => p.name === latest.payload.name);
  const trigger = policy?.trigger;
  const projection: TraceProjection = {
    name: latest.payload.name,
    decision: latest.payload.outcome,
    enforcement: latest.payload.enforcement,
    reason: latest.payload.reason,
    ledgerTag: latest.payload.ledgerTag,
    evaluatedAt: latest.payload.evaluatedAt,
    triggerMatched: {
      event: trigger?.event ?? "(unknown: policy not declared in current manifest)",
      ...(trigger?.match !== undefined && { match: trigger.match }),
      ...(trigger?.bash_match !== undefined && { bashMatch: trigger.bash_match }),
    },
    extract: latest.payload.extractValues,
    ...(latest.payload.requiresEval && { requiresEval: latest.payload.requiresEval }),
    ledgerQuery: { verb: "ledger_summary", sessionId },
  };

  return json
    ? `${JSON.stringify(projection, null, 2)}\n`
    : stringifyYaml(projection, { lineWidth: 0 });
}
