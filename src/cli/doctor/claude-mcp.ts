// Claude Code MCP registration health (task
// init-mcp-wiring-claude-code/T-003). Verifies the surface Claude Code
// ACTUALLY reads at runtime — the `claude mcp` CLI's user-scope registry
// (`claude mcp list`) — as opposed to the inert `mcpServers` block harness
// used to (wrongly) write into settings.json. See `src/io/claude-mcp.ts`'s
// module header for the full story and the verified CLI contract.
//
// Runtime gating (per the task spec): doctor has no clean per-runtime
// concept to further scope this check on — `KNOWN_DOCTOR_TARGETS` (see
// `types.ts`) only carries `codex` today, with no `claude-code` entry.
// The section therefore gates purely on `tools.mcp[]` being non-empty and
// documents the "assumes Claude Code is the effective runtime" caveat in
// its own rendered output (see `format.ts`'s `formatClaudeMcpSection`)
// rather than silently pretending to be runtime-aware.
//
// Hermeticity: the live `claude mcp list` spawn only fires when NOT
// `--shallow` and at least one manifest MCP server is enabled (nothing to
// verify otherwise). Callers that don't want the real CLI touched (every
// test in this repo) inject `claudeMcpExec`, mirroring the
// `npmBinExec`/`gitIgnoreProbe` injectable-exec convention already used
// elsewhere in this directory.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Manifest } from "../../schema/index.js";
import { buildDesiredMcpServers } from "../apply/generate-settings.js";
import {
  listMcpServers,
  posixSingleQuote,
  type ClaudeMcpExec,
  type ClaudeMcpListEntry,
} from "../../io/claude-mcp.js";
import { DEFAULT_OWNED_MCP_SERVERS } from "../uninstall/index.js";

export interface ClaudeMcpEntryReport {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

/**
 * Claude Code MCP registration health. Present whenever `tools.mcp[]` is
 * non-empty (see the module header for why the gate isn't further
 * narrowed by runtime).
 */
export interface ClaudeMcpRegistrationSection {
  /**
   * Outcome of the underlying `claude mcp list` call. `"skipped"` means
   * `--shallow` suppressed the live probe. When there are zero ENABLED
   * `tools.mcp[]` servers, this is trivially `"ok"` with empty `entries`
   * — nothing to look up, so no spawn happens either.
   */
  listStatus: "ok" | "cli-missing" | "timeout" | "error" | "skipped";
  /** Present when listStatus !== "ok": why (CLI missing / timed out / spawn error / shallow skip). */
  listMessage?: string;
  /**
   * Per-server registration status, populated only when `listStatus ===
   * "ok"`. `"error"` entries roll into `errorCount`; `"warn"` entries
   * roll into `warningCount` (see `countDiagnostics` in `index.ts`).
   */
  entries: ClaudeMcpEntryReport[];
  /**
   * harness-owned MCP server names still present in the dead
   * `~/.claude/settings.json` `mcpServers` block (a leftover from the
   * pre-T-002 write path that Claude Code never actually read).
   */
  deadSettingsBlockNames: string[];
  /**
   * Roll-up warnings (list unavailable for a reason other than "CLI not
   * installed", dead settings.json block). Each rolls into
   * `warningCount`, mirroring `GroundingSection.warnings` /
   * `RiskGateSection.warnings`.
   */
  warnings: string[];
}

export interface BuildClaudeMcpRegistrationOptions {
  /** Operator home dir, the `~/.claude/settings.json` fallback location when `CLAUDE_CONFIG_DIR` is unset. Same `home` doctor threads through the other checks. */
  home: string;
  /**
   * Env for `CLAUDE_CONFIG_DIR` resolution in the dead settings.json
   * block check. Defaults to `process.env`; tests inject `{}` or a fake
   * config dir to stay hermetic against the operator's real env.
   */
  env?: NodeJS.ProcessEnv;
  shallow?: boolean;
  /** Test-injection knob; production omits this and the real `claude` CLI is spawned. */
  claudeMcpExec?: ClaudeMcpExec;
  /**
   * The `harness.generated/` directory for the manifest in use (review
   * round H1, Finding 2), threaded to `buildDesiredMcpServers` so the
   * desired projection — and therefore the "not registered" `claude mcp
   * add-json ...` hint — carries `SOLUTION_VERDICT_SIGNING_KEY` exactly
   * like `apply`/`init --interactive`/opencode's config generator project
   * it. The caller (doctor/index.ts) resolves this the same way apply.ts
   * and interactive.ts do: `resolveGeneratedDir({homeDir, manifestPath})`.
   * Omitted -> no signing-key projection, mirroring
   * `BuildDesiredMcpServersOptions.generatedDir`'s own no-safe-default rule.
   */
  generatedDir?: string;
}

/**
 * Resolve the settings.json path the dead-block check reads. Mirrors the
 * precedence `resolveClaudeUserRegistryPath` in `src/io/claude-mcp.ts`
 * applies for the registry file: a non-empty `CLAUDE_CONFIG_DIR` wins
 * (`$CLAUDE_CONFIG_DIR/settings.json`), otherwise it is
 * `~/.claude/settings.json` under the operator home.
 */
function resolveSettingsPath(home: string, env: NodeJS.ProcessEnv): string {
  const configDir = env["CLAUDE_CONFIG_DIR"];
  if (typeof configDir === "string" && configDir.length > 0) {
    return path.join(configDir, "settings.json");
  }
  return path.join(home, ".claude", "settings.json");
}

/**
 * Read the resolved settings.json's `mcpServers` block (if any) and return
 * the harness-owned names still present in it. Owned = the current
 * manifest's `tools.mcp[].name` (any entry, enabled or not — a server
 * disabled after being registered once can still have left a dead entry)
 * union the uninstall module's default ownership set, mirroring the
 * ownership union `migrateDeadSettingsMcpBlock` in
 * `src/cli/init/interactive.ts` computes for the same block (that
 * function additionally unions `.last-apply` provenance names; doctor
 * intentionally stays with the simpler two-set union since it only
 * needs to detect the gap, not decide what's safe to delete).
 *
 * Never throws: a missing file, malformed JSON, or a non-object
 * `mcpServers` value all resolve to "nothing to report" — those failure
 * modes are surfaced by other doctor/validate checks, not duplicated here.
 */
function findDeadSettingsMcpNames(manifest: Manifest, settingsPath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const mcpServers = (parsed as Record<string, unknown>)["mcpServers"];
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    return [];
  }
  const owned = new Set<string>([
    ...manifest.tools.mcp.map((m) => m.name),
    ...DEFAULT_OWNED_MCP_SERVERS,
  ]);
  return Object.keys(mcpServers as Record<string, unknown>)
    .filter((name) => owned.has(name))
    .sort();
}

