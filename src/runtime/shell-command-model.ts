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
// - Refusals (task 9238cc27): a command line holding a compound shape this
//   walk would place in the wrong directory is refused as a whole instead
//   of read (`ShellModelView.refusal` names the construct; the gate then
//   fails closed for every per-repository `bash_match` policy, whether or
//   not the text holds a directory-changing word). The shapes are listed
//   at `REFUSAL_CONSTRUCTS`; each check sits where the walk would
//   otherwise misread the shape, and none of them applies inside data (an
//   arithmetic body, a `[[ ]]` condition, an array literal). A word that
//   references `CDPATH` (or zsh's `cdpath`) through an expansion, an
//   assignment, or the name position of a builtin that assigns by name
//   sets the `CDPATH` flag for the rest of the walk.
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
  /**
   * Set only when `commands` is `null` because the walk refused a shape it
   * cannot place (one of `REFUSAL_CONSTRUCTS`): the construct, for the
   * gate's deny text. A refused line fails closed for every per-repository
   * `bash_match` policy, not only when `directoryChangeWord` holds.
   */
  readonly refusal?: string;
  /**
   * Set only with `refusal`: the commands the walk reads with every refusal
   * check off (the reading before the refusals existed), or `null` when that
   * walk gives up too. For trigger matching only, never for attribution: a
   * policy the shell model's arm matched on this reading still matches, and
   * then fails closed on the refusal.
   */
  readonly triggerCommands?: readonly ModelCommand[] | null;
}

/**
 * The shapes the walk refuses (task 9238cc27), by kind: each one is read
 * by bash or zsh in a way the walk below does not follow, so a directory
 * change in it could reach a gated verb the walk places elsewhere. The text
 * names the construct for the gate's deny message.
 */
export const REFUSAL_CONSTRUCTS = {
  "case-terminator": "a `case` arm terminator (`;;`, `;&`, `;;&`) outside an open `case` arm",
  "case-fall-through": "a `case` arm that changes directory and falls through (`;&` or `;;&`) into the next arm",
  "case-arm-dir-stack":
    "a directory stack or `OLDPWD` read (`popd`, `pushd`, `cd -`, `cd +N`) in a `case` arm after an earlier arm changed directory",
  "alternate-form":
    "a compound command in an alternate form (a body or keyword directly after `]]` or `))`, `foreach`, `repeat`, " +
    "`always`, an anonymous function, or a word after a closing `}`)",
  "loop-body": "a `for` or `select` loop whose body is not a separate `do ... done` list, or a loop without its `done`",
  "command-word-brace":
    "a command word that starts with `{` or holds a brace expansion (or such a word in a line the gate cannot otherwise read)",
  "command-word-glob": "a command word that holds a glob (`*`, `?`, `[...]`)",
  coproc: "`coproc` with a compound command",
  "negated-compound": "`!` in front of a compound command (`{ }`, `if`, a loop, `case`)",
  "paren-after-word": "`(` after a word of a command (other than a function definition or an array assignment)",
} as const;

/** One kind of refused shape; see `REFUSAL_CONSTRUCTS`. */
export type RefusalKind = keyof typeof REFUSAL_CONSTRUCTS;

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
  const result = runModel(command, oracle);
  if (result.kind === "refused") {
    return {
      commands: null,
      directoryChangeWord: hasDirectoryChangeWord(command),
      refusal: REFUSAL_CONSTRUCTS[result.refusal],
      triggerCommands: result.read,
    };
  }
  const commands = result.kind === "ok" ? result.commands : null;
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
  /** An unquoted brace expansion (`{a,b}`, `{1..3}`); `glob` holds too. */
  readonly brace: boolean;
  /** An unquoted `*`, `?`, `[` or extended glob; `glob` holds too. */
  readonly wildcard: boolean;
  readonly tilde: boolean;
  readonly unusual: boolean;
  /**
   * A `$CDPATH` / `${CDPATH...}` (or zsh `cdpath`) expansion, or an
   * arithmetic expansion naming one, at this word's own level (not inside
   * a `$( )`, backtick or `<( )` body, which runs in a subshell).
   */
  readonly cdpathRef: boolean;
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

