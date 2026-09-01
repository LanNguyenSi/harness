// Built-in destructive-shell floor for the Risk Classifier (task 2929c5b7).
//
// WHY THIS IS CODE AND NOT ONLY A MANIFEST PATTERN. `when-eval.ts` no
// longer lets an UNCLASSIFIED action satisfy `risk.severity_at_least:
// critical` on its own. That change ships in the binary and takes effect
// for every install on upgrade. Its compensating half, explicit
// classification for the mutating heads that used to ride the blanket
// fail-close (`dd`, `truncate`, `shred`, `mkfs`, `find -delete`, ...),
// would take effect only for installs that ADOPT the new `dangerous-shell`
// template patterns, because `harness init` writes the manifest once and
// never rewrites it. An existing manifest carrying the original four
// patterns would have kept the loosened fallback and lost the hard block
// in the same upgrade. So the recognition ships HERE, composed into
// `classifyRisk` like the existing built-in floors, and the template
// patterns are its operator-visible, operator-editable mirror.
//
// FLOOR SEMANTICS, same as every other built-in floor: it composes under
// highest-severity-wins. It can only RAISE an action's severity, never
// lower one an operator classifier already assigned, and an operator
// pattern can always raise above it.
//
// SCOPE, deliberately narrow. This is not a general "is this command
// dangerous" oracle and must not grow into one: it recognises a closed set
// of heads whose DESTRUCTIVE INVOCATION SHAPE is decidable from argv
// tokens alone. Anything else stays unclassified and rides the "high" rung
// fallback (approval-gated), which is the honest answer. A truncating
// redirection (`cmd > file`) is NOT recognised here for the same reason it
// is not a template pattern: this module has no redirection model, and a
// text heuristic for a bare `>` over-matches `2>&1`, heredocs, and
// comparison operators. See docs/risk-gate.md.

import type { RiskCategory, RiskSeverity } from "../schema/index.js";
import {
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_TAKING_FLAGS,
  GIT_TOKEN_RE,
  peelWrapperPrefixes,
  type WrapperPeelToken,
} from "./command-normalize.js";
import { decodeShellWord } from "./shell-word.js";

/** One recognised destructive invocation. */
export interface DestructiveFloorHit {
  severity: RiskSeverity;
  categories: readonly RiskCategory[];
  /** Human-readable, appended to the profile's `reasons`. */
  reason: string;
}

// Shell boundary characters. The command text is split on these before any
// head resolution, so a destructive invocation after `;`, `&&`, `||`, `|`,
// `&`, a subshell paren, or a newline is still examined. Splitting is
// deliberately NOT quote-aware: over-splitting inside a quoted string only
// produces MORE candidate heads to examine, which is the safe direction
// for a floor that raises severity. Under-splitting is what would hide a
// destructive tail, and that cannot happen here.
const BOUNDARY_SPLIT_RE = /[;&|()\n]+/;

/** Multi-call binaries: `busybox dd if=... of=...` really runs `dd`. */
const MULTICALL_HEADS: ReadonlySet<string> = new Set(["busybox", "toybox"]);

/** Shells whose `-c` argument is a nested command string. */
const SHELL_HEADS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash",
]);

/** Depth bound for `sh -c "sh -c ..."` nesting. */
const MAX_NESTING_DEPTH = 4;

/**
 * Recognise every built-in destructive invocation in `command`.
 *
 * Pure and linear in the length of the command: whitespace tokenisation,
 * set lookups, and a bounded wrapper peel. No regex with a backtracking
 * risk runs over the command text (`BOUNDARY_SPLIT_RE` is a character
 * class), so this may be called on the UNCAPPED command string, which it
 * must be, so a destructive tail past the classifier's 16 KiB ReDoS cap
 * cannot be laundered by a long benign head.
 */
