// Canonical shell-tool alias set: Claude Code's single "Bash" tool plus
// the Codex shell-tool names current runtimes emit. Exported so callers
// elsewhere in the layering (e.g. policy-packs/builtin, which may import
// from runtime/ but not from cli/) can derive their own shell-alias
// lists from this one definition instead of hand-copying the literal
// array (task bea04a03 review finding).
export const SHELL_ALIASES = [
  "Bash",
  "shell",
  "exec_command",
  "functions.exec_command",
] as const;

function addShellAliases(out: Set<string>, toolName: string): void {
  if (!(SHELL_ALIASES as readonly string[]).includes(toolName)) return;
  for (const alias of SHELL_ALIASES) out.add(alias);
}

function addMcpAliases(out: Set<string>, toolName: string): void {
  const variants = parseMcpToolName(toolName);
  if (!variants) return;
  const serverVariants = new Set([
    variants.server,
    variants.server.replace(/-/g, "_"),
    variants.server.replace(/_/g, "-"),
  ]);
  for (const server of serverVariants) {
    out.add(`mcp__${server}__${variants.tool}`);
    out.add(`mcp__${server}__.${variants.tool}`);
  }
}

function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  const doubleUnderscoreDot = /^mcp__(.+)__\.(.+)$/.exec(toolName);
  if (doubleUnderscoreDot?.[1] && doubleUnderscoreDot[2]) {
    return { server: doubleUnderscoreDot[1], tool: doubleUnderscoreDot[2] };
  }

  const doubleUnderscore = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (doubleUnderscore?.[1] && doubleUnderscore[2]) {
    return { server: doubleUnderscore[1], tool: doubleUnderscore[2] };
  }

  const dot = /^mcp__(.+)\.(.+)$/.exec(toolName);
  if (dot?.[1] && dot[2]) {
    return { server: dot[1], tool: dot[2] };
  }

  return null;
}

export function expandToolNameAliases(toolName: string): string[] {
  const out = new Set<string>([toolName]);
  addShellAliases(out, toolName);
  addMcpAliases(out, toolName);
  return [...out];
}

function isSimpleToolPatternToken(token: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(token);
}

export function expandCodexHookMatchPattern(match: string): string {
  const tokens = match.split("|");
  if (!tokens.every(isSimpleToolPatternToken)) return match;

  const expanded = new Set<string>();
  for (const token of tokens) {
    for (const alias of expandToolNameAliases(token)) expanded.add(alias);
  }
  return [...expanded].join("|");
}

export function extractShellCommand(event: {
  tool_input?: unknown;
  raw_input?: unknown;
  input?: unknown;
}): string | null {
  for (const candidate of [event.tool_input, event.raw_input, event.input]) {
    if (!candidate || typeof candidate !== "object") continue;
    const args = candidate as { command?: unknown; cmd?: unknown };
    if (typeof args.command === "string") return args.command;
    if (typeof args.cmd === "string") return args.cmd;
  }
  return null;
}
