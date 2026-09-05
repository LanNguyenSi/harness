import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DELEGATE_LEDGER_SOURCE,
  DEFAULT_DELEGATION_TTL_SECONDS,
  NO_BINDING_MESSAGE,
  delegationLedgerFactFor,
  issueDelegation,
} from "../../src/cli/delegate/index.js";
import { buildProgram, run } from "../../src/cli/index.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  approvalMarkerPathFor,
  delegationMarkerPathFor,
  delegationReportPathFor,
  hashDelegationCwd,
  REPORTS_DIR_ENV,
  verifyDelegation,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  getOrCreateSigningKey,
  signingKeyPathFor,
} from "../../src/runtime/approval-signing.js";
import { readPendingApproval, writePendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Slice 3 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks 37ad0b05), acceptance criterion 1: `harness delegate` /
// `issueDelegation`. Every fixture below uses a real temp generatedDir
// and, where a valid parent marker is needed, the real operator-side
// signing key and `writeApprovalMarker`, so a "valid" fixture here is
// valid in exactly the sense the child's own hook (a later slice) will
// check.

const CHILD = "11111111-1111-4111-8111-111111111111";
const PARENT = "parent-session-0001";

/**
 * A real, parseable Understanding Report: the exact 5-bullet shape
 * `@lannguyensi/understanding-gate`'s fast_confirm prompt emits (mirrors
 * `approve-stdin-report.test.ts`'s `FAST_CONFIRM_BULLETS`). Round-2 fix
 * (agent-tasks 49d1ee41): `issueDelegation` now validates a `--report`
 * file's content with the SAME parser `persistStdinReport` applies, so
 * every `--report` fixture in this suite that expects staging to SUCCEED
 * needs content that actually parses; the arbitrary JSON blob these
 * fixtures used before this fix only ever exercised the copy/mode/
 * conflict mechanics, never validity.
 */
const VALID_REPORT_MARKDOWN = [
  "- I understood the task as: bind a launcher-supplied report by content and path.",
  "- I will do: stage the conventional copy and let the child's hook read it back.",
  "- I will not touch: the transcript-scan channel.",
  "- I will verify by: issuing a delegation and verifying it end to end.",
  "- Assumptions: the file exists and is readable at delegation time.",
].join("\n");

/**
 * A full, all-sections Understanding Report (the grill_me / `full` prompt
 * shape), used by the round-3 stage-time mode-parity tests below. Unlike
 * {@link VALID_REPORT_MARKDOWN} (fast_confirm's relaxed 5-bullet shape,
 * which only parses when the gap-fill default is `fast_confirm`), every
 * section required by the STRICT schema is present, so this fixture
 * parses under either mode's validator regardless of which one the
 * caller's `defaults.mode` resolves to.
 */
const FULL_REPORT_MARKDOWN = [
  "# Understanding Report",
  "",
  "**Current Understanding**",
  "",
  "The stage-time parse must use the pack's configured mode, not a hardcoded one.",
  "",
  "**Intended Outcome**",
  "",
  "A short-form report is refused at stage time under grill_me, before anything is signed.",
  "",
  "**Derived Todos**",
  "",
  "- mirror the hook's own mode resolution at stage time",
  "",
  "**Acceptance Criteria**",
  "",
  "- a fast_confirm-shaped report is refused under a grill_me-configured pack",
  "",
  "**Assumptions**",
  "",
  "- the pack's declared config is the same one the child hook resolves",
  "",
  "**Open Questions**",
  "",
  "- none",
  "",
  "**Out Of Scope**",
  "",
  "- the transcript-scan channel",
  "",
  "**Risks**",
  "",
  "- a stale gap-fill default reintroducing the mismatch",
  "",
  "**Verification Plan**",
  "",
  "- vitest over issueDelegation with an explicit mode-declaring manifest",
  "",
  "**Prior Art**",
  "",
  "- mirrors the child hook's toPackageMode(resolveMode(declared).mode) call",
].join("\n");

/**
 * {@link FULL_REPORT_MARKDOWN} with an explicit `## Metadata` block
 * declaring its OWN mode. The parser's merge order gives an inline
 * Metadata declaration precedence over the caller-supplied gap-fill
 * default for schema-validator selection (`understanding-gate`'s
 * `parseReport`, `merged["mode"] ?? defaults.mode`), so this fixture
 * stages successfully under a manifest configured for the OPPOSITE mode.
 */
