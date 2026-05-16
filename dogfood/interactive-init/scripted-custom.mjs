#!/usr/bin/env node
// Dogfood smoke for `harness init --interactive` Custom profile
// composer (task 31d2fbb5). Mirrors scripted-solo.mjs: drives the
// wizard with synthetic prompt answers against a fresh tmp HOME, then
// re-validates the composed manifest end-to-end. Builds confidence
// that a Custom picker tick is not just unit-test green but
// produces a manifest harness validate accepts on disk.
//
// Run from the repo root:
//   node dogfood/interactive-init/scripted-custom.mjs

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
  const checkboxQ = [...(queue.checkbox ?? [])];
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
    checkbox: async () => {
      const v = checkboxQ.shift();
      if (v === undefined) throw new Error("checkbox queue empty");
      return v;
    },
  };
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dogfood-custom-"));

// Fake deps dir so the wizard's dep check finds every binary present
// (no real `npm i -g` should run during dogfood).
const fakeDeps = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dogfood-deps-"));
for (const bin of [
  "memory-router-user-prompt-submit",
  "understanding-gate-claude-hook",
  "understanding-gate-claude-stop",
  "agent-tasks-mcp-bridge",
  "grounding-mcp",
  "preflight",
]) {
  const p = path.join(fakeDeps, bin);
  fs.writeFileSync(p, "#!/bin/sh\n");
  fs.chmodSync(p, 0o755);
}

try {
  const result = await runInteractive({
    homeDir: tmpHome,
    dependencyPathEnv: fakeDeps,
    prompts: mockPrompts({
      select: ["custom"],
      // packs, mcps, policies — full pick to exercise every composer branch.
      checkbox: [
        ["understanding-before-execution"],
        ["agent-tasks", "grounding-mcp", "memory-router"],
        [
          "review-before-merge",
          "preflight-before-investigation",
          "review-subagent-before-pr-create",
        ],
        [], // wire-now multiselect — skip
      ],
      input: ["~/.claude/projects/{project}/memory"],
      confirm: [true], // confirm write
    }),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });

  if (result.aborted) {
    console.error("FAIL: wizard reported aborted=true");
    process.exit(2);
  }
  if (result.profile !== "custom") {
    console.error(`FAIL: profile = ${result.profile}, expected "custom"`);
    process.exit(2);
  }
  if (result.validateClean !== true) {
    console.error("FAIL: validateClean=false; composer wrote a manifest that fails validate");
    process.exit(2);
  }

  const manifestPath = path.join(tmpHome, ".claude", "harness.yaml");
  if (!fs.existsSync(manifestPath)) {
    console.error(`FAIL: manifest not found at ${manifestPath}`);
    process.exit(2);
  }

  const content = fs.readFileSync(manifestPath, "utf8");
  if (!content.includes("Custom profile")) {
    console.error("FAIL: manifest missing Custom-profile header banner");
    process.exit(2);
  }
  for (const needle of [
    "understanding-before-execution",
    "agent-tasks",
    "grounding-mcp",
    "memory-router-user-prompt-submit",
    "review-before-merge",
    "preflight-before-investigation",
    "review-subagent-before-pr-create",
  ]) {
    if (!content.includes(needle)) {
      console.error(`FAIL: composed manifest missing expected entry "${needle}"`);
      process.exit(2);
    }
  }

  const v = validate({ configPath: manifestPath });
  if (v.errorCount !== 0) {
    console.error(`FAIL: re-validate reports ${v.errorCount} error(s)`);
    process.exit(2);
  }

  console.log("\nOK: custom wizard path produces a validate-clean composed manifest");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeDeps, { recursive: true, force: true });
}
