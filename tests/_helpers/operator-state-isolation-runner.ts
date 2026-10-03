import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSentinel, sentinelPath, writeSentinel } from "../../src/runtime/pause-sentinel.js";

export interface OperatorStateFixture {
  root: string;
  userHome: string;
  generatedDir: string;
  preloadPath: string;
  proofDir: string;
}

/** The sentinel belongs to a unique scratch user home, even if the test is killed. */
export function createOperatorStateFixture(): OperatorStateFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-operator-isolation-"));
  const userHome = path.join(root, "user-home");
  const generatedDir = path.join(userHome, ".claude", "harness.generated");
  const proofDir = path.join(root, "child-proofs");
  const preloadPath = path.join(root, "fake-user-home.cjs");
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(proofDir);
  writeSentinel(generatedDir, {
    pausedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: "operator-state isolation fixture",
    pausedBy: "integration-test",
  });
  if (readSentinel(generatedDir).kind !== "active") throw new Error("Fixture sentinel is not active");

  // This preload runs before Vitest and its workers import any harness code.
  // Updating the named builtin exports also covers ESM `import { homedir }`.
  // NODE_OPTIONS propagates it to Node descendants; no shell HOME is changed.
  // Existing tests can still explicitly choose their own temporary HOME. Only
  // real directories strictly inside the system tmpdir are honored, and the
  // original operator home is excluded even if it happens to live there.
  fs.writeFileSync(preloadPath, [
    'const os = require("node:os");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const fixtureHome = ${JSON.stringify(userHome)};`,
    `const sentinel = ${JSON.stringify(sentinelPath(generatedDir))};`,
    `const proofDir = ${JSON.stringify(proofDir)};`,
    "const nativeHomedir = os.homedir.bind(os);",
    `const operatorHome = ${JSON.stringify(fs.realpathSync(os.homedir()))};`,
    "os.homedir = () => {",
    "  const requested = nativeHomedir();",
    "  try {",
    "    const resolved = fs.realpathSync(requested);",
    "    const relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);",
    "    if (resolved !== operatorHome && relative !== '' && relative !== '..' &&",
    "        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return requested;",
    "  } catch { /* Nonexistent or unreadable homes stay in the fixture. */ }",
    "  return fixtureHome;",
    "};",
    'require("node:module").syncBuiltinESMExports();',
    'const pause = JSON.parse(fs.readFileSync(sentinel, "utf8"));',
    'if (Date.parse(pause.expiresAt) <= Date.now()) throw new Error("Fixture sentinel expired before child startup");',
    'fs.writeFileSync(path.join(proofDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, userHome: os.homedir(), sentinel, active: true, argv: process.argv }));',
    "",
  ].join("\n"));

  // An optional external observer can rendezvous with this exact fixture
  // before interrupting its own test process; ordinary runs need no observer.
  const observationDir = process.env["HARNESS_OPERATOR_ISOLATION_OBSERVATION_DIR"];
  if (observationDir) {
    fs.mkdirSync(observationDir, { recursive: true });
    fs.writeFileSync(path.join(observationDir, `${path.basename(root)}.json`), JSON.stringify({ root, userHome, generatedDir, proofDir }));
  }
  return { root, userHome, generatedDir, preloadPath, proofDir };
}

export function operatorStateChildEnv(fixture: OperatorStateFixture): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["HARNESS_INTEGRATION_TESTS"];
  delete env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  delete env["HARNESS_HOME"];
  env["NODE_OPTIONS"] = `--require=${JSON.stringify(fixture.preloadPath)}`;
  return env;
}
