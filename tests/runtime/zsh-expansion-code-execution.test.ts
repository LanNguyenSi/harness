// zsh expansion constructs that run code without any `$(`, backtick or write
// token (tracker task b647da7f). zsh's GLOB_SUBST flag (`${~x}`, `$~x`,
// `$^~x`, ...) glob-expands the VALUE of an expansion, so a glob qualifier
// hidden in a quote inside `${...}` (`${~x:-'*(e:cmd:)'}`) runs `cmd` while
// no parenthesis is unquoted. Both read-only classifiers used to return
// read-only for it, and the understanding-gate PreToolUse hooks and the
// solution-acceptance write-guard's strict route allowed it without an
// approved report.
//
// Every executing row below is run under a real zsh in a scratch directory
// (skipped when no zsh is installed): the witness proves the payload creates
// a file, and the classifier assertions prove both predicates refuse it. The
// allowed rows prove the refusal does not reach plain `$HOME`-style
// expansions: the same zsh runs them without creating the file.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isReadOnlyBashCommand,
  isReadOnlyBashPipeline,
} from "../../src/runtime/read-only-bash.js";

const ZSH = ["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh", "/usr/local/bin/zsh"].find(
  (p) => fs.existsSync(p),
);

// The payload every row tries to run: create the file `w` in the cwd.
const PAYLOAD_VALUE = "*(e:touch w:)";

/** Commands that create `w` under zsh and must not be read-only. */
const EXECUTING: ReadonlyArray<readonly [string, string]> = [
  ["${~x:-'..'} with a quoted qualifier", "ls ${~x:-'*(e:touch w:)'}"],
  ["${~x:-'..'} with the e.. qualifier", "ls ${~x:-'*(e.touch w.)'}"],
  ["${=~x:-'..'}", "ls ${=~x:-'*(e:touch w:)'}"],
  ["${~=x:-'..'}", "ls ${~=x:-'*(e:touch w:)'}"],
  ["${~^x:-'..'}", "ls ${~^x:-'*(e:touch w:)'}"],
  ["${^~x:-'..'}", "ls ${^~x:-'*(e:touch w:)'}"],
  ["${~${:-'..'}} nested", "ls ${~${:-'*(e:touch w:)'}}"],
  ["${~x:-'..'} inside another ${..}", "ls ${z:-${~x:-'*(e:touch w:)'}}"],
  ["$~x after an assigning ${x:='..'}", "echo ${x:='*(e:touch w:)'} $~x"],
  ["${~x} after an assigning ${x:='..'}", "echo ${x:='*(e:touch w:)'} ${~x}"],
  ["$~X1 on an exported value", "ls $~X1"],
  ["${~X1} on an exported value", "ls ${~X1}"],
  ["$^~X1", "ls $^~X1"],
  ["$^^~X1", "ls $^^~X1"],
  ["$==~X1", "ls $==~X1"],
  ["$~X1 with a subscript", "ls $~X1[1,-1]"],
  ["${^~X1}", "ls ${^~X1}"],
  // Flags are spelled with a parenthesis, which was refused before already;
  // kept here so the survey rows run through the same witness.
  ["${(@)~x:-'..'}", "ls ${(@)~x:-'*(e:touch w:)'}"],
  ["${(e)..} evaluates the value", "echo ${(e)${:-'$''(touch w)'}}"],
  ["glob qualifier with an unquoted parenthesis", "ls *(e:'touch w':)"],
  ["process substitution =(..)", "cat =(touch w)"],
  // `~[name]` calls the host's zsh_directory_name function; the witness
  // defines one through ZDOTDIR the way a host rc file could.
  ["dynamic named directory ~[..]", "echo ~[foo]"],
];

/**
 * Refused although they do not run code under zsh 5.9: the refusal is by
 * construct (a paren inside `${...}`, an unquoted tilde in it, `$~` anywhere,
 * a quoted re-glob), not by outcome. Over-blocks by design; they stay
 * classifiable by the old route (the approved report).
 */
const REFUSED_NOT_EXECUTING: ReadonlyArray<readonly [string, string]> = [
  ["dq-wrapped ${~x:-'..'} does not glob", "ls \"${~x:-'*(e:touch w:)'}\""],
  ["$~ on a quoted literal", "ls $~'*(e:touch w:)'"],
  ["$~X1 inside double quotes does not glob", 'ls "$~X1"'],
  ["quoted paren in ${..}", "echo ${x:-'(paren)'}"],
  ["double-quoted paren in ${..}", 'echo ${x:-"(paren)"}'],
  ["ANSI-C quoted paren in ${..}", "echo ${x:-$'(paren)'}"],
  ["escaped paren in ${..}", "echo ${x:-\\(paren\\)}"],
  ["unquoted tilde in ${..}", "echo ${x:-~/y}"],
  ["${~#x:-..} is a length, not a glob", "ls ${~#x:-'*(e:touch w:)'}"],
];

