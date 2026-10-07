import { describe, expect, it } from "vitest";
import { MAX_NORMALIZE_LENGTH } from "../../src/runtime/command-normalize.js";
import {
  hasDirectoryChangeWord,
  lexShellCommand,
  MAX_COMPOSED_PATH_LENGTH,
  modelShellCommands,
  shellModelViewOf,
  stepMayBeConfirmed,
  type DirectoryOracle,
  type DirPossibility,
  type ModelCommand,
  type ShellToken,
  type ShellWord,
} from "../../src/runtime/shell-command-model.js";

// Task 7d4abf84: the quote-aware shell command model. These tests pin the
// lexer (word values and quote provenance, real operator boundaries) and
// the directory sets the walk computes for the gated command of every
// shape the task names, plus the control-flow rules and the bounds.

function words(command: string): ShellWord[] {
  const tokens = lexShellCommand(command);
  if (tokens === null) throw new Error(`could not lex ${JSON.stringify(command)}`);
  return tokens.filter((t): t is ShellWord => t.kind === "word");
}

function ops(command: string): string[] {
  const tokens = lexShellCommand(command) ?? [];
  return tokens.filter((t): t is Extract<ShellToken, { kind: "op" }> => t.kind === "op").map((t) => t.op);
}

function compact(d: DirPossibility): string {
  if (d.kind !== "path") return d.kind;
  if (d.steps.length === 0) return "cwd";
  return d.steps.map((s) => `${s.mode === "logical" ? "L" : "P"}:${s.value}`).join(" > ");
}

/** The model command whose canonical text starts with `head`, as compact sorted dirs. */
function dirsOf(command: string, head = "git log"): string[] {
  const model = modelShellCommands(command);
  if (model === null) throw new Error(`model is null for ${JSON.stringify(command)}`);
  const found = model.filter((c) => c.canonical === head || c.canonical.startsWith(`${head} `));
  if (found.length !== 1) {
    throw new Error(`expected one "${head}" in ${JSON.stringify(model.map((c) => c.canonical))}`);
  }
  return found[0]!.dirs.map(compact).sort();
}

/**
 * `dirsOf` with a directory oracle that confirms exactly the targets listed
 * (in `compact` form), and records every question it was asked.
 */
function dirsWithOracle(command: string, existing: readonly string[], asked: string[] = [], head = "git log"): string[] {
  const oracle: DirectoryOracle = {
    certainDirectory(base, step, target) {
      asked.push(`${compact(base)} + ${step.mode === "logical" ? "L" : "P"}:${step.value} = ${compact(target)}`);
      return existing.includes(compact(target));
    },
  };
  const model = modelShellCommands(command, oracle);
  if (model === null) throw new Error(`model is null for ${JSON.stringify(command)}`);
  const found = model.filter((c) => c.canonical === head || c.canonical.startsWith(`${head} `));
  if (found.length !== 1) {
    throw new Error(`expected one "${head}" in ${JSON.stringify(model.map((c) => c.canonical))}`);
  }
  return found[0]!.dirs.map(compact).sort();
}

function commandOf(command: string, head = "git log"): ModelCommand {
  const model = modelShellCommands(command) ?? [];
  const found = model.find((c) => c.canonical === head || c.canonical.startsWith(`${head} `));
  if (found === undefined) throw new Error(`no "${head}" in ${JSON.stringify(command)}`);
  return found;
}

const P = "vendor/libplain";
const T = "'vendor/lib`x`y'";

