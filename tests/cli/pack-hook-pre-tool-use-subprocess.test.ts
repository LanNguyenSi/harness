// E2E subprocess tests for `harness pack hook pre-tool-use`.
//
// Spawns the REAL built CLI (dist/cli/main.js) as a child process to verify
// the complete hook entry path — manifest load, pack lookup, decision, stdout
// decision envelope — without mocking internals.
//
// Home-dir isolation: we pass `--config <tmpdir>/harness.yaml` AND set
// HARNESS_HOME to a tmp path. `--config` only overrides the base manifest path;
// the loader still resolves the machine/project override layers under the
// harness home (resolveHomeDir honors $HARNESS_HOME before any disk lookup), so
// without HARNESS_HOME a real ~/.harness/machines override could merge into the
// planted manifest and change the decision. With both set, the child reads and
// writes only under the tmp dir, never the operator's real ~/.harness/.
//
// Deterministic allow path: the planted harness.yaml declares NO
// policy_packs[], so the hook allows with "pack not declared in manifest,
// allowing." before it ever reaches the ledger or approval-marker checks.
// This gives a zero-dependency, fast, reproducible assertion.
//
// Why subprocess (not in-process): main.ts sets
// HARNESS_ALLOW_REAL_GENERATED_DIR=1 before importing. Running the module
// in-process inside vitest would skip that assignment and trip the
// resolvePaths() isolation guard. A subprocess gets a clean module state.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { approvalMarkerPathFor } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest } from "../../src/schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

// Minimal valid harness.yaml with NO policy_packs declared.
// Hook will allow immediately with "pack not declared in manifest, allowing."
const MANIFEST_NO_PACKS = `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`;

