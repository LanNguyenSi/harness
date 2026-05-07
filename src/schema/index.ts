import { z } from "zod";
import { GroundingSchema } from "./grounding.js";
import { HooksSchema } from "./hooks.js";
import { MemorySchema } from "./memory.js";
import { PoliciesSchema } from "./policies.js";
import { PermissionProfilesSchema } from "./permission-profiles.js";
import { PolicyPacksSchema } from "./policy-packs.js";
import { ToolsSchema } from "./tools.js";
import { AuditSchema } from "./audit.js";
import { ReviewTemplatesSchema, WorkflowsSchema } from "./workflows.js";

export const SUPPORTED_MANIFEST_VERSION = 1;

export const ManifestSchema = z
  .object({
    version: z.literal(SUPPORTED_MANIFEST_VERSION),
    grounding: GroundingSchema.default({}),
    tools: ToolsSchema.default({}),
    memory: MemorySchema.default({}),
    hooks: HooksSchema.default([]),
    policies: PoliciesSchema.default([]),
    policy_packs: PolicyPacksSchema.default([]),
    permission_profiles: PermissionProfilesSchema.default({}),
    workflows: WorkflowsSchema.default([]),
    review_templates: ReviewTemplatesSchema.default({}),
    audit: AuditSchema.default({}),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const hookNames = new Set(manifest.hooks.map((h) => h.name));
    manifest.policies.forEach((p, i) => {
      if (!hookNames.has(p.hook)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policies", i, "hook"],
          message: `policy "${p.name}" references hook "${p.hook}" which is not declared in hooks[]`,
        });
      }
    });
    const templateNames = new Set(Object.keys(manifest.review_templates));
    manifest.workflows.forEach((wf, wi) => {
      wf.steps.forEach((step, si) => {
        if (step.kind === "review_subagent" && step.template !== undefined) {
          if (!templateNames.has(step.template)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["workflows", wi, "steps", si, "template"],
              message: `review_subagent.template "${step.template}" is not defined in review_templates`,
            });
          }
        }
      });
    });
  });

export type Manifest = z.infer<typeof ManifestSchema>;

export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "ManifestParseError";
  }
}

export function parseManifest(raw: unknown): Manifest {
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ManifestParseError(
      `harness manifest failed validation:\n${summary}`,
      result.error.issues,
    );
  }
  return result.data;
}

export * from "./grounding.js";
export * from "./tools.js";
export * from "./memory.js";
export * from "./hooks.js";
export * from "./permission-profiles.js";
export * from "./policies.js";
export * from "./policy-packs.js";
export * from "./workflows.js";
export * from "./audit.js";
export * from "./extract.js";
export * from "./requires.js";
