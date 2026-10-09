// Structural comparison + safe-parse helpers for `config.ux` (task
// 68b9ad9c). Shared by `checkPolicyPackUxDrift` (the `harness doctor`
// read-side warning, ux-drift-check.ts) and `harness pack reseed` (the
// opt-in write-side fix, src/cli/pack/reseed.ts) so the two can never
// independently drift on what "matches the shipped template" means.

import { PolicyUxSchema } from "../schema/policies.js";
import type { PolicyUx } from "../schema/index.js";

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function uxEqual(a: PolicyUx, b: PolicyUx): boolean {
  return (
    a.cannot === b.cannot &&
    stringArrayEqual(a.required, b.required) &&
    stringArrayEqual(a.run, b.run)
  );
}

/** Parses an unknown `config.ux` value; returns null on any schema rejection. */
export function safeParseUx(raw: unknown): PolicyUx | null {
  const result = PolicyUxSchema.safeParse(raw);
  return result.success ? result.data : null;
}
