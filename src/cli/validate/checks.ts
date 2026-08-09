import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkPolicyPackConfigs,
  checkPolicyPackSources,
  KNOWN_RUNTIMES,
  resolveBuiltin,
} from "../../policy-packs/index.js";
import { expandHome } from "../../runtime/expand-home.js";
import { shippedOperatorOnlyPolicyNames } from "../init/templates.js";
import { isPolicyInterceptCommand, requiredHookBudgetMs } from "../policy/intercept.js";
import type { Hook, Manifest } from "../../schema/index.js";
import type { Diagnostic } from "./types.js";

export interface CheckOptions {
  homeDir?: string;
  pathEnv?: string;
  builtinRuntimeProbe?: () => string[];
  versionProbe?: (cmd: readonly string[]) => string | null;
  /**
   * Answers "is this repo-relative path git-ignored in the current working
   * directory's repository?". `null` means "cannot tell" (not a git repo,
   * git unavailable) and skips the dependent check. Injectable for tests;
   * defaults to a real `git check-ignore` probe.
   */
  gitIgnoreProbe?: GitIgnoreProbe;
}

const DEFAULT_RUNTIME_BUILTINS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Agent",
  "Skill",
  "TaskCreate",
  "Glob",
  "Grep",
];

function isRootedPath(p: string): boolean {
  return path.isAbsolute(p) || p === "~" || p.startsWith("~/");
}

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function resolveOnPath(binary: string, pathEnv: string): string | null {
  if (binary.includes(path.sep) || path.isAbsolute(binary)) return null;
  const segments = pathEnv.split(path.delimiter).filter(Boolean);
  for (const seg of segments) {
    const candidate = path.join(seg, binary);
    if (fs.existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

const SEMVER_RE = /(\d+(?:\.\d+){0,3})/;

function compareVersions(actual: string, required: string): number {
  const a = actual.split(".").map((n) => Number.parseInt(n, 10));
  const r = required.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(a.length, r.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const ri = r[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(ri)) return 0;
    if (ai > ri) return 1;
    if (ai < ri) return -1;
  }
  return 0;
}

function checkMcp(manifest: Manifest, home: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  manifest.tools.mcp.forEach((mcp) => {
    const cmdArr = Array.isArray(mcp.command) ? mcp.command : mcp.command.trim().split(/\s+/);
    const first = cmdArr[0] ?? "";
    if (!isRootedPath(first)) return;
    const resolved = expandHome(first, home);
    const stat = statOrNull(resolved);
    if (!stat) {
      diags.push({
        severity: "error",
        path: `tools.mcp[${mcp.name}].command`,
        message: `path does not exist: ${resolved}`,
      });
    }
  });
  return diags;
}

function checkCli(manifest: Manifest, opts: CheckOptions): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const versionProbe = opts.versionProbe ?? (() => null);

  manifest.tools.cli.forEach((cli) => {
    let resolved: string | null;
    if (path.isAbsolute(cli.binary)) {
      resolved = fs.existsSync(cli.binary) && isExecutable(cli.binary) ? cli.binary : null;
    } else {
      resolved = resolveOnPath(cli.binary, pathEnv);
    }
    if (!resolved) {
      diags.push({
        severity: cli.required ? "error" : "warning",
        path: `tools.cli[${cli.name}].binary`,
        message: cli.required
          ? `required binary not found: ${cli.binary}`
          : `binary not found on PATH: ${cli.binary}`,
      });
      return;
    }
    if (!cli.min_version) return;
    const versionCommand = cli.version_command ?? [resolved, "--version"];
    const stdout = versionProbe(versionCommand);
    if (stdout === null) {
      diags.push({
        severity: "warning",
        path: `tools.cli[${cli.name}].min_version`,
        message: `version probe failed for ${versionCommand.join(" ")}`,
      });
      return;
    }
    const match = stdout.match(SEMVER_RE);
    if (!match || !match[1]) {
      diags.push({
        severity: "warning",
        path: `tools.cli[${cli.name}].min_version`,
        message: `could not parse a version from "${stdout.trim()}"`,
      });
      return;
    }
    if (compareVersions(match[1], cli.min_version) < 0) {
      diags.push({
        severity: "error",
        path: `tools.cli[${cli.name}].min_version`,
        message: `installed version ${match[1]} is less than required ${cli.min_version}`,
      });
    }
  });
  return diags;
}

function checkSkills(manifest: Manifest, home: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const required = manifest.tools.skills.required ?? [];
  if (required.length === 0) return diags;
  for (const skillName of required) {
    let found = false;
    for (const dir of manifest.tools.skills.source_dirs) {
      const expanded = expandHome(dir, home);
      const candidate = path.join(expanded, skillName, "SKILL.md");
      if (fs.existsSync(candidate)) {
        found = true;
        break;
      }
    }
    if (!found) {
      diags.push({
        severity: "error",
        path: `tools.skills.required[${skillName}]`,
        message: `SKILL.md not found in any tools.skills.source_dirs entry`,
      });
    }
  }
  return diags;
}

function checkHooks(manifest: Manifest, home: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  manifest.hooks.forEach((hook) => {
    const first = firstToken(hook.command);
    if (!isRootedPath(first)) return;
    const resolved = expandHome(first, home);
    const stat = statOrNull(resolved);
    if (!stat) {
      diags.push({
        severity: "error",
        path: `hooks[${hook.name}].command`,
        message: `path does not exist: ${resolved}`,
      });
      return;
    }
    if (!stat.isFile()) {
      diags.push({
        severity: "error",
        path: `hooks[${hook.name}].command`,
        message: `not a regular file: ${resolved}`,
      });
      return;
    }
    if (!isExecutable(resolved)) {
      diags.push({
        severity: "error",
        path: `hooks[${hook.name}].command`,
        message: `not executable (chmod +x): ${resolved}`,
      });
    }
  });
  return diags;
}

function checkBuiltinDrift(manifest: Manifest, opts: CheckOptions): Diagnostic[] {
  const probe = opts.builtinRuntimeProbe ?? (() => DEFAULT_RUNTIME_BUILTINS);
  const runtime = probe();
  const known = new Set(manifest.tools.builtin.known);
  const diags: Diagnostic[] = [];
  for (const r of runtime) {
    if (!known.has(r)) {
      diags.push({
        severity: "warning",
        path: `tools.builtin.known`,
        message: `runtime advertises built-in "${r}" but the manifest does not list it`,
      });
    }
  }
  return diags;
}

export function checkPolicyGroundingMcp(manifest: Manifest): Diagnostic[] {
  if (manifest.policies.length === 0) return [];
  const wired = manifest.tools.mcp.some((m) => m.name === "grounding-mcp");
  if (wired) return [];
  // Tier-aware wording since task f1aea826: this is the LAST surface
  // before an operator ships a manifest whose block/require_approval
  // policies will hard-deny every matching event (deny-degraded), the
  // inverse of the pre-0.45 silent non-blocking fallback this message
  // used to describe. The wording is pinned by a test so it cannot
  // drift from the runtime contract again (review 2026-08-08, round 2).
  return [
    {
      severity: "warning",
      path: "policies",
      message:
        "policies declared but grounding-mcp not wired: warn policies degrade non-blocking (warn-degraded), but block/require_approval policies will DENY every matching event (deny-degraded) until the producer is wired; risk.degraded_fail_posture: fail_open restores the availability-first behaviour — see docs/okf/gate-fail-posture-matrix.md",
    },
  ];
}

// solution-acceptance is a pure CONSUMER: it reads the verdict marker the
// grounding-mcp producer writes. Misconfigurations can silently turn the
// completion-gate into a permanent deny (a No-Op that LOOKS protective):
//   1. grounding-mcp absent from tools.mcp -> the producer (solution_evaluate)
//      is unreachable, so no verdict can ever be written -> deadlock.
//   2. grounding-mcp declares a RELATIVE SOLUTION_VERDICT_DIR -> harness now
//      projects the value into the hook command, but a relative path resolves
//      against each process's cwd, which harness cannot reconcile (the
//      producer's cwd is unknown), so producer and consumer can still diverge.
// An ABSOLUTE non-default SOLUTION_VERDICT_DIR previously also denied (harness
// did not project the env override into the hook); `harness apply` now projects
// it (see `buildExpectedFiles` in apply.ts), so the absolute case is handled
// correctly and no longer warn-worthy. Condition #1 (grounding-mcp not wired)
// is an ERROR: solution-acceptance without a reachable producer deadlocks the
// completion-gate on a permanent deny, so it is a hard misconfiguration rather
// than a warning (task e3af6388). Condition #2 (a relative SOLUTION_VERDICT_DIR)
// stays a warning: it only bites on cwd divergence between producer and hook.
export function checkSolutionAcceptanceProducer(manifest: Manifest): Diagnostic[] {
  const pack = manifest.policy_packs.find((p) => p.name === "solution-acceptance");
  if (!pack || !pack.enabled) return [];
  const grounding = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
  if (!grounding) {
    return [
      {
        severity: "error",
        path: "policy_packs",
        message:
          "solution-acceptance is enabled but grounding-mcp is not wired under tools.mcp: the producer (solution_evaluate) is unreachable, so the completion-gate can never see a verdict and will deadlock on a permanent deny. Add grounding-mcp (>= 0.3.2) to tools.mcp.",
      },
    ];
  }
  // Condition #2: an absolute non-default SOLUTION_VERDICT_DIR is now projected
  // into the hook at apply time, so it is handled and silent. A relative
  // override cannot be reconciled (cwd divergence between producer and hook),
  // so warn only for that unfixable case.
  const env = (grounding.env ?? {}) as Record<string, unknown>;
  const dir = env["SOLUTION_VERDICT_DIR"];
  if (typeof dir === "string" && dir.trim().length > 0 && !path.isAbsolute(dir.trim())) {
    return [
      {
        severity: "warning",
        path: "tools.mcp",
        message:
          "solution-acceptance: grounding-mcp declares a relative SOLUTION_VERDICT_DIR; harness projects this value into the completion-gate hook, but a relative path resolves against each process's working directory, so the producer (grounding-mcp) and the hook can still land on different dirs and the gate would deny. Use an absolute path.",
      },
    ];
  }
  return [];
}

/**
 * Answers "is `relPath` git-ignored here?": `true` / `false`, or `null`
 * when the question has no answer (not a git repository, git not
 * installed). See `createDefaultGitIgnoreProbe` for the real
 * implementation; checks receive the probe so tests stay hermetic.
 */
export type GitIgnoreProbe = (relPath: string) => boolean | null;

/**
 * The orchestrator-workflow knob the grounding-mcp producer reads
 * (`resolveOwKnob`). Repo-relative on purpose: the knob belongs to the
 * repository whose completions the OW arm gates.
 */
export const OW_KNOB_REL_PATH = ".ai/solution-acceptance.json";

export function createDefaultGitIgnoreProbe(cwd?: string): GitIgnoreProbe {
  return (relPath) => {
    const res = spawnSync("git", ["check-ignore", "-q", "--", relPath], {
      cwd: cwd ?? process.cwd(),
      stdio: "ignore",
    });
    if (res.error) return null;
    if (res.status === 0) return true;
    if (res.status === 1) return false;
    return null; // 128: not a git repository (or another fatal git error)
  };
}

// Knob-reachability lint (task 24f6ceb9, ow-review-2026-07-01). The OW arm
// of solution-acceptance reads repo state: the knob above plus run
// completeness under `.ai/runs/`. When the knob path is git-ignored the
// repo CANNOT commit its enforcement posture, so in a fresh clone or a git
// worktree `.ai/runs/` is absent, the default `auto` knob silently skips
// the OW arm, and the gate that exists to prevent process skipping is
// itself skipped exactly where process skipping happens. Warn (not error):
// the preflight floor still gates every completion; only the OW arm is
// affected. A `null` probe answer (non-repo cwd, git missing) skips the
// check — validate must stay usable for pure home-config linting.
export function checkSolutionAcceptanceKnobIgnored(
  manifest: Manifest,
  probe: GitIgnoreProbe,
): Diagnostic[] {
  const pack = manifest.policy_packs.find((p) => p.name === "solution-acceptance");
  if (!pack || !pack.enabled) return [];
  if (probe(OW_KNOB_REL_PATH) !== true) return [];
  return [
    {
      severity: "warning",
      path: "policy_packs",
      message:
        `solution-acceptance: the orchestrator-workflow knob ${OW_KNOB_REL_PATH} ` +
        `is git-ignored in this repository, so the OW enforcement posture cannot ` +
        `be committed. In a fresh clone or git worktree .ai/runs/ is absent and ` +
        `the default "auto" knob silently skips the OW arm — exactly where ` +
        `process skipping happens. Narrow the ignore to .ai/runs/ (run state ` +
        `stays local) and commit ${OW_KNOB_REL_PATH}; see ` +
        `docs/policy-packs/solution-acceptance.md ("Repo state and gitignore").`,
    },
  ];
}

// Self-attestation disclosure (task 43b107f2, harness-review-2026-07-01).
// The generic `requires:`/`ledger_tag` engine matches substrings in ledger
// content that the GATED AGENT can write directly via
// `mcp__grounding-mcp__ledger_add` — whoever can write the ledger can open
// the gate. The two builtin packs were hardened to filesystem markers after
// exactly this class of self-approval bug (docs/CLI.md, branch-protection),
// but a custom block-policy is only as strong as its evidence producer.
//
// Heuristic: warn only when a `block` policy declares NO `producers:` at
// all — the evidence source is then undocumented and the operator has made
// no visible trust decision. A declared producer, even an agent-executable
// `mcp`/`bash` one, IS the schema's way of stating the intended evidence
// flow (same philosophy as the doctor producer-gap refinement, task
// f97e152f): the full/team templates deliberately ship mcp-producer
// process-gates whose purpose is forcing a review-subagent step, and
// warning on every one of them would train operators to ignore warnings.
// What an agent-executable producer MEANS for the trust model (advisory
// against the gated agent) is taught by the tripwire in
// docs/writing-custom-policies.md, which the producer docs link to.
export function checkPolicySelfAttestation(manifest: Manifest): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (let i = 0; i < manifest.policies.length; i++) {
    const p = manifest.policies[i];
    // block-only on purpose: a require_approval policy's canonical unblock
    // path is the operator verb (`harness approve risk`), an ask-semantics
    // flow that exists independent of producers:, so absence of producers
    // there does not mean the evidence source is undocumented.
    if (p === undefined || p.enforcement !== "block") continue;
    // operator_only: true (task 2cc73f55) is the schema-level unconditional
    // operator-only deny: no requires:, so there is no self-satisfiable
    // evidence source to leave undocumented, and no producers: array could
    // ever name a legitimate one (an unconditional deny is never satisfied
    // from inside the session, by design). Correct-by-construction: skip
    // both this warning and the --strict error it would become.
    if (p.operator_only === true) continue;
    if (p.producers !== undefined && p.producers.length > 0) continue;
    diags.push({
      severity: "warning",
      path: `policies[${i}]`,
      message:
        `policy "${p.name}" blocks on requires.ledger_tag but declares no ` +
        `producers: — the evidence source is undocumented, and the tag is ` +
        `satisfied by ANY ledger writer, including the gated agent itself ` +
        `via mcp__grounding-mcp__ledger_add (advisory against the agent ` +
        `it gates). Declare a producers: entry naming the intended evidence ` +
        `flow — an ask-kind producer for operator-in-the-loop approval ` +
        `(alongside the mcp recovery producer the schema requires), or an ` +
        `agent recipe if the gate is a deliberate process gate. See ` +
        `docs/writing-custom-policies.md ("The trust model").`,
    });
  }
  return diags;
}

// M7 validate lint: a policy that gates on risk.* / action.reversible clauses
// WITHOUT an environment.name clause fires on EVERY unclassified command in
// EVERY environment because those three clauses fail-closed to matched=true
// when the action is unclassified ("unknown is not safe"). This is almost
// never what the operator intends: an unscoped risk policy becomes a blanket
// gate on any command the classifier does not recognise. See docs/risk-gate.md.
export function checkPolicyRiskWithoutEnvScope(manifest: Manifest): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (let i = 0; i < manifest.policies.length; i++) {
    const p = manifest.policies[i];
    if (!p?.when) continue;
    const when = p.when;
    // The three clauses that fail-closed to matched=true for an unclassified
    // action. An environment.name clause constrains the scope, so we only
    // warn when it is absent.
    const hasUnclassifiedFallbackClause =
      when["risk.severity_at_least"] !== undefined ||
      when["risk.category_in"] !== undefined ||
      when["action.reversible"] !== undefined;
    const hasEnvNameScope = when["environment.name"] !== undefined;
    if (hasUnclassifiedFallbackClause && !hasEnvNameScope) {
      diags.push({
        severity: "warning",
        path: `policies[${i}]`,
        message:
          `policy "${p.name}" declares a when: block with ` +
          `risk.severity_at_least / risk.category_in / action.reversible ` +
          `but no environment.name scope: those clauses fail-closed to ` +
          `matched=true for any unclassified command, so this policy fires ` +
          `on every unclassified action in every environment. ` +
          `Add an environment.name clause to scope the policy to a specific ` +
          `environment. See docs/risk-gate.md.`,
      });
    }
  }
  return diags;
}

