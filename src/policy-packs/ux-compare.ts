// Structural comparison + safe-parse helpers for `config.ux` /
// `config.producers` (task 68b9ad9c). Shared by `checkPolicyPackUxDrift`
// (the `harness doctor` read-side warning, ux-drift-check.ts) and
// `harness pack reseed` (the opt-in write-side fix, src/cli/pack/reseed.ts)
// so the two can never independently drift on what "matches the shipped
// template" means.

import { z } from "zod";
import { PolicyUxSchema, ProducerSchema } from "../schema/policies.js";
import type { PolicyUx, Producer } from "../schema/index.js";

const ProducersArraySchema = z.array(ProducerSchema);

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

/**
 * Structural equality over a `producers:` array. Compares each entry
 * field-by-field per its discriminated `kind` rather than a generic deep
 * equal — the shape is small and fixed (bash/mcp/ask), and this keeps the
 * comparison legible instead of round-tripping through JSON.stringify
 * (which would also be sensitive to incidental key ordering).
 */
export function producersEqual(a: readonly Producer[], b: readonly Producer[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entryA, i) => {
    const entryB = b[i];
    if (!entryB || entryA.kind !== entryB.kind) return false;
    if (entryA.kind === "bash" && entryB.kind === "bash") {
      return entryA.command === entryB.command && entryA.description === entryB.description;
    }
    if (entryA.kind === "ask" && entryB.kind === "ask") {
      return entryA.command === entryB.command && entryA.description === entryB.description;
    }
    if (entryA.kind === "mcp" && entryB.kind === "mcp") {
      return (
        entryA.verb === entryB.verb &&
        entryA.example === entryB.example &&
        entryA.description === entryB.description
      );
    }
    return false;
  });
}

/** Parses an unknown `config.ux` value; returns null on any schema rejection. */
export function safeParseUx(raw: unknown): PolicyUx | null {
  const result = PolicyUxSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Parses an unknown `config.producers` value; returns null on any schema rejection. */
export function safeParseProducers(raw: unknown): Producer[] | null {
  const result = ProducersArraySchema.safeParse(raw);
  return result.success ? result.data : null;
}