/** The walk met a shape it refuses to place (see `REFUSAL_CONSTRUCTS`). */
class ShellModelRefusal extends ShellModelError {
  constructor(readonly kind: RefusalKind) {
    super(`refused: ${kind}`);
  }
}

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
  wildcard: boolean;
  tilde: boolean;
  cdpathRef: boolean;
  subs: ShellToken[][];
}

/** `CDPATH` or zsh's `cdpath` as a whole identifier. */
const CDPATH_NAME_RE = /(?<![A-Za-z0-9_])(?:CDPATH|cdpath)(?![A-Za-z0-9_])/;

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
      wildcard: false,
      tilde: false,
      cdpathRef: false,
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
          b.wildcard = true;
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
    if (/[*?[]/.test(b.unquoted)) b.wildcard = true;
    if (b.wildcard) b.glob = true;
    const brace = /\{[^}\u0000]*(?:,|\.\.)[^}\u0000]*\}/.test(b.unquoted);
    if (brace) b.glob = true;
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
        brace,
        wildcard: b.wildcard,
        tilde: b.tilde,
        unusual: UNUSUAL_CHAR_RE.test(b.literal),
        cdpathRef: b.cdpathRef,
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
      const end = skipBalanced(s, i + 1, "(", ")");
      if (CDPATH_NAME_RE.test(s.slice(i, end))) b.cdpathRef = true;
      return { literal: null, end, quoted: false };
    }
    if (nx === "(") {
      const r = this.list(i + 2, "paren", depth + 1);
      b.subs.push(r.tokens);
      b.dynamic = true;
      return { literal: null, end: r.end, quoted: false };
    }
    if (nx === "{") {
      b.dynamic = true;
      const end = skipBalanced(s, i + 1, "{", "}");
      if (CDPATH_NAME_RE.test(s.slice(i, end))) b.cdpathRef = true;
      return { literal: null, end, quoted: false };
    }
    if (nx === "[") {
      b.dynamic = true;
      const end = skipBalanced(s, i + 1, "[", "]");
      if (CDPATH_NAME_RE.test(s.slice(i, end))) b.cdpathRef = true;
      return { literal: null, end, quoted: false };
    }
    if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      b.dynamic = true;
      const name = s.slice(i + 1, j);
      if (name === "CDPATH" || name === "cdpath") b.cdpathRef = true;
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
  /** Count of changes to the directory, `OLDPWD` or the stack in this shell (a subshell counts its own). */
  moves: number;
  /**
   * True inside a `case` arm when an earlier arm of that `case` changed
   * directory: the walk carries the stack and `OLDPWD` over from that arm,
   * which the shell does not, so a read of them is refused.
   */
  staleDirStack: boolean;
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
  /** `case`: `WalkState.moves` when the current arm started. */
  armMovesStart: number;
  /** `case`: some finished arm changed directory. */
  armMoved: boolean;
  /** `case`: `WalkState.staleDirStack` when the frame opened, restored at `esac`. */
  staleOuter: boolean;
  /** `for` / `select`: the header was read and the next command must start with `do`. */
  expectDo: boolean;
  /** `for` / `select`: `in` was read (a header may put `in` on the next line). */
  sawIn: boolean;
}

/** How a `( )` group of a command is read. */
type GroupKind = "subshell" | "data";

interface SimpleCommand {
  words: ShellWord[];
  redirs: ShellRedirection[];
  group: ShellToken[] | null;
  /** Index in `words` where `group` stood (words from it on came after the group). */
  groupAt: number;
  /**
   * `data`: an arithmetic body (`(( ))`, `for (( ))`), an array literal
   * (`NAME=( )`) or parentheses inside a `[[ ]]` condition; nothing in it
   * runs as a command, so the structural refusals do not apply in it.
   */
  groupKind: GroupKind;
  /** `data` group: an arithmetic body (`(( ))`), whose bare names are variables. */
  groupArith: boolean;
}

/** Per-walk state of the refusal checks. */
interface WalkScope {
  /** A `[[` condition was opened and its `]]` not read yet (the lexer splits a condition at `&&`, `||`, `(`). */
  condOpen: boolean;
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

/** An assignment to `CDPATH` or zsh's `cdpath` (an element of it included). */
function isCdpathAssignment(w: ShellWord): boolean {
  return /^(?:CDPATH|cdpath)(?:\[[^\]]*\])?\+?=/.test(w.raw);
}

