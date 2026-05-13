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
  force?: boolean;
  configPath?: string;
  homeDir?: string;
}

export interface InitResult {
  path: string;
  template: TemplateName;
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
  const template: TemplateName = opts.template ?? "minimal";
  const content = getTemplate(template);

  // Validate the template before any disk work — a broken template is a code
  // bug, not a user error, but failing loud here makes that bug obvious.
  const validation = validateBeforeWrite(parseYaml(content));
  if (!validation.ok) {
    throw new HarnessExitError(
      `template "${template}" failed validation:\n${formatValidationErrors(validation.errors)}`,
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
    `harness manifest written to ${target} (template: ${template})`,
    "",
    "Next steps:",
    `  harness validate --config ${target}`,
    `  harness describe --config ${target}`,
    `  harness doctor   --config ${target}`,
    "",
  ].join("\n");

  return { path: target, template, overwrote: exists, stdout, stderr };
}

export const KNOWN_TEMPLATES: TemplateName[] = ["minimal", "solo", "team", "full"];

export function isTemplate(s: string): s is TemplateName {
  return (KNOWN_TEMPLATES as string[]).includes(s);
}
