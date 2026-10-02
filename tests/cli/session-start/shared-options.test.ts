import { Command } from "commander";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStdinBounded } from "../../../src/cli/bounded-stdin.js";
import {
  addCwdOption,
  addIdentityOptions,
  addLedgerTimeoutOption,
  applyCliOptions,
  classifySessionSource,
  explicitSessionId,
  FALLBACK_SESSION,
  malformedEventReason,
  readSessionStartEvent,
  resolveEventCwd,
  type SessionStartCliTarget,
} from "../../../src/cli/session-start/shared-options.js";

describe("classifySessionSource", () => {
  const saved = {
    code: process.env.CLAUDE_CODE_SESSION_ID,
    plain: process.env.CLAUDE_SESSION_ID,
  };
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
  });
  afterEach(() => {
    for (const [key, value] of [
      ["CLAUDE_CODE_SESSION_ID", saved.code],
      ["CLAUDE_SESSION_ID", saved.plain],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports the flag when --session was given, even if the event has an id", () => {
    expect(classifySessionSource("flag-id", { session_id: "evt" }, "flag-id")).toBe("flag");
  });

  it("reports stdin when only the event carries an id", () => {
    expect(classifySessionSource(undefined, { session_id: "evt" }, "evt")).toBe("stdin");
  });

  it("treats an empty flag and an empty event id as absent", () => {
    expect(classifySessionSource("", { session_id: "" }, FALLBACK_SESSION)).toBe("default");
  });

  it("reports default when the resolver landed on the literal default", () => {
    expect(classifySessionSource(undefined, {}, FALLBACK_SESSION)).toBe("default");
  });

  it("reports env when the resolved id equals CLAUDE_CODE_SESSION_ID", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "from-code-env";
    expect(classifySessionSource(undefined, {}, "from-code-env")).toBe("env");
  });

  it("reports env when the resolved id equals CLAUDE_SESSION_ID", () => {
    process.env.CLAUDE_SESSION_ID = "from-plain-env";
    expect(classifySessionSource(undefined, {}, "from-plain-env")).toBe("env");
  });

  it("reports transcript for any other resolved id", () => {
    process.env.CLAUDE_SESSION_ID = "something-else";
    expect(classifySessionSource(undefined, {}, "found-in-transcript")).toBe("transcript");
  });

  it("forces default when the resolver threw, whatever the flag or event said", () => {
    expect(classifySessionSource("flag-id", { session_id: "evt" }, FALLBACK_SESSION, true)).toBe(
      "default",
    );
  });
});

describe("explicitSessionId", () => {
  it("prefers the flag, then the event id, else undefined", () => {
    expect(explicitSessionId("flag", { session_id: "evt" })).toBe("flag");
    expect(explicitSessionId(undefined, { session_id: "evt" })).toBe("evt");
    expect(explicitSessionId("", { session_id: "" })).toBeUndefined();
    expect(explicitSessionId(undefined, { session_id: 42 })).toBeUndefined();
  });
});

describe("resolveEventCwd", () => {
  it("prefers the override, then the event cwd, then process.cwd()", () => {
    expect(resolveEventCwd("/over", { cwd: "/evt" })).toBe("/over");
    expect(resolveEventCwd(undefined, { cwd: "/evt" })).toBe("/evt");
    expect(resolveEventCwd("", { cwd: "" })).toBe(process.cwd());
    expect(resolveEventCwd(undefined, { cwd: 7 })).toBe(process.cwd());
  });
});

describe("stdin event reading", () => {
  it("reads a stream to its end", async () => {
    const stream = new PassThrough();
    const read = readStdinBounded(stream);
    stream.write("ab");
    stream.end("cd");
    expect(await read).toEqual({ text: "abcd", timedOut: false });
  });

  it("parses the event JSON and treats blank input as an empty event", async () => {
    const full = new PassThrough();
    const parsed = readSessionStartEvent(full);
    full.end('  {"session_id":"s1","cwd":"/x"}\n');
    expect(await parsed).toEqual({ session_id: "s1", cwd: "/x" });

    const blank = new PassThrough();
    const empty = readSessionStartEvent(blank);
    blank.end("  \n");
    expect(await empty).toEqual({});
  });

  it("rejects malformed JSON and words the reason the way the producers log it", async () => {
    const stream = new PassThrough();
    const parsed = readSessionStartEvent(stream);
    stream.end("{nope");
    const err = await parsed.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(malformedEventReason(err)).toBe(`malformed event JSON: ${(err as Error).message}`);
  });
});

describe("commander wiring", () => {
  const build = (withCwd: boolean): Command => {
    const cmd = new Command("x").exitOverride();
    addIdentityOptions(cmd, "SESSION-DESC");
    if (withCwd) addCwdOption(cmd);
    addLedgerTimeoutOption(cmd);
    return cmd;
  };

  it("declares the shared options in the order the help text lists them", () => {
    const names = build(true).options.map((o) => o.long);
    expect(names).toEqual(["--config", "--project", "--session", "--cwd", "--ledger-timeout"]);
    expect(build(false).options.map((o) => o.long)).toEqual([
      "--config",
      "--project",
      "--session",
      "--ledger-timeout",
    ]);
  });

  it("uses the caller's --session description", () => {
    const session = build(true).options.find((o) => o.long === "--session");
    expect(session?.description).toBe("SESSION-DESC");
  });

  it("applies parsed options onto a producer's options", () => {
    const cmd = build(true);
    cmd.parse(
      ["--config", "/c.yaml", "--project", "p", "--session", "s", "--cwd", "/w", "--ledger-timeout", "250"],
      { from: "user" },
    );
    const target: SessionStartCliTarget = {};
    applyCliOptions(cmd.opts(), target);
    expect(target).toEqual({
      configPath: "/c.yaml",
      project: "p",
      session: "s",
      cwd: "/w",
      ledgerTimeoutMs: 250,
    });
  });

  it("leaves absent options unset and ignores a non-positive or malformed ledger timeout", () => {
    const target: SessionStartCliTarget = {};
    applyCliOptions({}, target);
    expect(target).toEqual({});
    for (const bad of ["0", "-5", "abc"]) {
      const t: SessionStartCliTarget = {};
      applyCliOptions({ ledgerTimeout: bad }, t);
      expect(t.ledgerTimeoutMs).toBeUndefined();
    }
  });
});
