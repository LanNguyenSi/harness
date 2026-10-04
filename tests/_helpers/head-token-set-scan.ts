import * as ts from "typescript";

/**
 * Structural (TypeScript compiler API) detection of exported head-token
 * shaped `Set` literals, used by the unregistered-set drift guard in
 * `tests/runtime/bash-match-head-token-drift.test.ts` (task 26c1d33e).
 *
 * A declaration is a candidate when ALL of these hold:
 *   - it is a top-level `export const NAME[: <any annotation>] = ...`
 *     VariableStatement (the `export` modifier is read from the AST, so a
 *     module-private `const` and text inside a string or comment never
 *     match);
 *   - its initializer is `new Set[<T>](<array literal>)`, with the
 *     constructor argument peeled of parentheses, `as` / `satisfies` /
 *     non-null assertions (so `[...] as const` is seen);
 *   - at least one array element is a string literal or a
 *     no-substitution template literal (backticks) whose text is a bare
 *     lowercase word (no leading `-`).
 *
 * Comments, type annotations (including union literals) and a trailing
 * comma are not AST nodes this scanner reads, so they cannot affect the
 * result.
 */

const BARE_WORD_RE = /^[a-z][a-z0-9_-]*$/;

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

function hasExportModifier(stmt: ts.VariableStatement): boolean {
  return (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function elementText(el: ts.Expression): string | undefined {
  const inner = unwrap(el);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  return undefined;
}

/**
 * Names of every exported bare-word-shaped `Set` literal declared at the
 * top level of `source`, in declaration order.
 */
export function findHeadTokenShapedSetNames(source: string, fileName = "input.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt) || !hasExportModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = unwrap(decl.initializer);
      if (!ts.isNewExpression(init)) continue;
      if (!ts.isIdentifier(init.expression) || init.expression.text !== "Set") continue;
      const arg = init.arguments?.[0];
      if (!arg) continue;
      const arr = unwrap(arg);
      if (!ts.isArrayLiteralExpression(arr)) continue;
      const texts = arr.elements.map(elementText);
      if (texts.some((t) => t !== undefined && BARE_WORD_RE.test(t))) {
        names.push(decl.name.text);
      }
    }
  }
  return names;
}