export function classifyDestructiveShellFloor(command: string): DestructiveFloorHit[] {
  const hits: DestructiveFloorHit[] = [];
  scanCommand(command, 0, hits);
  return dedupe(hits);
}

function dedupe(hits: readonly DestructiveFloorHit[]): DestructiveFloorHit[] {
  const seen = new Set<string>();
  const out: DestructiveFloorHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.reason)) continue;
    seen.add(hit.reason);
    out.push(hit);
  }
  return out;
}

function scanCommand(command: string, depth: number, hits: DestructiveFloorHit[]): void {
  if (depth > MAX_NESTING_DEPTH) return;

  // WHOLE-STRING pass first, and only for the `<shell> -c "<command>"`
  // shape. The boundary split below is not quote-aware, so it would tear
  // `sh -c "dd if=x of=y; rm -rf /"` apart mid-quote and leave the nested
  // `dd` unrecognisable. Resolving the shell head before splitting keeps
  // the nested command intact for the recursive scan.
  const wholeTokens = tokenize(command);
  const wholeHead = resolveHead(wholeTokens);
  if (wholeHead !== null && SHELL_HEADS.has(wholeHead.name)) {
    scanShellDashC(wholeTokens.slice(wholeHead.idx + 1), depth, hits);
  }

  for (const piece of command.split(BOUNDARY_SPLIT_RE)) {
    const tokens = tokenize(piece);
    if (tokens.length === 0) continue;
    scanInvocation(tokens, depth, hits);
  }
}

function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter((t) => t !== "");
}

/**
 * Resolve the real head of one invocation: peel `VAR=x` assignments and
 * the `sudo`/`env`/`command`/`timeout`/... wrapper chain, then any
 * `busybox`/`toybox` multi-call prefix. Returns the head's literal name
 * (decoded, path prefix stripped) and its token index, or `null` when no
 * head token survives.
 */
function resolveHead(rawTokens: readonly string[]): { name: string; idx: number } | null {
  // Basename + decode every token that is not a flag and not a `NAME=value`
  // assignment, so `/bin/dd`, `/usr/bin/env`, and `"sudo"` all resolve like
  // their bare spellings. Assignments and `of=`-style operands keep their
  // text (their `=` is load-bearing), and flags keep theirs (a flag has no
  // path prefix to strip).
  const peelTokens: WrapperPeelToken[] = rawTokens.map((t) => ({ text: headNameOf(t) }));

  let idx = 0;
  for (let guard = 0; guard <= MAX_NESTING_DEPTH; guard += 1) {
    const before = idx;
    // Shared wrapper vocabulary (`peelWrapperPrefixes`, command-normalize.ts)
    // rather than a second hand-rolled copy of it: a wrapper added there
    // benefits this floor automatically.
    idx = peelWrapperPrefixes(peelTokens, idx).idx;
    const peeled = peelTokens[idx]?.text;
    if (peeled !== undefined && MULTICALL_HEADS.has(peeled)) {
      idx += 1;
      continue;
    }
    if (idx === before) break;
  }

  const name = peelTokens[idx]?.text;
  return name === undefined ? null : { name, idx };
}

/** Resolve one boundary-delimited invocation's head, then dispatch on it. */
function scanInvocation(rawTokens: readonly string[], depth: number, hits: DestructiveFloorHit[]): void {
  const resolved = resolveHead(rawTokens);
  if (resolved === null) return;
  const head = resolved.name;
  const args = rawTokens.slice(resolved.idx + 1);

  if (SHELL_HEADS.has(head)) {
    scanShellDashC(args, depth, hits);
    return;
  }
  if (head === "dd") return scanDd(args, hits);
  if (head === "truncate") return scanTruncate(args, hits);
  if (head === "shred") {
    hits.push({
      severity: "critical",
      categories: ["destructive", "data_loss", "irreversible_action"],
      reason: "built-in destructive floor: shred overwrites a file in place",
    });
    return;
  }
  if (head === "mkfs" || head.startsWith("mkfs.")) {
    hits.push({
      severity: "critical",
      categories: ["destructive", "data_loss", "infrastructure_change"],
      reason: "built-in destructive floor: mkfs formats a filesystem",
    });
    return;
  }
  if (head === "find") return scanFind(args, hits);
  if (GIT_TOKEN_RE.test(head)) return scanGit(args, hits);
  if (head === "chmod" || head === "chown") return scanChmodChown(head, args, hits);
  if (head === "sed") return scanSed(args, hits);
  if (head === "curl") return scanCurl(args, hits);
}

