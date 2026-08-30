// `harness pack upgrade <name>`: text-level insertion of a pack's
// missing default config block into an existing manifest, WITHOUT
// parsing and reserializing the operator's YAML (unlike `pack add` /
// `pack reseed`, which both mutate via the `yaml` Document API). Task
// 8f637efd: the one upgrade this ships is `auto_approve` for
// `understanding-before-execution` (D-004,
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Amendment:
// install default").
//
// WHY TEXT-LEVEL, NOT DOCUMENT-LEVEL. The `yaml` package's Document API
// (`withDocument`, used by `pack reseed`) round-trips comments
// reasonably well for a single field REPLACEMENT, but this upgrade
// INSERTS a brand-new key with its own multi-line comment block into an
// operator manifest that may carry hand edits `pack add` / `reseed`
// never touch (custom producers, an extra top-level key, a reordered
// field). Re-serializing the whole document risks reformatting content
// this verb has no business touching. Insertion by line position,
// guided by indentation, keeps every byte outside the inserted block
// untouched.
//
// IDEMPOTENT. If `auto_approve:` already exists anywhere inside the
// pack's `config:` mapping (any indentation), this is a no-op: the
// output is byte-identical to the input. An operator who already
// hand-applied the workaround (the ADR's own "Workaround, bereits
// angewendet" paragraph) gets nothing rewritten out from under them.
//
// REFUSES ON AMBIGUITY. Zero or more than one
// `understanding-before-execution` pack block, more than one `config:`
// key inside it, or no `config:` key found at all, is a refusal
// (non-zero exit, a clear message), never a guess at where to insert.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { unifiedDiff } from "../../io/patch.js";
import { withFileLock } from "../../io/lock.js";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../io/validate-before-write.js";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { renderAutoApproveSnippet } from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { EX_FAIL, EX_NOINPUT, HarnessExitError } from "../exit-codes.js";

/** Pack names this verb knows how to upgrade. Grows as more upgrades ship. */
export type PackUpgradeName = "understanding-before-execution";

export interface PackUpgradeOptions {
  configPath?: string;
  homeDir?: string;
  dryRun?: boolean;
}

export interface PackUpgradeResult {
  path: string;
  name: string;
  diff: string;
  /** True when the manifest was actually written. */
  applied: boolean;
  /** True when the block was already present: a byte-identical no-op. */
  alreadyPresent: boolean;
}

const DEFAULT_BASENAME = "harness.yaml";
const LOCK_BASENAME = ".harness.lock";

function resolveTargetPath(opts: PackUpgradeOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(
    resolveHomeDir({ ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}) }).path,
    DEFAULT_BASENAME,
  );
}

function countLeadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

export type ApplyAutoApproveUpgradeResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: string };

/**
 * Text-level insertion of the `auto_approve` default snippet into the
 * `understanding-before-execution` pack's `config:` mapping. Pure: text
 * in, text (+ a change flag) out, or an error string on ambiguity.
 * Exported for direct unit testing without going through the CLI/file
 * layer.
 */
/**
 * The line ending most of `text` uses, so an insertion into a CRLF
 * manifest does not mix in bare-LF lines (task 8f637efd review round 2
 * F6): counts `\r\n` occurrences against LF-only ones (every `\n` not
 * part of a `\r\n` pair) and picks whichever is more common, defaulting
 * to `\n` on a tie or an all-LF file.
 */
function detectDominantEol(text: string): "\n" | "\r\n" {
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const totalLf = (text.match(/\n/g) ?? []).length;
  const lfOnlyCount = totalLf - crlfCount;
  return crlfCount > lfOnlyCount ? "\r\n" : "\n";
}

