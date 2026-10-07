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
//   `cd` stays put; with the gate's `DirectoryOracle`, a top-level `cd` or
//   `pushd` into a directory that exists has no failure state, so
//   `cd frontend; ...; cd ..` comes back to where it started instead of
//   also reaching the parent; see `DirectoryOracle` for when the oracle is
//   asked at all). `A && B` starts B from A's success state,
//   `A || B` from its failure state, `!` swaps them, `;` / newline continue
//   from either,
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
// the environment, and zsh `AUTO_CD` and other zsh-only options.
//
// TRIGGER MATCHING (task d11762ce). Every modelled command also carries its
// texts at each wrapper-peeling stage (`ModelCommand.heads`), and the gate
// tests every `bash_match` trigger against them for every command, so a
// gated verb behind a compound prefix (`! git log`, `{ git log; }`,
// `if ...; then git log; fi`, a loop body) or behind `xargs` / `coproc`
// matches the policy the bare verb matches. Not read: commands run by a
// nested shell or another program's argument (`sh -c`, `find -exec`,
// `parallel`, `watch`), and wrappers not peeled here.

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

/** A `path` possibility: the working directory (no steps) or a composed path. */
export type PathPossibility = Extract<DirPossibility, { kind: "path" }>;

/**
 * The filesystem view the gate may lend the model. The model itself never
 * touches the filesystem: without an oracle, every directory change may
 * fail (the shell then stays where it was), so a later relative step is
 * also composed onto the directory before the change. With one, a `cd` or
 * `pushd` the oracle confirms (`certainDirectory`: the step, applied to the
 * base, lands in an existing directory the shell can enter) loses that
 * failure branch, so `cd frontend; npm test; cd ..; git status` runs
 * `git status` in the working directory only, not also in its parent. An
 * oracle answers `true` only when it knows; any doubt (a missing path, an
 * error, a spent work budget) is `false`, which keeps the branch. The model
 * asks only for a `cd` or `pushd` it can read without doubt: a literal
 * target, a shell-neutral spelling (not `chdir`, `command cd`, `noglob cd`
 * or `time -p cd`, which bash or zsh do not run as a directory change), no
 * redirection of its own, not inside a `{ }` group, a compound command, a
 * function body or an `eval` string (a failing group redirection, or a loop,
 * can stop it from running), a step `stepMayBeConfirmed` accepts (a
 * logical `..` only before every name), and only before the first command
 * that can make `cd` or `pushd` something other than the builtin (see
 * `SHELL_OVERRIDE_COMMANDS`): from there on the walk asks nothing.
 */
export interface DirectoryOracle {
  certainDirectory(base: PathPossibility, step: PathStep, target: PathPossibility): boolean;
}

/**
 * Whether a `cd` / `pushd` step may be confirmed at all (see
 * `DirectoryOracle`). A logical step with a `..` after a name
 * (`missing/..`, `README.md/../x`, `a/../b`) never is: bash and zsh fail
 * such a `cd` when the name is not a directory they can enter, while the
 * lexical result (the name and its `..` cancel out) can exist. Only `..`
 * components before every name (`..`, `../..`, `../x`, `./..`) are
 * accepted; they leave directories the shell is already in. A physical
 * step is not restricted here: the oracle walks it through the real
 * directories it names (`ModelPathResolver.certainDirectory`).
 */
export function stepMayBeConfirmed(step: PathStep): boolean {
  if (step.mode === "physical") return true;
  let named = false;
  for (const part of step.value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") named = true;
    else if (named) return false;
  }
  return true;
}

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
   * The command's text at every wrapper-peeling stage, outermost first, in
   * the same decoded, `_`-substituted form as `canonical`, which is the
   * last entry: the words after the compound prefixes (`!`, `{`, `time`,
   * compound keywords) with leading assignments and `builtin` / `command`
   * selectors, then the text after each peeled wrapper (`env`, `nohup`,
   * `xargs`, ...). A `bash_match` trigger is tested against each entry, so
   * a wrapper whose own spelling is gated (`env -u CLAUDE_SESSION_ID x`)
   * still matches when another wrapper or a compound prefix stands in front
   * of it, and a gated verb matches behind every wrapper.
   */
  readonly heads: readonly string[];
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

