import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { withFileLock } from "../../io/lock.js";
import { unifiedDiff } from "../../io/patch.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { parseManifest } from "../../schema/index.js";
import { applyAdd } from "../add/mutate.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";
import {
  computeDrift,
  manifestProjection,
  parseSettingsHooks,
  synthesizeName,
  type DerivedHook,
} from "./derive.js";

export interface AdoptOptions {
  configPath?: string;
  homeDir?: string;
  yes?: boolean;
  /** Optional injection point for tests; defaults to readline against stdin. */
  prompt?: (message: string) => Promise<string>;
}

export interface AdoptResult {
  manifestPath: string;
  settingsPath: string;
  driftCount: number;
  /** The unified diff of the proposed change. Empty when nothing to adopt. */
  diff: string;
  applied: boolean;
  /** Names synthesised for the new manifest entries. */
  adoptedNames: string[];
  /** Human-readable status: "no-drift" | "declined" | "applied". */
  outcome: "no-drift" | "declined" | "applied";
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveManifestPath(opts: AdoptOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(opts.homeDir ?? path.join(os.homedir(), ".claude"), DEFAULT_BASENAME);
}

async function defaultPrompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

export async function adopt(
  settingsPath: string,
  opts: AdoptOptions = {},
): Promise<AdoptResult> {
  const manifestPath = resolveManifestPath(opts);
  if (!fs.existsSync(manifestPath)) {
    throw new HarnessExitError(
      `harness manifest not found at ${manifestPath}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }
  if (!fs.existsSync(settingsPath)) {
    throw new HarnessExitError(
      `cannot adopt: file does not exist: ${settingsPath}`,
      EX_NOINPUT,
    );
  }

  const originalYaml = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(parseYaml(originalYaml));
  const projection = manifestProjection(manifest);

  let settingsRaw: unknown;
  try {
    settingsRaw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (e) {
    throw new HarnessExitError(
      `cannot adopt: ${settingsPath} is not valid JSON: ${(e as Error).message}`,
      EX_FAIL,
    );
  }

  const settingsHooks = parseSettingsHooks(settingsRaw);
  const drift = computeDrift(settingsHooks, projection);

  if (drift.length === 0) {
    return {
      manifestPath,
      settingsPath,
      driftCount: 0,
      diff: "",
      applied: false,
      adoptedNames: [],
      outcome: "no-drift",
    };
  }

  const taken = new Set(manifest.hooks.map((h) => h.name));
  const adoptedNames: string[] = [];
  let proposedYaml = originalYaml;
  for (const d of drift) {
    const name = synthesizeName(d, taken);
    taken.add(name);
    adoptedNames.push(name);
    proposedYaml = applyAdd(proposedYaml, {
      type: "hook",
      entry: buildHookEntry(name, d),
    });
  }

  const diff = unifiedDiff({
    fileName: path.basename(manifestPath),
    oldText: originalYaml,
    newText: proposedYaml,
    oldHeader: "current",
    newHeader: "proposed",
  });

  // Defence-in-depth gate. From a happy-path adopt (well-formed input manifest +
  // well-formed settings.json) every synthesised hook field is already
  // schema-valid by construction (event from KNOWN_EVENTS, non-empty command,
  // disambiguated name, blocking:false). The gate is here to catch structural
  // bugs in synthesizeName / applyAdd that future maintainers might introduce.
  const validation = validateBeforeWrite(parseYaml(proposedYaml));
  if (!validation.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(validation.errors)}`,
      EX_FAIL,
    );
  }

  if (!opts.yes) {
    const promptFn = opts.prompt ?? defaultPrompt;
    const answer = (await promptFn(`${diff}\nApply (y/N)? `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return {
        manifestPath,
        settingsPath,
        driftCount: drift.length,
        diff,
        applied: false,
        adoptedNames,
        outcome: "declined",
      };
    }
  }

  const lockPath = path.join(path.dirname(manifestPath), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    const current = fs.readFileSync(manifestPath, "utf8");
    let next = current;
    const currentManifest = parseManifest(parseYaml(current));
    const lockTaken = new Set(currentManifest.hooks.map((h) => h.name));
    for (let i = 0; i < drift.length; i++) {
      const d = drift[i]!;
      const name = adoptedNames[i]!;
      // If a concurrent adopt landed the same drift, skip silently rather than
      // duplicating. This makes adopt idempotent across repeated runs.
      // KNOWN GAP: a concurrent adopt that resolved the same drift to a
      // *different* name (e.g. our `foo` vs their `foo-2`) would NOT be caught
      // here — both would land as separate hooks with different names. Schema
      // accepts it (no name collision), but the manifest contains two entries
      // pointing at the same command. Acceptable rarity for Phase 2; revisit
      // when a SHA-based drift identity ships in Phase 3 alongside harness.lock.
      if (lockTaken.has(name)) continue;
      next = applyAdd(next, { type: "hook", entry: buildHookEntry(name, d) });
      lockTaken.add(name);
    }
    const recheck = validateBeforeWrite(parseYaml(next));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(manifestPath, next);
  });

  return {
    manifestPath,
    settingsPath,
    driftCount: drift.length,
    diff,
    applied: true,
    adoptedNames,
    outcome: "applied",
  };
}

function buildHookEntry(
  name: string,
  d: DerivedHook,
): { name: string; event: string; command: string; match?: string; blocking: false } {
  // Adopted hooks default to non-blocking so the captured entry doesn't
  // unexpectedly start gating tool calls. The user can promote to soft/hard
  // explicitly if they want enforcement.
  const entry: { name: string; event: string; command: string; match?: string; blocking: false } = {
    name,
    event: d.event,
    command: d.command,
    blocking: false,
  };
  if (d.match !== undefined) entry.match = d.match;
  return entry;
}