const FULL_REPORT_MARKDOWN_DECLARING_FAST_CONFIRM = [
  "# Understanding Report",
  "",
  "**Metadata**",
  "",
  "mode: fast_confirm",
  "",
  ...FULL_REPORT_MARKDOWN.split("\n").slice(2),
].join("\n");

let tmp: string;
let generatedDir: string;
let childCwd: string;
// Env hygiene (approve-understanding.test.ts's own top-level pattern):
// without this, a real $CLAUDE_CODE_SESSION_ID exported into the test
// runner's own shell (e.g. this very session, running under Claude
// Code) silently supplies a parent session id the "unresolved" fixtures
// below are specifically trying to rule out.
let savedClaudeCode: string | undefined;
let savedClaude: string | undefined;
let savedCodex: string | undefined;

function fakeLedger(): {
  calls: { sessionId: string; content: string }[];
  ledgerAdd: (sessionId: string, content: string) => Promise<{ ok: true }>;
} {
  const calls: { sessionId: string; content: string }[] = [];
  return {
    calls,
    ledgerAdd: async (sessionId: string, content: string) => {
      calls.push({ sessionId, content });
      return { ok: true };
    },
  };
}

/** Write a validly-signed parent approval marker. */
function approveParent(overrides: { approvedAt?: string } = {}): void {
  writeApprovalMarker(generatedDir, PARENT, {
    approvedAt: overrides.approvedAt ?? new Date().toISOString(),
    approvedBy: "test-operator",
    reportContentHash: null,
  });
}

/** Write a hand-rolled, unsigned marker at the parent's approval path (forgery). */
function forgeParentMarker(): void {
  const filePath = approvalMarkerPathFor(generatedDir, PARENT);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ approvedAt: new Date().toISOString(), approvedBy: "attacker" })}\n`,
  );
}

function manifestWithMaxAge(maxAge: string): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { max_age: maxAge } },
      },
    ],
  });
}

/**
 * `{ mode: session, max_age }` (task 496660c5 review finding): `parseApprovalLifecycle`'s mode-session branch used to return
 * before `max_age` was ever parsed, so this config silently kept no TTL
 * at all. `issueDelegation` is the second consumer of the shared parser
 * (the gate's own `checkOperatorApprovalMarkers` is the first); the fix
 * reaches its parent-marker check, its default `--ttl`, and its
 * explicit-`--ttl` ceiling the same way it reaches the gate.
 */
function manifestWithModeSessionMaxAge(maxAge: string): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { mode: "session", max_age: maxAge } },
      },
    ],
  });
}

/** A manifest declaring only `config.mode`, for the stage-time mode-parity tests below. */
function manifestWithMode(mode: string): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        config: { mode },
      },
    ],
  });
}

/** Manifest declaring a `grounding-mcp` server that runs `scriptPath` (real `writeLedgerTag` path, no `ledgerAdd` override). */
function manifestWithGroundingMcp(scriptPath: string): Manifest {
  return parseManifest({
    version: 1,
    tools: { mcp: [{ name: "grounding-mcp", command: [scriptPath] }] },
  });
}

/**
 * A minimal MCP stub (fake-script transport approach, mirroring
 * tests/runtime/ledger-add.test.ts) that captures the `ledger_add`
 * call's `arguments` (including `source`) to `captureFile` before
 * responding ok. Used to exercise the real `writeLedgerTag` ->
 * `addLedgerFact` path end to end and observe its `source` argument,
 * rather than stubbing it away at the `ledgerAdd` level the way every
 * other test in this file does (the M2 mutation probe: dropping
 * `writeLedgerTag`'s 5th argument does not turn any `ledgerAdd`-stubbed
 * test red, since that override bypasses `writeLedgerTag` entirely).
 */
function makeCapturingLedgerServer(dir: string, captureFile: string): string {
  const file = path.join(dir, "ledger-server.js");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("fs");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) { msg = null; }
      if (msg) {
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
        } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_add") {
          fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(msg.params.arguments));
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
        }
      }
    }
    nl = buf.indexOf("\\n");
  }
});
`,
    "utf8",
  );
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegate-"));
  generatedDir = path.join(tmp, "harness.generated");
  childCwd = path.join(tmp, "child-cwd");
  fs.mkdirSync(childCwd, { recursive: true });
  getOrCreateSigningKey(generatedDir);
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
});

