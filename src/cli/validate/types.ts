export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  path: string;
  message: string;
}

export function fmtDiagnostic(d: Diagnostic): string {
  const tag = d.severity === "error" ? "ERROR" : "WARN";
  return `${tag}  ${d.path}: ${d.message}`;
}
