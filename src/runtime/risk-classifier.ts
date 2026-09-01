// Phase 7 #3 — Risk Classifier.
//
// Assigns an Action Envelope a risk profile by regex-matching the
// manifest's `risk.classifiers[]` against the action. The first Risk
// Gate stage that reads the `risk:` schema vocabulary shipped in
// Phase 7 #1.
//
// STATUS: consumed by `harness policy intercept` (Phase 7 #5) and by the
// `harness test-risk` debug verb (Phase 7 #3). See docs/risk-gate.md and
// docs/ROADMAP.md.
//
// "Unknown is not safe": an envelope no pattern matches yields a
// profile with `classified: false` and `severity: null`, deliberately
// NOT a low/zero-risk profile. The Phase 7 #5 policy evaluator must
// treat an unclassified action as risk-bearing rather than allow it by
// default; this module's job is only to report the unclassified state
// honestly.
//
// The built-in exceptions are floors, not overrides, and each composes
// under the same highest-severity-wins rule as an operator pattern:
// harness's own benign meta-commands (see BENIGN_HARNESS_COMMAND below),
// the read-only-command / kubectl / sed `low` floors, and (since
// task 2929c5b7) the DESTRUCTIVE floor (`destructive-shell-floor.ts`),
// which recognizes `dd of=`, `truncate -s`, `shred`, `mkfs`, `find
// -delete` and friends in the binary so an install that never adopts the
// new `dangerous-shell` template patterns still classifies them.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md
// (design phase B).

import type {
  RiskCategory,
  RiskClassifier,
  RiskSeverity,
} from "../schema/index.js";
import { RiskSeveritySchema } from "../schema/index.js";
import type { ActionEnvelope } from "./action-envelope.js";
import { expandToolNameAliases, extractShellCommand } from "./tool-name-aliases.js";
import {
  isReadOnlyBashCommand,
  isReadOnlyKubectlCommand,
  isReadOnlySedCommand,
} from "./read-only-bash.js";
import { classifyDestructiveShellFloor } from "./destructive-shell-floor.js";

// Ordered severity scale: a value's index here is the comparison key
// for "highest matched severity wins". Sourced from the schema enum so
// a future reordering there flows through unchanged.
const SEVERITY_ORDER: readonly RiskSeverity[] = RiskSeveritySchema.options;

// Categories that mean the action does not cleanly undo itself. When a
// matched pattern carries any of these the profile is `reversible:
// false`. `destructive` and `data_loss` are included alongside the
// explicit `irreversible_action`: a regex classifier cannot prove an
// action is safely undoable, and the Risk Gate exists to err toward
// caution. A genuinely destructive-but-reversible action simply should
// not be tagged `destructive` by its classifier author.
const IRREVERSIBLE_CATEGORIES: ReadonlySet<RiskCategory> = new Set<RiskCategory>(
  ["irreversible_action", "data_loss", "destructive"],
);

// Built-in benign-harness-command floor.
//
// harness's own read-only and gate-producer subcommands are benign: they
// read state, record evidence, or print diagnostics, and several
// (`harness preflight`, `harness session-start`) are REQUIRED by other
// harness gates (require-preflight-evidence et al). Leaving them
// unclassified lets the "unknown is not safe" fail-close treat them as
// risk-bearing, so a `when: { risk.severity_at_least: critical,
// environment.name: production }` policy HARD-DENIES `harness preflight`
// the moment a session resolves to production (a main / release branch)
// — deadlocking against the very gate that demands it. So we recognize
// these as a `low`-severity floor.
//
// Floor, not override: the contribution composes with operator
// classifiers under the same highest-severity-wins rule, so
// `harness preflight && rm -rf /var` still classifies `critical` (the
// dangerous-shell tail wins) and an operator pattern can only RAISE the
// severity, never sink below this floor. Mutating subcommands (`apply`,
// `init`, `add`, `adopt`, `remove`, `pack`, `uninstall`, `migrate-home`,
// `smoke`, `gate`, `pause`, `resume`) are deliberately excluded — they
// stay classifiable. Anchored at the command head, so `cd /x && harness
// preflight` does NOT match and stays unclassified (fail-safe = denied):
// a benign prefix must not launder a non-harness command.
const BENIGN_HARNESS_SUBCOMMANDS: readonly string[] = [
  "preflight",
  "session-start",
  "approve",
  "doctor",
  "validate",
  "describe",
  "list",
  "diff",
  "explain",
  "explain-action",
  "explain-policy",
  "test-risk",
  "resolve-env",
  "audit",
  "session-export",
  "dry-run",
  "export",
  "help",
];

