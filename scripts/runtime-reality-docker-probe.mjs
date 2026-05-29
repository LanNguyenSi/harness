#!/usr/bin/env node
// Docker probe for the runtime-reality PreToolUse hook.
//
// Contract (see `harness pack hook runtime-reality`): print a JSON array
// of ActualProcessState `{ name, running, startup_mode, port }` on stdout,
// one entry per running/known container. The hook spawns this via
// RUNTIME_REALITY_PROBE_CMD, parses stdout, and compares it against the
// keyword's expectations file. A non-zero exit or non-JSON output is
// treated by the hook as "probe failed" (fail-open unless
// RUNTIME_REALITY_PROBE_FAIL_BLOCK=1) — so this script must either emit a
// valid array or exit non-zero, never print partial garbage.
//
// Host-coupling lives here on purpose: the agent-grounding package stays
// probe-agnostic; this is the harness-side concrete probe. Copy/adapt it
// for systemd or pm2 hosts.

import { execFileSync } from "node:child_process";

/** Pull the first published host port out of a `docker ps` Ports string,
 *  e.g. "0.0.0.0:3001->3001/tcp, :::3001->3001/tcp" -> 3001. Returns
 *  undefined when the container publishes no host port. */
function firstHostPort(ports) {
  if (typeof ports !== "string") return undefined;
  const m = ports.match(/:(\d+)->/);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function main() {
  let raw;
  try {
    raw = execFileSync("docker", ["ps", "--format", "{{json .}}"], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    process.stderr.write(`docker-probe: docker ps failed: ${String(err)}\n`);
    process.exit(1);
  }

  const states = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      // A single malformed line shouldn't sink the whole probe; skip it.
      continue;
    }
    // `docker ps` may join multiple names with commas; the first is the
    // canonical container name expectations are written against.
    const name = String(row.Names ?? "").split(",")[0].trim();
    if (!name) continue;
    const state = {
      name,
      running: row.State === "running",
      startup_mode: "docker",
    };
    const port = firstHostPort(row.Ports);
    if (port !== undefined) state.port = port;
    states.push(state);
  }

  process.stdout.write(JSON.stringify(states) + "\n");
}

main();
