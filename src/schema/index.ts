import { z } from "zod";
import { GroundingSchema } from "./grounding.js";
import { HooksSchema } from "./hooks.js";
import { MemorySchema } from "./memory.js";
import { PolicyPacksSchema } from "./policy-packs.js";
import { ToolsSchema } from "./tools.js";
import { AuditSchema } from "./audit.js";
import {
  findRemovedCommandUses,
  remapIssuePath,
  stripRemovedManifestEntries,
  type ManifestPostureWarning,
  type StrippedIndexMaps,
} from "./removed-keys.js";

export const SUPPORTED_MANIFEST_VERSION = 1;

export const ManifestSchema = z
  .object({
    version: z.literal(SUPPORTED_MANIFEST_VERSION),
    grounding: GroundingSchema.default({}),
    tools: ToolsSchema.default({}),
    memory: MemorySchema.default({}),
    hooks: HooksSchema.default([]),
    policy_packs: PolicyPacksSchema.default([]),
    audit: AuditSchema.default({}),
  })
  .strict();

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

export interface ParsedManifest {
  manifest: Manifest;
  /**
   * Removed keys, removed hook fields and removed packs that were stripped
   * before the parse, then every hook command or pack `producers` / `ux.run`
   * line that still calls a removed command.
   */
  warnings: ManifestPostureWarning[];
  /**
   * Original positions of the policy_packs[] entries that
   * survived the drop, for a caller that reports a diagnostic about the
   * parsed manifest (`remapDiagnosticPath`). Absent when nothing was dropped.
   */
  indexMaps?: StrippedIndexMaps;
}

/**
 * Parse a raw manifest, first stripping every removed manifest path, every
 * removed hook field and every removed pack name (`src/schema/removed-keys.ts`):
 * those warn (an empty value of a removed key does not) and are ignored
 * instead of failing the strict parse. Any other unknown key still fails it. A manifest that parses is then scanned for sites that still call
 * a removed command (`findRemovedCommandUses`); those warn too, with the
 * manifest path of each site.
 */
export function parseManifestWithWarnings(raw: unknown): ParsedManifest {
  const stripped = stripRemovedManifestEntries(raw);
  const result = ManifestSchema.safeParse(stripped.raw);
  if (!result.success) {
    // Dropping an entry re-indexes policy_packs[]: name the index the
    // operator wrote, not the one the strict parse saw.
    const issues = friendlyVersionIssues(result.error.issues, raw).map((i) => ({
      ...i,
      path: remapIssuePath(i.path, stripped.indexMaps),
    }));
    const summary = issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ManifestParseError(
      `harness manifest failed validation:\n${summary}`,
      issues,
    );
  }
  return {
    manifest: result.data,
    warnings: [...stripped.warnings, ...findRemovedCommandUses(raw)],
    ...(stripped.indexMaps !== undefined ? { indexMaps: stripped.indexMaps } : {}),
  };
}

/** `parseManifestWithWarnings` for callers that do not report the warnings. */
export function parseManifest(raw: unknown): Manifest {
  return parseManifestWithWarnings(raw).manifest;
}

export * from "./grounding.js";
export * from "./tools.js";
export * from "./memory.js";
export * from "./hooks.js";
export * from "./policy-ux.js";
export * from "./policy-packs.js";
export * from "./audit.js";
// Named, not `export *`: `removedCommandMessage` is shared with the doctor
// but is not part of the package API.
export {
  REMOVED_MANIFEST_PATHS,
  REMOVED_HOOK_FIELDS,
  REMOVED_PACK_NAMES,
  REMOVED_MANIFEST_TABLE,
  REMOVED_COMMANDS,
  REMOVED_LIST_CATEGORIES,
  REMOVED_DESCRIBE_PILLARS,
  removedInspectNameMessage,
  stripRemovedManifestEntries,
  stripRemovedManifestPaths,
  formatPostureWarning,
  invokesRemovedCommand,
  findRemovedCommandUses,
  remapDiagnosticPath,
} from "./removed-keys.js";
export type {
  RemovedManifestPath,
  RemovedHookField,
  RemovedPackName,
  RemovedManifestTable,
  IndexMap,
  StrippedIndexMaps,
  ManifestPostureWarning,
  StrippedManifest,
  RemovedCommand,
  RemovedInspectName,
} from "./removed-keys.js";
