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

  it("does not flag `cd -` or a bare `cd` (no statically resolvable destination)", () => {
    expect(bash("cd -").blocked).toBe(false);
    expect(bash("cd").blocked).toBe(false);
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
