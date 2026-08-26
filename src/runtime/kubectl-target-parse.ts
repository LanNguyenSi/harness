// Kubectl explicit-target parser, Risk Gate resolver merge (task
// a7eb1a71).
//
// Before this module, the Kube half of the Risk Gate's environment
// resolver (`kube_context_patterns` / `kube_namespace_patterns`, see
// `kube-context.ts`) only ever saw the AMBIENT `~/.kube/config`
// `current-context`. An explicit `--context`/`--namespace`/`-n` flag
// named directly in the Bash command, the usual, explicit way an
// operator or agent addresses a specific cluster, was invisible: the
// resolver could not tell `kubectl delete namespace payments
// --context prod-eu-1` from a `kubectl` call with no `--context` at
// all, so the whole Kube signal only fired when the ambient kubeconfig
// happened to already point at production.
//
// This parser extracts that explicit target from a `kubectl ...`
// command string so `src/cli/policy/intercept.ts` can merge it into the
// resolver's `SignalInputs`. See that call site's own comment for the
// merge rule: the merge is UPGRADE-ONLY (command text can raise the
// resolved environment toward production, never lower an
// already-resolved production), the same asymmetric shape the
// branch-switch merge already uses.
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
//      Unhandled on either side of that split, noted so a future change
//      does not have to rediscover the gap: a `sudo`/`time`/`env`
//      wrapper immediately before `kubectl` (parseBashPrefix does not
//      recognize those prefixes either); a kubectl invocation that is
//      not the FIRST segment of a chained command (`echo hi && kubectl
//      ...`); and a piped kubectl (`foo | kubectl ...`, where kubectl is
//      not the command head at all).
//   2. Once the head is confirmed to be `kubectl`, flags are read only
//      from the FIRST shell segment of the command, up to (not
//      including) the first unquoted `&&`, `||`, `;`, `|`, `&`, or
//      newline, AND stopping at a bare `--` token (the POSIX
//      end-of-flags marker: `kubectl exec -it pod -- myapp --context
//      staging-1` must not read the exec'd program's own `--context` as
//      kubectl's). A `--context` flag that belongs to a SECOND, chained
//      command after the kubectl invocation, or that appears after `--`,
//      is never read as part of it.
//   3. Only `--context`, `--namespace`, and `-n` are recognized. The two
//      long flags accept `--flag value` and `--flag=value`. `-n`
//      additionally accepts the concatenated short-flag form `-nVALUE`
//      (pflag, kubectl's own flag library, treats a value-taking short
//      flag's remaining characters as its value, the same way `-oJSON`
//      means `-o JSON`), on top of `-n value` and `-n=value`. Any other
//      flag is ignored.
//   4. When a flag repeats, the LAST occurrence wins, the same
//      last-write-wins rule a real `getopt`-style parser (and kubectl
//      itself) applies, and the same rule `consumeInlineEnv` already
//      uses for repeated `VAR=value` prefixes.
//   5. A flag with an EMPTY or whitespace-only value (`--context=`,
//      `--context ""`) is treated as though the flag were absent, never
//      as the literal empty string: an empty `SignalInputs.kubeContext`
//      means "no context" to the resolver (`environment-resolver.ts`
//      only evaluates `kube_context_patterns` when the field is
//      non-empty), so returning `""` here would let a bare `--context=`
//      erase a real ambient production signal instead of leaving it
//      alone. Fix round 2 (review HIGH finding 2): measured, this
//      previously let `kubectl delete namespace payments --context=`
//      downgrade an ambient-production resolution to allow.
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
 */
function firstSegment(command: string): string {
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
      if (value === undefined || isBlank(value)) continue;
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
      const value = t.slice(2);
      if (!isBlank(value)) namespace = value;
      continue;
    }
  }

  return { context, namespace };
}