describe("issueDelegation - refusals", () => {
  it("refuses without parent marker (mutation probe M1 target)", async () => {
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("parent-marker-missing");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses with a forged (unsigned) parent marker", async () => {
    forgeParentMarker();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("parent-marker-forged");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses with an expired parent marker", async () => {
    approveParent({ approvedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithMaxAge("1h"),
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("parent-marker-expired");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses without binding, neither --cwd nor --task (mutation probe M3 target)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("no-binding");
    expect(result.detail).toBe(NO_BINDING_MESSAGE);
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses when --child-session is not a UUID", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: "not-a-uuid",
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("invalid-child-session");
  });

  it("refuses when the operator signing key is absent, and creates no key (checked before the parent marker, since verifying a marker would otherwise self-heal a missing key)", async () => {
    // A FRESH generatedDir that never had `getOrCreateSigningKey` called
    // against it (unlike the shared `generatedDir`, whose key the
    // top-level beforeEach already created). No parent marker exists
    // here either, which is exactly the real-world case: nothing could
    // ever have been validly signed in a generatedDir with no key.
    const bareTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegate-nokey-"));
    const bareGeneratedDir = path.join(bareTmp, "harness.generated");
    const { ledgerAdd } = fakeLedger();
    try {
      const result = await issueDelegation({
        childSessionId: CHILD,
        cwd: childCwd,
        parentSessionId: PARENT,
        generatedDir: bareGeneratedDir,
        ledgerAdd,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("signing-key-absent");
      expect(fs.existsSync(signingKeyPathFor(bareGeneratedDir))).toBe(false);
      expect(fs.existsSync(delegationMarkerPathFor(bareGeneratedDir, CHILD))).toBe(false);
      expect(fs.existsSync(bareGeneratedDir)).toBe(false);
    } finally {
      fs.rmSync(bareTmp, { recursive: true, force: true });
    }
  });

  it("refuses when --parentSessionId cannot be resolved (no flag, no env, no staged .pending-approval)", async () => {
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("parent-session-unresolved");
  });

  it("refuses when --report points at a file that does not exist", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath: path.join(tmp, "does-not-exist.md"),
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("report-unreadable");
  });

  it("refuses at STAGE time when --report points at a file that is readable but does not parse as an Understanding Report, and stages nothing (round-2 fix, agent-tasks 49d1ee41)", async () => {
    // Before this fix an unparseable `--report` file was only hashed,
    // never validated: it would be staged, signed, and adopted by the
    // child hook, which would then fail to parse it at mint time
    // AFTER already recording the adoption, permanently burning that
    // child session id, with no cheap retry (a corrected `--report`
    // rerun would hit `report-conflict` against the garbage already
    // staged). Refusing here, before anything is written, avoids all of
    // that.
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "unparseable-report.md");
    fs.writeFileSync(reportPath, "not an understanding report at all, just prose\n");

    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("report-unparseable");
    expect(result.detail).toMatch(/did not parse/);

    // Nothing was staged: no conventional file, no delegation marker.
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    expect(fs.existsSync(conventionalPath)).toBe(false);
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses at STAGE time a fast_confirm-shaped --report when the applied pack declares mode: grill_me, and stages nothing (round-3 fix, agent-tasks 49d1ee41)", async () => {
    // Before this fix the stage-time parse always gap-filled
    // `mode: "fast_confirm"`, regardless of what the pack's own config
    // declared. Every shipped init template sets `mode: grill_me`, so a
    // short-form report like this one used to pass staging here and only
    // fail later, at the child hook's persist-time parse (which DOES
    // resolve the pack's real mode): after the adoption ledger had
    // already recorded the report's content hash as spent, with no cheap
    // retry. The fix mirrors the hook's own resolution
    // (`toPackageMode(resolveMode(declared).mode)`) at stage time too, so
    // this now refuses up front, before anything is signed or staged.
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "fast-confirm-report.md");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);

    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      manifest: manifestWithMode("grill_me"),
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("report-unparseable");
    expect(result.detail).toMatch(/did not parse/);

    // Nothing was staged: no conventional file, no delegation marker, no
    // adoption-ledger entry spent.
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    expect(fs.existsSync(conventionalPath)).toBe(false);
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("stages a --report that declares its OWN mode in its Metadata block, unaffected by the applied pack's configured mode (agent-tasks 49d1ee41)", async () => {
    // The pack is configured for grill_me, but the report explicitly
    // declares `mode: fast_confirm` in its own `## Metadata` block. The
    // parser's merge order gives that declaration precedence over the
    // caller-supplied gap-fill default (`understanding-gate`'s
    // `parseReport`: `merged["mode"] ?? defaults.mode`), so staging must
    // still succeed: mirroring the pack's configured mode at stage time
    // (this task's own fix) only changes the GAP-FILL default a report
    // with no declaration of its own falls back to, never a report that
    // states its mode itself.
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "declares-own-mode-report.md");
    fs.writeFileSync(reportPath, FULL_REPORT_MARKDOWN_DECLARING_FAST_CONFIRM);

    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      manifest: manifestWithMode("grill_me"),
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success (the report declares its own mode)");

    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe(
      FULL_REPORT_MARKDOWN_DECLARING_FAST_CONFIRM,
    );
  });

  it("stages a grill_me-shaped --report when the applied pack declares mode: grill_me (agent-tasks 49d1ee41)", async () => {
    // The positive control for the round-3 fix: a report that actually
    // matches the pack's configured mode stages successfully. Mutation
    // probe A (task brief): reverting the stage-time mode to the
    // hardcoded `"fast_confirm"` literal does not turn THIS test red on
    // its own (a full-shaped report parses under either validator); it
    // turns the grill_me-refusal test above red instead, which is the
    // discriminating probe.
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "grill-me-report.md");
    fs.writeFileSync(reportPath, FULL_REPORT_MARKDOWN);

    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      manifest: manifestWithMode("grill_me"),
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success (the report matches the configured mode)");

    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe(FULL_REPORT_MARKDOWN);
  });

  it("refuses --task 'a=b' (an unsafe delegation-segment delimiter) with reason invalid-task (L1)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      taskId: "a=b",
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("invalid-task");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses --task '-' (the reserved unbound literal) with reason invalid-task (L1)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      taskId: "-",
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("invalid-task");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses an empty --cwd ('') with reason invalid-cwd, alongside the no-binding check (L3)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: "",
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("invalid-cwd");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses --ttl 0s with reason invalid-ttl, before minting a dead delegation (L2, mutation probe S2 target)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ttlSeconds: 0,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("invalid-ttl");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses a negative --ttl with reason invalid-ttl (L2)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ttlSeconds: -30,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("invalid-ttl");
  });

  it("refuses an explicit --ttl above the pack's approval_lifecycle.max_age with reason ttl-above-max-age (L4, mutation probe S3 target)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithMaxAge("1h"),
      ttlSeconds: 2 * 60 * 60,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("ttl-above-max-age");
    expect(result.detail).toContain("3600");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses an explicit --ttl above the 24h default ceiling when the pack sets no approval_lifecycle.max_age (L4)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: parseManifest({ version: 1 }),
      ttlSeconds: 25 * 60 * 60,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("ttl-above-max-age");
    expect(result.detail).toContain("86400");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });
});

