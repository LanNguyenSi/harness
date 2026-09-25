import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { composeCustom } from "../../src/cli/init/composer.js";
import { TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { runPackHookPostToolUseCli } from "../../src/cli/pack/hook-post-tool-use.js";
import {
  approvalMarkerPathFor,
  taskApprovalMarkerPathFor,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Harness task 5018c0c4: a task_finish that lands in review keeps the
// approval, so on the review-then-task_merge path the approval expires
// only at task_merge. The runtime boundary list comes from the manifest's
// explicit `expire_on_tool_match` alone, and the emitted PostToolUse
// matcher is built from that same list, so every scaffold `harness init`
// writes has to list task_merge itself. Each scaffold below is expanded
// the way `harness apply` does and replayed through the real hook.

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "track-active-claim",
  "real-posttooluse-task-finish-2.1.280.json",
);
const SESSION = "redacted-session-id";
const TASK = "abc-123";
const TASK_MERGE = "mcp__agent-tasks__task_merge";

const SCAFFOLDS: Array<[string, () => Manifest]> = [
  ["init --template full", () => parseManifest(parseYaml(FULL_TEMPLATE))],
  ["init --template team", () => parseManifest(parseYaml(TEAM_TEMPLATE))],
  [
    "init --interactive (custom composer)",
    () =>
      parseManifest(
        parseYaml(
          composeCustom({ packs: ["understanding-before-execution"], mcps: [], policies: [] }).yaml,
        ),
      ),
  ],
];

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-scaffold-expiry-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function sink(): Writable {
  return new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
}

function loadFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
}

describe("init scaffolds expire the approval on review-then-task_merge (harness 5018c0c4)", () => {
  for (const [label, load] of SCAFFOLDS) {
    it(`${label}: finish to review keeps the approval, the later task_merge expires it`, async () => {
      const manifest = load();

      // The emitted matcher routes task_merge to the hook at all.
      const { hooks } = expandPolicyPacks(manifest);
      const post = hooks.find(
        (h) => h.name === "policy-pack:understanding-before-execution:post-tool-use",
      );
      expect(post?.match).toBeDefined();
      expect(new RegExp(post!.match!).test(TASK_MERGE)).toBe(true);

      const generatedDir = path.join(tmp, "harness.generated");
      writeApprovalMarker(generatedDir, SESSION, {
        approvedAt: new Date().toISOString(),
        approvedBy: "test-operator",
      });
      writeTaskApprovalMarker(generatedDir, TASK, {
        approvedAt: new Date().toISOString(),
        approvedBy: "test-operator",
      });

      const replay = async (event: Record<string, unknown>): Promise<boolean> =>
        (
          await runPackHookPostToolUseCli({
            manifest,
            stdin: readableFromString(JSON.stringify(event)),
            stderr: sink(),
            generatedDir,
            reportsDir: path.join(tmp, "reports"),
          })
        ).matchedExpiry;

      // The verbatim capture: task_finish lands abc-123 in review.
      expect(await replay(loadFixture())).toBe(false);
      expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(true);
      expect(fs.existsSync(taskApprovalMarkerPathFor(generatedDir, TASK))).toBe(true);

      // The merge, same content-block envelope with the task now done.
      const merge = loadFixture();
      merge["tool_name"] = TASK_MERGE;
      merge["tool_response"] = [
        { type: "text", text: JSON.stringify({ ok: true, task: { id: TASK, status: "done" } }) },
      ];
      expect(await replay(merge)).toBe(true);
      expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(false);
      expect(fs.existsSync(taskApprovalMarkerPathFor(generatedDir, TASK))).toBe(false);
    });
  }
});
