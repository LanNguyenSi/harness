// Kubectl explicit-target parser, Risk Gate resolver merge (task
// a7eb1a71).
//
// Extracts an explicit `--context`/`--namespace`/`-n` target from a
// `kubectl ...` command string so `src/cli/policy/intercept.ts` can
// merge it into the resolver's `SignalInputs`, UPGRADE-ONLY (see that
// call site's `applyKubeTargetUpgrade` for the merge rule). See
// CHANGELOG.md's `[Unreleased]` entry for the measured defects this
// fixes and the review round history.
//
// SCOPE, deliberately narrow (task risk note: too-broad parsing could
// collect values from a foreign context):
//
//   1. Tokenization is anchored at the COMMAND HEAD: this module only
//      recognizes a string whose very first token (after leading
//      whitespace) is the literal word `kubectl`. It does not look
//      through a leading `cd <path> &&`, `VAR=value`, or `git switch
//      <branch> &&` prefix on its own; the CALLER is responsible for
//      stripping any such prefix first (see `intercept.ts`, which
//      passes the remainder after `parseBashPrefix` consumed one) so a
//      wrapped invocation like `cd /tmp && kubectl ... --context x` or
//      `KUBECONFIG=/tmp/k kubectl ... --context x` is still covered.
//      Known unhandled shapes, listed so a future change does not have
//      to rediscover them: a `sudo`/`time`/`env` wrapper immediately
//      before `kubectl` (`parseBashPrefix` does not recognize those
//      prefixes either); a kubectl invocation that is not the FIRST
//      segment of a chained command (`echo hi && kubectl ...`); a piped
//      kubectl (`foo | kubectl ...`, where kubectl is not the command
//      head at all); an unquoted shell variable as a flag value
//      (`--context $PROD` reads the literal text `$PROD`, never the
//      variable's expanded value, so it practically never matches a
//      real `kube_context_patterns` entry, the same "not evaluated"
//      stance `bash-prefix-parse.ts` takes for `$VAR`/`${VAR}`); and
//      backslash-escaped whitespace inside an unquoted value (`prod\
//      eu` splits into two tokens at the escaped space, same as this
//      runtime's other narrow parsers, none of which model shell
//      escape sequences).
//   2. Once the head is confirmed to be `kubectl`, flags are read only
//      from the FIRST shell segment of the command, up to (not
//      including) the first unquoted `&&`, `||`, `;`, `|`, `&`, or
//      newline, AND stopping at a bare `--` token (the POSIX
//      end-of-flags marker).
//   3. Only `--context`, `--namespace`, and `-n` are recognized. The two
//      long flags accept `--flag value` and `--flag=value`. `-n`
//      additionally accepts the concatenated short-flag form `-nVALUE`
//      (see the narrowing note at its own call site) and `-n=value`.
//      Any other flag is ignored.
//   4. When a flag repeats, the LAST occurrence wins.
//   5. A flag with an EMPTY or whitespace-only value (`--context=`,
//      `--context ""`) is treated as though the flag were absent, never
//      as the literal empty string (an empty `SignalInputs.kubeContext`
//      means "no context" to the resolver, so returning `""` here would
//      erase a real ambient signal instead of leaving it alone).
//
// Never throws; a command that is not a `kubectl` invocation (by the
// narrow head test above) returns `{ context: null, namespace: null }`.

/** Explicit kube target read from a `kubectl ...` command's own flags. */
export interface KubectlTarget {
  /** `--context` value, or null when absent, blank, or not a kubectl command. */
  context: string | null;
  /** `--namespace`/`-n` value, or null when absent, blank, or not a kubectl command. */
  namespace: string | null;
}

const EMPTY: KubectlTarget = { context: null, namespace: null };

const WS = /\s/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/** Empty or whitespace-only, per scope point 5 above. */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * True when `command`'s head token (after skipping leading whitespace)
 * is the literal word `kubectl` on a word boundary, immediately
 * followed by whitespace or end-of-string, never a partial-word match
 * (`kubectl-plugin` must not match). See module doc, scope point 1.
 */
function isKubectlHead(command: string): boolean {
  const i = skipWs(command, 0);
  if (command.slice(i, i + 7) !== "kubectl") return false;
  const after = i + 7;
  return after >= command.length || WS.test(command[after]!);
}