export function applyAutoApproveUpgrade(original: string): ApplyAutoApproveUpgradeResult {
  const eol = detectDominantEol(original);
  // Split on either line ending so every line in `lines` is `\r`-free
  // (its own trailing `\r`, if any, is consumed by the delimiter, not
  // left dangling on the line content); the array is rejoined with the
  // detected `eol` below, so a CRLF manifest stays CRLF end to end
  // instead of picking up bare-LF lines from the inserted snippet.
  const lines = original.split(/\r\n|\n/);

  // Accepts a bare, double-quoted, or single-quoted scalar for the pack
  // name (task 8f637efd review round 2 F4): `- name: understanding-before-execution`,
  // `- name: "understanding-before-execution"`, and
  // `- name: 'understanding-before-execution'` are all schema-valid YAML
  // for the same value; the bare-only form previously refused the
  // quoted spellings with "could not find a ... entry".
  const packNameRe =
    /^(\s*)-\s*name:\s*(?:"understanding-before-execution"|'understanding-before-execution'|understanding-before-execution)\s*(#.*)?$/;
  const packMatches: { index: number; indent: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = packNameRe.exec(lines[i] ?? "");
    if (m) packMatches.push({ index: i, indent: (m[1] ?? "").length });
  }
  if (packMatches.length === 0) {
    return {
      ok: false,
      error:
        "could not find a `- name: understanding-before-execution` policy_packs entry in this manifest",
    };
  }
  if (packMatches.length > 1) {
    return {
      ok: false,
      error: `found ${packMatches.length} \`understanding-before-execution\` policy_packs entries; refusing (ambiguous)`,
    };
  }
  const pack = packMatches[0]!;
  const itemIndent = pack.indent;

  function findBoundary(startIdx: number, indentThreshold: number): number {
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "") continue;
      if (countLeadingSpaces(line) <= indentThreshold) return i;
    }
    return lines.length;
  }

  const packEnd = findBoundary(pack.index + 1, itemIndent);

  const configIndent = itemIndent + 2;
  const configRe = /^config:\s*(#.*)?$/;
  let configIdx = -1;
  for (let i = pack.index + 1; i < packEnd; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (countLeadingSpaces(line) === configIndent && configRe.test(line.trim())) {
      if (configIdx !== -1) {
        return {
          ok: false,
          error:
            "found more than one `config:` key in the understanding-before-execution pack block; refusing (ambiguous)",
        };
      }
      configIdx = i;
    }
  }
  if (configIdx === -1) {
    return {
      ok: false,
      error: "could not find a `config:` key in the understanding-before-execution pack block",
    };
  }

  let lastContentIdx = configIdx;
  let autoApprovePresent = false;
  for (let i = configIdx + 1; i < packEnd; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const indent = countLeadingSpaces(line);
    if (indent <= configIndent) break;
    lastContentIdx = i;
    if (trimmed === "auto_approve:") autoApprovePresent = true;
  }

  if (autoApprovePresent) {
    return { ok: true, text: original, changed: false };
  }

  const snippetLines = renderAutoApproveSnippet(configIndent + 2).split("\n");
  const insertAt = lastContentIdx + 1;
  const next = [...lines.slice(0, insertAt), ...snippetLines, ...lines.slice(insertAt)];
  return { ok: true, text: next.join(eol), changed: true };
}

/**
 * `harness pack upgrade <name>` implementation. `name` is validated
 * against the (currently one-entry) set of known upgrades before any
 * file I/O; an unknown name refuses with `EX_FAIL` rather than silently
 * doing nothing.
 */
export async function packUpgrade(
  name: string,
  opts: PackUpgradeOptions = {},
): Promise<PackUpgradeResult> {
  if (name !== "understanding-before-execution") {
    throw new HarnessExitError(
      `harness pack upgrade does not support ${JSON.stringify(name)} yet; only "understanding-before-execution" (auto_approve default, task 8f637efd) is wired.`,
      EX_FAIL,
    );
  }

  const target = resolveTargetPath(opts);
  if (!fs.existsSync(target)) {
    throw new HarnessExitError(
      `harness manifest not found at ${target}; run \`harness init\` first`,
      EX_NOINPUT,
    );
  }

  const original = fs.readFileSync(target, "utf8");
  const result = applyAutoApproveUpgrade(original);
  if (!result.ok) {
    throw new HarnessExitError(`harness pack upgrade: ${result.error}`, EX_FAIL);
  }

  const diff = unifiedDiff({
    fileName: path.basename(target),
    oldText: original,
    newText: result.text,
    oldHeader: "current",
    newHeader: "proposed",
  });

  if (!result.changed) {
    return { path: target, name, diff, applied: false, alreadyPresent: true };
  }

  // Schema gate before ever touching disk, mirroring `pack add` / `pack
  // reseed`: catches an insertion that would somehow produce an invalid
  // manifest (e.g. a config: key this heuristic mis-located) before it
  // reaches the operator's file.
  const schemaResult = validateBeforeWrite(parseYaml(result.text));
  if (!schemaResult.ok) {
    throw new HarnessExitError(
      `proposed manifest fails schema validation:\n${formatValidationErrors(schemaResult.errors)}`,
      EX_FAIL,
    );
  }

  if (opts.dryRun) {
    return { path: target, name, diff, applied: false, alreadyPresent: false };
  }

  const lockPath = path.join(path.dirname(target), LOCK_BASENAME);
  await withFileLock(lockPath, () => {
    // Re-read and recompute under the lock (mirrors `pack add`): a
    // concurrent writer may have inserted the block (or changed the
    // file entirely) between the pre-lock read above and now.
    const current = fs.readFileSync(target, "utf8");
    const recomputed = applyAutoApproveUpgrade(current);
    if (!recomputed.ok) {
      throw new HarnessExitError(`harness pack upgrade: ${recomputed.error}`, EX_FAIL);
    }
    if (!recomputed.changed) return; // raced: someone else already inserted it
    const recheck = validateBeforeWrite(parseYaml(recomputed.text));
    if (!recheck.ok) {
      throw new HarnessExitError(
        `proposed manifest fails schema validation after lock acquisition:\n${formatValidationErrors(recheck.errors)}`,
        EX_FAIL,
      );
    }
    atomicWriteFile(target, recomputed.text);
  });

  return { path: target, name, diff, applied: true, alreadyPresent: false };
}
