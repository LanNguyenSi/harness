import { stringify as stringifyYaml } from "yaml";
import {
  evaluateExtract,
  firstInputMatchMismatch,
  substituteTemplate,
  type ExtractBuiltins,
  type ExtractEventContext,
} from "../policies/index.js";
import {
  normalizeCommand,
  normalizeCommandAmpAware,
  normalizeCommandQuoteAware,
} from "../runtime/command-normalize.js";
import { resolveGitContext } from "../runtime/git-context.js";
import type { Hook, Manifest, Policy } from "../schema/index.js";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface DryRunOptions extends LoaderOptions {
  json?: boolean;
  /** Tool name to simulate; required for `PreToolUse` matching. */
  tool?: string;
  /** JSON string for `tool_input`. Parsed once and threaded into the extract context. */
  toolArgs?: string;
  /** Override builtins (tests). */
  builtins?: Partial<ExtractBuiltins>;
}

export interface DryRunHookHit {
  event: string;
  name: string;
}

export interface DryRunPolicyHit {
  name: string;
  ledgerQuery: string;
  requires: Policy["requires"];
  enforcement: Policy["enforcement"];
  triggerEvent: string;
}

export interface DryRunPolicyCouldHit {
  name: string;
  triggerEvent: string;
  reason: string;
}

export interface DryRunMemoryDir {
  path: string;
  scope: string;
}

export interface DryRunReport {
  prompt: string;
  tool: string | null;
  toolArgs: unknown;
  hooks: DryRunHookHit[];
  matchingPolicies: DryRunPolicyHit[];
  couldMatchPolicies: DryRunPolicyCouldHit[];
  memoryDirectories: DryRunMemoryDir[];
}

export interface DryRunResult {
  output: string;
  report: DryRunReport;
}

const PROMPT_EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);

function builtinsFor(opts: DryRunOptions, tool: string | null): ExtractBuiltins {
  const fromOpts = opts.builtins ?? {};
  // Derive REPO / BRANCH from the cwd so the prediction matches what the
  // intercept engine resolves at runtime; an explicit builtins override
  // (tests, or a deliberate caller) still wins.
  const cwd = fromOpts.CWD ?? process.cwd();
  const gitContext = resolveGitContext(cwd);
  return {
    SESSION_ID: fromOpts.SESSION_ID ?? "dry-run",
    REPO: fromOpts.REPO ?? gitContext.repo,
    BRANCH: fromOpts.BRANCH ?? gitContext.branch,
    TOOL_NAME: fromOpts.TOOL_NAME ?? (tool ?? ""),
    CWD: cwd,
  };
}

function policyMatchesPrompt(policy: Policy, prompt: string): boolean {
  if (!PROMPT_EVENTS.has(policy.trigger.event)) return false;
  if (policy.trigger.match !== undefined) {
    return prompt.includes(policy.trigger.match);
  }
  return true;
}

