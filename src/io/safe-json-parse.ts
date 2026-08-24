// Small shared JSON-parse helper. Moved here (structural-concentration
// slice, task 9bc0d546) from
// src/policy-packs/builtin/understanding-before-execution/persisted-reports.ts,
// which used to be the only definition; markers.ts imported it from there
// too, creating an internal markers.ts -> persisted-reports.ts edge purely
// for this one helper. Giving it a neutral home in src/io removes that
// edge: both call sites now import the same function from here instead of
// from each other. Pure move, no behavior change.

/**
 * Parse `text` as JSON, returning `null` instead of throwing on malformed
 * input.
 */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