const BENIGN_HARNESS_COMMAND = new RegExp(
  `^\\s*harness\\s+(?:${BENIGN_HARNESS_SUBCOMMANDS.join("|")})\\b`,
);

export type RiskConfidence = "high" | "low";

export interface RiskProfile {
  /** Did any classifier pattern match the action? */
  classified: boolean;
  /**
   * Highest matched severity, or `null` when unclassified. `null` is
   * NOT "low" — see the module header on "unknown is not safe".
   */
  severity: RiskSeverity | null;
  /** Union of every matched pattern's categories, sorted and deduplicated. */
  categories: RiskCategory[];
  /**
   * `false` when a matched category marks the action irreversible,
   * `true` when classified and nothing marks it irreversible, `null`
   * when unclassified (reversibility is unknown, not assumed).
   */
  reversible: boolean | null;
  /**
   * `high` for any deterministic rule match, `low` when unclassified.
   * A regex classifier has no real probability; the field is a
   * placeholder for the v2 LLM-assisted classifier, where a graded
   * confidence becomes meaningful.
   */
  confidence: RiskConfidence;
  /** One human-readable line per matched pattern, or the no-match note. */
  reasons: string[];
}

// Hot-path ReDoS guard (Phase 7 #6). As of Phase 7 #5/#6 the classifier
// runs operator-authored regexes against tool input on EVERY PreToolUse
// call inside `harness policy intercept`. Catastrophic-backtracking cost
// scales with input length, so the match subject is capped before any
// pattern runs. This bounds the input-length-driven blow-up — the common
// failure mode for a tool call that pipes a large blob through Bash.
//
// It is a mitigation, not a complete fix: harness does NOT screen the
// classifier patterns themselves for catastrophic backtracking. A
// manifest is operator-trusted config — the same contract already stated
// for `environments.resolvers[].kube_context_patterns` in
// docs/risk-gate.md. A pathological *pattern* is a self-inflicted hazard.
//
// 16 KiB comfortably covers any real shell command or serialized tool
// input. A genuinely dangerous command longer than the cap still does
// not slip the gate: its head (where `rm -rf` / `terraform destroy` /
// `kubectl delete` live) is within the cap, and an action that ends up
// unclassified is treated as risk-bearing by the `when:` evaluator.
const MAX_SUBJECT_LENGTH = 16 * 1024;

/**
 * The string a classifier's patterns are regex-matched against. For a
 * shell-class tool (or any tool whose input carries a `command` / `cmd`
 * field) it is that command. For other tools it is the serialized raw
 * input — blunt, but it keeps non-shell classifiers usable in the MVP.
 *
 * The result is capped at `MAX_SUBJECT_LENGTH` (ReDoS guard, see above).
 */
function subjectFor(envelope: ActionEnvelope): string {
  const subject = rawSubjectFor(envelope);
  return subject.length > MAX_SUBJECT_LENGTH
    ? subject.slice(0, MAX_SUBJECT_LENGTH)
    : subject;
}

