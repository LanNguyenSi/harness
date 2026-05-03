import * as path from "node:path";
import { ManifestParseError, parseManifest, type Manifest } from "../../schema/index.js";
import { LOCK_BASENAME, readLock } from "../../io/harness-lock.js";
import { diffAssets } from "../diff/since-apply.js";
import { loadMergedRaw, type LoaderOptions } from "../loader.js";
import { runAssetChecks, type CheckOptions } from "./checks.js";
import { fmtDiagnostic, type Diagnostic } from "./types.js";

export interface ValidateOptions extends LoaderOptions, CheckOptions {
  strict?: boolean;
  /**
   * Phase 3 follow-up: when set, also read the sibling `harness.lock`
   * file and surface any drifted-asset entries as warnings (errors with
   * `--strict`). When the lock file is absent, emits a single info-warn
   * pointing to `harness apply`. Off by default so existing CI gates
   * keep their current scope.
   */
  checkLock?: boolean;
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
  const { mergedRaw, resolved } = loadMergedRaw(opts);

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

  if (opts.checkLock) {
    diagnostics.push(...checkLockDrift(resolved.base));
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

/**
 * Phase 3 follow-up: read the sibling `harness.lock` and surface every
 * drifted-asset entry as a warning. Uses `diffAssets` (re-exported from
 * `harness diff --since-apply`); the comparison is `sha256(read(path))`
 * vs the recorded `sha256` per asset, bit-identical to the `computeDrift`
 * call apply performs at the same gate. This CLI just rewords each
 * drift entry as a Diagnostic so it shows up next to schema/asset
 * findings in the validate report.
 */
function checkLockDrift(manifestPath: string): Diagnostic[] {
  const lockPath = path.join(path.dirname(manifestPath), LOCK_BASENAME);
  const entries = readLock(lockPath);
  if (entries === null) {
    return [
      {
        severity: "warning",
        path: lockPath,
        message: "no lock file; run `harness apply` to populate",
      },
    ];
  }
  const drifted = diffAssets(entries);
  return drifted.map((d) => ({
    severity: "warning",
    path: d.path,
    message:
      d.reason === "missing"
        ? `asset ${d.reason}; expected sha ${d.expectedSha.slice(0, 12)}…`
        : `asset ${d.reason}; expected sha ${d.expectedSha.slice(0, 12)}…, on-disk ${d.currentSha?.slice(0, 12) ?? "?"}…`,
  }));
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
