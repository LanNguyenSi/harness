// Command rows for the shell command model's refusals (task 9238cc27).
// Data only: `tests/runtime/shell-command-model-refusals.test.ts` and
// `tests/runtime/intercept-cli-refused-shapes.test.ts` read them. Every row
// is written for a working directory that is a repository with a nested
// repository at `vendor/libplain`.
import type { RefusalKind } from "../../../src/runtime/shell-command-model.js";

/**
 * Rows only their own kind refuses: with that kind's check taken out, the
 * model reads the row again (the mutation probes of the task rely on it).
 */
export const SOLE_ROWS: Readonly<Record<RefusalKind, readonly string[]>> = {
  "case-terminator": [
    "echo hi ;& git push origin main",
    "case x in x) if true;; esac; git push origin main",
  ],
  "case-fall-through": [
    "case x in x) cd vendor/libplain ;& y) :; git push;; esac",
    "case x in x) cd vendor/libplain ;& y) true && git push origin main;; esac",
    "case x in x) cd vendor/libplain ;;& *) :; git push;; esac",
    "[[ -n x ]] && case x in x) cd vendor/libplain ;& y) :; git push origin main;; esac",
    "case x in x) cd vendor/libplain; case y in y) :;; esac ;& z) :; git push origin main;; esac",
    "case x in x) pushd vendor/libplain ;& y) :; git push origin main;; esac",
    "case x in x) eval cd vendor/libplain ;& y) :; git push origin main;; esac",
  ],
  "case-arm-dir-stack": [
    "case y in x) cd vendor/libplain;; y) cd -; git push;; esac",
    "pushd vendor/libplain; pushd ..; case y in x) popd;; y) popd; git push;; esac",
    "cd vendor/libplain; cd ../..; case y in x) cd vendor;; y) cd -; git push origin main;; esac",
    "pushd vendor/libplain; pushd ../..; case y in x) pushd vendor;; y) pushd; git push origin main;; esac",
    "case y in x) cd vendor/libplain;; y) eval cd -; git push origin main;; esac",
  ],
  "alternate-form": [
    "if [[ -n x ]] cd vendor/libplain; git push",
    "if [[ -n x ]] then cd vendor/libplain; fi; git push origin main",
    "if [[ -z x ]] { : } else { cd vendor/libplain; }; git push origin main",
    "{ :; } always { cd vendor/libplain; }; git push origin main",
    "repeat 1 cd vendor/libplain; git push origin main",
    "repeat 1 do cd vendor/libplain; done; git push origin main",
    "repeat 1 { cd vendor/libplain; }; git push origin main",
    "foreach i (1) cd vendor/libplain; end; git push origin main",
    "() { cd vendor/libplain; }; git push origin main",
    "function { cd vendor/libplain; }; git push origin main",
    "if { false } { : } else { cd vendor/libplain }; git push origin main",
  ],
  "loop-body": [
    "for i in 1; cd vendor/libplain; git push origin main",
    "for i (1) cd vendor/libplain; git push origin main",
    "for ((i=0;i<1;i++)) cd vendor/libplain; git push origin main",
    "set -- 1; for i do cd vendor/libplain; done; git push origin main",
    "for ((i=0;i<1;i++)) do cd vendor/libplain; done; git push origin main",
    "for i in 1 2; { cd vendor; }; git push origin main",
    "for ((i=0;i<2;i++)) { cd vendor; }; git push origin main",
    "select i in 1; cd vendor/libplain; git push origin main",
    "i=0; while (( i++ < 2 )); { cd vendor; }; git push origin main",
  ],
  "command-word-brace": [
    "{cd vendor/libplain; git push origin main; }",
    "{cd,vendor/libplain}; git push origin main",
    "{,cd} vendor/libplain; git push origin main",
    "c{d,} vendor/libplain; git push origin main",
  ],
  "command-word-glob": [
    "c[d] vendor/libplain; git push origin main",
    "c? vendor/libplain; git push origin main",
    "c* vendor/libplain; git push origin main",
    "@(cd) vendor/libplain; git push origin main",
  ],
  coproc: [
    "coproc foo { cd vendor/libplain; git push origin main; }",
    "coproc { cd vendor/libplain; git push origin main; }",
    "coproc foo while true; do cd vendor/libplain; git push origin main; break; done",
    "coproc ( cd vendor/libplain; git push origin main )",
  ],
  "negated-compound": [
    "! { cd vendor/libplain && git push; }",
    "! { cd vendor/libplain && git push origin main; }",
    "! while cd vendor/libplain && git push origin main; do break; done",
    "! time { cd vendor/libplain && git push origin main; }",
  ],
  "paren-after-word": [
    "echo x (cd vendor/libplain); git push origin main",
    "git push origin main (x)",
  ],
};

