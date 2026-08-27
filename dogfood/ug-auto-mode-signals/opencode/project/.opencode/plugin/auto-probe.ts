// auto-probe: logs every hook invocation as one JSON line to PROBE_LOG.
import { appendFileSync } from "node:fs"

const LOG = process.env.PROBE_LOG ?? "/<scratch>/opencode-probe/probe.jsonl"
const LABEL = process.env.PROBE_LABEL ?? "unlabeled"

function replacer(_k: string, v: any) {
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + `...[truncated ${v.length}]`
  if (typeof v === "function") return "[fn]"
  return v
}
function safe(v: any) {
  try { return JSON.parse(JSON.stringify(v, replacer)) } catch (e) { return { unserializable: String(e) } }
}
function envSubset() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => /OPENCODE|AUTO|PERMISSION|PROBE/i.test(k)))
}
function log(hook: string, data: Record<string, any>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), label: LABEL, hook, pid: process.pid, ...data }, replacer)
  appendFileSync(LOG, line + "\n")
}
function io(hook: string) {
  return async (input: any, output: any) => log(hook, { input: safe(input), output: safe(output) })
}

export const AutoProbe = async (input: any) => {
  log("plugin.init", {
    inputKeys: Object.keys(input ?? {}),
    project: safe(input?.project),
    directory: input?.directory,
    worktree: input?.worktree,
    serverUrl: String(input?.serverUrl ?? ""),
    argv: process.argv,
    execArgv: process.execArgv,
    bunArgv: (globalThis as any).Bun?.argv,
    env: envSubset(),
    cwd: process.cwd(),
  })
  return {
    config: async (config: any) => log("config", { config: safe(config), permission: safe(config?.permission), argv: process.argv, env: envSubset() }),
    event: async ({ event }: any) => log("event", { type: event?.type, properties: safe(event?.properties) }),
    "chat.message": io("chat.message"),
    "chat.params": async (input: any, output: any) => log("chat.params", { input: safe({ ...input, model: input?.model?.id, provider: Object.keys(input?.provider ?? {}) }), output: safe(output) }),
    "chat.headers": async (input: any, output: any) => log("chat.headers", { input: safe({ ...input, model: input?.model?.id, provider: Object.keys(input?.provider ?? {}) }), output: safe(output) }),
    "permission.ask": async (input: any, output: any) => log("permission.ask", { input: safe(input), output: safe(output), argv: process.argv, env: envSubset() }),
    "command.execute.before": io("command.execute.before"),
    "tool.execute.before": async (input: any, output: any) => log("tool.execute.before", { input: safe(input), output: safe(output), argv: process.argv, env: envSubset() }),
    "tool.execute.after": io("tool.execute.after"),
    "shell.env": io("shell.env"),
    "tool.definition": async (input: any, output: any) => log("tool.definition", { input: safe(input), outputKeys: Object.keys(output ?? {}) }),
    "experimental.chat.system.transform": async (input: any, output: any) => log("experimental.chat.system.transform", { input: safe({ ...input, model: input?.model?.id }), systemCount: output?.system?.length }),
    "experimental.chat.messages.transform": async (input: any, output: any) => log("experimental.chat.messages.transform", { input: safe(input), messageCount: output?.messages?.length }),
    "experimental.session.compacting": io("experimental.session.compacting"),
    "experimental.text.complete": io("experimental.text.complete"),
  }
}
