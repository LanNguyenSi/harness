import { describe, expect, it } from "vitest";
import { scanShellPipeline } from "../../src/runtime/shell-pipeline-scan.js";

function stagesOf(command: string): readonly string[] | null {
  return scanShellPipeline(command)?.stages ?? null;
}

describe("scanShellPipeline: real stage boundaries", () => {
  it.each([
    ["ls | head", ["ls ", " head"]],
    ["ls|head", ["ls", "head"]],
    ["a | b | c", ["a ", " b ", " c"]],
    ["ls", ["ls"]],
    ["", [""]],
    // An empty stage is reported as empty: `||`, a leading and a trailing pipe.
    ["a || b", ["a ", "", " b"]],
    ["| a", ["", " a"]],
    ["a |", ["a ", ""]],
    // A plain variable and a quote on either side of a boundary do not hide it.
    ["cat $HOME/x | head", ["cat $HOME/x ", " head"]],
    ["cat 'a b' | head", ["cat 'a b' ", " head"]],
    ['cat "a b" | head', ['cat "a b" ', " head"]],
    ["cat a\\ b | head", ["cat a\\ b ", " head"]],
    // A closed quote, an escaped quote and a closed expansion before the pipe.
    ["echo 'a'|cat", ["echo 'a'", "cat"]],
    ["echo \\'|cat", ["echo \\'", "cat"]],
    ["echo ${x}|cat", ["echo ${x}", "cat"]],
    ["echo $[1]|cat", ["echo $[1]", "cat"]],
    ["echo (a)|cat", ["echo (a)", "cat"]],
  ])("cuts %j into its stages", (command, expected) => {
    const scan = scanShellPipeline(command);
    expect(scan).not.toBeNull();
    expect(scan?.stages).toEqual(expected);
    expect(scan?.hasNonBoundaryPipe).toBe(false);
  });
});

describe("scanShellPipeline: a `|` that is not a boundary", () => {
  it.each([
    ["single quote", "find d -name 'a|b' -x"],
    ["double quote", 'find d -name "a|b" -x'],
    ["backslash", "find d -name a\\|b -x"],
    ["backslash inside double quotes", 'echo "a\\|b"'],
    ["parameter expansion", "echo ${x//a|b}"],
    ["parameter expansion in double quotes", 'echo "${x//a|b}"'],
    ["nested parameter expansion", "echo ${x:-${y:-a|b}}"],
    ["array subscript inside a parameter expansion", "echo ${a[1|2]}"],
    ["plain brace inside a parameter expansion", "echo ${x:-{a|b}}"],
    ["arithmetic bracket", "echo $[1|2]"],
    ["nested bracket", "echo $[a[1]|2]"],
    ["command substitution", "echo $(a|b)"],
    ["arithmetic expansion", "echo $((1|2))"],
    ["backtick substitution", "echo `a|b`"],
    ["ANSI-C quote", "echo $'a|b'"],
    ["ANSI-C quote holding an escaped quote", "echo $'a\\'|b'"],
    ["locale double quote", 'echo $"a|b"'],
    ["extglob group", "echo @(a|b)"],
    ["negated extglob group", "echo !(a|b)"],
    ["subshell", "(a|b)"],
    ["command substitution inside double quotes", 'echo "$(a|b)"'],
    ["quote inside a parameter expansion", "echo ${x:-'a|b'}"],
    // The scan counts a plain `{` and a `[` inside `${...}` and keeps the
    // expansion open until their closers: deeper than the shell may read it,
    // which only makes a caller refuse.
    ["closing brace after a plain opening brace", "echo ${x:-{a}|b}"],
    ["closing brace inside an array subscript", "echo ${a[}|b]}"],
    ["double quote inside a parameter expansion", 'echo ${x:-"a|b"}'],
  ])("%s: no boundary is reported", (_label, command) => {
    const scan = scanShellPipeline(command);
    expect(scan).not.toBeNull();
    expect(scan?.hasNonBoundaryPipe).toBe(true);
    expect(scan?.stages).toHaveLength(1);
  });

  it("keeps a real boundary next to a non-boundary pipe", () => {
    const scan = scanShellPipeline("find d -name 'a|b' | head");
    expect(scan?.hasNonBoundaryPipe).toBe(true);
    expect(scan?.stages).toEqual(["find d -name 'a|b' ", " head"]);
  });

  // Each row pins the context guard of one opener: the nested construct must
  // be read INSIDE the enclosing one. Dropping the guard re-reads the quote
  // that follows against the wrong context, so the `|` shows up as a boundary
  // (two stages) or the scan loses its balance (`null`).
  it.each([
    ["`$'` inside double quotes is a literal, not an ANSI-C run", "echo \"$'\" | cat", 2, false],
    ["`${` opens a parameter expansion inside double quotes", 'echo "${x:-"a|b"}"', 1, true],
    ["`$[` opens an arithmetic bracket inside double quotes", 'echo "$["1|b"]"', 1, true],
    ["a single quote quotes inside `${..}`", "echo ${x:-'}|b'}", 1, true],
    ["a double quote quotes inside `${..}`", 'echo ${x:-"}|b"}', 1, true],
    ["`$'` is an ANSI-C run inside `${..}`", "echo ${x:-$'\\'}|b'}", 1, true],
  ])("%s", (_label, command, stageCount, nonBoundaryPipe) => {
    const scan = scanShellPipeline(command);
    expect(scan).not.toBeNull();
    expect(scan?.stages).toHaveLength(stageCount);
    expect(scan?.hasNonBoundaryPipe).toBe(nonBoundaryPipe);
  });

  it("does not let a quote opened in one construct swallow the next real boundary", () => {
    const scan = scanShellPipeline("echo 'a' | echo \"b\" | echo ${c} | tail");
    expect(scan?.hasNonBoundaryPipe).toBe(false);
    expect(scan?.stages).toHaveLength(4);
  });

  it("ends an ANSI-C run only at an unescaped quote", () => {
    // `$'a\'|b'` is ONE run holding an escaped quote; ending it at the escaped
    // quote would report the `|` as a stage boundary.
    expect(stagesOf("echo $'a\\'|b'")).toEqual(["echo $'a\\'|b'"]);
    // A plain single quote has no escapes: `'a\'` ends at the second quote.
    expect(stagesOf("echo 'a\\'|b")).toEqual(["echo 'a\\'", "b"]);
  });
});

