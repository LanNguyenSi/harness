// Phase 4 #2 — trigger.extract evaluator
//
// TODO(Phase 4 #4): replace `src/schema/extract.ts` EXTRACT_ROOT_RE with
// a `parseExtractExpression`-backed `.refine`. The schema today rejects the
// bracket-quoted form this parser supports; #4 is when validate enhancements
// land and the two surfaces get unified.
//
// Implements the JSONPath-restricted DSL described in ARCHITECTURE.md §6
// "trigger.extract: generic variable extraction":
//
//   <namespace>.<segment>(<segment>)*
//
// where namespace ∈ { toolArgs, event, session, git } and a segment is either
// `.identifier` or `["quoted key"]` (single or double quotes). The grammar
// deliberately rejects function calls, numeric/slice indices, and any other
// JSON-Path constructs so validate-time analysis stays statically decidable.

const NAMESPACES = ["toolArgs", "event", "session", "git"] as const;
type Namespace = (typeof NAMESPACES)[number];

const NAMESPACE_RE = /^(toolArgs|event|session|git)\b/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMERIC_INDEX_RE = /^-?\d/;

export class ExtractGrammarError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(`extract expression "${expression}": ${message}`);
    this.name = "ExtractGrammarError";
  }
}

export type ExtractSegment =
  | { kind: "identifier"; key: string }
  | { kind: "bracket"; key: string };

export interface ExtractPath {
  namespace: Namespace;
  segments: ExtractSegment[];
}

export function parseExtractExpression(expr: string): ExtractPath {
  if (typeof expr !== "string" || expr.length === 0) {
    throw new ExtractGrammarError("expression must be a non-empty string", String(expr));
  }
  const rootMatch = NAMESPACE_RE.exec(expr);
  if (!rootMatch) {
    const ident = IDENTIFIER_RE.exec(expr);
    if (ident) {
      throw new ExtractGrammarError(`unknown namespace \`${ident[0]}\``, expr);
    }
    throw new ExtractGrammarError(
      "expression must begin with one of toolArgs / event / session / git",
      expr,
    );
  }
  const namespace = rootMatch[1] as Namespace;
  let i = rootMatch[0].length;

  const segments: ExtractSegment[] = [];
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ".") {
      i++;
      const id = IDENTIFIER_RE.exec(expr.slice(i));
      if (!id) {
        throw new ExtractGrammarError(`expected identifier after '.'`, expr);
      }
      i += id[0].length;
      if (expr[i] === "(") {
        throw new ExtractGrammarError("function calls not allowed", expr);
      }
      segments.push({ kind: "identifier", key: id[0] });
    } else if (ch === "[") {
      i++;
      const next = expr[i];
      if (next === undefined) {
        throw new ExtractGrammarError("unterminated bracket accessor", expr);
      }
      if (NUMERIC_INDEX_RE.test(next)) {
        throw new ExtractGrammarError("array indices not allowed", expr);
      }
      if (next !== '"' && next !== "'") {
        throw new ExtractGrammarError(
          "bracket accessor must be a quoted string key",
          expr,
        );
      }
      const quote = next;
      i++;
      const end = expr.indexOf(quote, i);
      if (end === -1) {
        throw new ExtractGrammarError("unterminated quoted bracket key", expr);
      }
      const key = expr.slice(i, end);
      if (key.length === 0) {
        throw new ExtractGrammarError("empty bracket key", expr);
      }
      i = end + 1;
      if (expr[i] !== "]") {
        throw new ExtractGrammarError("expected ']' after bracket key", expr);
      }
      i++;
      segments.push({ kind: "bracket", key });
    } else if (ch === "(") {
      throw new ExtractGrammarError("function calls not allowed", expr);
    } else {
      throw new ExtractGrammarError(`unexpected character '${ch}'`, expr);
    }
  }

  if (segments.length === 0) {
    throw new ExtractGrammarError(
      "expression must include at least one segment after the namespace",
      expr,
    );
  }

  return { namespace, segments };
}

export function validateExtractGrammar(expr: string): void {
  parseExtractExpression(expr);
}

export interface ExtractEventContext {
  toolArgs?: unknown;
  event?: unknown;
  session?: unknown;
  git?: unknown;
}

export interface ExtractBuiltins {
  SESSION_ID: string;
  REPO: string;
  BRANCH: string;
  TOOL_NAME: string;
  CWD: string;
}

export type ExtractTraceSource = "extract" | "builtin" | "missing";

export interface ExtractTraceEntry {
  var: string;
  expression: string;
  resolved: string;
  source: ExtractTraceSource;
}

export interface ExtractEvaluation {
  values: Record<string, string>;
  traceData: ExtractTraceEntry[];
}

function walkPath(path: ExtractPath, ctx: ExtractEventContext): unknown {
  let cursor: unknown = (ctx as Record<string, unknown>)[path.namespace];
  for (const seg of path.segments) {
    if (cursor === undefined || cursor === null) return undefined;
    if (typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg.key];
  }
  return cursor;
}

