// Quote-aware shell command model for repository target attribution
// (task 7d4abf84).
//
// WHAT THIS IS. One lexer pass turns a Bash command into words that keep
// their quote provenance, real operator boundaries (`&& || | |& ; & ( )`
// and newlines, counted only outside quotes, escapes and expansions),
// redirections, and recursively lexed `$( )`, backtick and `<( )` bodies.
// One walk over those words computes, for every simple command, the set of
// directories it can run in. `src/runtime/intercept.ts` reads those sets as
// a fifth, additive view next to `command-normalize.ts`'s segment view
// (`segmentViewOf`), which stays unchanged: the two are combined by union,
// so this module can only ADD a demand or a fail-closed verdict to what the
// segment view already decides, never remove one.
//
// WHY A SECOND VIEW. The segment view splits at a quote-blind boundary
// alphabet and tokenises at blanks, so a quoted target holding `;` or a
// space, a quoted option word (`git '-C' X log`), a `cd` spelled `\cd` or
// `c''d`, and every `cd` shape other than `cd <one word>` (`cd -P X`,
// `pushd X`, `cd X >/dev/null`, `{ cd X; }`, `builtin cd X`, `eval cd X`)
// either fell back to the working directory's evidence or matched no policy
// at all. Patching those one shape at a time is the enumeration the task
// that introduced this module set out to end; the word model reads them all
// from one grammar.
//
// RULES:
//
// - Directory builtins: after quote and backslash decoding and after the
//   transparent prefixes (`!`, `{`, `}`, `time [-p]`, compound keywords,
//   `builtin`, `command` without `-v`/`-V`, the zsh precommand modifiers
//   `noglob` and `nocorrect`, leading assignments, redirections anywhere),
//   the command word `cd`, `chdir`, `pushd` or `popd` moves the shell.
//   `cd` options `-L -P -e -@` and `--` are read; `exec`, `env`, `sudo` or
//   `nice` in front of `cd` run an external program and do not move it.
// - Composition: a literal target is joined onto every current possibility
//   as a step that keeps its mode (logical for `cd` and `pushd`, physical
//   for `cd -P`, `git -C`, `env -C` and `--git-dir`); an absolute target
//   replaces. The gate resolves the steps against the real filesystem; this
//   module never touches it. `cd` with no argument and `cd ~` give
//   `unknown` (home), `cd -` returns the tracked previous directory, `pushd`
//   and `popd` keep a tracked stack, `cd A B` (zsh substitution) is opaque.
// - Relocation options: `env` honours its last `-C` / `--chdir`; git applies
//   every `-C` in order, then `--git-dir` (its `.git` parent). Option words
//   are compared decoded (`'-C'`, `-''C`).
// - Opaque (the gate fails closed): a backtick anywhere in a target word, an
//   ANSI-C or locale quoted target, a control, format or separator character
//   in a target that is not a plain unquoted path, an unquoted glob (`* ? [`
//   or a brace expansion with `,` or `..`), a relative `cd` target while an
//   in-command `CDPATH` assignment is in effect, a relative or dynamic step
//   onto an opaque possibility, a loop body that moves relatively, and the
//   bounds below.
// - Dynamic values (`$VAR`, `${...}`, `$(...)`, `~...`) give `unknown`, the
//   documented working-directory fallback; a known base stays a candidate
//   next to it, because an empty expansion does not move.
// - Control flow: every command has a success and a failure state (a failed
//   `cd` stays put). `A && B` starts B from A's success state, `A || B` from
//   its failure state, `!` swaps them, `;` / newline continue from either,
//   `&` restores the state the list started in. A pipeline element runs in
//   a subshell; the last one is joined with the start state (zsh runs it in
//   the current shell). `( )`, `$( )`, backticks and `<( )` are subshells
//   whose inner commands are modelled too. `if` / `case` branches join.
//   `eval` with literal arguments is re-lexed and walked. Commands inside a
//   loop body that moved also get the directories a later iteration starts
//   in.
//
// BOUNDS (past them a possibility reads as opaque, or the command as not
// lexable): `MAX_NORMALIZE_LENGTH` characters, nesting depth
// `MAX_MODEL_NESTING`, eval depth `MAX_MODEL_EVAL_DEPTH`, more than
// `MAX_DIR_POSSIBILITIES` possibilities, a composed path longer than
// `MAX_COMPOSED_PATH_LENGTH` characters. Every exception inside the model is
// caught and reported as "not lexable" (`null`), so a defect here routes to
// the gate's fallback (fail closed when the raw text holds a
// directory-changing word) instead of crashing the hook.
//
// OUT OF SCOPE (the working-directory fallback stays): directories held in
// variables or substitutions, `GIT_DIR=` / `GIT_WORK_TREE=` assignments,
// `sudo -D`, nested shells (`bash -c`, `sh -c`), `source`, function calls
// (a function body is walked where it is defined, as if it ran there),
// aliases, `env -S`, a dynamic `eval`, `CDPATH` and `OLDPWD` inherited from
// the environment, zsh `AUTO_CD` and other zsh-only options, and a gated
// verb whose own head is spelled through a prefix the legacy arms miss
// (`! git log`), which this module models but the gate does not match on
// (the matching arm is scoped to commands that name a directory).

import * as path from "node:path";
import { MAX_NORMALIZE_LENGTH } from "./command-normalize.js";
import { decodeShellWord } from "./shell-word.js";

/** Nesting bound for `$( )`, backtick, `<( )` bodies, `( )` groups and compound commands. */
export const MAX_MODEL_NESTING = 8;
/** `eval` re-lexing depth bound; a deeper `eval` makes the directory opaque. */
export const MAX_MODEL_EVAL_DEPTH = 3;
/** More directory possibilities than this read as one opaque possibility. */
export const MAX_DIR_POSSIBILITIES = 8;
/** A composed path longer than this many characters reads as opaque. */
export const MAX_COMPOSED_PATH_LENGTH = 4096;
/** Tracked `pushd` stack depth; older entries are dropped and a pop past them is opaque. */
const MAX_DIR_STACK = 16;
/** Compound-command (`if`, `while`, `case`, ...) nesting bound. */
const MAX_COMPOUND_DEPTH = 32;

/** How one composition step is resolved by the gate. */
export type PathStepMode = "logical" | "physical";

/**
 * One directory change, as written. `logical` (a plain `cd` or `pushd`)
 * resolves `..` lexically against the previous directory, like the shell's
 * own `$PWD`; `physical` (`cd -P`, `git -C`, `env -C`, `--git-dir`) is a
 * `chdir(2)` relative to the real previous directory.
 */
export interface PathStep {
  readonly value: string;
  readonly mode: PathStepMode;
}

/**
 * One directory a command can run in. `path` with no steps is the working
 * directory itself; `unknown` is a directory the command text does not name
 * (home, a variable), which keeps the documented working-directory fallback;
 * `opaque` is a directory the gate must not guess at (fail closed).
 */
