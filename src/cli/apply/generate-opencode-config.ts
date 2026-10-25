// Opencode runtime adapter config generator: `harness apply --runtime
// opencode` (adapter shipped in task f34eb233). Writes
// `harness.generated/opencode/opencode.json` instead of settings.json.
// opencode MERGES multiple config sources by precedence (global
// `~/.config/opencode/opencode.json`, `$OPENCODE_CONFIG`, a project
// `opencode.json`, ...), and every one of those slots is operator-owned
// or environment-selected, so this generator deliberately writes no
// operator config: wiring the artefact in is an operator action (point
// `$OPENCODE_CONFIG` at the generated file, or copy its `mcp` block
// out). Those merge semantics drive the projection rules below.
//
// Projected: `$schema` (the published opencode config schema URL) and
// `mcp`, built from `manifest.tools.mcp[]` via generate-settings.ts's
// `buildDesiredMcpServers` (the single choke point the Claude Code and
// Codex projections share, covering the grounding-mcp env projection
// and the literal-tilde warning) and reshaped into opencode's native
// `{type: "local", command, environment}` entries.
//
// enabled:false -> a `tools.mcp[]` entry declared `enabled: false` is
// emitted as a bare `{"enabled": false}` marker, NOT omitted: because
// opencode merges config sources, an omitted key would not override an
// active declaration for the same server name in another merged source
// (e.g. the operator's own `~/.config/opencode/opencode.json`), while
// the explicit marker makes the disablement actually win once merged.
// opencode accepts the bare marker without `type` or `command`.
//
// NOT projected (hooks and `memory.router` print a warning when present;
// permission has no manifest source, so nothing is warned or dropped):
//   - hooks: `manifest.hooks[]` and the `memory.router`
//     UserPromptSubmit-equivalent projection
//     (`generate-settings.ts#buildMemoryRouterHook`). opencode.json has
//     no declarative hook/event field; its only tool-call interception
//     surface is the JS/TS `plugin` array (a code-authoring surface),
//     and a harness -> opencode plugin bridge is out of scope.
//   - permission: opencode's native `permission` block (per-tool
//     `ask`/`allow`/`deny`) is a genuine PreToolUse-blocking
//     equivalent, but its tool -> pattern -> action shape is
//     structurally inverted from the `permissions.{allow,ask,deny}`
//     pattern DSL of Claude Code's settings.json, and mapping one into
//     the other is real, untested work. `generate-codex-config.ts`'s
//     header deferred the analogous Codex sandbox-profile mapping for
//     the same "keep v1 small" reason; this adapter follows that
//     precedent. No builtin pack contributes permissions, so nothing is
//     dropped silently.
//
// Stable-output rules (load-bearing for byte-equivalent regeneration on
// a no-op apply): `mcp` server keys are ascending lexical by name, and
// no timestamps, hostnames, or other run-specific data are emitted.
//
// What this generator deliberately does NOT do: merge into, or
// otherwise write, any operator-owned opencode config (harness never
// touches `~/.config/opencode/` or a project `opencode.json`; opencode
// reads JSONC, which is why the emitted `//` banner is valid config),
// and map hook commands into plugin code or
// `permission` entries (see "NOT projected" above).
//
// Header contract: the generated file's first line is
// `OPENCODE_GENERATED_HEADER_LINE`, the banner `harness doctor --target
// opencode` recognises a harness-generated artefact by. The emitted
// `HEADER` block and that constant are pinned bytes: change them only
// together with doctor's banner check and the tests that pin them.

import type { Manifest } from "../../schema/index.js";
import {
  buildDesiredMcpServers,
  type SettingsMcpServer,
} from "./generate-settings.js";

/** opencode's native local-MCP-server shape (`$defs.McpLocalConfig`). */
export interface OpencodeLocalMcpServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}

/**
 * LOW-F4 (batch18 fix-round, task f34eb233 review): the marker projected
 * for a manifest `tools.mcp[]` entry declared `enabled: false`. See this
 * module's "enabled:false" header note for why the key is not omitted
 * and why a bare object (no `type`/`command`) is accepted.
 */
export interface OpencodeDisabledMcpServer {
  enabled: false;
}

export type OpencodeMcpEntry = OpencodeLocalMcpServer | OpencodeDisabledMcpServer;

export interface OpencodeConfigResult {
  content: string;
  warnings: string[];
  /**
   * The projected `mcp` block, structured (not re-parsed out of
   * `content`, which is JSONC and may carry banner comments a strict
   * JSON.parse would reject). Consumers that need the server list
   * without re-deriving it -- `harness doctor --target opencode`'s MCP
   * command-resolution check -- read this instead. Mirrors
   * `GenerateSettingsResult.mcpServers`'s reason for existing
   * (generate-settings.ts). Entries for `enabled: false` manifest
   * servers appear here too, as `OpencodeDisabledMcpServer` (LOW-F4);
   * consumers that need to skip them can check `"command" in entry`.
   */
  mcp: Record<string, OpencodeMcpEntry>;
}

/**
 * First line of the generated opencode config. Exported so callers that
 * need to detect a harness-generated artefact (doctor's banner check)
 * pin against the same literal as the emitter instead of duplicating the
 * string.
 */
export const OPENCODE_GENERATED_HEADER_LINE =
  "// Generated by harness apply --runtime opencode.";

