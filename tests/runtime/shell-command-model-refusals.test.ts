import { describe, expect, it } from "vitest";
import {
  modelShellCommands,
  REFUSAL_CONSTRUCTS,
  shellModelViewOf,
  type DirPossibility,
  type RefusalKind,
} from "../../src/runtime/shell-command-model.js";
import {
  BENIGN_ROWS,
  CDPATH_ROWS,
  SHARED_ROWS,
  SOLE_ROWS,
  UNLEXABLE_BRACE_ROWS,
} from "../fixtures/shell-model-refusals/rows.js";

// Task 9238cc27: the shell command model refuses a command line that holds
// a compound shape its walk would place in the wrong directory, instead of
// reading it. The rows live in `tests/fixtures/shell-model-refusals/rows.ts`.

const KINDS = Object.keys(REFUSAL_CONSTRUCTS) as RefusalKind[];

function compact(d: DirPossibility): string {
  if (d.kind !== "path") return d.kind;
  if (d.steps.length === 0) return "cwd";
  return d.steps.map((s) => s.value).join(" > ");
}

describe("shellModelViewOf: a refused command line names its construct and reads as no commands", () => {
  for (const kind of KINDS) {
    it(`refuses the rows of the ${kind} class with that class's construct`, () => {
      const rows = SOLE_ROWS[kind];
      expect(rows.length).toBeGreaterThan(0);
      // Every row that is not refused this way, listed in full on a failure.
      const misread = rows.filter((command) => {
        const view = shellModelViewOf(command);
        return view.commands !== null || view.refusal !== REFUSAL_CONSTRUCTS[kind] || modelShellCommands(command) !== null;
      });
      expect(misread).toEqual([]);
    });
  }

  it("reports the first refusal the walk meets for a row more than one check refuses", () => {
    for (const { command, first } of SHARED_ROWS) {
      expect(shellModelViewOf(command).refusal, command).toBe(REFUSAL_CONSTRUCTS[first]);
    }
  });

  it("refuses an unparsed line that holds a refused command-word form", () => {
    for (const command of UNLEXABLE_BRACE_ROWS) {
      expect(shellModelViewOf(command), command).toEqual({
        commands: null,
        directoryChangeWord: false,
        refusal: REFUSAL_CONSTRUCTS["command-word-brace"],
        triggerCommands: null,
      });
    }
    // Without such a word the line stays not lexable, with no refusal.
    expect(shellModelViewOf("{ case x in x) echo hi;; esac; git push; }")).toEqual({
      commands: null,
      directoryChangeWord: false,
    });
  });

  it("keeps the reading without refusals for trigger matching only", () => {
    const view = shellModelViewOf("! { git -C vendor/libplain push; }");
    expect(view.commands).toBeNull();
    expect(view.refusal).toBe(REFUSAL_CONSTRUCTS["negated-compound"]);
    expect(view.triggerCommands?.map((c) => c.canonical)).toEqual(["git push"]);
    expect(shellModelViewOf("arr=(a b); git push").triggerCommands).toBeUndefined();
  });

  it("keeps directoryChangeWord as the raw text has it on a refused line", () => {
    expect(shellModelViewOf("case x in x) cd vendor/libplain ;& y) :; git push;; esac").directoryChangeWord).toBe(true);
    expect(shellModelViewOf("{cd,vendor/libplain}; git push origin main").directoryChangeWord).toBe(false);
  });
});

describe("modelShellCommands: the directory-search rows make the next relative cd opaque", () => {
  it("reads git push after each directory-search row as opaque", () => {
    for (const command of CDPATH_ROWS) {
      const view = shellModelViewOf(command);
      expect(view.refusal, command).toBeUndefined();
      const push = view.commands?.find((c) => c.canonical.startsWith("git push"));
      expect(push, command).toBeDefined();
      expect(push!.dirs.map(compact), command).toContain("opaque");
    }
  });

  it("keeps a directory-search setting made inside a substitution in that subshell", () => {
    const view = shellModelViewOf("echo $(: ${CDPATH:=vendor}) >/dev/null; cd libplain; git push origin main");
    const push = view.commands?.find((c) => c.canonical.startsWith("git push"));
    expect(push!.dirs.map(compact).sort()).toEqual(["cwd", "libplain"]);
  });

  it("does not set the flag for a word that only contains the letters", () => {
    for (const command of [
      'echo "CDPATH note"; cd sub; git push origin main',
      'git commit -m "CDPATH handling"; cd sub; git push origin main',
      "grep cdpath scripts/cdpath.sh; cd sub; git push origin main",
      // Names that only contain the letters, where the identifier-boundary
      // check is the one consulted (assigning-builtin name, expansion).
      "read -r CDPATHX; cd sub; git push origin main",
      "echo ${MYCDPATH}; cd sub; git push origin main",
      "export MY_CDPATH=x; cd sub; git push origin main",
    ]) {
      const push = modelShellCommands(command)?.find((c) => c.canonical.startsWith("git push"));
      expect(push!.dirs.map(compact).sort(), command).toEqual(["cwd", "sub"]);
    }
  });
});

describe("modelShellCommands: the benign rows stay attributed", () => {
  it("reads every benign row without a refusal", () => {
    for (const command of BENIGN_ROWS) {
      const view = shellModelViewOf(command);
      expect(view.refusal, command).toBeUndefined();
      expect(view.commands, command).not.toBeNull();
      expect(view.commands!.some((c) => c.canonical.startsWith("git push")), command).toBe(true);
    }
  });

  it("places the push of an array assignment, a condition and an arithmetic body in the working directory", () => {
    for (const command of [
      "arr=(a b c); git push origin main",
      "declare -A m=([k]=v); git push origin main",
      "[[ -n x && ( -n y || -n z ) ]] && git push origin main",
      "(( x * (1 + 1) )) && git push origin main",
    ]) {
      const push = modelShellCommands(command)?.find((c) => c.canonical.startsWith("git push"));
      expect(push!.dirs.map(compact), command).toEqual(["cwd"]);
    }
  });

  it("reads the benign case spellings next to the refused ones", () => {
    const push = modelShellCommands("case $x in a) cd vendor/libplain;; b) cd vendor;; esac; git push origin main")?.find(
      (c) => c.canonical.startsWith("git push"),
    );
    expect(push!.dirs.map(compact).sort()).toEqual(["cwd", "vendor", "vendor/libplain"]);
    expect(shellModelViewOf("case x in x) echo a ;& y) git push origin main;; esac").refusal).toBeUndefined();
  });

  it("reads the benign stack spellings next to the refused ones", () => {
    expect(shellModelViewOf("case y in x) pushd vendor; popd;; y) :;; esac; git push origin main").refusal).toBeUndefined();
    expect(shellModelViewOf("case y in x) cd vendor;; esac; cd -; git push origin main").refusal).toBeUndefined();
  });
});