export type DirPossibility =
  | { readonly kind: "path"; readonly steps: readonly PathStep[] }
  | { readonly kind: "unknown" }
  | { readonly kind: "opaque" };

/** One simple command of the modelled command line. */
export interface ModelCommand {
  /**
   * The command after wrapper and git-global-option peeling, words decoded
   * and joined by one space (`git log`, `gh pr merge 1`). Any of
   * `\n ; | & ( )` inside a word is replaced by `_`, so a `bash_match`
   * pattern can only anchor at the start of the text.
   */
  readonly canonical: string;
  /**
   * Offsets of the command's words in the original command text. A command
   * found inside a backtick body or an `eval` string carries the span of the
   * enclosing word or command instead.
   */
  readonly span: { readonly start: number; readonly end: number };
  /** True when some possibility is opaque or names a directory (a path with at least one step). */
  readonly namesDirectory: boolean;
  /** Every directory the command can run in, at most `MAX_DIR_POSSIBILITIES`. */
  readonly dirs: readonly DirPossibility[];
}

/**
 * What the gate reads from this module for one command: the model commands,
 * or `null` when the command could not be lexed; and, only for that `null`
 * case, whether the raw text holds a directory-changing word (the fallback
 * then fails closed for a per-repo policy the legacy arms matched).
 */
export interface ShellModelView {
  readonly commands: readonly ModelCommand[] | null;
  readonly directoryChangeWord: boolean;
}

/**
 * A directory-changing word in the raw text: `cd`, `pushd`, `popd`,
 * `chdir`, `-C`, `--chdir`, `--git-dir`, or a glued `-C<dir>`.
 */