function policyMatchesTool(
  policy: Policy,
  tool: string,
  toolInput: unknown,
): { matched: true } | { matched: false; reason: string } {
  if (policy.trigger.event !== "PreToolUse") {
    return { matched: false, reason: `trigger event is ${policy.trigger.event}, not PreToolUse` };
  }
  if (policy.trigger.match !== undefined && !tool.includes(policy.trigger.match)) {
    return {
      matched: false,
      reason: `--tool "${tool}" does not contain trigger.match "${policy.trigger.match}"`,
    };
  }
  // `input_match` (task 2699b476): the SAME predicate `policyMatchesEvent`
  // ANDs onto the tool-name match (`firstInputMatchMismatch`, called on
  // the same `toolArgs` context both sides build), so dry-run predicts
  // `mcp__agent-tasks__task_finish` with `{"autoMerge": true}` as gated
  // and the same verb without it as unmatched, exactly as the runtime
  // decides. Leaving this arm out would reintroduce the debug-verb
  // contradiction the bash_match arms below already document once for
  // their own family: dry-run reporting "no policy matches" for a call
  // `policy intercept` blocks.
  if (policy.trigger.input_match !== undefined) {
    const mismatch = firstInputMatchMismatch(policy.trigger.input_match, {
      toolArgs: toolInput,
    });
    if (mismatch !== null) {
      return {
        matched: false,
        reason: mismatch.missing
          ? `trigger.input_match needs ${mismatch.expression} in tool_input ` +
            `(expected ${JSON.stringify(mismatch.expected)})`
          : `trigger.input_match ${mismatch.expression} is ` +
            `${JSON.stringify(mismatch.actual)}, not ${JSON.stringify(mismatch.expected)}`,
      };
    }
  }
  if (policy.trigger.bash_match !== undefined) {
    const args = toolInput as { command?: unknown } | undefined;
    if (!args || typeof args.command !== "string") {
      return {
        matched: false,
        reason: "trigger.bash_match needs tool_input.command",
      };
    }
    let re: RegExp;
    try {
      re = new RegExp(policy.trigger.bash_match);
    } catch {
      return { matched: false, reason: `trigger.bash_match is not a valid regex` };
    }
    // Raw-OR-normalised-OR-amp-normalised-OR-quote-normalised, mirroring
    // `policyMatchesEvent`'s real evaluation path exactly (third arm added
    // task aabbad63; fourth arm added task f561e44c): dry-run used to test
    // only the RAW command, so it predicted `env -C /tmp git status` as NOT
    // matching `preflight-before-investigation` while `policy intercept`
    // actually blocks it — a debug verb contradicting the runtime it exists
    // to predict (its own comment above and docs/okf/debug-verb-selection.md
    // both assert parity). Leaving out the amp-aware third arm here would
    // reintroduce that SAME class of contradiction for the bare-`&` family
    // (`A=x&env -C /tmp git status`, `echo hi & nice git status`): `policy
    // intercept` now blocks those via `normalizeCommandAmpAware`, so dry-run
    // must try it too. The REPO/BRANCH half of this file (`builtinsFor`,
    // cwd-only) stays in parity with the runtime, which is also cwd-only for
    // `${REPO}`/`${BRANCH}` — see `src/cli/policy/intercept.ts`'s comment
    // above `cwdGitContext` for why a per-command target directory is
    // deliberately not consulted.
    //
    // FOURTH ARM (task f561e44c, closes the cf3dff51 follow-up): task
    // cf3dff51 wired `normalizeCommandQuoteAware` (a quote-aware BOUNDARY_RE
    // segmenter closing `VAR='a; b' git push origin master` and its
    // `|`/`&&`/`(`/newline siblings — task 13e55484's pinned gap) as
    // `policyMatchesEvent`'s FOURTH arm, but deliberately left this function
    // untouched (scope was narrowed to `src/runtime/intercept.ts` alone),
    // reintroducing EXACTLY the parity contradiction this comment's first
    // sentence describes, for that one family. Closed here by adding the
    // same fourth OR-arm, literally duplicated rather than extracted to a
    // shared helper — mirroring the amp-aware arm's own literal-duplication
    // shape immediately above (no shared-helper precedent exists yet for
    // this OR-chain to follow instead).
    if (
      !re.test(args.command) &&
      !re.test(normalizeCommand(args.command).normalized) &&
      !re.test(normalizeCommandAmpAware(args.command).normalized) &&
      !re.test(normalizeCommandQuoteAware(args.command).normalized)
    ) {
      return {
        matched: false,
        reason: `bash_match "${policy.trigger.bash_match}" did not match`,
      };
    }
  }
  return { matched: true };
}

function buildHookHits(manifest: Manifest, tool: string | null): DryRunHookHit[] {
  const hits: DryRunHookHit[] = [];
  for (const hook of manifest.hooks as Hook[]) {
    if (PROMPT_EVENTS.has(hook.event)) {
      hits.push({ event: hook.event, name: hook.name });
      continue;
    }
    if (tool !== null && hook.event === "PreToolUse") {
      hits.push({ event: hook.event, name: hook.name });
    }
  }
  return hits;
}

