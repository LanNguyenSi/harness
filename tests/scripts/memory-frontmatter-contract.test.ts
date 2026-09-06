import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkContract,
  syncContract,
  validateCorpus,
} from "../../scripts/memory-frontmatter-contract.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/memory-frontmatter-contract.mjs");
const dirs: string[] = [];
function temp(prefix: string) { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
function git(repo: string, args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function corpus(repo: string) {
  const root = join(repo, "packages/memory-router/contracts/memory-frontmatter-v1");
  writeFileSync(join(root, "README.md"), "producer corpus\n");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: "memory-frontmatter/v1", cases: [
    { file: "cases/accepted.md", accepted: true, resolvedType: "user" },
    { file: "cases/rejected.md", accepted: false },
  ] }) + "\n");
  writeFileSync(join(root, "cases/accepted.md"), "---\ntype: user\n---\nCRLF\r\n");
  writeFileSync(join(root, "cases/rejected.md"), "---\ntype: nope\n---\n");
  return root;
}
function producer() {
  const repo = temp("memory-producer-");
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@example.com"]); git(repo, ["config", "user.name", "Test"]);
  const root = join(repo, "packages/memory-router/contracts/memory-frontmatter-v1");
  mkdirSync(join(root, "cases"), { recursive: true });
  corpus(repo); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "fixture"]);
  return { repo, root, revision: git(repo, ["rev-parse", "HEAD"]) };
}
function nextRevision(source: ReturnType<typeof producer>) {
  writeFileSync(join(source.root, "README.md"), "updated producer corpus\n");
  git(source.repo, ["add", "."]); git(source.repo, ["commit", "-qm", "updated fixture"]);
  return git(source.repo, ["rev-parse", "HEAD"]);
}
function consumer() { const root = temp("memory-consumer-"); mkdirSync(join(root, "tests/contracts"), { recursive: true }); return root; }
function pinnedUpdatedFixture() {
  const source = producer(); const target = consumer();
  syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
  return { source, target, updatedRevision: nextRevision(source) };
}
function cli(consumerRoot: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [join(consumerRoot, "scripts/memory-frontmatter-contract.mjs"), ...args], { cwd, encoding: "utf8" });
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("memory-frontmatter contract tooling", () => {
  it("syncs committed exact bytes and checks the local provenance offline", () => {
    const source = producer(); const target = consumer();
    const result = syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    expect(result.fileCount).toBe(4);
    expect(checkContract(target).provenance.revision).toBe(source.revision);
    expect(readFileSync(join(target, "tests/contracts/memory-frontmatter-v1/vendor/cases/accepted.md"))).toEqual(
      readFileSync(join(source.root, "cases/accepted.md")),
    );
  });

  it("replaces only the owned vendor and provenance on repeated successful syncs", () => {
    const source = producer(); const target = consumer();
    const contract = join(target, "tests/contracts/memory-frontmatter-v1");
    mkdirSync(join(contract, "notes"), { recursive: true });
    writeFileSync(join(contract, "README.md"), "consumer documentation\n");
    writeFileSync(join(contract, "notes/sentinel.md"), "keep me\n");
    writeFileSync(join(contract, ".previous"), "keep me too\n");
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    expect(readFileSync(join(contract, "README.md"), "utf8")).toBe("consumer documentation\n");
    expect(readFileSync(join(contract, "notes/sentinel.md"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(contract, ".previous"), "utf8")).toBe("keep me too\n");
    expect(checkContract(target).fileCount).toBe(4);
    expect(readdirSync(contract).filter((name) => name.startsWith(".memory-frontmatter-sync-"))).toEqual([]);
  });

  it("requires an exact HEAD and rejects dirty tracked, staged, untracked, and ignored source contract paths", () => {
    const source = producer(); const target = consumer();
    expect(() => syncContract({ source: source.repo, revision: SHA, consumerRoot: target })).toThrow(/HEAD/);
    const mutations = [
      (fixture: ReturnType<typeof producer>) => writeFileSync(join(fixture.root, "README.md"), "dirty"),
      (fixture: ReturnType<typeof producer>) => { writeFileSync(join(fixture.root, "README.md"), "staged"); git(fixture.repo, ["add", "."]); },
      (fixture: ReturnType<typeof producer>) => writeFileSync(join(fixture.root, "cases/untracked.md"), "x"),
      (fixture: ReturnType<typeof producer>) => {
        writeFileSync(join(fixture.repo, ".gitignore"), "packages/memory-router/contracts/memory-frontmatter-v1/cases/ignored.md\n");
        writeFileSync(join(fixture.root, "cases/ignored.md"), "x");
      },
    ];
    for (const mutate of mutations) {
      const fixture = producer(); mutate(fixture);
      expect(() => syncContract({ source: fixture.repo, revision: fixture.revision, consumerRoot: target })).toThrow(/dirty/);
    }
    expect(() => syncContract({ source: join(source.repo, "packages/memory-router"), revision: source.revision, consumerRoot: target })).toThrow(/repository root/);
  });

  it("does not replace a valid destination when source validation fails", () => {
    const source = producer(); const target = consumer();
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    const before = readFileSync(join(target, "tests/contracts/memory-frontmatter-v1/provenance.json"));
    writeFileSync(join(source.root, "manifest.json"), "not json");
    expect(() => syncContract({ source: source.repo, revision: source.revision, consumerRoot: target })).toThrow(/dirty/);
    expect(readFileSync(join(target, "tests/contracts/memory-frontmatter-v1/provenance.json"))).toEqual(before);
  });

  it("rejects malformed provenance, unsafe or duplicate manifest paths, reserved or empty cases, extra files, and symlinks", () => {
    const source = producer(); const target = consumer(); syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    const contract = join(target, "tests/contracts/memory-frontmatter-v1");
    writeFileSync(join(contract, "provenance.json"), "{}\n");
    expect(() => checkContract(target)).toThrow(/provenance/);
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    const validProvenance = readFileSync(join(contract, "provenance.json"), "utf8");
    const malformedValues: Array<[string, unknown]> = [["revision", [source.revision]], ["sha256", ["a".repeat(64)]]];
    for (const [field, value] of malformedValues) {
      const malformed = JSON.parse(validProvenance) as Record<string, unknown>; malformed[field] = value;
      writeFileSync(join(contract, "provenance.json"), `${JSON.stringify(malformed)}\n`);
      expect(() => checkContract(target)).toThrow(/invalid fields/);
      writeFileSync(join(contract, "provenance.json"), validProvenance);
    }
    const vendor = join(contract, "vendor");
    writeFileSync(join(vendor, "manifest.json"), JSON.stringify({ schema: "memory-frontmatter/v1", cases: [{ file: "cases/../escape.md", accepted: false }] }));
    expect(() => validateCorpus(vendor)).toThrow(/invalid case/);
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    writeFileSync(join(vendor, "manifest.json"), JSON.stringify({ schema: "memory-frontmatter/v1", cases: [
      { file: "cases/accepted.md", accepted: true, resolvedType: "user" },
      { file: "cases/accepted.md", accepted: true, resolvedType: "user" },
    ] }));
    expect(() => validateCorpus(vendor)).toThrow(/duplicate/);
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    writeFileSync(join(vendor, "manifest.json"), JSON.stringify({ schema: "memory-frontmatter/v1", cases: [{ file: "cases/MEMORY.md", accepted: false }] }));
    expect(() => validateCorpus(vendor)).toThrow(/invalid case/);
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    writeFileSync(join(vendor, "manifest.json"), JSON.stringify({ schema: "memory-frontmatter/v1", cases: [] }));
    expect(() => validateCorpus(vendor)).toThrow(/at least one case/);
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    writeFileSync(join(vendor, "extra.md"), "extra");
    expect(() => validateCorpus(vendor)).toThrow(/membership/);
    rmSync(join(vendor, "extra.md")); symlinkSync("README.md", join(vendor, "linked.md"));
    expect(() => validateCorpus(vendor)).toThrow(/symlink/);
  });

  it("rejects a symlinked vendor root or provenance before reading either target", () => {
    const source = producer(); const target = consumer(); syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    const contract = join(target, "tests/contracts/memory-frontmatter-v1");
    const vendor = join(contract, "vendor");
    renameSync(vendor, join(contract, "vendor-real"));
    symlinkSync("vendor-real", vendor);
    expect(() => checkContract(target)).toThrow(/symlink.*tree root/);
    rmSync(vendor); renameSync(join(contract, "vendor-real"), vendor);
    renameSync(join(contract, "provenance.json"), join(contract, "provenance-real.json"));
    symlinkSync("provenance-real.json", join(contract, "provenance.json"));
    expect(() => checkContract(target)).toThrow(/symlink.*provenance/);
  });

  it("rejects a tampered byte and missing member against its pinned digest", () => {
    const source = producer(); const target = consumer(); syncContract({ source: source.repo, revision: source.revision, consumerRoot: target });
    const vendor = join(target, "tests/contracts/memory-frontmatter-v1/vendor");
    writeFileSync(join(vendor, "cases/accepted.md"), "tampered");
    expect(() => checkContract(target)).toThrow(/integrity mismatch/);
    rmSync(join(vendor, "cases/rejected.md"));
    expect(() => checkContract(target)).toThrow(/membership|missing/);
  });

  it("uses the script location and keeps sync transactional through recovery faults", () => {
    const source = producer(); const root = consumer();
    syncContract({ source: source.repo, revision: source.revision, consumerRoot: root });
    const elsewhere = temp("memory-cwd-");
    const original = process.cwd();
    process.chdir(elsewhere);
    try { expect(checkContract(root).fileCount).toBe(4); } finally { process.chdir(original); }
    const cliRoot = consumer(); const cliCwd = temp("memory-cli-cwd-");
    mkdirSync(join(cliRoot, "scripts"), { recursive: true }); copyFileSync(scriptPath, join(cliRoot, "scripts/memory-frontmatter-contract.mjs"));
    const cliSync = cli(cliRoot, ["sync", "--source", source.repo, "--revision", source.revision], cliCwd);
    const cliCheck = cli(cliRoot, ["check"], cliCwd);
    expect(cliSync.status).toBe(0);
    expect(cliCheck.status).toBe(0);
    const cliProvenance = join(cliRoot, "tests/contracts/memory-frontmatter-v1/provenance.json");
    const beforeCliFailure = readFileSync(cliProvenance);
    expect(cli(cliRoot, ["sync"], cliCwd).status).toBe(1);
    expect(cli(cliRoot, ["sync", "--source", source.repo, "--revision", source.revision.slice(0, 7)], cliCwd).status).toBe(1);
    expect(readFileSync(cliProvenance)).toEqual(beforeCliFailure);
    const installFaults = [
      (from: string, to: string, vendor: string, _provenance: string) => from === vendor && to.endsWith("/vendor-backup"),
      (from: string, to: string, vendor: string, _provenance: string) => from !== vendor && from.endsWith("/vendor") && to === vendor,
      (from: string, to: string, _vendor: string, provenance: string) => from === provenance && to.endsWith("/provenance-backup"),
      (from: string, to: string, _vendor: string, provenance: string) => from !== provenance && from.endsWith("/provenance.json") && to === provenance,
    ];
    for (const shouldFail of installFaults) {
      const { source, target, updatedRevision } = pinnedUpdatedFixture();
      const contract = join(target, "tests/contracts/memory-frontmatter-v1");
      const vendor = join(contract, "vendor"); const provenance = join(contract, "provenance.json");
      const before = readFileSync(provenance);
      expect(() => syncContract({ source: source.repo, revision: updatedRevision, consumerRoot: target, testOps: {
        renameSync(from, to) { if (shouldFail(from.toString(), to.toString(), vendor, provenance)) throw new Error("injected rename failure"); return renameSync(from, to); },
      } })).toThrow(/injected rename failure/);
      expect(readFileSync(provenance)).toEqual(before);
      expect(checkContract(target).provenance.revision).toBe(source.revision);
      expect(readdirSync(contract).filter((name) => name.startsWith(".memory-frontmatter-sync-"))).toEqual([]);
    }

    const { source: rollbackSource, target: rollbackTarget, updatedRevision: rollbackRevision } = pinnedUpdatedFixture();
    const rollbackContract = join(rollbackTarget, "tests/contracts/memory-frontmatter-v1");
    const rollbackVendor = join(rollbackContract, "vendor");
    expect(() => syncContract({ source: rollbackSource.repo, revision: rollbackRevision, consumerRoot: rollbackTarget, testOps: {
      renameSync(from, to) {
        const sourcePath = from.toString(); const destination = to.toString();
        if ((sourcePath !== rollbackVendor && sourcePath.endsWith("/vendor") && destination === rollbackVendor) ||
          (sourcePath.endsWith("/vendor-backup") && destination === rollbackVendor)) throw new Error("injected rollback rename failure");
        return renameSync(from, to);
      },
    } })).toThrow(/injected rollback rename failure/);
    const rollbackScratch = readdirSync(rollbackContract).find((name) => name.startsWith(".memory-frontmatter-sync-"));
    expect(rollbackScratch).toBeTruthy();
    expect(readFileSync(join(rollbackContract, rollbackScratch!, "vendor-backup", "README.md"), "utf8")).toBe("producer corpus\n");

    const { source: cleanupSource, target: cleanupTarget, updatedRevision: cleanupRevision } = pinnedUpdatedFixture();
    const cleanupContract = join(cleanupTarget, "tests/contracts/memory-frontmatter-v1");
    expect(() => syncContract({ source: cleanupSource.repo, revision: cleanupRevision, consumerRoot: cleanupTarget, testOps: {
      rmSync(path, options) { if (path.toString().endsWith("/provenance-backup")) throw new Error("injected cleanup failure"); return rmSync(path, options); },
    } })).toThrow(/injected cleanup failure/);
    expect(checkContract(cleanupTarget).provenance.revision).toBe(cleanupRevision);
    const cleanupScratch = readdirSync(cleanupContract).find((name) => name.startsWith(".memory-frontmatter-sync-"));
    expect(cleanupScratch).toBeTruthy();
    expect(readdirSync(join(cleanupContract, cleanupScratch!))).toEqual(["provenance-backup"]);
  });
});
