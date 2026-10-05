#!/usr/bin/env node
// Help-snapshot tool for the CLI wiring refactor (task 32d84940).
//
// Walks the command tree of the BUILT program (dist/cli/index.js), runs
// `node dist/cli/main.js <path...> --help` for the root and every (sub-)command
// in registration order, and concatenates the outputs into one snapshot. Two
// snapshots (before / after a wiring-only move) are diffable, and the sha256
// of the snapshot is printed so it can be quoted in a PR.
//
// Usage (after `npm run build`):
//   node scripts/help-snapshot.mjs                    # snapshot to stdout
//   node scripts/help-snapshot.mjs --out <file>       # snapshot to <file>
//   node scripts/help-snapshot.mjs --check <baseline> # exit 0 when identical,
//                                                     # exit 1 on any difference
//
// The snapshot starts with the ordered command-path list (names and order are
// part of the contract: Commander lists commands in registration order), then
// one section per path with the exact bytes of its --help output.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = join(root, "dist", "cli", "main.js");
const indexJs = join(root, "dist", "cli", "index.js");

function parseArgs(argv) {
  const out = { out: undefined, check: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--check") out.check = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.check !== undefined && out.out !== undefined) {
    throw new Error("--out and --check are mutually exclusive");
  }
  if ((argv.includes("--out") && !out.out) || (argv.includes("--check") && !out.check)) {
    throw new Error("--out / --check need a file argument");
  }
  return out;
}

// Depth-first, registration order. Each entry is the command path (array of
// names) below the root.
function collectPaths(cmd, prefix, acc) {
  for (const sub of cmd.commands) {
    const path = [...prefix, sub.name()];
    acc.push(path);
    collectPaths(sub, path, acc);
  }
  return acc;
}

function helpOf(path) {
  const res = spawnSync(process.execPath, [mainJs, ...path, "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", COLUMNS: "80", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(
      `\`harness ${path.join(" ")} --help\` exited ${String(res.status)}: ${res.stderr}`,
    );
  }
  return res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
}

export async function buildSnapshot() {
  const { buildProgram } = await import(pathToFileURL(indexJs).href);
  const program = buildProgram({ stdout: () => {}, stderr: () => {} });
  const paths = [[], ...collectPaths(program, [], [])];
  const lines = ["# command paths (registration order)"];
  for (const p of paths) lines.push(["harness", ...p].join(" "));
  lines.push("");
  for (const p of paths) {
    lines.push(`# === harness ${p.join(" ")} --help ===`);
    lines.push(helpOf(p));
  }
  return lines.join("\n");
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await buildSnapshot();
  if (args.check !== undefined) {
    const baseline = readFileSync(args.check, "utf8");
    if (baseline === snapshot) {
      process.stdout.write(`help snapshot identical (sha256 ${sha256(snapshot)})\n`);
      return 0;
    }
    process.stderr.write(
      `help snapshot differs from ${args.check} (baseline sha256 ${sha256(baseline)}, ` +
        `current sha256 ${sha256(snapshot)})\n`,
    );
    return 1;
  }
  if (args.out !== undefined) {
    writeFileSync(args.out, snapshot);
    process.stdout.write(`wrote ${args.out} (sha256 ${sha256(snapshot)})\n`);
    return 0;
  }
  process.stdout.write(snapshot);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
