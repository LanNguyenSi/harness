import { describe, expect, it } from "vitest";
import { parseBashPrefix } from "../../src/runtime/bash-prefix-parse.js";
import { isReadOnlyBashCommand } from "../../src/runtime/read-only-bash.js";
import { normalizeCommand } from "../../src/runtime/command-normalize.js";

// Cross-module agreement on ONE shell fact: what counts as a POSIX variable
// name in a leading `NAME=VALUE` assignment.
//
// WHY THIS EXISTS AND WHY IT IS A TEST RATHER THAN A SHARED CONSTANT
// (task d977ad58, run 2026-07-28-shell-vocabulary, decisions D-001/D-007/D-008):
// three modules encode this grammar independently and none exports it:
//   - bash-prefix-parse.ts  VAR_START / VAR_CONT, walked character by character
//   - read-only-bash.ts     an inline /^[A-Za-z_][A-Za-z0-9_]*=/ in the env peel
//   - command-normalize.ts  VAR_ASSIGN_RE, byte-identical to the inline one
// A read-only inventory measured that all three AGREE today. So a shared
// module would have had nothing to repair: it would have moved one correct
// line and created an export with no second consumer. The other candidate for
// sharing, the shell-metacharacter catalogue, is worse — its three
// enumerations differ ON PURPOSE, because the modules fail in opposite
// directions, and one shared list would invite the next author to flatten
// that. What was actually missing is the COUPLING, and a coupling is a test.
//
// It asserts BEHAVIOUR, not the constants: each module is observed through its
// own public entry point, so an author may rewrite the regex freely as long as
// the three still answer alike. That is the property worth protecting.
//
// Measured 2026-07-28: the repository's duplication check is structurally blind
// to this class — running its exact jscpd invocation showed ZERO of the 103
// pinned clones touch any of these three files, even though two of the three
// encodings are byte-identical. Do not expect that gate to catch a divergence.
//
// NOT covered here, deliberately: the modules' other, KNOWINGLY asymmetric
// vocabularies (which wrappers each trusts, which binaries are read-only, which
// chaining metacharacters each checks). Those differ on purpose because the
// modules fail in opposite directions — read-only-bash.ts treats the unknown as
// a write, command-normalize.ts only ever widens matching — and flattening them
// into one list would be a behaviour change wearing a refactor's clothes.
//
// NOT covered either: a FOURTH module growing its own copy of this grammar
// would join silently, which is the very failure mode the parent task was
// opened for. Nothing here scans for that. Checked 2026-07-28: the only other
// `[A-Za-z_][A-Za-z0-9_]*` under src/ is `IDENTIFIER_RE` in
// src/policies/extract.ts, a JSONPath-DSL identifier — a different concept, so
// "three modules" is accurate today and this is a watch item, not a gap.
// src/runtime/bash-match-registry.ts's unregistered-set scan is the idiom to
// copy if a guard is ever wanted.
//
// PROBE LIMITS — READ BEFORE ADDING A CASE. Two of the three observation
// functions can answer from a guard that sits UPSTREAM of the grammar, so a
// carelessly chosen name would produce a red that blames a divergence which
// does not exist. Measured 2026-07-28 (reviewer):
//   - Do NOT add a name beginning with `-`, nor one containing `;`, `&`, `|`,
//     `<` or `>`. read-only-bash.ts answers those from its own flag-skipping
//     (`--x=…` and `-uX`/`-CX` are consumed as `env`'s options) or from its
//     chaining guard, never from the variable-name grammar. The corpus below
//     stays clear of both: `-x` is the sole dash case and it matches neither
//     catch-all, which is why it still measures the grammar.
//   - `__proto__` is grammar-valid and accepted by all three modules, but
//     `prefixParserAccepts` would report it rejected: bash-prefix-parse.ts
//     stores into a plain object literal, so that one name sets the prototype
//     instead of creating an own property. That is a real module defect
//     (a silently dropped inline env var on the risk-gate resolver's input),
//     filed separately — not something to encode here.

interface GrammarCase {
  readonly name: string;
  readonly accepted: boolean;
  readonly why: string;
}

const CASES: readonly GrammarCase[] = [
  { name: "A", accepted: true, why: "single uppercase letter" },
  { name: "_", accepted: true, why: "bare underscore is a legal identifier" },
  { name: "a1", accepted: true, why: "letter then digit" },
  { name: "A_B9", accepted: true, why: "underscore and digit inside" },
  { name: "_x", accepted: true, why: "leading underscore" },
  { name: "PATH2", accepted: true, why: "the ordinary shape" },
  { name: "1a", accepted: false, why: "may not start with a digit" },
  { name: "9", accepted: false, why: "digits alone are not an identifier" },
  { name: "a-b", accepted: false, why: "hyphen is not an identifier character" },
  { name: "a.b", accepted: false, why: "dot is not an identifier character" },
  { name: "a+b", accepted: false, why: "plus is not an identifier character" },
  {
    name: "a b",
    accepted: false,
    why: "a space ends the token before the =; note only bash-prefix-parse.ts sees this string un-tokenized, the other two split on whitespace first, so this row pins one module rather than three",
  },
  { name: "-x", accepted: false, why: "a leading dash reads as a flag, not a name" },
];

/** Does bash-prefix-parse.ts accept `name` as an inline env assignment? */
function prefixParserAccepts(name: string): boolean {
  // The `&& echo hi` tail is required for an unrelated reason: this module
  // extracts a cd PREFIX, so a trailing `cd` with nothing after it yields a
  // null target even for a perfectly good value. Only `inlineEnv` is read here.
  const parsed = parseBashPrefix(`${name}=x cd /tmp && echo hi`);
  return Object.prototype.hasOwnProperty.call(parsed.inlineEnv, name);
}

/** Does read-only-bash.ts skip `name=x` while peeling `env`'s arguments? */
function readOnlyClassifierAccepts(name: string): boolean {
  // When the assignment is recognised it is skipped and the real binary (`ls`,
  // read-only) is classified; when it is not, the peel stops and the command
  // falls to the module's unknown-is-a-write default.
  return isReadOnlyBashCommand(`env ${name}=x ls`);
}

/** Does command-normalize.ts peel `name=x` as a leading assignment? */
function normaliserAccepts(name: string): boolean {
  const command = `${name}=x git status`;
  return normalizeCommand(command).normalized !== command;
}

describe("cross-module agreement: POSIX variable-name grammar in a leading assignment", () => {
  it.each(CASES)(
    "$name is $accepted in all three modules alike ($why)",
    ({ name, accepted }) => {
      expect(prefixParserAccepts(name), "bash-prefix-parse.ts").toBe(accepted);
      expect(readOnlyClassifierAccepts(name), "read-only-bash.ts").toBe(accepted);
      expect(normaliserAccepts(name), "command-normalize.ts").toBe(accepted);
    },
  );

  it("every PROBE returns both verdicts across the corpus, so none can have gone constant", () => {
    // Asserting this per PROBE, not over CASES: a check on the literal array
    // would only restate how the array was written and could never observe a
    // degenerate probe. This observes the functions.
    const probes = {
      "bash-prefix-parse.ts": prefixParserAccepts,
      "read-only-bash.ts": readOnlyClassifierAccepts,
      "command-normalize.ts": normaliserAccepts,
    };
    for (const [module, probe] of Object.entries(probes)) {
      const answers = CASES.map((c) => probe(c.name));
      expect(answers, `${module} never accepted anything`).toContain(true);
      expect(answers, `${module} never rejected anything`).toContain(false);
    }
  });
});
