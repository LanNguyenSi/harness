import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { runSessionStartPreflight } from "../../src/cli/session-start/index.js";
import type { ClaudeDenyJson, LedgerClient } from "../../src/runtime/intercept.js";
import { parseManifest, type Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Block message for a decision attributed to a foreign target (a nested or
// vendored work tree named by `git -C <dir>` / `cd <dir> &&`). The gate
// itself is unchanged; only the agent-visible text names the target repo
// and its directory.

let cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of cleanups) c();
  cleanups = [];
});

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function capture(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/** The shipped preflight-before-investigation policy, verbatim (incl. `ux:`). */
function shippedPolicy(): Policy {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === "preflight-before-investigation");
  if (!policy) throw new Error("preflight-before-investigation missing from FULL_TEMPLATE");
  return policy;
}

/** The same policy without `ux:` and `producers:` (neutral deny envelope). */
function neutralPolicy(): Policy {
  const { ux: _ux, producers: _producers, ...rest } = shippedPolicy() as Policy & {
    ux?: unknown;
    producers?: unknown;
  };
  return rest as Policy;
}

function writeGitDir(dir: string, branch = "main"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

/** `<tmp>/outer` with `.git/HEAD`, and `outer/vendor/libfoo` with its own `.git/HEAD`. */
function makeNestedFixture(): { outer: string; libfoo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bb202fb9-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const outer = path.join(root, "outer");
  const libfoo = path.join(outer, "vendor", "libfoo");
  writeGitDir(outer);
  writeGitDir(libfoo);
  return { outer, libfoo };
}

function ledgerWithEntries(contents: string[]): LedgerClient {
  const entries = contents.map((content, i) => ({
    id: `e${i}`,
    content,
    createdAt: new Date().toISOString(),
  }));
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

async function run(
  policy: Policy,
  cwd: string,
  command: string,
  entries: string[],
  extraEvent: Record<string, unknown> = {},
) {
  const out = capture();
  const result = await runInterceptCli({
    stdin: streamFrom(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        session_id: "sess-bb202fb9",
        cwd,
        ...extraEvent,
      }),
    ),
    stdout: out.stream,
    stderr: sink(),
    manifest: makeManifest({ policies: [policy] }),
    ledger: ledgerWithEntries(entries),
  });
  const written = out.output().trim();
  const blockJson = written.length > 0 ? (JSON.parse(written) as ClaudeDenyJson) : null;
  return { ...result, blockJson };
}

const CWD_ONLY_UX_TEXT =
  "You cannot investigate this repository yet.\n\n" +
  "Required:\n" +
  "- verified repository preflight\n" +
  "- an approved Understanding Report, if the Understanding Gate is still active (it blocks `harness preflight` itself)\n\n" +
  "Run:\n" +
  "  harness preflight";

