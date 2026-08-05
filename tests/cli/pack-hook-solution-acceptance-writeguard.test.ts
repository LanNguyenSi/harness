import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  evaluateWriteGuard,
  runPackHookSolutionAcceptanceWriteguardCli,
} from "../../src/cli/pack/hook-solution-acceptance-writeguard.js";

const DIR = "/home/u/.local/state/agent-grounding/solution-verdicts";
const MARKER = `${DIR}/task-42.json`;

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}
function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function bash(command: string, cwd = "/repo") {
  return evaluateWriteGuard("Bash", { command }, DIR, cwd);
}

describe("write-guard — forge-attempt matrix (the load-bearing anti-forgery proof)", () => {
  // Each of these is an attempt to hand-write a green verdict marker. ALL
  // must be blocked. The dogfood plan runs the same matrix end-to-end.
  it("blocks Write/Edit/NotebookEdit whose target is inside the verdict dir", () => {
    expect(evaluateWriteGuard("Write", { file_path: MARKER }, DIR, "/repo").blocked).toBe(true);
    expect(evaluateWriteGuard("Edit", { file_path: MARKER }, DIR, "/repo").blocked).toBe(true);
    expect(evaluateWriteGuard("MultiEdit", { file_path: MARKER }, DIR, "/repo").blocked).toBe(true);
    expect(
      evaluateWriteGuard("NotebookEdit", { notebook_path: `${DIR}/x.ipynb` }, DIR, "/repo").blocked,
    ).toBe(true);
  });

  it("blocks the enumerated Bash write spellings", () => {
    // literal abs-path redirect
    expect(bash(`echo '{"ready":true}' > ${MARKER}`).blocked).toBe(true);
    // env-var spelling
    expect(bash('echo \'{"ready":true}\' > "$SOLUTION_VERDICT_DIR/task-42.json"').blocked).toBe(true);
    // ~ / tail spelling
    expect(bash("printf x > ~/.local/state/agent-grounding/solution-verdicts/task-42.json").blocked).toBe(
      true,
    );
    // mkdir && echo (chained)
    expect(bash(`mkdir -p ${DIR} && echo x > ${MARKER}`).blocked).toBe(true);
    // tee (not read-only, references dir)
    expect(bash(`tee ${MARKER}`).blocked).toBe(true);
    // non-allowlisted interpreter
    expect(bash(`python3 -c "open('${MARKER}','w').write('{}')"`).blocked).toBe(true);
    expect(bash(`node -e "require('fs').writeFileSync('${MARKER}','{}')"`).blocked).toBe(true);
    // mv / cp / ln / install into the dir
    expect(bash(`mv /tmp/x.json ${MARKER}`).blocked).toBe(true);
    expect(bash(`cp /tmp/x ${MARKER}`).blocked).toBe(true);
    expect(bash(`ln -s /tmp/x ${MARKER}`).blocked).toBe(true);
    expect(bash(`install /tmp/x ${MARKER}`).blocked).toBe(true);
    // chmod / chattr loosening perms on the dir
    expect(bash(`chmod 0700 ${DIR}`).blocked).toBe(true);
  });

  it("blocks a non-read-only Bash whose shell cwd is inside the dir (cwd-relative)", () => {
    expect(bash("echo x > task-42.json", DIR).blocked).toBe(true);
    expect(bash("echo x > task-42.json", `${DIR}/sub`).blocked).toBe(true);
  });

  it("blocks `cd <parent> && write <relative-into-dir>` (the leaf-segment descent)", () => {
    // cwd is the repo (NOT inside the dir), and the parent path + child
    // redirect never form the contiguous tail — only the leaf segment
    // `solution-verdicts` appears, in the redirect target. Must still block.
    const parent = "/home/u/.local/state/agent-grounding";
    expect(bash(`cd ${parent} && echo '{"ready":true}' > solution-verdicts/task-42.json`).blocked).toBe(
      true,
    );
    expect(bash(`cd /home/u/.local/state && cp /tmp/forged.json agent-grounding/solution-verdicts/x.json`).blocked).toBe(
      true,
    );
    // first `cd` into the dir would itself name the leaf -> blocked, so the
    // agent cannot establish cwd==dir for a later bare relative write.
    expect(bash(`cd ${DIR}`).blocked).toBe(true);
  });

  it("blocks bare `cd` into the verdict dir via a resolved-path pre-check, ahead of cd's own read-only classification", () => {
    // `cd` is provably read-only on its own (task fb67b402), so without a
    // dedicated pre-check this would fall through to "read-only Bash
    // command" and be allowed — defeating the defense-in-depth property
    // pinned above. The pre-check must fire first.
    expect(bash(`cd ${DIR}`).blocked).toBe(true);
    // A subdirectory of the verdict dir is inside it too.
    expect(bash(`cd ${DIR}/sub`).blocked).toBe(true);
  });

  it("discriminating pair: cd into the verdict dir is blocked, cd into an unrelated dir is not", () => {
    expect(bash(`cd ${DIR}`).blocked).toBe(true);
    expect(bash("cd /home/u/.local/state/agent-grounding").blocked).toBe(false); // the dir's PARENT, not the dir itself
    expect(bash("cd /tmp/some-other-project").blocked).toBe(false);
    expect(bash("cd /repo").blocked).toBe(false);
  });

  it("resolves the cd target as a real path, not a substring match: near-miss siblings are not blocked", () => {
    // Shares a long text prefix with the verdict dir but is a SIBLING
    // directory (different leaf), not inside it. A substring-based check
    // would wrongly flag this; the resolved-path check (isInsideDir) does not.
    expect(bash(`cd ${DIR}-decoy`).blocked).toBe(false);
    expect(bash("cd /tmp/verdict-dir-decoy").blocked).toBe(false);
  });

  it("a quoted decoy behaves like the unquoted decoy: quote-stripping makes the resolved-path check spelling-independent", () => {
    // Before cdTargetArgument stripped surrounding quotes, a quoted decoy
    // routed to CD_TARGET_UNRESOLVABLE_CHARS (the quote chars themselves
    // triggered it) and fell through to bashReferencesVerdictDir's textual
    // leaf match, which DOES match here (the leaf "solution-verdicts" is a
    // literal PREFIX substring of "solution-verdicts-decoy") — so the
    // quoted form was wrongly blocked while the unquoted form correctly was
    // not. Stripping the quotes before either check runs makes both forms
    // agree.
    expect(bash(`cd "${DIR}-decoy"`).blocked).toBe(false);
    expect(bash(`cd '${DIR}-decoy'`).blocked).toBe(false);
    // Known, unchanged residual: a tilde/env-var decoy spelling is NOT
    // normalized the same way (this module does not expand `~`/`$VAR` —
    // that is the whole reason those forms fall through to the textual
    // check at all), so it still hits the same textual-prefix over-match
    // and stays blocked. This is a false positive (fails safe), not a
    // forgery gap, and is out of this task's scope to resolve.
    expect(bash("cd ~/.local/state/agent-grounding/solution-verdicts-decoy").blocked).toBe(true);
  });

  it("pins the pre-existing case-variance residual from the module header (task 769d5452): case-variant spellings pass through undetected TODAY", () => {
    // Same form as the tilde-decoy residual pin above: this records CURRENT
    // behavior, not a desired one. Named and accepted in the module header's
    // "Known-open residual" note (src/cli/pack/hook-solution-acceptance-writeguard.ts)
    // as pre-existing, not introduced by the cd-target check. Not endorsed —
    // a future fix that case-folds `isInsideDir`'s comparison would (and
    // should) flip these to blocked=true; verified by transient mutation
    // during this task (see task 769d5452 report), not asserted here.
    //
    // `SOLUTION-VERDICTS` navigates into the (real, lowercase) dir on a
    // case-insensitive filesystem (e.g. default macOS APFS), but both
    // `isInsideDir` (case-sensitive `path.relative`) and the textual check
    // (case-sensitive `includes`) compare case-sensitively, so neither fires
    // and `cd`'s read-only fast path is taken.
    expect(bash("cd /home/u/.local/state/agent-grounding/SOLUTION-VERDICTS").blocked).toBe(false);
    expect(bash("cd /home/u/.local/state/agent-grounding/Solution-Verdicts").blocked).toBe(false);
  });

  it("pins the pre-existing trailing-backslash residual from the module header (task 769d5452): `cd <DIR>\\` passes through undetected TODAY", () => {
    // Split from the case-variance pin so a partial future fix identifies
    // itself: the two residuals live in DIFFERENT mechanisms and must fail
    // independently. Same record-not-endorse form as above — a future fix
    // that strips a trailing backslash before resolving the cd target would
    // (and should) flip this to blocked=true.
    //
    // `cd <DIR>\` at end of input still lands in the dir under bash (verified
    // directly against bash 3.2.57 during this task; before a newline the
    // trailing backslash is a line continuation instead, so the residual
    // holds only for the exact end-of-input spelling asserted here). The
    // literal trailing backslash makes the token resolve to a different
    // (sibling, non-existent) path than `dir` itself, so `isInsideDir`
    // returns false and, since no unresolvable-expansion character matches
    // either, `cd`'s read-only fast path is taken.
    expect(bash(`cd ${DIR}\\`).blocked).toBe(false);
  });

  it("does not flag `cd -` or a bare `cd` (no statically resolvable destination)", () => {
    expect(bash("cd -").blocked).toBe(false);
    expect(bash("cd").blocked).toBe(false);
  });

  it("blocks cd targets path.resolve cannot literally evaluate: quoted / env-var / tilde / glob spellings of the verdict dir", () => {
    // Each of these previously fell through to cd's unconditional read-only
    // fast path (isReadOnlyBashCommand returns true for ANY `cd`), because
    // path.resolve on the raw, un-shell-evaluated token never lands inside
    // `dir` for any of these spellings. The fix routes them to the same
    // bashReferencesVerdictDir text-reference check any other non-read-only
    // Bash command goes through.
    expect(bash(`cd "${DIR}"`).blocked).toBe(true); // double-quoted literal
    expect(bash(`cd '${DIR}'`).blocked).toBe(true); // single-quoted literal
    expect(bash("cd $SOLUTION_VERDICT_DIR").blocked).toBe(true); // env-var spelling
    expect(bash("cd ~/.local/state/agent-grounding/solution-verdicts").blocked).toBe(true); // tilde spelling
    expect(bash("cd $HOME/.local/state/agent-grounding/solution-verdicts").blocked).toBe(true); // $HOME spelling
    expect(bash("cd ${HOME}/.local/state/agent-grounding/solution-verdicts").blocked).toBe(true); // ${HOME} spelling
    expect(bash("cd /home/u/.local/state/agent-grounding/solution-ver*").blocked).toBe(true); // glob spelling
    expect(bash("cd /home/u/.local/state/agent-grounding/solution-verdict?").blocked).toBe(true); // glob spelling
  });

  it("blocks brace-expansion cd spellings of the verdict dir (bash 3.2.57 verified: cd <parent>/{solution-verdicts,x} navigates into the leaf, ignoring the extra alternative)", () => {
    // `{` `}` `,` were missing from CD_TARGET_UNRESOLVABLE_CHARS: path.resolve
    // treats the whole brace expression as one literal (non-existent) path
    // segment, so it is neither "inside" the dir nor flagged unresolvable,
    // and cd's unconditional read-only fast path fired. Each of these
    // previously measured blocked=false even though bashReferencesVerdictDir
    // already returns true for all of them (the leaf "solution-verdicts"
    // survives intact inside the braces in every one of these six forms).
    const parent = "/home/u/.local/state/agent-grounding";
    expect(bash(`cd ${parent}/{solution-verdicts,x}`).blocked).toBe(true);
    expect(bash(`cd ${parent}/{x,solution-verdicts}`).blocked).toBe(true);
    expect(bash(`cd ${parent}/{solution-verdicts,}`).blocked).toBe(true);
    expect(bash(`cd -P ${parent}/{solution-verdicts,x}`).blocked).toBe(true);
    expect(bash(`cd -- ${parent}/{solution-verdicts,x}`).blocked).toBe(true);
    // Relative form: cwd is already the parent.
    expect(bash("cd {solution-verdicts,x}", parent).blocked).toBe(true);
  });

  it("blocks a brace that SPLITS the leaf itself, via the widened bashReferencesVerdictDir glob/brace fallback", () => {
    // `solution-verdict{s,}` expands to `solution-verdicts` / `solution-verdict`
    // — neither contains the literal leaf as a contiguous substring, so the
    // direct literal-leaf check misses it; only the leaf-WORD fallback (which
    // needed `{` added to its trigger regex, same task) catches it, because
    // "solution" alone (a >=6-char leaf word) survives the split. This
    // sub-case predates the cd branch (it applies to bashReferencesVerdictDir
    // for ANY command, not just cd) and was already a hole before this task;
    // the same widening closes it here too.
    const parent = "/home/u/.local/state/agent-grounding";
    expect(bash(`cd ${parent}/solution-verdict{s,}`).blocked).toBe(true);
  });

  it("allows ordinary brace/comma cd paths unrelated to the verdict dir (task 769d5452 positive pin)", () => {
    // `{` `}` `,` are in CD_TARGET_UNRESOLVABLE_CHARS, so each of these takes
    // `cd`'s cdTargetUnresolvable branch (same as the verdict-dir brace forms
    // above) rather than the read-only fast path — but bashReferencesVerdictDir
    // finds no literal-leaf, tail, or leaf-word match for any of them, so they
    // are NOT blocked. Note `cd /tmp/a,b` never even enters the glob/brace
    // leaf-word fallback: a bare comma is in CD_TARGET_UNRESOLVABLE_CHARS but
    // not in the /[*?[{]/ trigger, so it pins the unresolvable-routing path,
    // distinct from the two brace cases. Pinned because a future tightening of either
    // CD_TARGET_UNRESOLVABLE_CHARS or the glob/brace leaf-word fallback could
    // silently block normal navigation; verified by transient mutation during
    // this task (routing any unresolvable cd target straight to blocked=true
    // flips all three) — see task 769d5452 report, not asserted here.
    expect(bash("cd ~/{src,test}").blocked).toBe(false);
    expect(bash("cd /tmp/{a,b}").blocked).toBe(false);
    expect(bash("cd /tmp/a,b").blocked).toBe(false);
  });

  it("blocks `cd /repo/{solution,notes}`: the DELIBERATE, accepted over-block from the leaf-word fallback (task 769d5452 pin)", () => {
    // Neither path segment is the verdict dir or anywhere near it — this is
    // an ordinary, unrelated `cd`. It blocks anyway because the brace
    // triggers bashReferencesVerdictDir's glob/brace fallback
    // (src/policy-packs/builtin/solution-acceptance-runtime.ts, the
    // "ACCEPTED COST of including `{` here" comment above its `if
    // (/[*?[{]/.test(command))` check), and "solution" is one of the leaf's
    // >=6-char words ("solution-verdicts" -> "solution" + "verdicts"). That
    // comment names this exact command as a measured example and explains
    // why it is accepted: dropping `{` from the trigger class would reopen
    // the `solution-verdict{s,}` split-leaf hole, which fails OPEN, whereas
    // this over-block fails SAFE. Pinned here so it reads as a recorded
    // decision, not a regression, the next time someone re-derives it.
    // Verified by transient mutation during this task (dropping `{` from
    // that trigger class flips this to blocked=false) — see task 769d5452
    // report, not asserted here.
    expect(bash("cd /repo/{solution,notes}").blocked).toBe(true);
  });

  it("blocks shell-glob redirect targets that obscure the leaf (overwrite forge)", () => {
    // bash expands the glob to the real dir at runtime; the literal leaf
    // never appears, but a distinctive leaf word survives the single glob.
    const ag = "/home/u/.local/state/agent-grounding";
    expect(bash(`echo '{"ready":true}' > ${ag}/solution-ver*/task-42.json`).blocked).toBe(true);
    expect(bash(`echo '{"ready":true}' > ${ag}/solu*verdicts/task-42.json`).blocked).toBe(true);
    expect(bash(`printf x > ${ag}/solution-v?rdicts/task-42.json`).blocked).toBe(true);
    expect(bash(`cp /tmp/forged.json ${ag}/s*verdicts/task-42.json`).blocked).toBe(true);
    expect(bash(`cd ${ag} && echo x > solution-ver*/task-42.json`).blocked).toBe(true);
  });

  it("does NOT over-block a globbed command that is unrelated to the verdict dir", () => {
    expect(bash("cp src/*.ts dist/").blocked).toBe(false);
    expect(bash("rm -f /tmp/agent-relay/*.log").blocked).toBe(false); // 'agent-' prefix, not the leaf
    expect(bash("git add tests/cli/*.test.ts").blocked).toBe(false);
  });

  it("blocks an apply_patch that references the verdict dir (codex arm)", () => {
    expect(
      evaluateWriteGuard("apply_patch", { patch: `*** Add File: ${MARKER}\n+{}` }, DIR, "/repo")
        .blocked,
    ).toBe(true);
  });

  it("does NOT over-block: pure reads and unrelated writes are allowed", () => {
    expect(bash(`cat ${MARKER}`).blocked).toBe(false); // read
    expect(bash(`ls ${DIR}`).blocked).toBe(false); // read
    expect(bash("git status").blocked).toBe(false);
    expect(bash("echo hi > /tmp/safe.txt").blocked).toBe(false); // write elsewhere
    expect(
      evaluateWriteGuard("Write", { file_path: "/repo/src/x.ts" }, DIR, "/repo").blocked,
    ).toBe(false);
    // a sibling path that merely shares a prefix is not inside the dir
    expect(
      evaluateWriteGuard("Write", { file_path: `${DIR}-notes/x` }, DIR, "/repo").blocked,
    ).toBe(false);
  });
});

describe("write-guard CLI — end-to-end deny envelope", () => {
  it("emits a Claude Code block envelope on a forge attempt", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const res = await runPackHookSolutionAcceptanceWriteguardCli({
      stdin: streamFrom(
        JSON.stringify({ tool_name: "Bash", cwd: "/repo", tool_input: { command: `echo x > ${MARKER}` } }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      verdictDir: DIR,
    });
    expect(res.blocked).toBe(true);
    const env = JSON.parse(stdout.output());
    expect(env.decision).toBe("block");
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(env.reason).toMatch(/write-guard/);
  });

  it("allows an unrelated edit (no envelope on stdout)", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const res = await runPackHookSolutionAcceptanceWriteguardCli({
      stdin: streamFrom(
        JSON.stringify({ tool_name: "Write", cwd: "/repo", tool_input: { file_path: "/repo/a.ts" } }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      verdictDir: DIR,
    });
    expect(res.blocked).toBe(false);
    expect(stdout.output()).toBe("");
  });
});
