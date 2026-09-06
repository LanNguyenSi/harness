#!/usr/bin/env node
/** Offline integrity checker and explicit local producer sync for memory-frontmatter/v1. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_PATH = "packages/memory-router/contracts/memory-frontmatter-v1";
export const HASH_ALGORITHM = "sha256-path-filehash-lines-v1";
export const SCHEMA = "memory-frontmatter/v1";
const REVISION_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TYPES = new Set(["user", "feedback", "project", "reference"]);
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`memory-frontmatter-contract: ${message}`);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function posixRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}
function safeCasePath(path) {
  return typeof path === "string" && /^cases\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path) && !path.includes("..") && path !== "cases/MEMORY.md" && path === path.normalize("NFC");
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return all regular files; reject links and non-regular entries at every level. */
export function regularTree(root) {
  if (!existsSync(root)) fail(`missing tree: ${root}`);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) fail("symlink is not allowed: tree root");
  if (!rootStat.isDirectory()) fail(`tree root is not a directory: ${root}`);
  const paths = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`symlink is not allowed: ${posixRelative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) paths.push(posixRelative(root, path));
      else fail(`non-regular entry is not allowed: ${posixRelative(root, path)}`);
    }
  };
  visit(root);
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function parseManifest(root) {
  const path = join(root, "manifest.json");
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); } catch { fail("manifest.json is malformed JSON"); }
  if (!isObject(manifest) || manifest.schema !== SCHEMA || !Array.isArray(manifest.cases)) {
    fail(`manifest.json must contain schema ${JSON.stringify(SCHEMA)} and cases array`);
  }
  if (manifest.cases.length === 0) fail("manifest must contain at least one case");
  const listed = new Set();
  for (const item of manifest.cases) {
    if (!isObject(item) || !safeCasePath(item.file) || typeof item.accepted !== "boolean") fail("manifest has an invalid case record");
    if (listed.has(item.file)) fail(`manifest contains duplicate case path: ${item.file}`);
    listed.add(item.file);
    if (item.accepted) {
      if (!TYPES.has(item.resolvedType) || Object.keys(item).some((key) => !["file", "accepted", "resolvedType"].includes(key))) {
        fail(`accepted case has invalid resolvedType: ${item.file}`);
      }
    } else if (Object.hasOwn(item, "resolvedType") || Object.keys(item).some((key) => !["file", "accepted"].includes(key))) {
      fail(`rejected case has invalid fields: ${item.file}`);
    }
  }
  return { manifest, listed };
}

export function treeDigest(root, paths = regularTree(root)) {
  const lines = paths.map((path) => `${path}:${sha256(readFileSync(join(root, path)))}`);
  return sha256(lines.join("\n"));
}

/** Validate the complete producer corpus tree and return its deterministic digest. */
export function validateCorpus(root) {
  const paths = regularTree(root);
  const { listed } = parseManifest(root);
  const expected = new Set(["README.md", "manifest.json", ...listed]);
  if (paths.length !== expected.size || paths.some((path) => !expected.has(path))) {
    fail("tree membership must be exactly README.md, manifest.json, and listed cases/*.md");
  }
  for (const path of listed) {
    if (!paths.includes(path)) fail(`manifest case is missing: ${path}`);
  }
  return { paths, sha256: treeDigest(root, paths), fileCount: paths.length };
}

export function readProvenance(path) {
  if (!existsSync(path)) fail("missing provenance.json");
  if (lstatSync(path).isSymbolicLink()) fail("symlink is not allowed: provenance.json");
  if (!lstatSync(path).isFile()) fail("provenance.json is not a regular file");
  let provenance;
  try { provenance = JSON.parse(readFileSync(path, "utf8")); } catch { fail("provenance.json is malformed JSON"); }
  const allowed = ["repository", "revision", "contractPath", "hashAlgorithm", "sha256", "fileCount"];
  if (!isObject(provenance) || Object.keys(provenance).length !== allowed.length || allowed.some((key) => !Object.hasOwn(provenance, key)) ||
    provenance.repository !== "https://github.com/LanNguyenSi/agent-memory" || !REVISION_RE.test(provenance.revision) ||
    provenance.contractPath !== CONTRACT_PATH || provenance.hashAlgorithm !== HASH_ALGORITHM || !HASH_RE.test(provenance.sha256) ||
    !Number.isInteger(provenance.fileCount) || provenance.fileCount < 2) {
    fail("provenance.json has invalid fields");
  }
  return provenance;
}

export function checkContract(consumerRoot = scriptRoot) {
  const contractRoot = join(consumerRoot, "tests/contracts/memory-frontmatter-v1");
  const vendorRoot = join(contractRoot, "vendor");
  const provenance = readProvenance(join(contractRoot, "provenance.json"));
  const tree = validateCorpus(vendorRoot);
  if (tree.sha256 !== provenance.sha256 || tree.fileCount !== provenance.fileCount) fail("vendor integrity mismatch against provenance");
  return { ...tree, provenance };
}

function git(source, args, options = {}) {
  try { return execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }); }
  catch (error) { fail(`git ${args[0]} failed: ${String(error.stderr || error.message).trim()}`); }
}
function assertSource(source, revision) {
  if (!REVISION_RE.test(revision)) fail("--revision must be a full 40-character lowercase SHA");
  const topLevel = realpathSync(git(source, ["rev-parse", "--show-toplevel"]).trim());
  if (topLevel !== realpathSync(source)) fail("--source must name the local Git repository root");
  const head = git(source, ["rev-parse", "HEAD"]).trim();
  if (head !== revision) fail(`source HEAD ${head} does not equal requested revision ${revision}`);
  const status = git(source, ["status", "--porcelain=v1", "--ignored", "--untracked-files=all", "--", CONTRACT_PATH]);
  if (status.trim()) fail(`source contract path is dirty: ${status.trim().split("\n")[0]}`);
  const entries = git(source, ["ls-tree", "-r", "--full-tree", "-z", revision, "--", CONTRACT_PATH], { encoding: "buffer" });
  if (!entries.length) fail("requested revision has no contract tree");
  const records = entries.toString("utf8").split("\0").filter(Boolean);
  const files = [];
  for (const record of records) {
    const match = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/.exec(record);
    if (!match || match[1] !== "100644" || match[2] !== "blob") fail("source contract tree contains a non-regular committed file");
    const rel = match[3].slice(`${CONTRACT_PATH}/`.length);
    if (!rel || rel.includes("\\") || rel.startsWith("/") || rel.split("/").some((part) => !part || part === "." || part === "..")) fail("source contract tree has unsafe path");
    files.push(rel);
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
function sourceBytes(source, revision, path) {
  try { return execFileSync("git", ["-C", source, "show", `${revision}:${CONTRACT_PATH}/${path}`], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { fail(`could not read source byte ${path}: ${String(error.stderr || error.message).trim()}`); }
}

/** Sync a fully pinned local checkout. Source is read only and destination changes only after validation. */
export function syncContract({ source, revision, consumerRoot = scriptRoot, testOps = {} }) {
  if (!source || !revision) fail("sync requires --source <local producer repo> and --revision <full SHA>");
  const operations = { renameSync, rmSync, ...testOps };
  const sourceRoot = resolve(source);
  const files = assertSource(sourceRoot, revision);
  const staging = mkdtempSync(join(tmpdir(), "memory-frontmatter-contract-"));
  try {
    for (const path of files) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, sourceBytes(sourceRoot, revision, path));
    }
    const tree = validateCorpus(staging);
    const contractRoot = join(consumerRoot, "tests/contracts/memory-frontmatter-v1");
    mkdirSync(contractRoot, { recursive: true });
    const vendor = join(contractRoot, "vendor");
    const provenance = join(contractRoot, "provenance.json");
    const transaction = mkdtempSync(join(contractRoot, ".memory-frontmatter-sync-"));
    const candidateVendor = join(transaction, "vendor");
    const candidateProvenance = join(transaction, "provenance.json");
    const vendorBackup = join(transaction, "vendor-backup");
    const provenanceBackup = join(transaction, "provenance-backup");
    try {
      mkdirSync(candidateVendor, { recursive: true });
      for (const path of tree.paths) {
        const target = join(candidateVendor, path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(staging, path), target);
      }
      writeFileSync(candidateProvenance, `${JSON.stringify({ repository: "https://github.com/LanNguyenSi/agent-memory", revision, contractPath: CONTRACT_PATH, hashAlgorithm: HASH_ALGORITHM, sha256: tree.sha256, fileCount: tree.fileCount }, null, 2)}\n`);
      let movedVendor = false;
      let movedProvenance = false;
      let installedVendor = false;
      let installedProvenance = false;
      try {
        if (existsSync(vendor)) { operations.renameSync(vendor, vendorBackup); movedVendor = true; }
        operations.renameSync(candidateVendor, vendor); installedVendor = true;
        if (existsSync(provenance)) { operations.renameSync(provenance, provenanceBackup); movedProvenance = true; }
        operations.renameSync(candidateProvenance, provenance); installedProvenance = true;
      } catch (error) {
        let rollbackComplete = true;
        if (installedProvenance && existsSync(provenance)) {
          try { operations.rmSync(provenance, { force: true }); } catch { rollbackComplete = false; }
        }
        if (installedVendor && existsSync(vendor)) {
          try { operations.rmSync(vendor, { recursive: true, force: true }); } catch { rollbackComplete = false; }
        }
        if (movedProvenance && existsSync(provenanceBackup)) {
          try { operations.renameSync(provenanceBackup, provenance); } catch { rollbackComplete = false; }
        }
        if (movedVendor && existsSync(vendorBackup)) {
          try { operations.renameSync(vendorBackup, vendor); } catch { rollbackComplete = false; }
        }
        if (rollbackComplete) operations.rmSync(transaction, { recursive: true, force: true });
        throw error;
      }
      // The new vendor/provenance pair is committed before best-effort cleanup.
      if (movedVendor) operations.rmSync(vendorBackup, { recursive: true, force: true });
      if (movedProvenance) operations.rmSync(provenanceBackup, { force: true });
      operations.rmSync(transaction, { recursive: true, force: true });
    } catch (error) {
      throw error;
    }
    return { ...tree, revision };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "check" && args.length === 0) return checkContract();
  if (command === "sync") {
    const source = args[args.indexOf("--source") + 1];
    const revision = args[args.indexOf("--revision") + 1];
    if (!args.includes("--source") || !args.includes("--revision") || args.length !== 4) fail("sync requires exactly --source <local producer repo> --revision <full SHA>");
    return syncContract({ source, revision });
  }
  fail("usage: memory-frontmatter-contract.mjs check | sync --source <local producer repo> --revision <full SHA>");
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try { const result = main(process.argv.slice(2)); console.log(`memory-frontmatter-contract: OK (${result.fileCount} files, ${result.sha256})`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