describe("lexShellCommand: words keep their decoded value and quote provenance", () => {
  it("decodes single, double and partial quoting", () => {
    const [cd, target] = words("cd 'vendor/lib sp'");
    expect(cd!.value).toBe("cd");
    expect(target!.value).toBe("vendor/lib sp");
    expect(target!.quoted).toBe(true);
    expect(words('cd "vendor/lib;semi"')[1]!.value).toBe("vendor/lib;semi");
    expect(words("cd vendor/'libplain'")[1]!.value).toBe("vendor/libplain");
  });

  it("decodes a backslash-escaped or partly quoted command word", () => {
    expect(words("\\cd x")[0]!.value).toBe("cd");
    expect(words("c''d x")[0]!.value).toBe("cd");
    expect(words('"c"d x')[0]!.value).toBe("cd");
    expect(words("git '-C' x log")[1]!.value).toBe("-C");
    expect(words("git -''C x log")[1]!.value).toBe("-C");
  });

  it("marks ANSI-C and locale quoting and decodes ANSI-C escapes", () => {
    const [ansi] = words("$'\\x63d'");
    expect(ansi!.ansiC).toBe(true);
    expect(ansi!.value).toBe("cd");
    const [loc] = words('$"vendor/ok"');
    expect(loc!.locale).toBe(true);
    // A `$` inside quotes is a literal, not ANSI-C or locale quoting.
    const [plain] = words("'a$'");
    expect(plain!.ansiC).toBe(false);
    expect(plain!.value).toBe("a$");
  });

  it("marks substitutions as dynamic, with their bodies lexed", () => {
    const [tick] = words("`git rev-parse --show-toplevel`");
    expect(tick!.backtick).toBe(true);
    expect(tick!.dynamic).toBe(true);
    expect(tick!.value).toBeNull();
    expect(tick!.subs).toHaveLength(1);
    const [subst] = words('"$(cd x && git log)"');
    expect(subst!.dynamic).toBe(true);
    expect(subst!.subs[0]!.filter((t) => t.kind === "word").map((t) => (t as ShellWord).value)).toEqual([
      "cd",
      "x",
      "git",
      "log",
    ]);
    expect(words("$HOME")[0]!.value).toBeNull();
    expect(words("${D}")[0]!.value).toBeNull();
  });

  it("marks unquoted globs and brace expansions, not quoted ones", () => {
    expect(words("vendor/libpl*")[0]!.glob).toBe(true);
    expect(words("vendor/libpl?in")[0]!.glob).toBe(true);
    expect(words("vendor/[l]ibplain")[0]!.glob).toBe(true);
    expect(words("{a,b}")[0]!.glob).toBe(true);
    expect(words("{1..3}")[0]!.glob).toBe(true);
    expect(words("{a}")[0]!.glob).toBe(false);
    expect(words("'vendor/libpl*'")[0]!.glob).toBe(false);
    expect(words("vendor/libpl\\*")[0]!.glob).toBe(false);
  });

  it("marks a leading tilde and an unusual character", () => {
    expect(words("~/x")[0]!.tilde).toBe(true);
    expect(words("a~")[0]!.tilde).toBe(false);
    expect(words("'lib\u001bz'")[0]!.unusual).toBe(true);
    expect(words("'lib\u2028z'")[0]!.unusual).toBe(true);
  });

  it("counts operators only outside quotes, escapes and expansions", () => {
    expect(ops("cd 'a;b|c&&d(e' && git log")).toEqual(["&&"]);
    expect(ops('cd "a;b" ; git log')).toEqual([";"]);
    expect(ops("cd a\\;b && git log")).toEqual(["&&"]);
    expect(ops('echo "$(a; b)" | git log')).toEqual(["|"]);
    expect(ops("a || b | c |& d & e ; f\ng")).toEqual(["||", "|", "|&", "&", ";", "\n"]);
  });

  it("removes a backslash-newline, also inside a word", () => {
    expect(words("cd vendor/lib\\\nplain")[1]!.value).toBe("vendor/libplain");
    expect(ops("cd x \\\n&& git log")).toEqual(["&&"]);
  });

  it("consumes heredoc bodies as data and skips comments", () => {
    const heredoc = "git commit -F - <<'EOF'\ndon't; cd elsewhere\nEOF\ngit push";
    expect(words(heredoc).map((w) => w.value)).toEqual(["git", "commit", "-F", "-", "git", "push"]);
    const tabbed = "cat <<-EOF\n\tbody's\n\tEOF\ngit log";
    expect(words(tabbed).map((w) => w.value)).toEqual(["cat", "git", "log"]);
    expect(words("git log # cd elsewhere").map((w) => w.value)).toEqual(["git", "log"]);
  });

  it("separates redirections, also with an fd or {var} prefix, from the words", () => {
    const tokens = lexShellCommand("cd x 2>&1 >/dev/null {fd}>out &>log")!;
    expect(tokens.filter((t) => t.kind === "word").map((t) => (t as ShellWord).value)).toEqual(["cd", "x"]);
    expect(tokens.filter((t) => t.kind === "redir").map((t) => (t as { op: string }).op)).toEqual([">&", ">", ">", "&>"]);
  });

  it("returns null when the command cannot be lexed", () => {
    expect(lexShellCommand("cd 'unterminated")).toBeNull();
    expect(lexShellCommand('git log "unterminated')).toBeNull();
    expect(lexShellCommand("echo $(unterminated")).toBeNull();
    expect(lexShellCommand("x".repeat(MAX_NORMALIZE_LENGTH + 1))).toBeNull();
    // nesting past MAX_MODEL_NESTING
    expect(lexShellCommand(`${"(".repeat(9)}true${")".repeat(9)}`)).toBeNull();
    expect(lexShellCommand(`${"(".repeat(8)}true${")".repeat(8)}`)).not.toBeNull();
  });
});