describe("scanShellPipeline: unclassifiable text returns null", () => {
  it.each([
    ["unterminated single quote", "echo 'a|b"],
    ["unterminated double quote", 'echo "a|b'],
    ["unterminated ANSI-C quote", "echo $'a|b"],
    ["unterminated locale quote", 'echo $"a|b'],
    ["unterminated parameter expansion", "echo ${x//a|b"],
    ["unterminated arithmetic bracket", "echo $[1|2"],
    ["unterminated command substitution", "echo $(a|b"],
    ["unterminated backtick", "echo `a|b"],
    ["unterminated group", "echo (a|b"],
    ["stray closing parenthesis", "echo a)|b"],
    ["closing parenthesis inside a parameter expansion", "echo ${x:-a)|b}"],
    ["unterminated brace in a parameter expansion", "echo ${x:-{a}|b"],
    ["unterminated quote after a boundary", "ls | echo 'a"],
  ])("%s", (_label, command) => {
    expect(scanShellPipeline(command)).toBeNull();
  });
});

describe("scanShellPipeline: flags", () => {
  it.each([
    ["$HOME", false],
    ["$1", false],
    ["$_x", false],
    ["'$'", false], // inside single quotes
    ["\\$", false], // escaped
    ['"\\$"', false],
    ["${x}", true],
    ["$(x)", true],
    ["$[1]", true],
    ["$'x'", true],
    ['$"x"', true],
    ["$?", true],
    ["a $", true],
    ['"$"', true],
    ['"${x}"', true],
  ])("hasDollarExpansion(%j) is %s", (command, expected) => {
    expect(scanShellPipeline(command)?.hasDollarExpansion).toBe(expected);
  });

  it.each([
    ["echo a", false],
    ["echo '(a)'", false],
    ['echo "(a)"', false],
    ["echo \\(a\\)", false],
    ["echo (a)", true],
    ["echo @(a|b)", true],
    ["(a)", true],
  ])("hasGroupParen(%j) is %s", (command, expected) => {
    expect(scanShellPipeline(command)?.hasGroupParen).toBe(expected);
  });

  it("treats a trailing lone backslash as a literal character", () => {
    expect(stagesOf("cat x \\")).toEqual(["cat x \\"]);
  });
});
