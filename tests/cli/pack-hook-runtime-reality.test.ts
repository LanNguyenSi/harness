import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExpectationsLoadResult, Probe } from "@lannguyensi/runtime-reality-checker/policy";
import type { ActualProcessState } from "@lannguyensi/runtime-reality-checker";
import {
  buildSubprocessProbe,
  parseProbeOutput,
  runPackHookRuntimeRealityCli,
  runRuntimeRealityHook,
  type RuntimeRealityHookDeps,
} from "../../src/cli/pack/hook-runtime-reality.js";

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

// A PreToolUse payload that matches the compose-mutation trigger.
const TRIGGER_PAYLOAD = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "docker-compose -f docker-compose.prod.yml restart panel-api" },
});
// A payload that matches no trigger (read-only).
const NON_TRIGGER_PAYLOAD = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
});

function expectations(
  processes: { name: string; expected_startup?: string; expected_port?: number }[],
): ExpectationsLoadResult {
  return {
    ok: true,
    file: { domain: "deploy-panel", processes: processes as never },
  };
}

function deps(opts: {
  load: ExpectationsLoadResult;
  probe: Probe | null;
}): RuntimeRealityHookDeps {
  return {
    loadExpectations: () => opts.load,
    buildProbe: () => opts.probe,
  };
}

const KEYWORD_ENV = { RUNTIME_REALITY_KEYWORD: "deploy-panel" } as NodeJS.ProcessEnv;

describe("parseProbeOutput", () => {
  it("parses a valid ActualProcessState array", () => {
    const states = parseProbeOutput(
      JSON.stringify([{ name: "panel-api", running: true, startup_mode: "docker", port: 3001 }]),
    );
    expect(states).toEqual([
      { name: "panel-api", running: true, startup_mode: "docker", port: 3001 },
    ]);
  });

  it("throws on empty / whitespace output (degrades via handler probe-fail, never phantom drift)", () => {
    expect(() => parseProbeOutput("")).toThrow(/empty/);
    expect(() => parseProbeOutput("   \n ")).toThrow(/empty/);
  });

  it("throws on non-JSON", () => {
    expect(() => parseProbeOutput("not json")).toThrow(/not valid JSON/);
  });

  it("throws when the top level is not an array", () => {
    expect(() => parseProbeOutput(JSON.stringify({ name: "x", running: true }))).toThrow(
      /not a JSON array/,
    );
  });

  it("throws when an entry is missing name or running", () => {
    expect(() => parseProbeOutput(JSON.stringify([{ running: true }]))).toThrow(/name must be a string/);
    expect(() => parseProbeOutput(JSON.stringify([{ name: "x" }]))).toThrow(/running must be a boolean/);
  });
});

describe("buildSubprocessProbe", () => {
  it("returns null when no command is configured", () => {
    expect(buildSubprocessProbe(undefined, {})).toBeNull();
    expect(buildSubprocessProbe("   ", {})).toBeNull();
  });

  it("spawns the command and parses its JSON stdout", () => {
    const json = JSON.stringify([{ name: "panel-api", running: true }]);
    const probe = buildSubprocessProbe(`cat <<'EOF'\n${json}\nEOF`, {})!;
    expect(probe({ keyword: "deploy-panel", expected: [] })).toEqual([
      { name: "panel-api", running: true },
    ]);
  });

  it("exposes the keyword to the probe via RUNTIME_REALITY_KEYWORD", () => {
    // The probe echoes back a state named after the env var, proving the
    // keyword reaches the spawned command's environment.
    const probe = buildSubprocessProbe(
      `printf '[{"name":"%s","running":true}]' "$RUNTIME_REALITY_KEYWORD"`,
      {},
    )!;
    const states = probe({ keyword: "agent-relay", expected: [] }) as ActualProcessState[];
    expect(states[0]!.name).toBe("agent-relay");
  });

  it("throws when the command exits non-zero (handler then applies fail-open policy)", () => {
    const probe = buildSubprocessProbe("exit 3", {})!;
    expect(() => probe({ keyword: "deploy-panel", expected: [] })).toThrow();
  });
});