describe("modelShellCommands: the directories the gated command runs in, per shape", () => {
  // [label, command (git log form), expected dirs of `git log`]
  const shapes: Array<[string, string, string[]]> = [
    ["ctl:plain-cd", `cd ${P} && git log`, [`L:${P}`]],
    ["ctl:plain-C", `git -C ${P} log`, [`P:${P}`]],
    ["ctl:no-dir", "git log", ["cwd"]],
    ["ctl:opaque-cd", `cd ${T} && git log`, ["opaque"]],
    ["a:cd-P", `cd -P ${P} && git log`, [`P:${P}`]],
    ["a:cd-L", `cd -L ${P} && git log`, [`L:${P}`]],
    ["a:cd--", `cd -- ${P} && git log`, [`L:${P}`]],
    ["a:cd -LP (last wins)", `cd -L -P ${P} && git log`, [`P:${P}`]],
    ["a:pushd", `pushd ${P} && git log`, [`L:${P}`]],
    ["a:cd-redir-null", `cd ${P} >/dev/null && git log`, [`L:${P}`]],
    ["a:cd-redir-2>&1", `cd ${P} 2>&1 && git log`, [`L:${P}`]],
    ["a:redir-before-cd", `>/dev/null cd ${P} && git log`, [`L:${P}`]],
    ["a:brace-group", `{ cd ${P}; git log; }`, ["cwd", `L:${P}`]],
    ["a:builtin-cd", `builtin cd ${P} && git log`, [`L:${P}`]],
    ["a:command-cd", `command cd ${P} && git log`, [`L:${P}`]],
    ["a:eval-cd", `eval cd ${P} && git log`, [`L:${P}`]],
    ["a:eval-cd-quoted", `eval 'cd ${P}' && git log`, [`L:${P}`]],
    ["a:CDPATH-inline", "CDPATH=vendor cd libplain && git log", ["opaque"]],
    ["a:CDPATH-statement", "CDPATH=vendor; cd libplain && git log", ["opaque"]],
    ["a:CDPATH-export", "export CDPATH=vendor && cd libplain && git log", ["opaque"]],
    ["a:CDPATH with ./", "CDPATH=vendor cd ./libplain && git log", ["L:libplain"]],
    ["a:continuation-in-value", "cd vendor/lib\\\nplain && git log", [`L:${P}`]],
    ["a:continuation-before-op", `cd ${P} \\\n&& git log`, [`L:${P}`]],
    ["a:continuation-in-git", `git -C ${P} \\\nlog`, [`P:${P}`]],
    ["a:double-C-rel-rel", "git -C vendor -C libplain log", [`P:${P}`]],
    ["a:double-C-abs-rel", "git -C /w/outer/vendor -C libplain log", ["P:/w/outer/vendor/libplain"]],
    ["a:double-C-rel-abs", "git -C vendor/libok -C /w/outer/vendor/libplain log", ["P:/w/outer/vendor/libplain"]],
    ["a:double-C-other-plain", "git -C vendor/libok -C ../libplain log", ["P:vendor/libok/../libplain"]],
    ["a:env-double-C", `env -C vendor/libok -C ${P} git log`, [`P:${P}`]],
    ["a:env-double-C-chdir", `env --chdir=vendor/libok --chdir=${P} git log`, [`P:${P}`]],
    ["a:env -Cdir", `env -C${P} git log`, [`P:${P}`]],
    ["a:glob-star-cd", "cd vendor/libpl* && git log", ["opaque"]],
    ["a:glob-q-C", "git -C vendor/libpl?in log", ["opaque"]],
    ["a:glob-class-cd", "cd vendor/[l]ibplain && git log", ["opaque"]],
    ["a:glob-env-C", "env -C vendor/libpl* git log", ["opaque"]],
    ["a:sq-cd", `cd '${P}' && git log`, [`L:${P}`]],
    ["a:dq-cd", `cd "${P}" && git log`, [`L:${P}`]],
    ["a:partial-q-cd", "cd vendor/'libplain' && git log", [`L:${P}`]],
    ["a:sq-C", `git -C '${P}' log`, [`P:${P}`]],
    ["a:dq-C", `git -C "${P}" log`, [`P:${P}`]],
    ["a:dq-env-C", `env -C "${P}" git log`, [`P:${P}`]],
    ["a:dq-git-dir", `git --git-dir="${P}/.git" log`, [`P:${P}`]],
    ["a:space-sq-cd", "cd 'vendor/lib sp' && git log", ["L:vendor/lib sp"]],
    ["a:space-dq-cd", 'cd "vendor/lib sp" && git log', ["L:vendor/lib sp"]],
    ["a:space-bs-cd", "cd vendor/lib\\ sp && git log", ["L:vendor/lib sp"]],
    ["a:space-sq-C", "git -C 'vendor/lib sp' log", ["P:vendor/lib sp"]],
    ["a:space-sq-env-C", "env -C 'vendor/lib sp' git log", ["P:vendor/lib sp"]],
    ["a:space-git-dir", "git --git-dir='vendor/lib sp/.git' log", ["P:vendor/lib sp"]],
    ["a:qopt-sq-C", `git '-C' ${P} log`, [`P:${P}`]],
    ["a:qopt-dq-C", `git "-C" ${P} log`, [`P:${P}`]],
    ["a:qopt-partial-C", `git -''C ${P} log`, [`P:${P}`]],
    ["a:qopt-git-dir", `git '--git-dir=${P}/.git' log`, [`P:${P}`]],
    ["a:qopt-env-C", `env '-C' ${P} git log`, [`P:${P}`]],
    ["a:qopt-cd-word", `'cd' ${P} && git log`, [`L:${P}`]],
    ["a:bs-cd-word", `\\cd ${P} && git log`, [`L:${P}`]],
    ["a:partial-cd-word", `c''d ${P} && git log`, [`L:${P}`]],
    ["a:zsh-chdir", `chdir ${P} && git log`, [`L:${P}`]],
    ["a:zsh noglob cd", `noglob cd ${P} && git log`, [`L:${P}`]],
    ["b:then-cd-P", `cd ${T} && cd -P sub && git log`, ["opaque"]],
    ["b:then-cd-L", `cd ${T} && cd -L sub && git log`, ["opaque"]],
    ["b:then-cd--", `cd ${T} && cd -- sub && git log`, ["opaque"]],
    ["b:then-pushd", `cd ${T} && pushd sub && git log`, ["opaque"]],
    ["b:then-cd-redir", `cd ${T} && cd sub >/dev/null && git log`, ["opaque"]],
    ["b:then-builtin-cd", `cd ${T} && builtin cd sub && git log`, ["opaque"]],
    ["b:then-eval-cd", `cd ${T} && eval cd sub && git log`, ["opaque"]],
    ["b:then-dq-cd", `cd ${T} && cd "sub" && git log`, ["opaque"]],
    ["b:then-sq-cd", `cd ${T} && cd 'sub' && git log`, ["opaque"]],
    ["b:then-cd-dot", `cd ${T} && cd . && git log`, ["opaque"]],
    ["b:cd-minus", `cd ${T} && cd sub && cd - && git log`, ["opaque"]],
    ["b:cd-minus-abs", `cd ${T} && cd /tmp && cd - && git log`, ["opaque"]],
    ["b:popd", `pushd ${T} && pushd /tmp && popd && git log`, ["opaque"]],
    ["b:or-true", `cd ${T} || true && git log`, ["cwd", "opaque"]],
    ["b:or-chain", `cd ${T} || echo x && git log`, ["cwd", "opaque"]],
    ["b:bs-cd-word", `\\cd ${T} && git log`, ["opaque"]],
    ["b:partial-cd-word", `c''d ${T} && git log`, ["opaque"]],
    ["b:partial-cd-word-dq", `"c"d ${T} && git log`, ["opaque"]],
    ["b:zsh-chdir", `chdir ${T} && git log`, ["opaque"]],
    ["b:then-relative-C", `cd ${T} && git -C sub log`, ["opaque"]],
    ["b:then-dotdot-escaped-tick", `cd ${T} && cd .. && cd lib\\\`x\\\`y && git log`, ["opaque"]],
    ["b:subst-then-cd-P", "cd `echo vendor/libplain` && cd -P sub && git log", ["opaque"]],
    ["b:ansic-then-pushd", "cd $'vendor/libplain' && pushd sub && git log", ["opaque"]],
    ["c:sq-semi-cd", "cd 'vendor/lib;semi' && git log", ["L:vendor/lib;semi"]],
    ["c:dq-semi-cd", 'cd "vendor/lib;semi" && git log', ["L:vendor/lib;semi"]],
    ["c:sq-pipe-cd", "cd 'vendor/lib|pipe' && git log", ["L:vendor/lib|pipe"]],
    ["c:sq-amp-cd", "cd 'vendor/lib&&amp' && git log", ["L:vendor/lib&&amp"]],
    ["c:sq-paren-cd", "cd 'vendor/lib(paren' && git log", ["L:vendor/lib(paren"]],
    ["c:sq-newline-cd", "cd 'vendor/lib\nnl' && git log", ["opaque"]],
    ["c:bs-semi-cd", "cd vendor/lib\\;semi && git log", ["L:vendor/lib;semi"]],
    ["c:sq-semi-C", "git -C 'vendor/lib;semi' log", ["P:vendor/lib;semi"]],
    ["c:sq-semi-env-C", "env -C 'vendor/lib;semi' git log", ["P:vendor/lib;semi"]],
    ["c:sq-semi-tick-cd", "cd 'vendor/lib;`x`y' && git log", ["opaque"]],
    ["c:sq-semi-tick-C", "git -C 'vendor/lib;`x`y' log", ["opaque"]],
  ];
  for (const [label, command, expected] of shapes) {
    it(`${label}: ${JSON.stringify(command)}`, () => {
      expect(dirsOf(command)).toEqual([...expected].sort());
    });
  }
});

