import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAST_APPLY_BASENAME,
  buildLastApply,
  lastApplyPath,
  readLastApply,
  sha256Hex,
  verifyLastApplyIntegrity,
  writeLastApply,
} from "../../src/io/last-apply.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-la-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function expectedSha(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

describe("last-apply", () => {
  it("sha256Hex matches Node's reference implementation", () => {
    expect(sha256Hex("hello\n")).toBe(expectedSha("hello\n"));
  });

  it("buildLastApply records sha + content for each file", () => {
    const record = buildLastApply({
      "settings.json": "{}\n",
      "MEMORY.md": "# index\n",
    });
    expect(Object.keys(record.files).sort()).toEqual(["MEMORY.md", "settings.json"]);
    expect(record.files["settings.json"]?.sha256).toBe(expectedSha("{}\n"));
    expect(record.files["settings.json"]?.content).toBe("{}\n");
    expect(record.files["MEMORY.md"]?.sha256).toBe(expectedSha("# index\n"));
  });

  it("write+read round-trips identically", () => {
    const record = buildLastApply({
      "settings.json": "{\"a\":1}\n",
      "MEMORY.md": "# memory index\n",
    });
    writeLastApply(tmpDir, record);
    const loaded = readLastApply(tmpDir);
    expect(loaded).toEqual(record);
  });

  it("write produces stable JSON with sorted file keys", () => {
    const record = buildLastApply({
      "z.json": "z\n",
      "a.json": "a\n",
      "m.json": "m\n",
    });
    writeLastApply(tmpDir, record);
    const onDisk = fs.readFileSync(lastApplyPath(tmpDir), "utf8");
    const parsed = JSON.parse(onDisk) as { files: Record<string, unknown> };
    expect(Object.keys(parsed.files)).toEqual(["a.json", "m.json", "z.json"]);
  });

  it("lastApplyPath joins with the canonical basename", () => {
    expect(lastApplyPath(tmpDir)).toBe(path.join(tmpDir, LAST_APPLY_BASENAME));
  });

  it("readLastApply returns null when the file is absent", () => {
    expect(readLastApply(tmpDir)).toBeNull();
  });

  it("readLastApply throws on a malformed record", () => {
    fs.writeFileSync(lastApplyPath(tmpDir), JSON.stringify({ files: { foo: { sha256: 1, content: 2 } } }));
    expect(() => readLastApply(tmpDir)).toThrow(/malformed/);
  });

  it("readLastApply throws on completely-wrong shape (missing files map)", () => {
    fs.writeFileSync(lastApplyPath(tmpDir), JSON.stringify({ wrong: true }));
    expect(() => readLastApply(tmpDir)).toThrow(/malformed/);
  });

  it("readLastApply throws on top-level non-object payload", () => {
    fs.writeFileSync(lastApplyPath(tmpDir), JSON.stringify(["array"]));
    expect(() => readLastApply(tmpDir)).toThrow(/malformed/);
  });

  it("verifyLastApplyIntegrity returns [] when every stored sha matches its content", () => {
    const record = buildLastApply({
      "a.json": "a\n",
      "b.json": "b\n",
    });
    expect(verifyLastApplyIntegrity(record)).toEqual([]);
  });

  it("verifyLastApplyIntegrity returns the relPath when a stored sha was tampered with", () => {
    const record = buildLastApply({ "settings.json": "{}\n" });
    record.files["settings.json"]!.sha256 = "0".repeat(64);
    expect(verifyLastApplyIntegrity(record)).toEqual(["settings.json"]);
  });

  it("re-stored sha matches recomputed sha (sha integrity guarantee)", () => {
    const content = "version: 1\nfoo: bar\n";
    const record = buildLastApply({ "harness.yaml": content });
    writeLastApply(tmpDir, record);
    const loaded = readLastApply(tmpDir);
    expect(loaded).not.toBeNull();
    const entry = loaded!.files["harness.yaml"];
    expect(entry).toBeDefined();
    expect(sha256Hex(entry!.content)).toBe(entry!.sha256);
  });
});
