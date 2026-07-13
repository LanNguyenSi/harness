import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { withFileLock } from "../../io/lock.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { parse as parseYaml } from "yaml";
import { EX_FAIL, EX_SOFTWARE, HarnessExitError } from "../exit-codes.js";
import { parseManifest } from "../../schema/index.js";
import { checkBinResolution, formatBinResolutionIssues } from "../doctor/index.js";
import type { NpmExec } from "../doctor/npm-bin-path.js";
import { getTemplate, type TemplateName } from "./templates.js";

export interface InitOptions {
  template?: TemplateName;
  /**
   * Pre-composed manifest YAML; bypasses the template lookup. Used by
   * the interactive Custom-profile composer (task 31d2fbb5) so the same
   * lock + validateBeforeWrite + overwrite-guard path is reused without
   * needing a second write surface.
   */
  content?: string;
  /**
   * Label surfaced to the operator and recorded on `InitResult.template`
   * when `content` is provided (the YAML carries no template name of its
   * own). Defaults to `"custom"`.
   */
  contentLabel?: string;
  force?: boolean;
  configPath?: string;
  homeDir?: string;
  /**
   * Test-injection knobs for the post-write bin-resolution check (task
   * 7f8fb4bc). Production leaves both undefined and gets the real PATH /
   * `npm prefix -g` spawn.
   */
  pathEnv?: string;
  npmBinExec?: NpmExec;
}

export interface InitResult {
  path: string;
  /**
   * The template name written, or `contentLabel` (default "custom")
   * when the caller passed `content` instead of selecting a preset.
   */
  template: TemplateName | string;
  overwrote: boolean;
  stdout: string;
  stderr: string;
  /**
   * Count of declared, enabled MCP binaries and REQUIRED CLI binaries
   * that do not resolve on PATH right after the write (task 7f8fb4bc).
   * Non-interactive `init` deliberately does not throw on this — a bare
   * `harness init --template full` is expected to be followed by a
   * separate dependency install before `harness apply` / `harness
   * doctor`, unlike the interactive wizard which already offers to
   * install deps first. 0 when every binary resolves (or none declared).
   */
  binResolutionErrorCount: number;
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function defaultHome(opts: InitOptions): string {
  return resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path;
}

function resolveTargetPath(opts: InitOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(defaultHome(opts), DEFAULT_BASENAME);
}

export async function init(opts: InitOptions = {}): Promise<InitResult> {
  const target = resolveTargetPath(opts);
  // When the caller supplied pre-composed YAML, use it verbatim and
  // record the contentLabel (default "custom") in the result. Otherwise
  // fall back to the named-template path.
  const usingContent = opts.content !== undefined;
  const templateLabel: TemplateName | string = usingContent
    ? opts.contentLabel ?? "custom"
    : opts.template ?? "minimal";
  const content = usingContent
    ? (opts.content as string)
    : getTemplate(opts.template ?? "minimal");

  // Validate before any disk work. For named templates a failure is a
  // code bug; for composer output it's also a code bug (the composer is
  // expected to emit validate-clean YAML). Either way we want to fail
  // loud BEFORE clobbering the on-disk manifest.
  const validation = validateBeforeWrite(parseYaml(content));
  if (!validation.ok) {
    throw new HarnessExitError(
      `${usingContent ? "composed manifest" : `template "${templateLabel}"`} failed validation:\n${formatValidationErrors(validation.errors)}`,
      EX_SOFTWARE,
    );
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  // Existence check + write inside the lock so two concurrent `init` calls
  // can't both pass the !force guard and clobber each other.
  let exists = false;
  await withFileLock(lockPath, () => {
    exists = fs.existsSync(target);
    if (exists && !opts.force) {
      throw new HarnessExitError(
        `harness manifest already exists at ${target}; pass --force to overwrite`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, content);
  });

  // Bin-resolution check (task 7f8fb4bc): validateBeforeWrite only checked
  // the manifest's shape, not whether the binaries it declares actually
  // resolve. Re-parsing here is cheap (validateBeforeWrite already proved
  // it parses clean) and lets a fresh `harness init` surface an
  // unresolvable MCP/CLI binary immediately — including the PATH-shadow
  // case (installed, but under a dir not on PATH) that used to only show
  // up later as an opaque `harness doctor` crash.
  const manifest = parseManifest(parseYaml(content));
  const binReport = await checkBinResolution(manifest, {
    ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    ...(opts.npmBinExec !== undefined ? { npmBinExec: opts.npmBinExec } : {}),
  });

  let stderr = exists ? `(overwriting existing manifest at ${target})\n` : "";
  if (binReport.errorCount > 0) {
    stderr += `${formatBinResolutionIssues(binReport).join("\n")}\n`;
    stderr +=
      "\nSome declared binaries are not resolvable; install them or fix PATH, then re-run `harness doctor`.\n";
  }
  const stdout = [
    `harness manifest written to ${target} (template: ${templateLabel})`,
    "",
    "Next steps:",
    `  harness validate --config ${target}`,
    `  harness describe --config ${target}`,
    `  harness doctor   --config ${target}`,
    "",
  ].join("\n");

  return {
    path: target,
    template: templateLabel,
    overwrote: exists,
    stdout,
    stderr,
    binResolutionErrorCount: binReport.errorCount,
  };
}

export const KNOWN_TEMPLATES: TemplateName[] = ["minimal", "solo", "team", "full"];

export function isTemplate(s: string): s is TemplateName {
  return (KNOWN_TEMPLATES as string[]).includes(s);
}
