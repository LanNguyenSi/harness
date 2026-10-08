// `harness apply` prints the manifest posture warnings (task 2ce6933f): a
// manifest that still names the removed post-merge-gate pack applies with
// the strip warning from the loader surfaced in ApplyResult.warnings (which
// the CLI prints), and the generated settings carry nothing of the pack.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { GENERATED_DIRNAME, SETTINGS_BASENAME, apply } from "../../../src/cli/apply/index.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-apply-posture-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeManifest(extra: Record<string, unknown> = {}): string {
  const manifest = {
    version: 1,
    tools: {
      mcp: [],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: [] },
    hooks: [],
    policies: [],
    ...extra,
  };
  const target = path.join(tmpHome, "harness.yaml");
  fs.writeFileSync(target, yamlStringify(manifest));
  return target;
}

const PMG_PACKS = [
  { name: "branch-protection" },
  { name: "post-merge-gate", enabled: true, config: { anything: 1 } },
];

describe("apply surfaces the removed-pack posture warnings", () => {
  it("a manifest naming the removed pack: apply succeeds, warns at policy_packs[1], and generates no post-merge-gate content", async () => {
    writeManifest({ policy_packs: PMG_PACKS });
    const result = await apply({ homeDir: tmpHome });
    expect(result.outcome).toBe("applied");
    expect(
      result.warnings.some((w) => w.startsWith("policy_packs[1]") && w.includes("removed in 1.0.0")),
    ).toBe(true);

    const settings = fs.readFileSync(
      path.join(tmpHome, GENERATED_DIRNAME, SETTINGS_BASENAME),
      "utf8",
    );
    expect(settings).not.toContain("post-merge-gate");
  });

  it("a manifest without the removed pack: no such warning", async () => {
    writeManifest({ policy_packs: [{ name: "branch-protection" }] });
    const result = await apply({ homeDir: tmpHome });
    expect(result.outcome).toBe("applied");
    expect(result.warnings.some((w) => w.includes("post-merge-gate"))).toBe(false);
  });
});
