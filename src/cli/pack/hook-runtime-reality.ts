// Phase 1 Schritt 3 (harness side) — `harness pack hook runtime-reality` runtime verb.
//
// PreToolUse drift gate. Wires @lannguyensi/runtime-reality-checker as a
// real, blocking PreToolUse hook by composing its PURE policy handler
// with a host-coupled subprocess probe.
//
// Why this verb exists at all: the package's own bin
// (`runtime-reality-policy-pre-tool-use`) ships with `probe: null`, so it
// always degrades to allow — it can detect a trigger but never compare
// against actual runtime state. The probe is deliberately left to the
// harness side so the agent-grounding repo stays free of host-coupling
// (see agent-grounding/docs/policy-runtime-reality.md "Actuals probe").
// This verb is that harness-side half: it spawns the operator-configured
// `RUNTIME_REALITY_PROBE_CMD`, parses its JSON `ActualProcessState[]`, and
// injects it into the package handler.
//
// Failure mode mirrors the package and the understanding-gate pack hook:
// every load / parse / probe error degrades to ALLOW (exit 0). The only
// deny path is a probe that actually produced actuals showing critical
// drift (or the operator's explicit `RUNTIME_REALITY_*_BLOCK` escalations,
// which the package handler owns). A misconfigured probe must never
// tarpit the session.

import { execFileSync } from "node:child_process";
import {
  handlePolicyPreToolUse,
  loadExpectations,
  type HandlerResult,
  type PolicyEnv,
  type Probe,
} from "@lannguyensi/runtime-reality-checker/policy";
import type { ActualProcessState } from "@lannguyensi/runtime-reality-checker";

/** Hard ceiling on a single probe invocation. The hook's own budget_ms
 *  (default 30s) is the outer bound; keep the probe well inside it so a
 *  hung `docker ps` degrades to allow rather than blowing the hook
 *  budget. */
const PROBE_TIMEOUT_MS = 10_000;
/** docker ps on a busy host can emit a lot of lines; 4 MiB is generous. */
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Validate that the probe's stdout parses to an `ActualProcessState[]`.
 * The package handler treats a thrown probe as "probe failed" and applies
 * the fail-open / `PROBE_FAIL_BLOCK` policy, so throwing on malformed
 * output is the correct signal — not silently returning `[]` (which would
 * read as "nothing is running" and manufacture phantom critical drift).
 */
export function parseProbeOutput(raw: string): ActualProcessState[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("probe produced empty output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`probe output is not valid JSON: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("probe output is not a JSON array of ActualProcessState");
  }
  return parsed.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`probe output[${i}] is not an object`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string") {
      throw new Error(`probe output[${i}].name must be a string`);
    }
    if (typeof rec.running !== "boolean") {
      throw new Error(`probe output[${i}].running must be a boolean`);
    }
    // startup_mode / port are optional and forwarded as-is; the package's
    // runRealityCheck only reads them when the expectation declares them.
    return rec as unknown as ActualProcessState;
  });
}

/**
 * Build a synchronous probe from an operator-configured command string,
 * or `null` when none is set (handler then takes the no-probe degrade
 * path). The command runs via `sh -c` so a full command line with args
 * works. The resolved keyword is passed on the env (RUNTIME_REALITY_KEYWORD)
 * so a probe script can scope its output; it is deliberately NOT appended
 * as a positional arg, which would surprise commands that don't ignore
 * extra args (e.g. `cat file`, `printf`).
 */
export function buildSubprocessProbe(
  probeCmd: string | undefined,
  env: NodeJS.ProcessEnv,
): Probe | null {
  const cmd = probeCmd?.trim();
  if (!cmd) return null;
  return ({ keyword }) => {
    const stdout = execFileSync("sh", ["-c", cmd], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
      env: { ...env, RUNTIME_REALITY_KEYWORD: keyword },
    });
    return parseProbeOutput(stdout);
  };
}

export interface RuntimeRealityHookDeps {
  loadExpectations: typeof loadExpectations;
  buildProbe: (probeCmd: string | undefined, env: NodeJS.ProcessEnv) => Probe | null;
}

const DEFAULT_DEPS: RuntimeRealityHookDeps = {
  loadExpectations,
  buildProbe: buildSubprocessProbe,
};

/**
 * Pure composition: given the raw PreToolUse stdin and an environment,
 * build the probe and run the package handler. Injectable deps keep this
 * unit-testable without spawning real subprocesses.
 */
export function runRuntimeRealityHook(
  rawStdin: string,
  env: NodeJS.ProcessEnv,
  deps: RuntimeRealityHookDeps = DEFAULT_DEPS,
): HandlerResult {
  const probe = deps.buildProbe(env.RUNTIME_REALITY_PROBE_CMD, env);
  return handlePolicyPreToolUse(rawStdin, env as PolicyEnv, {
    loadExpectations: deps.loadExpectations,
    probe,
  });
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  if ((stream as NodeJS.ReadStream).isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface RuntimeRealityCliOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
}

function allowResult(reason: string): HandlerResult {
  return { stdout: "", stderr: "", exitCode: 0, decision: { kind: "skip", reason } };
}

/**
 * CLI entrypoint for `harness pack hook runtime-reality`. Reads the
 * PreToolUse event JSON on stdin, runs the drift check, writes the
 * hookSpecificOutput envelope (deny) / stderr message, and RETURNS the
 * handler result. It deliberately does NOT call `process.exit`: the
 * caller in src/cli/index.ts throws `HarnessExitError` on a nonzero
 * exit code, which lets `main.ts` exit only after the promise resolves
 * so the deny envelope on stdout fully flushes to the pipe first. A
 * synchronous `process.exit` here could truncate that envelope and
 * silently defeat the block. Any unexpected failure resolves to ALLOW.
 */
export async function runPackHookRuntimeRealityCli(
  opts: RuntimeRealityCliOptions = {},
): Promise<HandlerResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  let raw = "";
  try {
    raw = await readStdin(stdin);
  } catch {
    return allowResult("stdin read failed, degraded to allow");
  }

  let result: HandlerResult;
  try {
    result = runRuntimeRealityHook(raw, process.env);
  } catch (err) {
    // Defense in depth: the handler already degrades internally, but a
    // bug in probe construction must not crash the hook.
    const message = `runtime-reality hook failed silently: ${String(err)}\n`;
    stderr.write(message);
    return allowResult("hook construction failed, degraded to allow");
  }

  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return result;
}
