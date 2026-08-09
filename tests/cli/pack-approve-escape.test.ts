import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPipedStdin } from "../../src/cli/approve/stdin-report.js";
import {
  isEscapeCommand,
  parseApproveReportHeredoc,
} from "../../src/cli/pack/approve-escape.js";

const APPROVE_ESCAPE_SOURCE_URL = new URL(
  "../../src/cli/pack/approve-escape.ts",
  import.meta.url,
);

// Strip `//` line comments, `/* */` block comments, and quoted/template
// string literals from a TS source string, leaving (approximately) just
// code, so the guard test below can check regex literals for a bare
// `\s` without also flagging one mentioned in prose. Comments are
// stripped FIRST so a quote character inside a comment cannot be
// mistaken for the start of a string literal.
//
// Known blind spots, not fixed (this is a coarse textual strip, not a
// real parser): a quote-delimited span INSIDE a regex literal (e.g. the
// `'...'` piece of approve-escape.ts's own heredoc-delimiter regex in
// `parseApproveReportHeredoc`) is stripped by the same string-literal
// alternative below, so a `\s` planted inside such a span disappears
// before the guard test ever sees it (verified: mutating that exact
// span to end in `\s'` still leaves the guard test green). A `//`
// occurring INSIDE a same-line string literal (e.g. a URL) is also
// mistaken for a line comment, since line-comment stripping runs first
// and chops the rest of that line, string content included. The guard
// test below is therefore a rough backstop, not a proof: the PRIMARY
// protection against the bash-blank-divergence class is the "bash-blank
// divergence" describe block above, which pins actual runtime BEHAVIOR
// (every non-bash-blank codepoint of the 23-member enumeration rejected
// at every call site), not source text.
function stripCommentsAndStrings(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLineComments = noBlockComments.replace(/\/\/[^\n]*/g, "");
  return noLineComments.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "");
}

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

  it("rejects every non-bash-blank \\s codepoint MID command-part in the heredoc shape (HEREDOC_COMMAND_PART_ALLOWED_RE pin, review 2026-08-08)", () => {
    // Distinct from the harness/approve-separator loop above: this
    // codepoint sits AFTER `commandPartIsClean`'s own prefix check
    // (between "understanding" and "--force"), so only
    // HEREDOC_COMMAND_PART_ALLOWED_RE (the heredoc-only whitelist) can
    // reject it. A revert of ONLY that whitelist back to a generic `\s`
    // char class (while sites A and C stay fixed) left this exact
    // position untested — a single-line command with the same codepoint
    // is already rejected by commandPartIsClean's prefix regex, so the
    // gap was heredoc-only and silent.
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      const command = `harness approve understanding${ch}--force <<'X'\nbody\nX`;
      expect(isEscapeCommand(command), label).toBe(false);
    }
  });

  it("rejects a non-bash-blank \\s codepoint glued directly before the heredoc intro (right-trim site pin, review 2026-08-08)", () => {
    // The command part is right-trimmed before the whitelist check runs
    // (to drop a real trailing bash blank between the command and
    // `<<`). That trim must only ever remove `[ \t]`: a generic
    // `.trimEnd()` would strip a non-bash-blank codepoint here too,
    // hiding it from the whitelist as if it were an insignificant
    // separator bash also treats as blank — which it does not (bash
    // glues it onto the preceding word instead).
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isEscapeCommand(`harness approve understanding${ch}<<'X'\nbody\nX`), label).toBe(
        false,
      );
      expect(isEscapeCommand(`harness approve understanding ${ch}<<'X'\nbody\nX`), label).toBe(
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

describe("top-level trim residual (task 508a2d81) — after.every check reachability", () => {
  // 623640a5 fixed the after.every check's own regex (`/^[ \t]*$/`, never
  // `\s`) but left the TOP-LEVEL `command.trim()` that runs before any
  // line-splitting. `.trim()` strips every JS `\s` codepoint from the
  // string's edges, so a TRAILING line made only of a non-bash-blank
  // whitespace codepoint (NBSP, U+2028, ...) was deleted before
  // after.every ever ran — making the fixed check unreachable through
  // the public API for exactly the shape it exists to reject. PATH-stub
  // measured against real GNU bash (this task's implementation notes):
  // such a line is NOT inert — bash looks it up and attempts to execute
  // it as a real command (`command not found`, exit 127), the same as
  // any other body line after the heredoc has closed.
  const NBSP = " ";
  const LINE_SEPARATOR = " ";

  it("rejects a report heredoc with a non-bash-blank post-terminator tail (the found exploit shape)", () => {
    for (const [label, ch] of [
      ["NBSP", NBSP],
      ["U+2028", LINE_SEPARATOR],
    ] as const) {
      const command = `harness approve understanding <<'X'\nbody\nX\n${ch}`;
      expect(isEscapeCommand(command), label).toBe(false);
      expect(parseApproveReportHeredoc(command), label).toBeNull();
    }
  });

  it("rejects the same tail even with a trailing real newline after it", () => {
    for (const [label, ch] of [
      ["NBSP", NBSP],
      ["U+2028", LINE_SEPARATOR],
    ] as const) {
      const command = `harness approve understanding <<'X'\nbody\nX\n${ch}\n`;
      expect(isEscapeCommand(command), label).toBe(false);
    }
  });

  it("still accepts a real [ \\t]-only post-terminator tail (matches bash's actual no-op; no regression)", () => {
    expect(isEscapeCommand(`harness approve understanding <<'X'\nbody\nX\n  \n`)).toBe(true);
  });

  it("does not regress a plain trailing LF on a single-line command (LF is line structure, never hides content)", () => {
    expect(isEscapeCommand("harness approve understanding\n")).toBe(true);
    expect(isEscapeCommand("  harness approve understanding  \n\n")).toBe(true);
  });
});

describe("mechanical guard — no bare `\\s` token in approve-escape.ts (task 623640a5 review)", () => {
  // Fix-by-fix closure of the bash-blank divergence does not stop the
  // class from reopening: a FUTURE regex added to this module could
  // reintroduce JS's generic `\s` class where bash's actual blank set
  // (`[ \t]`) is meant. This is a mechanical backstop for the common
  // case (a bare `\s` typed into a character class or alternation), read
  // the module's own source, strip comments and string literals (the
  // prose above legitimately talks ABOUT `\s`), and assert the
  // remaining code contains no `\s` token at all. It is not a
  // guarantee: see `stripCommentsAndStrings`'s own comment above for the
  // two documented blind spots and why the behavioral enumeration in
  // the "bash-blank divergence" describe block above this one is the
  // primary protection, not this text-level check.
  it("the module's code (comments and string literals stripped) contains no `\\s` token", () => {
    const source = readFileSync(APPROVE_ESCAPE_SOURCE_URL, "utf8");
    const code = stripCommentsAndStrings(source);
    expect(code.includes("\\s")).toBe(false);
  });

  // Liveness proof (not just a passing assertion above): mutate a COPY of
  // the real module source in memory, adding a `\s` to an existing regex
  // literal exactly the way a future regression would, and prove the same
  // strip-and-check logic actually turns red on it. Guards against the
  // check above being vacuously true (e.g. because the strip step
  // accidentally eats the whole file).
  it("guard liveness: turns red when a `\\s` token is injected into a copy of the module", () => {
    const source = readFileSync(APPROVE_ESCAPE_SOURCE_URL, "utf8");
    const mutated = source.replace(
      "const COMMAND_META_RE = /[;&|<>]/;",
      "const COMMAND_META_RE = /[;&|<>\\s]/;",
    );
    // Fails loudly (rather than silently passing on a no-op replace) if
    // the anchor text above ever drifts out of sync with the real source.
    expect(mutated, "mutation anchor not found in approve-escape.ts").not.toBe(source);
    const mutatedCode = stripCommentsAndStrings(mutated);
    expect(mutatedCode.includes("\\s")).toBe(true);
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