describe("modelShellCommands: composition and step modes", () => {
  it("composes a relative path onto a known directory, keeping each step's mode", () => {
    expect(dirsOf(`cd ${P} && git -C sub log`)).toEqual([`L:${P} > P:sub`]);
    expect(dirsOf(`env -C ${P} git -C sub log`)).toEqual([`P:${P}/sub`]);
    expect(dirsOf(`cd ${P} && cd sub && git log`)).toEqual([`L:${P}/sub`]);
    expect(dirsOf(`cd -P ${P} && cd .. && git log`)).toEqual([`P:${P} > L:..`]);
  });

  it("joins logical steps lexically and physical steps as written", () => {
    expect(dirsOf(`cd ${P} && cd .. && git log`)).toEqual(["L:vendor"]);
    expect(dirsOf(`git -C ${P} -C .. log`)).toEqual([`P:${P}/..`]);
  });

  it("an absolute target replaces every earlier step", () => {
    expect(dirsOf(`cd ${P} && git -C /abs/repo log`)).toEqual(["P:/abs/repo"]);
    expect(dirsOf(`cd ${T} && cd /abs/repo && git log`)).toEqual(["L:/abs/repo"]);
  });

  it("applies --git-dir after every -C, relative to the result", () => {
    expect(dirsOf("git --git-dir=inner/.git -C vendor log")).toEqual(["P:vendor/inner"]);
    expect(dirsOf("git -C vendor --git-dir=/abs/x/.git log")).toEqual(["P:/abs/x"]);
  });

  it("a dynamic value gives unknown and keeps a known base as a candidate", () => {
    expect(dirsOf(`git -C ${P} -C "$EMPTY" log`)).toEqual(["P:" + P, "unknown"].sort());
    expect(dirsOf('cd "$D" && git log')).toEqual(["cwd", "unknown"]);
    expect(dirsOf("cd ~/x && git log")).toEqual(["unknown"]);
    expect(dirsOf("cd && git log")).toEqual(["unknown"]);
    expect(dirsOf('cd "$(git rev-parse --show-toplevel)" && git status', "git status")).toEqual(["cwd", "unknown"]);
  });

  it("an empty value stays put", () => {
    expect(dirsOf('cd "" && git log')).toEqual(["cwd"]);
  });

  it("zsh two-argument cd is opaque, cd - returns the previous directory", () => {
    expect(dirsOf("cd a b && git log")).toEqual(["opaque"]);
    expect(dirsOf(`cd ${P} && cd /tmp && cd - && git log`)).toEqual([`L:${P}`]);
    expect(dirsOf("cd - && git log")).toEqual(["unknown"]);
  });

  it("tracks the pushd stack", () => {
    expect(dirsOf(`pushd ${P} && pushd /tmp && popd && git log`)).toEqual([`L:${P}`]);
    expect(dirsOf(`pushd ${P} && pushd /tmp && pushd && git log`)).toEqual([`L:${P}`]);
    expect(dirsOf("popd && git log")).toEqual(["cwd"]);
  });

  it("exec, env, sudo and nice in front of cd do not move the shell", () => {
    for (const prefix of ["exec", "env", "sudo", "nice"]) {
      expect(dirsOf(`${prefix} cd ${P}; git log`)).toEqual(["cwd"]);
    }
  });

  it("a composed path past MAX_COMPOSED_PATH_LENGTH reads as opaque", () => {
    const long = "d".repeat(MAX_COMPOSED_PATH_LENGTH);
    expect(dirsOf(`cd ${long} && git log`)).toEqual(["opaque"]);
    expect(dirsOf(`cd ${"d".repeat(100)} && git log`)).toEqual([`L:${"d".repeat(100)}`]);
  });
});