describe("issueDelegation - happy path", () => {
  it("writes to .delegations/, nothing to .approvals/, and verifies via verifyDelegation with the same cwd", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const before = fs.existsSync(path.join(generatedDir, ".approvals", CHILD));
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(before).toBe(false);
    expect(result.filePath).toBe(delegationMarkerPathFor(generatedDir, CHILD));
    expect(fs.existsSync(result.filePath)).toBe(true);
    // Nothing landed under .approvals/ for the child.
    expect(fs.existsSync(path.join(generatedDir, ".approvals", CHILD))).toBe(false);
    expect(result.parentSessionId).toBe(PARENT);
    expect(result.childSessionId).toBe(CHILD);

    const verified = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected verifyDelegation to accept the freshly issued delegation");
    expect(verified.parentSessionId).toBe(PARENT);
  });

  it("calls the injected ledgerAdd with the understanding-delegated:<child>:<parent> fact content", async () => {
    approveParent();
    const { calls, ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.ledgerFact.written).toBe(true);
    expect(calls).toEqual([
      { sessionId: CHILD, content: delegationLedgerFactFor(CHILD, PARENT) },
    ]);
    expect(calls[0]!.content).toBe(`understanding-delegated:${CHILD}:${PARENT}`);
  });

  it("writes the ledger fact via the real writeLedgerTag -> addLedgerFact path, with source harness-delegate-cli, when ledgerAdd is omitted and the manifest declares a grounding MCP (mutation probe M2 target)", async () => {
    approveParent();
    const captureFile = path.join(tmp, "captured-ledger-call.json");
    const scriptPath = makeCapturingLedgerServer(tmp, captureFile);
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithGroundingMcp(scriptPath),
      // Deliberately no `ledgerAdd`: that override bypasses
      // `writeLedgerTag` entirely, which is exactly why every other
      // ledgerAdd-stubbed test in this file cannot observe the `source`
      // argument. This test exercises the real
      // findGroundingMcp + addLedgerFact path instead.
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.ledgerFact.written).toBe(true);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8")) as {
      sessionId: string;
      type: string;
      content: string;
      source: string;
    };
    expect(captured.sessionId).toBe(CHILD);
    expect(captured.content).toBe(delegationLedgerFactFor(CHILD, PARENT));
    expect(captured.source).toBe("harness-delegate-cli");
    expect(captured.source).toBe(DEFAULT_DELEGATE_LEDGER_SOURCE);
  });

  it("mints the delegation but marks the ledger fact unwritten, naming the load cause, when the manifest cannot be loaded (manifestLoadError branch)", async () => {
    approveParent();
    const badConfig = path.join(tmp, "broken-harness.yaml");
    fs.writeFileSync(badConfig, "version: 1\nbroken: [unclosed\n");
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      configPath: badConfig,
      // Deliberately no `manifest` injection and no `ledgerAdd`: forces
      // `loadDeclaredUnderstandingPack` to actually attempt (and fail)
      // the load, landing in the `manifestLoadError` branch.
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success (manifest load failure is audit-only)");
    expect(result.ledgerFact.written).toBe(false);
    expect(result.ledgerFact.reason).toContain("manifest unreadable (");
    expect(result.ledgerFact.reason).toContain("); skipped ledger write");
    expect(result.ledgerFact.reason).toMatch(/broken-harness\.yaml|not valid YAML/);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("--ttl 30m sets expires = now + 1800s", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const now = new Date("2026-08-28T00:00:00.000Z");
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ttlSeconds: 30 * 60,
      now,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.expiresAt).toBe(new Date(now.getTime() + 1800 * 1000).toISOString());
  });

  it("defaults the ttl from the pack's approval_lifecycle.max_age when set", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const now = new Date("2026-08-28T00:00:00.000Z");
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithMaxAge("2h"),
      now,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.expiresAt).toBe(new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString());
  });

  it(`defaults the ttl to ${DEFAULT_DELEGATION_TTL_SECONDS}s (1h) when the pack sets no max_age`, async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const now = new Date("2026-08-28T00:00:00.000Z");
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: parseManifest({ version: 1 }),
      now,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.expiresAt).toBe(
      new Date(now.getTime() + DEFAULT_DELEGATION_TTL_SECONDS * 1000).toISOString(),
    );
  });

  it("--report copies the file to the conventional harness.generated/.delegation-reports/<child-sid>.md location (mode 0600), binds both hashes to THAT path, and a copy at a non-conventional path fails path verification", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      // `VALID_REPORT_MARKDOWN` is fast_confirm-shaped (5 bullets); this
      // test is about the copy/hash/verify mechanics, not mode matching,
      // so it declares the fixture's own shape explicitly rather than
      // riding the no-manifest DEFAULT_MODE (grill_me), which the
      // fixture would fail to parse against (round-3 fix, agent-tasks
      // 49d1ee41: stage-time validation now uses the resolved pack mode,
      // same as the child hook's persist-time validation).
      manifest: manifestWithMode("fast_confirm"),
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");

    // The conventional copy exists, carries the same bytes as the
    // operator's original file, and is mode 0600 (agent-tasks 49d1ee41,
    // AC1: "copy the operator's file there, mode 0600").
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    expect(fs.existsSync(conventionalPath)).toBe(true);
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe(VALID_REPORT_MARKDOWN);
    expect(fs.statSync(conventionalPath).mode & 0o777).toBe(0o600);

    // The delegation binds the CONVENTIONAL path's hash, not the
    // operator's original --report argument: the child's hook has no
    // channel to learn that argument, only the conventional path it can
    // derive itself from the child session id.
    const okVerify = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
      launcherReportPath: conventionalPath,
    });
    expect(okVerify.ok).toBe(true);
    if (!okVerify.ok) throw new Error("expected the conventional-path report to verify");
    expect(okVerify.reportPathHash).toBe(hashDelegationCwd(conventionalPath));

    // Verifying against a DIFFERENT path (even one with identical bytes)
    // still fails path verification: WHERE the parent put the report is
    // part of what was signed, not just what it contains.
    const movedPath = path.join(tmp, "moved-report.json");
    fs.copyFileSync(conventionalPath, movedPath);
    const movedVerify = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
      launcherReportPath: movedPath,
    });
    expect(movedVerify.ok).toBe(false);
    if (movedVerify.ok) throw new Error("expected the moved-copy report to fail verification");
    expect(movedVerify.reason).toBe("report_path_mismatch");
  });

  it("--report refuses when the conventional path holds a symlink, leaving the link and its target untouched", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(conventionalPath), { recursive: true });
    const target = path.join(tmp, "symlink-target.md");
    fs.writeFileSync(target, "untouched target\n");
    fs.symlinkSync(target, conventionalPath);

    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      manifest: manifestWithMode("fast_confirm"),
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("report-conflict");
    // The link is neither followed nor replaced, and its target is not written.
    expect(fs.lstatSync(conventionalPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("untouched target\n");
  });

  it("--report refuses to silently overwrite a DIFFERENT report already staged at the conventional path for the same child session", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(conventionalPath), { recursive: true });
    fs.writeFileSync(conventionalPath, '{"mode":"already-staged"}\n', { mode: 0o600 });

    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      // See the mode-shape note on the preceding test.
      manifest: manifestWithMode("fast_confirm"),
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("report-conflict");
    // The already-staged file is untouched, not clobbered.
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe('{"mode":"already-staged"}\n');
    // No delegation was minted from a half-completed report stage.
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("--report is idempotent when the SAME content is already staged at the conventional path (re-delegating the same child with the same report)", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(conventionalPath), { recursive: true });
    fs.writeFileSync(conventionalPath, VALID_REPORT_MARKDOWN, { mode: 0o600 });

    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      // See the mode-shape note two tests up.
      manifest: manifestWithMode("fast_confirm"),
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success (identical content is not a conflict)");
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe(VALID_REPORT_MARKDOWN);
  });

  it("--report brings a pre-existing IDENTICAL conventional file to mode 0600 on restage, even though nothing is written", async () => {
    // Round-2 fix: the identical-restage branch used to leave the mode
    // as-is, while the pack doc promises 0600 for the conventional copy
    // unconditionally. A pre-existing file at a looser mode (left by
    // something other than this verb) must still end at 0600.
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(conventionalPath), { recursive: true });
    fs.writeFileSync(conventionalPath, VALID_REPORT_MARKDOWN, { mode: 0o644 });
    expect(fs.statSync(conventionalPath).mode & 0o777).toBe(0o644);

    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      // See the mode-shape note above.
      manifest: manifestWithMode("fast_confirm"),
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success (identical content is not a conflict)");
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe(VALID_REPORT_MARKDOWN);
    expect(fs.statSync(conventionalPath).mode & 0o777).toBe(0o600);
  });

  it("binds by --task alone (no --cwd) and verifyDelegation accepts the matching task with no cwd offered", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      taskId: "37ad0b05",
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const verified = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: null,
      taskId: "37ad0b05",
    });
    expect(verified.ok).toBe(true);
  });

  it("degrades the ledger write to a warning (never a refusal) when it fails", async () => {
    approveParent();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      ledgerAdd: async () => ({ ok: false, reason: "grounding-mcp unreachable" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success (ledger failure is audit-only)");
    expect(result.ledgerFact).toEqual({
      written: false,
      reason: "grounding-mcp unreachable",
    });
    expect(fs.existsSync(result.filePath)).toBe(true);
  });
});