/**
 * `sh -c "<command>"` / `bash -lc '<command>'`: the nested command string
 * is re-scanned from the top. The `-c` value is reconstructed by rejoining
 * the tokens after the flag run (the whitespace tokenizer split the quoted
 * string apart) and stripping one layer of surrounding quotes.
 */
function scanShellDashC(args: readonly string[], depth: number, hits: DestructiveFloorHit[]): void {
  let i = 0;
  let sawDashC = false;
  for (; i < args.length; i += 1) {
    const t = decodeShellWord(args[i]!);
    if (!t.startsWith("-")) break;
    if (t === "--") {
      i += 1;
      break;
    }
    if (!t.startsWith("--") && t.includes("c")) {
      sawDashC = true;
      i += 1;
      break;
    }
    if (t === "--command") {
      sawDashC = true;
      i += 1;
      break;
    }
  }
  if (!sawDashC) return;
  const nested = stripOuterQuotes(args.slice(i).join(" "));
  if (nested === "") return;
  scanCommand(nested, depth + 1, hits);
}

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0]!;
    const last = t[t.length - 1]!;
    if ((first === "'" || first === '"') && first === last) return t.slice(1, -1);
  }
  return t;
}

/**
 * The literal name a head token invokes: decoded, with any path prefix
 * stripped. `NAME=value` assignment tokens and flags are returned
 * unchanged (stripping a `/` out of an assignment's VALUE would corrupt
 * the token `peelWrapperPrefixes` needs to recognise, and a flag has no
 * path prefix).
 */
function headNameOf(token: string): string {
  const decoded = decodeShellWord(token);
  if (decoded.startsWith("-")) return decoded;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(decoded)) return decoded;
  const slash = decoded.lastIndexOf("/");
  return slash === -1 ? decoded : decoded.slice(slash + 1);
}

/** `true` when `arg`, raw or decoded, satisfies `pred`. */
function eitherForm(arg: string, pred: (t: string) => boolean): boolean {
  return pred(arg) || pred(decodeShellWord(arg));
}

/** `true` when `t` is a single-dash short-flag cluster containing `ch`. */
function shortClusterHas(t: string, ch: string): boolean {
  return t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes(ch);
}

// `dd` writes only when it is given an output file. `dd if=/dev/sda | gzip`
// (a read into a pipe) is deliberately NOT floored: it mutates nothing, and
// flooring it would hard-block a backup on a production-resolved session,
// the exact false positive this task exists to remove.
function scanDd(args: readonly string[], hits: DestructiveFloorHit[]): void {
  if (!args.some((a) => eitherForm(a, (t) => t.startsWith("of=")))) return;
  hits.push({
    severity: "critical",
    categories: ["destructive", "data_loss"],
    reason: "built-in destructive floor: dd with an of= write target",
  });
}

// `truncate -s <size>` / `--size=<size>`, including the glued `-s0` form
// and any cluster carrying `s` (`-cs 0`). Without a size there is nothing
// to truncate to.
function scanTruncate(args: readonly string[], hits: DestructiveFloorHit[]): void {
  const sized = args.some((a) =>
    eitherForm(a, (t) => t === "--size" || t.startsWith("--size=") || shortClusterHas(t, "s")),
  );
  if (!sized) return;
  hits.push({
    severity: "critical",
    categories: ["destructive", "data_loss"],
    reason: "built-in destructive floor: truncate with a size argument",
  });
}