describe("modelShellCommands: control flow", () => {
  // [command, expected dirs of `git log`]; X is a plain directory.
  const table: Array<[string, string[]]> = [
    ["cd X && git log", ["L:X"]],
    ["cd X || git log", ["cwd"]],
    ["! cd X && git log", ["cwd"]],
    ["! cd X || git log", ["L:X"]],
    ["cd X; git log", ["L:X", "cwd"]],
    ["cd X\ngit log", ["L:X", "cwd"]],
    ["cd X & git log", ["cwd"]],
    ["cd X && git status & git log", ["cwd"]],
    ["cd X | git log", ["cwd"]],
    ["echo | cd X && git log", ["L:X", "cwd"]],
    ["(cd X) && git log", ["cwd"]],
    ["(cd X; git status); git log", ["cwd"]],
    ["{ cd X; } && git log", ["L:X", "cwd"]],
    ["cd X && cd Y || git log", ["L:X", "cwd"]],
    ["if cd X; then git log; fi", ["L:X", "cwd"]],
    ["if true; then cd X; fi; git log", ["L:X", "cwd"]],
    ["case a in a) cd X;; b) cd Y;; esac; git log", ["L:X", "L:Y", "cwd"]],
    ["eval 'cd X'; git log", ["L:X", "cwd"]],
    ["while true; do cd /abs/x; done; git log", ["L:/abs/x", "cwd"]],
    ["while true; do cd x; done; git log", ["L:x", "cwd", "opaque"]],
    ["for d in a b; do cd ..; done; git log", ["L:..", "cwd", "opaque"]],
    ["for ((i = 0; i < 2; i++)); do cd ..; done; git log", ["L:..", "cwd", "opaque"]],
    ["while (true); do cd x; done; git log", ["L:x", "cwd", "opaque"]],
    ["if (cd X); then git log; fi", ["cwd"]],
  ];
  for (const [command, expected] of table) {
    it(JSON.stringify(command), () => {
      expect(dirsOf(command)).toEqual([...expected].sort());
    });
  }

  it("models the commands inside substitutions, each in a subshell", () => {
    expect(dirsOf('echo "$(cd X && git log)"')).toEqual(["L:X"]);
    expect(dirsOf("echo `cd X && git log`")).toEqual(["L:X"]);
    expect(dirsOf("diff <(cd X && git log) y")).toEqual(["L:X"]);
    expect(dirsOf("exec > >(cd X && git log)")).toEqual(["L:X"]);
    expect(dirsOf('echo "$(cd X)" && git log')).toEqual(["cwd"]);
  });

  it("a command inside a loop body that moved also gets the directories a later iteration starts in", () => {
    expect(dirsOf("while true; do git log; cd /abs/x; done")).toEqual(["L:/abs/x", "cwd"]);
    expect(dirsOf("for d in a b; do git log; cd $d; done")).toEqual(["cwd", "unknown"]);
    expect(dirsOf("for d in a b; do cd ..; git log; done")).toEqual(["L:..", "cwd", "opaque"]);
    expect(dirsOf("while git log; do cd sub; done", "git log")).toEqual(["cwd", "opaque"]);
    // A loop whose body moves only in a subshell is unaffected.
    expect(dirsOf("for d in a b; do (cd $d && git status); git log; done")).toEqual(["cwd"]);
  });

  it("a function body is walked in place, in both definition forms", () => {
    expect(dirsOf("f() { cd X; }; f; git log")).toEqual(["L:X", "cwd"]);
    expect(dirsOf("function f { cd X; }; f; git log")).toEqual(["L:X", "cwd"]);
  });

  it("a dynamic eval or command word is out of scope and moves nothing", () => {
    expect(dirsOf('eval "cd $D"; git log')).toEqual(["cwd"]);
    expect(dirsOf("$CD x; git log")).toEqual(["cwd"]);
  });
});

describe("modelShellCommands: canonical text and namesDirectory", () => {
  it("peels wrappers, assignments and git global options and decodes words", () => {
    expect(commandOf(`A=1 env -C ${P} nice -n 5 git -c x=y --no-pager '-C' sub log --oneline`).canonical).toBe(
      "git log --oneline",
    );
    expect(commandOf("sudo -u x /usr/bin/git -C y push origin", "git push").canonical).toBe("git push origin");
    expect(commandOf(`cd ${P} && gh pr merge 1`, "gh pr merge").canonical).toBe("gh pr merge 1");
  });

  it("replaces shell boundary characters inside a value, so a pattern can only anchor at the start", () => {
    const c = commandOf(`git -C ${P} commit -m 'x; git push'`, "git commit");
    expect(c.canonical).toBe("git commit -m x_ git push");
    expect(commandOf("git log --grep='a|b&c(d)\ne'").canonical).toBe("git log --grep=a_b_c_d__e");
  });

  it("namesDirectory is true for a named path or an opaque possibility only", () => {
    expect(commandOf("git log").namesDirectory).toBe(false);
    expect(commandOf("! git log").namesDirectory).toBe(false);
    expect(commandOf('cd "$D" && git log').namesDirectory).toBe(false);
    expect(commandOf(`git -C ${P} log`).namesDirectory).toBe(true);
    expect(commandOf(`cd ${T} && git log`).namesDirectory).toBe(true);
  });

  it("records the span of the command's words in the original text", () => {
    const command = `cd ${P} && git -C sub log`;
    const c = commandOf(command);
    expect(command.slice(c.span.start, c.span.end)).toBe("git -C sub log");
  });
});

