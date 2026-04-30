// Three-state comparator for `harness apply` per ARCHITECTURE.md §7.
//
// Given:
//   - manifestExpected: what the file should look like, derived from the manifest
//   - lastApplied:      what harness wrote on the previous apply (null on first run)
//   - onDiskCurrent:    what the file currently contains on disk (null if absent)
//
// returns one of:
//   - "safe-overwrite": no last-apply record, no on-disk file → write fresh
//   - "no-drift":       last-apply present and matches on-disk → overwrite is safe
//   - "drift-refuse":   either (a) on-disk exists but no last-apply, or
//                              (b) last-apply present but on-disk differs (or is gone)

export type ThreeStateVerdict = "safe-overwrite" | "no-drift" | "drift-refuse";

export interface ThreeStateInput {
  manifestExpected: string;
  lastApplied: string | null;
  onDiskCurrent: string | null;
}

export function compare(input: ThreeStateInput): ThreeStateVerdict {
  const { lastApplied, onDiskCurrent } = input;

  if (lastApplied === null) {
    return onDiskCurrent === null ? "safe-overwrite" : "drift-refuse";
  }

  return onDiskCurrent === lastApplied ? "no-drift" : "drift-refuse";
}
