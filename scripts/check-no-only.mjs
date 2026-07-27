#!/usr/bin/env node
// CI gate against a committed `.only` under tests/ (task b4845053, closing
// the gap review round 4 of task 052f9d5b flagged and deliberately left
// open — see tests/_helpers/hermetic-spawn-allowlist.ts's "Known gap"
// comment). Reproduced against vitest 4.1.8: a file carrying
// `describe.only` whose selected tests are ALL skipped disables BOTH
// layers of the hermetic-spawn backstop at once (only-mode filters the
// setup-injected `it()` out of the run, and `afterAll` never fires because
// nothing executed) — and the overall `vitest run` still exits 0 despite a
// swallowed collection-phase violation. The repo has no ESLint at all
// (no config, no lint script), so eslint-plugin-no-only-tests is not an
// available guard; this script is the dedicated, ESLint-free fix that
// comment calls for.
//
// Parses each file with the TypeScript compiler API (already a
// devDependency, used here purely as a library — no extra install, no
// spawned process) instead of a hand-rolled string/comment stripper: the
// AST separates string, template, and comment trivia from real code by
// construction, so a `.only` typed inside a test *name*, a code comment,
// or a string literal can never be mistaken for a real
// `describe`/`it`/`test` call — the false-positive risk the task
// explicitly weighs above catching every syntactic variant ("one false
// positive gets the gate bypassed instead of repaired"). Whitespace around
// the dot or before the call's `(` is likewise irrelevant to the AST, so
// variants like `it.only (` need no special-casing.
//
// Two independent shapes are matched, both catching real vitest bypasses
// review found while validating this gate:
//   1. The PROPERTY NAME `only` reached from a `describe`/`it`/`test`-
//      rooted access chain (walking down through any number of chained
//      modifiers, e.g. `it.concurrent.only`) — catches the `.each`
//      variants (`it.only.each`, `describe.only.each`, `test.only.each`)
//      for free, since `.each` is just one more link on the same chain.
//   2. The options-object form `it("name", { only: true }, fn)` (and the
//      `test`/`describe` equivalents) — vitest's documented TestOptions
//      second positional argument. Empirically confirmed (task b4845053
//      review) to independently activate only-mode: it filters the
//      setup-injected hermetic-spawn backstop test out of the run just
//      like `it.only(...)` does, and shape (1) above does not see it
//      (there is no PropertyAccessExpression named `only` anywhere in
//      that call). Scoped tightly to preserve precision: only a DIRECT,
//      non-computed `only: true` property literal on the object literal
//      in the call's 2nd argument position counts — no nested objects
//      (`{ retry: { only: true } }` does not count, since `only` there is
//      not a direct property of the options object), no computed keys,
//      and no non-literal value (`only: someVar` does not count, since a
//      non-`true` runtime value can't be confirmed statically).
//
// Known bypasses (accepted, low realistic likelihood): this gate trades
// exhaustive coverage of every way vitest can be told to run a subset of
// tests for precision (a false positive gets the gate bypassed rather than
// repaired — see the task rationale above). Deliberately NOT covered:
//   - bracket/computed property access: describe["only"](...)
//   - aliasing the holder: const d = describe; d.only(...)
//   - renamed imports: import { it as x } from "vitest"; x.only(...)
//   - bench.only(...) (vitest's benchmark API, a different global than
//     describe/it/test)
//   - the options-object form reached through a chained call, e.g.
//     it.each([...])("name", { only: true }, fn) — the outer call's
//     callee is itself a CallExpression (`it.each([...])`), not a bare
//     describe/it/test identifier chain, so it doesn't resolve to a
//     holder name
// None of these appear anywhere in this repo's tests/ today (verified by
// running this gate against the current tree with 0 violations).
//
// Runs in a single source-scan pass, no second suite run: parsing every
// file under tests/ with the TS compiler is a sub-second operation for
// this repo's size (~60k lines across ~170 files).

import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ONLY_HOLDERS = new Set(["describe", "it", "test"]);
const TEST_SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

/** Recursively collects TypeScript source file paths under `dir`. */
export function collectTestSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestSourceFiles(full, out);
    } else if (entry.isFile() && TEST_SOURCE_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walks down a (possibly chained) PropertyAccessExpression to its
 * left-most identifier, e.g. the `expression` of `describe.concurrent`
 * within `describe.concurrent.only` resolves to the identifier
 * `describe`; the (already bare) callee of `it(...)` resolves to `it`
 * directly (the loop body never runs). Returns null when the chain does
 * not bottom out on a bare identifier (e.g. a call result, `foo().only`,
 * or `it.each([...])(...)` where the callee is itself a CallExpression).
 */
function rootIdentifierName(expr) {
  let cur = expr;
  while (ts.isPropertyAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

/**
 * True when `objectLiteral` has a DIRECT (non-computed, non-nested,
 * non-shorthand) property named `only` whose value is the literal `true`.
 * Deliberately narrow — see the "options-object form" note above.
 */
function hasDirectOnlyTrueProperty(objectLiteral) {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      // Excludes shorthand (`{ only }`, value not statically a literal),
      // spread (`{ ...opts }`), and method/get/set properties.
      continue;
    }
    if (ts.isComputedPropertyName(prop.name)) {
      continue;
    }
    const keyText = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (keyText !== "only") {
      continue;
    }
    if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
  }
  return false;
}

/**
 * Returns every real-code (never string/template/comment) `.only` access
 * found in `source`: both `(describe|it|test)[.chain].only[.each]`
 * PropertyAccessExpressions and `(describe|it|test)(name, { only: true },
 * fn)` options-object CallExpressions. See the module header for the
 * precision rationale behind each shape's scope.
 */
export function findOnlyViolations(source, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "only") {
      const holder = rootIdentifierName(node.expression);
      if (holder && ONLY_HOLDERS.has(holder)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
        violations.push({ line: pos.line + 1, column: pos.character + 1, holder, kind: "only-chain" });
      }
    } else if (ts.isCallExpression(node)) {
      const holder = rootIdentifierName(node.expression);
      const optionsArg = node.arguments[1];
      if (holder && ONLY_HOLDERS.has(holder) && optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
        if (hasDirectOnlyTrueProperty(optionsArg)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(optionsArg.getStart(sourceFile));
          violations.push({ line: pos.line + 1, column: pos.character + 1, holder, kind: "options-object" });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/** Formats one violation into the human-readable failure line main() prints. */
function formatViolation(file, v) {
  const what = v.kind === "options-object" ? `${v.holder}(..., { only: true }, ...)` : `${v.holder}.only`;
  return `${file}:${v.line}:${v.column} — committed \`${what}\``;
}

export function main(testsDir) {
  const files = collectTestSourceFiles(testsDir);
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const v of findOnlyViolations(source, file)) {
      failures.push(formatViolation(file, v));
    }
  }
  if (failures.length > 0) {
    console.error(`check-no-only: FAIL — ${failures.length} committed .only occurrence(s) under tests/:`);
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    console.error(
      "check-no-only: remove .only before committing — it silently narrows the suite and can defeat the " +
        "hermetic-spawn backstop (see tests/_helpers/hermetic-spawn-allowlist.ts).",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`check-no-only: OK — scanned ${files.length} file(s) under tests/, no committed .only`);
}

// Only auto-run when invoked directly (not when imported by tests) — same
// guard as scripts/check-ug-schema-drift.mjs.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main("tests");
}