describe("foreign-target block message (nested / vendored work tree)", () => {
  for (const spelling of ["git -C vendor/libfoo log", "cd vendor/libfoo && git log"]) {
    it(`ux branch: \`${spelling}\` names the target repo and its resolved directory`, async () => {
      const { outer, libfoo } = makeNestedFixture();
      const result = await run(shippedPolicy(), outer, spelling, ["preflight:outer"]);

      expect(result.blocked).toBe(true);
      // The gate is exactly as strict as before: same decisions, same tags.
      expect(
        result.decisions.map((d) => [d.ledgerTag, d.outcome]).sort(),
      ).toEqual([
        ["preflight:libfoo", "deny"],
        ["preflight:outer", "allow"],
      ]);

      const block = result.blockJson;
      expect(block ?? null).not.toBeNull();
      const resolvedDir = fs.realpathSync(libfoo);
      for (const text of [block?.reason, block?.hookSpecificOutput?.permissionDecisionReason]) {
        expect(text).toContain("libfoo");
        expect(text).toContain(resolvedDir);
        // The operator-curated ux text is intact at the head of the message.
        expect(text?.startsWith(CWD_ONLY_UX_TEXT)).toBe(true);
        // Policy-neutral wording: no opt-out, no pause, no manifest edit.
        expect(text).not.toMatch(/pause|opt-out|fail_open|manifest/i);
      }
    });

    it(`neutral branch: \`${spelling}\` names the target repo and its resolved directory`, async () => {
      const { outer, libfoo } = makeNestedFixture();
      const result = await run(neutralPolicy(), outer, spelling, ["preflight:outer"]);

      expect(result.blocked).toBe(true);
      const reason = result.blockJson?.reason ?? "";
      expect(reason).toContain("libfoo");
      expect(reason).toContain(fs.realpathSync(libfoo));
      expect(reason).not.toMatch(/pause|opt-out|fail_open/i);
    });
  }

  it("cwd-only block (no foreign attribution) keeps the exact pre-existing text", async () => {
    const { outer } = makeNestedFixture();
    const result = await run(shippedPolicy(), outer, "git log", []);

    expect(result.blocked).toBe(true);
    expect(result.decisions.map((d) => [d.ledgerTag, d.outcome])).toEqual([
      ["preflight:outer", "deny"],
    ]);
    expect(result.blockJson?.reason).toBe(CWD_ONLY_UX_TEXT);
    expect(result.blockJson?.hookSpecificOutput?.permissionDecisionReason).toBe(CWD_ONLY_UX_TEXT);
  });

  it("cwd-only neutral block keeps the exact pre-existing text shape", async () => {
    const { outer } = makeNestedFixture();
    const result = await run(neutralPolicy(), outer, "git log", []);
    const reason = result.blockJson?.reason ?? "";
    expect(reason).not.toContain("targets repository");
    expect(reason).not.toContain(path.join("vendor", "libfoo"));
  });

  it("a block caused by the cwd context of a foreign-target command carries no target sentence", async () => {
    // Evidence present for libfoo, missing for outer: the blocking decision
    // belongs to the cwd context, so the message stays the cwd-only text.
    const { outer } = makeNestedFixture();
    const result = await run(shippedPolicy(), outer, "git -C vendor/libfoo log", [
      "preflight:libfoo",
    ]);
    expect(result.blocked).toBe(true);
    expect(result.blockJson?.reason).toBe(CWD_ONLY_UX_TEXT);
  });

  it("allows when both preflight:outer and preflight:libfoo are on record", async () => {
    const { outer } = makeNestedFixture();
    for (const spelling of ["git -C vendor/libfoo log", "cd vendor/libfoo && git log"]) {
      const result = await run(shippedPolicy(), outer, spelling, [
        "preflight:outer",
        "preflight:libfoo",
      ]);
      expect(result.blocked).toBe(false);
      expect(result.blockJson ?? null).toBeNull();
    }
  });

  it("renders a target path with control characters only sanitised", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bb202fb9-ctl-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const outer = path.join(root, "outer");
    writeGitDir(outer);
    // ESC (0x1b) and BEL (0x07) inside the directory name, built without raw
    // control bytes in the source file. Neither is whitespace, so the command
    // tokenises them as part of the `-C` argument.
    const evilName = `ev${String.fromCharCode(27)}il${String.fromCharCode(7)}dir`;
    const evil = path.join(outer, "vendor", evilName);
    writeGitDir(evil);
    const command = `git -C ${path.join("vendor", evilName)} log`;

    const result = await run(shippedPolicy(), outer, command, ["preflight:outer"]);
    expect(result.blocked).toBe(true);
    const reason = result.blockJson?.reason ?? "";
    const controlRe = new RegExp(
      `[${String.fromCharCode(0)}-${String.fromCharCode(9)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
    );
    expect(controlRe.test(reason)).toBe(false);
    expect(reason).toContain("targets repository");
    expect(reason).toContain("ev il dir");
  });
});

describe("the remedy named for a foreign target is real", () => {
  it("`cd <dir> && harness preflight` records preflight:<target repo> when it reports ready:true", async () => {
    const { outer, libfoo } = makeNestedFixture();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(libfoo);
    const writes: Array<{ sessionId: string; content: string }> = [];
    const result = await runSessionStartPreflight({
      session: "sess-bb202fb9",
      runPreflight: async () => ({ ok: true, json: { ready: true, confidence: 0.9, checks: [] } }),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
      stderr: sink(),
    });
    cwdSpy.mockRestore();

    expect(result.wrote).toBe(true);
    expect(result.repo).toBe("libfoo");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toContain("preflight:libfoo");
    expect(writes[0]?.content).not.toContain("preflight:outer");
    void outer;
  });
});
