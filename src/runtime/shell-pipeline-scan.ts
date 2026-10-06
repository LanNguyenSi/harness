// Quote- and expansion-aware scan of a shell command for its `|` stage
// boundaries (tracker task 25c56a0f).
//
// A `|` is a pipeline stage boundary only when the shell reads it as an
// operator: outside every quote, not backslash-escaped, and not inside an
// expansion or group the shell reads as one word. Cutting the text at every
// `|` character instead turns one command into fragments that are each
// classified on their own: `find <dir> -name 'a|cat -x' -delete` splits into
// `find <dir> -name 'a` and `cat -x' -delete`, which both look read-only
// while the real command deletes. The same cut happens for `${x//a|cat -x}`,
// `$[1|cat -x]`, `$(echo a|cat -x)`, a backtick substitution, a `$'a|b'` run
// and an extglob group `@(a|cat -x)`.
//
// This module is the single place that models that grammar for pipelines.
// `isReadOnlyBashPipeline` (read-only-bash.ts) splits through it, and the
// solution-acceptance write-guard builds its refuse-only filter on the flags
// it returns instead of keeping a second copy of the scan.
//
// Fail-closed by construction. The scan returns `null` for a command it
// cannot classify (an unterminated quote, expansion, substitution or group,
// or a stray closing parenthesis), and it errs on the deep side when a
// construct is ambiguous: a `|` it wrongly keeps inside a construct only
// makes a caller refuse, whereas a `|` it wrongly reports as a boundary is
// the unsafe direction. The constructs modelled are:
//
//   - single quotes `'...'` (no escapes inside)
//   - ANSI-C quotes `$'...'` (backslash escapes, so `\'` does not end the run)
//   - double quotes `"..."` and `$"..."` (backslash escapes; `$(`, `${`,
//     `$[` and backticks nest inside)
//   - a backslash outside quotes escapes the next character
//   - parameter expansion `${...}` (nested quotes, `${`, plain `{`, `[`)
//   - arithmetic bracket `$[...]` and array subscripts inside `${...}`
//   - command substitution `$(...)` and backticks
//   - parenthesised groups `(...)`: extglob `@(a|b)`, subshells, `$((..))`
//
// A `case` pattern list closed by a bare `)` inside `$( ... )` is NOT
// modelled; callers refuse `$(` and backticks before scanning, and a stray
// `)` makes the scan return `null`.
//
// The scan also reports zsh constructs that run code without any `$(`,
// backtick or write token (tracker task b647da7f), see `hasGlobSubst`,
// `hasParenInParam` and `hasDynamicNamedDir` on `ShellPipelineScan`.
//
// Not modelled, and harmless for a refuse-first caller: comments (a `|` after
// `#` is treated as a boundary, which only makes a caller classify more
// stages) and a trailing lone backslash (kept as a literal character).

/** Result of `scanShellPipeline`. */
export interface ShellPipelineScan {
  /**
   * The command cut at every `|` that is a real stage boundary, in order and
   * untrimmed. A command without a boundary yields one stage (the whole text).
   * A stage that still contains a `|` holds a non-boundary pipe.
   */
  readonly stages: readonly string[];
  /**
   * True when a `|` was seen inside a quote, after a backslash, or inside an
   * expansion or group (a `|` that is NOT a stage boundary).
   */
  readonly hasNonBoundaryPipe: boolean;
  /**
   * True when a `$` outside single quotes is not followed by a plain variable
   * name character (`${`, `$(`, `$[`, `$'`, `$"`, `$?`, a lone `$`).
   */
  readonly hasDollarExpansion: boolean;
  /** True when an unquoted `(` or `)` was seen (extglob, subshell, `$((..))`). */
  readonly hasGroupParen: boolean;
  /**
   * True when zsh would re-glob an expansion result (`GLOB_SUBST`): `$~name`
   * (also `$^~name`, `$==~name`), or an unquoted `~` anywhere in a `${...}` body (`${~x}`, `${=~x}`,
   * `${~^x}`, `${(@)~x}`). A glob qualifier hidden in a quote inside the
   * expansion, `${~x:-'*(e:cmd:)'}`, runs `cmd` while the glob expands; the
   * parentheses sit inside quotes, so `hasGroupParen` stays false.
   */
  readonly hasGlobSubst: boolean;
  /**
   * True when a `(` or `)` appears anywhere inside a `${...}` body, quoted,
   * escaped or not. The quoted spelling is the payload half of the
   * `hasGlobSubst` vector; refusing it keeps the refusal independent of how
   * the re-glob is spelled.
   */
  readonly hasParenInParam: boolean;
  /**
   * True when an unquoted `~[` (zsh dynamic named directory) was seen. zsh
   * calls the `zsh_directory_name` function for it when the host defines one,
   * so the word is not provably read-only.
   */
  readonly hasDynamicNamedDir: boolean;
}

/**
 * What follows a `$` when zsh re-globs the value without braces: the
 * shorthand flags `=`, `^`, `~`, `+` and `#` in any order and repetition
 * ahead of the name, so `$~x`, `$^~x`, `$^^~x` and `$==~x` all glob-expand
 * the value. Applied to everything after the `$` (the regex is anchored and
 * stops at the first other character), so no flag run length escapes it.
 */
