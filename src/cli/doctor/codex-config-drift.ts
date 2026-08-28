// Codex counterpart of settings-drift.ts (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, threat model (c),
// "Audit and doctor"), follow-up of slice 2 (agent-tasks f59ea0eb).
// Measured basis: dogfood/ug-auto-mode-signals/README.md sections (k)
// and (l): a config-derived `approval_policy = "never"` in Codex's
// `config.toml` makes EVERY Codex session emit `permission_mode:
// bypassPermissions` on `PreToolUse` (`exec-never-ws`, `exec-never-full`,
// `config-never-full`, `config-never-ws`, `tui-config-never`,
// `tui-config-never-ws`, `tui-never` rows), and a full-access
// `default_permissions` selection does the same
// (`config-perm-fullaccess`: `default_permissions = ":danger-full-access"`
// -> `bypassPermissions`). Either key pre-sets the trusted `when`-allowlist
// signal the Codex auto-approval path (`src/cli/pack/auto-approve-path.ts`,
// `CODEX_HARNESS`) consumes, the same way `permissions.defaultMode` does
// for Claude Code (settings-drift.ts's module header, threat model (c)).
//
// Gated on the pack's `auto_approve.harnesses` actually listing `codex`
// (`isCodexOptedIntoAutoApprove` below): a repo that never opted Codex
// into the auto path has no live Codex `permission_mode` signal for this
// key to pre-set, so warning there would be noise unconnected to any
// live risk (mirrors the per-harness gate `attemptAutoApproval` itself
// applies before the `when` allowlist, `auto-approve.ts`'s module
// header).
//
// Unlike settings-drift.ts's `permissions.defaultMode` check, this is
// NOT drift-gated (warn only when the live value differs from the
// apply-time baseline): `approval_policy = "never"` is a real live risk
// the moment it is present, whether or not it was already there at the
// last `harness apply`, so this check always warns while present and
// opted in. The apply-time snapshot only ANNOTATES the warning (AC 3):
// harness never snapshots the operator's live, whole `config.toml` (only
// `harness apply --runtime codex --install`'s own generated hook block,
// merged in place by `install-codex-config.ts`, ever lands in
// `.last-apply`'s `"codex/config.toml"` entry, and `apply.ts` never
// records a `kind: "target"` lock entry for the installed Codex config
// path the way it does for Claude Code's `--target` write), so today
// every warning below carries the "no apply snapshot" annotation; the
// target-lock lookup is kept anyway so a future apply-time Codex target
// entry would make the annotation meaningful without a second change
// here.
//
// Fail-open, like every other doctor check in this family: a missing or
// unreadable candidate file resolves to "nothing to report" for that
// file, and a candidate whose TOML this module's minimal scanner cannot
// make sense of (an unterminated quoted string) resolves to ONE
// diagnostic line, never a thrown error.
//
// No full TOML parser: none is a dependency of this package (checked
// before writing this file), and `install-codex-config.ts` itself never
// parses the operator's config.toml into an object either, it locates
// harness's own managed block by string search. This module only needs
// two ROOT-LEVEL (not inside any `[table]`) string-valued keys, so a
// small line-oriented scanner is enough; it does not attempt custom
// `[profiles.*]` tables (out of scope, see the task's constraints).

import * as fs from "node:fs";
import * as path from "node:path";
import { readLastApply } from "../../io/last-apply.js";
import { PACK_NAME as UNDERSTANDING_PACK_NAME } from "../../policy-packs/builtin/understanding-before-execution.js";
import {
  CODEX_HARNESS,
  harnessAllowed,
  parseAutoApprove,
} from "../../policy-packs/builtin/understanding-before-execution/auto-approve.js";
import type { Manifest } from "../../schema/index.js";
import { targetLockAbsPaths, tildeize } from "./settings-drift.js";

export interface CodexConfigDriftSection {
  /** ⚠ lines; each rolls into warningCount. */
  warnings: string[];
}

interface CodexConfigCandidate {
  absolutePath: string;
  /** How the file is named in a warning line, never a raw machine path when avoidable. */
  displayLabel: string;
}

/**
 * Whether the manifest's `understanding-before-execution` pack has opted
 * Codex into the `auto_approve` path (`auto_approve.harnesses` contains
 * `"codex"`). Pure and side-effect-free: reuses the same fail-closed
 * parser the Codex PreToolUse hook itself consults
 * (`attemptAutoApproval` in `../pack/auto-approve-path.ts`), so a
 * malformed `auto_approve` block resolves to "not opted in" here too,
 * never a guess.
 */
export function isCodexOptedIntoAutoApprove(manifest: Manifest): boolean {
  const pack = manifest.policy_packs.find(
    (p) => p.name === UNDERSTANDING_PACK_NAME && p.enabled !== false,
  );
  if (!pack) return false;
  const cfg = parseAutoApprove(pack.config["auto_approve"], null);
  return harnessAllowed(cfg, CODEX_HARNESS);
}

/**
 * Scan the ROOT-LEVEL (before the first `[table]` header) `key = "..."`
 * assignments in a Codex `config.toml` body. Returns the string-valued
 * keys found, plus `malformed: true` when a candidate assignment opens a
 * quoted string that never closes on the same line (the one shape this
 * scanner treats as broken TOML rather than "not a string / not a key we
 * track"). Non-string values (numbers, booleans, arrays, inline tables)
 * are silently skipped, not flagged malformed: this scanner has no
 * opinion about them.
 */
