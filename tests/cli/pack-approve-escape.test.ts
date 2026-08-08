import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPipedStdin } from "../../src/cli/approve/stdin-report.js";
import {
  isEscapeCommand,
  parseApproveReportHeredoc,
} from "../../src/cli/pack/approve-escape.js";

const REPORT_BODY = [
  "## Understanding Report",
  "",
  "**Metadata**",
  "",
  "taskId: t-1",
  "mode: grill_me",
  "riskLevel: low",
].join("\n");

function heredoc(
  head = "harness approve understanding",
  delimiter = "UNDERSTANDING_REPORT",
  body: string = REPORT_BODY,
  tail = "",
): string {
  return `${head} <<'${delimiter}'\n${body}\n${delimiter}${tail}`;
}

describe("isEscapeCommand — single-line (behavior preserved from task 367fb12f)", () => {
  it("accepts bare approve invocations", () => {
    for (const command of [
      "harness approve understanding",
      "  harness approve understanding  ",
      "harness approve understanding --force",
      "harness approve understanding --task a,b --session sess-1",
      "harness approve risk high",
    ]) {
      expect(isEscapeCommand(command), command).toBe(true);
    }
  });

  it("rejects metacharacters, substitution, and non-approve commands", () => {
    for (const command of [
      "harness approve understanding && rm -rf /tmp/x",
      "harness approve understanding; id",
      "harness approve understanding | tee /tmp/x",
      "harness approve understanding > /tmp/x",
      "harness approve understanding < /etc/shadow",
      "harness approve understanding $(whoami)",
      "harness approve understanding `id`",
      "echo harness approve understanding",
      "harness approvex understanding",
      "harness  pause",
    ]) {
      expect(isEscapeCommand(command), command).toBe(false);
    }
  });
});