describe("runRuntimeRealityHook decision matrix", () => {
  it("skips (allow, silent) when no trigger matches", () => {
    const r = runRuntimeRealityHook(NON_TRIGGER_PAYLOAD, KEYWORD_ENV, deps({
      load: expectations([{ name: "panel-api" }]),
      probe: () => [],
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.kind).toBe("skip");
  });

  it("allows when the keyword is unset (no baseline)", () => {
    const r = runRuntimeRealityHook(TRIGGER_PAYLOAD, {} as NodeJS.ProcessEnv, deps({
      load: expectations([{ name: "panel-api" }]),
      probe: () => [{ name: "panel-api", running: true }],
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("allows silently when runtime matches expectations (golden path)", () => {
    const r = runRuntimeRealityHook(TRIGGER_PAYLOAD, KEYWORD_ENV, deps({
      load: expectations([{ name: "panel-api" }, { name: "panel-frontend" }]),
      probe: () => [
        { name: "panel-api", running: true },
        { name: "panel-frontend", running: true },
      ],
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.kind).toBe("allow");
  });

  it("denies on critical drift (a process is missing)", () => {
    const r = runRuntimeRealityHook(TRIGGER_PAYLOAD, KEYWORD_ENV, deps({
      load: expectations([{ name: "panel-api" }, { name: "panel-frontend" }]),
      probe: () => [{ name: "panel-api", running: true }],
    }));
    expect(r.exitCode).toBe(2);
    expect(r.decision.kind).toBe("block");
    const envelope = JSON.parse(r.stdout);
    expect(envelope.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(envelope.hookSpecificOutput.permissionDecisionReason).toContain("panel-frontend");
  });

  it("allows warning-tier drift (port mismatch) with a stderr note", () => {
    const r = runRuntimeRealityHook(TRIGGER_PAYLOAD, KEYWORD_ENV, deps({
      load: expectations([{ name: "panel-api", expected_port: 3001 }]),
      probe: () => [{ name: "panel-api", running: true, port: 9999 }],
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("drift detected");
    expect(r.decision.kind).toBe("warn");
  });

  it("escalates warning to deny under RUNTIME_REALITY_WARN_AS_BLOCK", () => {
    const r = runRuntimeRealityHook(
      TRIGGER_PAYLOAD,
      { ...KEYWORD_ENV, RUNTIME_REALITY_WARN_AS_BLOCK: "1" },
      deps({
        load: expectations([{ name: "panel-api", expected_port: 3001 }]),
        probe: () => [{ name: "panel-api", running: true, port: 9999 }],
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("degrades critical to allow under RUNTIME_REALITY_CRITICAL_AS_WARN", () => {
    const r = runRuntimeRealityHook(
      TRIGGER_PAYLOAD,
      { ...KEYWORD_ENV, RUNTIME_REALITY_CRITICAL_AS_WARN: "1" },
      deps({
        load: expectations([{ name: "panel-api" }, { name: "panel-frontend" }]),
        probe: () => [{ name: "panel-api", running: true }],
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.kind).toBe("warn");
  });

  it("fails open when the probe throws", () => {
    const r = runRuntimeRealityHook(TRIGGER_PAYLOAD, KEYWORD_ENV, deps({
      load: expectations([{ name: "panel-api" }]),
      probe: () => {
        throw new Error("docker daemon unreachable");
      },
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("denies on probe failure under RUNTIME_REALITY_PROBE_FAIL_BLOCK", () => {
    const r = runRuntimeRealityHook(
      TRIGGER_PAYLOAD,
      { ...KEYWORD_ENV, RUNTIME_REALITY_PROBE_FAIL_BLOCK: "1" },
      deps({
        load: expectations([{ name: "panel-api" }]),
        probe: () => {
          throw new Error("docker daemon unreachable");
        },
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows when no probe is configured (degrade, not phantom drift)", () => {
    const r = runRuntimeRealityHook(TRIGGER_PAYLOAD, KEYWORD_ENV, deps({
      load: expectations([{ name: "panel-api" }]),
      probe: null,
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("runPackHookRuntimeRealityCli (entrypoint, real env + probe)", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "RUNTIME_REALITY_KEYWORD",
    "RUNTIME_REALITY_EXPECTATIONS_DIR",
    "RUNTIME_REALITY_PROBE_CMD",
    "RUNTIME_REALITY_DISABLE",
    "RUNTIME_REALITY_WARN_AS_BLOCK",
    "RUNTIME_REALITY_CRITICAL_AS_WARN",
    "RUNTIME_REALITY_PROBE_FAIL_BLOCK",
  ];

  function writeProbe(body: string): string {
    const p = path.join(tmp, "probe.sh");
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    return `sh ${p}`;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-cli-"));
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const expDir = path.join(tmp, "exp");
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(
      path.join(expDir, "deploy-panel.json"),
      JSON.stringify({
        domain: "deploy-panel",
        processes: [
          { name: "panel-api", expected_startup: "docker", expected_port: 3001 },
          { name: "panel-frontend", expected_startup: "docker", expected_port: 3000 },
        ],
      }),
    );
    process.env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    process.env.RUNTIME_REALITY_EXPECTATIONS_DIR = expDir;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns exit 2 and writes a COMPLETE deny envelope to stdout on critical drift", async () => {
    // probe reports panel-frontend missing -> critical.
    process.env.RUNTIME_REALITY_PROBE_CMD = writeProbe(
      `printf '[{"name":"panel-api","running":true,"startup_mode":"docker","port":3001}]'`,
    );
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookRuntimeRealityCli({
      stdin: readableFromString(TRIGGER_PAYLOAD),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(result.exitCode).toBe(2);
    // The envelope must survive intact to stdout: this is the load-bearing
    // block signal and the reason the entrypoint returns (vs process.exit).
    const envelope = JSON.parse(stdout.read());
    expect(envelope.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(envelope.hookSpecificOutput.permissionDecisionReason).toContain("panel-frontend");
    expect(stderr.read()).toContain("Fix drift before continuing");
  });

  it("returns exit 0 with silent stdout on the golden path", async () => {
    process.env.RUNTIME_REALITY_PROBE_CMD = writeProbe(
      `printf '[{"name":"panel-api","running":true},{"name":"panel-frontend","running":true}]'`,
    );
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookRuntimeRealityCli({
      stdin: readableFromString(TRIGGER_PAYLOAD),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.read()).toBe("");
  });

  it("degrades to allow (exit 0) when the probe command fails", async () => {
    process.env.RUNTIME_REALITY_PROBE_CMD = writeProbe("exit 7");
    const stdout = bufferStream();
    const result = await runPackHookRuntimeRealityCli({
      stdin: readableFromString(TRIGGER_PAYLOAD),
      stdout: stdout.stream,
      stderr: bufferStream().stream,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.read()).toBe("");
  });
});
