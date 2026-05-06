import { z } from "zod";

export const ReviewSpawnSchema = z.enum(["required", "optional", "skip"]);
export const ReviewRigorSchema = z.enum(["rigorous", "quick", "docs-only"]);
export const ReviewOnFindingsSchema = z.enum(["fix_then_remerge", "comment_only"]);
export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export const MergeGateSchema = z.enum(["solo", "agent_tasks_label", "none"]);

export const WorkflowWhenSchema = z
  .object({
    task_label: z.array(z.string().min(1)).min(1).optional(),
    project: z.string().min(1).optional(),
  })
  .strict();

export const BranchStepSchema = z
  .object({
    kind: z.literal("branch"),
    from: z.string().min(1).default("master"),
    per_task: z.boolean().default(true),
  })
  .strict();

export const ReviewSubagentStepSchema = z
  .object({
    kind: z.literal("review_subagent"),
    spawn: ReviewSpawnSchema.default("required"),
    agent_type: z.string().min(1).default("Explore"),
    rigor: ReviewRigorSchema.default("rigorous"),
    template: z.string().min(1).optional(),
    on_findings: ReviewOnFindingsSchema.default("fix_then_remerge"),
  })
  .strict();

export const CiGateStepSchema = z
  .object({
    kind: z.literal("ci_gate"),
    wait_for: z.string().min(1).default("completed/success"),
  })
  .strict();

export const MergeStepSchema = z
  .object({
    kind: z.literal("merge"),
    method: MergeMethodSchema.default("squash"),
    gate: MergeGateSchema.default("solo"),
  })
  .strict();

export const WorkflowStepSchema = z.discriminatedUnion("kind", [
  BranchStepSchema,
  ReviewSubagentStepSchema,
  CiGateStepSchema,
  MergeStepSchema,
]);

export const WorkflowSchema = z
  .object({
    name: z.string().min(1),
    when: WorkflowWhenSchema.default({}),
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict()
  .superRefine((wf, ctx) => {
    wf.steps.forEach((step, i) => {
      if (step.kind === "review_subagent" && step.spawn === "required" && !step.template) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "template"],
          message:
            'review_subagent with spawn: "required" must set a template name (referencing review_templates)',
        });
      }
    });
  });

export const WorkflowsSchema = z.array(WorkflowSchema).superRefine((workflows, ctx) => {
  const seen = new Set<string>();
  workflows.forEach((wf, i) => {
    if (seen.has(wf.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "name"],
        message: `duplicate workflow name: ${wf.name}`,
      });
    }
    seen.add(wf.name);
  });
});

export const ReviewTemplatesSchema = z.record(z.string().min(1), z.string().min(1));

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type ReviewTemplates = z.infer<typeof ReviewTemplatesSchema>;
