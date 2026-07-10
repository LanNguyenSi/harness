import { describe, expect, it } from "vitest";
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

  it("rejects carriage returns in the command line", () => {
    expect(isEscapeCommand(`harness approve understanding <<'UR'\r\nbody\nUR`)).toBe(false);
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
