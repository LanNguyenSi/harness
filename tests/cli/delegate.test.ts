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
import { buildProgram } from "../../src/cli/index.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  approvalMarkerPathFor,
  delegationMarkerPathFor,
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

  it("--report populates both hashes; verifyDelegation with the same launcherReportPath passes, a moved copy fails", async () => {
    approveParent();
    const { ledgerAdd } = fakeLedger();
    const reportPath = path.join(tmp, "child-report.json");
    fs.writeFileSync(reportPath, '{"mode":"grill_me"}\n');
    const result = await issueDelegation({
      childSessionId: CHILD,
      cwd: childCwd,
      parentSessionId: PARENT,
      generatedDir,
      reportPath,
      ledgerAdd,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");

    const okVerify = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
      launcherReportPath: reportPath,
    });
    expect(okVerify.ok).toBe(true);
    if (!okVerify.ok) throw new Error("expected the same-path report to verify");
    expect(okVerify.reportPathHash).toBe(hashDelegationCwd(reportPath));

    const movedPath = path.join(tmp, "moved-report.json");
    fs.copyFileSync(reportPath, movedPath);
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
    fs.writeFileSync(reportPath, '{"mode":"grill_me"}\n');
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
        "--report",
        reportPath,
      ],
      { from: "user" },
    );
    expect(out).toMatch(/delegation: ✓/);
    const verified = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
      launcherReportPath: reportPath,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected the same-path report to verify");
    expect(verified.reportPathHash).toBe(hashDelegationCwd(reportPath));
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