// Manifest that DECLARES + ENABLES the understanding-before-execution pack
// with a `config.producers` kind:ask entry (mirrors the in-process unit
// test's "renders config.producers into the deny envelope" case in
// pack-hook-pre-tool-use.test.ts). No approval marker, persisted report, or
// ledger entry exists anywhere under the isolated tmp dir, so the hook falls
// through every allow source and reaches the hard BLOCK/deny path.
const MANIFEST_WITH_PACK = `version: 1
policy_packs:
  - name: understanding-before-execution
    enabled: true
    config:
      producers:
        - kind: ask
          command: harness approve understanding
          description: Bare command. Operator approval IS the gate satisfaction.
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-hook-e2e-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runHook(
  configPath: string,
  stdinPayload: string,
  opts: {
    verb?: "pre-tool-use" | "codex-pre-tool-use";
    timeoutMs?: number;
    /** Extra child environment (the auto-approval path reads the Claude session id from it). */
    env?: Record<string, string>;
  } = {},
): { status: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number } {
  // Strip session-id env vars so the test controls which code path the hook
  // takes (otherwise the dev host's $CLAUDE_CODE_SESSION_ID could influence
  // the decision for a pack-declared manifest).
  const childEnv = { ...process.env };
  delete childEnv["CLAUDE_CODE_SESSION_ID"];
  delete childEnv["CLAUDE_SESSION_ID"];
  delete childEnv["CODEX_SESSION_ID"];
  // Pin the harness home under the tmp dir so the machine/project override
  // layers cannot resolve against the operator's real ~/.harness/.
  childEnv["HARNESS_HOME"] = path.join(tmpDir, "home");
  // Pin the persisted-report lookup under the tmp dir too, so the deny-path
  // case below can never accidentally pick up a real
  // `<cwd>/.understanding-gate/reports` directory (defaultReportsDir()
  // falls back to cwd when this is unset).
  childEnv["UNDERSTANDING_GATE_REPORT_DIR"] = path.join(tmpDir, "reports");
  Object.assign(childEnv, opts.env);

  const started = Date.now();
  const result = spawnSync(
    "node",
    [MAIN_JS, "pack", "hook", opts.verb ?? "pre-tool-use", "--config", configPath],
    {
      input: stdinPayload,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 15_000,
      // A hook stuck in a blocking open() is killed outright at the timeout.
      killSignal: "SIGKILL",
      env: childEnv,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    ms: Date.now() - started,
  };
}

describe("pack hook pre-tool-use — subprocess E2E (allow path)", () => {
  it("exits 0 with empty stdout when the pack is not declared in the manifest", () => {
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_NO_PACKS, "utf8");

    const event = JSON.stringify({
      session_id: "sess-hook-e2e-1",
      tool_name: "Edit",
      tool_input: { file_path: "/some/file.ts", old_string: "x", new_string: "y" },
    });

    const { status, stdout, stderr } = runHook(configPath, event);

    expect(status).toBe(0);
    // Allow path: hook writes nothing to stdout (only block/ask emit JSON)
    expect(stdout.trim()).toBe("");
    // The hook always writes a diagnostic line to stderr
    expect(stderr).toContain("not declared in manifest");
  });

  it("exits 0 with empty stdout on malformed stdin JSON (fail-open contract)", () => {
    // When stdin is not valid JSON, the hook falls through to allow rather
    // than erroring, so a broken event injector never hard-blocks the session.
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_NO_PACKS, "utf8");

    const { status, stdout, stderr } = runHook(configPath, "{not valid json}");

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
    // Loud degradation: the fail-open path must announce why on stderr, so a
    // silent-swallow regression is caught.
    expect(stderr).toContain("malformed event JSON on stdin");
  });

  it("exits 0 with empty stdout on empty stdin", () => {
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_NO_PACKS, "utf8");

    const { status, stdout } = runHook(configPath, "");

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});

describe("pack hook pre-tool-use — subprocess E2E (deny path)", () => {
  it("emits the block/deny envelope when the pack is declared with a kind:ask producer and no approval marker exists", () => {
    // Security-relevant path: a declared + enabled pack, no operator
    // approval marker/report/ledger entry anywhere under the isolated tmp
    // dir. A field-name regression in blockJson()'s envelope (e.g.
    // "decision" or "permissionDecision" typo'd or dropped) would only be
    // caught here — the allow-path cases above never reach blockJson() at
    // all.
    const configPath = path.join(tmpDir, "harness.yaml");
    fs.writeFileSync(configPath, MANIFEST_WITH_PACK, "utf8");

    const event = JSON.stringify({
      session_id: "sess-hook-e2e-deny-1",
      tool_name: "Edit",
      tool_input: { file_path: "/some/file.ts", old_string: "x", new_string: "y" },
    });

    const { status, stdout, stderr } = runHook(configPath, event);

    expect(status).toBe(0);
    const decision = JSON.parse(stdout.trim()) as {
      decision?: string;
      reason?: string;
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    // The legacy top-level field (keeps 2.0.x CLIs blocking)...
    expect(decision.decision).toBe("block");
    // ...and the Claude Code 2.1+ documented PreToolUse contract.
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(stderr).toMatch(/BLOCK/);
  });
});

// The gate-read report content check reads every *.json entry of the reports
// directory, which the agent can write. A hook that dies (a crash exit) or
// never returns is a non-blocking error for the runtime, so the call would
// proceed: the check must still decide next to a file nested thousands of
// levels deep (once a stack overflow), a file over the 1 MiB hashing cap
// (once a heap exhaustion at a few hundred megabytes; the failing class is
// "size over the cap", and 2 MiB is one member of it that keeps the suite
// fast) and a FIFO with no writer (once a blocking open).
// This pins the hash scan and, below, the evidence read.
// The evidence read (no marker at all, and after a refused marker) is bounded
// the same way: it reads each report file through the one bounded reader, so
// a FIFO or a file over the cap there is skipped instead of blocking the hook
// or running it out of memory (the cases tagged "evidence read" below). So
// are the other two readers of the reports directory on those paths, the
// auto-approval precondition (which also declines when it had to skip an
// entry) and the parse-error log lookup (the cases tagged "auto-approval" and
// "parse-error log" below).
// Built CLI, both runtimes: Claude exits 0 with a block decision on stdout,
// Codex exits 2.
interface E2ERuntime {
  verb: "pre-tool-use" | "codex-pre-tool-use";
  event: (session: string) => string;
  expectAllow: (run: ReturnType<typeof runHook>) => void;
  expectBlock: (run: ReturnType<typeof runHook>) => void;
}

const E2E_RUNTIMES: E2ERuntime[] = [
  {
    verb: "pre-tool-use",
    event: (session) =>
      JSON.stringify({
        session_id: session,
        tool_name: "Edit",
        tool_input: { file_path: "/some/file.ts", old_string: "x", new_string: "y" },
      }),
    expectAllow: (run) => {
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr).toMatch(/approved via marker/);
    },
    expectBlock: (run) => {
      expect(run.status).toBe(0);
      expect((JSON.parse(run.stdout.trim()) as { decision?: string }).decision).toBe("block");
    },
  },
  {
    verb: "codex-pre-tool-use",
    event: (session) => JSON.stringify({ session_id: session, tool_name: "apply_patch" }),
    expectAllow: (run) => {
      expect(run.status).toBe(0);
      expect(run.stderr).toMatch(/approved via marker/);
    },
    expectBlock: (run) => {
      expect(run.status).toBe(2);
    },
  },
];

const FIFO_PLANTS: [string, (reportsDir: string) => void][] = [
  ["a FIFO", (reportsDir) => execFileSync("mkfifo", [path.join(reportsDir, "zz-fifo.json")])],
  [
    "a symlink to a FIFO",
    (reportsDir) => {
      const pipe = path.join(tmpDir, "outside-pipe");
      execFileSync("mkfifo", [pipe]);
      fs.symlinkSync(pipe, path.join(reportsDir, "zz-link.json"));
    },
  ],
];

const MISMATCH_SESSION =
  /no report in the reports directory matches the content the session approval marker was signed for/;

describe.each(E2E_RUNTIMES)(
  "pack hook $verb: subprocess E2E (the report content check still decides next to a deeply nested, an oversized or a FIFO *.json)",
  (rt) => {
    /** Approve a pending report through the real flow; the hook resolves harness.generated next to --config. */
    async function approvedSetup(session: string): Promise<{
      configPath: string;
      reportsDir: string;
      reportPath: string;
      run: (timeoutMs?: number) => ReturnType<typeof runHook>;
    }> {
      const configPath = path.join(tmpDir, "harness.yaml");
      fs.writeFileSync(configPath, MANIFEST_WITH_PACK, "utf8");
      const reportsDir = path.join(tmpDir, "reports");
      const generatedDir = path.join(tmpDir, "harness.generated");
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, "r1.json");
      fs.writeFileSync(
        reportPath,
        JSON.stringify({
          sessionId: session,
          approvalStatus: "pending",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          content: "the understanding the operator reviewed",
        }),
      );
      const approve = await approveUnderstanding({
        manifest: parseManifest({ version: 1 }),
        session,
        reportsDir,
        generatedDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(approve.marker.ok).toBe(true);
      const event = rt.event(session);
      return {
        configPath,
        reportsDir,
        reportPath,
        run: (timeoutMs) => runHook(configPath, event, { verb: rt.verb, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
      };
    }

    function tamper(reportPath: string): void {
      const approved = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(reportPath, JSON.stringify({ ...approved, content: "SWAPPED" }));
    }

    it("a tampered approval next to a deeply nested *.json blocks with the mismatch reason, not a crash exit", async () => {
      const { reportsDir, reportPath, run } = await approvedSetup(`sess-e2e-deep-${rt.verb}`);
      // Control: the untouched approval allows through the built CLI.
      rt.expectAllow(run());

      tamper(reportPath);
      fs.writeFileSync(path.join(reportsDir, "zz-deep.json"), `{"content":${"[".repeat(6000)}${"]".repeat(6000)}}`);
      const after = run();

      rt.expectBlock(after);
      expect(after.stderr).toMatch(MISMATCH_SESSION);
      expect(after.stderr).not.toMatch(/Maximum call stack size exceeded/);
    });

    it("a 2 MiB *.json carrying the approved content is over the size cap: next to the untouched approval it allows, after a tamper it blocks", async () => {
      const { reportsDir, reportPath, run } = await approvedSetup(`sess-e2e-big-${rt.verb}`);
      // The approved content padded with JSON whitespace past the cap: within
      // the cap it would be a copy that keeps a match.
      fs.writeFileSync(path.join(reportsDir, "zz-big.json"), fs.readFileSync(reportPath, "utf8") + " ".repeat(2 * 1024 * 1024));
      rt.expectAllow(run());

      tamper(reportPath);
      const after = run();

      rt.expectBlock(after);
      expect(after.stderr).toMatch(MISMATCH_SESSION);
    });

    it.each(FIFO_PLANTS)(
      "%s named *.json with no writer is skipped without blocking: the untouched approval allows and the tampered one blocks, each within the bound",
      async (_kind, plant) => {
        const { reportsDir, reportPath, run } = await approvedSetup(`sess-e2e-fifo-${rt.verb}`);
        plant(reportsDir);
        // A blocking open() of the FIFO would wait for a writer forever; the
        // child is killed at the bound and the run reports it as timed out.
        const bound = 10_000;
        const allowed = run(bound);
        expect(allowed.timedOut).toBe(false);
        expect(allowed.ms).toBeLessThan(bound);
        rt.expectAllow(allowed);

        tamper(reportPath);
        const blocked = run(bound);
        expect(blocked.timedOut).toBe(false);
        expect(blocked.ms).toBeLessThan(bound);
        rt.expectBlock(blocked);
        expect(blocked.stderr).toMatch(MISMATCH_SESSION);
      },
      60_000,
    );

    // The evidence read after a refused marker. The refusal is the same
    // mismatch block, whatever the evidence read finds; what it must not do
    // is wait on a FIFO or die on a huge file. The cases pin that the decision
    // is reached, promptly, with the unchanged deny. (The reason carries no
    // report-derived value, so the evidence a skipped file would have
    // contributed is pinned by the no-marker cases below.)
    it("evidence read after a refused marker: a tampered approval next to a 2 MiB approved report of the same session still blocks with the mismatch reason", async () => {
      const session = `sess-e2e-ev-big-${rt.verb}`;
      const { reportsDir, reportPath, run } = await approvedSetup(session);
      fs.writeFileSync(
        path.join(reportsDir, "zz-big-approved.json"),
        JSON.stringify({
          sessionId: session,
          approvalStatus: "approved",
          createdAt: new Date().toISOString(),
          content: "planted",
        }) + " ".repeat(2 * 1024 * 1024),
      );
      tamper(reportPath);

      const after = run(10_000);

      expect(after.timedOut).toBe(false);
      rt.expectBlock(after);
      expect(after.stderr).toMatch(MISMATCH_SESSION);
    });

    it.each(FIFO_PLANTS)(
      "evidence read after a refused marker: %s named *.json with no writer next to the tampered approval blocks with the mismatch reason within the bound",
      async (_kind, plant) => {
        const { reportsDir, reportPath, run } = await approvedSetup(`sess-e2e-ev-fifo-${rt.verb}`);
        tamper(reportPath);
        plant(reportsDir);
        const bound = 10_000;

        const blocked = run(bound);

        expect(blocked.timedOut).toBe(false);
        expect(blocked.ms).toBeLessThan(bound);
        rt.expectBlock(blocked);
        expect(blocked.stderr).toMatch(MISMATCH_SESSION);
      },
      60_000,
    );

    // No marker at all: the hash scan never runs, so the evidence read is the
    // only reader of the reports directory.
    function noMarkerSetup(): { reportsDir: string; run: (timeoutMs?: number) => ReturnType<typeof runHook> } {
      const configPath = path.join(tmpDir, "harness.yaml");
      fs.writeFileSync(configPath, MANIFEST_WITH_PACK, "utf8");
      const reportsDir = path.join(tmpDir, "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      const event = rt.event(`sess-e2e-nomarker-${rt.verb}`);
      return {
        reportsDir,
        run: (timeoutMs) => runHook(configPath, event, { verb: rt.verb, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
      };
    }

    it("evidence read, no marker: a 2 MiB approved report of the session is skipped, so the block names no report instead of the unsigned approval", () => {
      const { reportsDir, run } = noMarkerSetup();
      fs.writeFileSync(
        path.join(reportsDir, "zz-big-approved.json"),
        JSON.stringify({
          sessionId: `sess-e2e-nomarker-${rt.verb}`,
          approvalStatus: "approved",
          createdAt: new Date().toISOString(),
          content: "planted",
        }) + " ".repeat(2 * 1024 * 1024),
      );

      const result = run(10_000);

      expect(result.timedOut).toBe(false);
      rt.expectBlock(result);
      expect(result.stderr).toMatch(/no reports found at/);
      expect(result.stderr).not.toMatch(/unsigned persisted-report approval rejected/);
    });

    it("evidence read, no marker: a regular approved report of the session is still reported as an unsigned approval claim (unchanged)", () => {
      const { reportsDir, run } = noMarkerSetup();
      fs.writeFileSync(
        path.join(reportsDir, "r1.json"),
        JSON.stringify({
          sessionId: `sess-e2e-nomarker-${rt.verb}`,
          approvalStatus: "approved",
          createdAt: new Date().toISOString(),
          content: "forged",
        }),
      );

      const result = run(10_000);

      rt.expectBlock(result);
      expect(result.stderr).toMatch(/unsigned persisted-report approval rejected/);
    });

    it.each(FIFO_PLANTS)(
      "evidence read, no marker: %s named *.json with no writer gives the unchanged no-report block within the bound",
      (_kind, plant) => {
        const { reportsDir, run } = noMarkerSetup();
        plant(reportsDir);
        const bound = 10_000;

        const result = run(bound);

        // A blocking open() of the FIFO would wait for a writer forever; the
        // child is killed at the bound and the run reports it as timed out.
        expect(result.timedOut).toBe(false);
        expect(result.ms).toBeLessThan(bound);
        rt.expectBlock(result);
        expect(result.stderr).toMatch(/no reports found at/);
      },
      60_000,
    );
  },
);

// Auto-approval opted in (the shipped default is `when: [bypassPermissions]`).
// With no matching marker, and after a refused marker, the hook reaches the
// auto-approval precondition, which lists the reports directory too. That
// listing is bounded like the evidence read, and it declines (the call stays
// blocked) when it had to skip an entry, so an oversized or unreadable newest
// report never lets the selection fall back to an older pending one. The
// control in each describe shows a valid pending report does mint, so the
// declines below are caused by the planted entry. The planted size is 2 MiB,
// a member of the "over the 1 MiB cap" class; hundreds of megabytes are never
// written.
// Preload for the consume-window cases below (loaded into the hook process
// with NODE_OPTIONS=--import). While RETARGET_PATH is a symlink, every
// fs.openSync of it first points it at RETARGET_REAL and, once the descriptor
// is open, at RETARGET_PLANTED. Reads through a descriptor (the bounded
// reader) see the real report; a later read by path sees the planted entry.
// Each retarget appends one line to RETARGET_COUNT_FILE so a case can assert
// the window was actually exercised and cannot pass by checking nothing.
const RETARGET_AFTER_OPEN_PRELOAD = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const target = process.env.RETARGET_PATH;
const real = process.env.RETARGET_REAL;
const planted = process.env.RETARGET_PLANTED;
const countFile = process.env.RETARGET_COUNT_FILE;
const openSync = fs.openSync;
function isLink() {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}
function point(to) {
  const tmp = target + ".retarget";
  fs.symlinkSync(to, tmp);
  fs.renameSync(tmp, target);
}
fs.openSync = function (p, ...rest) {
  if (String(p) !== target || !isLink()) return openSync.call(this, p, ...rest);
  point(real);
  const fd = openSync.call(this, p, ...rest);
  point(planted);
  if (countFile) fs.appendFileSync(countFile, "retarget\\n");
  return fd;
};
syncBuiltinESMExports();
`;

