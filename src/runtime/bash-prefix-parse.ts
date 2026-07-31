// Risk Gate resolver input — Bash command-prefix parser.
//
// Two normal POSIX shell idioms slip past the production environment
// resolver when only `process.env` and the hook's starting cwd are
// inspected:
//
//   DATABASE_URL=postgres://prod terraform destroy   # inline env
//   cd /repos/prod-infra && terraform destroy        # working-dir hop
//
// The hook intercept sees Claude Code's process env and starting cwd, so
// `env_var_patterns` and `branch_patterns` miss both signals and the
// gate silently treats a prod mutation as non-prod.
//
// This parser extracts the leading idioms from a Bash command string so
// the resolver layer can merge them into its inputs before
// `environments.resolvers[]` runs. SECOND CONSUMER, easy to miss because
// it lives in another module: `command-normalize.ts` calls this for the
// `cd` half only (`const leadingCd = parseBashPrefix(command).cdTarget`),
// feeding its `targetDir`/`targetBase`. Both of those are currently
// unwired — nothing outside that module reads them — but a change here
// moves them without touching that file. Two POSIX forms are supported in v1
// (kept narrow on purpose, see follow-up scope in the originating task):
//
//   1. Inline env: leading `\w+=value` tokens. Values may be unquoted,
//      single-quoted (literal), or double-quoted (literal, no $
//      interpolation in v1).
//   2. cd prefix: a single leading `cd <path> [&&|;] ...`. Quoted paths
//      supported. No `pushd`, no subshell `(cd X && ...)`, no `bash -c`.
//
// The two clauses may appear in either order (`cd /x && VAR=v cmd` and
// `VAR=v cd /x && cmd` both parse); the parser walks up to two passes
// before giving up.
//
// Values and paths are scanned as shell WORDS: a concatenation of
// unquoted, single-quoted, double-quoted and ANSI-C (`$'…'`) runs, with
// bash's backslash rules per run kind. That is what makes `VAR='it'\''s
// fine' cd /prod && …` and `VAR="say \"hi\"" cd /prod && …` land on the
// same word boundary bash uses. What is deliberately NOT done: `$`
// interpolation, command substitution, and ANSI-C escape DECODING
// (`$'a\nb'` yields the literal two characters `\n`, not a newline; only
// `\'` and `\\` are decoded, because only those move the boundary).
//
// On a syntactically broken prefix (unterminated quote, dangling
// backslash, missing `&&` after `cd <path>`) the parser falls through
// cleanly: the malformed prefix is not consumed, the resolver-side
// fallback to process env / hook cwd holds. There are no thrown errors
// from this module.
//
// NO LENGTH CAP, unlike `command-normalize.ts`'s
// `MAX_NORMALIZE_LENGTH`, and that asymmetry is deliberate. Skipping
// oversized input there only forfeits the ADDITIONAL normalised-form
// coverage, because the raw command is still matched either way. Here a
// skip forfeits the ONLY signal: an empty `inlineEnv` and a null
// `cdTarget` are what the resolver falls back on, so a cap would trade
// a cost that was measured as immaterial for a real fail-open. Measured
// cost of the word scanner on the worst shape (a long double-quoted
// value), as a range across two machines' single-run measurements:
// 0.16-0.23 ms at 20 KB, 1.1-2.4 ms at 160 KB, ~3.7 ms at 320 KB,
// growing linearly, against hook budgets of 2000 ms and up. The ratio to
// the old `indexOf` scan, which never built the value string, is
// 100x-1200x depending on shape — a large ratio on a very small absolute
// number, so the conclusion (no cap) is unaffected, but the reserve is
// smaller than a single figure would suggest. 200k random shell-soup
// inputs all returned, none hung; an independent 300k run agreed.
//
// Falling through is NOT the conservative direction here, which is why
// the scanner parses instead of bailing wherever bash's boundary is
// determinate: the risk gate SEARCHES for production indicators, so an
// empty `inlineEnv` and a null `cdTarget` are exactly the state in which
// `env_var_patterns` and `branch_patterns` see nothing.
//
// THAT ARGUMENT IS NARROWER THAN IT LOOKS, on both outputs. Corrected
// across two review rounds of task b093911d, each of which falsified the
// preceding wording by measurement.
//
// `inlineEnv`: merged INTO the ambient env and matched by substring. NOT
// monotone, though — the corrected value is a different string, not a
// superset of the truncated one (measured: 10 of 15 corpus values are
// not supersets, e.g. `$'plain'` was `$'plain'` and is now `plain`). A
// pattern written against the TRUNCATED form can therefore stop
// matching. What is measured is narrower and is all that may be
// claimed: no realistic production indicator was lost — 0 lost matches
// over 38 values, and `prod` survives in every corpus case.
//
// `cdTarget`: REPLACES the resolver's git context (`resolverGit`,
// src/cli/policy/intercept.ts:515-524). Accuracy therefore cuts BOTH
// ways, and the losing side splits again:
//
//   HONEST HALF — bash really does enter the directory, so pointing the
//   resolver there is correct even when it declassifies. Measured at the
//   hook entry point (cwd on `main`, target on a feature branch),
//   spellings such as `VAR=a\ b cd X`, `VAR="say \"hi\"" cd X`,
//   `VAR='it'\''s cd X`, `VAR='a b'"c d" cd X`, `cd /esc\ aped` and
//   `cd /de\<newline>coy` flip BLOCK->allow. Those blocks were an
//   ACCIDENT of the parse bug, not a policy decision: `cd X`,
//   `A=x cd X` and `cd 'X'` already allowed on master. Enumeration is
//   illustrative, not the population — 19 distinct spellings were found
//   at the hook, 72 of 91 head/separator combinations at parse level.
//
//   PHANTOM HALF — bash NEVER enters the directory, the gated command
//   runs where it started, and the resolver is nonetheless pointed away.
//   `VAR='';: cd DECOY ; terraform destroy` used to be allowed while a
//   PATH shim showed terraform executing in the PRODUCTION repo. This
//   half was NOT "consistency, not a new hole"; it was a real widening
//   of a real bypass, and round 2 of the review is what caught it.
//   Closed in round 3 (operator-authorised) by the `stopAtWsOrMeta`
//   predicate above: a value now ends where bash ends it. Phantom
//   targets went master 27 -> 72 before the fix -> 0 after.
//
// ROUND 3 TRADED THE PHANTOM FOR A FAIL-OPEN, AND THE FIRST WRITE-UP OF
// IT WAS WRONG. This paragraph claimed "0 honest `cd` targets and 0
// `prod` indicators lost against EITHER earlier state". That number came
// from a corpus that could not produce it: its unseparated arm rendered
// `A=xcd /tmp` with no space, it ran from a non-writable directory so
// every redirection shape was dropped, and its own output reported a
// positive control of ZERO honest targets in all three builds. Re-run
// from a writable directory with the positive control asserted (84
// honest shapes of 102), the real figures are 8 honest `cd` targets lost
// against master, 16 against the pre-round-3 state, and 9 `prod`
// indicators lost.
//
// Mechanism: the value scan now parks the cursor ON the metacharacter,
// and `consumeLeadingCd`'s `skipWs` does not skip one, so a GENUINE
// leading `cd` after `A=x; ` is unreachable. Measured at the real hook
// with cwd non-production and the `cd` target production,
// `A=x; cd PROD && terraform destroy` blocks on master AND before round
// 3, is allowed here, and the shim shows terraform running in the
// production repo.
//
// Task 98ad072f (per-policy target attribution) is the structural answer
// to `cdTarget` being a context replacement at all. Until it lands,
// every accuracy change to this parser has produced a two-directional
// security effect — three rounds, three demonstrations — so measure both
// directions AND assert the positive control before reporting a zero.

