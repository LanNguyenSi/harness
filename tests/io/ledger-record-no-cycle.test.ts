import { describe, expect, it } from "vitest";

// Regression for task `1272feb6`: a TDZ cycle used to live between
// `src/runtime/ledger-record.ts` (which value-imported `parseLedgerTimestamp`
// from the `policies/index.ts` barrel) and `src/policies/ledger-client.ts`
// (which value-imports `POLICY_DECISION_TYPE` from `runtime/ledger-record.ts`).
// The barrel re-exported ledger-client, closing the loop. On any import
// path that forced `runtime/ledger-record.ts` to load before
// `policies/index.ts`, `ledger-client.ts` would touch `POLICY_DECISION_TYPE`
// while it was still in its TDZ and crash CLI startup with
// `ReferenceError: Cannot access 'POLICY_DECISION_TYPE' before initialization`.
//
// The fix swapped `ledger-record.ts`'s barrel import for direct
// leaf-module imports (`policies/timestamp.js` and `policies/requires.js`).
// Pin the cycle's absence here: value-import the constant from
// ledger-record first, then load the commander program (which transitively
// pulls in `policies/index.ts`). The original failure manifested at
// module-init time, so we just need the import + reference to succeed.
// `src/cli/index.ts` is loaded instead of `src/cli/main.ts` because main
// auto-runs and calls `process.exit`, which would muddy the test signal.

describe("io/ledger-record ↔ policies/index — no TDZ cycle on load", () => {
  it("value-importing POLICY_DECISION_TYPE before loading the CLI program does not throw", async () => {
    const { POLICY_DECISION_TYPE } = await import("../../src/io/ledger-record.js");
    expect(POLICY_DECISION_TYPE).toBe("policy_decision");
    await expect(import("../../src/cli/index.js")).resolves.toBeDefined();
  });

  it("the policies barrel re-export still resolves parseLedgerTimestamp", async () => {
    const mod = await import("../../src/policies/index.js");
    expect(typeof mod.parseLedgerTimestamp).toBe("function");
  });
});