function scanRootLevelStringKeys(raw: string): { values: Record<string, string>; malformed: boolean } {
  const values: Record<string, string> = {};
  let malformed = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // A `[table]` or `[[array-of-tables]]` header ends the root-level
    // scope for every key from here on; this module only tracks
    // root-level keys.
    if (line.startsWith("[")) break;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const valuePart = line.slice(eq + 1).trim();
    const parsed = matchTomlString(valuePart);
    if (parsed === null) {
      if (valuePart.startsWith('"') || valuePart.startsWith("'")) malformed = true;
      continue;
    }
    values[key] = parsed;
  }
  return { values, malformed };
}

/** A basic (`"..."`) or literal (`'...'`) single-line TOML string, or `null` if `value` is not one. */
function matchTomlString(value: string): string | null {
  if (value.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (!m) return null;
    return (m[1] ?? "")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'")) {
    const m = /^'([^']*)'/.exec(value);
    if (!m) return null;
    return m[1] ?? "";
  }
  return null;
}

/**
 * Annotate a warning with what the apply-time baseline knew, mirroring
 * settings-drift.ts's "absent at last apply" / "changed from X"
 * phrasing, plus the "no apply snapshot" fallback for when there is
 * nothing to compare against (see the module header: that is every
 * observable case today for Codex config, since `apply.ts` records no
 * `target` lock entry for the installed path).
 */
function annotate(hasSnapshot: boolean, baselineValue: string | undefined, liveValue: string): string {
  if (!hasSnapshot) return " (no apply snapshot for this file)";
  if (baselineValue === liveValue) return " (present at last apply)";
  if (baselineValue === undefined) return " (absent at last apply, appeared since)";
  return ` (changed from ${JSON.stringify(baselineValue)} since last apply)`;
}

function checkOneFile(
  file: CodexConfigCandidate,
  baseline: Record<string, string>,
  hasSnapshot: boolean,
  warnings: string[],
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file.absolutePath, "utf8");
  } catch {
    return;
  }
  const scan = scanRootLevelStringKeys(raw);
  if (scan.malformed) {
    warnings.push(`${file.displayLabel}: unreadable/invalid Codex config TOML`);
    return;
  }

  const approvalPolicy = scan.values["approval_policy"];
  if (approvalPolicy === "never") {
    warnings.push(
      `approval_policy = "never" set in ${file.displayLabel}${annotate(hasSnapshot, baseline["approval_policy"], approvalPolicy)}`,
    );
  }

  const defaultPermissions = scan.values["default_permissions"];
  if (defaultPermissions !== undefined && defaultPermissions.includes("danger-full-access")) {
    warnings.push(
      `default_permissions = ${JSON.stringify(defaultPermissions)} (full access) set in ${file.displayLabel}${annotate(hasSnapshot, baseline["default_permissions"], defaultPermissions)}`,
    );
  }
}

export interface BuildCodexConfigDriftOptions {
  /** `harness.generated/` for the manifest in use; `.last-apply` lives here. */
  generatedDir: string;
  /** `harness.lock` path for the manifest in use. */
  lockPath: string;
  /** Resolves the repo-scoped candidate file (`<cwd>/.codex/config.toml`). */
  cwd: string;
  /** Operator home; resolves the default `$CODEX_HOME` when the env var is unset. */
  home: string;
  /** Env for `CODEX_HOME` resolution. */
  env: NodeJS.ProcessEnv;
}

export function buildCodexConfigDrift(opts: BuildCodexConfigDriftOptions): CodexConfigDriftSection {
  const warnings: string[] = [];

  const lastApply = readLastApply(opts.generatedDir);
  let baseline: Record<string, string> = {};
  if (lastApply !== null) {
    const baselineRaw = lastApply.files["codex/config.toml"]?.content;
    if (baselineRaw !== undefined) {
      const scan = scanRootLevelStringKeys(baselineRaw);
      if (!scan.malformed) baseline = scan.values;
    }
  }

  const targetAbsPaths = targetLockAbsPaths(opts.lockPath);

  const codexHomeEnv = opts.env["CODEX_HOME"];
  const codexHomeFromEnv = typeof codexHomeEnv === "string" && codexHomeEnv.trim().length > 0;
  const codexHomeDir = codexHomeFromEnv ? (codexHomeEnv as string) : path.join(opts.home, ".codex");
  const codexHomeConfigPath = path.join(codexHomeDir, "config.toml");

  const candidates: CodexConfigCandidate[] = [
    {
      absolutePath: path.resolve(codexHomeConfigPath),
      displayLabel: codexHomeFromEnv
        ? "$CODEX_HOME/config.toml"
        : tildeize(codexHomeConfigPath, opts.home),
    },
    {
      absolutePath: path.resolve(opts.cwd, ".codex", "config.toml"),
      displayLabel: ".codex/config.toml",
    },
  ];

  for (const c of candidates) {
    const hasSnapshot = targetAbsPaths.has(c.absolutePath);
    checkOneFile(c, baseline, hasSnapshot, warnings);
  }

  return { warnings };
}
