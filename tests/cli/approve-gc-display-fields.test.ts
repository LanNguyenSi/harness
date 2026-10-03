import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapeForDisplay } from "../../src/io/display-path.js";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/cli/main.js");
const HOSTILE = "chosen\u001b]52;c;Zm9v\u0007\u001b[2K\r\nforged\u007f\u009b\u202e\u200b\ufeff\u2028\u2029\u{e0001}";
const SESSION = "display-session";
let root: string;
let config: string;
let reports: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-display-fields-"));
  config = path.join(root, "harness.yaml");
  reports = path.join(root, ".understanding-gate/reports");
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(config, "version: 1\n");
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function report(body: Record<string, unknown>): string {
  const file = path.join(reports, "report.json");
  fs.writeFileSync(file, JSON.stringify({ sessionId: SESSION, approvalStatus: "pending", createdAt: new Date().toISOString(), ...body }));
  return file;
}

function run(verb: "approve" | "gc", guessed = false, session = SESSION): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: path.join(root, "home"), UNDERSTANDING_GATE_REPORT_DIR: reports };
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID"]) delete env[key];
  const args = verb === "approve" ? ["approve", "understanding"] : ["gc"];
  args.push("--config", config);
  if (verb === "approve" && !guessed) args.push("--session", session);
  const child = spawnSync(process.execPath, [MAIN, ...args], { env, input: "", encoding: "utf8", timeout: 30_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  // LF is the CLI's legitimate line delimiter; hostile LF must appear as
  // an escaped literal, as asserted at each field below. Tabs are unsafe too.
  for (const stream of [child.stdout, child.stderr]) {
    expect(stream).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u);
    expect(stream.split("\n").some((line) => line.startsWith("forged"))).toBe(false);
  }
  return child.stdout + child.stderr;
}

function parseError(): void {
  const dir = path.join(root, ".understanding-gate/parse-errors");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "latest.log"), JSON.stringify({ sessionId: SESSION, message: HOSTILE }));
}

// Date.parse accepts comments in legacy date strings. Hostile text in such
// a comment reaches date-dependent branches while preserving the timestamp.
function dateWithComment(date: Date): string {
  const value = `${date.toUTCString()} (${HOSTILE})`;
  expect(Date.parse(value)).toBe(date.getTime() - date.getMilliseconds());
  return value;
}

describe("approve/gc display fields (built CLI)", () => {
  it("escapes the latest parse-error message when there are no reports", () => {
    parseError();
    expect(run("approve")).toContain(`: ${escapeForDisplay(HOSTILE)}`);
  });

  it("escapes the latest parse-error message and createdAt of a stale fallback", () => {
    const createdAt = dateWithComment(new Date(Date.now() - 60 * 60_000));
    report({ sessionId: null, createdAt });
    parseError();
    const out = run("approve");
    expect(out).toContain(`created ${escapeForDisplay(createdAt)}`);
    expect(out).toContain(`: ${escapeForDisplay(HOSTILE)}`);
  });

  it("escapes the previous approval status without changing persisted approval", () => {
    const file = report({ approvalStatus: HOSTILE });
    const out = run("approve");
    expect(out).toContain(`approvalStatus: ${escapeForDisplay(HOSTILE)} → approved`);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).approvalStatus).toBe("approved");
  });

  it("escapes createdAt on a recent sessionId-less fallback", () => {
    const createdAt = dateWithComment(new Date());
    report({ sessionId: null, createdAt });
    expect(run("approve")).toContain(`fallback: created ${escapeForDisplay(createdAt)}`);
  });

  it("escapes a guessed session id and its marker path, preserving the actual id", () => {
    report({ sessionId: HOSTILE });
    const out = run("approve", true);
    const marker = path.join(root, "harness.generated/.approvals", HOSTILE);
    expect(out).toContain(`session: ${escapeForDisplay(HOSTILE)} (GUESSED`);
    expect(out).toContain(`marker:  ✓ ${escapeForDisplay(marker)}`);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("escapes an unknown legacy report mode without changing validation", () => {
    report({ mode: HOSTILE });
    expect(run("approve")).toContain(`validation: ✓ ${escapeForDisplay(HOSTILE)} report passed`);
  });

  it.each(["other-session", "stale-fallback"])("escapes the unmatched session id in the %s reason", (kind) => {
    report(kind === "other-session" ? {} : { sessionId: null, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(run("approve", false, HOSTILE)).toContain(`no report matched session_id=${escapeForDisplay(HOSTILE)}`);
  });

  it.each(["future", "invalid"])("escapes an in-flight approvedAt in the %s branch", (kind) => {
    const approvedAt = kind === "future" ? dateWithComment(new Date(Date.now() + 60 * 60_000)) : HOSTILE;
    const dir = path.join(root, "harness.generated/.inflight", SESSION);
    fs.mkdirSync(dir, { recursive: true });
    const record = path.join(dir, "agent");
    fs.writeFileSync(record, JSON.stringify({ approvedAt }));
    const out = run("gc");
    expect(out).toContain(escapeForDisplay(approvedAt));
    expect(out).toContain(kind === "future" ? "minutes in the future" : "not a valid instant");
    expect(fs.existsSync(record)).toBe(true); // Dry-run remains read-only.
  });
});
