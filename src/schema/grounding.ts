import { z } from "zod";

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
