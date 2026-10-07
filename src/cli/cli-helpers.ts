import { HarnessExitError } from "./exit-codes.js";
import type { RecordResult } from "./record/index.js";
import { runSessionStartPreflight } from "./session-start/index.js";
import { writePendingApproval } from "../runtime/pending-approval.js";
import { applyCliOptions, type SessionStartCliOptions } from "./session-start/shared-options.js";

export function createCliHelpers(io: {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}): {
  preflightAction: (options: SessionStartCliOptions & { timeout?: string }) => Promise<void>;
  applyLedgerTimeout: (raw: string | undefined, cliOpts: { ledgerTimeoutMs?: number }) => void;
  reportRecordResult: (result: RecordResult) => void;
} {
  const { stdout, stderr } = io;
  // The action shared by `harness session-start preflight` and its
  // top-level alias `harness preflight`: the alias delegates to the same
  // implementation, with the same CLI options.
  const preflightAction = async (options: SessionStartCliOptions & { timeout?: string }) => {
    const cliOpts: Parameters<typeof runSessionStartPreflight>[0] = {};
    applyCliOptions(options, cliOpts);
    if (options.timeout) {
      const n = Number.parseInt(options.timeout, 10);
      if (Number.isFinite(n) && n > 0) cliOpts.preflightTimeoutMs = n;
    }
    // Opt into the bootstrap-staging side effect from the CLI entry
    // point only. Library callers (vitest cases) get the no-op default
    // so they cannot clobber the operator's real pending-approval file.
    cliOpts.stagePendingApproval = writePendingApproval;
    await runSessionStartPreflight(cliOpts);
  };

  // Shared by the three `record` verbs' action handlers (src/cli/register-record-session-group.ts): parse
  // `--ledger-timeout <ms>` into `cliOpts.ledgerTimeoutMs`, and report a
  // `RecordResult` (print the recorded fact on success; on failure, throw
  // with the runner's own exit code and an EMPTY message, since the
  // runner already wrote the reason to stderr itself — throwing the same
  // text again would double-print it).
  //
  // An unparseable / non-positive value used to fall back to the
  // default silently (review finding, T-004): an operator who typo'd
  // `--ledger-timeout 5ooo` got the default timeout with zero
  // diagnostic. Now a malformed value warns once on stderr before
  // falling back, same "never a silent gap" convention `resolveBase`'s
  // own degrade path (src/cli/record/index.ts) already uses.
  const applyLedgerTimeout = (
    raw: string | undefined,
    cliOpts: { ledgerTimeoutMs?: number },
  ): void => {
    if (!raw) return;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      cliOpts.ledgerTimeoutMs = n;
      return;
    }
    stderr(
      `harness record: --ledger-timeout ${JSON.stringify(raw)} is not a positive integer; using the default timeout.\n`,
    );
  };
  const reportRecordResult = (result: RecordResult): void => {
    if (result.wrote) {
      stdout(`recorded ${result.content} for session ${result.sessionId}\n`);
    }
    if (result.exitCode !== 0) {
      throw new HarnessExitError("", result.exitCode);
    }
  };
  return { preflightAction, applyLedgerTimeout, reportRecordResult };
}