/** Plain reads that stay read-only and do not run code under zsh. */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["$HOME", "echo $HOME"],
  ["${HOME}", "echo ${HOME}"],
  ["${x:-default}", "echo ${x:-default}"],
  ["${HOME%/*}", "echo ${HOME%/*}"],
  ["${#HOME}", "echo ${#HOME}"],
  ["${HOME//a/b}", "echo ${HOME//a/b}"],
  ["a value that holds a qualifier is not globbed: $X1", "ls $X1"],
  ["${X1} is not globbed", "ls ${X1}"],
  ["$=X1 splits only", "ls $=X1"],
  ["$^X1 expands per element only", "ls $^X1"],
  ["tilde expansion ~root", "echo ~root"],
  ["=ls expansion", "echo =ls"],
  ["=ls expansion in a pipeline stage", "echo =ls | head"],
];

describe("zsh GLOB_SUBST and `${...}` parentheses are not provably read-only (task b647da7f)", () => {
  it.each([...EXECUTING, ...REFUSED_NOT_EXECUTING])(
    "isReadOnlyBashCommand refuses %s",
    (_label, command) => {
      expect(isReadOnlyBashCommand(command)).toBe(false);
    },
  );

  it.each([...EXECUTING, ...REFUSED_NOT_EXECUTING])(
    "isReadOnlyBashPipeline refuses %s",
    (_label, command) => {
      expect(isReadOnlyBashPipeline(command)).toBe(false);
      expect(isReadOnlyBashPipeline(`${command} | head`)).toBe(false);
      expect(isReadOnlyBashPipeline(`cat a | ${command}`)).toBe(false);
    },
  );

  it.each(ALLOWED)("keeps %s read-only", (_label, command) => {
    // The strict single-command check refuses any `|`; only the pipeline
    // check classifies the piped row.
    if (!command.includes("|")) expect(isReadOnlyBashCommand(command)).toBe(true);
    expect(isReadOnlyBashPipeline(command)).toBe(true);
  });
});

// A fixture runner that spawns zsh as a grandchild of `node`: the suite's
// spawn guard allows `node`, and the zsh binary is a system interpreter, not
// a repo binary.
const RUNNER = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [zsh, cwd, zdotdir, command] = process.argv.slice(2);
const r = spawnSync(zsh, ["-c", command], {
  cwd,
  encoding: "utf8",
  input: "",
  timeout: 10000,
  env: { ...process.env, ZDOTDIR: zdotdir, X1: ${JSON.stringify(PAYLOAD_VALUE)} },
});
process.stdout.write(JSON.stringify({ executed: fs.existsSync(path.join(cwd, "w")), status: r.status }));
`;

describe.skipIf(ZSH === undefined)("executed under a real zsh in a scratch directory", () => {
  let scratch: string;
  let runnerPath: string;
  let zdotdir: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zsh-expansion-witness-"));
    runnerPath = path.join(scratch, "runner.cjs");
    fs.writeFileSync(runnerPath, RUNNER);
    zdotdir = path.join(scratch, "zdotdir");
    fs.mkdirSync(zdotdir);
    fs.writeFileSync(
      path.join(zdotdir, ".zshenv"),
      "zsh_directory_name() { touch w; return 1; }\n",
    );
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function executes(command: string): boolean {
    const cwd = fs.mkdtempSync(path.join(scratch, "case-"));
    fs.writeFileSync(path.join(cwd, "a"), "");
    fs.writeFileSync(path.join(cwd, "b"), "");
    const run = spawnSync(process.execPath, [runnerPath, ZSH as string, cwd, zdotdir, command], {
      encoding: "utf8",
      timeout: 30000,
    });
    expect(run.status).toBe(0);
    return (JSON.parse(run.stdout) as { executed: boolean }).executed;
  }

  it.each(EXECUTING)("zsh runs the payload: %s", (_label, command) => {
    expect(executes(command)).toBe(true);
  });

  it.each(REFUSED_NOT_EXECUTING)("zsh does not run a payload: %s", (_label, command) => {
    expect(executes(command)).toBe(false);
  });

  it.each(ALLOWED)("zsh runs no payload for the allowed read: %s", (_label, command) => {
    expect(executes(command)).toBe(false);
  });
});