/**
 * Stringify a resolved extract value for substitution into a `${VAR}` template.
 * Strings pass through; numbers/booleans/bigints get `String(...)`. Objects and
 * arrays fall through to `JSON.stringify` — uncommon for v1 paths but stable
 * enough that audit / `explain --trace` consumers can rely on the shape.
 */
function stringifyResolved(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

const BUILTIN_NAMES: readonly (keyof ExtractBuiltins)[] = [
  "SESSION_ID",
  "REPO",
  "BRANCH",
  "TOOL_NAME",
  "CWD",
];

export function evaluateExtract(
  extracts: Record<string, string>,
  ctx: ExtractEventContext,
  builtins: ExtractBuiltins,
): ExtractEvaluation {
  const values: Record<string, string> = {};
  const traceData: ExtractTraceEntry[] = [];

  // Builtins first; an extract entry with the same name overrides both the
  // value and the trace row so the trace stays one-row-per-variable.
  for (const name of BUILTIN_NAMES) {
    if (Object.prototype.hasOwnProperty.call(extracts, name)) continue;
    const v = builtins[name];
    values[name] = v;
    traceData.push({
      var: name,
      expression: `<builtin:${name}>`,
      resolved: v,
      source: "builtin",
    });
  }

  for (const [varName, expr] of Object.entries(extracts)) {
    const path = parseExtractExpression(expr);
    const raw = walkPath(path, ctx);
    if (raw === undefined || raw === null) {
      const placeholder = `\${${varName}}`;
      values[varName] = placeholder;
      traceData.push({
        var: varName,
        expression: expr,
        resolved: placeholder,
        source: "missing",
      });
      continue;
    }
    const resolved = stringifyResolved(raw);
    values[varName] = resolved;
    traceData.push({
      var: varName,
      expression: expr,
      resolved,
      source: "extract",
    });
  }

  return { values, traceData };
}

const TEMPLATE_VAR_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export interface SubstituteTemplateResult {
  result: string;
  missing: string[];
}

export function substituteTemplate(
  template: string,
  values: Record<string, string>,
): SubstituteTemplateResult {
  const missing: string[] = [];
  const result = template.replace(TEMPLATE_VAR_RE, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name]!;
    }
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
  return { result, missing };
}

// ---------------------------------------------------------------------------
// trigger.input_match — literal equality predicate over the tool payload
// (task 2699b476)
// ---------------------------------------------------------------------------
//
// `trigger.match` filters on the tool NAME, `trigger.bash_match` on the
// shell command text. Neither can express "this MCP call, but only when
// one of its arguments has a particular value" — the shape
// `mcp__agent-tasks__task_finish` needs, where the same verb either
// merges the PR (`autoMerge: true`) or does not. `input_match` closes
// that gap with the narrowest possible primitive: a map from an extract
// expression (same grammar and parser as `trigger.extract`, restricted
// to the `toolArgs.` namespace by the schema) to a literal, ANDed
// together, compared by strict equality.
//
// Deliberately NOT a regex or a truthiness test: a gate that fires on
// `autoMerge: "false"` (string) or on any non-empty value would be a
// different gate than the one an operator read in the manifest. Strict
// equality means same JSON type AND same value; a path that is missing
// (or explicitly `null`) never matches, so an omitted argument leaves
// the narrower gate out of the way rather than silently arming it.

/** One `trigger.input_match` map: extract expression -> expected literal. */
export type InputMatchMap = Record<string, string | number | boolean>;

export interface InputMatchMismatch {
  /** The extract expression whose value did not equal the declared literal. */
  expression: string;
  /** The literal the policy declared. */
  expected: string | number | boolean;
  /** The value actually read from the event payload (`undefined` when absent). */
  actual: unknown;
  /** True when the path resolved to nothing at all (absent or null). */
  missing: boolean;
}

/**
 * Read the RAW (unstringified) value an extract expression points at.
 * `evaluateExtract` above stringifies for `${VAR}` substitution; an
 * equality predicate must not, or `true` and `"true"` would compare equal.
 */
export function resolveExtractPathValue(expr: string, ctx: ExtractEventContext): unknown {
  return walkPath(parseExtractExpression(expr), ctx);
}

/**
 * The FIRST entry of `inputMatch` that does not hold for this event, or
 * `null` when every entry holds (the trigger's input predicate passes).
 *
 * Fail direction on an unparseable expression: the entry is treated as
 * HOLDING, so a malformed `input_match` leaves the policy matching and
 * its `requires:` gate armed, rather than silently excusing the tool call
 * from a block gate. The schema rejects such an expression at parse time,
 * so this only guards hand-built `Manifest` objects (tests, embedders).
 */
export function firstInputMatchMismatch(
  inputMatch: InputMatchMap,
  ctx: ExtractEventContext,
): InputMatchMismatch | null {
  for (const [expression, expected] of Object.entries(inputMatch)) {
    let actual: unknown;
    try {
      actual = resolveExtractPathValue(expression, ctx);
    } catch {
      continue;
    }
    if (actual === undefined || actual === null) {
      return { expression, expected, actual, missing: true };
    }
    if (actual !== expected) {
      return { expression, expected, actual, missing: false };
    }
  }
  return null;
}