function staticLedgerQuery(
  policy: Policy,
  ctx: ExtractEventContext,
  builtins: ExtractBuiltins,
): string {
  if (policy.requires === undefined) {
    // operator_only: true (task 2cc73f55): no requires.ledger_tag to
    // substitute — the policy never queries the ledger at all.
    return "(operator-only: no ledger query — unconditional deny)";
  }
  const extract = evaluateExtract(policy.trigger.extract ?? {}, ctx, builtins);
  const sub = substituteTemplate(policy.requires.ledger_tag, extract.values);
  return sub.result;
}

function formatYaml(report: DryRunReport): string {
  // Hide raw `null` from YAML output for the no-tool case.
  const visible: Record<string, unknown> = {
    prompt: report.prompt,
    ...(report.tool !== null && { tool: report.tool }),
    ...(report.tool !== null && report.toolArgs !== undefined && {
      toolArgs: report.toolArgs,
    }),
    "Hooks that would fire": report.hooks.length === 0 ? "(none)" : report.hooks,
    "Policies that match":
      report.matchingPolicies.length === 0 ? "(none)" : report.matchingPolicies,
    "Policies that COULD match (need --tool)":
      report.couldMatchPolicies.length === 0 ? "(none)" : report.couldMatchPolicies,
    "Memories that would route":
      report.memoryDirectories.length === 0 ? "(none)" : report.memoryDirectories,
  };
  return stringifyYaml(visible, { lineWidth: 0 });
}

export function dryRun(prompt: string, opts: DryRunOptions = {}): DryRunResult {
  const { manifest } = loadManifest(opts);
  const tool = opts.tool ?? null;
  let toolArgs: unknown = undefined;
  if (opts.toolArgs !== undefined) {
    try {
      toolArgs = JSON.parse(opts.toolArgs);
    } catch (err) {
      throw new HarnessExitError(
        `--tool-args: ${(err as Error).message}`,
        EX_USAGE,
      );
    }
  }

  const builtins = builtinsFor(opts, tool);
  const ctx: ExtractEventContext = {
    toolArgs,
    event: { hook_event_name: tool ? "PreToolUse" : "UserPromptSubmit", tool_name: tool, prompt },
    session: { id: builtins.SESSION_ID },
    git: {},
  };

  const hooks = buildHookHits(manifest, tool);
  const matching: DryRunPolicyHit[] = [];
  const couldMatch: DryRunPolicyCouldHit[] = [];

  for (const policy of manifest.policies) {
    if (PROMPT_EVENTS.has(policy.trigger.event)) {
      if (policyMatchesPrompt(policy, prompt)) {
        matching.push({
          name: policy.name,
          ledgerQuery: staticLedgerQuery(policy, ctx, builtins),
          requires: policy.requires,
          enforcement: policy.enforcement,
          triggerEvent: policy.trigger.event,
        });
      }
      continue;
    }
    // PreToolUse and friends.
    if (tool === null) {
      couldMatch.push({
        name: policy.name,
        triggerEvent: policy.trigger.event,
        reason: "no --tool supplied; dry-run can only statically match prompt-style events",
      });
      continue;
    }
    const verdict = policyMatchesTool(policy, tool, toolArgs);
    if (verdict.matched) {
      matching.push({
        name: policy.name,
        ledgerQuery: staticLedgerQuery(policy, ctx, builtins),
        requires: policy.requires,
        enforcement: policy.enforcement,
        triggerEvent: policy.trigger.event,
      });
    } else {
      couldMatch.push({
        name: policy.name,
        triggerEvent: policy.trigger.event,
        reason: verdict.reason,
      });
    }
  }

  const memoryDirectories: DryRunMemoryDir[] = manifest.memory.directories.map(
    (d) => ({ path: d.path, scope: d.scope }),
  );

  const report: DryRunReport = {
    prompt,
    tool,
    toolArgs,
    hooks,
    matchingPolicies: matching,
    couldMatchPolicies: couldMatch,
    memoryDirectories,
  };

  const output = opts.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatYaml(report);
  return { output, report };
}
