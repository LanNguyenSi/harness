import { z } from "zod";

/**
 * `doctor:` — operator-facing configuration for `harness doctor` checks.
 *
 * `ignore_template_drift` is the deliberate-opt-out channel for the
 * template-policy-drift check (task adf037c1): each entry is a shipped
 * policy NAME the operator has consciously chosen NOT to carry in this
 * installed manifest, so doctor must not report it as drift.
 *
 * This is deliberately NOT a per-policy `enabled: false` flag. A
 * `policies[].enabled` field would be read by the drift check but IGNORED
 * by the runtime policy engine (which has no such concept), so an operator
 * setting it would believe a policy disabled while it still fired — a
 * security footgun. This list only ever suppresses a doctor REPORT line;
 * it changes no enforcement semantics, so its meaning is honest at a
 * glance. (Operator decision 2026-08-08.)
 */
export const DoctorSchema = z
  .object({
    ignore_template_drift: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type DoctorConfig = z.infer<typeof DoctorSchema>;
