import { ManifestParseError, parseManifest, type Manifest } from "../../schema/index.js";
import { loadMergedRaw, type LoaderOptions } from "../loader.js";
import { runAssetChecks, type CheckOptions } from "./checks.js";
import { fmtDiagnostic, type Diagnostic } from "./types.js";

export interface ValidateOptions extends LoaderOptions, CheckOptions {
  strict?: boolean;
}

export interface ValidateResult {
  diagnostics: Diagnostic[];
  manifest: Manifest | null;
  errorCount: number;
  warningCount: number;
}

function fromZodIssues(err: ManifestParseError): Diagnostic[] {
  return err.issues.map((i) => ({
    severity: "error",
    path: i.path.length === 0 ? "<root>" : i.path.join("."),
    message: i.message,
  }));
}

export function validate(opts: ValidateOptions = {}): ValidateResult {
  const { mergedRaw } = loadMergedRaw(opts);

  let manifest: Manifest | null = null;
  let diagnostics: Diagnostic[] = [];
  try {
    manifest = parseManifest(mergedRaw);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      diagnostics = fromZodIssues(err);
    } else {
      throw err;
    }
  }

  if (manifest) {
    diagnostics.push(...runAssetChecks(manifest, opts));
  }

  if (opts.strict) {
    for (const d of diagnostics) {
      if (d.severity === "warning") d.severity = "error";
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  return { diagnostics, manifest, errorCount, warningCount };
}

export function formatReport(result: ValidateResult): string {
  if (result.diagnostics.length === 0) return "no validation findings\n";
  const lines = result.diagnostics.map(fmtDiagnostic);
  lines.push("");
  lines.push(
    `${result.errorCount} error${result.errorCount === 1 ? "" : "s"}, ${result.warningCount} warning${result.warningCount === 1 ? "" : "s"}.`,
  );
  return `${lines.join("\n")}\n`;
}

export type { Diagnostic } from "./types.js";
export { fmtDiagnostic } from "./types.js";
export { runAssetChecks } from "./checks.js";