/** Parsed leading-prefix result. */
export interface BashPrefix {
  /**
   * `VAR -> value` pairs from leading inline-env assignments. Empty when
   * none.
   *
   * The carrier has a NULL PROTOTYPE (see `parseBashPrefix`). Spread,
   * `Object.keys`, `JSON.stringify`, `structuredClone` and `in` all
   * behave normally and preserve a `__proto__` key; `Object.assign`
   * silently DROPS it, and `value.hasOwnProperty(...)` throws — use
   * `Object.prototype.hasOwnProperty.call(value, k)`.
   */
  inlineEnv: Record<string, string>;
  /** Path argument of a leading `cd <path> &&|;`, or null when none. */
  cdTarget: string | null;
}

/**
 * Parse leading inline-env and `cd <path>` idioms from a Bash command
 * string. Returns an empty `inlineEnv` and `cdTarget:null` when neither
 * idiom matches. Never throws.
 */
export function parseBashPrefix(command: string): BashPrefix {
  if (typeof command !== "string" || command.length === 0) {
    // Same null-prototype carrier as the main path: a caller must not
    // have to know which return it got before trusting a lookup.
    return { inlineEnv: Object.create(null) as Record<string, string>, cdTarget: null };
  }
  // Null-prototype carrier: `__proto__` is a grammatically valid POSIX
  // variable name, and on a plain object literal `into["__proto__"] = v`
  // would set the prototype (a no-op for a string) instead of creating an
  // own property, silently dropping the assignment from the resolver's
  // view. Not a pollution vector — assigning a string to `__proto__` does
  // nothing — but a signal loss.
  const inlineEnv: Record<string, string> = Object.create(null) as Record<string, string>;
  let cdTarget: string | null = null;
  let cursor = 0;
  // Two passes catch `cd /x && VAR=v cmd` and `VAR=v cd /x && cmd`. A
  // third pass would only fire on a redundant prefix; bail to keep this
  // bounded.
  for (let pass = 0; pass < 2; pass++) {
    const before = cursor;
    cursor = consumeInlineEnv(command, cursor, inlineEnv);
    if (cdTarget === null) {
      // The value scan stops ON an unquoted metacharacter and
      // `consumeLeadingCd` starts with `skipWs`, which does not skip one
      // — so without this step a GENUINE leading `cd` after `A=x; ` was
      // unreachable and the resolver silently fell back to the hook cwd
      // (review round 3: measured 8 honest targets lost against master,
      // and `A=x; cd PROD && terraform destroy` went from block to
      // allow while the command really did run in production).
      //
      // ONLY `;` and `&&`, and that restriction is load-bearing: they
      // are the two separators after which the next command still runs
      // in the same shell and the same directory. `|`, `&`, `(`, `<` and
      // `>` start a subshell or a redirection, so a `cd` behind them is
      // not a prefix of the gated command — stepping over those is
      // exactly how the phantom class of round 2 came about.
      cursor = skipConsumedSeparator(command, cursor);
      const cd = consumeLeadingCd(command, cursor);
      if (cd !== null) {
        cdTarget = cd.path;
        cursor = cd.next;
      }
    }
    if (cursor === before) break;
  }
  return { inlineEnv, cdTarget };
}

