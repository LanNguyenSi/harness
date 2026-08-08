import { z } from "zod";
import { EnvironmentsSchema } from "./environments.js";
import { GroundingSchema } from "./grounding.js";
import { HooksSchema } from "./hooks.js";
import { MemorySchema } from "./memory.js";
import { PoliciesSchema } from "./policies.js";
import { PermissionProfilesSchema } from "./permission-profiles.js";
import { PolicyPacksSchema } from "./policy-packs.js";
import { RiskSchema } from "./risk.js";
import { ToolsSchema } from "./tools.js";
import { ToolchainParitySchema } from "./toolchain-parity.js";
import { StaleBaseCheckSchema } from "./stale-base-check.js";
import { AuditSchema } from "./audit.js";
import { DoctorSchema } from "./doctor.js";
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
    // Phase 7 Risk Gate inputs — LIVE since Phase 7 #3/#5:
    // `risk.classifiers[]` feeds `classifyRisk` (runtime/intercept.ts)
    // on every PreToolUse once the manifest declares at least one
    // `when:`-bearing policy (the riskGateActive guard), and
    // `when.risk.*` clauses consume the result in runtime/when-eval.ts.
    // See docs/risk-gate.md.
    risk: RiskSchema.default({}),
    environments: EnvironmentsSchema.default({}),
    permission_profiles: PermissionProfilesSchema.default({}),
    workflows: WorkflowsSchema.default([]),
    review_templates: ReviewTemplatesSchema.default({}),
    audit: AuditSchema.default({}),
    // Optional, default-OFF: `harness session-start toolchain-parity`
    // snapshot + peer-drift-compare config. See ./toolchain-parity.ts.
    toolchain_parity: ToolchainParitySchema.default({}),
    // Optional, default-OFF: `harness session-start stale-base-check`
    // config (task ce3903b0, incident ea8becf5). See ./stale-base-check.ts.
    stale_base_check: StaleBaseCheckSchema.default({}),
    // Optional: `harness doctor` config, e.g. the deliberate-opt-out
    // list for the template-policy-drift check. See ./doctor.ts.
    doctor: DoctorSchema.default({}),
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

/**
 * Replace the bare zod literal error on the `version` key with
 * actionable guidance (task 50a94127; the message docs/ARCHITECTURE.md
 * §"Versioning" promises). Three variants: a HIGHER numeric version
 * most likely comes from a newer harness release, so the fix is
 * upgrading the CLI; a missing key needs `version: 1` added; anything
 * else (lower number, quoted string, wrong type) gets a neutral
 * unsupported-version message, since upgrade advice would point the
 * wrong way. Message wording only: issue codes, paths, and the thrown
 * error type stay identical, so exit codes and callers that branch on
 * issue structure are unaffected.
 */
function friendlyVersionIssues(issues: z.ZodIssue[], raw: unknown): z.ZodIssue[] {
  const declared =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)["version"]
      : undefined;
  return issues.map((i) => {
    if (i.path.length !== 1 || i.path[0] !== "version") return i;
    let message: string;
    if (declared === undefined || declared === null) {
      message = `missing manifest version: add \`version: ${SUPPORTED_MANIFEST_VERSION}\` (this CLI supports manifest version ${SUPPORTED_MANIFEST_VERSION})`;
    } else if (typeof declared === "number" && declared > SUPPORTED_MANIFEST_VERSION) {
      message = `this CLI supports manifest version ${SUPPORTED_MANIFEST_VERSION}; your manifest declares version ${JSON.stringify(declared)}. A newer manifest needs a newer CLI: re-run \`npm i -g @lannguyensi/harness\` and see the CHANGELOG for migration notes.`;
    } else {
      message = `unsupported manifest version ${JSON.stringify(declared)}: this CLI supports manifest version ${SUPPORTED_MANIFEST_VERSION} (use \`version: ${SUPPORTED_MANIFEST_VERSION}\`, unquoted)`;
    }
    return { ...i, message };
  });
}

export function parseManifest(raw: unknown): Manifest {
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = friendlyVersionIssues(result.error.issues, raw);
    const summary = issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ManifestParseError(
      `harness manifest failed validation:\n${summary}`,
      issues,
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
export * from "./risk.js";
export * from "./toolchain-parity.js";
export * from "./environments.js";
export * from "./workflows.js";
export * from "./audit.js";
export * from "./doctor.js";
export * from "./extract.js";
export * from "./requires.js";