describe("isEscapeCommand — report heredoc (task 61fd36db)", () => {
  it("accepts the canonical report-heredoc shape", () => {
    expect(isEscapeCommand(heredoc())).toBe(true);
  });

  it("accepts flags on the command part and spacing before the heredoc intro", () => {
    for (const command of [
      heredoc("harness approve understanding --force"),
      heredoc("harness approve understanding --task a,b"),
      `harness approve understanding << 'UR'\nbody\nUR`,
      heredoc("harness approve understanding", "UR_2"),
    ]) {
      expect(isEscapeCommand(command), command).toBe(true);
    }
  });

  it("accepts shell metacharacters INSIDE the body (inert data under a quoted delimiter)", () => {
    const body = "danger: `id` $(whoami) ; rm -rf / | tee > x < y && true";
    expect(isEscapeCommand(heredoc(undefined, undefined, body))).toBe(true);
  });

  it("accepts trailing whitespace/newlines after the terminator", () => {
    expect(isEscapeCommand(`${heredoc()}\n`)).toBe(true);
    expect(isEscapeCommand(`${heredoc()}\n   \n`)).toBe(true);
  });

  it("rejects an unquoted or malformed delimiter (expansion would be live)", () => {
    for (const command of [
      `harness approve understanding <<UR\nbody\nUR`,
      `harness approve understanding <<"UR"\nbody\nUR`,
      `harness approve understanding <<'ur'\nbody\nur`,
      `harness approve understanding <<'U R'\nbody\nU R`,
      `harness approve understanding <<-'UR'\nbody\nUR`,
    ]) {
      expect(isEscapeCommand(command), command).toBe(false);
    }
  });

  it("rejects trailing commands after the terminator (the smuggle shape)", () => {
    expect(isEscapeCommand(heredoc(undefined, undefined, REPORT_BODY, "\nrm -rf /tmp/x"))).toBe(
      false,
    );
  });

  it("rejects a body that embeds the terminator early followed by commands (mirrors shell heredoc end)", () => {
    const command = [
      "harness approve understanding <<'UR'",
      "innocent first line",
      "UR",
      "rm -rf /tmp/x",
      "UR",
    ].join("\n");
    expect(isEscapeCommand(command)).toBe(false);
  });

  it("rejects an unterminated heredoc", () => {
    expect(isEscapeCommand(`harness approve understanding <<'UR'\nbody only`)).toBe(false);
  });

  it("rejects an indented terminator line (shell would not terminate either)", () => {
    expect(isEscapeCommand(`harness approve understanding <<'UR'\nbody\n  UR`)).toBe(false);
  });

  it("tolerates trailing spaces on a FINAL terminator line (outer trim; inert — nothing can follow)", () => {
    // The whole command is trimmed before parsing, so `UR  ` as the very
    // last line becomes `UR`. Safe: any content AFTER a terminator is
    // still checked, and a padded terminator mid-body is not a terminator
    // (matching shell semantics).
    expect(isEscapeCommand(`harness approve understanding <<'UR'\nbody\nUR  `)).toBe(true);
    expect(isEscapeCommand(`harness approve understanding <<'UR'\nbody\nUR  \nrm -rf /x`)).toBe(
      false,
    );
  });

  it("rejects metacharacters or extra redirects on the command part", () => {
    for (const command of [
      heredoc("harness approve understanding; id"),
      heredoc("harness approve understanding $(whoami)"),
      heredoc("harness approve understanding `id`"),
      `harness approve understanding <<'UR' > /tmp/x\nbody\nUR`,
      `harness approve understanding <<'A' <<'B'\nbody\nA`,
      heredoc("rm -rf /tmp/x"),
      heredoc("echo harness approve understanding"),
    ]) {
      expect(isEscapeCommand(command), command).toBe(false);
    }
  });

  it("rejects a multi-line command without a heredoc", () => {
    expect(isEscapeCommand("harness approve understanding\necho pwned")).toBe(false);
  });

  // Review 2026-07-10 (HIGH). `\<` is a LITERAL `<` to bash, so
  // `harness approve understanding \<<'UR'` is not a heredoc at all: it
  // is a redirect from a file named UR, and the "body" lines run as
  // ordinary shell commands. Verified live in bash (the intervening
  // `echo SMUGGLED_EXECUTED` executed). The old blacklist accepted it
  // because the heredoc regex consumed the `<` chars and `\` was not a
  // rejected metachar. The command part is now whitelist-checked.
  it("rejects a backslash-escaped redirect (shell would NOT open a heredoc — smuggle shape)", () => {
    for (const command of [
      `harness approve understanding \\<<'UR'\nrm -rf /tmp/x\nUR`,
      `harness approve understanding foo\\<<'UR'\nrm -rf /tmp/x\nUR`,
      `harness approve understanding \\\\<<'UR'\nrm -rf /tmp/x\nUR`,
    ]) {
      expect(isEscapeCommand(command), command).toBe(false);
      expect(parseApproveReportHeredoc(command), command).toBeNull();
    }
  });

  it("rejects a quote-obscured heredoc intro", () => {
    expect(isEscapeCommand(`harness approve understanding '<<'UR'\nbody\nUR`)).toBe(false);
    expect(isEscapeCommand(`harness approve understanding "<<"UR'\nbody\nUR`)).toBe(false);
  });

  it("rejects process substitution in the command part", () => {
    expect(isEscapeCommand("harness approve understanding <(id)")).toBe(false);
    expect(isEscapeCommand(`harness approve understanding <(id) <<'UR'\nbody\nUR`)).toBe(false);
    expect(isEscapeCommand(`harness approve understanding >(cmd) <<'UR'\nbody\nUR`)).toBe(false);
  });

  it("rejects shell-special characters the whitelist excludes from the heredoc command part", () => {
    for (const command of [
      `harness approve understanding *\n<<'UR'\nbody\nUR`,
      `harness approve understanding $HOME <<'UR'\nbody\nUR`,
      `harness approve understanding "x" <<'UR'\nbody\nUR`,
      `harness approve understanding 'x' <<'UR'\nbody\nUR`,
      `harness approve understanding {a,b} <<'UR'\nbody\nUR`,
      `harness approve understanding !! <<'UR'\nbody\nUR`,
    ]) {
      expect(isEscapeCommand(command), command).toBe(false);
    }
  });

  it("still accepts the character classes a legitimate approve command part needs", () => {
    for (const command of [
      // flags, comma lists, uuids, paths, urls-ish, home-relative paths
      heredoc("harness approve understanding --force"),
      heredoc("harness approve understanding --task 61fd36db-2d54-4917-809b-07c683a7d6c2"),
      heredoc("harness approve understanding --task a,b,c --session sess-1"),
      heredoc("harness approve understanding --reports-dir /tmp/x/reports"),
      heredoc("harness approve understanding --reports-dir ~/.harness/reports"),
      heredoc("harness approve understanding --approved-by ops@example.com"),
      heredoc("harness approve understanding --config=/etc/harness.yaml"),
    ]) {
      expect(isEscapeCommand(command), command).toBe(true);
    }
  });

  it("rejects carriage returns in the command line", () => {
    expect(isEscapeCommand(`harness approve understanding <<'UR'\r\nbody\nUR`)).toBe(false);
  });
});