/** Rows more than one check refuses; `first` is the kind the walk meets first and reports. */
export const SHARED_ROWS: ReadonlyArray<{ readonly command: string; readonly first: RefusalKind }> = [
  { command: "{ case x in (x) cd vendor/libplain;; esac; git push origin main; }", first: "paren-after-word" },
  {
    command: "if true; then case x in (x) cd vendor/libplain;; esac; fi; git push origin main",
    first: "paren-after-word",
  },
  { command: "if [[ -n x ]] case x in (x) cd vendor/libplain ;& (y) :; git push;; esac", first: "paren-after-word" },
  { command: "if (( 1 )) case x in (x) cd vendor/libplain;; esac; git push", first: "paren-after-word" },
  { command: "{ case x in (x) cd vendor/libplain; :;& (y) :; git push;; esac; }", first: "paren-after-word" },
  { command: "foreach i (1) case x in (x) cd vendor/libplain;; esac; end; git push", first: "alternate-form" },
  { command: "i=0; while (( i++ < 1 )) { cd vendor/libplain; }; git push origin main", first: "alternate-form" },
  { command: "for i in 1 2; do cd vendor; [[ -n x ]] done; git push origin main", first: "alternate-form" },
];

/** Lines the walk gives up on that hold a refused command-word form: refused as a whole. */
export const UNLEXABLE_BRACE_ROWS: readonly string[] = [
  "{ case x in x) {cd,vendor/libplain};; esac; git push origin main; }",
];

/**
 * Refused rows whose gated verb only the shell model's own arm of the
 * trigger reads: the policy still matches on the reading without refusals,
 * and then fails closed.
 */
export const MODEL_ARM_ROWS: ReadonlyArray<{ readonly command: string; readonly kind: RefusalKind }> = [
  { command: "! { git -C vendor/libplain push; }", kind: "negated-compound" },
  { command: "! case x in\nx) git -C vendor/libplain push;;\nesac", kind: "negated-compound" },
  { command: "for (( i=`git -C vendor/libplain push`; i<1; i++ )) do :; done", kind: "loop-body" },
  { command: "case x in x) cd vendor ;& y) :; git -C libplain push;; esac", kind: "case-fall-through" },
];

/** Rows that steer a later relative `cd`: the `git push` after it reads as opaque. */
export const CDPATH_ROWS: readonly string[] = [
  ": ${CDPATH:=vendor}; cd libplain; git push origin main",
  ": ${CDPATH=vendor}; cd libplain; git push origin main",
  ": ${CDPATH::=vendor}; cd libplain; git push origin main",
  'echo "${CDPATH:=vendor}" >/dev/null; cd libplain; git push origin main',
  "x=${CDPATH:=vendor}; cd libplain; git push origin main",
  "case ${CDPATH:=vendor} in *) cd libplain; git push origin main;; esac",
  "read CDPATH <<< vendor; cd libplain; git push origin main",
  "printf -v CDPATH vendor; cd libplain; git push origin main",
  "cdpath=(vendor); cd libplain; git push origin main",
  "cdpath[1]=vendor; cd libplain; git push origin main",
  "(( CDPATH = 1 )); cd libplain; git push origin main",
  "arr=(${CDPATH:=vendor}); cd libplain; git push origin main",
  "for CDPATH in vendor; do :; done; cd libplain; git push origin main",
  ": <<< ${CDPATH:=vendor}; cd libplain; git push origin main",
];

/**
 * Rows that stay attributed: array assignments, condition and arithmetic
 * bodies with operators, everyday `if` / `for` / `while` / `case`
 * one-liners, brace expansion in arguments, words that only contain the
 * letters of a variable name, and `( )`, `{ }` and closers where bash or
 * zsh accept them.
 */