function rawSubjectFor(envelope: ActionEnvelope): string {
  const command = extractShellCommand({ raw_input: envelope.raw_input });
  if (command !== null) return command;
  const raw = envelope.raw_input;
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

/** A classifier applies when its `tool` is an alias of the envelope's tool. */
function classifierApplies(
  classifier: RiskClassifier,
  envelope: ActionEnvelope,
): boolean {
  return expandToolNameAliases(envelope.tool).includes(classifier.tool);
}

/**
 * Classify an Action Envelope against the manifest's risk classifiers.
 *
 * Pure: envelope + classifiers in, profile out, no I/O. Multiple
 * matching patterns compose — highest severity wins, categories union,
 * one `reasons` line per hit. An envelope no pattern matches yields the
 * honest unclassified profile (`classified: false`, `severity: null`).
 */
export function classifyRisk(
  envelope: ActionEnvelope,
  classifiers: readonly RiskClassifier[],
): RiskProfile {
  const applicable = classifiers.filter((c) => classifierApplies(c, envelope));
  const subject = subjectFor(envelope);

  const categories = new Set<RiskCategory>();
  const reasons: string[] = [];
  let severityIdx = -1;

  for (const classifier of applicable) {
    for (const pat of classifier.patterns) {
      let re: RegExp;
      try {
        re = new RegExp(pat.pattern);
      } catch {
        // The schema regex-validates patterns at parse time; this guard
        // only covers a manifest that bypassed `harness validate`.
        continue;
      }
      if (!re.test(subject)) continue;
      for (const cat of pat.categories) categories.add(cat);
      const idx = SEVERITY_ORDER.indexOf(pat.severity);
      if (idx > severityIdx) severityIdx = idx;
      reasons.push(
        `classifier "${classifier.name}" pattern /${pat.pattern}/ matched: ` +
          `severity ${pat.severity}, categories [${pat.categories.join(", ")}]`,
      );
    }
  }

  // Built-in floors. Folded in AFTER the operator loop so they compose by
  // the same highest-severity-wins rule: the benign ones only raise an
  // otherwise-unclassified action up to `low`, and never sink an operator
  // match (a dangerous tail in `harness preflight && rm -rf /var` keeps
  // the higher severity, and a chained command is not read-only); the
  // destructive one raises to `high`/`critical` and is evaluated first,
  // so a recognized mutating head never also takes a benign floor. All
  // of them are gated on a real shell command so a non-shell tool whose
  // serialized input happens to look benign cannot match.
  const shellCommand = extractShellCommand({ raw_input: envelope.raw_input });
  if (shellCommand !== null) {
    // Built-in DESTRUCTIVE floor (task 2929c5b7), evaluated before the
    // benign floors below so a recognized mutating head keeps them from
    // firing at all. It ships in the binary rather than only as a
    // `dangerous-shell` template pattern because `harness init` writes a
    // manifest once and never rewrites it: an install carrying the
    // original four patterns would otherwise take `when-eval.ts`'s
    // loosened `severity_at_least: critical` fallback on upgrade WITHOUT
    // the compensating classification. See
    // `destructive-shell-floor.ts`'s module header and docs/risk-gate.md.
    //
    // Same composition rule as every other floor: highest severity wins,
    // categories union. An operator pattern can raise above it; nothing
    // sinks below it.
    //
    // Pass the UNCAPPED shellCommand for the same reason the read-only
    // floor does (see below): the floor's scan is linear-time, and a
    // destructive tail past the 16 KiB `subject` cap must not be
    // laundered by a long benign head.
    for (const hit of classifyDestructiveShellFloor(shellCommand)) {
      const idx = SEVERITY_ORDER.indexOf(hit.severity);
      if (idx > severityIdx) severityIdx = idx;
      for (const cat of hit.categories) categories.add(cat);
      reasons.push(`${hit.reason} (severity ${hit.severity})`);
    }

    const lowIdx = SEVERITY_ORDER.indexOf("low");
    if (lowIdx > severityIdx) {
      if (BENIGN_HARNESS_COMMAND.test(subject)) {
        // harness's own benign meta-commands (head-anchored; see
        // BENIGN_HARNESS_COMMAND). Broader than the read-only floor: it
        // also floors gate-PRODUCER commands like `harness preflight`
        // and `harness approve`, which the understanding-gate read-only
        // classifier deliberately excludes.
        severityIdx = lowIdx;
        reasons.push(
          "built-in: benign harness meta-command recognized (severity low)",
        );
      } else if (isReadOnlyBashCommand(shellCommand)) {
        // Any provably read-only command (`git status`, `grep`, `cat`,
        // ...). Without this floor, "unknown is not safe" treats it as
        // risk-bearing and a prod-scoped `risk.severity_at_least` policy
        // denies harmless reads on a main / release branch (the recurring
        // release-cut false-positive). The shared classifier already
        // rejects any chaining / redirection / substitution, so a metachar
        // command can never reach this floor.
        //
        // Pass the UNCAPPED shellCommand, not the 16 KiB-capped `subject`:
        // isReadOnlyBashCommand scans the whole string for write
        // metacharacters, so a tail truncated by the cap (e.g. a hidden
        // `; rm -rf /` past 16 KiB) must not be able to launder a write
        // behind a read-only head. The classifier's checks are linear-time,
        // so the uncapped scan carries no ReDoS risk.
        severityIdx = lowIdx;
        reasons.push(
          "built-in: provably read-only command recognized (severity low)",
        );
      } else if (isReadOnlyKubectlCommand(shellCommand)) {
        // Kubectl read-verb floor (task da823721), narrower than the
        // general read-only floor above and NOT folded into
        // `isReadOnlyBashCommand` itself: it changes only the Risk
        // Classifier's behavior. The understanding-gate PreToolUse
        // blocker and the solution-acceptance write-guard both consume
        // `isReadOnlyBashCommand` directly and keep treating every
        // kubectl invocation as non-read-only, unchanged by this floor.
        // See docs/risk-gate.md's kubectl read-only floor decision for
        // the secrets exclusion and the full blast-radius reasoning.
        severityIdx = lowIdx;
        reasons.push(
          "built-in: provably read-only kubectl verb recognized (severity low)",
        );
      } else if (isReadOnlySedCommand(shellCommand)) {
        // `sed` read-verb floor (task 2929c5b7). Same placement decision
        // as the kubectl floor directly above and for the same measured
        // reason: it is NOT folded into `isReadOnlyBashCommand`, because
        // the understanding-gate PreToolUse blocker and the
        // solution-acceptance write-guard consume that predicate
        // directly and short-circuit on it, so a `sed` recognition there
        // would let `sed 's/a/b/w <verdict-dir>/marker.json' f` past the
        // write-guard. See `isReadOnlySedCommand`'s own docstring for
        // the allowlist and the script scan (sed's `w` command, `s///w`
        // flag, `-f SCRIPTFILE` and GNU `e` all forfeit).
        severityIdx = lowIdx;
        reasons.push(
          "built-in: provably read-only sed invocation recognized (severity low)",
        );
      }
      // NOTE, decision D-013 (task 2929c5b7, review round 3): there is
      // deliberately NO `curl` branch here. Two rounds of this task shipped
      // one and both leaked (a write-flag denylist that missed `-o`, then a
      // flag allowlist that still admitted `-w '%output{FILE}'`, which
      // writes a local file since curl 8.3.0). `curl` stays UNCLASSIFIED
      // like `ssh` and `node -e`: approval-gated by prong (b), never
      // hard-blocked, never floored. Its write-capable spellings are raised
      // to `high` by the destructive floor above instead. See
      // `read-only-bash.ts`'s floor section header.
    }
  }

  if (severityIdx === -1) {
    return {
      classified: false,
      severity: null,
      categories: [],
      reversible: null,
      confidence: "low",
      reasons: [
        applicable.length === 0
          ? `no risk classifier is declared for tool "${envelope.tool}"`
          : `no classifier pattern matched the action for tool "${envelope.tool}"`,
      ],
    };
  }

  const sortedCategories = [...categories].sort();
  return {
    classified: true,
    severity: SEVERITY_ORDER[severityIdx]!,
    categories: sortedCategories,
    reversible: !sortedCategories.some((c) => IRREVERSIBLE_CATEGORIES.has(c)),
    confidence: "high",
    reasons,
  };
}