// `find ... -delete` and `find ... -exec/-execdir rm`. Both spellings are
// compared raw OR decoded, the measured bypass class from task fdee7d0f
// (`-"delete"`, `-'delete'`, `-\delete` all reach find as `-delete`).
function scanFind(args: readonly string[], hits: DestructiveFloorHit[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (eitherForm(a, (t) => t === "-delete")) {
      hits.push({
        severity: "critical",
        categories: ["destructive", "data_loss"],
        reason: "built-in destructive floor: find -delete",
      });
      continue;
    }
    if (eitherForm(a, (t) => t === "-exec" || t === "-execdir")) {
      const payload = args[i + 1];
      if (payload !== undefined && headNameOf(payload) === "rm") {
        hits.push({
          severity: "critical",
          categories: ["destructive", "data_loss"],
          reason: "built-in destructive floor: find -exec rm",
        });
      }
    }
  }
}

/**
 * git's own global options sit BETWEEN the binary and the subcommand
 * (`git -C /repo push -f`), so they are skipped before the subcommand is
 * read, reusing command-normalize.ts's exported flag sets. `-c` is
 * deliberately absent from `GIT_GLOBAL_VALUE_TAKING_FLAGS` (config
 * injection can execute code); a command carrying it stops the walk and
 * simply yields no subcommand here.
 */
function scanGit(args: readonly string[], hits: DestructiveFloorHit[]): void {
  let i = 0;
  while (i < args.length) {
    const t = decodeShellWord(args[i]!);
    if (!t.startsWith("-")) break;
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(t)) {
      i += 1;
      continue;
    }
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    if (GIT_GLOBAL_VALUE_TAKING_FLAGS.has(name)) {
      i += eq === -1 ? 2 : 1;
      continue;
    }
    break;
  }
  const sub = args[i] === undefined ? "" : decodeShellWord(args[i]!);
  const subArgs = args.slice(i + 1);
  const push = (categories: readonly RiskCategory[], reason: string): void => {
    hits.push({ severity: "high", categories, reason: `built-in destructive floor: ${reason}` });
  };

  if (sub === "reset" && subArgs.some((a) => eitherForm(a, (t) => t === "--hard"))) {
    push(["destructive", "data_loss"], "git reset --hard");
    return;
  }
  if (sub === "push") {
    const forced = subArgs.some((a) =>
      eitherForm(
        a,
        (t) =>
          t === "--force" ||
          t === "--force-with-lease" ||
          t.startsWith("--force-with-lease=") ||
          t.startsWith("+") ||
          shortClusterHas(t, "f"),
      ),
    );
    if (forced) push(["destructive", "production_mutation", "deployment_change"], "git push --force");
    return;
  }
  if (sub === "clean") {
    const forced = subArgs.some((a) =>
      eitherForm(a, (t) => t === "--force" || shortClusterHas(t, "f")),
    );
    if (forced) push(["destructive", "data_loss"], "git clean --force");
    return;
  }
  if (sub === "checkout" || sub === "restore") {
    const operands = subArgs.map((a) => decodeShellWord(a)).filter((t) => t !== "--");
    if (operands.length === 1 && operands[0] === ".") {
      push(["destructive", "data_loss"], `git ${sub} . discards every uncommitted change`);
    }
  }
}

// `chmod -R` / `chown -R` (and `--recursive`), cluster-aware so `-Rf` and
// `-fR` are both caught. Categories: `mass_update` only, deliberately NOT
// `destructive`/`data_loss`: a recursive mode or owner change rewrites
// metadata across a tree (worth a `high` gate) but is reversible by the
// inverse command, so the profile stays `reversible: true`.
function scanChmodChown(head: string, args: readonly string[], hits: DestructiveFloorHit[]): void {
  const recursive = args.some((a) =>
    eitherForm(a, (t) => t === "--recursive" || shortClusterHas(t, "R")),
  );
  if (!recursive) return;
  hits.push({
    severity: "high",
    categories: ["mass_update"],
    reason: `built-in destructive floor: ${head} -R rewrites a whole tree`,
  });
}

