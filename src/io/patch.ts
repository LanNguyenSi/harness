import { createPatch } from "diff";

export interface UnifiedDiffOptions {
  fileName: string;
  oldText: string;
  newText: string;
  oldHeader?: string;
  newHeader?: string;
  context?: number;
}

export function unifiedDiff(opts: UnifiedDiffOptions): string {
  return createPatch(
    opts.fileName,
    opts.oldText,
    opts.newText,
    opts.oldHeader ?? "before",
    opts.newHeader ?? "after",
    { context: opts.context ?? 3 },
  );
}

export function isNoop(diff: string): boolean {
  return !/^[+-](?!\+\+ |-- )/m.test(diff);
}