// Template-policy drift (task adf037c1): an installed harness.yaml ages in
// place — `harness apply` never retroactively adds newly-shipped default
// policies to an already-materialized manifest, so security policies
// introduced after install reach only fresh installs. The measured
// incident: a 0.44.0 machine whose manifest predated the kill-switch
// defenses (deny-kill-switch-bypass / deny-session-env-strip /
// deny-pause-sentinel-forgery) had the documented `harness pause` bypass
// live as ALLOW, with nothing surfacing the gap.
//
// Scope (operator decision 2026-08-08): compare only the shipped
// `operator_only` (kill-switch / security) policy names — the
// profile-independent security floor — against the installed manifest.
// A missing one is an ERROR (this is a real, exploitable defense gap),
// distinct from a merely-cosmetic drift; non-operator_only policies are
// intentionally not compared so solo/team installs are not nagged for
// full-only convenience policies they never carried.
//
// Two drift shapes are reported, both real aged-manifest bypasses:
//   - MISSING: the shipped operator_only policy name is absent entirely.
//   - DOWNGRADED: a policy of that name IS present but is no longer
//     operator_only (task 2cc73f55's history: these exact policies once
//     shipped with a `requires.ledger_tag` shape a ledger write could
//     satisfy; a manifest that kept the name but not operator_only:true
//     has a bypassable kill-switch). Name-presence alone would pass it as
//     no-drift, which is exactly the class this check exists to catch
//     (review finding 2026-08-08). operator_only:true is the single
//     sufficient predicate: the schema's superRefine forces enforcement
//     block for operator_only policies, so any downgrade (warn, a
//     requires: shape, operator_only dropped) fails this test.
//
// Deliberate opt-out (operator decision 2026-08-08): a name listed in
// `doctor.ignore_template_drift` is skipped ENTIRELY (both shapes). This
// is NOT a `policies[].enabled` flag — such a flag would be read here but
// ignored by the runtime engine, so an operator would believe a policy
// disabled while it still fired. The ignore-list only ever silences THIS
// report and changes no enforcement, so its meaning is honest. A
// stale/typo'd ignore entry (matching no shipped name) is itself
// surfaced as a warning so a dead opt-out cannot silently stop
// suppressing after a future rename.
export function checkTemplatePolicyDrift(manifest: Manifest): Diagnostic[] {
  const byName = new Map(manifest.policies.map((p) => [p.name, p]));
  const ignored = new Set(manifest.doctor.ignore_template_drift);
  const shipped = shippedOperatorOnlyPolicyNames();
  const diags: Diagnostic[] = [];
  for (const name of shipped) {
    if (ignored.has(name)) continue;
    const installed = byName.get(name);
    if (installed === undefined) {
      diags.push({
        severity: "error",
        path: "policies",
        message:
          `shipped operator_only security policy "${name}" is missing from ` +
          `this manifest, a defense the current template ships but this ` +
          `(older) install never received, so the gate it enforces is silently ` +
          `absent. Re-add the "${name}" policy + its hook from the full ` +
          `template (\`harness init --template full\` in a scratch dir and copy ` +
          `the block, or hand-add per docs/okf/pause-vs-gate-kill-switch.md), ` +
          `or, if you deliberately do not want it, list "${name}" under ` +
          `doctor.ignore_template_drift to acknowledge the opt-out.`,
      });
    } else if (installed.operator_only !== true) {
      diags.push({
        severity: "error",
        path: "policies",
        message:
          `security policy "${name}" is present but DOWNGRADED: the shipped ` +
          `template makes it \`operator_only: true\` (an unconditional deny no ` +
          `in-session evidence can satisfy), but this manifest's copy is not, ` +
          `so its kill-switch is bypassable (e.g. a \`requires:\` shape a ledger ` +
          `write satisfies, or \`enforcement: warn\`). Restore \`operator_only: ` +
          `true\` from the full template, or list "${name}" under ` +
          `doctor.ignore_template_drift if this weakening is deliberate.`,
      });
    }
  }
  // Stale/typo'd opt-out entries: named in ignore_template_drift but not a
  // shipped operator_only policy, so they suppress nothing. Warn (not
  // error) — fail-safe already (the operator keeps seeing any real drift),
  // this only surfaces the dead config so a rename doesn't silently strand
  // an acknowledgement.
  const shippedSet = new Set(shipped);
  for (const name of manifest.doctor.ignore_template_drift) {
    if (!shippedSet.has(name)) {
      diags.push({
        severity: "warning",
        path: "doctor.ignore_template_drift",
        message:
          `doctor.ignore_template_drift lists "${name}", which is not a ` +
          `shipped operator_only policy name — it suppresses nothing. Remove ` +
          `the entry, or fix the name (a policy rename can strand an ` +
          `acknowledgement here).`,
      });
    }
  }
  return diags;
}