describe("modelShellCommands: bounds", () => {
  it("more than MAX_DIR_POSSIBILITIES possibilities read as one opaque possibility", () => {
    // Each `;` keeps the success and the failure state: 2, 4, 8, then 16.
    expect(dirsOf("cd a; cd b; cd c; git log")).toHaveLength(8);
    expect(dirsOf("cd a; cd b; cd c; cd d; git log")).toEqual(["opaque"]);
  });

  it("an eval nested past MAX_MODEL_EVAL_DEPTH is opaque", () => {
    expect(dirsOf("eval eval eval cd x; git log")).toEqual(["L:x", "cwd"]);
    expect(dirsOf("eval eval eval eval cd x; git log")).toContain("opaque");
  });

  it("a pushd stack past its tracked depth makes a pop past it opaque", () => {
    const pushes = Array.from({ length: 17 }, (_, i) => `pushd /d${i}`).join("; ");
    const pops = Array.from({ length: 17 }, () => "popd").join(" && ");
    expect(dirsOf(`${pushes}; ${pops} && git log`)).toContain("opaque");
  });

  it("returns null for a command it cannot lex, and for one past MAX_NORMALIZE_LENGTH", () => {
    expect(modelShellCommands("cd 'x && git log")).toBeNull();
    expect(modelShellCommands(`${"(".repeat(9)}true${")".repeat(9)}; cd x && git log`)).toBeNull();
    expect(modelShellCommands(`cd x && git log; ${"#".repeat(MAX_NORMALIZE_LENGTH)}`)).toBeNull();
    expect(modelShellCommands("git log )")).toBeNull();
  });
});

describe("shellModelViewOf / hasDirectoryChangeWord", () => {
  it("reports a directory-changing word only when the command could not be lexed", () => {
    expect(shellModelViewOf("cd x && git log")).toMatchObject({ directoryChangeWord: false });
    expect(shellModelViewOf("cd 'x && git log")).toEqual({ commands: null, directoryChangeWord: true });
    expect(shellModelViewOf("git log 'x")).toEqual({ commands: null, directoryChangeWord: false });
  });

  it("finds cd, pushd, popd, chdir, -C, --chdir and --git-dir, also partly quoted", () => {
    for (const command of [
      "cd x",
      "a; pushd x",
      "popd",
      "chdir x",
      "git -C x log",
      "env --chdir=x git log",
      "git --git-dir=x log",
      "env -Cx git log",
      "c''d x",
      "\\cd x",
      "git '-C' x log",
    ]) {
      expect(hasDirectoryChangeWord(command), command).toBe(true);
    }
    for (const command of ["git log", "echo abcd", "git commit -m cdx"]) {
      expect(hasDirectoryChangeWord(command), command).toBe(false);
    }
  });
});

describe("modelShellCommands: a directory oracle drops the failure branch of a cd that certainly succeeds", () => {
  it("without an oracle every cd may fail; a logical step back to the start is one possibility, not two", () => {
    expect(dirsOf("cd X; git log")).toEqual(["L:X", "cwd"]);
    // X/.. is the working directory itself: no separate `L:.` entry.
    expect(dirsOf("cd X; cd ..; git log")).toEqual(["L:..", "L:X", "cwd"]);
    expect(dirsOf("cd . && git log")).toEqual(["cwd"]);
    expect(dirsOf("cd X/ && git log")).toEqual(["L:X"]);
  });

  it("a confirmed cd has no failure branch", () => {
    expect(dirsWithOracle("cd X; git log", ["L:X"])).toEqual(["L:X"]);
    expect(dirsWithOracle("cd X; npm test; cd ..; git log", ["L:X", "cwd"])).toEqual(["cwd"]);
    expect(dirsWithOracle("cd X; cd ..; cd Y; cd ..; git log", ["L:X", "L:Y", "cwd"])).toEqual(["cwd"]);
    expect(dirsWithOracle("pushd X; git log", ["L:X"])).toEqual(["L:X"]);
    expect(dirsWithOracle("cd -P X; git log", ["P:X"])).toEqual(["P:X"]);
    expect(dirsWithOracle("cd /abs/x; git log", ["L:/abs/x"])).toEqual(["L:/abs/x"]);
    // `||` starts from the failure branch, which a confirmed cd does not have.
    expect(dirsWithOracle("cd X || git log", ["L:X"])).toEqual([]);
  });

  it("an unconfirmed cd keeps its failure branch", () => {
    expect(dirsWithOracle("cd X; git log", [])).toEqual(["L:X", "cwd"]);
    expect(dirsWithOracle("cd missing; cd ..; git log", ["cwd", "L:.."])).toEqual(["L:..", "cwd"]);
  });

  it("asks only about a literal target of a shell-neutral cd or pushd at the top level, with no redirection", () => {
    const notAsked: string[] = [
      "chdir X; git log",
      "command cd X; git log",
      "noglob cd X; git log",
      "time -p cd X; git log",
      "cd X >/dev/null; git log",
      "{ cd X; }; git log",
      "if true; then cd X; fi; git log",
      "eval cd X; git log",
      "cd -Pe X; git log",
      'cd "$D"; git log',
      "cd ~/x; git log",
      "cd -; git log",
      "pushd -n X; git log",
      "f() { cd X; }; f; git log",
    ];
    for (const command of notAsked) {
      const asked: string[] = [];
      dirsWithOracle(command, ["L:X", "P:X"], asked);
      expect(asked, command).toEqual([]);
    }
    for (const command of ["cd X; git log", "builtin cd X; git log", "time cd X; git log", "! cd X; git log", "pushd X; git log"]) {
      const asked: string[] = [];
      dirsWithOracle(command, [], asked);
      expect(asked, command).toEqual(["cwd + L:X = L:X"]);
    }
    // Inside a subshell or a substitution the same rule applies to its own top level.
    const asked: string[] = [];
    dirsWithOracle('echo "$(cd X; git log)"', ["L:X"], asked);
    expect(asked).toEqual(["cwd + L:X = L:X"]);
  });

  it("asks about the cd from every directory it can start in", () => {
    const asked: string[] = [];
    // From A the cd cannot fail; from the working directory it can.
    expect(dirsWithOracle("cd A; cd X; git log", ["L:A/X"], asked)).toEqual(["L:A/X", "L:X", "cwd"]);
    expect(asked).toEqual(["cwd + L:A = L:A", "L:A + L:X = L:A/X", "cwd + L:X = L:X"]);
  });
});