export async function buildClaudeMcpRegistration(
  manifest: Manifest,
  opts: BuildClaudeMcpRegistrationOptions,
): Promise<ClaudeMcpRegistrationSection> {
  // buildDesiredMcpServers' own warnings (empty command, literal-tilde env
  // values) are already surfaced by the settings-generation path / the
  // init wizard when they matter; re-reporting them here would just
  // duplicate that diagnostic under a different section, so they are
  // discarded.
  // homeDir: opts.home is DELIBERATE here (review round H1-R2, L4,
  // resolved by documentation): doctor expands the manifest's
  // tilde-carrying values (e.g. the EVIDENCE_LEDGER_DB ledger path)
  // against the operator home it was invoked for, which is the
  // pre-existing EVIDENCE_LEDGER_DB semantics this check has always had.
  // apply/init pass no homeDir and fall back to os.homedir(); the two only
  // diverge when doctor is pointed at a DIFFERENT home than the one the
  // process runs as, in which case doctor's hint is the correct one for
  // that home. For the signing key the shared signingKeyEnvValue resolves
  // non-absolute generatedDir inputs the same way at every call site.
  const { mcp: desired } = buildDesiredMcpServers(manifest, {
    homeDir: opts.home,
    generatedDir: opts.generatedDir,
  });
  const desiredNames = Object.keys(desired).sort();

  const warnings: string[] = [];
  const entries: ClaudeMcpEntryReport[] = [];
  let listStatus: ClaudeMcpRegistrationSection["listStatus"];
  let listMessage: string | undefined;

  if (desiredNames.length === 0) {
    // Nothing enabled to register — trivially fine, no spawn needed.
    listStatus = "ok";
  } else if (opts.shallow) {
    listStatus = "skipped";
    listMessage = "harness doctor --shallow does not probe live claude CLI registration";
  } else {
    const listResult = await listMcpServers(
      opts.claudeMcpExec ? { exec: opts.claudeMcpExec } : {},
    );
    listStatus = listResult.status;
    if (listResult.status === "cli-missing") {
      // Hard constraint from the task spec: CLI missing never counts as
      // an error and stays out of errorCount/warningCount — treated the
      // same as `npmGlobalBin`'s silent "unknown" state.
      listMessage = listResult.message ?? "claude CLI not found on PATH";
    } else if (listResult.status !== "ok") {
      // "timeout" or a genuine non-zero-exit "error": still not a hard
      // failure (same constraint), but unlike cli-missing this is
      // unexpected enough to surface as a warning.
      listMessage = listResult.message ?? listResult.status;
      warnings.push(
        `could not verify claude-code MCP registration (claude mcp list ${listResult.status}` +
          `${listMessage ? `: ${listMessage}` : ""}); ${desiredNames.length} server(s) unverified`,
      );
    } else {
      const byName = new Map<string, ClaudeMcpListEntry>(
        listResult.servers.map((s) => [s.name, s]),
      );
      for (const name of desiredNames) {
        const found = byName.get(name);
        if (!found) {
          entries.push({
            name,
            status: "error",
            message:
              "not registered with the claude CLI — run `harness init --interactive` or " +
              `\`claude mcp add-json --scope user ${name} ${posixSingleQuote(
                JSON.stringify(desired[name]),
              )}\``,
          });
          continue;
        }
        switch (found.status) {
          case "connected":
            entries.push({ name, status: "ok", message: found.statusText || "Connected" });
            break;
          case "failed":
            entries.push({
              name,
              status: "error",
              message: found.statusText || "Failed to connect",
            });
            break;
          case "needs-authentication":
            entries.push({
              name,
              status: "warn",
              message: found.statusText || "Needs authentication",
            });
            break;
          default:
            // Defensive: markerToStatus in io/claude-mcp.ts only returns
            // "unknown" for a marker glyph the verified CLI contract has
            // never produced. Warn rather than silently drop it.
            entries.push({
              name,
              status: "warn",
              message: `unrecognised claude mcp list status (${found.statusText || "unknown"})`,
            });
        }
      }
    }
  }

  const settingsPath = resolveSettingsPath(opts.home, opts.env ?? process.env);
  const deadSettingsBlockNames = findDeadSettingsMcpNames(manifest, settingsPath);
  if (deadSettingsBlockNames.length > 0) {
    warnings.push(
      `${settingsPath} still declares a dead \`mcpServers\` block for ` +
        `${deadSettingsBlockNames.join(", ")} — Claude Code does not read this block; ` +
        "re-run `harness init --interactive` to migrate it away",
    );
  }

  return {
    listStatus,
    ...(listMessage !== undefined ? { listMessage } : {}),
    entries,
    deadSettingsBlockNames,
    warnings,
  };
}