// Preloads for the consume step's WRITE (loaded into the hook process with
// NODE_OPTIONS=--import). The consume step writes the approved report through
// a temp file in the agent-writable reports directory.
//
// SPRAY plants FIFOs, at process start, at every name the former scheme
// `.<base>.<pid>.<millisecond>.tmp` could produce for the next few seconds
// (the hook's own pid is known inside the process, which is what an attacker
// reading the process table gets). A writer that opens a predictable name
// without O_EXCL blocks on one of them until the kill; one that keeps a
// predictable name but opens with O_EXCL declines on the first; one with an
// unpredictable name never meets one. The number planted goes to SPRAY_COUNT_FILE.
const SPRAY_PRELOAD = `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const dir = process.env.SPRAY_DIR;
const base = process.env.SPRAY_BASE;
const now = Date.now();
const names = [];
for (let ms = now - 50; ms <= now + 4000; ms++) {
  names.push(path.join(dir, "." + base + "." + process.pid + "." + ms + ".tmp"));
}
for (let i = 0; i < names.length; i += 500) {
  spawnSync("mkfifo", names.slice(i, i + 500));
}
fs.writeFileSync(process.env.SPRAY_COUNT_FILE, String(names.filter((n) => fs.existsSync(n)).length));
`;

// PLANT_AT_CHOSEN_NAME plants one entry at the temp name the write chose, right
// before the first open of it: the attack with a name the attacker knows. The
// kind is PLANT_KIND (fifo | symlink | file); a symlink points at PLANT_OUTSIDE.
// The planted path goes to PLANT_RECORD_FILE.
const PLANT_AT_CHOSEN_NAME_PRELOAD = `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const dir = process.env.PLANT_DIR;
const base = process.env.PLANT_BASE;
const kind = process.env.PLANT_KIND;
const openSync = fs.openSync;
let planted = false;
fs.openSync = function (p, ...rest) {
  const s = String(p);
  if (!planted && path.dirname(s) === dir && path.basename(s).startsWith("." + base + ".") && s.endsWith(".tmp")) {
    planted = true;
    if (kind === "fifo") spawnSync("mkfifo", [s]);
    else if (kind === "symlink") fs.symlinkSync(process.env.PLANT_OUTSIDE, s);
    else fs.writeFileSync(s, "planted\\n");
    fs.writeFileSync(process.env.PLANT_RECORD_FILE, s);
  }
  return openSync.call(this, p, ...rest);
};
syncBuiltinESMExports();
`;

