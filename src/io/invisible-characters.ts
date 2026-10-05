// Shared rule for characters that are not printable text but can hide,
// reorder or smuggle what a reader sees. The terminal display escaper
// (`escapeForDisplay` in `src/io/display-path.ts`) and the agent-facing
// envelope sanitiser (`sanitizeEnvelopeReason` in `src/runtime/intercept.ts`)
// both build their pattern from this one class, so a character covered here
// is covered by both.
//
// The rule: every code point with General_Category Cf (bidi controls, zero
// width space, BOM, the tag characters, ...) or the property
// Default_Ignorable_Code_Point (adds the variation selectors, U+034F, the
// Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, and the rest of
// U+E0000-U+E0FFF).
//
// One documented difference between the two callers: the envelope sanitiser
// keeps the zero width joiner U+200D, because it joins emoji sequences in
// model-visible prose; the display escaper escapes it, because it prints
// file names whose exact identity matters and a joiner between two letters
// renders as nothing.

/** Regex character-class body (no brackets) of the shared rule; use with the `u` flag. */
export const INVISIBLE_CHARACTER_CLASS = "\\p{Cf}\\p{Default_Ignorable_Code_Point}";
