// Codex counterpart of settings-drift.ts (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, threat model (c),
// "Audit and doctor"), follow-up of slice 2 (agent-tasks f59ea0eb).
//
// `approval_policy = "never"` is the MEASURED signal: dogfood/ug-auto-
// mode-signals/README.md section (l) (Codex TUI) shows `tui-config-never`
// (`config.toml`: `approval_policy = "never"`) reports `bypassPermissions`
// where the otherwise-comparable `tui-default` shape (no `approval_policy`
// set) reports `default`, and section (k) (Codex exec) shows the same
// key discriminating `exec-onrequest`/`exec-onfailure` (`bypassPermissions`
// regardless, exec auto-approves almost everything headless) from nothing
// special, i.e. exec's own vocabulary does not turn on this key either
// way there. The `default_permissions` full-access check below is NOT a
// measured signal in the same sense: section (k)'s exec rows show
// `config-perm-fullaccess` (`default_permissions = ":danger-full-access"`)
// and `config-perm-readonly` (`default_permissions = ":read-only"`) both
// reporting `bypassPermissions`, i.e. this key does not discriminate
// `permission_mode` at all under `codex exec`, and section (l)'s TUI
// table has no `default_permissions`-via-`config.toml` row at all (the
// one full-access TUI shape, `tui-perm-full-access`, was set through the
// `/permissions` menu, not this config key, per
// `payloads/codex-tui-perm-full-access.config.toml`). This check flags
// `default_permissions` as a threat-model heuristic on a key the operator
// can set (it is documented Codex config surface that plausibly feeds a
// yet-unmeasured code path), not because measurement showed it moving
// `permission_mode`.
//
// Either key pre-sets the trusted `when`-allowlist signal the Codex
// auto-approval path (`src/cli/pack/auto-approve-path.ts`,
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
// opted in. There is no apply-time three-way distinction to annotate
// with either: harness never snapshots the operator's live, whole
// `config.toml` (only `harness apply --runtime codex --install`'s own
// generated hook block, merged in place by `install-codex-config.ts`,
// ever lands in `.last-apply`'s `"codex/config.toml"` entry), and
// `apply.ts` never records a `kind: "target"` lock entry for the
// installed Codex config path the way it does for Claude Code's
// `--target` write, so there is no baseline to compare the live value
// against and no lock entry to tell a harness-touched file apart from
// one it has never seen. Every warning below therefore carries the same
// constant `NO_SNAPSHOT_SUFFIX`, reporting presence, not drift.
//
// Fail-open, like every other doctor check in this family: a missing or
// unreadable candidate file resolves to "nothing to report" for that
// file, and a candidate whose TOML this module's minimal scanner cannot
// make sense of (an unterminated quoted string) adds ONE diagnostic
// line, never a thrown error; the keys that did parse from the rest of
// that same file are still evaluated and can still warn.
//
// No full TOML parser: none is a dependency of this package (checked
// before writing this file), and `install-codex-config.ts` itself never
// parses the operator's config.toml into an object either, it locates
// harness's own managed block by string search. This module only needs
// two ROOT-LEVEL (not inside any `[table]`) string-valued keys, so a
// small line-oriented scanner is enough: it accepts a bare or quoted key
// (`approval_policy = ...` and `"approval_policy" = ...`), skips over
// multi-line basic/literal string bodies (`"""`/`'''`) so a body line
// that happens to look like `key = "value"` inside one is never
// mistaken for a root-level assignment, and does not attempt custom
// `[profiles.*]` tables: a profile-scoped `approval_policy` under
// `[profiles.<name>]` is out of scope and not detected today (see the
// task's constraints).

import * as fs from "node:fs";
import * as path from "node:path";
import { PACK_NAME as UNDERSTANDING_PACK_NAME } from "../../policy-packs/builtin/understanding-before-execution.js";
import {
  CODEX_HARNESS,
  harnessAllowed,
  parseAutoApprove,
} from "../../policy-packs/builtin/understanding-before-execution/auto-approve.js";
import type { Manifest } from "../../schema/index.js";
import { tildeize } from "./settings-drift.js";

export interface CodexConfigDriftSection {
  /** ⚠ lines; each rolls into warningCount. */
  warnings: string[];
}

