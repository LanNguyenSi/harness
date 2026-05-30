// Builtin Policy Pack runtime: `solution-acceptance` (consumer half).
//
// The PRODUCER lives in grounding-mcp (`solution_evaluate` / `solution_gate`,
// @lannguyensi/grounding-mcp >= 0.3.2): it runs a real `preflight run --json`
// and records a HEAD-pinned verdict marker outside the agent-writable
// evidence ledger. harness is the CONSUMER: it reimplements the marker read +
// gate decision here so it carries NO grounding-mcp runtime dependency (the
// same precedent as understanding-before-execution reimplementing its
// approval-marker read). Schema parity with the producer is pinned by a
// golden-fixture test against a real 0.3.2 marker; if grounding-mcp changes
// the Verdict shape, that test fails loudly.
//
// Two enforcement surfaces are built on top of these helpers (see the pack
// definition + the two hook verbs):
//
//   1. completion-gate — denies the task-finishing tools (agent-tasks MCP
//      task_finish / task_submit_pr / task_merge / pull_requests_merge, plus
//      a belt-and-suspenders bash match for `git push` / `gh pr merge`)
//      unless a ready verdict exists at the CURRENT git HEAD.
//
//   2. write-guard — the actual anti-forgery closure. Relocating the verdict
//      dir is NOT sufficient: understanding-gate allows all Bash post-approval
//      (it does no write-target inspection in the allow path), so an approved
//      agent could otherwise hand-write a `ready:true` marker. The write-guard
//      blocks the agent's enumerated write paths into the verdict dir.
//
// Anti-forgery honesty (operator decision, 2026-05-30): v1 closes the
// ENUMERATED-WRITE-PATH residual (the Bash/Edit/Write spellings below), NOT
// arbitrary same-uid forgery. A `0500` chmod on the dir would be incoherent
// here because the producer (grounding-mcp) and the agent share a uid, so it
// would block the producer too. Content-authenticity against an unguarded
// write primitive is closed by marker signing, a cross-repo follow-up that
// already touches the producer. This module must NOT claim the residual is
// fully closed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PolicyPack } from "../../schema/index.js";

export const PACK_NAME = "solution-acceptance";

/**
 * agent-tasks MCP verbs that mark a completion boundary. The gate fires on
 * these (matched by exact tool name `mcp__agent-tasks__<verb>`). These MCP
 * choke points are reliable: unlike the bash matcher they cannot be evaded
 * by shell indirection.
 */
export const DEFAULT_PROTECTED_COMPLETION_TOOLS = [
  "task_finish",
  "task_submit_pr",
  "task_merge",
  "pull_requests_merge",
] as const;

/**
 * Belt-and-suspenders bash matcher for `git push` / `gh pr merge`. Regex on
 * the typed command, so an env-var indirection
 * (`B=main && git push origin $B`) evades it — the MCP verbs above are the
 * load-bearing choke points; hardening this is follow-up `7207d8f9`.
 * Tolerates a leading `cd … &&`, inline `VAR=val` assignments, and `git -C
 * <path> push`.
 */
export const DEFAULT_PUSH_BASH_RE =
  /(?:^|\n|;|\||&&|\()\s*(?:\w+=\S+\s+)*(?:git(?:\s+-C\s+\S+)?\s+push|gh\s+pr\s+merge)\b/;

/**
 * Resolve the completion verbs the gate fires on: the pack's
 * `config.protected_completion_tools` override, else the default set.
 * Always non-empty. Lives here (not in the pack module) so the
 * completion-gate hook can share it without importing the pack's zod
 * surface (mirrors `resolveProtectedBranches` in branch-protection-runtime).
 */
export function resolveProtectedCompletionTools(pack: PolicyPack): string[] {
  const raw = (pack.config as Record<string, unknown>)["protected_completion_tools"];
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((t) => typeof t === "string" && t.length > 0)
  ) {
    return raw as string[];
  }
  return [...DEFAULT_PROTECTED_COMPLETION_TOOLS];
}

// ── Verdict marker contract (mirror of grounding-mcp solution-verdict.ts) ──

