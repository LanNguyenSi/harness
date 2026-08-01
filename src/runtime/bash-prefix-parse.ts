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
// `environments.resolvers[]` runs. Two POSIX forms are supported in v1
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
// On a syntactically broken prefix (unterminated quote, missing `&&`
// after `cd <path>`) the parser falls through cleanly: the malformed
// prefix is not consumed, the resolver-side fallback to process env /
// hook cwd holds. There are no thrown errors from this module.
//
// MEASUREMENT RULE (task 47297478): any claim about this parser's
// CD-TARGET extraction versus another build (lost or gained `cdTarget`
// values) must come from scripts/measure-bash-prefix-parse.mjs, the
// per-arm-gated corpus with real bash as referee. Three consecutive
// ad-hoc corpora in the b093911d run reported "0 lost" while being
// structurally unable to report a loss; that tool's self-test rebuilds
// exactly that failure and demands the gate catch it. The tool does NOT
// measure `inlineEnv` extraction — claims about inline-env behavior
// have no instrument yet and need their own measurement.

/** Parsed leading-prefix result. */
export interface BashPrefix {
  /** `VAR -> value` pairs from leading inline-env assignments. Empty when none. */
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
    return { inlineEnv: {}, cdTarget: null };
  }
  const inlineEnv: Record<string, string> = {};
  let cdTarget: string | null = null;
  let cursor = 0;
  // Two passes catch `cd /x && VAR=v cmd` and `VAR=v cd /x && cmd`. A
  // third pass would only fire on a redundant prefix; bail to keep this
  // bounded.
  for (let pass = 0; pass < 2; pass++) {
    const before = cursor;
    cursor = consumeInlineEnv(command, cursor, inlineEnv);
    if (cdTarget === null) {
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
 * quote model for the same leading-`VAR=value` construction, with
 * different deliberate coverage — it handles backslash escapes (outside
 * single quotes) and chained quote runs (`'a b'"c d"`), which this
 * function does not, while this function extracts the VALUE (which the
 * normaliser never needs). Neither model handles ANSI-C `$'...'`
 * escapes; the normaliser side carries a one-directional guard so that
 * divergence can only fall back to its pre-continuation behaviour,
 * never swallow a gated head token. This function's own escape gaps are
 * task `b093911d`.
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
    // Read value: quoted (single/double, literal) or unquoted (to ws).
    let value: string;
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return lastGood;
      value = s.slice(i + 1, end);
      i = end + 1;
    } else if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return lastGood;
      value = s.slice(i + 1, end);
      i = end + 1;
    } else {
      const vStart = i;
      while (i < s.length && !WS.test(s[i]!)) i++;
      value = s.slice(vStart, i);
    }
    into[name] = value;
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
  // Path: quoted or unquoted.
  let path: string;
  if (s[i] === "'") {
    const end = s.indexOf("'", i + 1);
    if (end < 0) return null;
    path = s.slice(i + 1, end);
    i = end + 1;
  } else if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    if (end < 0) return null;
    path = s.slice(i + 1, end);
    i = end + 1;
  } else {
    const pStart = i;
    while (i < s.length && !WS.test(s[i]!) && s[i] !== ";" && s[i] !== "&") i++;
    path = s.slice(pStart, i);
  }
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