const DIRECTORY_CHANGE_WORD_RE =
  /(^|[\s;&|(){}`'"\\!])(cd|pushd|popd|chdir)($|[\s;&|()'"])|(^|\s)['"]?(-C|--chdir|--git-dir)['"]?($|[\s=])|(^|\s)-C\S/;

/**
 * True when the command text holds a directory-changing word, tested on
 * the text as written and again with every quote and backslash removed, so
 * a partly quoted spelling (`c''d`, `'-C'`) counts too.
 */
export function hasDirectoryChangeWord(command: string): boolean {
  return (
    DIRECTORY_CHANGE_WORD_RE.test(command) ||
    DIRECTORY_CHANGE_WORD_RE.test(command.replace(/['"\\]/g, ""))
  );
}

/** The model view of one command; see `ShellModelView`. */
export function shellModelViewOf(command: string): ShellModelView {
  const commands = modelShellCommands(command);
  return {
    commands,
    directoryChangeWord: commands === null && hasDirectoryChangeWord(command),
  };
}

// ------------------------------------------------------------------ lexer

interface Span {
  start: number;
  end: number;
}

/** A word with its decoded value and quote provenance. */
export interface ShellWord {
  readonly kind: "word";
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  /** Decoded value; `null` when a part of it is only known at run time. */
  readonly value: string | null;
  /** The decoded literal parts only (dynamic parts left out). */
  readonly literal: string;
  readonly quoted: boolean;
  readonly dynamic: boolean;
  readonly backtick: boolean;
  readonly ansiC: boolean;
  readonly locale: boolean;
  readonly glob: boolean;
  readonly tilde: boolean;
  readonly unusual: boolean;
  /** Lexed bodies of the `$( )`, backtick and `<( )` substitutions in this word. */
  readonly subs: readonly ShellToken[][];
}

export interface ShellOperator {
  readonly kind: "op";
  readonly op: string;
  readonly start: number;
  readonly end: number;
}

export interface ShellRedirection {
  readonly kind: "redir";
  readonly op: string;
  readonly target: ShellWord;
  readonly start: number;
  readonly end: number;
}

export type ShellToken = ShellWord | ShellOperator | ShellRedirection;

class ShellModelError extends Error {}

const UNUSUAL_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WORD_END_CHARS = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", ")"]);
const REDIRECTION_OPERATORS = ["<<<", "<<-", "<<", "<>", "<&", ">>", ">&", ">|", "<", ">"];

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

interface WordBuilder {
  literal: string;
  unquoted: string;
  quoted: boolean;
  dynamic: boolean;
  backtick: boolean;
  ansiC: boolean;
  locale: boolean;
  glob: boolean;
  tilde: boolean;
  subs: ShellToken[][];
}

class ShellLexer {
  constructor(
    private readonly s: string,
    /** When set, every token gets this span (a backtick body or an `eval` string). */
    private readonly origin: Span | null,
  ) {}

  private span(start: number, end: number): Span {
    return this.origin ?? { start, end };
  }

  list(start: number, mode: "top" | "paren", depth: number): { tokens: ShellToken[]; end: number } {
    if (depth > MAX_MODEL_NESTING) throw new ShellModelError("nesting too deep");
    const s = this.s;
    const n = s.length;
    const tokens: ShellToken[] = [];
    const pending: PendingHeredoc[] = [];
    let parenDepth = 0;
    let i = start;
    const pushOp = (op: string, at: number): void => {
      const sp = this.span(at, at + op.length);
      tokens.push({ kind: "op", op, start: sp.start, end: sp.end });
    };
    while (i < n) {
      const c = s[i]!;
      if (c === " " || c === "\t") {
        i++;
        continue;
      }
      if (c === "\\" && s[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (c === "#") {
        while (i < n && s[i] !== "\n") i++;
        continue;
      }
      if (c === "\n") {
        pushOp("\n", i);
        i = this.consumeHeredocBodies(i + 1, pending, mode);
        continue;
      }
      if (s.startsWith(";;&", i)) {
        pushOp(";;&", i);
        i += 3;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === "|&" || two === ";;" || two === ";&") {
        pushOp(two, i);
        i += 2;
        continue;
      }
      if (c === "&" && s[i + 1] === ">") {
        const op = s[i + 2] === ">" ? "&>>" : "&>";
        const target = this.redirectionTarget(i + op.length, depth);
        const sp = this.span(i, target.end);
        tokens.push({ kind: "redir", op, target: target.word, start: sp.start, end: sp.end });
        i = target.end;
        continue;
      }
      if (c === "&" || c === "|" || c === ";") {
        pushOp(c, i);
        i++;
        continue;
      }
      if (c === "(") {
        parenDepth++;
        if (depth + parenDepth > MAX_MODEL_NESTING) throw new ShellModelError("nesting too deep");
        pushOp("(", i);
        i++;
        continue;
      }
      if (c === ")") {
        if (mode === "paren" && parenDepth === 0) return { tokens, end: i + 1 };
        parenDepth--;
        pushOp(")", i);
        i++;
        continue;
      }
      if ((c === "<" || c === ">") && s[i + 1] === "(") {
        const w = this.word(i, depth);
        tokens.push(w.word);
        i = w.end;
        continue;
      }
      if (c === "<" || c === ">") {
        const r = this.redirection(i, depth, pending);
        tokens.push(r.token);
        i = r.end;
        continue;
      }
      const w = this.word(i, depth);
      i = w.end;
      const next = s[i];
      if (
        (next === "<" || next === ">") &&
        s[i + 1] !== "(" &&
        (/^\d+$/.test(w.word.raw) || /^\{[A-Za-z_]\w*\}$/.test(w.word.raw))
      ) {
        // An fd number or `{var}` glued to a redirection operator.
        const r = this.redirection(i, depth, pending);
        tokens.push(r.token);
        i = r.end;
        continue;
      }
      tokens.push(w.word);
    }
    if (mode === "paren") throw new ShellModelError("unterminated $(");
    return { tokens, end: i };
  }

  /** Skip the heredoc bodies that start after a newline at `i`; their text is data. */
  private consumeHeredocBodies(i: number, pending: PendingHeredoc[], mode: "top" | "paren"): number {
    const s = this.s;
    const n = s.length;
    while (pending.length > 0) {
      const h = pending.shift()!;
      while (i < n) {
        let j = s.indexOf("\n", i);
        if (j < 0) j = n;
        let line = s.slice(i, j);
        if (h.stripTabs) line = line.replace(/^\t+/, "");
        const lineEnd = j;
        i = j < n ? j + 1 : n;
        if (line === h.delimiter) break;
        // Inside `$( )` the closing parenthesis may share the delimiter line.
        if (mode === "paren" && line === `${h.delimiter})`) {
          i = lineEnd - 1;
          break;
        }
      }
    }
    return i;
  }

  private redirection(
    i: number,
    depth: number,
    pending: PendingHeredoc[],
  ): { token: ShellRedirection; end: number } {
    const op = REDIRECTION_OPERATORS.find((o) => this.s.startsWith(o, i))!;
    const target = this.redirectionTarget(i + op.length, depth);
    if (op === "<<" || op === "<<-") {
      pending.push({
        delimiter: target.word.value ?? target.word.raw.replace(/["'\\]/g, ""),
        stripTabs: op === "<<-",
      });
    }
    const sp = this.span(i, target.end);
    return { token: { kind: "redir", op, target: target.word, start: sp.start, end: sp.end }, end: target.end };
  }

  private redirectionTarget(i: number, depth: number): { word: ShellWord; end: number } {
    const s = this.s;
    while (s[i] === " " || s[i] === "\t") i++;
    const processSubstitution = (s[i] === "<" || s[i] === ">") && s[i + 1] === "(";
    if (i >= s.length || (/[\n;&|()<>]/.test(s[i]!) && !processSubstitution)) {
      throw new ShellModelError("redirection without target");
    }
    return this.word(i, depth);
  }

  word(start: number, depth: number): { word: ShellWord; end: number } {
    const s = this.s;
    const n = s.length;
    const b: WordBuilder = {
      literal: "",
      unquoted: "",
      quoted: false,
      dynamic: false,
      backtick: false,
      ansiC: false,
      locale: false,
      glob: false,
      tilde: false,
      subs: [],
    };
    const add = (text: string, quoted: boolean): void => {
      b.literal += text;
      // A quoted run counts as one non-glob placeholder, so a brace or a
      // glob character cannot pair across it.
      b.unquoted += quoted ? "\u0000" : text;
    };
    let i = start;
    while (i < n) {
      const c = s[i]!;
      if (WORD_END_CHARS.has(c)) {
        if ((c === "<" || c === ">") && i === start && s[i + 1] === "(") {
          const r = this.list(i + 2, "paren", depth + 1);
          b.subs.push(r.tokens);
          b.dynamic = true;
          i = r.end;
          continue;
        }
        break;
      }
      if (c === "(") {
        const prev = s[i - 1];
        if (i > start && prev !== undefined && "@!+*?".includes(prev)) {
          // extglob `@( )`, `!( )`, `+( )`, `*( )`, `?( )`
          const end = skipBalanced(s, i, "(", ")");
          b.glob = true;
          add(s.slice(i, end), false);
          i = end;
          continue;
        }
        if (i === start + 1 && prev === "=") {
          // zsh `=( )` process substitution
          const r = this.list(i + 1, "paren", depth + 1);
          b.subs.push(r.tokens);
          b.dynamic = true;
          i = r.end;
          continue;
        }
        break;
      }
      if (c === "\\") {
        if (s[i + 1] === "\n") {
          i += 2;
          continue;
        }
        if (i + 1 >= n) {
          add("\\", false);
          i++;
          continue;
        }
        b.quoted = true;
        add(s[i + 1]!, true);
        i += 2;
        continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) throw new ShellModelError("unterminated '");
        b.quoted = true;
        add(s.slice(i + 1, j), true);
        i = j + 1;
        continue;
      }
      if (c === '"') {
        b.quoted = true;
        i = this.doubleQuoted(i + 1, depth, b, add);
        continue;
      }
      if (c === "$") {
        const r = this.dollar(i, depth, b, false);
        if (r.literal !== null) add(r.literal, r.quoted);
        i = r.end;
        continue;
      }
      if (c === "`") {
        i = this.backtickBody(i, depth, b);
        continue;
      }
      if (c === "~" && i === start) b.tilde = true;
      add(c, false);
      i++;
    }
    if (i === start) throw new ShellModelError(`empty word at ${i}`);
    if (/[*?[]/.test(b.unquoted)) b.glob = true;
    if (/\{[^}\u0000]*(?:,|\.\.)[^}\u0000]*\}/.test(b.unquoted)) b.glob = true;
    const sp = this.span(start, i);
    return {
      word: {
        kind: "word",
        raw: s.slice(start, i),
        start: sp.start,
        end: sp.end,
        value: b.dynamic ? null : b.literal,
        literal: b.literal,
        quoted: b.quoted,
        dynamic: b.dynamic,
        backtick: b.backtick,
        ansiC: b.ansiC,
        locale: b.locale,
        glob: b.glob,
        tilde: b.tilde,
        unusual: UNUSUAL_CHAR_RE.test(b.literal),
        subs: b.subs,
      },
      end: i,
    };
  }

  /** Read a double-quoted run starting after its opening quote; returns the index after the closing quote. */
  private doubleQuoted(
    i: number,
    depth: number,
    b: WordBuilder,
    add: (text: string, quoted: boolean) => void,
  ): number {
    const s = this.s;
    for (;;) {
      if (i >= s.length) throw new ShellModelError('unterminated "');
      const d = s[i]!;
      if (d === '"') return i + 1;
      if (d === "\\") {
        const e = s[i + 1];
        if (e === "\n") {
          i += 2;
          continue;
        }
        if (e === "$" || e === "`" || e === '"' || e === "\\") {
          add(e, true);
          i += 2;
          continue;
        }
        add("\\", true);
        i++;
        continue;
      }
      if (d === "$") {
        const r = this.dollar(i, depth, b, true);
        if (r.literal !== null) add(r.literal, true);
        i = r.end;
        continue;
      }
      if (d === "`") {
        i = this.backtickBody(i, depth, b);
        continue;
      }
      add(d, true);
      i++;
    }
  }

  /** A `$` construct at `i`. `literal` is its literal contribution, `null` when dynamic. */
  private dollar(
    i: number,
    depth: number,
    b: WordBuilder,
    inDoubleQuotes: boolean,
  ): { literal: string | null; end: number; quoted: boolean } {
    const s = this.s;
    const nx = s[i + 1];
    if (!inDoubleQuotes && nx === "'") {
      // ANSI-C quoting: decodes escapes, so it can spell any character.
      let j = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === "\\") {
          j++;
          continue;
        }
        if (s[j] === "'") break;
      }
      if (j >= s.length) throw new ShellModelError("unterminated $'");
      b.ansiC = true;
      b.quoted = true;
      const decoded = decodeShellWord(s.slice(i, j + 1));
      return { literal: decoded === s.slice(i, j + 1) ? s.slice(i + 2, j) : decoded, end: j + 1, quoted: true };
    }
    if (!inDoubleQuotes && nx === '"') {
      // Locale quoting: bash may translate the text into a different name.
      let j = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === "\\") {
          j++;
          continue;
        }
        if (s[j] === '"') break;
      }
      if (j >= s.length) throw new ShellModelError('unterminated $"');
      b.locale = true;
      b.quoted = true;
      return { literal: s.slice(i + 2, j), end: j + 1, quoted: true };
    }
    if (nx === "(" && s[i + 2] === "(") {
      b.dynamic = true;
      return { literal: null, end: skipBalanced(s, i + 1, "(", ")"), quoted: false };
    }
    if (nx === "(") {
      const r = this.list(i + 2, "paren", depth + 1);
      b.subs.push(r.tokens);
      b.dynamic = true;
      return { literal: null, end: r.end, quoted: false };
    }
    if (nx === "{") {
      b.dynamic = true;
      return { literal: null, end: skipBalanced(s, i + 1, "{", "}"), quoted: false };
    }
    if (nx === "[") {
      b.dynamic = true;
      return { literal: null, end: skipBalanced(s, i + 1, "[", "]"), quoted: false };
    }
    if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      b.dynamic = true;
      return { literal: null, end: j, quoted: false };
    }
    if (nx !== undefined && /[0-9@*#?$!-]/.test(nx)) {
      b.dynamic = true;
      return { literal: null, end: i + 2, quoted: false };
    }
    return { literal: "$", end: i + 1, quoted: inDoubleQuotes };
  }

  /** A backtick substitution at `i`; its body is lexed with the enclosing word's span. */
  private backtickBody(i: number, depth: number, b: WordBuilder): number {
    const s = this.s;
    let j = i + 1;
    let body = "";
    for (; j < s.length; j++) {
      const ch = s[j]!;
      if (ch === "\\" && (s[j + 1] === "`" || s[j + 1] === "\\" || s[j + 1] === "$")) {
        body += s[j + 1]!;
        j++;
        continue;
      }
      if (ch === "`") break;
      body += ch;
    }
    if (j >= s.length) throw new ShellModelError("unterminated `");
    const inner = new ShellLexer(body, this.span(i, j + 1)).list(0, "top", depth + 1);
    b.subs.push(inner.tokens);
    b.dynamic = true;
    b.backtick = true;
    return j + 1;
  }
}