/** The verdict marker the producer writes. Keep field-for-field with grounding-mcp. */
export interface Verdict {
  id: string;
  head: string;
  ready: boolean;
  confidence: number;
  blockers: string[];
  timestamp: string;
  source: string;
}

/** Env knob that overrides the verdict directory (mirrors the producer). */
export const VERDICT_DIR_ENV = "SOLUTION_VERDICT_DIR";

/**
 * Stable tail of the default verdict dir. The write-guard's reference
 * detection matches on this so ANY spelling of the home prefix is caught
 * (`~/.local/state/...`, `$HOME/...`, `$XDG_STATE_HOME/...`, the literal
 * absolute path).
 */
export const VERDICT_DIR_TAIL = path.join("agent-grounding", "solution-verdicts");

/**
 * Resolve the verdict directory. Resolution order MUST match grounding-mcp's
 * `verdictDir()` so the consumer reads exactly where the producer writes
 * (operator decision B: both sides use the producer default; no apply-time
 * env threading, no divergence risk):
 *   1. SOLUTION_VERDICT_DIR
 *   2. $XDG_STATE_HOME/agent-grounding/solution-verdicts
 *   3. ~/.local/state/agent-grounding/solution-verdicts
 */
export function verdictDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env[VERDICT_DIR_ENV];
  if (override && override.trim().length > 0) return override;
  const xdg = env["XDG_STATE_HOME"];
  const base =
    xdg && xdg.trim().length > 0 ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "agent-grounding", "solution-verdicts");
}

/**
 * Reduce a verdict id to a single safe path segment. Mirrors the producer's
 * `sanitizeVerdictId`: non-portable chars collapse to `_`, `path.basename`
 * strips any residual separator (path-traversal guard), empty / dot-only ids
 * are rejected.
 */
export function sanitizeVerdictId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const base = path.basename(cleaned);
  if (base === "" || base === "." || base === "..") {
    throw new Error(`invalid verdict id: ${JSON.stringify(id)}`);
  }
  return base;
}

export function verdictPathFor(dir: string, id: string): string {
  return path.join(dir, `${sanitizeVerdictId(id)}.json`);
}

/**
 * Read + validate the verdict marker for `id`, or null when it is absent,
 * unparseable, a symlink, or not a regular file. The lstat + symlink reject
 * mirrors `checkApprovalMarker`: defense-in-depth against a symlink planted
 * at the marker path pointing at agent-controlled content.
 */
export function readVerdict(dir: string, id: string): Verdict | null {
  let p: string;
  try {
    p = verdictPathFor(dir, id);
  } catch {
    return null; // invalid id
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Verdict>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.head !== "string" ||
      typeof parsed.ready !== "boolean"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      head: parsed.head,
      ready: parsed.ready,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      source: typeof parsed.source === "string" ? parsed.source : "",
    };
  } catch {
    return null;
  }
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  verdict: Verdict | null;
}

/**
 * Evaluate the gate for `id` at `currentHead`. Mirrors grounding-mcp
 * `evaluateGate` EXACTLY: allow iff `verdict.ready === true` AND
 * `verdict.head === currentHead`. `confidence` is INFORMATIONAL ONLY and
 * never gates — a `ready:true confidence:0` verdict at HEAD passes — so the
 * harness consumer stays byte-parity with the producer's `solution_gate`
 * (an operator running `solution_gate` and the harness gate must agree).
 */
export function evaluateGate(
  verdict: Verdict | null,
  currentHead: string | null,
  id: string,
): GateResult {
  if (!verdict) {
    return {
      allowed: false,
      reason: `no solution-acceptance verdict recorded for "${id}" (run mcp__agent-grounding__solution_evaluate first)`,
      verdict: null,
    };
  }
  if (!verdict.ready) {
    const why = verdict.blockers.length > 0 ? `: ${verdict.blockers.join("; ")}` : "";
    return {
      allowed: false,
      reason: `solution-acceptance verdict for "${id}" is not ready${why} (fix, then re-run solution_evaluate)`,
      verdict,
    };
  }
  if (!currentHead) {
    return {
      allowed: false,
      reason: `cannot resolve the current git HEAD to confirm the verdict for "${id}" is at HEAD`,
      verdict,
    };
  }
  if (verdict.head !== currentHead) {
    return {
      allowed: false,
      reason: `stale solution-acceptance verdict for "${id}": recorded at ${verdict.head.slice(0, 7)}, current HEAD ${currentHead.slice(0, 7)} (re-run solution_evaluate after the rework)`,
      verdict,
    };
  }
  return {
    allowed: true,
    reason: `solution-acceptance verdict for "${id}" is ready at HEAD ${currentHead.slice(0, 7)} (confidence ${Math.round(verdict.confidence * 100)}%)`,
    verdict,
  };
}