export const BENIGN_ROWS: readonly string[] = [
  "arr=(a b c); git push origin main",
  "declare -A m=([k]=v); git push origin main",
  "name+=(x); git push origin main",
  "local -a xs=(1 2 3); git push origin main",
  "[[ -n x && ( -n y || -n z ) ]] && git push origin main",
  "[[ ( -n x ) ]] && git push origin main",
  "(( x * (1 + 1) )) && git push origin main",
  "(( a[1]++ )); git push origin main",
  "for ((i=0;i<3;i++)); do echo $i; done; git push origin main",
  "if (( x > 1 )); then cd vendor/libplain; fi; git push origin main",
  "while (( i < 3 )); do i=$((i+1)); done; git push origin main",
  'echo "CDPATH note"; cd vendor/libplain; git push origin main',
  'git commit -m "CDPATH handling"; cd vendor/libplain; git push origin main',
  "grep cdpath scripts/cdpath.sh; cd vendor/libplain; git push origin main",
  "echo {a,b}; git push origin main",
  "mkdir -p dir/{a,b}; git push origin main",
  "cp file{,.bak}; git push origin main",
  "if [ -f x ]; then cd vendor/libplain; fi; git push origin main",
  "if [[ -f x ]]; then cd vendor/libplain; else cd vendor; fi; git push origin main",
  "for f in *.ts; do echo $f; done; git push origin main",
  "for i in 1 2 3\ndo\necho $i\ndone; git push origin main",
  "for i\nin 1 2; do echo; done; git push origin main",
  "while read -r l; do echo $l; done < f; git push origin main",
  "until [ -f x ]; do sleep 1; done; git push origin main",
  "case $x in a) cd vendor/libplain;; b) cd vendor;; esac; git push origin main",
  "case $x in (a) cd vendor/libplain;; (b) cd vendor;; esac; git push origin main",
  "case $x in a|b) echo;; *) echo other;; esac && git push origin main",
  "case x in x) echo a ;& y) echo b;; esac; git push origin main",
  "cd vendor/libplain && case x in x) : ;& y) git push origin main;; esac",
  "pushd vendor/libplain; case x in x) popd;; esac; git push origin main",
  "case y in x) pushd vendor; popd;; y) :;; esac; git push origin main",
  "{ [[ -n x ]] }; cd vendor/libplain; git push origin main",
  "{ { cd vendor/libplain; } }; git push origin main",
  "if true; then { cd vendor/libplain; } fi; git push origin main",
  "if { true; } then cd vendor/libplain; fi; git push origin main",
  "{ if true; then cd vendor/libplain; fi }; git push origin main",
  "{\ncase x in x) cd vendor/libplain;; esac\n}; git push origin main",
  "{ for i in 1; do cd vendor/libplain; done }; git push origin main",
  "while { false; } do :; done; cd vendor/libplain; git push origin main",
  "f() { cd vendor/libplain; }; f; git push origin main",
  "function f { cd vendor/libplain; }; f; git push origin main",
  "function f() { cd vendor/libplain; }; f; git push origin main",
  "f() ( cd vendor/libplain ); git push origin main",
  "! git diff --quiet && git push origin main",
  "! [[ -n x ]] && git push origin main",
  "time (cd vendor/libplain && make); git push origin main",
  "(cd vendor/libplain && git push origin main)",
  "echo $(cd vendor/libplain; git status); git push origin main",
  "find . -name '*.ts' -exec grep -l x {} \\; ; git push origin main",
  "echo $(( (1+2) * 3 )); git push origin main",
  "select x in a b; do break; done; git push origin main",
  'eval "cd vendor/libplain"; git push origin main',
  "coproc cat; git push origin main",
  "echo }; git push origin main",
  "[ -n x ] && git push origin main",
  "ls *.ts; git push origin main",
  "arr[1]=x; git push origin main",
  "awk '{print $1}' f; git push origin main",
  "[[ -n x ]] && { cd vendor/libplain; git push origin main; }",
  "(( 1 )) && { cd vendor/libplain; git push origin main; }",
  "while [[ -n $x ]]; do x=; done; git push origin main",
];
