import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const warning =
  "version floor not checked without a version probe; run `harness doctor` to check installed versions";
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("shipped validate keeps manifest version programs static", () => {
  for (const explicitCommand of [false, true]) {
    for (const strict of [false, true]) {
      it(`${explicitCommand ? "explicit version_command" : "default --version"}, ${strict ? "strict" : "normal"}: warns without executing an executable prerelease fixture`, () => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-static-version-"));
        fixtures.push(fixture);
        const binary = path.join(fixture, "fake-version.cjs");
        const marker = path.join(fixture, "executed.json");
        const config = path.join(fixture, "harness.yaml");
        // A fresh child environment isolates machine layers and operator state.
        // The real built CLI runs outside vitest's in-process spawn interception.
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: fixture,
          HARNESS_HOME: path.join(fixture, "state"),
          FIXTURE_MARKER: marker,
        };
        fs.writeFileSync(
          binary,
          `#!${process.execPath}\n` +
            'require("node:fs").writeFileSync(process.env.FIXTURE_MARKER, JSON.stringify(process.argv.slice(2)));\n' +
            'console.log("fake 1.2.3-rc.1");\n',
          { mode: 0o755 },
        );
        const args = explicitCommand ? ["version", "--machine"] : ["--version"];
        const proof = spawnSync(binary, args, { cwd: fixture, env, encoding: "utf8" });
        expect(proof.error).toBeUndefined();
        expect(proof.status).toBe(0);
        expect(proof.stdout.trim()).toBe("fake 1.2.3-rc.1");
        expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(args);
        fs.unlinkSync(marker);
        fs.writeFileSync(
          config,
          JSON.stringify({
            version: 1,
            tools: {
              builtin: { known: ["Read", "Edit", "Write", "Bash", "Agent", "Skill", "TaskCreate", "Glob", "Grep"] },
              cli: [{
                name: "fake",
                binary,
                min_version: "1.2.3",
                required: true,
                ...(explicitCommand ? { version_command: [binary, ...args] } : {}),
              }],
            },
          }),
        );

        const result = spawnSync(
          process.execPath,
          [cli, "validate", "--config", config, "--json", ...(strict ? ["--strict"] : [])],
          { cwd: fixture, env, encoding: "utf8" },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(fs.existsSync(marker), "validate executed the manifest-named version program").toBe(false);
        expect(result.status).toBe(strict ? 1 : 0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          diagnostics: [{
            severity: strict ? "error" : "warning",
            path: "tools.cli[fake].min_version",
            message: warning,
          }],
          errorCount: strict ? 1 : 0,
          warningCount: strict ? 0 : 1,
        });
      });
    }
  }
});
