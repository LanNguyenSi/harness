// harness b56d95d3: a kubeconfig that is present but cannot be read (over its
// 8 MiB cap, or not a regular file) resolves to an UNKNOWN kube context, which
// drops the production signal a kube context would have carried. The hook
// says so on stderr instead of letting the loss pass silently. An absent
// kubeconfig stays silent: nothing was lost.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { resolveKubeContext } from "../../src/runtime/kube-context.js";
import {
  emptyLedger,
  makeGitRepo,
  manifest,
  runParityCleanups,
  writeEvent,
} from "../_helpers/intercept-parity.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kube-diag-home-"));
  fs.mkdirSync(path.join(home, ".kube"));
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  runParityCleanups();
});

const kubeconfig = (): string => path.join(home, ".kube", "config");
const EIGHT_MIB = 8 * 1024 * 1024;

async function hookStderr(): Promise<string> {
  const cwd = makeGitRepo("feature/work");
  const eventPath = writeEvent('psql -c "DROP TABLE users"', cwd);
  let err = "";
  await runInterceptCli({
    stdin: Readable.from([fs.readFileSync(eventPath, "utf8")]),
    stdout: new Writable({ write: (_c, _e, cb) => cb() }),
    stderr: new Writable({
      write(chunk, _enc, cb) {
        err += chunk.toString("utf8");
        cb();
      },
    }),
    manifest,
    ledger: emptyLedger,
    env: {},
    // No kube seams: the hook reads `~/.kube/config` itself.
  });
  return err;
}

describe("resolveKubeContext: a kubeconfig that is there but unreadable is reported", () => {
  it("over the cap: unknown context, with a diagnostic naming the cap", () => {
    fs.writeFileSync(kubeconfig(), "current-context: prod\n");
    fs.truncateSync(kubeconfig(), EIGHT_MIB + 1);
    const result = resolveKubeContext();
    expect(result).toMatchObject({ context: "", namespace: "" });
    expect(result.unreadable).toMatch(/larger than the 8 MiB read cap/);
    expect(result.unreadable).toContain(JSON.stringify(kubeconfig()));
  });

  it("exactly at the cap still resolves (the boundary is the cap, not below it)", () => {
    fs.writeFileSync(kubeconfig(), "current-context: prod\ncontexts:\n  - name: prod\n    context: { namespace: payments }\n");
    fs.truncateSync(kubeconfig(), EIGHT_MIB);
    // Padded with NULs the YAML parser rejects: the point is the READ, not the parse.
    expect(resolveKubeContext().unreadable).toBeUndefined();
  });

  it("a directory at the path: unknown context, with a diagnostic", () => {
    fs.mkdirSync(kubeconfig());
    expect(resolveKubeContext().unreadable).toMatch(/is not a regular file/);
  });

  it("an absent kubeconfig has no diagnostic", () => {
    expect(resolveKubeContext()).toEqual({ context: "", namespace: "" });
  });

  it("a readable kubeconfig has no diagnostic", () => {
    fs.writeFileSync(kubeconfig(), "current-context: dev\ncontexts:\n  - name: dev\n    context: { namespace: default }\n");
    expect(resolveKubeContext()).toEqual({ context: "dev", namespace: "default" });
  });
});

describe("policy intercept: the lost kube signal reaches stderr", () => {
  it("an over-cap kubeconfig is named on stderr", async () => {
    fs.writeFileSync(kubeconfig(), "current-context: prod\n");
    fs.truncateSync(kubeconfig(), EIGHT_MIB + 1);
    const err = await hookStderr();
    expect(err).toMatch(/harness policy intercept: kubeconfig ".*" is unreadable or larger than the 8 MiB read cap/);
    expect(err).toMatch(/a production kube context cannot raise the target environment/);
  });

  it("an absent kubeconfig adds no line", async () => {
    expect(await hookStderr()).not.toMatch(/kubeconfig/);
  });
});