/** Index after the `close` that balances the `open` at `i`, skipping quoted and escaped text. */
function skipBalanced(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'") {
      const k = s.indexOf("'", j + 1);
      if (k < 0) throw new ShellModelError("unterminated ' in group");
      j = k;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      while (k < s.length && s[k] !== '"') {
        if (s[k] === "\\") k++;
        k++;
      }
      if (k >= s.length) throw new ShellModelError('unterminated " in group');
      j = k;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  throw new ShellModelError(`unterminated ${open}`);
}

/**
 * Lex a command into words, operators and redirections. `null` when the
 * command is longer than `MAX_NORMALIZE_LENGTH` or cannot be lexed (an
 * unterminated quote or substitution, nesting past `MAX_MODEL_NESTING`).
 */
export function lexShellCommand(command: string): ShellToken[] | null {
  if (command.length > MAX_NORMALIZE_LENGTH) return null;
  try {
    return new ShellLexer(command, null).list(0, "top", 0).tokens;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- directory sets

type DirSet = ReadonlyMap<string, DirPossibility>;

const OPAQUE: DirPossibility = { kind: "opaque" };
const UNKNOWN: DirPossibility = { kind: "unknown" };
const CWD: DirPossibility = { kind: "path", steps: [] };

function keyOf(d: DirPossibility): string {
  if (d.kind === "opaque") return "o";
  if (d.kind === "unknown") return "u";
  let key = "p";
  for (const step of d.steps) key += `${step.mode === "logical" ? "L" : "P"}${step.value.length}:${step.value}`;
  return key;
}

function setOf(...items: DirPossibility[]): DirSet {
  const m = new Map<string, DirPossibility>();
  for (const d of items) m.set(keyOf(d), d);
  return capped(m);
}

function capped(m: Map<string, DirPossibility>): DirSet {
  return m.size > MAX_DIR_POSSIBILITIES ? new Map([[keyOf(OPAQUE), OPAQUE]]) : m;
}

function union(a: DirSet, b: DirSet): DirSet {
  if (a === b) return a;
  const m = new Map(a);
  for (const [k, d] of b) m.set(k, d);
  return capped(m);
}

function withPossibility(a: DirSet, d: DirPossibility): DirSet {
  const k = keyOf(d);
  if (a.has(k)) return a;
  const m = new Map(a);
  m.set(k, d);
  return capped(m);
}

const OPAQUE_SET = setOf(OPAQUE);
const UNKNOWN_SET = setOf(UNKNOWN);
const CWD_SET = setOf(CWD);

function composedLength(steps: readonly PathStep[]): number {
  let n = 0;
  for (const step of steps) n += step.value.length + 1;
  return n;
}

/**
 * Append one step to a path possibility; an absolute step replaces the
 * steps before it. Consecutive steps of the same mode merge: logical steps
 * lexically (`a` then `..` is `.`, as the shell's own `$PWD` does),
 * physical steps as written (`a/..` is resolved by the gate, through the
 * real directory `a` names).
 */
function appendStep(base: readonly PathStep[], step: PathStep): DirPossibility {
  const own = step.mode === "logical" ? path.posix.normalize(step.value) : step.value;
  let steps: PathStep[];
  const last = base[base.length - 1];
  if (path.posix.isAbsolute(step.value)) {
    steps = [{ value: own, mode: step.mode }];
  } else if (last !== undefined && last.mode === step.mode) {
    const joined = `${last.value}/${step.value}`;
    steps = [
      ...base.slice(0, -1),
      { value: step.mode === "logical" ? path.posix.normalize(joined) : joined, mode: step.mode },
    ];
  } else {
    steps = [...base, { value: own, mode: step.mode }];
  }
  if (composedLength(steps) > MAX_COMPOSED_PATH_LENGTH) return OPAQUE;
  return { kind: "path", steps };
}

/** A word whose value the gate refuses to read as a directory (the cfb6b390 class, globs). */
function isOpaqueTargetWord(w: ShellWord): boolean {
  if (w.ansiC || w.locale || w.backtick || w.raw.includes("`") || w.literal.includes("`")) return true;
  if (w.unusual && (w.quoted || w.tilde || w.dynamic)) return true;
  return w.glob;
}

/** Compose one possibility with a target word. */
function joinOne(base: DirPossibility, w: ShellWord, mode: PathStepMode, cdpathSearch: boolean): DirPossibility {
  if (isOpaqueTargetWord(w)) return OPAQUE;
  if (w.value === null || w.tilde) return base.kind === "opaque" ? OPAQUE : UNKNOWN;
  const v = w.value;
  if (v === "") return base; // `cd ""` and `git -C ""` stay put
  if (path.posix.isAbsolute(v)) return appendStep([], { value: v, mode });
  if (cdpathSearch && !/^\.\.?(\/|$)/.test(v)) return OPAQUE;
  if (base.kind !== "path") return base;
  return appendStep(base.steps, { value: v, mode });
}

function joinSet(set: DirSet, w: ShellWord, mode: PathStepMode, cdpathSearch: boolean): DirSet {
  const m = new Map<string, DirPossibility>();
  for (const base of set.values()) {
    const joined = joinOne(base, w, mode, cdpathSearch);
    m.set(keyOf(joined), joined);
    // A variable or substitution may expand to nothing, which stays put.
    if (w.value === null && !w.tilde && !isOpaqueTargetWord(w) && base.kind === "path") m.set(keyOf(base), base);
  }
  return capped(m);
}

// ------------------------------------------------------------------ walker

interface LoopFrame {
  moved: boolean;
  relative: boolean;
}

interface WalkState {
  cur: DirSet;
  oldpwd: DirSet;
  stack: DirSet[];
  stackTruncated: boolean;
  cdpath: boolean;
  evalDepth: number;
  loops: LoopFrame[];
}

interface OutRecord {
  canonical: string;
  span: Span;
  dirs: DirSet;
}

interface CompoundFrame {
  kind: string;
  union: DirSet;
  entry: DirSet;
  header: boolean;
  expectPattern: boolean;
  loop: LoopFrame | null;
  outStart: number;
}

interface SimpleCommand {
  words: ShellWord[];
  redirs: ShellRedirection[];
  group: ShellToken[] | null;
}

const RESERVED_OPEN = new Set(["if", "while", "until", "for", "select", "case"]);
const RESERVED_MID = new Set(["then", "else", "elif", "do"]);
const RESERVED_CLOSE = new Set(["fi", "done", "esac"]);
const LOOP_KEYWORDS = new Set(["while", "until", "for", "select"]);
const DECLARATION_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const GIT_HEAD_RE = /^(?:\S*\/)?git$/;

function isAssignment(w: ShellWord): boolean {
  return ASSIGNMENT_RE.test(w.raw);
}

function assignmentName(w: ShellWord): string {
  return ASSIGNMENT_RE.exec(w.raw)![1]!;
}

function newState(): WalkState {
  return {
    cur: CWD_SET,
    oldpwd: UNKNOWN_SET,
    stack: [],
    stackTruncated: false,
    cdpath: false,
    evalDepth: 0,
    loops: [],
  };
}

/** The state a subshell starts in: a copy whose moves do not reach the parent or its loops. */
function subshellState(st: WalkState): WalkState {
  return { ...st, stack: st.stack.slice(), loops: [] };
}

function emptyCommand(): SimpleCommand {
  return { words: [], redirs: [], group: null };
}

interface ExecInfo {
  moved: boolean;
  negated: boolean;
  evalFail: DirSet | null;
}

class Walker {
  readonly out: OutRecord[] = [];

  walk(tokens: readonly ShellToken[], st: WalkState, finalUnion = true): { succ: DirSet; fail: DirSet } {
    let listStart = st.cur;
    let succ: DirSet | null = null;
    let fail: DirSet | null = null;
    let andOrOp: string | null = null;
    let inPipe = false;
    let pipeStart: DirSet | null = null;
    const compound: CompoundFrame[] = [];
    const loopsAtEntry = st.loops.length;
    let cmd = emptyCommand();

    const finishCommand = (nextOp: string | null): void => {
      const top = compound[compound.length - 1];
      const casePattern = top !== undefined && top.kind === "case" && top.expectPattern;
      if (cmd.words.length === 0 && cmd.redirs.length === 0 && cmd.group === null) {
        cmd = emptyCommand();
        return;
      }
      let start: DirSet;
      if (inPipe && pipeStart !== null) start = pipeStart;
      else if (andOrOp === "&&" && succ !== null) start = succ;
      else if (andOrOp === "||" && fail !== null) start = fail;
      else start = st.cur;
      st.cur = start;
      const before = { cur: st.cur, oldpwd: st.oldpwd, stack: st.stack.slice(), stackTruncated: st.stackTruncated };
      const nextIsPipe = nextOp === "|" || nextOp === "|&";
      if (nextIsPipe && !inPipe) pipeStart = start;
      let info: ExecInfo = { moved: false, negated: false, evalFail: null };
      if (cmd.group !== null) {
        // Words before a `( )` group are keywords (`while (cmd)`, `!`,
        // `for ((...))`): read them first, then the group as a subshell.
        if (cmd.words.length > 0) info = this.execCommand({ words: cmd.words, redirs: [], group: null }, st, compound);
        this.walk(cmd.group, subshellState(st));
      } else if (!casePattern) {
        info = this.execCommand(cmd, st, compound);
      }
      let cs = st.cur;
      let cf = info.evalFail ?? (info.moved ? before.cur : st.cur);
      if (info.negated) [cs, cf] = [cf, cs];
      cmd = emptyCommand();
      if (nextIsPipe) {
        // Not the last element: its directory changes stay in its subshell.
        st.cur = before.cur;
        st.oldpwd = before.oldpwd;
        st.stack = before.stack;
        st.stackTruncated = before.stackTruncated;
        inPipe = true;
        return;
      }
      if (inPipe && pipeStart !== null) {
        cs = union(pipeStart, cs);
        cf = union(pipeStart, cf);
        inPipe = false;
        pipeStart = null;
      }
      if (andOrOp === "&&" && succ !== null && fail !== null) {
        succ = cs;
        fail = union(fail, cf);
      } else if (andOrOp === "||" && succ !== null && fail !== null) {
        succ = union(succ, cs);
        fail = cf;
      } else {
        succ = cs;
        fail = cf;
      }
      st.cur = union(succ, fail);
    };

    const endList = (op: string | null): void => {
      if (op === "&") st.cur = listStart;
      else if (succ !== null && fail !== null) st.cur = union(succ, fail);
      succ = null;
      fail = null;
      andOrOp = null;
      inPipe = false;
      pipeStart = null;
      listStart = st.cur;
    };

    let i = 0;
    while (i < tokens.length) {
      const tk = tokens[i]!;
      if (tk.kind === "word") {
        if (cmd.words.length === 0 && !tk.quoted && tk.value === "case") {
          this.pushCompound(compound, {
            kind: "case",
            union: st.cur,
            entry: st.cur,
            header: true,
            expectPattern: false,
            loop: null,
            outStart: this.out.length,
          });
          i++;
          continue;
        }
        const top = compound[compound.length - 1];
        if (cmd.words.length === 0 && top !== undefined && top.kind === "case") {
          if (top.header) {
            if (tk.value === "in") {
              top.header = false;
              top.expectPattern = true;
            }
            i++;
            continue;
          }
          if (top.expectPattern) {
            if (tk.value === "esac") {
              compound.pop();
              st.cur = union(st.cur, top.union);
            }
            i++;
            continue;
          }
        }
        cmd.words.push(tk);
        i++;
        continue;
      }
      if (tk.kind === "redir") {
        cmd.redirs.push(tk);
        i++;
        continue;
      }
      const op = tk.op;
      const top = compound[compound.length - 1];
      const inCasePattern = top !== undefined && top.kind === "case" && top.expectPattern;
      if (inCasePattern && (op === "(" || op === "|")) {
        i++;
        continue;
      }
      if (inCasePattern && op === ")") {
        top.expectPattern = false;
        i++;
        continue;
      }
      if (op === "(") {
        const nextTk = tokens[i + 1];
        if (cmd.words.length > 0 && nextTk !== undefined && nextTk.kind === "op" && nextTk.op === ")") {
          // `name ( )`: a function definition; its body is walked in place.
          cmd = emptyCommand();
          i += 2;
          continue;
        }
        let d = 0;
        let j = i;
        for (; j < tokens.length; j++) {
          const t = tokens[j]!;
          if (t.kind !== "op") continue;
          if (t.op === "(") d++;
          else if (t.op === ")") {
            d--;
            if (d === 0) break;
          }
        }
        if (j >= tokens.length) throw new ShellModelError("unbalanced (");
        cmd.group = tokens.slice(i + 1, j);
        i = j + 1;
        continue;
      }
      if (op === ")") throw new ShellModelError("stray )");
      finishCommand(op);
      if (op === "&&" || op === "||") {
        andOrOp = op;
        i++;
        continue;
      }
      if (op === "|" || op === "|&") {
        i++;
        continue;
      }
      if (op === ";;" || op === ";&" || op === ";;&") {
        endList(op);
        if (top !== undefined && top.kind === "case") {
          top.union = union(top.union, st.cur);
          st.cur = top.entry;
          top.expectPattern = true;
        }
        i++;
        continue;
      }
      endList(op);
      i++;
    }
    finishCommand(null);
    const result = { succ: succ ?? st.cur, fail: fail ?? st.cur };
    if (finalUnion) endList(null);
    else st.cur = result.succ;
    // Unterminated compound commands: fold their branches in.
    for (const c of compound) st.cur = union(st.cur, c.union);
    st.loops.length = Math.min(st.loops.length, loopsAtEntry);
    return result;
  }

  private pushCompound(compound: CompoundFrame[], frame: CompoundFrame): void {
    if (compound.length >= MAX_COMPOUND_DEPTH) throw new ShellModelError("compound commands nested too deep");
    compound.push(frame);
  }

  private execCommand(cmd: SimpleCommand, st: WalkState, compound: CompoundFrame[]): ExecInfo {
    const info: ExecInfo = { moved: false, negated: false, evalFail: null };
    // Substitutions in any word run first, each in a subshell.
    for (const w of [...cmd.words, ...cmd.redirs.map((r) => r.target)]) {
      for (const sub of w.subs) this.walk(sub, subshellState(st));
    }
    let words = cmd.words;
    let k = 0;
    for (;;) {
      const w = words[k];
      if (w === undefined) break;
      const v = w.quoted ? null : w.value; // reserved words are never quoted
      if (v === "!") {
        info.negated = !info.negated;
        k++;
        continue;
      }
      if (v === "{" || v === "}") {
        k++;
        continue;
      }
      if (v === "time") {
        k++;
        if (words[k]?.value === "-p") k++;
        continue;
      }
      if (v !== null && RESERVED_OPEN.has(v)) {
        const loop = LOOP_KEYWORDS.has(v) ? { moved: false, relative: false } : null;
        const frame: CompoundFrame = {
          kind: v,
          union: st.cur,
          entry: st.cur,
          header: v === "case",
          expectPattern: false,
          loop,
          outStart: this.out.length,
        };
        this.pushCompound(compound, frame);
        if (loop !== null) st.loops.push(loop);
        if (v === "for" || v === "select" || v === "case") {
          if (v === "case" && words.slice(k + 1).some((x) => x.value === "in")) {
            frame.header = false;
            frame.expectPattern = true;
          }
          return info; // header only
        }
        k++;
        continue;
      }
      if (v !== null && RESERVED_MID.has(v)) {
        const top = compound[compound.length - 1];
        if (top !== undefined) {
          top.union = union(top.union, st.cur);
          st.cur = union(st.cur, top.union);
          // `for` / `select` bodies start at `do`; their header ran once.
          if (v === "do" && (top.kind === "for" || top.kind === "select")) top.outStart = this.out.length;
        }
        k++;
        continue;
      }
      if (v !== null && RESERVED_CLOSE.has(v)) {
        const top = compound.pop();
        if (top !== undefined) this.closeCompound(top, st);
        k++;
        continue;
      }
      if (v === "function") {
        // `function name { body; }`: the body is walked in place, like the
        // `name ( )` form (an over-approximation: it may never be called).
        k += 2;
        continue;
      }
      break;
    }
    words = words.slice(k);
    if (words.length === 0) return info;

    let a = 0;
    let inlineCdpath = false;
    while (a < words.length && isAssignment(words[a]!)) {
      if (assignmentName(words[a]!) === "CDPATH") inlineCdpath = true;
      a++;
    }
    if (a === words.length) {
      if (inlineCdpath) st.cdpath = true;
      return info;
    }
    words = words.slice(a);
    // Selectors that run the next word as a builtin in the current shell.
    for (;;) {
      const v = words[0]?.value;
      if (v === "builtin" || v === "noglob" || v === "nocorrect") {
        words = words.slice(1);
        continue;
      }
      if (v === "command") {
        let m = 1;
        for (;;) {
          const opt = words[m]?.value;
          if (opt === undefined || opt === null || !opt.startsWith("-") || opt === "-") break;
          if (/[vV]/.test(opt)) return info; // `command -v`: a lookup, nothing runs
          m++;
        }
        words = words.slice(m);
        continue;
      }
      break;
    }
    const headWord = words[0];
    if (headWord === undefined) return info;
    const head = headWord.value;
    if (head === null) return info; // a dynamic command word is out of scope
    if (DECLARATION_BUILTINS.has(head)) {
      if (words.slice(1).some((w) => isAssignment(w) && assignmentName(w) === "CDPATH")) st.cdpath = true;
    }
    const savedCdpath = st.cdpath;
    if (inlineCdpath) st.cdpath = true;
    try {
      if (head === "cd" || head === "chdir") {
        this.doCd(words.slice(1), st);
        info.moved = true;
        return info;
      }
      if (head === "pushd") {
        this.doPushd(words.slice(1), st);
        info.moved = true;
        return info;
      }
      if (head === "popd") {
        this.doPopd(words.slice(1), st);
        info.moved = true;
        return info;
      }
      if (head === "eval") {
        info.evalFail = this.doEval(words.slice(1), st, headWord);
        return info;
      }
    } finally {
      st.cdpath = savedCdpath;
    }
    this.gatedCommand(words, st, cmd);
    return info;
  }

  /** `done`, `fi`, `esac`: join the branches; a loop that moved also widens the commands inside it. */
  private closeCompound(top: CompoundFrame, st: WalkState): void {
    const loop = top.loop;
    if (loop !== null) {
      const idx = st.loops.lastIndexOf(loop);
      if (idx >= 0) st.loops.splice(idx, 1);
      if (loop.moved) {
        // A later iteration starts where the previous one ended.
        const later = loop.relative ? OPAQUE_SET : st.cur;
        for (let r = top.outStart; r < this.out.length; r++) {
          const rec = this.out[r]!;
          rec.dirs = union(rec.dirs, later);
        }
        if (loop.relative) st.cur = withPossibility(st.cur, OPAQUE);
      }
    }
    st.cur = union(st.cur, top.union);
  }

  private doEval(args: readonly ShellWord[], st: WalkState, evalWord: ShellWord): DirSet | null {
    if (st.evalDepth >= MAX_MODEL_EVAL_DEPTH) {
      st.cur = withPossibility(st.cur, OPAQUE);
      return null;
    }
    if (args.some((w) => w.value === null)) return null; // a dynamic `eval` is out of scope
    const source = args.map((w) => w.value).join(" ");
    const last = args[args.length - 1] ?? evalWord;
    let tokens: ShellToken[];
    try {
      tokens = new ShellLexer(source, { start: evalWord.start, end: last.end }).list(0, "top", 0).tokens;
    } catch {
      st.cur = withPossibility(st.cur, OPAQUE);
      return null;
    }
    const before = st.cur;
    st.evalDepth++;
    const res = this.walk(tokens, st, false);
    st.evalDepth--;
    return union(before, res.fail);
  }

  private moveTo(st: WalkState, next: DirSet, relative: boolean): void {
    for (const loop of st.loops) {
      loop.moved = true;
      if (relative) loop.relative = true;
    }
    st.oldpwd = st.cur;
    st.cur = next;
  }

  private doCd(args: readonly ShellWord[], st: WalkState): void {
    let m = 0;
    let mode: PathStepMode = "logical";
    while (m < args.length) {
      const v = args[m]!.value;
      if (v === "--") {
        m++;
        break;
      }
      if (v !== null && /^-[LPe@]+$/.test(v)) {
        for (const ch of v) {
          if (ch === "L") mode = "logical";
          else if (ch === "P") mode = "physical";
        }
        m++;
        continue;
      }
      break;
    }
    const rest = args.slice(m);
    if (rest.length === 0) {
      this.moveTo(st, UNKNOWN_SET, false); // $HOME
      return;
    }
    if (rest.length >= 2) {
      this.moveTo(st, OPAQUE_SET, false); // zsh two-argument substitution
      return;
    }
    const w = rest[0]!;
    if (w.value === "-") {
      this.moveTo(st, st.oldpwd, true);
      return;
    }
    if (w.value !== null && /^[+-]\d+$/.test(w.value)) {
      this.moveTo(st, this.stackUnion(st), true); // zsh stack entry
      return;
    }
    this.moveTo(st, joinSet(st.cur, w, mode, st.cdpath), isRelativeLiteral(w));
  }

  private doPushd(args: readonly ShellWord[], st: WalkState): void {
    let rest = args;
    let noCd = false;
    while (rest[0]?.value === "-n" || rest[0]?.value === "--") {
      if (rest[0].value === "-n") noCd = true;
      rest = rest.slice(1);
    }
    if (rest.length === 0) {
      const top = st.stack.pop();
      if (top === undefined) {
        if (st.stackTruncated) this.moveTo(st, OPAQUE_SET, true);
        return; // no other directory: an error, nothing moves
      }
      this.pushStack(st, st.cur);
      this.moveTo(st, top, true);
      return;
    }
    const w = rest[0]!;
    if (w.value !== null && /^[+-]\d+$/.test(w.value)) {
      this.moveTo(st, this.stackUnion(st), true);
      return;
    }
    const target = joinSet(st.cur, w, "logical", st.cdpath);
    if (noCd) {
      this.pushStack(st, target);
      return;
    }
    this.pushStack(st, st.cur);
    this.moveTo(st, target, true);
  }

  private doPopd(args: readonly ShellWord[], st: WalkState): void {
    let rest = args;
    let noCd = false;
    while (rest[0]?.value === "-n" || rest[0]?.value === "--") {
      if (rest[0].value === "-n") noCd = true;
      rest = rest.slice(1);
    }
    if (rest.length > 0) {
      // `popd +N` / `-N` removes an entry, `+0` changes directory.
      if (st.stack.length > 0 || st.stackTruncated) this.moveTo(st, this.stackUnion(st), true);
      return;
    }
    const top = st.stack.pop();
    if (top === undefined) {
      if (st.stackTruncated) this.moveTo(st, OPAQUE_SET, true);
      return; // directory stack empty: an error, nothing moves
    }
    if (noCd) return;
    this.moveTo(st, top, true);
  }

  private pushStack(st: WalkState, entry: DirSet): void {
    st.stack.push(entry);
    if (st.stack.length > MAX_DIR_STACK) {
      st.stack.shift();
      st.stackTruncated = true;
    }
  }

  private stackUnion(st: WalkState): DirSet {
    let r = st.cur;
    for (const entry of st.stack) r = union(r, entry);
    return st.stackTruncated ? withPossibility(r, OPAQUE) : r;
  }

  /** A command that is not a directory builtin: peel wrappers, apply relocation options, record it. */
  private gatedCommand(words: readonly ShellWord[], st: WalkState, cmd: SimpleCommand): void {
    const peeled = peelWrappers(words);
    let dirs = st.cur;
    if (peeled.envSplit) dirs = withPossibility(dirs, UNKNOWN);
    if (peeled.envChdir !== null) dirs = joinSet(dirs, peeled.envChdir, "physical", false);
    const rest = words.slice(peeled.idx);
    if (rest.length === 0) return;
    const head = rest[0]!.value;
    let canonicalWords: string[];
    if (head !== null && GIT_HEAD_RE.test(head)) {
      let j = 1;
      let gitDir: ShellWord | null = null;
      for (; j < rest.length; j++) {
        const t = rest[j]!.value;
        if (t === null) break;
        if (t === "-C") {
          const val = rest[j + 1];
          if (val === undefined) return;
          dirs = joinSet(dirs, val, "physical", false);
          j++;
          continue;
        }
        if (t === "--git-dir") {
          gitDir = rest[j + 1] ?? null;
          j++;
          continue;
        }
        if (t.startsWith("--git-dir=")) {
          gitDir = derivedWord(rest[j]!, t.slice("--git-dir=".length));
          continue;
        }
        if (GIT_VALUE_OPTIONS.has(t)) {
          j++;
          continue;
        }
        if (t.startsWith("-")) continue;
        break;
      }
      if (gitDir !== null) {
        const gd = gitDir.value !== null ? derivedWord(gitDir, parentIfDotGit(gitDir.value)) : gitDir;
        dirs = joinSet(dirs, gd, "physical", false);
      }
      canonicalWords = ["git", ...rest.slice(j).map(wordText)];
    } else {
      canonicalWords = rest.map(wordText);
    }
    const first = cmd.words[0] ?? rest[0]!;
    const lastWord = cmd.words[cmd.words.length - 1] ?? rest[rest.length - 1]!;
    this.out.push({
      canonical: canonicalWords.join(" "),
      span: { start: first.start, end: lastWord.end },
      dirs,
    });
  }
}

function isRelativeLiteral(w: ShellWord): boolean {
  return w.value !== null && !w.tilde && w.value !== "" && !path.posix.isAbsolute(w.value);
}

const GIT_VALUE_OPTIONS = new Set(["-c", "--namespace", "--work-tree", "--config-env", "--super-prefix"]);
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-P"]);

/** A word standing for part of another word (`--git-dir=<value>`, `-C<value>`). */
function derivedWord(w: ShellWord, value: string | null): ShellWord {
  return {
    ...w,
    value,
    literal: value ?? w.literal,
    tilde: value !== null && value.startsWith("~"),
  };
}

function parentIfDotGit(v: string): string {
  const t = v.replace(/\/+$/, "");
  if (t === ".git") return ".";
  if (t.endsWith("/.git")) return t.slice(0, -5) || "/";
  return v;
}

function wordText(w: ShellWord): string {
  return (w.value ?? w.raw).replace(/[\n;|&()]/g, "_");
}

/**
 * Peel the wrappers that run the next word as a program (`env`, `sudo`,
 * `doas`, `nice`, `timeout`, `nohup`, `setsid`, `time`, `command`, `exec`,
 * `stdbuf`) and leading assignments. `envChdir` is the last `env -C` value.
 */
function peelWrappers(words: readonly ShellWord[]): {
  idx: number;
  envChdir: ShellWord | null;
  envSplit: boolean;
} {
  let i = 0;
  let envChdir: ShellWord | null = null;
  let envSplit = false;
  const valueAt = (at: number): string | null | undefined => words[at]?.value;
  for (let guard = 0; guard < 64 && i < words.length; guard++) {
    const w = words[i]!;
    const v = w.value;
    if (isAssignment(w)) {
      i++;
      continue;
    }
    if (v === "env") {
      i++;
      while (i < words.length) {
        const cur = words[i]!;
        const dynamic = cur.value === null;
        const t = cur.value ?? cur.literal;
        if (dynamic && !/^(-C|--chdir=)/.test(t)) break;
        if (t === "--") {
          i++;
          break;
        }
        if (t === "-C" || t === "--chdir") {
          envChdir = words[i + 1] ?? null;
          i += 2;
          continue;
        }
        if (t.startsWith("--chdir=")) {
          envChdir = derivedWord(cur, dynamic ? null : t.slice("--chdir=".length));
          i++;
          continue;
        }
        if (/^-C./.test(t)) {
          envChdir = derivedWord(cur, dynamic ? null : t.slice(2));
          i++;
          continue;
        }
        if (t === "-S" || t === "--split-string" || t.startsWith("--split-string=") || /^-S./.test(t)) {
          envSplit = true;
          i++;
          break;
        }
        if (ENV_VALUE_OPTIONS.has(t)) {
          i += 2;
          continue;
        }
        if (t.startsWith("-")) {
          i++;
          continue;
        }
        if (isAssignment(cur)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    if (v === "sudo" || v === "doas") {
      i++;
      for (;;) {
        const t = valueAt(i);
        if (t === undefined || t === null || !t.startsWith("-")) break;
        i += /^-[ugpCrtTDhUc]$/.test(t) ? 2 : 1;
      }
      continue;
    }
    if (v === "nice") {
      i++;
      const t = valueAt(i) ?? "";
      if (t === "-n") i += 2;
      else if (/^-\d+$|^-n./.test(t)) i++;
      continue;
    }
    if (v === "timeout") {
      i++;
      for (;;) {
        const t = valueAt(i);
        if (t === undefined || t === null || !t.startsWith("-")) break;
        i += /^-[ks]$/.test(t) ? 2 : 1;
      }
      i++; // the duration
      continue;
    }
    if (v === "nohup" || v === "setsid" || v === "time" || v === "command") {
      i++;
      for (;;) {
        const t = valueAt(i);
        if (t === undefined || t === null || !t.startsWith("-")) break;
        i++;
      }
      continue;
    }
    if (v === "exec") {
      i++;
      for (;;) {
        const t = valueAt(i);
        if (t === undefined || t === null || !t.startsWith("-")) break;
        i += t === "-a" ? 2 : 1;
      }
      continue;
    }
    if (v === "stdbuf") {
      i++;
      for (;;) {
        const t = valueAt(i);
        if (t === undefined || t === null || !t.startsWith("-")) break;
        i += /^-[ioe]$/.test(t) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  return { idx: i, envChdir, envSplit };
}

function namesDirectory(dirs: DirSet): boolean {
  for (const d of dirs.values()) {
    if (d.kind === "opaque") return true;
    if (d.kind === "path" && d.steps.length > 0) return true;
  }
  return false;
}

/**
 * Model every simple command of a Bash command line with the directories
 * it can run in. `null` when the command is longer than
 * `MAX_NORMALIZE_LENGTH` or cannot be lexed, and also when the model itself
 * fails for any other reason (the gate's fallback then applies).
 */
export function modelShellCommands(command: string): ModelCommand[] | null {
  if (command.length > MAX_NORMALIZE_LENGTH) return null;
  try {
    const { tokens } = new ShellLexer(command, null).list(0, "top", 0);
    const walker = new Walker();
    walker.walk(tokens, newState());
    return walker.out.map((rec) => ({
      canonical: rec.canonical,
      span: rec.span,
      namesDirectory: namesDirectory(rec.dirs),
      dirs: [...rec.dirs.values()],
    }));
  } catch {
    return null;
  }
}