// ── Write-guard target detection ──

/**
 * Is `target` inside `dir` after resolution? Used for the path-tool arm
 * (Write/Edit/MultiEdit/NotebookEdit `file_path`) and for a Bash shell whose
 * cwd is the protected dir. A relative `target` resolves against `cwd`
 * (falling back to process.cwd()).
 */
export function isInsideDir(target: string, dir: string, cwd?: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  const absDir = path.resolve(dir);
  const absTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(cwd ?? process.cwd(), target);
  const rel = path.relative(absDir, absTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Does a Bash command TEXTUALLY reference the verdict dir? Catches the
 * enumerated spellings without shell-evaluating (same contract as
 * read-only-bash):
 *   - the literal absolute dir,
 *   - the `$SOLUTION_VERDICT_DIR` env token,
 *   - the stable tail `agent-grounding/solution-verdicts` (covers `~/...`,
 *     `$HOME/...`, `$XDG_STATE_HOME/...`, and absolute spellings), and
 *   - the dir's LEAF segment (`solution-verdicts` for the default).
 *
 * The leaf segment closes the `cd <parent> && write <relative-into-dir>`
 * descent (where the parent path and the child redirect never form the
 * contiguous tail): ANY relative write into the dir from a cwd that is not
 * the dir itself must name the leaf somewhere in the command, and a
 * `cd <…/leaf>` to first make cwd==dir would itself contain the leaf. The
 * write-guard's cwd-inside check covers the only remaining case (cwd already
 * inside the dir). The leaf needle is length-guarded so a short custom
 * basename does not over-block; the default leaf is distinctive, and a
 * non-default dir already warns at validate time.
 *
 * `chmod`/`chattr` that target the dir are caught the same way, so the
 * FS-perm-loosening attack is covered.
 *
 * Honest residual: a path constructed at runtime inside an interpreter with
 * no textual reference (e.g. base64-decoded inside `python3 -c`) is NOT
 * caught. That is what marker signing (follow-up) closes.
 */
export function bashReferencesVerdictDir(command: string, dir: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  const leaf = path.basename(dir);
  // Direct literal references + the distinctive leaf segment.
  if (
    command.includes(dir) ||
    command.includes(VERDICT_DIR_ENV) ||
    command.includes(VERDICT_DIR_TAIL) ||
    (leaf.length >= 6 && command.includes(leaf))
  ) {
    return true;
  }
  // Glob-obscured references. bash expands `*?[` against EXISTING paths at
  // runtime, so a glob like `solution-ver*/<id>.json` reaches the dir
  // without the literal leaf ever appearing in the command text, and a
  // matching glob can OVERWRITE an existing marker (flipping ready:false ->
  // true). We cannot safely expand globs (that is the shell-eval surface
  // read-only-bash refuses), so when a glob metachar is present we match the
  // leaf's distinctive sub-words: a single glob can split the hyphenated
  // leaf but not erase every >=6-char word of it (`solution-ver*` keeps
  // "solution"; `solu*verdicts` keeps "verdicts"). The leaf words, not the
  // parent segment, are used on purpose: the parent here is `agent-grounding`,
  // which is also a repo name and would over-block legitimate work. A command
  // that globs EVERY path segment is the residual the marker-signing
  // follow-up closes.
  if (/[*?[]/.test(command)) {
    const leafWords = leaf.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 6);
    if (leafWords.some((w) => command.includes(w))) return true;
  }
  return false;
}