describe("bash-blank divergence (task 623640a5)", () => {
  // Enumerate every codepoint JS's generic `\s` class matches, computed
  // here (not hardcoded) so a future JS-engine change to the `\s` class
  // is caught rather than silently under-tested. Ground truth (PATH-stub
  // measurement against GNU bash, task 623640a5): bash's lexical blank
  // set in this position is exactly TAB and SPACE. Every other `\s`
  // codepoint is a NON-bash-blank: bash glues it onto the adjacent
  // token instead of stripping it as a separator, which is exactly the
  // divergence that let a report heredoc's REAL delimiter word (as bash
  // reads it) diverge from the word this matcher extracts, closing the
  // heredoc a line early and letting a body line run as a real command.
  const ALL_JS_WHITESPACE_CODEPOINTS: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogate range, not a scalar value
    if (/^\s$/.test(String.fromCodePoint(cp))) {
      ALL_JS_WHITESPACE_CODEPOINTS.push(cp);
    }
  }
  const BASH_BLANK_CODEPOINTS = [0x09, 0x20];
  const NON_BASH_BLANK_CODEPOINTS = ALL_JS_WHITESPACE_CODEPOINTS.filter(
    (cp) => !BASH_BLANK_CODEPOINTS.includes(cp),
  );
  // LF restructures line boundaries before any of these regexes ever
  // run (the module splits on "\n" first), and CR is rejected by an
  // explicit, separate check in both call paths, both already have
  // dedicated regression tests elsewhere in this file. Excluded from
  // the generic loops below so those loops stay about the regex-level
  // blank/non-blank boundary itself, not the line-splitting/CR guards.
  const LOOP_EXCLUDED = new Set([0x0a, 0x0d]);

  it("pins the exact JS \\s codepoint set (25 total: 2 real bash blanks, 23 non-blank)", () => {
    // If this fails, the JS engine's `\s` class changed size. That is a
    // signal to re-measure against real bash (do not just bump the
    // number): the fix in approve-escape.ts assumes bash's blank set is
    // exactly { TAB, SPACE } regardless of what JS's `\s` covers.
    expect(ALL_JS_WHITESPACE_CODEPOINTS.length).toBe(25);
    expect(NON_BASH_BLANK_CODEPOINTS.length).toBe(23);
  });

  it("rejects every non-bash-blank \\s codepoint as heredoc-intro trailing whitespace (the found exploit shape)", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      const command = `harness approve understanding <<'X'${ch}\nX${ch}\ngit push origin master\nX`;
      expect(isEscapeCommand(command), label).toBe(false);
      expect(parseApproveReportHeredoc(command), label).toBeNull();
    }
  });

  it("rejects every non-bash-blank \\s codepoint as heredoc-intro leading whitespace (between << and the quote)", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      const command = `harness approve understanding <<${ch}'X'\nbody\nX`;
      expect(isEscapeCommand(command), label).toBe(false);
    }
  });

  it("rejects every non-bash-blank \\s codepoint as the harness/approve separator in the command part", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      // Single-line path (commandPartIsClean directly).
      expect(isEscapeCommand(`harness${ch}approve understanding`), label).toBe(false);
      // Heredoc path (same function, plus the whitelist char class).
      expect(isEscapeCommand(`harness${ch}approve understanding <<'X'\nbody\nX`), label).toBe(
        false,
      );
    }
  });

  it("still accepts real bash blanks (TAB, SPACE) in every position above (no regression)", () => {
    for (const cp of BASH_BLANK_CODEPOINTS) {
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isEscapeCommand(`harness approve understanding <<'X'${ch}\nreport line\nX`), label).toBe(
        true,
      );
      expect(isEscapeCommand(`harness approve understanding <<${ch}'X'\nreport line\nX`), label).toBe(
        true,
      );
      expect(isEscapeCommand(`harness${ch}approve understanding`), label).toBe(true);
    }
  });

  // The exact measured incident (2026-08-04 halt / task 623640a5
  // discovery): a non-breaking space (U+00A0) after the heredoc
  // delimiter's closing quote used to be accepted by `\s*$` as
  // insignificant trailing whitespace, while bash glues it onto the
  // quoted word: the REAL delimiter becomes "X"+NBSP, so the body
  // line "X"+NBSP closes bash's heredoc immediately and
  // `git push origin master` runs as a real top-level command instead
  // of staying inert report text.
  it("rejects the measured NBSP-heredoc incident (DENY, not ASK)", () => {
    const nbsp = " ";
    const command = `harness approve understanding <<'X'${nbsp}\nX${nbsp}\ngit push origin master\nX`;
    expect(isEscapeCommand(command)).toBe(false);
    expect(parseApproveReportHeredoc(command)).toBeNull();
  });
});

