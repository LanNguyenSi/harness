import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { resolveEnv } from "../../src/cli/resolve-env.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";
import type { GitRepoContext } from "../../src/runtime/git-context.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeEvent(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-resolve-env-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "event.json");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "psql" },
});

const MANIFEST: Manifest = parseManifest({
  version: 1,
  environments: {
    resolvers: [
      {
        name: "production-signals",
        environment: "production",
        signals: {
          branch_patterns: ["main"],
          env_var_patterns: [{ var: "DATABASE_URL", patterns: ["prod"] }],
        },
      },
    ],
  },
});

const EMPTY_MANIFEST: Manifest = parseManifest({ version: 1 });

// Deterministic seams: a feature branch (no branch-signal match), empty
// kube context/namespace, env supplied per-test.
const SEAMS = {
  now: new Date("2026-05-22T12:00:00.000Z"),
  host: "h",
  user: "u",
  resolveGit: (): GitRepoContext => ({ repo: "r", branch: "feature/x", sha: "" }),
  cwdFallback: "/fallback",
  kubeContext: "",
  kubeNamespace: "",
};

describe("resolveEnv — resolution", () => {
  it("resolves production from an env-var signal", () => {
    const file = writeEvent(EVENT);
    const result = resolveEnv({
      ...SEAMS,
      eventPath: file,
      manifest: MANIFEST,
      env: { DATABASE_URL: "postgres://prod-db/app" },
    });
    expect(result.resolution.name).toBe("production");
    expect(result.resolution.resolver).toBe("production-signals");
    expect(parseYaml(result.output)).toEqual(result.resolution);
  });

  it("emits valid JSON with --json", () => {
    const file = writeEvent(EVENT);
    const result = resolveEnv({
      ...SEAMS,
      eventPath: file,
      manifest: MANIFEST,
      env: { DATABASE_URL: "prod" },
      json: true,
    });
    expect(JSON.parse(result.output)).toEqual(result.resolution);
    expect(result.output.endsWith("\n")).toBe(true);
  });

  it("resolves to unknown when no signal matches", () => {
    const file = writeEvent(EVENT);
    const result = resolveEnv({
      ...SEAMS,
      eventPath: file,
      manifest: MANIFEST,
      env: {},
    });
    expect(result.resolution.name).toBe("unknown");
    expect(result.resolution.resolver).toBeNull();
  });

  it("resolves to unknown when the manifest declares no resolvers", () => {
    const file = writeEvent(EVENT);
    const result = resolveEnv({
      ...SEAMS,
      eventPath: file,
      manifest: EMPTY_MANIFEST,
      env: { DATABASE_URL: "prod" },
    });
    expect(result.resolution.name).toBe("unknown");
  });
});

describe("resolveEnv — input errors", () => {
  it("throws EX_NOINPUT when the event file is missing", () => {
    let caught: unknown;
    try {
      resolveEnv({ ...SEAMS, eventPath: "/nonexistent.json", manifest: MANIFEST });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
    expect((caught as HarnessExitError).message).toMatch(/resolve-env:/);
  });
});