describe("issueDelegation under { mode: session, max_age } (task 496660c5 review finding)", () => {
  // `parseApprovalLifecycle`'s mode-session branch used to return before
  // `max_age` was ever parsed, so `harness delegate`'s parent-marker
  // check, default `--ttl`, and explicit-`--ttl` ceiling all silently
  // saw `maxAgeMs: undefined` under this config, same as no config at
  // all. Mutation probe P1: reverting `issueDelegation` to ignore
  // `lifecycle.maxAgeMs` under `legacyMode` (or forcing the parser to
  // drop `max_age` again on the mode-session branch) turns every test
  // below red.
  it("defaults the ttl from max_age under mode: session, not the hardcoded default", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const now = new Date("2026-08-28T00:00:00.000Z");
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithModeSessionMaxAge("2h"),
      now,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.expiresAt).toBe(new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString());
  });

  it("refuses an explicit --ttl above max_age's ceiling under mode: session", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithModeSessionMaxAge("1h"),
      ttlSeconds: 2 * 60 * 60,
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("ttl-above-max-age");
    expect(result.detail).toContain("3600");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("refuses with parent-marker-expired when the parent marker has aged past max_age under mode: session", async () => {
    approveParent({ approvedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      manifest: manifestWithModeSessionMaxAge("1h"),
      ledgerAdd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("parent-marker-expired");
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });
});

describe("issueDelegation - parent session resolution precedence", () => {
  it("prefers $CLAUDE_CODE_SESSION_ID over a staged .pending-approval", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = PARENT;
    writePendingApproval(generatedDir, "sess-staged-impostor");
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      generatedDir,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.parentSessionId).toBe(PARENT);
    // Not consumed: the staged id was not the one resolved.
    expect(readPendingApproval(generatedDir)).toBe("sess-staged-impostor");
  });

  it("never adopts a persisted report's sessionId (delegation has no newest-report fallback, unlike harness approve understanding)", async () => {
    const savedReportsDirEnv = process.env[REPORTS_DIR_ENV];
    const reportsDir = path.join(tmp, "reports-dir");
    fs.mkdirSync(reportsDir, { recursive: true });
    process.env[REPORTS_DIR_ENV] = reportsDir;
    fs.writeFileSync(
      path.join(reportsDir, "rpt.json"),
      JSON.stringify({ sessionId: "impostor-parent-from-report", approvalStatus: "pending" }),
    );
    try {
      const { ledgerAdd } = fakeLedger();
      const result = await issueDelegation({
        childSessionId: CHILD,
        cwd: childCwd,
        generatedDir,
        ledgerAdd,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("parent-session-unresolved");
    } finally {
      if (savedReportsDirEnv === undefined) delete process.env[REPORTS_DIR_ENV];
      else process.env[REPORTS_DIR_ENV] = savedReportsDirEnv;
    }
  });
});

describe("harness delegate - CLI wiring", () => {
  it("declares --child-session as a required option, and the rest of the documented flags", () => {
    const program = buildProgram();
    const delegate = program.commands.find((c) => c.name() === "delegate");
    expect(delegate, "harness delegate should be registered").toBeDefined();
    const childOpt = delegate?.options.find((o) => o.long === "--child-session");
    expect(childOpt?.mandatory).toBe(true);
    for (const long of [
      "--cwd",
      "--task",
      "--ttl",
      "--report",
      "--session-id",
      "--config",
      "--project",
    ]) {
      expect(
        delegate?.options.some((o) => o.long === long),
        `expected --${long} to be registered`,
      ).toBe(true);
    }
  });

  // Pins the corrected boundary sentence (docs/decisions/2026-08-27-ug-auto-mode-approval.md,
  // "Platform scope" amendment, and the round-2 correction to it, agent-tasks
  // be9faf70): consumption of a delegation is Claude Code only (no Codex
  // delegation-marker consumer), but ISSUING one is not restricted the same
  // way (a Codex session can be the delegating parent today). Asserting on
  // the distinctive "no delegation consumer" fragment keeps `--help` and the
  // docs from drifting apart silently.
  it("--help states the boundary as consumption-side, not a blanket Claude-only claim", async () => {
    let stdout = "";
    const code = await run({
      argv: ["delegate", "--help"],
      stdout: (s) => {
        stdout += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/no delegation consumer/);
    expect(stdout).toMatch(/delegating\s+parent today/i);
  });

  it("exits 1 with the exact ADR-pinned message when neither --cwd nor --task is given", async () => {
    const program = buildProgram({ stdout: () => {}, stderr: () => {} });
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, "version: 1\n");
    let caught: unknown;
    try {
      await program.parseAsync(
        ["delegate", "--child-session", CHILD, "--config", configPath],
        { from: "user" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(1);
    expect((caught as HarnessExitError).message).toBe(NO_BINDING_MESSAGE);
  });

  it("issues a real delegation end to end through the CLI action", async () => {
    approveParent();
    let out = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
    });
    const configPath = path.join(generatedDir, "..", "harness.yaml");
    fs.writeFileSync(configPath, "version: 1\n");
    await program.parseAsync(
      [
        "delegate",
        "--child-session",
        CHILD,
        "--cwd",
        childCwd,
        "--session-id",
        PARENT,
        "--config",
        configPath,
      ],
      { from: "user" },
    );
    expect(out).toMatch(/delegation: ✓/);
    expect(out).toMatch(new RegExp(`child ${CHILD}`));
    expect(out).toMatch(new RegExp(`parent ${PARENT}`));
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(true);
  });

  it("--ttl 30m reaches issueDelegation as 1800 seconds through the CLI action", async () => {
    approveParent();
    let out = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
    });
    const configPath = path.join(generatedDir, "..", "harness.yaml");
    fs.writeFileSync(configPath, "version: 1\n");
    const before = Date.now();
    await program.parseAsync(
      [
        "delegate",
        "--child-session",
        CHILD,
        "--cwd",
        childCwd,
        "--session-id",
        PARENT,
        "--config",
        configPath,
        "--ttl",
        "30m",
      ],
      { from: "user" },
    );
    const match = /expires ([^)]+)\)/.exec(out);
    expect(match).not.toBeNull();
    const expiresMs = Date.parse(match![1]!);
    const deltaSeconds = (expiresMs - before) / 1000;
    expect(deltaSeconds).toBeGreaterThan(1790);
    expect(deltaSeconds).toBeLessThan(1810);
  });

  it("--report reaches issueDelegation end to end through the CLI action, binding both hashes", async () => {
    approveParent();
    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, VALID_REPORT_MARKDOWN);
    let out = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
    });
    const configPath = path.join(generatedDir, "..", "harness.yaml");
    // `VALID_REPORT_MARKDOWN` is fast_confirm-shaped; declares the pack's
    // mode explicitly so the stage-time parse (which now resolves mode
    // the same way the config file does) matches the fixture's shape
    // instead of falling through to DEFAULT_MODE (grill_me).
    fs.writeFileSync(
      configPath,
      "version: 1\npolicy_packs:\n  - name: understanding-before-execution\n    config:\n      mode: fast_confirm\n",
    );
    await program.parseAsync(
      [
        "delegate",
        "--child-session",
        CHILD,
        "--cwd",
        childCwd,
        "--session-id",
        PARENT,
        "--config",
        configPath,
        "--report",
        reportPath,
      ],
      { from: "user" },
    );
    expect(out).toMatch(/delegation: ✓/);
    const conventionalPath = delegationReportPathFor(generatedDir, CHILD);
    expect(fs.readFileSync(conventionalPath, "utf8")).toBe(VALID_REPORT_MARKDOWN);
    const verified = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
      launcherReportPath: conventionalPath,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected the conventional-path report to verify");
    expect(verified.reportPathHash).toBe(hashDelegationCwd(conventionalPath));
  });

  it("--cwd '' --task <id> does not silently drop the cwd: the CLI passes it through and issueDelegation refuses it with invalid-cwd (L3)", async () => {
    approveParent();
    const program = buildProgram({ stdout: () => {}, stderr: () => {} });
    const configPath = path.join(generatedDir, "..", "harness.yaml");
    fs.writeFileSync(configPath, "version: 1\n");
    let caught: unknown;
    try {
      await program.parseAsync(
        [
          "delegate",
          "--child-session",
          CHILD,
          "--cwd",
          "",
          "--task",
          "37ad0b05",
          "--session-id",
          PARENT,
          "--config",
          configPath,
        ],
        { from: "user" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).message).toMatch(/delegate refused \(invalid-cwd\)/);
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("--ttl 0s parses fine at the CLI usage level (0 is a valid duration) but issueDelegation refuses it with invalid-ttl (L2)", async () => {
    approveParent();
    const program = buildProgram({ stdout: () => {}, stderr: () => {} });
    const configPath = path.join(generatedDir, "..", "harness.yaml");
    fs.writeFileSync(configPath, "version: 1\n");
    let caught: unknown;
    try {
      await program.parseAsync(
        [
          "delegate",
          "--child-session",
          CHILD,
          "--cwd",
          childCwd,
          "--session-id",
          PARENT,
          "--config",
          configPath,
          "--ttl",
          "0s",
        ],
        { from: "user" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(1);
    expect((caught as HarnessExitError).message).toMatch(/delegate refused \(invalid-ttl\)/);
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(false);
  });

  it("--ttl garbage fails at the CLI usage level with EX_USAGE and the --ttl: prefix", async () => {
    const program = buildProgram({ stdout: () => {}, stderr: () => {} });
    const configPath = path.join(generatedDir, "..", "harness.yaml");
    fs.writeFileSync(configPath, "version: 1\n");
    let caught: unknown;
    try {
      await program.parseAsync(
        [
          "delegate",
          "--child-session",
          CHILD,
          "--cwd",
          childCwd,
          "--config",
          configPath,
          "--ttl",
          "not-a-duration",
        ],
        { from: "user" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(64);
    expect((caught as HarnessExitError).message).toMatch(/^--ttl: /);
  });
});