// Hook-budget-vs-ledger-timeout margin (task d20a7e0c, follow-up to
// f1aea826/7bf47554). A blocking (`blocking: "hard"`) hook that consults
// the evidence ledger before it can write its own decision is bounded
// TWICE: once by its own `budget_ms` (the runtime's outer kill-timeout —
// Claude Code and Codex both treat a KILLED hook as ALLOW, never as its
// own pending verdict) and once by the ledger round-trip it is waiting
// on. `budget_ms` below `requiredHookBudgetMs(health.timeout_ms)`
// (src/cli/policy/intercept.ts — see that function's doc comment for the
// full derivation from `realLedgerClient`'s own two round-trip shapes)
// means a merely SLOW (not even hard-down) ledger can get the hook
// killed before its fail-closed `deny` / `deny-degraded` JSON reaches
// stdout — silently turning the verdict into an unintended allow,
// defeating the deny-degraded fix (task f1aea826) on exactly the hang
// shape it exists to close.
//
// Two hook populations are checked, both GENERICALLY — unlike
// tests/runtime/hook-budget-ledger-margin.test.ts's pre-d20a7e0c version,
// which hand-imported three specific pack modules and pinned a hardcoded
// 15000ms floor instead of scaling with the manifest's own
// health.timeout_ms:
//   1. `manifest.hooks[]` entries that invoke `harness policy intercept`
//      (recognised via `isPolicyInterceptCommand`, robust to how the
//      operator or a local build spells the leading token — see that
//      function's own doc comment for why a verbatim string compare
//      under-recognises real manifests).
//   2. Every hook an ENABLED `manifest.policy_packs[]` entry resolves to,
//      for every runtime `harness apply` can target (`KNOWN_RUNTIMES`) —
//      iterating whichever packs the operator actually has enabled
//      through the shared `resolveBuiltin` registry lookup, not a
//      hand-maintained list of specific pack modules. Only the subset
//      whose command names one of the LEDGER_CONSULTING_PACK_SUBCOMMANDS
//      below is checked: `solution-acceptance` / `solution-acceptance-
//      writeguard` are DELIBERATELY excluded — they gate on a filesystem
//      verdict marker the producer writes, never a live ledger
//      round-trip (see solution-acceptance.ts's own header comment), so
//      flagging them here would be a false positive.
const LEDGER_CONSULTING_PACK_SUBCOMMANDS = [
  "pack hook branch-protection",
  "pack hook pre-tool-use",
  "pack hook codex-pre-tool-use",
  "pack hook post-merge-gate",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `command` invoke `subcommand` as adjacent, whitespace-separated
 * tokens, regardless of a leading interpreter/env-var prefix or a
 * trailing flag? Mirrors `isPolicyInterceptCommand`'s own reasoning
 * (src/cli/policy/intercept.ts) for the pack-hook subcommand names,
 * which that function does not itself cover (it only recognises `policy
 * intercept`).
 */
function commandInvokesSubcommand(command: string, subcommand: string): boolean {
  const pattern = subcommand.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?:^|[\\s/\\\\])${pattern}(?:\\s|$)`).test(command);
}

function isLedgerConsultingPackCommand(command: string): boolean {
  return LEDGER_CONSULTING_PACK_SUBCOMMANDS.some((s) => commandInvokesSubcommand(command, s));
}

function collectLedgerConsultingBlockingHooks(manifest: Manifest): Hook[] {
  const direct = manifest.hooks.filter(
    (h) => h.blocking === "hard" && isPolicyInterceptCommand(h.command),
  );
  const fromPacks: Hook[] = [];
  for (const pack of manifest.policy_packs) {
    if (!pack.enabled) continue;
    for (const runtime of KNOWN_RUNTIMES) {
      const resolved = resolveBuiltin(pack, runtime);
      // Unresolvable packs (unknown source / unknown builtin name) are
      // already flagged separately by checkPolicyPacks; nothing to
      // classify here.
      if (!resolved) continue;
      for (const hook of resolved.contribution.hooks) {
        if (hook.blocking === "hard" && isLedgerConsultingPackCommand(hook.command)) {
          fromPacks.push(hook);
        }
      }
    }
  }
  return [...direct, ...fromPacks];
}

export function checkHookBudgetLedgerMargin(manifest: Manifest): Diagnostic[] {
  const grounding = manifest.tools.mcp.find(
    (m) => m.name === "grounding-mcp" && m.enabled !== false,
  );
  // No wired producer: `harness policy intercept` falls back to the
  // instant `degradedLedgerClient` (no subprocess, no wait), and a pack
  // blocker with no grounding-mcp entry to query is a separate,
  // already-reported misconfiguration (checkPolicyGroundingMcp). No live
  // ledger round-trip exists here for a margin to protect.
  if (!grounding) return [];
  const ledgerTimeoutMs = grounding.health?.timeout_ms ?? 5000;
  const required = requiredHookBudgetMs(ledgerTimeoutMs);
  const seen = new Set<string>();
  const diags: Diagnostic[] = [];
  for (const hook of collectLedgerConsultingBlockingHooks(manifest)) {
    // Both KNOWN_RUNTIMES resolutions of an enabled pack commonly yield a
    // hook with the same (name, budget_ms) pair — only the match/command
    // wording differs per runtime. De-dupe so one misconfigured budget
    // is reported once, not twice.
    const key = `${hook.name}:${hook.budget_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hook.budget_ms >= required) continue;
    diags.push({
      severity: "error",
      path: `hooks[${hook.name}].budget_ms`,
      message:
        `hook "${hook.name}" carries budget_ms=${hook.budget_ms}, below the ${required}ms this ` +
        `manifest's grounding-mcp health.timeout_ms=${ledgerTimeoutMs}ms requires (2×timeout_ms ` +
        `+ 3× the deny-degraded audit-retry budget — see requiredHookBudgetMs in ` +
        `src/cli/policy/intercept.ts for the derivation). A merely SLOW (not even hard-down) ledger ` +
        `can get this blocking hook killed by the runtime's outer hook timeout before its fail-closed ` +
        `deny JSON reaches stdout — both Claude Code and Codex then read the kill as allow, ` +
        `defeating the deny-degraded fix (task f1aea826) on exactly this hang shape. Raise budget_ms ` +
        `to at least ${required}, or lower tools.mcp.grounding-mcp.health.timeout_ms (which lowers ` +
        `this requirement too, at the cost of a stricter ledger-latency budget); see ` +
        `docs/okf/gate-fail-posture-matrix.md.`,
    });
  }
  return diags;
}

