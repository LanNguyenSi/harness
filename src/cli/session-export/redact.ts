import type { RedactRule } from "../../schema/audit.js";

/**
 * Default regex denylist — applied even when the manifest declares no
 * `audit.redact[]`. Catches the four obvious patterns called out in the
 * design discussion: token, secret, password, api_key. Conservative on
 * purpose: matches `key: value` / `key=value` and replaces the value
 * with `<REDACTED>`.
 */
export const DEFAULT_REGEX_RULES: { regex: string; flags: string; replacement: string }[] = [
  {
    regex: "(token|secret|password|api[_-]?key)([\"']?\\s*[:=]\\s*[\"']?)[^\\s\"',}]+",
    flags: "gi",
    replacement: "$1$2<REDACTED>",
  },
];

export interface ResolvedRule {
  pattern: RegExp;
  replacement: string;
}

export interface ResolveRedactionOptions {
  env?: NodeJS.ProcessEnv;
}

export function resolveRedactionRules(
  manifestRules: RedactRule[],
  opts: ResolveRedactionOptions = {},
): ResolvedRule[] {
  const env = opts.env ?? process.env;
  const out: ResolvedRule[] = [];
  for (const def of DEFAULT_REGEX_RULES) {
    out.push({ pattern: new RegExp(def.regex, def.flags), replacement: def.replacement });
  }
  for (const rule of manifestRules) {
    if ("regex" in rule) {
      out.push({ pattern: new RegExp(rule.regex, "g"), replacement: rule.replacement });
    } else {
      const value = env[rule.env_var];
      if (typeof value !== "string" || value.length === 0) continue;
      out.push({
        pattern: new RegExp(escapeRegex(value), "g"),
        replacement: rule.replacement,
      });
    }
  }
  return out;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactString(input: string, rules: ResolvedRule[]): string {
  let out = input;
  for (const r of rules) {
    out = out.replace(r.pattern, r.replacement);
  }
  return out;
}
