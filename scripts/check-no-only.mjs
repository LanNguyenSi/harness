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
// Deliberately matches on the PROPERTY NAME `only` reached from a
// `describe`/`it`/`test`-rooted access chain (walking down through any
// number of chained modifiers, e.g. `it.concurrent.only`), not on a
// specific call shape — that also catches the `.each` variants
// (`it.only.each`, `describe.only.each`, `test.only.each`) for free, since
// `.each` is just one more link appended to the same chain.
//
// Runs in a single source-scan pass, no second suite run: parsing every
// file under tests/ with the TS compiler is a sub-second operation for
// this repo's size (~60k lines across ~170 files).

import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
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
 * `describe`. Returns null when the chain does not bottom out on a bare
 * identifier (e.g. a call result, `foo().only`).
 */
function baseHolderName(expr) {
  let cur = expr;
  while (ts.isPropertyAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

/**
 * Returns every `(describe|it|test)[.chain].only[.each]` access found in
 * `source` as real code — never inside a string, template, or comment,
 * because the TS parser does not surface those as PropertyAccessExpression
 * nodes.
 */
export function findOnlyViolations(source, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "only") {
      const holder = baseHolderName(node.expression);
      if (holder && ONLY_HOLDERS.has(holder)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
        violations.push({ line: pos.line + 1, column: pos.character + 1, holder });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function main(testsDir) {
  const files = collectTestSourceFiles(testsDir);
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const v of findOnlyViolations(source, file)) {
      failures.push(`${file}:${v.line}:${v.column} — committed \`${v.holder}.only\``);
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

main("tests");
