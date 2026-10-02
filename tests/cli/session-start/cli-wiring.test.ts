import { beforeEach, describe, expect, it, vi } from "vitest";

// The session-start producers are imported directly by src/cli/index.ts, so
// the runners are replaced at the module boundary (other exports of each
// module stay real, since other commands import them). No network, no ledger, no
// subprocess: each test parses a real command line through buildProgram and
// asserts what the (stubbed) runner receives.
const runners = vi.hoisted(() => ({
  preflight: vi.fn(async (..._args: unknown[]) => undefined),
  branchCheck: vi.fn(async (..._args: unknown[]) => undefined),
  toolchainParity: vi.fn(async (..._args: unknown[]) => undefined),
  staleBase: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("../../../src/cli/session-start/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSessionStartPreflight: runners.preflight,
}));
vi.mock("../../../src/cli/session-start/branch-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSessionStartBranchCheck: runners.branchCheck,
}));
vi.mock("../../../src/cli/session-start/toolchain-parity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSessionStartToolchainParity: runners.toolchainParity,
}));
vi.mock("../../../src/cli/session-start/stale-base-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runSessionStartStaleBaseCheck: runners.staleBase,
}));

import { buildProgram } from "../../../src/cli/index.js";

async function run(argv: string[]): Promise<void> {
  const program = buildProgram({ stdout: () => {}, stderr: () => {} });
  await program.parseAsync(argv, { from: "user" });
}

const COMMON = ["--config", "c.yaml", "--project", "p", "--session", "s", "--ledger-timeout", "5"];

beforeEach(() => {
  for (const fn of Object.values(runners)) fn.mockClear();
});

describe("session-start producers receive the command-line options", () => {
  const advisory: Array<[string, keyof typeof runners]> = [
    ["branch-check", "branchCheck"],
    ["toolchain-parity", "toolchainParity"],
    ["stale-base-check", "staleBase"],
  ];

  it.each(advisory)("session-start %s passes config, project, session, cwd, ledger-timeout", async (sub, key) => {
    await run(["session-start", sub, ...COMMON, "--cwd", "/work/dir"]);
    expect(runners[key]).toHaveBeenCalledTimes(1);
    expect(runners[key].mock.calls[0]).toEqual([
      {
        configPath: "c.yaml",
        project: "p",
        session: "s",
        cwd: "/work/dir",
        ledgerTimeoutMs: 5,
      },
    ]);
  });

  it.each(advisory)("session-start %s leaves unset options out", async (sub, key) => {
    await run(["session-start", sub]);
    expect(runners[key].mock.calls[0]).toEqual([{}]);
  });

  it("an advisory producer does not call a sibling runner", async () => {
    await run(["session-start", "branch-check", "--cwd", "/x"]);
    expect(runners.branchCheck).toHaveBeenCalledTimes(1);
    expect(runners.toolchainParity).not.toHaveBeenCalled();
    expect(runners.staleBase).not.toHaveBeenCalled();
    expect(runners.preflight).not.toHaveBeenCalled();
  });
});

describe("preflight and its alias receive the command-line options", () => {
  // `preflight` declares no --cwd option (the runner resolves the cwd from
  // the SessionStart event), so the cwd pass-through is pinned on the other
  // three producers and here only the options the command declares.
  const entries: Array<[string, string[]]> = [
    ["session-start preflight", ["session-start", "preflight"]],
    ["preflight alias", ["preflight"]],
  ];

  it.each(entries)("%s passes config, project, session, ledger-timeout, timeout", async (_name, prefix) => {
    await run([...prefix, ...COMMON, "--timeout", "7"]);
    expect(runners.preflight).toHaveBeenCalledTimes(1);
    const arg = runners.preflight.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      configPath: "c.yaml",
      project: "p",
      session: "s",
      ledgerTimeoutMs: 5,
      preflightTimeoutMs: 7,
    });
    expect(typeof arg.stagePendingApproval).toBe("function");
    expect(arg).not.toHaveProperty("cwd");
  });

  it.each(entries)("%s ignores a non-positive ledger timeout", async (_name, prefix) => {
    await run([...prefix, "--ledger-timeout", "0"]);
    const arg = runners.preflight.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("ledgerTimeoutMs");
  });
});