// `sed -i` in every spelling: `-i`, `-i.bak`, the cluster `-ni`,
// `--in-place`, `--in-place=SUFFIX`.
function scanSed(args: readonly string[], hits: DestructiveFloorHit[]): void {
  const inPlace = args.some((a) =>
    eitherForm(
      a,
      (t) => t === "--in-place" || t.startsWith("--in-place=") || shortClusterHas(t, "i"),
    ),
  );
  if (!inPlace) return;
  hits.push({
    severity: "high",
    categories: ["destructive", "data_loss"],
    reason: "built-in destructive floor: sed in-place edit",
  });
}

/** curl flags that write a LOCAL file. */
const CURL_LOCAL_WRITE_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--output", "--remote-name", "--dump-header", "--cookie-jar", "--config",
  "--create-dirs", "--output-dir", "--etag-save", "--trace", "--trace-ascii",
  "--stderr", "--remote-header-name",
]);
const CURL_LOCAL_WRITE_SHORT_CHARS: readonly string[] = ["o", "O", "D", "c", "K"];
/** curl flags that send a REQUEST BODY (making the request a write). */
const CURL_BODY_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii",
  "--json", "--form", "--form-string", "--form-escape", "--upload-file",
]);
const CURL_BODY_SHORT_CHARS: readonly string[] = ["d", "F", "T"];

// The mirror image of `isReadOnlyCurlCommand`'s allowlist: that predicate
// decides what may be floored DOWN to `low`, this one decides what is
// floored UP to `high`. They are deliberately not complements: a curl
// carrying a flag neither set names (say a future `--http4`) forfeits the
// read-only floor AND misses this one, and stays unclassified, which is
// the honest answer for a flag nobody has reasoned about.
function scanCurl(args: readonly string[], hits: DestructiveFloorHit[]): void {
  let localWrite = false;
  let body = false;
  for (let i = 0; i < args.length; i += 1) {
    const t = decodeShellWord(args[i]!);
    if (!t.startsWith("-") || t === "-" || t === "--") continue;
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    if (name === "--request" || (t.startsWith("-X") && !t.startsWith("--"))) {
      let value: string | undefined;
      if (name === "--request") {
        value = eq === -1 ? (args[i + 1] === undefined ? undefined : decodeShellWord(args[i + 1]!)) : t.slice(eq + 1);
      } else {
        const glued = t.slice(2);
        value = glued.length > 0 ? glued : args[i + 1] === undefined ? undefined : decodeShellWord(args[i + 1]!);
      }
      const method = (value ?? "").toUpperCase();
      if (method !== "" && method !== "GET" && method !== "HEAD") body = true;
      continue;
    }
    if (CURL_LOCAL_WRITE_LONG_FLAGS.has(name)) {
      localWrite = true;
      continue;
    }
    if (CURL_BODY_LONG_FLAGS.has(name)) {
      body = true;
      continue;
    }
    if (t.startsWith("--")) continue;
    if (CURL_LOCAL_WRITE_SHORT_CHARS.some((c) => shortClusterHas(t, c))) localWrite = true;
    if (CURL_BODY_SHORT_CHARS.some((c) => shortClusterHas(t, c))) body = true;
  }
  if (localWrite) {
    hits.push({
      severity: "high",
      categories: ["destructive", "data_loss"],
      reason: "built-in destructive floor: curl writes a local file",
    });
  }
  if (body) {
    hits.push({
      severity: "high",
      categories: ["production_mutation", "network_exfiltration"],
      reason: "built-in destructive floor: curl sends a request body or a non-GET/HEAD method",
    });
  }
}
