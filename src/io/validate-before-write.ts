import { ManifestParseError, parseManifest } from "../schema/index.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

export interface ValidationError {
  path: string;
  message: string;
}

export function validateBeforeWrite(proposedRaw: unknown): ValidationResult {
  try {
    parseManifest(proposedRaw);
    return { ok: true };
  } catch (e) {
    if (e instanceof ManifestParseError) {
      return {
        ok: false,
        errors: e.issues.map((i) => ({
          path: i.path.length > 0 ? i.path.join(".") : "<root>",
          message: i.message,
        })),
      };
    }
    throw e;
  }
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
}
