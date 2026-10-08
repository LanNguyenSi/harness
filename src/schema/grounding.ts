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
//
//   REMOVED  evidence_ledger.retention_days and policies_source (task
//            a4d8adc5): reserved keys that never had a consumer. A manifest
//            that still carries them loads with a warning; the posture
//            table is src/schema/removed-keys.ts.
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
  })
  .strict();

export const GroundingSchema = z
  .object({
    session: GroundingSessionSchema.default({}),
    evidence_ledger: EvidenceLedgerSchema.default({}),
  })
  .strict();

export type Grounding = z.infer<typeof GroundingSchema>;
