// `harness apply` names every managed file the lock builder could not read
// (a hook script that exists but is not readable, ...) in the apply result's
// warnings, prints them on stderr and carries them in `--json`; the apply
// still succeeds and the lock simply lacks the entry.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../../src/cli/apply/index.js";
import { run } from "../../../src/cli/index.js";
import { LOCK_BASENAME, parseLock } from "../../../src/io/harness-lock.js";
import { GENERATED_DIRNAME } from "../../../src/cli/apply/index.js";
import { LAST_APPLY_BASENAME } from "../../../src/io/last-apply.js";

let tmpHome: string;
let deniedPath: string | null = null;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-apply-lock-unreadable-"));
});

afterEach(() => {
  if (deniedPath !== null) fs.chmodSync(deniedPath, 0o644);
  deniedPath = null;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const asRoot = process.getuid?.() === 0;

function setup(): { manifestPath: string; bad: string; good: string } {
  const bad = path.join(tmpHome, "bad-hook.sh");
  const good = path.join(tmpHome, "good-hook.sh");
  fs.writeFileSync(bad, "#!/bin/sh\necho bad\n");
  fs.writeFileSync(good, "#!/bin/sh\necho good\n");
  fs.chmodSync(bad, 0o000);
  deniedPath = bad;
  const manifestPath = path.join(tmpHome, "harness.yaml");
  fs.writeFileSync(
    manifestPath,
    yamlStringify({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [
        { name: "bad", event: "SessionStart", command: bad, blocking: false, budget_ms: 30000 },
        { name: "good", event: "Stop", command: good, blocking: false, budget_ms: 30000 },
      ],
      policies: [],
    }),
  );
  return { manifestPath, bad, good };
}

const warningFor = (p: string): string =>
  `harness.lock: cannot read ${p} (EACCES); it is not drift-checked until readable`;

describe.skipIf(asRoot)("apply with an unreadable managed file", () => {
  it("apply(): succeeds, carries the warning, the lock lacks the unreadable entry", async () => {
    const { bad, good } = setup();
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("applied");
    expect(r.warnings).toContain(warningFor(bad));
    const entries = parseLock(fs.readFileSync(path.join(tmpHome, LOCK_BASENAME), "utf8"));
    expect(entries.map((e) => e.path)).toEqual([good]);
  });

  it("apply() --dry-run: writes no lock", async () => {
    setup();
    const r = await apply({ homeDir: tmpHome, dryRun: true });
    expect(r.outcome).toBe("would-apply");
    expect(fs.existsSync(path.join(tmpHome, LOCK_BASENAME))).toBe(false);
  });

  it("run() apply: exit 0 and a `warning:` line on stderr", async () => {
    const { manifestPath, bad } = setup();
    let err = "";
    const code = await run({
      argv: ["apply", "--config", manifestPath],
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
    });
    expect(code).toBe(0);
    expect(err).toContain(`warning: ${warningFor(bad)}\n`);
  });

  it("run() apply --json: exit 0 and the warning in the JSON warnings", async () => {
    const { manifestPath, bad } = setup();
    let out = "";
    const code = await run({
      argv: ["apply", "--json", "--config", manifestPath],
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect((JSON.parse(out) as { warnings: string[] }).warnings).toContain(warningFor(bad));
  });

  it("an idempotent re-apply that refreshes a drifted lock warns too, once", async () => {
    const { bad, good } = setup();
    await apply({ homeDir: tmpHome });
    // Drift a locked, readable asset so the no-changes path rewrites the lock.
    fs.writeFileSync(good, "#!/bin/sh\necho edited\n");
    const r = await apply({ homeDir: tmpHome });
    expect(r.outcome).toBe("no-changes");
    expect(r.lockDrift).toHaveLength(1);
    expect(r.warnings.filter((w) => w === warningFor(bad))).toHaveLength(1);
  });

  it("a re-apply that only recovers a missing .last-apply entry (no lock drift) warns", async () => {
    const { bad } = setup();
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const lastApplyPath = path.join(tmpHome, GENERATED_DIRNAME, LAST_APPLY_BASENAME);
    const record = JSON.parse(fs.readFileSync(lastApplyPath, "utf8")) as {
      files: Record<string, unknown>;
    };
    delete record.files["codex/config.toml"];
    fs.writeFileSync(lastApplyPath, JSON.stringify(record));
    const r = await apply({ homeDir: tmpHome, runtime: "codex" });
    expect(r.outcome).toBe("no-changes");
    expect(r.lockDrift).toHaveLength(0);
    expect(r.warnings).toContain(warningFor(bad));
  });

  it("a re-apply that recovers a missing .last-apply entry warns, and a run that takes both refresh paths still lists the warning once", async () => {
    const { bad, good } = setup();
    await apply({ homeDir: tmpHome, runtime: "codex" });
    // A .last-apply that lacks the generated Codex config's entry: the
    // no-changes path recovers it from disk and rebuilds the lock.
    const lastApplyPath = path.join(tmpHome, GENERATED_DIRNAME, LAST_APPLY_BASENAME);
    const record = JSON.parse(fs.readFileSync(lastApplyPath, "utf8")) as {
      files: Record<string, unknown>;
    };
    delete record.files["codex/config.toml"];
    fs.writeFileSync(lastApplyPath, JSON.stringify(record));
    // ... and a drifted locked asset so the lock-refresh path runs as well.
    fs.writeFileSync(good, "#!/bin/sh\necho edited\n");
    const r = await apply({ homeDir: tmpHome, runtime: "codex" });
    expect(r.outcome).toBe("no-changes");
    expect(r.warnings.filter((w) => w === warningFor(bad))).toHaveLength(1);
  });

  it("an idempotent re-apply with no lock drift repeats the warning each run", async () => {
    const { bad } = setup();
    const first = await apply({ homeDir: tmpHome });
    expect(first.warnings).toContain(warningFor(bad));
    for (let i = 0; i < 2; i++) {
      const again = await apply({ homeDir: tmpHome });
      expect(again.outcome).toBe("no-changes");
      expect(again.lockDrift).toHaveLength(0);
      expect(again.warnings.filter((w) => w === warningFor(bad))).toHaveLength(1);
    }
  });
});

// Documented limit: skip-and-warn covers paths that are not in the lock yet.
// A file already in harness.lock that later becomes unreadable still stops
// apply in the drift check (computeDrift reads it and throws).
describe.skipIf(asRoot)("a locked file that becomes unreadable (documented limit)", () => {
  function lockedHook(): { manifestPath: string; hook: string } {
    const hook = path.join(tmpHome, "locked-hook.sh");
    fs.writeFileSync(hook, "#!/bin/sh\necho hi\n");
    const manifestPath = path.join(tmpHome, "harness.yaml");
    fs.writeFileSync(
      manifestPath,
      yamlStringify({
        version: 1,
        tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
        memory: { directories: [] },
        hooks: [
          { name: "h", event: "SessionStart", command: hook, blocking: false, budget_ms: 30000 },
        ],
        policies: [],
      }),
    );
    return { manifestPath, hook };
  }

  it("apply() rejects with the read error", async () => {
    const { hook } = lockedHook();
    await apply({ homeDir: tmpHome });
    fs.chmodSync(hook, 0o000);
    deniedPath = hook;
    await expect(apply({ homeDir: tmpHome })).rejects.toThrow(/EACCES/);
  });

  it("run() apply exits 70", async () => {
    const { manifestPath, hook } = lockedHook();
    await apply({ homeDir: tmpHome });
    fs.chmodSync(hook, 0o000);
    deniedPath = hook;
    const code = await run({
      argv: ["apply", "--config", manifestPath],
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(70);
  });
});
