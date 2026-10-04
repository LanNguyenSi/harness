// Divergence guard (task 7c3919a2): `harness explain-policy` and
// `harness policy intercept` must resolve the same environment for the
// same Bash command, including the leading-prefix idioms (inline
// `VAR=value`, quoted values, several assignments, `cd <path> &&`,
// `git switch <branch> &&`). Before the shared enrichment, explain-policy
// reported `unknown` for a command the hook resolved to `production`.
//
// Each fixture runs through both surfaces with identical seams. The hook's
// verdict is observed as block/allow of a `block`-enforced policy whose
// `when:` needs production; explain-policy's as `applies`. The explicit
// `expectedEnv` pins the resolved name so a drift in BOTH surfaces at once
// also fails.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import {
  FIXTURES,
  hookBlocks,
  makeGitRepo,
  manifest,
  runParityCleanups,
  writeEvent,
} from "../_helpers/intercept-parity.js";

// Any ledger session opened from explain-policy's code path would go
// through this export; the guard test below asserts it is never reached.
const ledgerSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/policies/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/policies/index.js")>();
  return {
    ...actual,
    openLedgerSession: (...args: unknown[]) => {
      ledgerSpy(...args);
      throw new Error("explain-policy must not open a ledger session");
    },
  };
});

afterEach(runParityCleanups);

function explain(eventPath: string) {
  return explainPolicy("gate-prod-destructive", {
    eventPath,
    manifest,
    env: {},
    kubeContext: "",
    kubeNamespace: "",
  }).projection;
}

describe("explain-policy vs policy intercept: same environment resolution", () => {
  it("has at least five fixtures including a quoted prefix and multiple assignments", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
    expect(FIXTURES.some((f) => f.command({ prod: "" }).includes('DATABASE_URL="'))).toBe(true);
    expect(FIXTURES.some((f) => /^A=1 .*B=/.test(f.command({ prod: "" })))).toBe(true);
  });

  for (const fx of FIXTURES) {
    it(`agrees on: ${fx.name}`, async () => {
      const cwd = makeGitRepo("feature/work");
      const prod = makeGitRepo("main");
      const eventPath = writeEvent(fx.command({ prod }), cwd);

      const projection = explain(eventPath);
      const blocked = await hookBlocks(eventPath);

      expect(projection.environment.name).toBe(fx.expectedEnv);
      expect(projection.applies).toBe(fx.expectedEnv === "production");
      // The hook's verdict must match explain-policy's `applies`.
      expect(blocked).toBe(projection.applies);
    });
  }

  it("marks what explain-policy deliberately does not mirror from the hook", () => {
    const cwd = makeGitRepo("feature/work");
    const projection = explain(writeEvent('psql -c "DROP TABLE users"', cwd));
    expect(projection.parity.envelope_enrichment).toEqual([
      "inline_env",
      "cd_git_context",
      "branch_switch_upgrade",
    ]);
    expect(projection.parity.not_evaluated).toEqual(["ledger_requires", "kubectl_target"]);
  });
});

describe("explain-policy: per-event kubectl_target_present flag (task 8b891e83)", () => {
  const cases: Array<{ name: string; command: string; present: boolean }> = [
    {
      name: "kubectl --context on a delete",
      command: "kubectl --context prod-cluster delete ns a",
      present: true,
    },
    {
      name: "kubectl -n only",
      command: "kubectl delete pod x -n payments",
      present: true,
    },
    {
      name: "kubectl --namespace= form behind an inline-env prefix",
      command: "A=1 kubectl delete pod x --namespace=payments",
      present: true,
    },
    {
      name: "kubectl behind a cd prefix",
      command: "cd /tmp && kubectl --context prod-cluster delete ns a",
      present: true,
    },
    {
      name: "kubectl without --context/--namespace (negative)",
      command: "kubectl delete ns a",
      present: false,
    },
    {
      name: "non-kubectl command (negative)",
      command: 'psql -c "DROP TABLE users"',
      present: false,
    },
    {
      name: "kubectl-looking flag on a non-kubectl command (negative)",
      command: "echo kubectl --context prod-cluster",
      present: false,
    },
  ];
  for (const c of cases) {
    it(`flags ${c.name}: ${String(c.present)}`, () => {
      const cwd = makeGitRepo("feature/work");
      const projection = explain(writeEvent(c.command, cwd));
      expect(projection.parity.kubectl_target_present).toBe(c.present);
      // The static not_evaluated list keeps its meaning: the merge is
      // never evaluated by this verb, whatever the flag says.
      expect(projection.parity.not_evaluated).toContain("kubectl_target");
    });
  }

  it("is false for a non-Bash event", () => {
    const cwd = makeGitRepo("feature/work");
    const dir = path.dirname(writeEvent("x", cwd));
    const file = path.join(dir, "edit-event.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/x", command: "kubectl --context prod delete ns a" },
        session_id: "sess-parity",
        cwd,
      }),
    );
    expect(explain(file).parity.kubectl_target_present).toBe(false);
  });
});

describe("explain-policy stays ledger-free", () => {
  it("never opens a ledger session, even for a gating production fixture", () => {
    ledgerSpy.mockClear();
    const cwd = makeGitRepo("feature/work");
    const projection = explain(
      writeEvent(
        'DATABASE_URL=postgres://u@prod-db:5432/app psql -c "DROP TABLE users"',
        cwd,
      ),
    );
    expect(projection.applies).toBe(true);
    expect(ledgerSpy).not.toHaveBeenCalled();
  });

  it("neither verb-side source imports the ledger or evidence modules", () => {
    for (const rel of [
      "../../src/cli/explain-policy.ts",
      "../../src/cli/policy/risk-envelope-enrichment.ts",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      expect(src).not.toMatch(/from\s+"[^"]*policies\//);
      expect(src).not.toMatch(/ledger-client|openLedgerSession/);
    }
  });
});