/**
 * Builtins that assign a variable named by an argument; a `CDPATH` among
 * their arguments sets the flag. The declaration builtins are included.
 */
const ASSIGNING_BUILTINS = new Set([
  ...DECLARATION_BUILTINS,
  "read",
  "printf",
  "print",
  "getopts",
  "mapfile",
  "readarray",
  "let",
  "unset",
  "set",
  "integer",
  "float",
  "vared",
  "zparseopts",
  "sysread",
]);

/** Words that open a compound command after `coproc` (`coproc [NAME] COMPOUND`). */
const COMPOUND_OPENERS = new Set(["{", "[[", "if", "while", "until", "for", "select", "case", "repeat", "foreach"]);

/** A word that may follow a closing `}` in one command: another closer, or a reserved middle or closing word. */
function continuesCompound(w: ShellWord): boolean {
  const v = bareValue(w);
  return v !== null && (v === "}" || RESERVED_MID.has(v) || RESERVED_CLOSE.has(v));
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
    moves: 0,
    staleDirStack: false,
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
  return { words: [], redirs: [], group: null, groupAt: -1, groupKind: "subshell", groupArith: false };
}

/** A compound frame of `kind` opened in state `st`. */
function newFrame(kind: string, st: WalkState, outStart: number, loop: LoopFrame | null = null): CompoundFrame {
  return {
    kind,
    union: st.cur,
    entry: st.cur,
    header: kind === "case",
    expectPattern: false,
    loop,
    outStart,
    armMovesStart: st.moves,
    armMoved: false,
    staleOuter: st.staleDirStack,
    expectDo: false,
    sawIn: false,
  };
}

/** The unquoted value of a word (reserved words are never quoted), else `null`. */
function bareValue(w: ShellWord | undefined): string | null {
  return w === undefined || w.quoted ? null : w.value;
}

/** Words that keep the command position for a following `(`: `! (`, `if (`, `time -p (`, ... */
const PAREN_PREFIX_WORDS = new Set(["!", "{", "time", "if", "then", "else", "elif", "while", "until", "do"]);

/** `words` without its leading prefix words (see `PAREN_PREFIX_WORDS`; `-p` and `--` after `time`). */
function stripPrefixWords(words: readonly ShellWord[]): readonly ShellWord[] {
  let k = 0;
  let afterTime = false;
  for (; k < words.length; k++) {
    const v = bareValue(words[k]);
    if (v !== null && PAREN_PREFIX_WORDS.has(v)) {
      afterTime = v === "time";
      continue;
    }
    if (afterTime && (v === "-p" || v === "--")) continue;
    break;
  }
  return words.slice(k);
}

/** A word that opens an array literal: `NAME=(` or `NAME+=(`. */
const ARRAY_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;

/**
 * True when the `(` at `open` and the `)` at `close` are the outer pair of
 * an arithmetic `(( ... ))`: the next token is a `(` glued to the first and
 * matched by a `)` glued to the last. `( (x) )` and `((x) )` are nested
 * subshells in bash and zsh, and so is any pair whose inner `)` closes
 * before the end; tokens without their own position (a backtick body, an
 * `eval` string) are never read as arithmetic.
 */
function isArithmeticGroup(tokens: readonly ShellToken[], open: number, close: number): boolean {
  const inner = tokens[open + 1];
  const innerClose = tokens[close - 1];
  if (inner === undefined || innerClose === undefined || close - 1 <= open + 1) return false;
  if (inner.kind !== "op" || inner.op !== "(" || innerClose.kind !== "op" || innerClose.op !== ")") return false;
  let d = 0;
  for (let j = open + 1; j < close; j++) {
    const t = tokens[j]!;
    if (t.kind !== "op") continue;
    if (t.op === "(") d++;
    else if (t.op === ")") {
      d--;
      if (d === 0 && j !== close - 1) return false;
    }
  }
  const outer = tokens[open]!;
  const outerClose = tokens[close]!;
  const own = (t: ShellToken): boolean => t.end - t.start === 1;
  return (
    own(outer) &&
    own(inner) &&
    own(innerClose) &&
    own(outerClose) &&
    outer.end === inner.start &&
    innerClose.end === outerClose.start
  );
}

