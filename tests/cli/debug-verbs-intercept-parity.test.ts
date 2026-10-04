// Divergence guard (task 8b891e83): `harness resolve-env`,
// `harness test-risk` and `harness explain-action` must read the same
// Bash-prefix-enriched inputs as `harness policy intercept` (inline
// `VAR=value`, leading `cd`, leading `git switch|checkout`). Before the
// shared enrichment they read only the ambient environment, so
// `DATABASE_URL=...prod... psql ...` resolved `unknown` in the debug
// verbs and `production` in the hook.
//
// The corpus is the explain-policy parity corpus (tests/_helpers/
// intercept-parity.ts); the hook's verdict is its block/allow of a
// `block`-enforced policy that needs a production environment AND a high
// risk, so each verb is checked against the half of that verdict it owns.

import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainAction } from "../../src/cli/explain-action.js";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import { resolveEnv } from "../../src/cli/resolve-env.js";
import { testRisk } from "../../src/cli/test-risk.js";
import { resolveEnvironment } from "../../src/runtime/index.js";
import {
  FIXTURES,
  hookBlocks,
  makeGitRepo,
  manifest,
  runParityCleanups,
  writeEvent,
} from "../_helpers/intercept-parity.js";

// Records every call to the shared enrichment helper without changing it,
// so a verb that stops routing through it fails even where the printed
// output happens to be identical (test-risk's profile is raw-command only).
const helperSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/policy/risk-envelope-enrichment.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/policy/risk-envelope-enrichment.js")>();
  return {
    ...actual,
    resolveBashPrefixEnrichment: (...args: Parameters<typeof actual.resolveBashPrefixEnrichment>) => {
      helperSpy(...args);
      return actual.resolveBashPrefixEnrichment(...args);
    },
  };
});

afterEach(runParityCleanups);

const SEAMS = { env: {}, kubeContext: "", kubeNamespace: "" } as const;

describe("debug verbs vs policy intercept: same enriched inputs", () => {
  for (const fx of FIXTURES) {
    const command = (prod: string) => fx.command({ prod });
    const gitDriven = fx.expectedEnv === "production" && !command("").includes("DATABASE_URL");

    it(`resolve-env agrees with the hook on: ${fx.name}`, async () => {
      const cwd = makeGitRepo("feature/work");
      const prod = makeGitRepo("main");
      const eventPath = writeEvent(command(prod), cwd);

      const { resolution } = resolveEnv({ eventPath, manifest, ...SEAMS });
      const blocked = await hookBlocks(eventPath);

      expect(resolution.name).toBe(fx.expectedEnv);
      // Every fixture is a critical-severity command, so the hook blocks
      // exactly when the environment resolves to production.
      expect(blocked).toBe(resolution.name === "production");
    });

    it(`test-risk agrees with the hook and explain-policy on: ${fx.name}`, async () => {
      const cwd = makeGitRepo("feature/work");
      const prod = makeGitRepo("main");
      const eventPath = writeEvent(command(prod), cwd);

      const { profile } = testRisk({ eventPath, manifest, ...SEAMS });
      const explained = explainPolicy("gate-prod-destructive", {
        eventPath,
        manifest,
        ...SEAMS,
      }).projection;
      const { resolution } = resolveEnv({ eventPath, manifest, ...SEAMS });
      const blocked = await hookBlocks(eventPath);

      expect(profile.severity).toBe("critical");
      expect(profile).toEqual(explained.classifier);
      // The hook's block is (risk >= high) AND (env == production): the
      // risk half comes from test-risk, the environment half from resolve-env.
      expect(blocked).toBe(profile.severity === "critical" && resolution.name === "production");
    });

    it(`explain-action prints the hook's git context on: ${fx.name}`, async () => {
      const cwd = makeGitRepo("feature/work");
      const prod = makeGitRepo("main");
      const eventPath = writeEvent(command(prod), cwd);

      const { envelope } = explainAction({ eventPath, manifest, ...SEAMS });
      const blocked = await hookBlocks(eventPath);

      // Branch-resolving what explain-action printed must agree with the
      // hook for the git-driven prefixes (`cd`, `git switch`); the inline
      // env prefixes are not part of the envelope, so there it must be the
      // plain cwd context and resolve like the cwd does.
      const fromEnvelope = resolveEnvironment(envelope, manifest.environments.resolvers, {
        env: {},
        kubeContext: "",
        kubeNamespace: "",
      });
      if (gitDriven) {
        expect(envelope.session.branch).toBe("main");
        expect(fromEnvelope.name).toBe("production");
        expect(blocked).toBe(true);
      } else {
        expect(envelope.session.branch).toBe("feature/work");
        expect(fromEnvelope.name).toBe("unknown");
      }
    });
  }

  it("includes the inline DATABASE_URL production case that resolved unknown before", () => {
    const cwd = makeGitRepo("feature/work");
    const eventPath = writeEvent(
      'DATABASE_URL=postgres://u@prod-db:5432/app psql -c "DROP TABLE users"',
      cwd,
    );
    expect(resolveEnv({ eventPath, manifest, ...SEAMS }).resolution.name).toBe("production");
  });

  it("explain-action prints the cd target's repo, not the cwd's", () => {
    const cwd = makeGitRepo("feature/work");
    const prod = makeGitRepo("main");
    const eventPath = writeEvent(`cd ${prod} && rm -rf /var/lib/appdata`, cwd);
    const { envelope } = explainAction({ eventPath, manifest, ...SEAMS });
    expect(envelope.session.repo).toBe(path.basename(prod));
  });
});

describe("each verb routes through resolveBashPrefixEnrichment", () => {
  const eventFor = () =>
    writeEvent('DATABASE_URL=postgres://u@prod-db:5432/app psql -c "DROP TABLE users"', makeGitRepo("feature/work"));

  it("resolve-env", () => {
    helperSpy.mockClear();
    resolveEnv({ eventPath: eventFor(), manifest, ...SEAMS });
    expect(helperSpy).toHaveBeenCalledTimes(1);
  });
  it("test-risk", () => {
    helperSpy.mockClear();
    testRisk({ eventPath: eventFor(), manifest, ...SEAMS });
    expect(helperSpy).toHaveBeenCalledTimes(1);
  });
  it("explain-action", () => {
    helperSpy.mockClear();
    explainAction({ eventPath: eventFor(), manifest, ...SEAMS });
    expect(helperSpy).toHaveBeenCalledTimes(1);
  });
  it("explain-policy", () => {
    helperSpy.mockClear();
    explainPolicy("gate-prod-destructive", { eventPath: eventFor(), manifest, ...SEAMS });
    expect(helperSpy).toHaveBeenCalledTimes(1);
  });
});

describe("explain-action keeps working with no manifest on the machine", () => {
  it("does not load a manifest for a command without a leading git switch", () => {
    const eventPath = writeEvent("cd /nonexistent-dir-xyz && ls", makeGitRepo("feature/work"));
    // No `manifest` and no `configPath`: loading would throw (the loader
    // refuses the real home dir under test), so this passing proves the
    // lazy path.
    expect(() => explainAction({ eventPath, ...SEAMS })).not.toThrow();
  });

  it("loads the manifest for a leading git switch (needs the resolvers)", () => {
    const eventPath = writeEvent("git switch main && ls", makeGitRepo("feature/work"));
    expect(() => explainAction({ eventPath, ...SEAMS })).toThrow();
  });
});