interface CodexConfigCandidate {
  absolutePath: string;
  /** How the file is named in a warning line, never a raw machine path when avoidable. */
  displayLabel: string;
}

/** Every warning line carries this: harness keeps no apply-time snapshot of a live Codex config.toml (see module header). */
const NO_SNAPSHOT_SUFFIX = " (harness keeps no apply-time snapshot of this file; presence only)";

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
 * single-line quoted string that never closes on the same line (the one
 * shape this scanner treats as broken TOML rather than "not a string /
 * not a key we track"). A multi-line basic/literal string (`"""`/`'''`)
 * is a different, valid TOML shape: every line up to and including its
 * closing delimiter is skipped rather than scanned as assignments, and
 * skipping it never sets `malformed`. Non-string values (numbers,
 * booleans, arrays, inline tables) are silently skipped too, not flagged
 * malformed: this scanner has no opinion about them. The key itself may
 * be bare (`approval_policy`) or a quoted TOML key
 * (`"approval_policy"` / `'approval_policy'`); either form is accepted.
 */
function scanRootLevelStringKeys(raw: string): { values: Record<string, string>; malformed: boolean } {
  const values: Record<string, string> = {};
  let malformed = false;
  let multilineDelim: string | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    if (multilineDelim !== null) {
      // Inside a multi-line basic/literal string body: this line is
      // string content, never a root-level assignment, however much it
      // may look like one. Only the closing delimiter ends the skip.
      if (rawLine.includes(multilineDelim)) multilineDelim = null;
      continue;
    }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // A `[table]` or `[[array-of-tables]]` header ends the root-level
    // scope for every key from here on; this module only tracks
    // root-level keys.
    if (line.startsWith("[")) break;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (
      (key.startsWith('"') && key.endsWith('"') && key.length >= 2) ||
      (key.startsWith("'") && key.endsWith("'") && key.length >= 2)
    ) {
      key = key.slice(1, -1);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const valuePart = line.slice(eq + 1).trim();
    if (valuePart.startsWith('"""') || valuePart.startsWith("'''")) {
      const delim = valuePart.slice(0, 3);
      // A closing delimiter later on this same line makes it a
      // single-line multi-line-string literal; this scanner does not
      // track such values (out of scope, same as any other value shape
      // it has no opinion about), it just must not treat the rest of
      // the file as still inside the string.
      if (valuePart.indexOf(delim, 3) === -1) multilineDelim = delim;
      continue;
    }
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

function checkOneFile(file: CodexConfigCandidate, warnings: string[]): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file.absolutePath, "utf8");
  } catch {
    return;
  }
  const scan = scanRootLevelStringKeys(raw);
  if (scan.malformed) {
    warnings.push(`${file.displayLabel}: unreadable/invalid Codex config TOML`);
    // Keep going: a malformed line elsewhere in the file must not hide a
    // risky key that DID parse from a different line of the same file.
  }

  const approvalPolicy = scan.values["approval_policy"];
  if (approvalPolicy === "never") {
    warnings.push(`approval_policy = "never" set in ${file.displayLabel}${NO_SNAPSHOT_SUFFIX}`);
  }

  const defaultPermissions = scan.values["default_permissions"];
  if (defaultPermissions !== undefined) {
    const stripped = defaultPermissions.startsWith(":")
      ? defaultPermissions.slice(1)
      : defaultPermissions;
    if (stripped === "danger-full-access") {
      warnings.push(
        `default_permissions = ${JSON.stringify(defaultPermissions)} (full access) set in ${file.displayLabel}${NO_SNAPSHOT_SUFFIX}`,
      );
    }
  }
}

export interface BuildCodexConfigDriftOptions {
  /** `harness.generated/` for the manifest in use; kept for shape-parity with `BuildSettingsDriftOptions` (`driftCheckOpts` in index.ts is shared between both), unused by this check (see module header: no baseline exists to read here). */
  generatedDir: string;
  /** `harness.lock` path for the manifest in use; kept for the same shape-parity reason as `generatedDir`, unused by this check. */
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
    checkOneFile(c, warnings);
  }

  return { warnings };
}
