import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { ClaudeDenyJson, LedgerClient } from "../../src/runtime/intercept.js";
import type { Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";
import { addGitDirSkeleton } from "../_helpers/git-dir-fixture.js";
import {
  legacyPreflightInvestigation,
  legacyPreflightPush,
} from "../_helpers/legacy-preflight-policies.js";

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

/** The preflight-before-investigation fixture, verbatim (incl. `ux:`). */
function shippedPolicy(): Policy {
  return legacyPreflightInvestigation();
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
  addGitDirSkeleton(path.join(dir, ".git"));
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

function targetSentence(repo: string, dir: string): string {
  return (
    `This command targets repository \`${repo}\` (directory \`${dir}\`). ` +
    "The required evidence is missing for that repository, not for the working directory, " +
    "so it has to be produced for that repository itself."
  );
}

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
        // The operator-curated ux text stays intact, and the sentence follows
        // after a blank line so it never lands on the `Run:` command line.
        expect(text).toBe(`${CWD_ONLY_UX_TEXT}\n\n${targetSentence("libfoo", resolvedDir)}`);
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
      expect(reason).toContain(`(directory \`${fs.realpathSync(libfoo)}\`)`);
      // Neutral text is one paragraph: the sentence is appended after a single space.
      expect(reason.endsWith(` ${targetSentence("libfoo", fs.realpathSync(libfoo))}`)).toBe(true);
      expect(reason).not.toContain("\n\nThis command targets repository");
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

  it("cwd-only neutral block carries no target sentence and no target directory", async () => {
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

describe("a foreign target reached through a hostile symlink name", () => {
  // C1 NEL, line and paragraph separators, bidi override, embedding and
  // isolate controls and the bidi marks, plus instruction-like text. Built
  // from code points so this file holds none of them raw.
  const HOSTILE = [0x85, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
  const hostileChars = HOSTILE.map((n) => String.fromCodePoint(n));

  function assertNoneRaw(text: string): void {
    for (const ch of hostileChars) expect(text).not.toContain(ch);
  }

  it("shows the block text none of the hostile characters, in both the repo and the directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-6c278e7a-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const outer = path.join(root, "outer");
    writeGitDir(outer);
    // The directory the link resolves to carries every hostile character.
    const real = path.join(root, `real${hostileChars.join("")}dir`);
    writeGitDir(real);
    // U+2028 and U+2029 are whitespace to the command tokeniser, so the link
    // name the command spells carries only the characters that are not.
    const linkName = `lnk${hostileChars.filter((ch) => !/\s/.test(ch)).join("")}IGNORE`;
    fs.mkdirSync(path.join(outer, "vendor"), { recursive: true });
    fs.symlinkSync(real, path.join(outer, "vendor", linkName), "dir");
    const command = `git -C ${path.join("vendor", linkName)} log`;

    const result = await run(shippedPolicy(), outer, command, ["preflight:outer"]);
    expect(result.blocked).toBe(true);
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("targets repository");
    assertNoneRaw(reason);
    expect(reason).toContain("\\u{2028}");
    expect(reason).toContain("\\u{2029}");
    assertNoneRaw(result.blockJson?.hookSpecificOutput?.permissionDecisionReason ?? "");
    assertNoneRaw(JSON.stringify(result.blockJson).replace(/\\u[0-9a-fA-F]{4}/g, ""));
  });

  it("escapes the same characters when the real directory name carries them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-6c278e7a-real-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const outer = path.join(root, "outer");
    writeGitDir(outer);
    const name = `rl${hostileChars.join("")}dir`;
    const real = path.join(root, name);
    writeGitDir(real);
    fs.mkdirSync(path.join(outer, "vendor"), { recursive: true });
    fs.symlinkSync(real, path.join(outer, "vendor", "plain"), "dir");

    const result = await run(shippedPolicy(), outer, "git -C vendor/plain log", ["preflight:outer"]);
    expect(result.blocked).toBe(true);
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("targets repository");
    assertNoneRaw(reason);
    // The escapes are visible, so the name is not silently shortened.
    expect(reason).toContain("\\u{202e}");
    expect(reason).toContain("\\u{0085}");
  });

  it("escapes invisible format and default-ignorable characters in the real directory name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-d9a6d818-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const outer = path.join(root, "outer");
    writeGitDir(outer);
    // Tag characters, variation selectors, the BOM, word joiner, zero width
    // space, soft hyphen, combining grapheme joiner, Hangul filler and the
    // Mongolian vowel separator. Built from code points so this file holds
    // none of them raw.
    const INVISIBLE = [0xe0041, 0xe0049, 0xfe0f, 0xe0100, 0xfeff, 0x2060, 0x200b, 0xad, 0x34f, 0x3164, 0x180e];
    const invisibleChars = INVISIBLE.map((n) => String.fromCodePoint(n));
    const name = `v${invisibleChars.join("")}d`;
    const real = path.join(root, name);
    writeGitDir(real);
    fs.mkdirSync(path.join(outer, "vendor"), { recursive: true });
    fs.symlinkSync(real, path.join(outer, "vendor", "plain"), "dir");

    const result = await run(shippedPolicy(), outer, "git -C vendor/plain log", ["preflight:outer"]);
    expect(result.blocked).toBe(true);
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("targets repository");
    for (const ch of invisibleChars) expect(reason).not.toContain(ch);
    // The escapes are visible, so the name is not silently shortened.
    expect(reason).toContain("\\u{e0041}");
    expect(reason).toContain("\\u{feff}");
    const structured = result.blockJson?.hookSpecificOutput?.permissionDecisionReason ?? "";
    for (const ch of invisibleChars) expect(structured).not.toContain(ch);
  });
});

describe("foreign-target sentence is not added to envelopes that name their own cause", () => {
  it("a foreign target on a detached HEAD gets the empty-BRANCH envelope, not the target sentence", async () => {
    const { outer, libfoo } = makeNestedFixture();
    // libfoo's HEAD holds a raw sha: detached, no branch.
    fs.writeFileSync(path.join(libfoo, ".git", "HEAD"), `${"a".repeat(40)}\n`);
    addGitDirSkeleton(path.join(libfoo, ".git"));
    const pushPolicy = legacyPreflightPush();
    const result = await run(pushPolicy, outer, "git -C vendor/libfoo push origin HEAD", [
      "preflight:main",
    ]);

    expect(result.blocked).toBe(true);
    const reason = result.blockJson?.reason ?? "";
    // Exactly the pre-existing empty-BRANCH envelope, nothing appended.
    expect(reason).toBe(
      "preflight-before-push: no branch is checked out in repository `libfoo`: HEAD is detached, " +
        "so the branch-scoped evidence this policy checks cannot be looked up. Check out a named " +
        "branch there (`git switch <branch>`, or `git switch -c <branch>` for a new one), create " +
        "the evidence for that branch, then retry the command.",
    );
    expect(result.blockJson?.hookSpecificOutput?.permissionDecisionReason).toBe(reason);
  });

  it("a degraded ledger yields the deny-degraded envelope without the target sentence", async () => {
    const { libfoo } = makeNestedFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bb202fb9-out-"));
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    const degraded: LedgerClient = {
      async query() {
        return { kind: "degraded", reason: "grounding-mcp timeout after 5000ms" };
      },
      async record() {
        /* no-op */
      },
    };
    const out = capture();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: `git -C ${libfoo} log` },
          session_id: "sess-bb202fb9",
          cwd: outside,
        }),
      ),
      stdout: out.stream,
      stderr: sink(),
      manifest: makeManifest({ policies: [shippedPolicy()] }),
      ledger: degraded,
    });

    expect(result.blocked).toBe(true);
    expect(result.decisions.some((d) => d.outcome === "deny-degraded")).toBe(true);
    const reason = (JSON.parse(out.output().trim()) as ClaudeDenyJson).reason;
    // Exactly the pre-existing deny-degraded envelope, nothing appended.
    expect(reason).toBe(
      "preflight-before-investigation: required evidence could not be read (evidence ledger " +
        "degraded: grounding-mcp timeout after 5000ms). This block policy fails closed while its " +
        "evidence source is unreadable; producing the required tag will not unblock it until the " +
        "ledger is reachable again. Ask your operator to check grounding-mcp (harness doctor), " +
        "then retry. Session: sess-bb202fb9.",
    );
  });
});