const WS = /\s/;
const VAR_START = /[A-Za-z_]/;
const VAR_CONT = /[A-Za-z0-9_]/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/**
 * Step over a `;` or `&&` the value scan stopped on, so the `cd` clause
 * that follows is still reachable as a prefix. Returns the cursor
 * unchanged for anything else — see the call site for why the narrow set
 * is the point rather than an omission.
 */
function skipConsumedSeparator(s: string, i: number): number {
  if (s[i] === ";") return skipWs(s, i + 1);
  if (s[i] === "&" && s[i + 1] === "&") return skipWs(s, i + 2);
  return i;
}

/** A consumed run or word: its literal text and the cursor after it. */
interface Scanned {
  value: string;
  next: number;
}

/** Predicate for the characters that end a word when UNQUOTED. */
type StopAt = (ch: string) => boolean;

/**
 * Unquoted shell metacharacters. bash ends a word at any of these just as
 * it does at whitespace, so a VALUE cannot run past one. Getting this
 * wrong is what produced the phantom-`cd` class (task b093911d, review
 * round 2): a value that swallowed `;` kept consuming, made a later `cd`
 * look like a prefix, and handed the risk-gate resolver a directory bash
 * never enters.
 */
const META = new Set([";", "&", "|", "(", ")", "<", ">"]);

