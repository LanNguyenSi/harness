import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { atomicWriteFile } from "../io/atomic-write.js";
import type { Manifest } from "../schema/index.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface ExportOptions extends LoaderOptions {
  json?: boolean;
  sanitize?: boolean;
  outputPath?: string;
}

export interface ExportResult {
  output: string;
  manifest: Manifest;
  sanitized: boolean;
  wroteTo: string | null;
}

const SECRET_KEY_PATTERN = /(?:_|^)(KEY|TOKEN|SECRET|PASSWORD|API_KEY)$/i;
const REDACTED = "<REDACTED>";

export const SANITIZE_FOOTER =
  "# sanitised: /home/<user>/ paths replaced with ~/; env values whose key " +
  "matches /(_|^)(KEY|TOKEN|SECRET|PASSWORD|API_KEY)$/i are redacted. The " +
  "sanitiser does NOT touch secrets in command:[] arrays or in policy " +
  "`requires.ledger_tag` values; review before sharing.";

export function exportManifest(opts: ExportOptions = {}): ExportResult {
  const { manifest } = loadManifest(opts);
  const projection: Record<string, unknown> = manifest as unknown as Record<string, unknown>;
  const projected = opts.sanitize ? sanitize(projection, os.homedir()) : projection;

  let output: string;
  if (opts.json) {
    output = JSON.stringify(projected, null, 2);
    if (!output.endsWith("\n")) output += "\n";
  } else {
    output = stringifyYaml(projected, {
      lineWidth: 0,
      flowCollectionPadding: false,
    });
    if (opts.sanitize) output += `\n${SANITIZE_FOOTER}\n`;
  }

  let wroteTo: string | null = null;
  if (opts.outputPath) {
    const target = path.resolve(opts.outputPath);
    atomicWriteFile(target, output);
    wroteTo = target;
  }

  return { output, manifest, sanitized: !!opts.sanitize, wroteTo };
}

/**
 * Best-effort sanitiser. Walks the manifest, replaces `/home/<user>/...` paths
 * with `~/...` and redacts env values whose key looks credential-shaped. Does
 * NOT touch command:[] entries (they often contain absolute paths that are
 * intentional and not secret) and does NOT inspect policy ledger_tag values.
 */
export function sanitize(value: unknown, homeDir: string): unknown {
  return walk(value, homeDir, []);
}

function walk(value: unknown, homeDir: string, pathSegs: (string | number)[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, homeDir, [...pathSegs, i]));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isInsideEnvBlock(pathSegs) && SECRET_KEY_PATTERN.test(k) && typeof v === "string") {
        out[k] = REDACTED;
      } else {
        out[k] = walk(v, homeDir, [...pathSegs, k]);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return rewriteHomePath(value, homeDir);
  }
  return value;
}

function isInsideEnvBlock(pathSegs: (string | number)[]): boolean {
  // Immediate parent key must be `env` — i.e. we're walking a {KEY: value}
  // map directly under an env: section. Today that's only `tools.mcp[].env`.
  return pathSegs[pathSegs.length - 1] === "env";
}

function rewriteHomePath(s: string, homeDir: string): string {
  if (homeDir.length === 0 || homeDir === "/") return s;
  const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Lookahead `/` or end-of-string so `/home/lan` does not match inside
  // `/home/landscape`. We deliberately don't use \b — the homeDir's last char
  // could be a "word" character that erases the boundary semantics on a
  // following slash.
  return s.replace(new RegExp(`${escaped}(?=/|$)`, "g"), "~");
}

export const __testables = { sanitize, rewriteHomePath, isInsideEnvBlock, SECRET_KEY_PATTERN };
