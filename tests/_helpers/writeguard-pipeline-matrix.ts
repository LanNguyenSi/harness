// Fixture table for the solution-acceptance write-guard's read-only `|`
// pipeline arm (tracker task 95a3712d). One row per command; each row
// records what the guard decided on origin/master 45d1b668 (`onMaster`,
// measured, reproducible with scripts/measure-writeguard-baseline.mjs
// against a `git archive origin/master` extraction) and what it must decide
// now (`now`). `kind` says whether the command is a REAL attempt to write
// into the verdict dir (`write`, must stay blocked) or a pure read that the
// guard used to over-block (`read`, the only rows that may flip).
//
// Rows whose `onMaster` is `allowed` are recorded for completeness (an
// existing allow that must not change), they are not part of the
// "blocked on master stays blocked" monotonicity claim.

export const MATRIX_DIR = "/home/u/.local/state/agent-grounding/solution-verdicts";
export const MATRIX_MARKER = `${MATRIX_DIR}/task-42.json`;
export const MATRIX_CWD = "/repo";

export type Verdict = "blocked" | "allowed";

export interface MatrixRow {
  readonly group: string;
  readonly kind: "write" | "read";
  readonly command: string;
  readonly onMaster: Verdict;
  readonly now: Verdict;
}

const D = MATRIX_DIR;
const A = `${D}/a.json`;

function w(group: string, command: string, onMaster: Verdict = "blocked"): MatrixRow {
  return { group, kind: "write", command, onMaster, now: "blocked" };
}
function r(group: string, command: string): MatrixRow {
  return { group, kind: "read", command, onMaster: "blocked", now: "allowed" };
}

