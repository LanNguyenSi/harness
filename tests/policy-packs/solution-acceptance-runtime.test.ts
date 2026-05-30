import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bashReferencesVerdictDir,
  DEFAULT_PROTECTED_COMPLETION_TOOLS,
  DEFAULT_PUSH_BASH_RE,
  evaluateGate,
  isInsideDir,
  readVerdict,
  resolveProtectedCompletionTools,
  sanitizeVerdictId,
  VERDICT_DIR_ENV,
  VERDICT_DIR_TAIL,
  verdictDir,
  verdictPathFor,
  type Verdict,
} from "../../src/policy-packs/builtin/solution-acceptance-runtime.js";
import type { PolicyPack } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sa-runtime-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const HEAD = "f30767afdc14013a48cd0c024a82213f2f63855a";
const OTHER_HEAD = "0123456789abcdef0123456789abcdef01234567";

function writeMarker(dir: string, id: string, v: Partial<Verdict>): void {
  fs.mkdirSync(dir, { recursive: true });
  const full: Verdict = {
    id,
    head: HEAD,
    ready: true,
    confidence: 0.9,
    blockers: [],
    timestamp: "2026-05-30T00:00:00.000Z",
    source: "preflight",
    ...v,
  };
  fs.writeFileSync(verdictPathFor(dir, id), `${JSON.stringify(full, null, 2)}\n`);
}

describe("verdictDir — resolution order mirrors the producer", () => {
  it("honors SOLUTION_VERDICT_DIR first", () => {
    expect(verdictDir({ [VERDICT_DIR_ENV]: "/x/y" } as NodeJS.ProcessEnv, () => "/home/u")).toBe(
      "/x/y",
    );
  });
  it("falls back to XDG_STATE_HOME, then ~/.local/state", () => {
    expect(verdictDir({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv, () => "/home/u")).toBe(
      path.join("/state", "agent-grounding", "solution-verdicts"),
    );
    expect(verdictDir({} as NodeJS.ProcessEnv, () => "/home/u")).toBe(
      path.join("/home/u", ".local", "state", "agent-grounding", "solution-verdicts"),
    );
  });
  it("the stable tail is the default-location anchor", () => {
    expect(verdictDir({} as NodeJS.ProcessEnv, () => "/home/u").endsWith(VERDICT_DIR_TAIL)).toBe(true);
  });
});

describe("sanitizeVerdictId — path-traversal guard (mirror of producer)", () => {
  it("collapses unsafe chars so traversal cannot escape the dir", () => {
    // Slashes collapse to `_` BEFORE basename, so the whole id becomes one
    // safe segment — traversal is neutralized, not just trimmed.
    const out = sanitizeVerdictId("task/../../etc/passwd");
    expect(out).toBe("task_.._.._etc_passwd");
    expect(out).not.toContain("/");
    expect(sanitizeVerdictId("a b@c")).toBe("a_b_c");
  });
  it("rejects empty / dot-only ids", () => {
    expect(() => sanitizeVerdictId("")).toThrow();
    expect(() => sanitizeVerdictId("..")).toThrow();
  });
});

describe("readVerdict", () => {
  it("parses a well-formed marker", () => {
    const dir = tmpDir();
    writeMarker(dir, "t1", {});
    const v = readVerdict(dir, "t1");
    expect(v).not.toBeNull();
    expect(v?.head).toBe(HEAD);
    expect(v?.ready).toBe(true);
  });
  it("returns null on absent / malformed / missing-required-field", () => {
    const dir = tmpDir();
    expect(readVerdict(dir, "missing")).toBeNull();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(verdictPathFor(dir, "bad"), "{ not json");
    expect(readVerdict(dir, "bad")).toBeNull();
    fs.writeFileSync(verdictPathFor(dir, "partial"), JSON.stringify({ id: "x", ready: true }));
    expect(readVerdict(dir, "partial")).toBeNull(); // no head
  });
  it("refuses a symlink at the marker path (anti-forgery defense-in-depth)", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "evil.json");
    fs.writeFileSync(target, JSON.stringify({ id: "t", head: HEAD, ready: true }));
    fs.symlinkSync(target, verdictPathFor(dir, "linked"));
    expect(readVerdict(dir, "linked")).toBeNull();
  });
});

describe("evaluateGate — mirror of grounding-mcp solution_gate", () => {
  it("allows only a ready verdict at the current HEAD", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: HEAD, ready: true });
    expect(evaluateGate(readVerdict(dir, "t"), HEAD, "t").allowed).toBe(true);
  });
  it("blocks: no verdict", () => {
    const r = evaluateGate(null, HEAD, "t");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no solution-acceptance verdict/);
  });
  it("blocks: not ready, surfacing blockers", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { ready: false, blockers: ["lint failed", "1 test failing"] });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not ready: lint failed; 1 test failing/);
  });
  it("blocks: HEAD drift (stale verdict)", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { head: OTHER_HEAD, ready: true });
    const r = evaluateGate(readVerdict(dir, "t"), HEAD, "t");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/stale solution-acceptance verdict/);
  });
  it("blocks: unresolvable current HEAD", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { ready: true });
    expect(evaluateGate(readVerdict(dir, "t"), null, "t").allowed).toBe(false);
  });
  it("ignores confidence: ready:true confidence:0 at HEAD still ALLOWS (parity with producer)", () => {
    const dir = tmpDir();
    writeMarker(dir, "t", { ready: true, confidence: 0, head: HEAD });
    expect(evaluateGate(readVerdict(dir, "t"), HEAD, "t").allowed).toBe(true);
  });
});