const HEADER = [
  OPENCODE_GENERATED_HEADER_LINE,
  "// DO NOT EDIT: re-run `harness apply --runtime opencode` to regenerate.",
  "//",
  "// harness does NOT install this file automatically -- it never writes",
  "// into ~/.config/opencode/ or a project opencode.json. Wire it in",
  "// yourself, either:",
  "//   - point $OPENCODE_CONFIG at this file's path, or",
  "//   - copy the \"mcp\" block below into your own opencode.json /",
  "//     opencode.jsonc (opencode merges config sources by precedence;",
  "//     see https://opencode.ai/docs/config/).",
  "//",
  "// Adapter mapping (full ADR in this generator's module header,",
  "// src/cli/apply/generate-opencode-config.ts):",
  "//   mcp        -> projected below (opencode's native `mcp` block).",
  "//                 A manifest entry with `enabled: false` is emitted",
  "//                 as a bare `{\"enabled\": false}` marker rather than",
  "//                 omitted, so it overrides an active declaration for",
  "//                 the same server name in another merged config",
  "//                 source instead of silently not disabling it.",
  "//   hooks      -> NOT projected; opencode has no declarative hook",
  "//                 field, only a JS/TS plugin API (out of scope here)",
  "//   permission -> NOT projected in v1 (documented follow-up)",
  "",
].join("\n");

export interface GenerateOpencodeConfigExtras {
  /**
   * Home directory used to expand `~/` in projected values (the
   * grounding evidence-ledger path). Defaults to `os.homedir()` (via
   * `projectGroundingEnv`); injected by tests for determinism, same
   * convention as `GenerateSettingsExtras.homeDir` in generate-settings.ts.
   */
  homeDir?: string;
}

function toOpencodeMcpServer(server: SettingsMcpServer): OpencodeLocalMcpServer {
  const out: OpencodeLocalMcpServer = {
    type: "local",
    command: server.args ? [server.command, ...server.args] : [server.command],
  };
  if (server.env && Object.keys(server.env).length > 0) {
    out.environment = { ...server.env };
  }
  return out;
}

export function generateOpencodeConfig(
  manifest: Manifest,
  extras: GenerateOpencodeConfigExtras = {},
): OpencodeConfigResult {
  // Claude Code's {command, args, env} shape already carries the
  // grounding-mcp EVIDENCE_LEDGER_DB projection plus the literal-tilde
  // warning, via `buildDesiredMcpServers` (the single choke point every
  // producer of this shape shares, instead of hand-rolling a third copy of
  // the buildMcpServers/projectGroundingEnv sequence).
  // `buildMcpServers` (inside the helper) returns keys pre-sorted ascending
  // by name (see its own header) AND drops `enabled: false` entries
  // entirely. That drop is correct for the Claude-Code-shaped intermediate
  // this reuses, but NOT for the final opencode `mcp` block: those disabled
  // entries are re-added below as explicit `{"enabled": false}` markers
  // instead of staying dropped (LOW-F4, batch18 fix-round, task f34eb233
  // review — see this module's "enabled:false" header note for why).
  const { mcp: claudeShapeMcp, warnings } = buildDesiredMcpServers(manifest, {
    homeDir: extras.homeDir,
  });

  // Built by iterating manifest.tools.mcp SORTED ascending by name (not
  // by re-using claudeShapeMcp's own key order, which only covers the
  // enabled subset) so the combined enabled+disabled output keeps the
  // same stable-output guarantee the enabled-only projection had before.
  const mcp: Record<string, OpencodeMcpEntry> = {};
  const sortedEntries = [...manifest.tools.mcp].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const e of sortedEntries) {
    if (e.enabled === false) {
      mcp[e.name] = { enabled: false };
      continue;
    }
    // Absent when buildMcpServers skipped this entry (empty command
    // after token-splitting; already warned above by buildMcpServers
    // itself).
    const server = claudeShapeMcp[e.name];
    if (server) mcp[e.name] = toOpencodeMcpServer(server);
  }
  if (manifest.tools.mcp.length > 0 && Object.keys(mcp).length === 0) {
    // Reachable only when every entry is enabled but produced no
    // projectable server (empty command) -- a real `enabled: false`
    // entry always lands in `mcp` as a marker now, so it can no longer
    // be the cause of an empty result here (LOW-F4).
    warnings.push(
      "tools.mcp[] has entries but none produced a projectable opencode `mcp` entry (see the per-entry warnings above)",
    );
  }

  if (manifest.hooks.length > 0) {
    warnings.push(
      `manifest contributes ${manifest.hooks.length} hook(s); opencode has no declarative hook wiring (see this generator's header) and none were projected`,
    );
  }
  const router = manifest.memory.router;
  if (router && router.enabled !== false) {
    warnings.push(
      "memory.router is configured but not projected; opencode has no declarative UserPromptSubmit-equivalent (see this generator's header)",
    );
  }

  const config: Record<string, unknown> = {
    "$schema": "https://opencode.ai/config.json",
  };
  if (Object.keys(mcp).length > 0) config["mcp"] = mcp;

  const body = `${JSON.stringify(config, null, 2)}\n`;
  const content = `${HEADER}${body}`;
  return { content, warnings, mcp };
}