export const PIPELINE_MATRIX: readonly MatrixRow[] = [
  // Pure read pipelines that master over-blocks and the guard now allows.
  r("read-pipeline", "grep -n 'x*y' solution-notes.md | head -20"),
  r("read-pipeline", "cat docs/solution-design.md | grep -n 'a*b' | wc -l"),
  r("read-pipeline", "rg 'a{2}' solution-x | head"),
  r("read-pipeline", `cat ${A} | head`),
  r("read-pipeline", "cat ~/.local/state/agent-grounding/solution-verdicts/a.json | head"),
  r("read-pipeline", "cat $HOME/.local/state/agent-grounding/solution-verdicts/a.json | head"),
  r("read-pipeline", `ls ${D} | wc -l`),

  // A write stage that addresses the dir, as the FIRST, MIDDLE and LAST stage.
  w("tee", `tee ${A} | head`),
  w("tee", `cat x | tee ${A} | head`),
  w("tee", `cat x | tee ${A}`),
  w("redirect", `echo x > ${A} | head`),
  w("redirect", `cat x | head > ${A} | wc -l`),
  w("redirect", `cat x | head > ${A}`),
  w("redirect", `cat x | head >> ${A}`),
  w("redirect", `echo x >> ${A} | head`),
  w("sed -i", `sed -i s/a/b/ ${A} | head`),
  w("sed -i", `cat x | sed -i s/a/b/ ${A}`),
  w("sed -i", `cat x | sed -i s/a/b/ ${A} | head`),
  w("mv", `mv x ${A} | head`),
  w("mv", `cat x | mv x ${A}`),
  w("mv", `cat x | mv x ${A} | head`),
  w("cp", `cp x ${A} | head`),
  w("cp", `cat x | cp x ${A}`),
  w("rm", `rm ${A} | head`),
  w("rm", `cat x | rm ${A}`),
  w("rm", `cat x | rm -f ${A} | head`),
  w("dd", `dd of=${A} | head`),
  w("dd", `cat x | dd of=${A}`),
  w("dd", `cat x | dd of=${A} | head`),
  w("install", `install x ${A} | head`),
  w("install", `cat x | install /dev/stdin ${A}`),
  w("truncate", `truncate -s 0 ${A} | head`),
  w("truncate", `cat x | truncate -s 0 ${A}`),
  w("sort -o", `sort -o ${A} x | head`),
  w("sort -o", `cat x | sort -o ${A}`),
  w("sort -o", `cat x | sort -o ${A} | head`),
  w("sort --output", `cat x | sort --output=${A}`),

  // Subshell, command substitution, backticks.
  w("subshell", `(cat x | head) > ${A}`),
  w("subshell", `(cat x | head > ${A})`),
  w("subshell", `(cat x | tee ${A})`),
  w("substitution", `echo $(cat x) | head > ${A}`),
  w("substitution", `echo $(cat x | tee ${A}) | head`),
  w("backticks", "echo `cat x` | head > " + A),
  w("backticks", "echo `cat x | tee " + A + "` | head"),

  // The existing forge matrix with a pipe appended (or inserted).
  w("existing+pipe", `echo '{"ready":true}' > ${MATRIX_MARKER} | head`),
  w("existing+pipe", `echo '{"ready":true}' > "$SOLUTION_VERDICT_DIR/task-42.json" | head`),
  w("existing+pipe", "printf x > ~/.local/state/agent-grounding/solution-verdicts/task-42.json | head"),
  w("existing+pipe", "printf x > $HOME/.local/state/agent-grounding/solution-verdicts/task-42.json | head"),
  w("existing+pipe", "printf x > ${XDG_STATE_HOME}/agent-grounding/solution-verdicts/task-42.json | head"),
  w("existing+pipe", "printf x > $XDG_STATE_HOME/agent-grounding/solution-verdicts/task-42.json | head"),
  w("existing+pipe", `mkdir -p ${D} && echo x > ${MATRIX_MARKER} | head`),
  w("existing+pipe", `echo x | tee ${MATRIX_MARKER}`),
  w("existing+pipe", `python3 -c "open('${MATRIX_MARKER}','w').write('{}')" | head`),
  w("existing+pipe", `node -e "require('fs').writeFileSync('${MATRIX_MARKER}','{}')" | head`),
  w("existing+pipe", `ln -s /tmp/x ${MATRIX_MARKER} | head`),
  w("existing+pipe", `chmod 0700 ${D} | head`),
  w("existing+pipe", `chattr +i ${D} | head`),
  w("existing+pipe", `cat x | chmod 0700 ${D}`),
  w("existing+pipe", "cp /tmp/forged.json agent-grounding/solution-verdicts/x.json | head"),
  w("existing+pipe", "cat x | cp /tmp/forged.json solution-verdicts/x.json"),
  w("existing+pipe", "cat x | tee solution-verdicts/x.json"),
  w("existing+pipe", "echo x > /home/u/.local/state/agent-grounding/solution-ver*/x.json | head"),
  w("existing+pipe", "echo x > /home/u/.local/state/agent-grounding/solution-verdict{s,}/x.json | head"),
  w("existing+pipe", "cat x | tee /home/u/.local/state/agent-grounding/solution-ver*/x.json"),
  w("existing+pipe", "cat x | tee /home/u/.local/state/agent-grounding/solution-verdict{s,}/x.json"),
  w("existing+pipe", `echo x | tee ${MATRIX_DIR}-decoy/../solution-verdicts/x.json`),

  // Fail closed: a pipeline the classifier cannot parse stays on the old path.
  w("fail-closed", `echo 'x > ${A} | head`),
  w("fail-closed", `cat x || tee ${A}`),
  w("fail-closed", `cat x | | tee ${A}`),
  w("fail-closed", `| tee ${A}`),
  w("fail-closed", `cat ${A} |`),
  w("fail-closed", `cat x |& tee ${A}`),
  w("fail-closed", `cat x; cat ${A} | head`),
  w("fail-closed", `cat x && cat ${A} | head`),
  w("fail-closed", `cat ${A} | head; tee ${A}`),
  w("fail-closed", `cat ${A} | head &`),
  w("fail-closed", "cat x | head; grep 'a*b' solution-x | head"),
  w("fail-closed", "cat x && grep 'a*b' solution-x | head"),
  w("fail-closed", "cat x |& grep 'a*b' solution-x"),
  w("fail-closed", "cat x || grep 'a*b' solution-x"),
  w("fail-closed", "grep 'a*b' solution-x | | head"),
  w("fail-closed", "grep 'a*b' solution-x |"),
  w("fail-closed", "| grep 'a*b' solution-x"),
  w("fail-closed", "grep 'a*b solution-x | head"),

  // A `|` that is quoted or escaped is not a stage boundary. Splitting on it
  // would cut the text of one command into fragments that each look
  // read-only, so the pipeline arm must not be taken.
  w("quoted-pipe", `find ${D} -name 'a|cat -x' -delete`),
  w("quoted-pipe", `find ${D} -name "a|cat -x" -delete`),
  w("quoted-pipe", `find ${D} -name a\\|cat -delete`),
  w("quoted-pipe", `find ${D} -name $'a|cat -x' -delete`),
  w("quoted-pipe", `find ${D} -name $'a\\'|cat -x' -delete`),
  w("quoted-pipe", `find ${D} -name $"a|cat -x" -delete`),
  // An escaped quote after the ANSI-C word swings a plain-quote scan back to
  // balanced, so only the refusal of `$'` words keeps the `|` quoted.
  w("quoted-pipe", `find ${D} -name $'a\\'|cat -x' -name \\'x -delete`),
  // A `|` the shell reads as part of one word is not a stage boundary either:
  // parameter expansion, the old `$[...]` arithmetic, an extglob group and
  // arithmetic expansion.
  w("quoted-pipe", `find ${D} -name \${x//a|cat -x} -delete`),
  w("quoted-pipe", `find ${D} -name $[1|cat -x] -delete`),
  w("quoted-pipe", `find ${D} -name @(a|cat -x) -delete`),
  w("quoted-pipe", `find ${D} -name $((1|cat -x)) -delete`),
  w("quoted-pipe", `find ${D} -name "\${x:-"a|cat -x"}" -delete`),
  w("quoted-pipe", `find ${D} -name 'a|cat -x' -delete | head`),
  w("quoted-pipe", `cat x | find ${D} -name "a|cat -x" -delete`),
  w("quoted-pipe", "find solution-verdict* -name 'a|cat -x' -delete"),
  w("quoted-pipe", "find solution-verdict* -name 'a|cat -x' -exec rm {} +"),
  // Recorded over-block: a read that uses `${VAR}` is not fast-pathed (blocked
  // on master, still blocked).
  { group: "quoted-pipe", kind: "read", command: `cat \${XDG_STATE_HOME}/agent-grounding/solution-verdicts/a.json | head`, onMaster: "blocked", now: "blocked" },
  // Recorded over-block: a read whose quoted pattern carries `|`, with a glob
  // and the word "solution". It was blocked on master and stays blocked.
  { group: "quoted-pipe", kind: "read", command: "grep -n 'a|b*' solution-notes.md | head", onMaster: "blocked", now: "blocked" },

  // Recorded over-block: an unquoted parenthesis keeps the old route, whatever
  // the shell makes of it (blocked on master, still blocked).
  { group: "quoted-pipe", kind: "read", command: "cat solution-notes* (x) | head", onMaster: "blocked", now: "blocked" },

  // A `cd` stage never takes the pipeline arm.
  w("cd stage", `cd ${D} | cat`),
  w("cd stage", `cat x | cd ${D}`),
  w("cd stage", `cat x | cd ${D}/sub | head`),
  w("cd stage", "cat x | cd /home/u/.local/state/agent-grounding/solution-ver*"),
  w("cd stage", `cat x | cd "$SOLUTION_VERDICT_DIR"`),
  w("cd stage", `cat x | cd -P ${D}`),
  w("cd stage", `cat x | command cd ${D}`),
  w("cd stage", `cat x | env cd ${D}`),
  w("cd stage", `cat x | 'cd' ${D}`),
];