const DOLLAR_GLOB_SUBST_PREFIX = /^[=^~+#]*~/;

type Context = "dq" | "param" | "brace" | "bracket" | "cmd" | "paren" | "backtick";

function isNameChar(ch: string): boolean {
  return /^[A-Za-z0-9_]$/.test(ch);
}

/**
 * Index just past the `'` that closes a single-quoted run whose first
 * character is at `from`, or -1 when the run is unterminated. With
 * `ansiC` the run is a `$'...'` string where a backslash escapes the next
 * character, so `\'` does not end it.
 */
function endOfSingleQuoted(s: string, from: number, ansiC: boolean): number {
  for (let i = from; i < s.length; i += 1) {
    const c = s.charAt(i);
    if (ansiC && c === "\\") {
      i += 1;
    } else if (c === "'") {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Scan `command` for its `|` stage boundaries. Returns `null` when the text
 * cannot be classified (see the module header); callers must treat `null` as
 * "not provably anything" and refuse.
 */
export function scanShellPipeline(command: string): ShellPipelineScan | null {
  const stack: Context[] = [];
  const stages: string[] = [];
  let stageStart = 0;
  let hasNonBoundaryPipe = false;
  let hasDollarExpansion = false;
  let hasGroupParen = false;
  let hasGlobSubst = false;
  let hasParenInParam = false;
  let hasDynamicNamedDir = false;

  const top = (): Context | undefined => stack[stack.length - 1];

  let i = 0;
  while (i < command.length) {
    const c = command.charAt(i);
    const next = command.charAt(i + 1);
    const ctx = top();

    // Backslash: escapes the next character in every context. A trailing
    // lone backslash is a literal.
    if (c === "\\") {
      if (next === "|") hasNonBoundaryPipe = true;
      if ((next === "(" || next === ")") && stack.includes("param")) hasParenInParam = true;
      i += i + 1 < command.length ? 2 : 1;
      continue;
    }

    if (c === "$") {
      if (isNameChar(next)) {
        i += 1;
        continue;
      }
      hasDollarExpansion = true;
      if (DOLLAR_GLOB_SUBST_PREFIX.test(command.slice(i + 1))) hasGlobSubst = true;
      if (next === "{") {
        stack.push("param");
        i += 2;
      } else if (next === "(") {
        stack.push("cmd");
        i += 2;
      } else if (next === "[") {
        stack.push("bracket");
        i += 2;
      } else if (next === "'" && ctx !== "dq") {
        const end = endOfSingleQuoted(command, i + 2, true);
        if (end < 0) return null;
        const run = command.slice(i + 2, end);
        if (run.includes("|")) hasNonBoundaryPipe = true;
        if (/[()]/.test(run) && stack.includes("param")) hasParenInParam = true;
        i = end;
      } else if (next === '"' && ctx !== "dq") {
        stack.push("dq");
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (c === "`") {
      if (ctx === "backtick") stack.pop();
      else stack.push("backtick");
      i += 1;
      continue;
    }

    if (ctx === "dq") {
      if (c === '"') stack.pop();
      else if (c === "|") hasNonBoundaryPipe = true;
      else if ((c === "(" || c === ")") && stack.includes("param")) hasParenInParam = true;
      i += 1;
      continue;
    }

    // Everything below runs outside double quotes: the top level and the
    // code-like contexts (`${`, `$[`, `$(`, backtick, parenthesised group).
    if (c === "'") {
      const end = endOfSingleQuoted(command, i + 1, false);
      if (end < 0) return null;
      const run = command.slice(i + 1, end);
      if (run.includes("|")) hasNonBoundaryPipe = true;
      if (/[()]/.test(run) && stack.includes("param")) hasParenInParam = true;
      i = end;
      continue;
    }
    if (c === '"') {
      stack.push("dq");
      i += 1;
      continue;
    }
    if (c === "(") {
      hasGroupParen = true;
      if (stack.includes("param")) hasParenInParam = true;
      stack.push("paren");
      i += 1;
      continue;
    }
    if (c === ")") {
      hasGroupParen = true;
      if (stack.includes("param")) hasParenInParam = true;
      if (ctx !== "paren" && ctx !== "cmd") return null;
      stack.pop();
      i += 1;
      continue;
    }
    if (c === "~") {
      if (stack.includes("param")) hasGlobSubst = true;
      else if (next === "[") hasDynamicNamedDir = true;
    }
    // Plain `{` and `[` only matter inside `${...}` (a `}` or `]` there is
    // matched against them); counting them there keeps the scan on the deep
    // side of the shell's own parse.
    if (c === "{" && (ctx === "param" || ctx === "brace")) {
      stack.push("brace");
    } else if (c === "}" && (ctx === "param" || ctx === "brace")) {
      stack.pop();
    } else if (c === "[" && (ctx === "param" || ctx === "brace" || ctx === "bracket")) {
      stack.push("bracket");
    } else if (c === "]" && ctx === "bracket") {
      stack.pop();
    } else if (c === "|") {
      if (stack.length === 0) {
        stages.push(command.slice(stageStart, i));
        stageStart = i + 1;
      } else {
        hasNonBoundaryPipe = true;
      }
    }
    i += 1;
  }

  if (stack.length > 0) return null;
  stages.push(command.slice(stageStart));
  return {
    stages,
    hasNonBoundaryPipe,
    hasDollarExpansion,
    hasGroupParen,
    hasGlobSubst,
    hasParenInParam,
    hasDynamicNamedDir,
  };
}
