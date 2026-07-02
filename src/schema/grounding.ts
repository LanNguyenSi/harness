import { z } from "zod";

// Wiring status (task 129e1b94, harness-review-2026-07-01):
//
//   WIRED    evidence_ledger.path — projected by `harness apply` as the
//            `EVIDENCE_LEDGER_DB` env on the `tools.mcp[grounding-mcp]`
//            entry (src/cli/apply/generate-settings.ts,
//            projectGroundingEnv), the variable grounding-mcp's
//            ledger-bridge actually reads. `harness doctor` checks the
//            path is writable and flags divergence from an operator env
//            override.
//
//   RESERVED session.auto_start / session.id_format — no consumer yet;
//            session-start derives ids from the runtime event, not from
//            this format string.
//   RESERVED evidence_ledger.retention_days — evidence-ledger implements
//            no retention pruning yet; wiring an env no server reads
//            would be decorative.
//   RESERVED policies_source — no consumer; policies live in the
//            manifest's `policies[]` / `policy_packs[]`.
//
// Reserved keys are validated and round-tripped but change no behavior.
// Do not wire them speculatively: project an env/check only when a real
// consumer exists (that discipline is the point of 129e1b94).

export const GroundingSessionSchema = z
  .object({
    auto_start: z.boolean().default(true),
    id_format: z.string().min(1).default("gs-{repo}-{rand:8}"),
  })
  .strict();

export const EvidenceLedgerSchema = z
  .object({
    path: z.string().min(1).default("~/.evidence-ledger/ledger.db"),
    retention_days: z.number().int().positive().default(90),
  })
  .strict();

export const GroundingSchema = z
  .object({
    session: GroundingSessionSchema.default({}),
    evidence_ledger: EvidenceLedgerSchema.default({}),
    policies_source: z.string().min(1).nullable().default(null),
  })
  .strict();

export type Grounding = z.infer<typeof GroundingSchema>;
