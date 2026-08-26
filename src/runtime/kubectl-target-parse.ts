// Kubectl explicit-target parser — Risk Gate resolver merge (task
// a7eb1a71).
//
// Before this module, the Kube half of the Risk Gate's environment
// resolver (`kube_context_patterns` / `kube_namespace_patterns`, see
// `kube-context.ts`) only ever saw the AMBIENT `~/.kube/config`
// `current-context`. An explicit `--context`/`--namespace`/`-n` flag
// named directly in the Bash command — the usual, explicit way an
// operator or agent addresses a specific cluster — was invisible: the
// resolver could not tell `kubectl delete namespace payments
// --context prod-eu-1` from a `kubectl` call with no `--context` at
// all, so the whole Kube signal only fired when the ambient kubeconfig
// happened to already point at production. Measured 2026-08-06 (see
// the task spec's table): both the trailing- and leading-flag forms
// resolved `environment: unknown` and were allowed through.
//
// This parser extracts that explicit target from a `kubectl ...`
// command string so `src/cli/policy/intercept.ts` can merge it into the
// resolver's `SignalInputs`, mirroring the existing inline-`VAR=value`
// merge in `bash-prefix-parse.ts` / `intercept.ts` (same shape:
// operator's explicit statement wins over ambient state — see the
// CONFLICT PRIORITY note below).
//
// SCOPE, deliberately narrow (task risk note: "too-broad parsing could
// collect values from a foreign context"):
//
//   1. Tokenization is anchored at the COMMAND HEAD: this module only
//      recognizes a command whose very first token (after leading
//      whitespace) is the literal word `kubectl`. Unlike
//      `parseBashPrefix`, it does NOT look through a leading `cd
//      <path> &&` or `VAR=value` prefix to find a kubectl invocation
//      further in — a bare `kubectl` head is the ONLY form recognized.
//      This is intentionally conservative: it trades missing
//      `env-prefixed`/`cd`-prefixed kubectl invocations (not in this
//      task's acceptance criteria) for the guarantee that a `--context`
//      flag belonging to some OTHER program is never mistaken for a
//      kube signal (see AC4 in the task spec: a non-kubectl command
//      carrying `--context` must set no signal at all).
//   2. Once the head is confirmed to be `kubectl`, flags are read only
//      from the FIRST shell segment of the command — up to (not
//      including) the first unquoted `&&`, `||`, `;`, `|`, `&`, or
//      newline. A `--context` flag that belongs to a SECOND, chained
//      command after the kubectl invocation is never read as part of
//      it.
//   3. Only `--context`, `--namespace`, and `-n` are recognized, in
//      both the `--flag value` and `--flag=value` forms for the two
//      long flags (`-n` is short-flag-only per the task spec: `-n
//      <ns>`, no `-n=value` — kubectl's own short flags don't take an
//      `=` form either). Any other flag is ignored.
//   4. When a flag repeats, the LAST occurrence wins — the same
//      last-write-wins rule a real `getopt`-style parser (and kubectl
//      itself) applies, and the same rule `consumeInlineEnv` already
//      uses for repeated `VAR=value` prefixes.
//
// Never throws; a command that is not a `kubectl` invocation (by the
// narrow head test above) returns `{ context: null, namespace: null }`.

/** Explicit kube target read from a `kubectl ...` command's own flags. */
export interface KubectlTarget {
  /** `--context`/`--context=` value, or null when absent (or not a kubectl command). */
  context: string | null;
  /** `--namespace`/`--namespace=`/`-n` value, or null when absent (or not a kubectl command). */
  namespace: string | null;
}

const EMPTY: KubectlTarget = { context: null, namespace: null };

const WS = /\s/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/**
 * True when `command`'s head token (after skipping leading whitespace)
 * is the literal word `kubectl` on a word boundary — immediately
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
 * string. A quoted span (single or double) is read literally — quote
 * characters stripped, no escape/interpolation handling — and may
 * contain whitespace without splitting the token, mirroring the quoted-
 * value handling `consumeInlineEnv` and `consumeLeadingCd` already use
 * elsewhere in this runtime.
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
 * `kubectl` invocation, or when neither flag is present. Never throws.
 */
export function parseKubectlTarget(command: string): KubectlTarget {
  if (typeof command !== "string" || command.length === 0) return EMPTY;
  if (!isKubectlHead(command)) return EMPTY;

  const tokens = tokenize(firstSegment(command));
  let context: string | null = null;
  let namespace: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--context" || t === "--namespace" || t === "-n") {
      const value = tokens[i + 1];
      if (value === undefined) continue;
      if (t === "--context") context = value;
      else namespace = value;
      continue;
    }
    if (t.startsWith("--context=")) {
      context = t.slice("--context=".length);
      continue;
    }
    if (t.startsWith("--namespace=")) {
      namespace = t.slice("--namespace=".length);
      continue;
    }
  }

  return { context, namespace };
}