describe("parseApproveReportHeredoc", () => {
  it("extracts command part, delimiter, and body", () => {
    const parsed = parseApproveReportHeredoc(heredoc("harness approve understanding --force"));
    expect(parsed).not.toBeNull();
    expect(parsed?.command).toBe("harness approve understanding --force");
    expect(parsed?.delimiter).toBe("UNDERSTANDING_REPORT");
    expect(parsed?.body).toBe(REPORT_BODY);
  });

  it("returns null for a single-line command", () => {
    expect(parseApproveReportHeredoc("harness approve understanding")).toBeNull();
  });

  it("preserves an empty body", () => {
    const parsed = parseApproveReportHeredoc(`harness approve understanding <<'UR'\nUR`);
    expect(parsed).not.toBeNull();
    expect(parsed?.body).toBe("");
  });
});

describe("readPipedStdin — completeness signal (review 2026-07-10)", () => {
  function slowStream(chunks: string[], endAfter: boolean): Readable {
    const s = new Readable({ read() {} });
    for (const c of chunks) s.push(c);
    if (endAfter) s.push(null);
    return s;
  }

  it("reports complete:true for a clean EOF", async () => {
    const result = await readPipedStdin(slowStream(["## Understanding Report\n"], true));
    expect(result.complete).toBe(true);
    expect(result.text).toBe("## Understanding Report\n");
  });

  it("reports complete:false when the stream never ends (timeout with partial data)", async () => {
    const result = await readPipedStdin(slowStream(["## Understanding Rep"], false), 1024, 25);
    expect(result.complete).toBe(false);
    expect(result.text).toBe("## Understanding Rep");
  });

  it("reports complete:false when the size cap truncates the input", async () => {
    const result = await readPipedStdin(slowStream(["abcdefghij"], true), 4, 500);
    expect(result.complete).toBe(false);
    expect(result.text).toBe("abcd");
  });

  it("reports complete:false on a stream error", async () => {
    const s = new Readable({ read() {} });
    s.push("partial");
    queueMicrotask(() => s.destroy(new Error("boom")));
    const result = await readPipedStdin(s, 1024, 500);
    expect(result.complete).toBe(false);
  });
});