/**
 * Whether a data group's words name `CDPATH` in the current shell: an
 * expansion in any word, or, in an arithmetic body, the bare name (a
 * variable there). Substitution bodies are subshells and do not count.
 */
function tokensReferenceCdpath(tokens: readonly ShellToken[], arith: boolean): boolean {
  for (const t of tokens) {
    const w = t.kind === "word" ? t : t.kind === "redir" ? t.target : null;
    if (w === null) continue;
    if (w.cdpathRef || (arith && CDPATH_NAME_RE.test(w.raw))) return true;
  }
  return false;
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
  /**
   * Greater than zero while the walk reads a data group (see
   * `SimpleCommand.groupKind`): the refusals do not apply there. A
   * substitution inside data runs as a command again and resets it.
   */
  private dataDepth = 0;

  constructor(
    private readonly oracle: DirectoryOracle | null,
    /** False for the reading `ShellModelView.triggerCommands` keeps: every refusal check is off. */
    private readonly refusals = true,
  ) {}

  /**
   * Refuse the whole command line (see `REFUSAL_CONSTRUCTS`), except inside
   * data. Returns only in data, where the walk goes on as before.
   */
  private refuse(kind: RefusalKind): void {
    if (this.dataDepth > 0 || !this.refusals) return;
    throw new ShellModelRefusal(kind);
  }

  /**
   * `( )` right after `words`: a function definition (`NAME ( )`,
   * `function NAME ( )`, behind prefix words) is read as today; zsh's
   * anonymous functions (`( ) { ... }`, `function ( ) { ... }`) run their
   * body at once, which the walk does not follow.
   */
  private checkFunctionParens(words: readonly ShellWord[]): void {
    const rest = stripPrefixWords(words);
    const first = bareValue(rest[0]);
    if (rest.length === 0 || (rest.length === 1 && first === "function")) this.refuse("alternate-form");
    else if (!(rest.length === 1 || (rest.length === 2 && first === "function"))) this.refuse("paren-after-word");
  }

  /**
   * How a `( )` group after `cmd.words` is read. At command position (no
   * word before it but prefix words) it is a subshell, or, glued as
   * `(( ))`, an arithmetic body (data). After `for` / `select` only an
   * arithmetic header is read; inside a `[[ ]]` condition and after
   * `NAME=` it is data. Any other word before it, or a second group in one
   * command, is refused: the walk would read the group as a subshell where
   * bash refuses the line and zsh reads a zsh-only form.
   */
  private classifyGroup(cmd: SimpleCommand, arith: boolean, scope: WalkScope): GroupKind {
    if (cmd.group !== null) {
      this.refuse("paren-after-word");
      return "subshell";
    }
    const rest = stripPrefixWords(cmd.words);
    // Parentheses that group a `[[ ]]` condition are data too.
    if (rest.length === 0) return arith || scope.condOpen ? "data" : "subshell";
    const head = bareValue(rest[0]);
    const closesCond = rest.some((w) => bareValue(w) === "]]");
    if (head === "for" || head === "select") {
      if (rest.length === 1 && arith) return "data";
      // zsh's `for NAME (WORDS) ...` and a `for` without an arithmetic header.
      this.refuse("loop-body");
      return "subshell";
    }
    if (head === "foreach") {
      this.refuse("alternate-form");
      return "subshell";
    }
    if (head === "coproc" && rest.length <= 2) {
      this.refuse("coproc");
      return "subshell";
    }
    if ((head === "[[" || scope.condOpen) && !closesCond) return "data";
    const last = rest[rest.length - 1]!;
    if (!last.quoted && ARRAY_ASSIGNMENT_RE.test(last.raw)) return "data";
    this.refuse("paren-after-word");
    return "subshell";
  }

  /**
   * Words after an arithmetic `(( ))` in one command: only a reserved word
   * that continues or closes a compound (`then`, `do`, `fi`, `}`, ...) is
   * read; a body glued to the condition (zsh's `if (( 1 )) cd a`,
   * `while (( c )) { ... }`) or to a `for (( ))` header is refused.
   */
  private checkAfterGroup(cmd: SimpleCommand): void {
    if (!cmd.groupArith || cmd.groupAt >= cmd.words.length) return;
    const before = stripPrefixWords(cmd.words.slice(0, cmd.groupAt));
    const head = bareValue(before[0]);
    if (head === "for" || head === "select") {
      this.refuse("loop-body");
      return;
    }
    const next = bareValue(cmd.words[cmd.groupAt]);
    if (next === null || !(RESERVED_MID.has(next) || RESERVED_CLOSE.has(next) || next === "}")) {
      this.refuse("alternate-form");
    }
  }

  walk(tokens: readonly ShellToken[], st: WalkState, finalUnion = true): { succ: DirSet; fail: DirSet } {
    let listStart = st.cur;
    let succ: DirSet | null = null;
    let fail: DirSet | null = null;
    let andOrOp: string | null = null;
    let inPipe = false;
    let pipeStart: DirSet | null = null;
    const compound: CompoundFrame[] = [];
    const loopsAtEntry = st.loops.length;
    const scope: WalkScope = { condOpen: false };
    let cmd = emptyCommand();

    const finishCommand = (nextOp: string | null): void => {
      const top = compound[compound.length - 1];
      const casePattern = top !== undefined && top.kind === "case" && top.expectPattern;
      if (cmd.words.length === 0 && cmd.redirs.length === 0 && cmd.group === null) {
        cmd = emptyCommand();
        return;
      }
      if (top !== undefined && top.expectDo) {
        // The command after a `for` / `select` header: only `do` (or the
        // header's `in` on a line of its own) keeps the loop the walk reads;
        // a body without `do` (zsh's short loops, a `{ }` body) never
        // reaches the `done` that closes the loop.
        const first = cmd.words[0];
        const v = first === undefined || first.quoted ? null : first.value;
        if (v === "in" && !top.sawIn) top.sawIn = true;
        else if (v !== "do") this.refuse("loop-body");
      }
      if (cmd.group !== null) this.checkAfterGroup(cmd);
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
        if (cmd.words.length > 0) {
          info = this.execCommand({ ...cmd, redirs: [], group: null }, st, compound, scope);
        }
        if (cmd.groupKind === "data") {
          // An arithmetic body, an array literal or a condition runs in the
          // current shell: a `CDPATH` it names reaches the walk.
          if (tokensReferenceCdpath(cmd.group, cmd.groupArith)) st.cdpath = true;
          this.dataDepth++;
          try {
            this.walk(cmd.group, subshellState(st, compound.length));
          } finally {
            this.dataDepth--;
          }
        } else {
          this.walk(cmd.group, subshellState(st, compound.length));
        }
      } else if (!casePattern) {
        info = this.execCommand(cmd, st, compound, scope);
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
        // A `CDPATH` expansion in any word (an argument, an assignment
        // value, a `case` subject or pattern) can assign it in this shell.
        if (tk.cdpathRef) st.cdpath = true;
        if (cmd.words.length === 0 && !tk.quoted && tk.value === "case") {
          this.pushCompound(compound, newFrame("case", st, this.out.length));
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
              st.staleDirStack = top.staleOuter;
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
        if (tk.target.cdpathRef) st.cdpath = true;
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
        if (emptyParens) {
          this.builtinsInDoubt = true;
          this.checkFunctionParens(cmd.words);
        }
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
        const arith = isArithmeticGroup(tokens, i, j);
        const kind = this.classifyGroup(cmd, arith, scope);
        cmd.group = tokens.slice(i + 1, j);
        cmd.groupAt = cmd.words.length;
        cmd.groupKind = kind;
        cmd.groupArith = arith && kind === "data";
        i = j + 1;
        continue;
      }
      if (op === ")") throw new ShellModelError("stray )");
      const terminator = op === ";;" || op === ";&" || op === ";;&";
      // A terminator ends an arm only while the walk is inside one: a
      // `case` it opened itself, past its `in` and the arm's pattern. A
      // `case` behind a prefix (`{ case`, `then case`) is a word of a
      // simple command here, so its arms would be read as that command.
      if (terminator && (top === undefined || top.kind !== "case" || top.header || top.expectPattern)) {
        this.refuse("case-terminator");
      }
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
      if (terminator) {
        endList(op);
        if (top !== undefined && top.kind === "case") {
          // The arm's last command left another compound open.
          if (compound[compound.length - 1] !== top) this.refuse("case-terminator");
          const armMoved = st.moves !== top.armMovesStart;
          // The next arm starts where this one ended, which the reset below
          // does not follow.
          if (armMoved && op !== ";;") this.refuse("case-fall-through");
          if (armMoved) top.armMoved = true;
          top.union = union(top.union, st.cur);
          st.cur = top.entry;
          top.expectPattern = true;
          top.armMovesStart = st.moves;
          // Only `cur` is reset: the stack and `OLDPWD` of an earlier arm
          // reach the next one, so reading them there is refused.
          st.staleDirStack = top.staleOuter || top.armMoved;
        }
        i++;
        continue;
      }
      endList(op);
      i++;
    }
    finishCommand(null);
    // A loop whose `done` the walk never read (a zsh `{ }` body, a short
    // loop): the widening of its commands for a later iteration never ran.
    if (compound.some((c) => c.loop !== null)) this.refuse("loop-body");
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

  private execCommand(cmd: SimpleCommand, st: WalkState, compound: CompoundFrame[], scope: WalkScope): ExecInfo {
    const info: ExecInfo = { moved: false, negated: false, evalFail: null, cannotFailFrom: NO_KEYS };
    // Substitutions in any word run first, each in a subshell. One inside
    // data runs as a command line of its own, so the refusals apply in it.
    const dataDepth = this.dataDepth;
    this.dataDepth = 0;
    try {
      for (const w of [...cmd.words, ...cmd.redirs.map((r) => r.target)]) {
        for (const sub of w.subs) this.walk(sub, subshellState(st, compound.length));
      }
    } finally {
      this.dataDepth = dataDepth;
    }
    let words = cmd.words;
    let k = 0;
    // False once a prefix makes bash or zsh not run a `cd` as the builtin
    // (`command cd` runs an external program in zsh, `time -p cd` fails in
    // zsh, `noglob` / `nocorrect` exist only in zsh): such a `cd` is still
    // modelled as a move, but never asked of the oracle.
    let shellNeutral = true;
    // A `!` read in this run of prefix words: it applies to the whole
    // compound command after it, while the walk applies it to the first
    // simple command inside, so a `&&` there would start from the wrong
    // branch.
    let bang = false;
    for (;;) {
      const w = words[k];
      if (w === undefined) break;
      const v = w.quoted ? null : w.value; // reserved words are never quoted
      if (v === "!") {
        info.negated = !info.negated;
        bang = true;
        k++;
        continue;
      }
      if (bang && (v === "{" || (v !== null && RESERVED_OPEN.has(v)))) this.refuse("negated-compound");
      if (v === "{" || v === "}") {
        st.enclosing = v === "{" ? st.enclosing + 1 : Math.max(0, st.enclosing - 1);
        k++;
        if (v === "}" && words[k] !== undefined && !continuesCompound(words[k]!)) {
          // zsh's `{ ... } always { ... }`; any other word there is a
          // syntax error in bash and zsh.
          this.refuse("alternate-form");
        }
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
        const frame = newFrame(v, st, this.out.length, loop);
        this.pushCompound(compound, frame);
        if (loop !== null) st.loops.push(loop);
        if (v === "for" || v === "select") {
          frame.expectDo = true;
          if (cmd.groupAt !== k + 1) {
            // `for NAME [in WORDS]`; with an arithmetic header the words
            // after it are checked with the group (`checkAfterGroup`).
            const name = words[k + 1];
            const third = words[k + 2];
            if (name !== undefined && CDPATH_NAME_RE.test(name.raw)) st.cdpath = true;
            // `for NAME do ...` and zsh's `for NAME BODY`: the walk reads a
            // header only, so a body glued to it would be dropped.
            if (third !== undefined && bareValue(third) !== "in") this.refuse("loop-body");
            if (third !== undefined) frame.sawIn = true;
          }
        }
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
          if (v === "do") top.expectDo = false;
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
        // zsh's anonymous `function { body; }` runs the body at once.
        this.builtinsInDoubt = true;
        const name = words[k + 1];
        if (name === undefined || bareValue(name) === "{") this.refuse("alternate-form");
        k += 2;
        continue;
      }
      break;
    }
    words = words.slice(k);
    if (words.length === 0) return info;
    // A `[[ ]]` condition: its words are data up to the `]]` that closes it
    // (the lexer splits a condition at `&&`, `||` and parentheses, so the
    // `]]` may come in a later command). Only a `}` may follow the `]]` in
    // one command: zsh reads a glued body (`if [[ c ]] cd a`), and bash 5
    // and zsh a glued `then` or `do`, which the walk would read as words.
    const cond = scope.condOpen || bareValue(words[0]) === "[[";
    if (cond) {
      let close = -1;
      for (let m = scope.condOpen ? 0 : 1; m < words.length; m++) {
        if (bareValue(words[m]) === "]]") {
          close = m;
          break;
        }
      }
      scope.condOpen = close < 0;
      if (close >= 0 && words.slice(close + 1).some((w) => bareValue(w) !== "}")) this.refuse("alternate-form");
    }

    let a = 0;
    let inlineCdpath = false;
    while (a < words.length && isAssignment(words[a]!)) {
      if (isCdpathAssignment(words[a]!)) inlineCdpath = true;
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
    if (!cond) this.checkCommandWord(words);
    // zsh's subscripted `cdpath[1]=...` reads as a command word here.
    if (isCdpathAssignment(headWord)) st.cdpath = true;
    const head = headWord.value;
    if (head === null) {
      // A dynamic command word is out of scope, and can be any of the
      // `SHELL_OVERRIDE_COMMANDS`.
      this.builtinsInDoubt = true;
      return info;
    }
    if (SHELL_OVERRIDE_COMMANDS.has(head) || SHELL_TABLE_PARAMETER_RE.test(head)) this.builtinsInDoubt = true;
    if (DECLARATION_BUILTINS.has(head)) {
      if (words.slice(1).some((w) => isAssignment(w) && isCdpathAssignment(w))) st.cdpath = true;
    }
    // A builtin that assigns a variable named by an argument (`read CDPATH`,
    // `printf -v CDPATH`, `typeset -T`, zsh `vared cdpath`).
    if (ASSIGNING_BUILTINS.has(head) && words.slice(1).some((w) => CDPATH_NAME_RE.test(w.raw))) st.cdpath = true;
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
    this.gatedCommand(words, st, cmd);
    return info;
  }

  /**
   * The command word and the words after it (prefix words, assignments and
   * `builtin` / `command` already taken off), outside a `[[ ]]` condition.
   */
  private checkCommandWord(words: readonly ShellWord[]): void {
    const headWord = words[0]!;
    // zsh reads a glued `{cd ...; }` as a group, bash a brace expansion
    // (`{cd,a}`, `c{d,}`) as the words it expands to.
    if ((headWord.raw.startsWith("{") && headWord.raw !== "{") || headWord.brace) this.refuse("command-word-brace");
    const head = bareValue(headWord);
    // A glob in the command word runs whatever file it matches (`c?` runs
    // `cd` when a file named `cd` is in the directory). `[` and `[[` are
    // the test commands.
    // An element assignment (`NAME[key]=value`) is read as the command word.
    if (headWord.wildcard && head !== "[" && head !== "[[" && !/^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/.test(headWord.raw)) {
      this.refuse("command-word-glob");
    }
    if (head === "coproc") {
      // `coproc COMPOUND` and bash's `coproc NAME COMPOUND` run the compound
      // in a subshell; the walk would read it as arguments.
      const first = bareValue(words[1]);
      const second = bareValue(words[2]);
      if ((first !== null && COMPOUND_OPENERS.has(first)) || (second !== null && COMPOUND_OPENERS.has(second))) {
        this.refuse("coproc");
      }
    }
    // zsh loops; `repeat N` is not a prefix there.
    if (head === "foreach" || head === "repeat") this.refuse("alternate-form");
    // zsh reads a `}` anywhere as the end of a group (`{ : } always { ... }`,
    // `if { c } { ... } else { ... }`): a word after it starts a new construct.
    for (let m = 1; m < words.length - 1; m++) {
      if (bareValue(words[m]) === "}") this.refuse("alternate-form");
    }
  }

  /** `done`, `fi`, `esac`: join the branches; a loop that moved also widens the commands inside it. */
  private closeCompound(top: CompoundFrame, st: WalkState): void {
    if (top.kind === "case") st.staleDirStack = top.staleOuter;
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
    st.moves++;
  }

  /** A read of the `pushd` stack or `OLDPWD` (see `WalkState.staleDirStack`). */
  private readDirStack(st: WalkState): void {
    if (st.staleDirStack) this.refuse("case-arm-dir-stack");
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
      this.readDirStack(st);
      this.moveTo(st, st.oldpwd, true);
      return NO_KEYS;
    }
    if (w.value !== null && /^[+-]\d+$/.test(w.value)) {
      this.readDirStack(st);
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
      this.readDirStack(st);
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
      this.readDirStack(st);
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
    this.readDirStack(st);
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
    if (noCd) {
      st.moves++;
      return;
    }
    this.moveTo(st, top, true);
  }

  private pushStack(st: WalkState, entry: DirSet): void {
    st.moves++;
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
 * fails for any other reason (the gate's fallback then applies). `oracle`
 * (optional, see `DirectoryOracle`) lets the walk drop the failure branch
 * of a directory change that certainly succeeds.
 */
export function modelShellCommands(command: string, oracle?: DirectoryOracle): ModelCommand[] | null {
  const result = runModel(command, oracle);
  return result.kind === "ok" ? result.commands : null;
}

/** The model of a command line: its commands, a refusal (see `REFUSAL_CONSTRUCTS`), or not lexable. */
type ModelResult =
  | { readonly kind: "ok"; readonly commands: ModelCommand[] }
  | { readonly kind: "refused"; readonly refusal: RefusalKind; readonly read: ModelCommand[] | null }
  | { readonly kind: "unlexable" };

function runModel(command: string, oracle: DirectoryOracle | undefined): ModelResult {
  if (command.length > MAX_NORMALIZE_LENGTH) return { kind: "unlexable" };
  let tokens: ShellToken[];
  try {
    tokens = new ShellLexer(command, null).list(0, "top", 0).tokens;
  } catch {
    return { kind: "unlexable" };
  }
  try {
    return { kind: "ok", commands: walkCommands(tokens, oracle, true) };
  } catch (err) {
    if (err instanceof ShellModelRefusal) {
      return { kind: "refused", refusal: err.kind, read: readWithoutRefusals(tokens, oracle) };
    }
    // The walk gave up before it reached every command word. A word that
    // starts with `{` or holds a brace expansion can spell a directory
    // change no directory-changing word shows (`{cd,a}`), so such a line is
    // refused rather than left to the text fallback.
    if (holdsBraceWord(tokens)) return { kind: "refused", refusal: "command-word-brace", read: null };
    return { kind: "unlexable" };
  }
}

/** The model commands of a lexed command line; throws a `ShellModelError` where the walk gives up or refuses. */
function walkCommands(tokens: readonly ShellToken[], oracle: DirectoryOracle | undefined, refusals: boolean): ModelCommand[] {
  const walker = new Walker(oracle ?? null, refusals);
  walker.walk(tokens, newState());
  return walker.out.map((rec) => ({
    canonical: rec.canonical,
    span: rec.span,
    namesDirectory: namesDirectory(rec.dirs),
    dirs: [...rec.dirs.values()],
  }));
}

/** The commands the walk reads with every refusal check off, or `null` when it gives up (see `ShellModelView.triggerCommands`). */
function readWithoutRefusals(tokens: readonly ShellToken[], oracle: DirectoryOracle | undefined): ModelCommand[] | null {
  try {
    return walkCommands(tokens, oracle, false);
  } catch {
    return null;
  }
}

/** Some word of `tokens` (substitution bodies and redirection targets included) starts with `{` or holds a brace expansion. */
function holdsBraceWord(tokens: readonly ShellToken[]): boolean {
  for (const t of tokens) {
    const w = t.kind === "word" ? t : t.kind === "redir" ? t.target : null;
    if (w === null) continue;
    if (w.brace || (w.raw.startsWith("{") && w.raw !== "{")) return true;
    if (w.subs.some(holdsBraceWord)) return true;
  }
  return false;
}
