#!/usr/bin/env node
// Dogfood smoke for `harness init --interactive` (task c5287b80, PR 3/3).
// Imports the wizard module directly with synthetic prompt answers, runs
// it against a fresh tmp HOME, then asserts the produced manifest passes
// `harness validate` with zero errors.
//
// This avoids the TTY-only interactive prompt path (real @inquirer/prompts
// won't read from a pipe in the way scripted stdin would imply). The
// wizard exposes a prompt-dependency-injection seam exactly for this
// reason, and tests already use it; this script is the end-to-end
// equivalent that any operator can re-run to confirm the wizard still
// produces a valid manifest after a release.
//
// Run from the repo root:
//   node dogfood/interactive-init/scripted-solo.mjs

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

const { runInteractive } = await import(path.join(REPO_ROOT, "dist/cli/init/interactive.js"));
const { validate } = await import(path.join(REPO_ROOT, "dist/cli/validate/index.js"));

function mockPrompts(queue) {
  const selectQ = [...(queue.select ?? [])];
  const confirmQ = [...(queue.confirm ?? [])];
  const inputQ = [...(queue.input ?? [])];
  return {
    select: async () => {
      const v = selectQ.shift();
      if (v === undefined) throw new Error("select queue empty");
      return v;
    },
    confirm: async () => {
      const v = confirmQ.shift();
      if (v === undefined) throw new Error("confirm queue empty");
      return v;
    },
    input: async () => {
      const v = inputQ.shift();
      if (v === undefined) throw new Error("input queue empty");
      return v;
    },
  };
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dogfood-wizard-"));

try {
  const result = await runInteractive({
    homeDir: tmpHome,
    prompts: mockPrompts({
      select: ["solo"],
      input: ["~/.claude/projects/{project}/memory"],
      confirm: [true], // write
    }),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });

  if (result.aborted) {
    console.error("FAIL: wizard reported aborted=true");
    process.exit(2);
  }
  if (result.profile !== "solo") {
    console.error(`FAIL: profile = ${result.profile}, expected "solo"`);
    process.exit(2);
  }
  if (result.validateClean !== true) {
    console.error("FAIL: validateClean=false; the wizard wrote a manifest that fails validate");
    process.exit(2);
  }

  const manifestPath = path.join(tmpHome, ".claude", "harness.yaml");
  if (!fs.existsSync(manifestPath)) {
    console.error(`FAIL: manifest not found at ${manifestPath}`);
    process.exit(2);
  }

  const v = validate({ configPath: manifestPath });
  if (v.errorCount !== 0) {
    console.error(`FAIL: re-validate reports ${v.errorCount} error(s)`);
    process.exit(2);
  }

  console.log("\nOK: solo wizard path produces a validate-clean manifest");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