describe("isInsideDir — write-guard path arm", () => {
  const dir = "/home/u/.local/state/agent-grounding/solution-verdicts";
  it("true for a file inside the dir", () => {
    expect(isInsideDir(`${dir}/task-1.json`, dir)).toBe(true);
  });
  it("true for a relative target under a cwd that is the dir", () => {
    expect(isInsideDir("task-1.json", dir, dir)).toBe(true);
  });
  it("false for a sibling / outside path", () => {
    expect(isInsideDir("/home/u/.local/state/agent-grounding/solution-verdicts-notes", dir)).toBe(
      false,
    );
    expect(isInsideDir("/etc/passwd", dir)).toBe(false);
  });
});

describe("bashReferencesVerdictDir — write-guard reference detection", () => {
  const dir = "/home/u/.local/state/agent-grounding/solution-verdicts";
  it("catches the literal abs path, the env token, and the stable tail", () => {
    expect(bashReferencesVerdictDir(`echo x > ${dir}/t.json`, dir)).toBe(true);
    expect(bashReferencesVerdictDir(`echo x > "$${VERDICT_DIR_ENV}/t.json"`, dir)).toBe(true);
    expect(bashReferencesVerdictDir("tee ~/.local/state/agent-grounding/solution-verdicts/t.json", dir)).toBe(
      true,
    );
  });
  it("catches glob-obscured leaf spellings (overwrite forge)", () => {
    expect(bashReferencesVerdictDir(`echo x > ${dir.replace("solution-verdicts", "solution-ver*")}/t.json`, dir)).toBe(
      true,
    );
    expect(bashReferencesVerdictDir(`cp /tmp/f ${dir.replace("solution-verdicts", "solu*verdicts")}/t.json`, dir)).toBe(
      true,
    );
    expect(bashReferencesVerdictDir("cd /home/u/.local/state/agent-grounding && echo x > solution-v?rdicts/t.json", dir)).toBe(
      true,
    );
  });
  it("does not match unrelated commands (incl. globbed ones)", () => {
    expect(bashReferencesVerdictDir("echo hi > /tmp/x", dir)).toBe(false);
    expect(bashReferencesVerdictDir("cp src/*.ts dist/", dir)).toBe(false);
    expect(bashReferencesVerdictDir("rm /tmp/agent-relay/*.log", dir)).toBe(false);
  });
});

describe("DEFAULT_PUSH_BASH_RE — completion bash matcher", () => {
  it("matches the literal push / merge spellings", () => {
    expect(DEFAULT_PUSH_BASH_RE.test("git push origin feat/x")).toBe(true);
    expect(DEFAULT_PUSH_BASH_RE.test("git -C /repo push")).toBe(true);
    expect(DEFAULT_PUSH_BASH_RE.test("gh pr merge 12 --squash")).toBe(true);
    expect(DEFAULT_PUSH_BASH_RE.test("cd /repo && git push")).toBe(true);
  });
  it("does not match unrelated git commands", () => {
    expect(DEFAULT_PUSH_BASH_RE.test("git status")).toBe(false);
    expect(DEFAULT_PUSH_BASH_RE.test("git pushup")).toBe(false);
  });
});

describe("resolveProtectedCompletionTools", () => {
  function packWith(config: Record<string, unknown>): PolicyPack {
    return { name: "solution-acceptance", source: "builtin", enabled: true, config } as PolicyPack;
  }
  it("defaults to the canonical completion verb set", () => {
    expect(resolveProtectedCompletionTools(packWith({}))).toEqual([
      ...DEFAULT_PROTECTED_COMPLETION_TOOLS,
    ]);
  });
  it("honors a config override", () => {
    expect(resolveProtectedCompletionTools(packWith({ protected_completion_tools: ["task_finish"] }))).toEqual(
      ["task_finish"],
    );
  });
});

describe("golden fixture — drift guard against the real producer", () => {
  // Captured from @lannguyensi/grounding-mcp@0.3.2 solution_evaluate (a real
  // `preflight run --json`). If grounding-mcp changes the Verdict shape,
  // regenerate via `solution_evaluate({ id })` and copy the marker from
  // ~/.local/state/agent-grounding/solution-verdicts/<id>.json, then update
  // PRODUCER_KEYS below. This is the tripwire that the consumer stays
  // field-for-field with the producer.
  const PRODUCER_KEYS = ["id", "head", "ready", "confidence", "blockers", "timestamp", "source"];
  const fixturePath = path.join(
    __dirname,
    "..",
    "fixtures",
    "solution-acceptance",
    "golden-verdict-0.3.2.json",
  );

  it("the real 0.3.2 marker carries exactly the fields the consumer reads", () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    expect(Object.keys(raw).sort()).toEqual([...PRODUCER_KEYS].sort());
  });

  it("the consumer parses the real marker and gates on it correctly", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Verdict;
    fs.writeFileSync(verdictPathFor(dir, raw.id), JSON.stringify(raw));
    const v = readVerdict(dir, raw.id);
    expect(v).not.toBeNull();
    // allow at the marker's own head, deny at a drifted head.
    expect(evaluateGate(v, raw.head, raw.id).allowed).toBe(true);
    expect(evaluateGate(v, OTHER_HEAD, raw.id).allowed).toBe(false);
  });
});
