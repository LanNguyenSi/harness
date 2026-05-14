import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverNewestSessionId,
  resolveReadSessionId,
  resolveSessionId,
} from "../../src/runtime/session-id.js";

describe("resolveSessionId", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = savedEnv;
    }
  });

  it("returns the explicit argument when given", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveSessionId("explicit-id")).toBe("explicit-id");
  });

  it("falls back to CLAUDE_SESSION_ID when no explicit argument is given", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveSessionId()).toBe("env-id");
  });

  it("returns 'default' when neither explicit nor env is set", () => {
    expect(resolveSessionId()).toBe("default");
    expect(resolveSessionId(undefined)).toBe("default");
  });

  it("treats an empty string explicit argument as not provided", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveSessionId("")).toBe("env-id");
  });

  it("treats an empty CLAUDE_SESSION_ID env as not provided", () => {
    process.env.CLAUDE_SESSION_ID = "";
    expect(resolveSessionId()).toBe("default");
  });

  it("treats an empty explicit + empty env as 'default'", () => {
    process.env.CLAUDE_SESSION_ID = "";
    expect(resolveSessionId("")).toBe("default");
  });
});

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const SID_C = "33333333-3333-3333-3333-333333333333";

describe("discoverNewestSessionId", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function tmpProjects(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-session-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return path.join(root, ".claude", "projects");
  }

  // Write `<sid>.jsonl` into `projectsRoot/<project>/` with an explicit
  // mtime so the newest-wins ordering is deterministic.
  function writeTranscript(
    projectsRoot: string,
    project: string,
    sid: string,
    mtimeEpochSec: number,
  ): void {
    const dir = path.join(projectsRoot, project);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    fs.utimesSync(file, mtimeEpochSec, mtimeEpochSec);
  }

  it("returns the session id of the newest transcript by mtime", () => {
    const root = tmpProjects();
    writeTranscript(root, "-repo-one", SID_A, 1_000);
    writeTranscript(root, "-repo-one", SID_B, 3_000);
    writeTranscript(root, "-repo-one", SID_C, 2_000);
    expect(discoverNewestSessionId({ projectsRoot: root })).toBe(SID_B);
  });

  it("picks the global newest across multiple project dirs", () => {
    const root = tmpProjects();
    writeTranscript(root, "-repo-one", SID_A, 5_000);
    writeTranscript(root, "-repo-two", SID_B, 9_000);
    writeTranscript(root, "-repo-three", SID_C, 1_000);
    expect(discoverNewestSessionId({ projectsRoot: root })).toBe(SID_B);
  });

  it("ignores files that are not <uuid>.jsonl transcripts", () => {
    const root = tmpProjects();
    const dir = path.join(root, "-repo-one");
    fs.mkdirSync(dir, { recursive: true });
    // Non-transcript siblings, all newer than the real transcript.
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "not-a-uuid.jsonl"), "x");
    fs.writeFileSync(path.join(dir, ".pending-approval"), "x");
    writeTranscript(root, "-repo-one", SID_A, 1_000);
    expect(discoverNewestSessionId({ projectsRoot: root })).toBe(SID_A);
  });

  it("returns null when the projects root does not exist", () => {
    const root = tmpProjects(); // created lazily — the dir itself is absent
    expect(discoverNewestSessionId({ projectsRoot: root })).toBeNull();
  });

  it("returns null when no transcript files are present", () => {
    const root = tmpProjects();
    const dir = path.join(root, "-repo-one");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    expect(discoverNewestSessionId({ projectsRoot: root })).toBeNull();
  });

  it("derives the projects root from homeDir when projectsRoot is omitted", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-home-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    writeTranscript(
      path.join(home, ".claude", "projects"),
      "-repo-one",
      SID_A,
      1_000,
    );
    expect(discoverNewestSessionId({ homeDir: home })).toBe(SID_A);
  });
});

describe("resolveReadSessionId", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = savedEnv;
    }
  });

  it("returns the explicit argument ahead of env and discovery", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(
      resolveReadSessionId("explicit-id", { discover: () => "discovered-id" }),
    ).toBe("explicit-id");
  });

  it("uses $CLAUDE_SESSION_ID ahead of discovery", () => {
    process.env.CLAUDE_SESSION_ID = "env-id";
    expect(resolveReadSessionId(undefined, { discover: () => "discovered-id" })).toBe(
      "env-id",
    );
  });

  it("falls through to transcript discovery when no explicit id and no env", () => {
    expect(resolveReadSessionId(undefined, { discover: () => "discovered-id" })).toBe(
      "discovered-id",
    );
  });

  it("falls back to 'default' when discovery finds nothing", () => {
    expect(resolveReadSessionId(undefined, { discover: () => null })).toBe("default");
  });

  it("treats a discovered empty string as nothing found", () => {
    expect(resolveReadSessionId(undefined, { discover: () => "" })).toBe("default");
  });

  it("treats empty explicit + empty env as not provided, then discovers", () => {
    process.env.CLAUDE_SESSION_ID = "";
    expect(resolveReadSessionId("", { discover: () => "discovered-id" })).toBe(
      "discovered-id",
    );
  });

  it("threads projectsRoot through to the default discovery scan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-readsession-"));
    try {
      const dir = path.join(root, ".claude", "projects", "-repo-one");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), "{}\n");
      expect(
        resolveReadSessionId(undefined, {
          projectsRoot: path.join(root, ".claude", "projects"),
        }),
      ).toBe(SID_A);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