const stopAtWsOrMeta: StopAt = (ch) => WS.test(ch) || META.has(ch);
const stopAtWsOrSep: StopAt = (ch) => WS.test(ch) || ch === ";" || ch === "&";

/**
 * Inside double quotes bash strips a backslash only before these; before
 * anything else the backslash stays literal (`"a\b"` is `a\b`).
 */
const DQ_ESCAPES = new Set(['"', "\\", "$", "`", "\n"]);

/** Scan a `"…"` run, cursor just past the opening quote. */
function scanDoubleQuoted(s: string, start: number): Scanned | null {
  let i = start;
  let out = "";
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '"') return { value: out, next: i + 1 };
    const nxt = s[i + 1];
    if (ch === "\\" && nxt !== undefined && DQ_ESCAPES.has(nxt)) {
      // `\<newline>` is a line continuation: both characters vanish.
      if (nxt !== "\n") out += nxt;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return null;
}

/**
 * Scan a `$'…'` (ANSI-C) run, cursor just past the opening quote. Only
 * `\'` and `\\` are decoded — they are the two escapes that decide where
 * the run ENDS. Every other escape is kept verbatim, so `$'a\nb'` yields
 * the two literal characters `\n`; decoding those would be shell
 * emulation this module deliberately stays out of.
 */
function scanAnsiC(s: string, start: number): Scanned | null {
  let i = start;
  let out = "";
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "'") return { value: out, next: i + 1 };
    const nxt = s[i + 1];
    if (ch === "\\" && nxt !== undefined) {
      out += nxt === "'" || nxt === "\\" ? nxt : ch + nxt;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return null;
}

/**
 * Scan one shell word from `start`, stopping before the first UNQUOTED
 * character `stop` accepts (or at end of input). Quoted runs are consumed
 * whole, so a separator inside quotes does not end the word.
 *
 * Returns null when the word has no determinable end — an unterminated
 * quote of any kind, or a dangling final backslash. The caller then leaves
 * the text unconsumed, preserving the module's fall-through contract.
 */
