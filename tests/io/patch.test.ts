import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNoop, unifiedDiff } from "../../src/io/patch.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-patch-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("unifiedDiff", () => {
  it("produces a `---`/`+++` header pair with the given file name and labels", () => {
    const d = unifiedDiff({
      fileName: "harness.yaml",
      oldText: "a\n",
      newText: "b\n",
      oldHeader: "before",
      newHeader: "after",
    });
    expect(d).toContain("--- harness.yaml\tbefore");
    expect(d).toContain("+++ harness.yaml\tafter");
  });

  it("emits an empty diff body when inputs are identical", () => {
    const d = unifiedDiff({ fileName: "f", oldText: "same\n", newText: "same\n" });
    expect(isNoop(d)).toBe(true);
  });

  it("emits + / - lines when inputs differ", () => {
    const d = unifiedDiff({ fileName: "f", oldText: "a\n", newText: "b\n" });
    expect(d).toMatch(/^-a$/m);
    expect(d).toMatch(/^\+b$/m);
    expect(isNoop(d)).toBe(false);
  });

  it("produces a patch that `patch -p0` can apply against the original to reconstruct the new", () => {
    const oldText = "version: 1\ntools:\n  cli:\n    - name: gh\n      binary: gh\n";
    const newText =
      "version: 1\ntools:\n  cli:\n    - name: gh\n      binary: gh\n    - name: git-batch\n      binary: git-batch\n";
    const fileName = "harness.yaml";
    const diff = unifiedDiff({ fileName, oldText, newText });

    const filePath = path.join(tmpDir, fileName);
    const patchPath = path.join(tmpDir, "change.patch");
    fs.writeFileSync(filePath, oldText);
    fs.writeFileSync(patchPath, diff);

    execSync(`patch -p0 -i ${patchPath}`, { cwd: tmpDir });
    expect(fs.readFileSync(filePath, "utf8")).toBe(newText);
  });
});