describe("modelShellCommands: time and command -v", () => {
  it("time and time -p in front of cd are transparent", () => {
    expect(dirsOf("time cd X && git log")).toEqual(["L:X"]);
    expect(dirsOf("time -p cd X && git log")).toEqual(["L:X"]);
  });

  it("command -v / -V in front of cd only look the name up", () => {
    expect(dirsOf("command -v cd X && git log")).toEqual(["cwd"]);
    expect(dirsOf("command -V cd X && git log")).toEqual(["cwd"]);
    expect(dirsOf("command cd X && git log")).toEqual(["L:X"]);
  });
});

describe("stepMayBeConfirmed: a logical .. only before every name", () => {
  it("accepts leading .. components, names and absolute paths", () => {
    for (const value of ["..", "../..", "../x", "./..", "../x/y", "x", "x/y", "/abs/x", "/..", ".", ""]) {
      expect(stepMayBeConfirmed({ value, mode: "logical" }), value).toBe(true);
    }
  });

  it("refuses a logical .. after a name", () => {
    for (const value of ["missing/..", "README.md/../x", "a/../b", "../x/..", "x/./..", "/a/../b", "missing/../../.."]) {
      expect(stepMayBeConfirmed({ value, mode: "logical" }), value).toBe(false);
    }
  });

  it("leaves physical steps to the oracle", () => {
    for (const value of ["missing/..", "a/../b", "../x"]) {
      expect(stepMayBeConfirmed({ value, mode: "physical" }), value).toBe(true);
    }
  });
});

describe("modelShellCommands: the oracle is not asked about a logical .. after a name", () => {
  it("asks nothing and keeps the failure branch, whatever the oracle would answer", () => {
    for (const command of [
      "cd missing/..; git log",
      "cd README.md/../x; git log",
      "cd a/../b; git log",
      "cd ../x/..; git log",
      "pushd a/../b; git log",
    ]) {
      const asked: string[] = [];
      dirsWithOracle(command, ["cwd", "L:x", "L:b", "L:.."], asked);
      expect(asked, command).toEqual([]);
    }
    // The nested layout of the review: lib is entered for certain, the
    // second `cd` may fail and leave the shell in lib.
    expect(dirsWithOracle("cd vendor/lib; cd missing/../../..; git log", ["L:vendor/lib", "cwd"])).toEqual([
      "L:vendor/lib",
      "cwd",
    ]);
    expect(dirsWithOracle("cd vendor/lib; cd README.md/../../..; git log", ["L:vendor/lib", "cwd"])).toEqual([
      "L:vendor/lib",
      "cwd",
    ]);
  });

  it("still asks about leading .. components and physical steps", () => {
    for (const [command, question] of [
      ["cd ..; git log", "cwd + L:.. = L:.."],
      ["cd ../x; git log", "cwd + L:../x = L:../x"],
      ["cd ./..; git log", "cwd + L:./.. = L:.."],
      ["cd -P a/../b; git log", "cwd + P:a/../b = P:a/../b"],
    ] as const) {
      const asked: string[] = [];
      dirsWithOracle(command, [], asked);
      expect(asked, command).toEqual([question]);
    }
    expect(dirsWithOracle("cd vendor/lib; cd ../..; git log", ["L:vendor/lib", "cwd"])).toEqual(["cwd"]);
  });
});