// Phase 6 #2: surface pack-resolution problems at lint time, not at
// `harness apply` time. Delegates to the shared `checkPolicyPackSources`
// so the apply path (which now also fails loudly on these conditions)
// stays bit-identical with validate. `enabled: false` packs are skipped
// on both sides.
function checkPolicyPacks(manifest: Manifest): Diagnostic[] {
  return checkPolicyPackSources(manifest).map((issue) => ({
    severity: "error",
    path: `policy_packs[${issue.packIndex}].${issue.field}`,
    message: issue.message,
  }));
}

// Phase 6 follow-up (task d78fb3c7): per-pack `config:` shape check.
// Each builtin pack registers a zod `configSchema` consumed via
// `checkPolicyPackConfigs`; this turns the strict-mode issues into
// validate Diagnostics so typo'd keys (`permision_profile`) and bad
// enum values (`mode: "fastConfirm"`) fail loud at lint time. Runs
// AFTER the source / name check above; an unknown pack name has no
// registered schema and would be skipped silently here even without
// the source check, but emitting both diagnostics in one run is the
// point — the operator should see every issue per `validate` invocation.
function checkPolicyPackConfigsAsDiagnostics(manifest: Manifest): Diagnostic[] {
  return checkPolicyPackConfigs(manifest).map((issue) => {
    const path =
      issue.configPath.length > 0
        ? `policy_packs[${issue.packIndex}].config.${issue.configPath}`
        : `policy_packs[${issue.packIndex}].config`;
    return {
      severity: "error",
      path,
      message: issue.message,
    };
  });
}

export function runAssetChecks(
  manifest: Manifest,
  opts: CheckOptions = {},
): Diagnostic[] {
  const home = opts.homeDir ?? os.homedir();
  return [
    ...checkMcp(manifest, home),
    ...checkCli(manifest, opts),
    ...checkSkills(manifest, home),
    ...checkHooks(manifest, home),
    ...checkBuiltinDrift(manifest, opts),
    ...checkPolicyGroundingMcp(manifest),
    ...checkSolutionAcceptanceProducer(manifest),
    ...checkSolutionAcceptanceKnobIgnored(
      manifest,
      opts.gitIgnoreProbe ?? createDefaultGitIgnoreProbe(),
    ),
    ...checkPolicyPacks(manifest),
    ...checkPolicyPackConfigsAsDiagnostics(manifest),
    ...checkPolicyRiskWithoutEnvScope(manifest),
    ...checkPolicySelfAttestation(manifest),
    ...checkHookBudgetLedgerMargin(manifest),
  ];
}

export const __testables = {
  expandHome,
  isRootedPath,
  firstToken,
  compareVersions,
  resolveOnPath,
  DEFAULT_RUNTIME_BUILTINS,
};
