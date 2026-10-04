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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EX_NOINPUT, HarnessExitError } from "../../src/cli/exit-codes.js";
import { explainAction } from "../../src/cli/explain-action.js";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import { resolveEnv } from "../../src/cli/resolve-env.js";
import { testRisk } from "../../src/cli/test-risk.js";
import { resolveEnvironment } from "../../src/runtime/index.js";
import { makeManifest } from "../_helpers/manifest.js";
import {
  FIXTURES,
  GATE_PROD,
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

    // Classifier parity only: the classifier reads the raw command and the
    // tool, so this cannot notice a test-risk that stopped using the
    // enrichment helper. The helper-call-count test below is the guard for
    // routing through the helper.
    it(`test-risk classifier parity with explain-policy and the hook on: ${fx.name}`, async () => {
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

describe("documented limit: the kubectl --context merge is hook-only", () => {
  // The hook also merges an explicit `kubectl --context/--namespace` into
  // the environment (upgrade-only). The debug verbs do not: resolve-env
  // reports the ambient kube context, and explain-policy flags the skipped
  // merge per event via `parity.kubectl_target_present`. This pins that
  // known divergence so a change to it is deliberate.
  const kubeManifest = makeManifest({
    policies: [GATE_PROD],
    classifiers: [
      {
        name: "kube-delete",
        tool: "Bash",
        patterns: [{ pattern: "kubectl.*delete", categories: ["destructive"], severity: "critical" }],
      },
    ],
    resolvers: [
      {
        name: "prod-kube",
        environment: "production",
        signals: { kube_context_patterns: [".*prod.*"] },
      },
    ],
  });
  const command = "kubectl --context prod-cluster delete ns a";

  it("resolve-env stays on the ambient kube context while the hook resolves production", async () => {
    const eventPath = writeEvent(command, makeGitRepo("feature/work"));
    const seams = { env: {}, kubeContext: "dev-cluster", kubeNamespace: "" };

    const { resolution } = resolveEnv({ eventPath, manifest: kubeManifest, ...seams });
    const blocked = await hookBlocks(eventPath, { manifest: kubeManifest, kubeContext: "dev-cluster" });

    expect(resolution.name).toBe("unknown");
    expect(blocked).toBe(true);
    const projection = explainPolicy("gate-prod-destructive", {
      eventPath,
      manifest: kubeManifest,
      ...seams,
    }).projection;
    expect(projection.parity.kubectl_target_present).toBe(true);
  });
});

describe("explain-action manifest handling for a leading git switch", () => {
  const switchEvent = () => writeEvent("git switch main && ls", makeGitRepo("feature/work"));
  const emptyHome = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-parity-home-"));
    return dir;
  };

  it("does not load a manifest for a command without a leading git switch", () => {
    const eventPath = writeEvent("cd /nonexistent-dir-xyz && ls", makeGitRepo("feature/work"));
    // No `manifest` and no `configPath`: loading would throw (the loader
    // refuses the real home dir under test), so this passing proves the
    // lazy path.
    expect(() => explainAction({ eventPath, ...SEAMS })).not.toThrow();
  });

  it("falls back to the empty manifest when no manifest exists at the default location", () => {
    const homeDir = emptyHome();
    try {
      const eventPath = switchEvent();
      const { envelope } = explainAction({ eventPath, homeDir, ...SEAMS });
      // No resolvers, so the branch-switch upgrade is a no-op: the
      // envelope is the plain cwd context.
      expect(envelope.session.branch).toBe("feature/work");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("still fails with the manifest-not-found error for an explicit missing --config", () => {
    const eventPath = switchEvent();
    const configPath = path.join(os.tmpdir(), "harness-parity-missing", "harness.yaml");
    let caught: unknown;
    try {
      explainAction({ eventPath, configPath, ...SEAMS });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(EX_NOINPUT);
    expect((caught as Error).message).toContain("manifest not found");
  });

  it("applies the branch-switch upgrade when a manifest is present", () => {
    const eventPath = switchEvent();
    const { envelope } = explainAction({ eventPath, manifest, ...SEAMS });
    expect(envelope.session.branch).toBe("main");
  });
});
