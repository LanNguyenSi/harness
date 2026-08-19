// Batch 18 / task f34eb233 -- opencode runtime adapter config generator.
//
// ADR-style adapter-mapping notes (verified 2026-08-18 against the
// published opencode JSON Schema at https://opencode.ai/config.json, the
// docs at https://opencode.ai/docs/config/ and https://opencode.ai/docs/plugins/,
// and the real ~/.config/opencode/opencode.json + opencode.jsonc this
// exploration ran against as a read-only reference; not modified by this
// generator or by `harness apply`):
//
// Config location: opencode reads config from, in merge/precedence order
// (later sources win, but every source is MERGED, not replaced):
//   1. remote config from a `.well-known/opencode` endpoint
//   2. global config: `~/.config/opencode/opencode.json`
//   3. custom config: `$OPENCODE_CONFIG` (a path)
//   4. project config: `opencode.json` in the project root
//   5. `.opencode/` directories (agents, commands, plugins)
//   6. inline config: `$OPENCODE_CONFIG_CONTENT`
//   7. OS-managed config (macOS `/Library/Application Support/opencode/`,
//      Linux `/etc/opencode/`, Windows `%ProgramData%\opencode`)
// Every one of those slots is either operator-owned or environment/OS
// selected; opencode does not auto-discover an extra "drop a file here"
// directory the way a plugin/pack system might. That is exactly why this
// generator does not attempt to install itself into any of them -- see
// "What we deliberately do NOT do" below.
//
// mcp -> PROJECTED. opencode's config.json has a native `mcp` block
// ($defs.McpLocalConfig in the published schema: `{ type: "local",
// command: string[], cwd?, environment?: Record<string,string>,
// enabled?, timeout? }`). We reuse generate-settings.ts's
// `buildDesiredMcpServers` (Claude Code's `{command, args, env}` shape,
// already covering the grounding-mcp EVIDENCE_LEDGER_DB and
// SOLUTION_VERDICT_SIGNING_KEY projections and the literal-tilde
// env-value warning) and reshape the
// result into opencode's `{type: "local", command: [...], environment}`
// instead of hand-rolling a third copy of that logic that could drift
// from the other two runtimes.
//
// enabled:false -> projected as a bare `{"enabled": false}` marker, NOT
// omitted (LOW-F4, batch18 fix-round, task f34eb233 review; the
// reviewer verified live against opencode 1.18.18 that a bare
// `{"enabled": false}` entry -- no `type`/`command` -- is accepted).
// `buildMcpServers` drops disabled entries entirely, which is fine for
// Claude Code's settings.json (the only mcpServers source Claude Code
// reads, so a dropped entry is equivalent to a disabled one) but wrong
// for opencode: per the "Config location" list above, opencode MERGES
// multiple config sources, so a server name this generator's output
// simply omits does NOT override an `enabled: true` (or default-
// enabled) declaration for the SAME name in another merged source
// (e.g. the operator's own ~/.config/opencode/opencode.json) -- the
// operator's intent to disable that server would silently not take
// effect. Emitting the explicit marker instead makes the disablement
// actually win once merged.
//
// hooks -> NOT PROJECTED (documented no-op, not a bug). opencode.json's
// schema has NO declarative hook/event field of any kind (confirmed:
// absent from https://opencode.ai/config.json). opencode's only
// extensibility surface for tool-call interception is the JS/TS
// `plugin` array (`@opencode-ai/plugin`; its event set includes
// `tool.execute.before` / `tool.execute.after`, `session.*`,
// `permission.asked`, ...) -- a code-authoring surface, not a
// config-declared shell-command list like Claude Code's settings.json
// `hooks` or Codex's `[[hooks.*]]` TOML. Building a harness -> opencode
// plugin bridge that would let manifest hooks actually intercept tool
// calls is explicitly out of this task's scope (opencode policy
// enforcement / hook interception). So `manifest.hooks[]` and the
// `memory.router` UserPromptSubmit-equivalent projection
// (`generate-settings.ts#buildMemoryRouterHook`) are both left
// unprojected here; a warning says so instead of silently dropping them.
//
// permission -> NOT PROJECTED (v1; documented follow-up). opencode does
// have a native `permission` block (per-tool `ask`/`allow`/`deny`, with
// a pattern-keyed object as an escape hatch) that is a genuine
// PreToolUse-blocking equivalent -- but its shape (tool key -> pattern
// -> action) is structurally inverted from the
// `permissions.{allow,ask,deny}: string[]` pattern-DSL that
// `policy_packs`' `packPermissions` already produce for Claude Code, and
// mapping one into the other is real, untested-by-this-task translation
// work. `generate-codex-config.ts`'s header deferred the analogous
// Codex sandbox-profile mapping for the same "keep v1 small" reason;
// this adapter follows that precedent instead of inventing a rushed
// pattern translator. `apply.ts` surfaces a warning (mirroring the
// Codex branch) when a manifest actually contributes permissions here,
// so the gap stays visible instead of silent.
//
// Stable-output rules (load-bearing for byte-equivalent regeneration on
// a no-op apply):
//   - `mcp` server keys are in the order `buildMcpServers` already
//     guarantees: ascending lexical by name.
//   - No timestamps, hostnames, or other run-specific data.
//
// What we deliberately do NOT do:
//   - Merge into, or otherwise write, any operator-owned opencode config
//     file (`~/.config/opencode/opencode.json`, a project `opencode.json`,
//     or anything `$OPENCODE_CONFIG` points at). Unlike Codex's
//     `--install` (a marked-block splice into `~/.codex/config.toml`),
//     opencode already merges multiple config sources by precedence (see
//     the location list above), and its config format is JSONC --
//     comments and trailing commas are both allowed (the published
//     schema sets `allowComments` / `allowTrailingCommas`), confirmed
//     against the real machine-local `opencode.jsonc`. So wiring this
//     artefact in is left as an operator action: point `$OPENCODE_CONFIG`
//     at `harness.generated/opencode/opencode.json` directly, or copy the
//     `mcp` block into an existing config. harness never touches
//     `~/.config/opencode/` or a project `opencode.json` itself.
//   - Map policy-pack hook commands into opencode plugin code (see
//     "hooks" above) or opencode's `permission` block (see "permission"
//     above).

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
 * module's "enabled:false" header note for why a bare object -- no
 * `type`/`command` -- is emitted instead of omitting the key.
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
  /**
   * Absolute `harness.generated/` directory for the manifest in use (task
   * 03a917fd/H1b), threaded through to `projectSigningKeyEnv` exactly like
   * `GenerateSettingsExtras.generatedDir` in generate-settings.ts. Same
   * no-safe-default rule: omitting this yields NO
   * `SOLUTION_VERDICT_SIGNING_KEY` projection rather than a guessed path.
   */
  generatedDir?: string;
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
  // grounding-mcp EVIDENCE_LEDGER_DB and SOLUTION_VERDICT_SIGNING_KEY
  // projections plus the literal-tilde warning, via `buildDesiredMcpServers`
  // (review round H1, Finding 2 -- the single choke point every producer of
  // this shape now shares, instead of hand-rolling a third copy of the
  // buildMcpServers/projectGroundingEnv/projectSigningKeyEnv sequence).
  // `buildMcpServers` (inside the helper) returns keys pre-sorted ascending
  // by name (see its own header) AND drops `enabled: false` entries
  // entirely. That drop is correct for the Claude-Code-shaped intermediate
  // this reuses, but NOT for the final opencode `mcp` block: those disabled
  // entries are re-added below as explicit `{"enabled": false}` markers
  // instead of staying dropped (LOW-F4, batch18 fix-round, task f34eb233
  // review — see this module's "enabled:false" header note for why).
  const { mcp: claudeShapeMcp, warnings } = buildDesiredMcpServers(manifest, {
    homeDir: extras.homeDir,
    generatedDir: extras.generatedDir,
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