function scanWord(s: string, start: number, stop: StopAt): Scanned | null {
  let i = start;
  let out = "";
  while (i < s.length) {
    const ch = s[i]!;
    if (stop(ch)) break;
    if (ch === "\\") {
      // Unquoted: a backslash escapes exactly one following character,
      // except `\<newline>`, which is a line continuation — both
      // characters vanish, same rule `scanDoubleQuoted` applies. Multi-
      // line Bash commands are routine here, so the two runs having
      // different rules would be a silent divergence (review finding).
      if (i + 1 >= s.length) return null;
      if (s[i + 1] !== "\n") out += s[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === "'") {
      // Single quotes take no escapes at all, so the next `'` closes the
      // run. That is precisely why the `'\''` apostrophe idiom works:
      // it is close, escaped quote, reopen — three runs, not an escape.
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      out += s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    const opener = ch === "$" ? s[i + 1] : ch;
    if (opener === '"') {
      const run = scanDoubleQuoted(s, ch === "$" ? i + 2 : i + 1);
      if (run === null) return null;
      out += run.value;
      i = run.next;
      continue;
    }
    if (ch === "$" && opener === "'") {
      const run = scanAnsiC(s, i + 2);
      if (run === null) return null;
      out += run.value;
      i = run.next;
      continue;
    }
    out += ch;
    i++;
  }
  return { value: out, next: i };
}

/**
 * Consume zero or more leading `VAR=value` tokens. Each successful
 * consumption registers into `into`. Returns the cursor position after
 * the last consumed token, or the original cursor when nothing parsed
 * (so the caller can try another prefix kind).
 *
 * On a syntactically broken token (e.g. unterminated quote) the broken
 * token is NOT consumed and the function returns the cursor at the
 * start of that token, preserving the rest of the command for fallback.
 *
 * QUOTE-MODEL DIVERGENCE, recorded so the next change here starts from
 * the known state instead of rediscovering it (task 13e55484, review
 * round 1): `command-normalize.ts`'s `consumeAssignment` is a SECOND
 * quote model for the same leading-`VAR=value` construction, and the two
 * are still not one implementation (unifying them is task `d977ad58`).
 * Read before assuming which side is weaker — as of task `b093911d` it
 * is not a strict ordering. BOTH sides handle backslash escapes outside
 * single quotes and chained quote runs (`'a b'"c d"`). This side
 * additionally (a) models ANSI-C `$'…'` as its own run kind, where
 * `consumeAssignment` has no ANSI-C model at all and instead carries a
 * one-directional guard so that divergence can only fall back to its
 * pre-continuation behaviour, never swallow a gated head token; and
 * (b) continues across a backslash-escaped separator (`VAR=a\ b`), which
 * `consumeAssignment` deliberately does not (its own comment names that
 * as this task's class). The normaliser in turn needs only the BOUNDARY,
 * while this function needs the VALUE. Anything the two still disagree
 * on is a `d977ad58` question, not a bug in either.
 */
function consumeInlineEnv(s: string, start: number, into: Record<string, string>): number {
  let i = skipWs(s, start);
  let lastGood = i;
  while (i < s.length) {
    const nameStart = i;
    if (!VAR_START.test(s[i]!)) break;
    i++;
    while (i < s.length && VAR_CONT.test(s[i]!)) i++;
    if (s[i] !== "=") break;
    const name = s.slice(nameStart, i);
    i++;
    // Read the value as one shell word: quoted runs, unquoted runs and
    // backslash escapes concatenate up to the first unquoted whitespace
    // OR shell metacharacter, which is where bash ends the word too.
    const scanned = scanWord(s, i, stopAtWsOrMeta);
    if (scanned === null) return lastGood;
    into[name] = scanned.value;
    i = scanned.next;
    i = skipWs(s, i);
    lastGood = i;
  }
  return lastGood;
}

/**
 * Consume a single leading `cd <path> [&&|;]` clause. Returns
 * `{path, next}` on success (where `next` is the cursor after the
 * separator), or null when the prefix does not match. A path that is
 * missing the trailing `&&` / `;` separator is treated as not-a-prefix
 * (the operator typed `cd <path>` and nothing else — no useful resolver
 * override).
 */
function consumeLeadingCd(s: string, start: number): { path: string; next: number } | null {
  let i = skipWs(s, start);
  // Match `cd` followed by whitespace; do NOT match `cd&&` or `cdx`.
  if (s[i] !== "c" || s[i + 1] !== "d") return null;
  if (i + 2 >= s.length || !WS.test(s[i + 2]!)) return null;
  i = skipWs(s, i + 2);
  // Path as one shell word; `;` and `&` end it only when UNQUOTED, so
  // `cd "/tmp/a;b" && …` keeps its separator inside the path.
  const scanned = scanWord(s, i, stopAtWsOrSep);
  if (scanned === null) return null;
  const path = scanned.value;
  i = scanned.next;
  if (path.length === 0) return null;
  i = skipWs(s, i);
  if (s[i] === "&" && s[i + 1] === "&") {
    return { path, next: i + 2 };
  }
  if (s[i] === ";") {
    return { path, next: i + 1 };
  }
  return null;
}
