// Task d03af8f6 — `harness explain-policy` coverage for
// gate-dev-unsafe-deletion / `action.deletion_target_unresolvable`.
//
// AC1 names explain-policy explicitly ("explain-policy zeigt applies:
// true"); tests/runtime/intercept-deletion-gate.test.ts covers the
// `policy intercept` require_approval envelope side.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import type { GitRepoContext } from "../../src/runtime/git-context.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeEvent(command: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-deletion-gate-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "event.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
    "utf8",
  );
  return file;
}

// The shipped policy shape (docs/examples/full-manifest.yaml /
// src/cli/init/templates.ts), parsed through the REAL schema so
// `risk.safe_deletion_roots` gets the real default (`/tmp`,
// `/private/tmp`) rather than a hand-built stand-in.
const MANIFEST: Manifest = parseManifest({
  version: 1,
  hooks: [
    { name: "risk-gate", event: "PreToolUse", command: "/usr/bin/true", blocking: false },
  ],
  policies: [
    {
      name: "gate-dev-unsafe-deletion",
      description: "require approval for a deletion-verb command whose target cannot be statically proven safe",
      trigger: { event: "PreToolUse", match: "Bash" },
      when: { "action.deletion_target_unresolvable": true },
      requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
      hook: "risk-gate",
      enforcement: "require_approval",
    },
  ],
});

// Deterministic seams: an ordinary task branch, no production resolver
// declared at all, so environment always resolves "unknown".
const seams = (branch: string) => ({
  now: new Date("2026-08-26T12:00:00.000Z"),
  host: "h",
  user: "u",
  resolveGit: (): GitRepoContext => ({ repo: "r", branch, sha: "" }),
  cwdFallback: "/fallback",
  env: {},
  kubeContext: "",
  kubeNamespace: "",
});

describe("explainPolicy — AC1: dev-context, target outside the allowlist", () => {
  it("reports applies:true with environment unknown", () => {
    const file = writeEvent("rm -rf /home/lan/git/pandora/some-dir");
    const { projection } = explainPolicy("gate-dev-unsafe-deletion", {
      ...seams("task/x"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.environment.name).toBe("unknown");
    expect(projection.deletion_target).toMatchObject({
      verb: "rm",
      unresolvable: true,
      unresolvedTargets: ["/home/lan/git/pandora/some-dir"],
    });
    expect(projection.when).toMatchObject({ declared: true, matched: true });
    expect(projection.applies).toBe(true);
  });
});

describe("explainPolicy — AC2: target inside a declared safe root", () => {
  it("reports applies:false (allow)", () => {
    const file = writeEvent("rm -rf /tmp/scratch/build-output");
    const { projection } = explainPolicy("gate-dev-unsafe-deletion", {
      ...seams("task/x"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.deletion_target).toMatchObject({ unresolvable: false });
    expect(projection.applies).toBe(false);
  });

  it.each(["ls -la", "git status", "git diff"])(
    "does not misclassify the read-only command %j as a deletion target",
    (command) => {
      const file = writeEvent(command);
      const { projection } = explainPolicy("gate-dev-unsafe-deletion", {
        ...seams("task/x"),
        eventPath: file,
        manifest: MANIFEST,
      });
      expect(projection.deletion_target).toBeNull();
      expect(projection.applies).toBe(false);
    },
  );
});

describe("explainPolicy — AC3: unresolvable-target fixtures", () => {
  it.each([
    "rm -rf $SCRATCH_DIR/foo",
    "rm -rf scratch-files",
    "rm -rf /tmp/scratch/../../home/lan/x",
  ])("reports applies:true for %j", (command) => {
    const file = writeEvent(command);
    const { projection } = explainPolicy("gate-dev-unsafe-deletion", {
      ...seams("task/x"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.deletion_target?.unresolvable).toBe(true);
    expect(projection.applies).toBe(true);
  });
});