describe("modelShellCommands: after a command that can redefine cd, the oracle is not asked", () => {
  const overrides = [
    "cd() { :; }",
    "cd ( ) { :; }",
    "function cd { :; }",
    "pushd() { :; }",
    "f() { :; }",
    "function f { :; }",
    "() { :; }",
    "enable -n cd",
    "disable cd",
    "alias cd=:",
    "unalias cd",
    "unfunction cd",
    "hash -r",
    "unhash -f cd",
    "autoload -Uz cd",
    "functions -c f cd",
    "source ./env.sh",
    ". ./env.sh",
    "trap false DEBUG",
    "builtin enable -n cd",
    "X=1 alias cd=:",
    "'alias' cd=:",
    "$CMD -n cd",
    'eval "$X"',
    "functions[cd]=:",
    "aliases[cd]=:",
    "BASH_ALIASES[cd]=:",
    "BASH_CMDS[cd]=/bin/true",
    "functions+=(cd :)",
    "aliases=(cd :)",
    "(alias cd=:)",
    "eval 'cd() { :; }'",
  ];

  for (const override of overrides) {
    it(`${JSON.stringify(override)} keeps the failure branch of every later cd`, () => {
      const asked: string[] = [];
      const command = `cd X; ${override}; cd ..; git log`;
      expect(dirsWithOracle(command, ["L:X", "cwd"], asked), command).toEqual(["L:X", "cwd"]);
      // Only the `cd X` before it was asked about.
      expect(asked, command).toEqual(["cwd + L:X = L:X"]);
    });
  }

  it("a cd before the override is still confirmed, and the same words as arguments change nothing", () => {
    expect(dirsWithOracle("cd X; cd ..; cd() { :; }; git log", ["L:X", "cwd"])).toEqual(["cwd"]);
    for (const command of ["echo enable alias source; cd X; cd ..; git log", "git log --format=hash; cd X; cd ..; git log"]) {
      const model = modelShellCommands(command, {
        certainDirectory: (_base, _step, target) => ["L:X", "cwd"].includes(compact(target)),
      });
      const last = model?.filter((c) => c.canonical.startsWith("git log")).pop();
      expect(last?.dirs.map(compact), command).toEqual(["cwd"]);
    }
  });
});

describe("modelShellCommands: a subshell or substitution inside a compound command asks nothing", () => {
  it("the compound command of the enclosing walk counts", () => {
    for (const command of [
      "if true; then (cd X; git log); fi",
      "while true; do (cd X; git log); done",
      'if true; then echo "$(cd X; git log)"; fi',
      "if (cd X; git log); then :; fi",
      "for i in 1; do echo `cd X; git log`; done",
    ]) {
      const asked: string[] = [];
      dirsWithOracle(command, ["L:X"], asked);
      expect(asked, command).toEqual([]);
    }
  });
});

// Task d11762ce: the texts a `bash_match` trigger is tested against for
// every modelled command (the gate's fifth matching arm reads every
// command, not only one naming a directory).
describe("modelShellCommands: heads, the command text at each wrapper-peeling stage", () => {
  const headsOf = (command: string): string[][] => (modelShellCommands(command) ?? []).map((c) => [...c.heads]);

  it("a compound prefix is not part of any head; the canonical text is the last head", () => {
    expect(headsOf("{ git push; }")).toEqual([["git push"]]);
    expect(headsOf("! git push")).toEqual([["git push"]]);
    expect(headsOf("if true; then git push; fi")).toEqual([["true"], ["git push"]]);
    expect(headsOf("while git push; do :; done")).toEqual([["git push"], [":"]]);
    expect(headsOf("case a in a) git push;; esac")).toEqual([["git push"]]);
    expect(headsOf("git -C sub push")).toEqual([["git -C sub push", "git push"]]);
  });

  it("keeps leading assignments and every wrapper stage, so a gated wrapper spelling still matches", () => {
    expect(headsOf("A=1 nohup env -u CLAUDE_SESSION_ID true")).toEqual([
      ["A=1 nohup env -u CLAUDE_SESSION_ID true", "nohup env -u CLAUDE_SESSION_ID true", "env -u CLAUDE_SESSION_ID true", "true"],
    ]);
    expect(headsOf("{ CLAUDE_SESSION_ID= harness pause; }")).toEqual([["CLAUDE_SESSION_ID= harness pause", "harness pause"]]);
  });

  it("peels xargs with its option grammar (value options, clusters, long options, --)", () => {
    const last = (command: string): string => {
      const cmds = modelShellCommands(command) ?? [];
      return cmds[cmds.length - 1]!.canonical;
    };
    for (const command of [
      "xargs git push",
      "echo x | xargs -I{} git push",
      "echo x | xargs -I {} git push",
      "echo x | xargs -0 -n 1 -P 2 git push",
      "echo x | xargs -rn1 git push",
      "echo x | xargs -n1r git push",
      "echo x | xargs --max-args=1 git push",
      "echo x | xargs --max-procs 2 git push",
      "echo x | xargs --max-a 2 git push",
      "echo x | xargs -L1 -- git push",
      "echo x | xargs -a list -d , git push",
      "echo x | xargs -e -t git push",
    ]) {
      expect(last(command), command).toBe("git push");
    }
    // A long option with no value or an optional attached one takes nothing.
    expect(last("xargs --null --replace git push")).toBe("git push");
    // `--max` is ambiguous (max-args, max-lines, ...): nothing is taken.
    expect(last("xargs --max git push")).toBe("git push");
  });

  it("peels coproc in its three spellings without moving the modelled shell", () => {
    expect(headsOf("coproc git push").at(-1)!.at(-1)).toBe("git push");
    expect(headsOf("coproc { git push; }")[0]!.at(-1)).toBe("git push");
    expect(headsOf("coproc NAME { git push; }")[0]!.at(-1)).toBe("git push");
    // The coprocess runs in a subshell: its `cd` does not move the shell.
    const cmds = modelShellCommands("coproc cd sub; git log") ?? [];
    expect(cmds.map((c) => c.canonical)).toEqual(["cd sub", "git log"]);
    expect(cmds[1]!.namesDirectory).toBe(false);
  });

  it("a wrapper with nothing after it keeps its own text instead of dropping the command", () => {
    expect(headsOf("xargs")).toEqual([["xargs"]]);
    expect(headsOf("echo x | xargs -I")).toEqual([["echo x"], ["xargs -I"]]);
  });
});