/**
 * Slice `command` down to its first shell segment: everything up to
 * (not including) the first unquoted `&&`, `||`, `;`, bare `|`, bare
 * `&`, or newline. Quoted spans (single or double) are tracked so a
 * chain-looking character inside a flag value's quotes does not end
 * the segment early. See module doc, scope point 2.
 *
 * Exported (task d03af8f6, review round 2, pure visibility change — no
 * logic touched) so `deletion-target-resolve.ts`'s single-segment
 * fallback path can reuse this exact ~15-line function instead of
 * carrying its own byte-identical copy (the prior duplication was the
 * `check:duplication` clone pair the task's first round justified and
 * raised `MAX_CLONES` for; this closes it without touching this
 * module's own logic).
 */
export function firstSegment(command: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      return command.slice(0, i);
    }
  }
  return command;
}

/**
 * Whitespace-delimited tokenizer over an already-segment-bounded
 * string. A quoted span (single or double) is read literally, quote
 * characters stripped, no escape/interpolation handling, and may
 * contain whitespace or a chain-boundary character (`;`, `|`) without
 * splitting the token, mirroring the quoted-value handling
 * `consumeInlineEnv` and `consumeLeadingCd` already use elsewhere in
 * this runtime.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    i = skipWs(segment, i);
    if (i >= n) break;
    let token = "";
    while (i < n && !WS.test(segment[i]!)) {
      const c = segment[i]!;
      if (c === "'" || c === '"') {
        const end = segment.indexOf(c, i + 1);
        if (end < 0) {
          token += segment.slice(i + 1);
          i = n;
          break;
        }
        token += segment.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      token += c;
      i++;
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * Parse an explicit `--context`/`--namespace`/`-n` target out of a
 * `kubectl ...` command string. Returns `{ context: null, namespace:
 * null }` when `command` is not, by the narrow head test above, a
 * `kubectl` invocation, or when neither flag carries a non-blank value.
 * Never throws.
 */
export function parseKubectlTarget(command: string): KubectlTarget {
  if (typeof command !== "string" || command.length === 0) return EMPTY;
  if (!isKubectlHead(command)) return EMPTY;

  const tokens = tokenize(firstSegment(command));
  let context: string | null = null;
  let namespace: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    // POSIX end-of-flags marker (scope point 2): everything after a
    // bare `--` belongs to the exec'd program, not to kubectl itself.
    if (t === "--") break;

    if (t === "--context" || t === "--namespace" || t === "-n") {
      const value = tokens[i + 1];
      // No next token: a trailing valueless flag, nothing to consume or
      // skip. Otherwise the NEXT token is this flag's value under real
      // kubectl argument parsing (`--context -n prod` means --context
      // takes the literal value "-n"; "prod" is a positional argument,
      // not `-n`'s own value), so advance `i` past it here, regardless
      // of whether the value turns out blank, so the loop's own
      // increment does not re-examine that same token as if it were an
      // independent flag (fix round 3, review LOW finding).
      if (value === undefined) continue;
      i++;
      if (isBlank(value)) continue;
      if (t === "--context") context = value;
      else namespace = value;
      continue;
    }
    if (t.startsWith("--context=")) {
      const value = t.slice("--context=".length);
      if (!isBlank(value)) context = value;
      continue;
    }
    if (t.startsWith("--namespace=")) {
      const value = t.slice("--namespace=".length);
      if (!isBlank(value)) namespace = value;
      continue;
    }
    // `-n` short-flag forms, checked in an order where the longer
    // prefix (`-n=`) is tried before the general concatenated-value
    // fallback, so `-n=value` does not fall through to being read as
    // namespace `=value` (scope point 3).
    if (t.startsWith("-n=")) {
      const value = t.slice("-n=".length);
      if (!isBlank(value)) namespace = value;
      continue;
    }
    if (t.startsWith("-n") && t.length > 2) {
      // Narrowed (fix round 3, review LOW finding): real pflag DOES
      // glue any value onto a short flag's remaining characters, which
      // makes an unrelated flag typed with a single dash instead of two
      // (`-no-headers` for `--no-headers`) collide with this form and
      // read as `-n` plus a nonsense namespace value `o-headers`. A
      // genuine namespace value never contains a `-`-prefixed run once
      // read this way, since a Kubernetes namespace is a plain DNS
      // label; requiring no embedded `-` rejects that whole class of
      // false positive. This does NOT catch every case (`-namespace`
      // slices to `amespace`, which has no dash and is still accepted;
      // this is genuine pflag behavior for a value-taking short flag
      // and is left as a documented, narrow residual gap, not a
      // fabricated denylist of flag-shaped words).
      const value = t.slice(2);
      if (!isBlank(value) && !value.includes("-")) namespace = value;
      continue;
    }
  }

  return { context, namespace };
}