/** The model view of one command; see `ShellModelView` and, for `oracle`, `DirectoryOracle`. */
export function shellModelViewOf(command: string, oracle?: DirectoryOracle): ShellModelView {
  const commands = modelShellCommands(command, oracle);
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

const PATH_KEYS = new WeakMap<PathPossibility, string>();

function keyOf(d: DirPossibility): string {
  if (d.kind === "opaque") return "o";
  if (d.kind === "unknown") return "u";
  const cached = PATH_KEYS.get(d);
  if (cached !== undefined) return cached;
  let key = "p";
  for (const step of d.steps) key += `${step.mode === "logical" ? "L" : "P"}${step.value.length}:${step.value}`;
  PATH_KEYS.set(d, key);
  return key;
}

/**
 * A string that identifies a possibility: two possibilities with the same
 * key name the same directory the same way (same steps, same modes), so the
 * gate resolves each key once per event.
 */
export function dirPossibilityKey(d: DirPossibility): string {
  return keyOf(d);
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
  const own = step.mode === "logical" ? normalizeLogical(step.value) : step.value;
  let steps: PathStep[];
  const last = base[base.length - 1];
  if (path.posix.isAbsolute(step.value)) {
    steps = [{ value: own, mode: step.mode }];
  } else if (last !== undefined && last.mode === step.mode) {
    const joined = `${last.value}/${step.value}`;
    steps = [
      ...base.slice(0, -1),
      { value: step.mode === "logical" ? normalizeLogical(joined) : joined, mode: step.mode },
    ];
  } else {
    steps = [...base, { value: own, mode: step.mode }];
  }
  // A logical `.` names the directory before it (`cd x; cd ..` is back
  // where it started), so it is dropped: that directory and the one the
  // step leaves are one possibility, not two.
  const tail = steps[steps.length - 1];
  if (tail !== undefined && tail.mode === "logical" && tail.value === ".") steps.pop();
  if (composedLength(steps) > MAX_COMPOSED_PATH_LENGTH) return OPAQUE;
  return { kind: "path", steps };
}

/** Lexical normalisation of a logical step: `a/../b` is `b`, a trailing `/` is dropped. */
function normalizeLogical(v: string): string {
  const n = path.posix.normalize(v);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
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

function joinSet(
  set: DirSet,
  w: ShellWord,
  mode: PathStepMode,
  cdpathSearch: boolean,
  onJoin?: (base: DirPossibility, joined: DirPossibility) => void,
): DirSet {
  const m = new Map<string, DirPossibility>();
  for (const base of set.values()) {
    const joined = joinOne(base, w, mode, cdpathSearch);
    onJoin?.(base, joined);
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
  /**
   * Open `{ }` groups, plus the compound commands of the enclosing walks
   * (a subshell body or substitution inside an `if`). Only a directory
   * change at depth 0 of every walk is asked of the oracle.
   */
  enclosing: number;
}

interface OutRecord {
  canonical: string;
  heads: readonly string[];
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
/**
 * Commands after which a later `cd` or `pushd` may not be the builtin the
 * `DirectoryOracle` reasons about, or may not run at all: they enable,
 * disable, alias, hash or (re)define commands (bash and zsh), run code the
 * model does not see in the current shell (`source`, `.`), or install a
 * trap that can skip a command (`trap ... DEBUG` under bash `extdebug`).
 * Once the walk has seen one of them, or any function definition, a
 * dynamic command word, a dynamic `eval` or an assignment to one of
 * `SHELL_TABLE_PARAMETER_RE`'s tables, it asks the oracle nothing more and
 * every later directory change keeps its failure branch.
 */
const SHELL_OVERRIDE_COMMANDS = new Set([
  "enable",
  "disable",
  "alias",
  "unalias",
  "unfunction",
  "hash",
  "unhash",
  "autoload",
  "functions",
  "source",
  ".",
  "trap",
]);
/** zsh and bash parameters whose assignment defines a function, an alias or a hashed command. */
const SHELL_TABLE_PARAMETER_RE =
  /^(?:functions|aliases|galiases|saliases|dis_functions|dis_aliases|dis_galiases|dis_saliases|BASH_ALIASES|BASH_CMDS)(?:\[|\+?=)/;
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
    enclosing: 0,
  };
}

/**
 * The state a subshell starts in: a copy whose moves do not reach the
 * parent or its loops. `openCompounds` is the number of compound commands
 * open in the calling walk, which the subshell body is nested in.
 */
function subshellState(st: WalkState, openCompounds: number): WalkState {
  return { ...st, stack: st.stack.slice(), loops: [], enclosing: st.enclosing + openCompounds };
}

function emptyCommand(): SimpleCommand {
  return { words: [], redirs: [], group: null };
}

interface ExecInfo {
  moved: boolean;
  negated: boolean;
  evalFail: DirSet | null;
  /** Keys of the directories a directory change certainly succeeds from (see `DirectoryOracle`). */
  cannotFailFrom: ReadonlySet<string>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** `set` without the possibilities whose key is in `drop` (the same object when nothing is dropped). */
function withoutKeys(set: DirSet, drop: ReadonlySet<string>): DirSet {
  if (drop.size === 0) return set;
  const m = new Map<string, DirPossibility>();
  for (const [k, d] of set) if (!drop.has(k)) m.set(k, d);
  return m;
}

class Walker {
  readonly out: OutRecord[] = [];
  /**
   * True once the walk has seen a command that can make a later `cd` or
   * `pushd` something other than the builtin (see `SHELL_OVERRIDE_COMMANDS`);
   * from then on the oracle is not asked.
   */
  private builtinsInDoubt = false;

  constructor(private readonly oracle: DirectoryOracle | null) {}

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
      let info: ExecInfo = { moved: false, negated: false, evalFail: null, cannotFailFrom: NO_KEYS };
      if (cmd.group !== null) {
        // Words before a `( )` group are keywords (`while (cmd)`, `!`,
        // `for ((...))`): read them first, then the group as a subshell.
        if (cmd.words.length > 0) info = this.execCommand({ words: cmd.words, redirs: [], group: null }, st, compound);
        this.walk(cmd.group, subshellState(st, compound.length));
      } else if (!casePattern) {
        info = this.execCommand(cmd, st, compound);
      }
      let cs = st.cur;
      // A directory change that fails stays where it was, except from a
      // directory the oracle confirmed it cannot fail from.
      let cf = info.evalFail ?? (info.moved ? withoutKeys(before.cur, info.cannotFailFrom) : st.cur);
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
        const emptyParens = nextTk !== undefined && nextTk.kind === "op" && nextTk.op === ")";
        // `name ( )` defines a function (any name can shadow `cd`); zsh's
        // `( ) { ... }` is an anonymous one. Either ends the oracle's use.
        if (emptyParens) this.builtinsInDoubt = true;
        if (cmd.words.length > 0 && emptyParens) {
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
    const info: ExecInfo = { moved: false, negated: false, evalFail: null, cannotFailFrom: NO_KEYS };
    // Substitutions in any word run first, each in a subshell.
    for (const w of [...cmd.words, ...cmd.redirs.map((r) => r.target)]) {
      for (const sub of w.subs) this.walk(sub, subshellState(st, compound.length));
    }
    let words = cmd.words;
    let k = 0;
    // False once a prefix makes bash or zsh not run a `cd` as the builtin
    // (`command cd` runs an external program in zsh, `time -p cd` fails in
    // zsh, `noglob` / `nocorrect` exist only in zsh): such a `cd` is still
    // modelled as a move, but never asked of the oracle.
    let shellNeutral = true;
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
        st.enclosing = v === "{" ? st.enclosing + 1 : Math.max(0, st.enclosing - 1);
        k++;
        continue;
      }
      if (v === "time") {
        k++;
        if (words[k]?.value === "-p") {
          shellNeutral = false;
          k++;
        }
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
        this.builtinsInDoubt = true;
        k += 2;
        continue;
      }
      break;
    }
    words = words.slice(k);
    if (words.length === 0) return info;
    // The command as written after the compound prefixes: the first text a
    // `bash_match` trigger is tested against (see `ModelCommand.heads`).
    const headWords = words;

    let a = 0;
    let inlineCdpath = false;
    while (a < words.length && isAssignment(words[a]!)) {
      if (assignmentName(words[a]!) === "CDPATH") inlineCdpath = true;
      if (SHELL_TABLE_PARAMETER_RE.test(words[a]!.raw)) this.builtinsInDoubt = true;
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
        if (v !== "builtin") shellNeutral = false;
        words = words.slice(1);
        continue;
      }
      if (v === "command") {
        shellNeutral = false;
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
    if (head === null) {
      // A dynamic command word is out of scope, and can be any of the
      // `SHELL_OVERRIDE_COMMANDS`.
      this.builtinsInDoubt = true;
      return info;
    }
    if (SHELL_OVERRIDE_COMMANDS.has(head) || SHELL_TABLE_PARAMETER_RE.test(head)) this.builtinsInDoubt = true;
    if (DECLARATION_BUILTINS.has(head)) {
      if (words.slice(1).some((w) => isAssignment(w) && assignmentName(w) === "CDPATH")) st.cdpath = true;
    }
    const savedCdpath = st.cdpath;
    if (inlineCdpath) st.cdpath = true;
    // Whether the oracle may confirm this directory change (see
    // `DirectoryOracle`): a shell-neutral `cd` or `pushd` with no
    // redirection, outside every group, compound command and `eval`.
    const confirmable =
      this.oracle !== null &&
      !this.builtinsInDoubt &&
      shellNeutral &&
      cmd.redirs.length === 0 &&
      compound.length === 0 &&
      st.enclosing === 0 &&
      st.evalDepth === 0;
    try {
      if (head === "cd" || head === "chdir") {
        info.cannotFailFrom = this.doCd(words.slice(1), st, confirmable && head === "cd");
        info.moved = true;
        return info;
      }
      if (head === "pushd") {
        info.cannotFailFrom = this.doPushd(words.slice(1), st, confirmable);
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
    this.gatedCommand(words, st, cmd, headWords);
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
    if (args.some((w) => w.value === null)) {
      // A dynamic `eval` is out of scope, and can run any of the
      // `SHELL_OVERRIDE_COMMANDS`.
      this.builtinsInDoubt = true;
      return null;
    }
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

  /**
   * `cd` / `chdir`. Returns the keys of the directories the move certainly
   * succeeds from (`confirmable` and the oracle agree), so the failure
   * branch can leave them out.
   */
  private doCd(args: readonly ShellWord[], st: WalkState, confirmable: boolean): ReadonlySet<string> {
    let m = 0;
    let mode: PathStepMode = "logical";
    // `cd -Pe` may fail after it moved (bash: the new directory cannot be
    // determined): never confirmed.
    let mayFailAfterMove = false;
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
          // `-e` can fail after the move; `-@` is refused by bash 3.2 and zsh:
          // neither is a cd the oracle may confirm.
          else if (ch === "e" || ch === "@") mayFailAfterMove = true;
        }
        m++;
        continue;
      }
      break;
    }
    const rest = args.slice(m);
    if (rest.length === 0) {
      this.moveTo(st, UNKNOWN_SET, false); // $HOME
      return NO_KEYS;
    }
    if (rest.length >= 2) {
      this.moveTo(st, OPAQUE_SET, false); // zsh two-argument substitution
      return NO_KEYS;
    }
    const w = rest[0]!;
    if (w.value === "-") {
      this.moveTo(st, st.oldpwd, true);
      return NO_KEYS;
    }
    if (w.value !== null && /^[+-]\d+$/.test(w.value)) {
      this.moveTo(st, this.stackUnion(st), true); // zsh stack entry
      return NO_KEYS;
    }
    const { next, cannotFailFrom } = this.joinConfirmed(st, w, mode, confirmable && !mayFailAfterMove);
    this.moveTo(st, next, isRelativeLiteral(w));
    return cannotFailFrom;
  }

  /**
   * `st.cur` joined with a `cd` / `pushd` target, and the keys of the
   * current directories from which the oracle confirms the target is an
   * existing directory the shell can enter. Only a join of a path onto a
   * path is asked about: a dynamic, `~`, glob or otherwise opaque target
   * joins to an `unknown` or `opaque` possibility, never a path.
   */
  private joinConfirmed(
    st: WalkState,
    w: ShellWord,
    mode: PathStepMode,
    confirmable: boolean,
  ): { next: DirSet; cannotFailFrom: ReadonlySet<string> } {
    const oracle = confirmable ? this.oracle : null;
    const step: PathStep | null = w.value === null ? null : { value: w.value, mode };
    if (oracle === null || step === null || !stepMayBeConfirmed(step)) {
      return { next: joinSet(st.cur, w, mode, st.cdpath), cannotFailFrom: NO_KEYS };
    }
    const cannotFailFrom = new Set<string>();
    const next = joinSet(st.cur, w, mode, st.cdpath, (base, joined) => {
      if (base.kind !== "path" || joined.kind !== "path") return;
      if (oracle.certainDirectory(base, step, joined)) cannotFailFrom.add(keyOf(base));
    });
    return { next, cannotFailFrom };
  }

  /** `pushd`; returns the directories the move certainly succeeds from, like `doCd`. */
  private doPushd(args: readonly ShellWord[], st: WalkState, confirmable: boolean): ReadonlySet<string> {
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
        return NO_KEYS; // no other directory: an error, nothing moves
      }
      this.pushStack(st, st.cur);
      this.moveTo(st, top, true);
      return NO_KEYS;
    }
    const w = rest[0]!;
    if (w.value !== null && /^[+-]\d+$/.test(w.value)) {
      this.moveTo(st, this.stackUnion(st), true);
      return NO_KEYS;
    }
    const { next: target, cannotFailFrom } = this.joinConfirmed(st, w, "logical", confirmable && !noCd);
    if (noCd) {
      this.pushStack(st, target);
      return NO_KEYS;
    }
    this.pushStack(st, st.cur);
    this.moveTo(st, target, true);
    return cannotFailFrom;
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
  private gatedCommand(
    words: readonly ShellWord[],
    st: WalkState,
    cmd: SimpleCommand,
    headWords: readonly ShellWord[],
  ): void {
    const peeled = peelWrappers(words);
    let dirs = st.cur;
    if (peeled.envSplit) dirs = withPossibility(dirs, UNKNOWN);
    if (peeled.envChdir !== null) dirs = joinSet(dirs, peeled.envChdir, "physical", false);
    let rest: readonly ShellWord[] = words.slice(peeled.idx);
    // Nothing left to run after the wrappers (`xargs`, `env`, `nohup -`):
    // keep the command as written, so peeling never drops a record.
    if (rest.length === 0) rest = words;
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
    const canonical = canonicalWords.join(" ");
    const offset = headWords.length - words.length;
    this.out.push({
      canonical,
      heads: stageTexts(headWords, [0, ...peeled.stages.map((i) => offset + i)], canonical),
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
 * The texts of `words` from each stage index on (deduplicated, in order),
 * then `canonical` when it differs from the last one. The words are joined
 * once and every stage is a suffix of that one string, so a long argument
 * list behind many wrappers is not joined once per wrapper.
 */
function stageTexts(words: readonly ShellWord[], stages: readonly number[], canonical: string): string[] {
  const texts = words.map(wordText);
  const starts: number[] = [];
  let at = 0;
  for (const t of texts) {
    starts.push(at);
    at += t.length + 1;
  }
  const full = texts.join(" ");
  const out: string[] = [];
  let last = -1;
  for (const s of stages) {
    if (s <= last || s >= texts.length) continue;
    last = s;
    out.push(full.slice(starts[s]));
  }
  if (out[out.length - 1] !== canonical) out.push(canonical);
  return out;
}

/**
 * Peel the wrappers that run the next word as a program (`env`, `sudo`,
 * `doas`, `nice`, `timeout`, `nohup`, `setsid`, `time`, `command`, `exec`,
 * `stdbuf`, `xargs`, `coproc`) and leading assignments. `envChdir` is the
 * last `env -C` value. `stages` holds the index of every word a peel step
 * started at, and the final `idx`, in order (see `ModelCommand.heads`).
 */
function peelWrappers(words: readonly ShellWord[]): {
  idx: number;
  envChdir: ShellWord | null;
  envSplit: boolean;
  stages: number[];
} {
  let i = 0;
  let envChdir: ShellWord | null = null;
  let envSplit = false;
  const stages: number[] = [];
  const valueAt = (at: number): string | null | undefined => words[at]?.value;
  for (let guard = 0; guard < 64 && i < words.length; guard++) {
    const w = words[i]!;
    const v = w.value;
    if (stages[stages.length - 1] !== i) stages.push(i);
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
    if (v === "xargs") {
      i = skipXargsOptions(words, i + 1);
      continue;
    }
    if (v === "coproc" && !w.quoted) {
      // `coproc cmd`, `coproc { cmd; }`, `coproc NAME { cmd; }`. Peeled here,
      // not in the walker's prefix loop, because the coprocess runs in a
      // subshell: a `cd` behind it must not move the modelled shell.
      i++;
      if (words[i + 1]?.value === "{" && !words[i + 1]!.quoted && /^\w+$/.test(valueAt(i) ?? "")) i++;
      if (words[i]?.value === "{" && !words[i]!.quoted) i++;
      continue;
    }
    break;
  }
  if (stages[stages.length - 1] !== i) stages.push(i);
  return { idx: i, envChdir, envSplit, stages };
}

/** `xargs` options whose value is the next word when not attached (GNU and BSD). */
const XARGS_VALUE_SHORT = new Set(["a", "d", "E", "I", "J", "L", "n", "P", "R", "S", "s"]);
/** `xargs` long options with a required value. */
const XARGS_VALUE_LONG = ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"];
/** `xargs` long options with no value or an optional attached one. */
const XARGS_OTHER_LONG = [
  "null", "eof", "replace", "max-lines", "interactive", "no-run-if-empty", "verbose", "exit",
  "show-limits", "open-tty", "help", "version",
];

/**
 * The index of the command `xargs` runs: past its options from `i` on. A
 * short option word is read as a getopt cluster (`-0rn1`, `-I{}`, `-I {}`);
 * a long option takes the next word only when it is (an unambiguous prefix
 * of) one with a required value and carries no `=`. A misread moves the
 * head onto another word: the run command's match is then lost (the text
 * arms and the earlier stages still apply) or an argument word is matched
 * (over-blocking); no match another arm or stage makes is removed.
 */
function skipXargsOptions(words: readonly ShellWord[], start: number): number {
  let i = start;
  while (i < words.length) {
    const t = words[i]!.value;
    if (t === null || !t.startsWith("-") || t === "-") break;
    if (t === "--") return i + 1;
    if (t.startsWith("--")) {
      const name = t.slice(2);
      const takesNext =
        !name.includes("=") &&
        XARGS_VALUE_LONG.some((n) => n.startsWith(name)) &&
        !XARGS_OTHER_LONG.some((n) => n.startsWith(name));
      i += takesNext ? 2 : 1;
      continue;
    }
    let next = 1;
    for (let c = 1; c < t.length; c++) {
      if (XARGS_VALUE_SHORT.has(t[c]!)) {
        if (c === t.length - 1) next = 2;
        break;
      }
    }
    i += next;
  }
  return i;
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
 * fails for any other reason (the gate's fallback then applies). `oracle`
 * (optional, see `DirectoryOracle`) lets the walk drop the failure branch
 * of a directory change that certainly succeeds.
 */
export function modelShellCommands(command: string, oracle?: DirectoryOracle): ModelCommand[] | null {
  if (command.length > MAX_NORMALIZE_LENGTH) return null;
  try {
    const { tokens } = new ShellLexer(command, null).list(0, "top", 0);
    const walker = new Walker(oracle ?? null);
    walker.walk(tokens, newState());
    return walker.out.map((rec) => ({
      canonical: rec.canonical,
      heads: rec.heads,
      span: rec.span,
      namesDirectory: namesDirectory(rec.dirs),
      dirs: [...rec.dirs.values()],
    }));
  } catch {
    return null;
  }
}
