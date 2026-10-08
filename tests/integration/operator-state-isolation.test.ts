// A full nested suite must stay isolated from active operator pause state.
// Each test owns a scratch user home; a child preload redirects os.homedir
// before harness modules load, so interruption cannot leave live state paused.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSentinel, sentinelPath } from "../../src/runtime/pause-sentinel.js";
import { resolveVitestEntry } from "../_helpers/nested-vitest.js";
import { createOperatorStateFixture, operatorStateChildEnv, type OperatorStateFixture } from "../_helpers/operator-state-isolation-runner.js";

describe.skipIf(!process.env["HARNESS_INTEGRATION_TESTS"])(
  "operator-state-isolation: full suite passes with a planted pause sentinel",
  () => {
    let fixture: OperatorStateFixture;
    beforeEach(() => { fixture = createOperatorStateFixture(); });
    afterEach(() => { if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true }); });

    it("spawned full suite stays isolated while the fixture sentinel remains active", () => {
      const sentinel = sentinelPath(fixture.generatedDir);
      const before = fs.readFileSync(sentinel, "utf8");
      expect(readSentinel(fixture.generatedDir).kind).toBe("active");
      const result = spawnSync(process.execPath, [
        resolveVitestEntry(), "run", "--silent", "--exclude", "tests/integration/**",
      ], {
        cwd: path.resolve(__dirname, "..", ".."),
        env: operatorStateChildEnv(fixture),
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
      });
      // Child startup must have observed both the fake user home and pause;
      // a missing preload or failed fixture setup cannot produce a vacuous pass.
      const proof = JSON.parse(fs.readFileSync(path.join(fixture.proofDir, `${result.pid}.json`), "utf8"));
      expect(proof).toMatchObject({ pid: result.pid, userHome: fixture.userHome, sentinel, active: true });
      if (result.error || result.status !== 0) {
        throw new Error([
          `spawned vitest did not pass with active fixture sentinel (exit ${result.status}, signal ${result.signal}): ${result.error?.message ?? ""}`,
          "--- stdout ---", result.stdout, "--- stderr ---", result.stderr,
        ].join("\n"));
      }
      expect(fs.readFileSync(sentinel, "utf8")).toBe(before);
      expect(readSentinel(fixture.generatedDir).kind).toBe("active");
    }, 6 * 60 * 1000);
  },
);