const MANIFEST_WITH_AUTO_APPROVE = `version: 1
policy_packs:
  - name: understanding-before-execution
    enabled: true
    config:
      producers:
        - kind: ask
          command: harness approve understanding
          description: Bare command. Operator approval IS the gate satisfaction.
      auto_approve:
        when: [bypassPermissions]
        harnesses: [claude-code, codex]
        require_report: true
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`;

describe.each(E2E_RUNTIMES)(
  "pack hook $verb: subprocess E2E (auto-approval precondition with auto_approve on)",
  (rt) => {
    const OVER_CAP = " ".repeat(2 * 1024 * 1024);

    function pendingBody(session: string, createdAt: string): Record<string, unknown> {
      // grill_me on purpose: validatePersistedReport only inspects that mode.
      return {
        sessionId: session,
        approvalStatus: "pending",
        createdAt,
        mode: "grill_me",
        currentUnderstanding: "the auto path under test",
        priorArt: ["searched the repo for an existing auto-approval path; none exists, so build"],
      };
    }

    /**
     * `refused: false` is the no-marker path; `refused: true` signs a marker
     * for the session and then tampers with its report, so the marker is
     * refused and the call falls through to the same evidence read. A signing
     * key exists in both (the hook never creates one).
     */
    async function setup(
      session: string,
      refused: boolean,
    ): Promise<{
      reportsDir: string;
      generatedDir: string;
      run: (timeoutMs?: number, env?: Record<string, string>) => ReturnType<typeof runHook>;
      writePending: (name: string, createdAt: string) => string;
    }> {
      const configPath = path.join(tmpDir, "harness.yaml");
      fs.writeFileSync(configPath, MANIFEST_WITH_AUTO_APPROVE, "utf8");
      const reportsDir = path.join(tmpDir, "reports");
      const generatedDir = path.join(tmpDir, "harness.generated");
      fs.mkdirSync(reportsDir, { recursive: true });
      const keyOwner = refused ? session : "sess-key-owner";
      const seed = path.join(reportsDir, "r0.json");
      fs.writeFileSync(seed, JSON.stringify(pendingBody(keyOwner, new Date(Date.now() - 3_600_000).toISOString())));
      const approve = await approveUnderstanding({
        manifest: parseManifest({ version: 1 }),
        session: keyOwner,
        reportsDir,
        generatedDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(approve.marker.ok).toBe(true);
      if (refused) {
        const approved = JSON.parse(fs.readFileSync(seed, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(seed, JSON.stringify({ ...approved, content: "SWAPPED" }));
      }
      const transcript = path.join(tmpDir, `rollout-x-${session}.jsonl`);
      fs.writeFileSync(transcript, "{}\n");
      const event = JSON.stringify({
        ...(JSON.parse(rt.event(session)) as Record<string, unknown>),
        permission_mode: "bypassPermissions",
        transcript_path: transcript,
      });
      return {
        reportsDir,
        generatedDir,
        run: (timeoutMs, env) =>
          runHook(configPath, event, {
            verb: rt.verb,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            env: {
              ...env,
              // Claude's auto-approval wants the session id in the hook environment too.
              ...(rt.verb === "pre-tool-use" ? { CLAUDE_CODE_SESSION_ID: session } : {}),
            },
          }),
        writePending: (name, createdAt) => {
          const file = path.join(reportsDir, name);
          fs.writeFileSync(file, JSON.stringify(pendingBody(session, createdAt)));
          return file;
        },
      };
    }

    function status(file: string): unknown {
      return (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)["approvalStatus"];
    }

    describe.each([
      ["no marker", false],
      ["after a refused marker", true],
    ] as const)("%s", (_path, refused) => {
      const session = `sess-e2e-auto-${rt.verb}-${refused ? "refused" : "nomarker"}`;

      it("control: a valid pending report of the session mints and the call is allowed", async () => {
        const { run, writePending } = await setup(session, refused);
        const report = writePending("r1.json", new Date(Date.now() - 60_000).toISOString());

        const result = run(10_000);

        expect(result.timedOut).toBe(false);
        expect(result.stderr).toMatch(/auto-approved|approved via marker/);
        expect(status(report)).toBe("approved");
      });

      it("auto-approval: a 2 MiB *.json next to a valid pending report declines (the oversized entry is skipped, never read whole)", async () => {
        const { reportsDir, run, writePending } = await setup(session, refused);
        const report = writePending("r1.json", new Date(Date.now() - 60_000).toISOString());
        fs.writeFileSync(path.join(reportsDir, "zz-big.json"), JSON.stringify({ sessionId: "sess-other" }) + OVER_CAP);

        const result = run(10_000);

        expect(result.timedOut).toBe(false);
        rt.expectBlock(result);
        expect(result.stderr).toMatch(/auto-approval declined: report invalid \(\d+ bytes, over the 1048576-byte cap/);
        expect(status(report)).toBe("pending");
      });

      it("auto-approval: an oversized NEWER report of the session declines instead of falling back to the older pending one", async () => {
        const { reportsDir, run, writePending } = await setup(session, refused);
        const older = writePending("r1.json", new Date(Date.now() - 120_000).toISOString());
        fs.writeFileSync(
          path.join(reportsDir, "r2.json"),
          JSON.stringify(pendingBody(session, new Date(Date.now() - 60_000).toISOString())) + OVER_CAP,
        );

        const result = run(10_000);

        expect(result.timedOut).toBe(false);
        rt.expectBlock(result);
        expect(result.stderr).toMatch(/auto-approval declined: report invalid \(\d+ bytes, over the 1048576-byte cap/);
        expect(status(older)).toBe("pending");
      });

      it.each(FIFO_PLANTS)(
        "auto-approval: %s named *.json with no writer declines within the bound, the pending report stays pending",
        async (_kind, plant) => {
          const { reportsDir, run, writePending } = await setup(session, refused);
          const report = writePending("r1.json", new Date(Date.now() - 60_000).toISOString());
          plant(reportsDir);
          const bound = 10_000;

          const result = run(bound);

          // A blocking open() of the FIFO would wait for a writer forever; the
          // child is killed at the bound and the run reports it as timed out.
          expect(result.timedOut).toBe(false);
          expect(result.ms).toBeLessThan(bound);
          rt.expectBlock(result);
          expect(result.stderr).toMatch(/auto-approval declined: report listing skipped 1 unreadable entry/);
          expect(status(report)).toBe("pending");
        },
        60_000,
      );

      // The consume step rewrites the report the precondition validated. A
      // report that is a symlink can be retargeted after the precondition read,
      // so the consume must not re-read the path. The window is made
      // deterministic with a preload in the hook process: every descriptor
      // open of the report path sees the regular file, and right after each
      // open the symlink is retargeted to the planted entry. The bounded reads
      // (listing, precondition) therefore validate the real report, while a
      // read by path in the consume would get the planted entry: a FIFO with
      // no writer blocks it until the kill, and an oversized swapped report
      // would be the one rewritten. The planted size is 2 MiB, a member of the
      // "over the 1 MiB cap" class.
      it.each([
        ["a FIFO with no writer", (target: string): void => {
          execFileSync("mkfifo", [target]);
        }],
        [
          "a 2 MiB swapped report",
          (target: string): void =>
            fs.writeFileSync(
              target,
              JSON.stringify({
                ...pendingBody(session, new Date(Date.now() - 30_000).toISOString()),
                currentUnderstanding: "SWAPPED",
              }) + OVER_CAP,
            ),
        ],
      ])(
        "auto-approval consume: the report symlink retargeted to %s after the precondition read still mints the validated report within the bound",
        async (_kind, plantTarget) => {
          const { reportsDir, run } = await setup(session, refused);
          const outside = path.join(tmpDir, "outside");
          fs.mkdirSync(outside);
          const real = path.join(outside, "real.json");
          fs.writeFileSync(real, JSON.stringify(pendingBody(session, new Date(Date.now() - 60_000).toISOString())));
          const planted = path.join(outside, "planted.json");
          plantTarget(planted);
          const report = path.join(reportsDir, "r1.json");
          fs.symlinkSync(real, report);
          const preload = path.join(tmpDir, "retarget-after-open.mjs");
          fs.writeFileSync(preload, RETARGET_AFTER_OPEN_PRELOAD);
          const countFile = path.join(tmpDir, "retarget-count");
          fs.writeFileSync(countFile, "");
          const bound = 10_000;

          const result = run(bound, {
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            RETARGET_COUNT_FILE: countFile,
            RETARGET_PATH: report,
            RETARGET_REAL: real,
            RETARGET_PLANTED: planted,
          });

          // At least the listing and the precondition each opened the report
          // through the preload, so the retarget window was really exercised.
          const retargets = fs.readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
          expect(retargets).toBeGreaterThanOrEqual(2);
          expect(result.timedOut).toBe(false);
          expect(result.ms).toBeLessThan(bound);
          expect(result.stderr).toMatch(/auto-approved/);
          // The rename put the rewritten validated report in place of the symlink.
          expect(fs.lstatSync(report).isFile()).toBe(true);
          const consumed = JSON.parse(fs.readFileSync(report, "utf8")) as Record<string, unknown>;
          expect(consumed["approvalStatus"]).toBe("approved");
          expect(consumed["currentUnderstanding"]).toBe("the auto path under test");
        },
        60_000,
      );

      // The consume step's temp file. Its name used to be `.<base>.<pid>.<ms>.tmp`
      // opened with plain "w": a FIFO planted at the name hung the hook (the
      // call then proceeds as a non-blocking hook error), a symlink was
      // written through. The name is random and opened with O_EXCL now.
      it("auto-approval consume: FIFOs planted at every former pid.millisecond temp name do not hang the hook, and the report is still minted", async () => {
        const { reportsDir, run, writePending } = await setup(session, refused);
        const report = writePending("r1.json", new Date(Date.now() - 60_000).toISOString());
        const preload = path.join(tmpDir, "spray.mjs");
        fs.writeFileSync(preload, SPRAY_PRELOAD);
        const countFile = path.join(tmpDir, "spray-count");
        const bound = 10_000;

        const result = run(bound, {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          SPRAY_DIR: reportsDir,
          SPRAY_BASE: "r1.json",
          SPRAY_COUNT_FILE: countFile,
        });

        // The spray really ran: thousands of FIFOs sit at the old names.
        expect(Number(fs.readFileSync(countFile, "utf8"))).toBeGreaterThan(3000);
        expect(result.timedOut).toBe(false);
        expect(result.ms).toBeLessThan(bound);
        expect(result.stderr).toMatch(/auto-approved/);
        expect(status(report)).toBe("approved");
        // Nothing the hook did touched the planted names.
        const fifos = fs.readdirSync(reportsDir).filter((n) => /^\.r1\.json\.\d+\.\d+\.tmp$/.test(n));
        expect(fifos.length).toBeGreaterThan(3000);
      }, 60_000);

      it.each([
        ["a FIFO with no reader", "fifo"],
        ["a symlink to a file outside the reports directory", "symlink"],
        ["a regular file", "file"],
      ] as const)(
        "auto-approval consume: %s planted at the chosen temp name declines within the bound, the report stays pending, nothing is written through or removed",
        async (_label, kind) => {
          const { reportsDir, run, writePending } = await setup(session, refused);
          const report = writePending("r1.json", new Date(Date.now() - 60_000).toISOString());
          const outside = path.join(tmpDir, "outside-victim.txt");
          fs.writeFileSync(outside, "victim\n");
          const preload = path.join(tmpDir, "plant-at-chosen-name.mjs");
          fs.writeFileSync(preload, PLANT_AT_CHOSEN_NAME_PRELOAD);
          const recordFile = path.join(tmpDir, "plant-record");
          const bound = 10_000;

          const result = run(bound, {
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            PLANT_DIR: reportsDir,
            PLANT_BASE: "r1.json",
            PLANT_KIND: kind,
            PLANT_OUTSIDE: outside,
            PLANT_RECORD_FILE: recordFile,
          });

          // The plant really happened, at a name inside the reports directory.
          const plantedPath = fs.readFileSync(recordFile, "utf8");
          expect(path.dirname(plantedPath)).toBe(reportsDir);
          // A blocking open() of the FIFO would wait for a reader forever; the
          // child would be killed at the bound and reported as timed out.
          expect(result.timedOut).toBe(false);
          expect(result.ms).toBeLessThan(bound);
          rt.expectBlock(result);
          expect(result.stderr).toMatch(/auto-approval declined: could not consume the report \(.*EEXIST/);
          expect(status(report)).toBe("pending");
          // Not written through the link, and the planted entry was not ours to remove.
          expect(fs.readFileSync(outside, "utf8")).toBe("victim\n");
          const entry = fs.lstatSync(plantedPath);
          expect(kind === "fifo" ? entry.isFIFO() : kind === "symlink" ? entry.isSymbolicLink() : entry.isFile()).toBe(true);
          if (kind === "file") expect(fs.readFileSync(plantedPath, "utf8")).toBe("planted\n");
        },
        60_000,
      );
    });
  },
);

// The parse-error log lookup runs on the no-marker path (no persisted report
// at all for the session) and reads the sibling `parse-errors/` directory,
// which the agent can write too. The log is read through the same bounded
// reader: an oversized log and a FIFO are skipped, so the block is the plain
// no-report one, and a regular log is still surfaced (the control).
describe.each(E2E_RUNTIMES)(
  "pack hook $verb: subprocess E2E (parse-error log lookup on the no-marker path)",
  (rt) => {
    const session = `sess-e2e-parse-error-${rt.verb}`;
    // A header naming a malformed section makes the block carry this sentence
    // (the lookup ran and read the log); a skipped log leaves it out.
    const NOTE = "Your previous Understanding Report attempt had malformed sections";

    function setup(): { parseErrorsDir: string; run: (timeoutMs?: number) => ReturnType<typeof runHook> } {
      const configPath = path.join(tmpDir, "harness.yaml");
      fs.writeFileSync(configPath, MANIFEST_WITH_PACK, "utf8");
      fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });
      // The hook looks next to the reports directory: <reports-parent>/parse-errors.
      const parseErrorsDir = path.join(tmpDir, "parse-errors");
      fs.mkdirSync(parseErrorsDir, { recursive: true });
      const event = rt.event(session);
      return {
        parseErrorsDir,
        run: (timeoutMs) => runHook(configPath, event, { verb: rt.verb, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
      };
    }

    const logBody = (padding: string): string =>
      `${JSON.stringify({ sessionId: session, message: "report did not parse", malformedSections: ["priorArt"] })}\n--- raw ---\nthe agent's last message${padding}`;

    it("control: a regular parse-error log of the session is surfaced in the block", () => {
      const { parseErrorsDir, run } = setup();
      fs.writeFileSync(path.join(parseErrorsDir, "2026-10-01T10-00-00-000Z.log"), logBody(""));

      const result = run(10_000);

      rt.expectBlock(result);
      expect(result.stdout + result.stderr).toContain(NOTE);
    });

    it("a 2 MiB parse-error log is skipped: the plain no-report block, within the bound", () => {
      const { parseErrorsDir, run } = setup();
      fs.writeFileSync(path.join(parseErrorsDir, "2026-10-01T10-00-00-000Z.log"), logBody(" ".repeat(2 * 1024 * 1024)));

      const result = run(10_000);

      expect(result.timedOut).toBe(false);
      rt.expectBlock(result);
      expect(result.stdout + result.stderr).not.toContain(NOTE);
    });

    it.each([
      ["a FIFO", (dir: string): void => {
        execFileSync("mkfifo", [path.join(dir, "zz-fifo.log")]);
      }],
      [
        "a symlink to a FIFO",
        (dir: string): void => {
          const pipe = path.join(tmpDir, "outside-log-pipe");
          execFileSync("mkfifo", [pipe]);
          fs.symlinkSync(pipe, path.join(dir, "zz-link.log"));
        },
      ],
    ] as const)(
      "%s named *.log with no writer is skipped: the plain no-report block, within the bound",
      (_kind, plant) => {
        const { parseErrorsDir, run } = setup();
        plant(parseErrorsDir);
        const bound = 10_000;

        const result = run(bound);

        expect(result.timedOut).toBe(false);
        expect(result.ms).toBeLessThan(bound);
        rt.expectBlock(result);
        expect(result.stdout + result.stderr).not.toContain(NOTE);
      },
      60_000,
    );
  },
);

// The shared marker reader used to lstat the path and then readFileSync it by
// name (tracker task 46434fbf). A writer that swapped the regular marker for a
// FIFO between the two made the read block until the runtime's hook budget
// ran out, which the runtime treats as an allow. This preload makes that swap
// deterministic: the first time the hook process opens or reads the marker
// path by name, the regular file is replaced by a FIFO with no writer first,
// which is exactly where the old lstat-then-read left its window. A reader
// that opens once (O_NONBLOCK) and checks the descriptor's type refuses the
// FIFO at once; one that reads by path (or opens without O_NONBLOCK) blocks
// until the child is killed at the bound. The count file records the swap so
// a case cannot pass by never exercising it.
const SWAP_MARKER_FOR_FIFO_PRELOAD = `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const target = process.env.FIFO_SWAP_PATH;
const countFile = process.env.FIFO_SWAP_COUNT_FILE;
const openSync = fs.openSync;
const readFileSync = fs.readFileSync;
let swapped = false;
function swap(p) {
  if (swapped || String(p) !== target) return;
  swapped = true;
  fs.rmSync(target);
  const made = spawnSync("mkfifo", [target]);
  if (made.status !== 0) throw new Error("mkfifo failed");
  fs.appendFileSync(countFile, "swap\\n");
}
fs.openSync = function (p, ...rest) {
  swap(p);
  return openSync.call(this, p, ...rest);
};
fs.readFileSync = function (p, ...rest) {
  swap(p);
  return readFileSync.call(this, p, ...rest);
};
syncBuiltinESMExports();
`;

describe.skipIf(process.platform === "win32").each(E2E_RUNTIMES)(
  "pack hook $verb: subprocess E2E (the approval marker swapped for a FIFO after the last check)",
  (rt) => {
    it(
      "a valid marker allows; the same marker swapped for a FIFO with no writer at the read blocks within the bound",
      async () => {
        const session = `sess-e2e-marker-swap-${rt.verb}`;
        const configPath = path.join(tmpDir, "harness.yaml");
        fs.writeFileSync(configPath, MANIFEST_WITH_PACK, "utf8");
        const reportsDir = path.join(tmpDir, "reports");
        const generatedDir = path.join(tmpDir, "harness.generated");
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(
          path.join(reportsDir, "r1.json"),
          JSON.stringify({
            sessionId: session,
            approvalStatus: "pending",
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            content: "the understanding the operator reviewed",
          }),
        );
        const approve = await approveUnderstanding({
          manifest: parseManifest({ version: 1 }),
          session,
          reportsDir,
          generatedDir,
          ledgerAdd: async () => ({ ok: true }),
        });
        expect(approve.marker.ok).toBe(true);
        const markerPath = approvalMarkerPathFor(generatedDir, session);
        expect(fs.lstatSync(markerPath).isFile()).toBe(true);
        const event = rt.event(session);

        // Control: the untouched marker allows through the built CLI.
        rt.expectAllow(runHook(configPath, event, { verb: rt.verb }));

        const preload = path.join(tmpDir, "swap-marker-for-fifo.mjs");
        fs.writeFileSync(preload, SWAP_MARKER_FOR_FIFO_PRELOAD);
        const countFile = path.join(tmpDir, "fifo-swap-count");
        fs.writeFileSync(countFile, "");
        const bound = 10_000;

        const swapped = runHook(configPath, event, {
          verb: rt.verb,
          timeoutMs: bound,
          env: {
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            FIFO_SWAP_PATH: markerPath,
            FIFO_SWAP_COUNT_FILE: countFile,
          },
        });

        // The swap really happened, in the process that decided.
        expect(fs.readFileSync(countFile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
        expect(fs.lstatSync(markerPath).isFIFO()).toBe(true);
        // A blocking read would wait for a writer forever; the child is killed
        // at the bound and the run reports it as timed out.
        expect(swapped.timedOut).toBe(false);
        expect(swapped.ms).toBeLessThan(bound);
        rt.expectBlock(swapped);
        // Refused by the descriptor's type: the marker reads as absent. A
        // reader that skipped the type check would read the FIFO as an empty
        // body, which blocks too, but as a forged marker.
        expect(swapped.stderr).toMatch(/no approval marker for session/);
        expect(swapped.stderr).not.toMatch(/forged\/unsigned marker rejected/);
      },
      60_000,
    );
  },
);

// The same fail-open through a regular file: a sparse multi-gigabyte file at
// the marker path made the old read take longer than the hook budget, and the
// runtime treats a hook that runs out of time as an allow. The reader now refuses a file over its size
// cap from the descriptor's size, without reading it. This case is the
// end-to-end smoke (a block, within the bound, through both built hooks).
describe.skipIf(process.platform === "win32").each(E2E_RUNTIMES)(
  "pack hook $verb: subprocess E2E (the approval marker replaced by a huge sparse file)",
  (rt) => {
    it(
      "a valid marker allows; the same path holding a 2 GiB sparse file blocks within the bound as unreadable",
      async () => {
        const session = `sess-e2e-marker-sparse-${rt.verb}`;
        const configPath = path.join(tmpDir, "harness.yaml");
        fs.writeFileSync(configPath, MANIFEST_WITH_PACK, "utf8");
        const reportsDir = path.join(tmpDir, "reports");
        const generatedDir = path.join(tmpDir, "harness.generated");
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(
          path.join(reportsDir, "r1.json"),
          JSON.stringify({
            sessionId: session,
            approvalStatus: "pending",
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            content: "the understanding the operator reviewed",
          }),
        );
        const approve = await approveUnderstanding({
          manifest: parseManifest({ version: 1 }),
          session,
          reportsDir,
          generatedDir,
          ledgerAdd: async () => ({ ok: true }),
        });
        expect(approve.marker.ok).toBe(true);
        const markerPath = approvalMarkerPathFor(generatedDir, session);
        const event = rt.event(session);

        // Control: the untouched marker allows through the built CLI.
        rt.expectAllow(runHook(configPath, event, { verb: rt.verb }));

        fs.rmSync(markerPath);
        fs.writeFileSync(markerPath, "");
        fs.truncateSync(markerPath, 2 * 1024 * 1024 * 1024);
        const bound = 10_000;
        const huge = runHook(configPath, event, { verb: rt.verb, timeoutMs: bound });

        expect(huge.timedOut).toBe(false);
        expect(huge.ms).toBeLessThan(bound);
        rt.expectBlock(huge);
        // Refused as unreadable, which fails closed: the marker never counts as
        // a (forged) marker body. The size refusal itself is pinned in
        // tests/io/read-regular-file.test.ts, where the read count is visible.
        expect(huge.stderr).toMatch(/no approval marker for session/);
        expect(huge.stderr).not.toMatch(/forged\/unsigned marker rejected/);
      },
      60_000,
    );
  },
);
