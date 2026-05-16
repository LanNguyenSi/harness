import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { withFileLock } from "../../io/lock.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { parse as parseYaml } from "yaml";
import { EX_FAIL, EX_SOFTWARE, HarnessExitError } from "../exit-codes.js";
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
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function defaultHome(opts: InitOptions): string {
  return opts.homeDir ?? path.join(os.homedir(), ".claude");
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

  const stderr = exists ? `(overwriting existing manifest at ${target})\n` : "";
  const stdout = [
    `harness manifest written to ${target} (template: ${templateLabel})`,
    "",
    "Next steps:",
    `  harness validate --config ${target}`,
    `  harness describe --config ${target}`,
    `  harness doctor   --config ${target}`,
    "",
  ].join("\n");

  return { path: target, template: templateLabel, overwrote: exists, stdout, stderr };
}

export const KNOWN_TEMPLATES: TemplateName[] = ["minimal", "solo", "team", "full"];

export function isTemplate(s: string): s is TemplateName {
  return (KNOWN_TEMPLATES as string[]).includes(s);
}
