import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import { parseManifest, type Policy } from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Task cfb6b390: a `-C` / `cd` target whose name carries a backtick or an
// unusual control character used to be read as "no target", so a command
// that really runs in a nested repository was decided on the outer
// repository's evidence alone. The shapes below run the real
// `preflight-before-investigation` trigger through `runInterceptCli` with
// an outer repository that has nested repositories under `vendor/` and a
// ledger holding only the outer repository's tag.

function policyBashMatch(name: string): string {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === name);
  if (!policy?.trigger.bash_match) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
  return policy.trigger.bash_match;
}

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

function policyWith(enforcement: "block" | "warn"): Policy {
  return {
    name: "preflight-before-investigation",
    description: "gate investigative git reads on a per-repo preflight tag (real trigger regex)",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: policyBashMatch("preflight-before-investigation"),
    },
    requires: { ledger_tag: "preflight:${REPO}" },
    hook: "require-preflight-evidence",
    enforcement,
  } as Policy;
}

function ledgerWithEntries(contents: string[]): LedgerClient {
  const entries = contents.map((content, i) => ({
    id: `e${i}`,
    content,
    createdAt: new Date().toISOString(),
  }));
  return {
    async query() {
      return { kind: "ok", entries };
    },
    async record() {
      /* no-op */
    },
  };
}

describe("runInterceptCli: a target the gate cannot attribute does not fall back to the cwd repository's evidence (task cfb6b390)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function makeRepo(dir: string, branch = "main"): void {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  }

  /** An outer repository named `outer-repo` with one nested repository per name under `vendor/`. */
  function makeWorld(nestedNames: string[]): { outer: string; nested: Record<string, string> } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-cfb6b390-")));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const outer = path.join(root, "outer-repo");
    makeRepo(outer);
    const nested: Record<string, string> = {};
    for (const name of nestedNames) {
      const dir = path.join(outer, "vendor", name);
      makeRepo(dir);
      nested[name] = dir;
    }
    return { outer, nested };
  }

  async function run(
    command: string,
    cwd: string,
    entries: string[],
    enforcement: "block" | "warn" = "block",
  ) {
    return runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "sess-cfb6b390",
          cwd,
        }),
      ),
      stdout: sink(),
      stderr: sink(),
      manifest: makeManifest({ policies: [policyWith(enforcement)] }),
      ledger: ledgerWithEntries(entries),
    });
  }

  const OUTER_ONLY = ["preflight:outer-repo - evidence for the outer repository only"];
  const BACKTICK_NAME = "lib`x`y";

  describe("a backtick in the target fails closed instead of reading as cwd-only", () => {
    const shapes: Array<{ label: string; command: (abs: string) => string }> = [
      { label: "git -C, single-quoted relative name", command: () => `git -C 'vendor/${BACKTICK_NAME}' log` },
      { label: "git -C, escaped backticks", command: () => "git -C vendor/lib\\`x\\`y log" },
      { label: "git -C, absolute path", command: (abs) => `git -C '${abs}' log` },
      { label: "git --git-dir=", command: () => `git --git-dir='vendor/${BACKTICK_NAME}/.git' log` },
      { label: "env -C", command: () => `env -C 'vendor/${BACKTICK_NAME}' git log` },
      { label: "git -C behind a second -C", command: () => `git -C vendor/ok -C 'vendor/${BACKTICK_NAME}' log` },
      { label: "cd then read", command: () => `cd 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "cd, a harmless read, then the gated read", command: () => `cd 'vendor/${BACKTICK_NAME}' && echo hi && git log` },
      { label: "cd then a relative cd then the read", command: () => `cd 'vendor/${BACKTICK_NAME}' && cd sub && git log` },
      { label: "ANSI-C quoted spelling of the backtick", command: () => "git -C $'vendor/lib\\x60x\\x60y' log" },
      { label: "locale quoted value", command: () => 'git -C $"vendor/ok" log' },
      // `cd` and `env -C` shapes the bare `cd <path>` reading does not cover.
      { label: "cd -P", command: () => `cd -P 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "cd -L", command: () => `cd -L 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "cd --", command: () => `cd -- 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "pushd", command: () => `pushd 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "cd with a redirection to /dev/null", command: () => `cd 'vendor/${BACKTICK_NAME}' >/dev/null && git log` },
      { label: "cd with a stderr redirection", command: () => `cd 'vendor/${BACKTICK_NAME}' 2>&1 && git log` },
      { label: "a brace group", command: () => `{ cd 'vendor/${BACKTICK_NAME}'; git log; }` },
      { label: "builtin cd", command: () => `builtin cd 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "command cd", command: () => `command cd 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "eval cd", command: () => `eval cd 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "a CDPATH assignment before cd", command: () => `CDPATH=. cd 'vendor/${BACKTICK_NAME}' && git log` },
      { label: "a line continuation after the cd", command: () => `cd 'vendor/${BACKTICK_NAME}' \\\n&& git log` },
      { label: "env -C with a second, opaque value", command: () => `env -C vendor/ok -C 'vendor/${BACKTICK_NAME}' git log` },
      { label: "env -C with a ~ value carrying ESC", command: () => "env -C ~/lib\u001bz git log" },
      { label: "env -C plus a relative -C after an opaque cd", command: () => `cd 'vendor/${BACKTICK_NAME}' && env -C sub git -C sub2 log` },
      { label: "a read after an env -C plus relative -C segment that followed an opaque cd", command: () => `cd 'vendor/${BACKTICK_NAME}' && env -C sub git -C sub2 status && git log` },
    ];
    for (const shape of shapes) {
      it(`${shape.label}: denied with the cwd-only evidence on record`, async () => {
        const world = makeWorld([BACKTICK_NAME, "ok"]);
        const command = shape.command(world.nested[BACKTICK_NAME]!);

        const result = await run(command, world.outer, OUTER_ONLY);

        expect(result.blocked).toBe(true);
        expect(result.decisions).toHaveLength(1);
        const decision = result.decisions[0]!;
        expect(decision.outcome).toBe("deny");
        expect(decision.reason).toContain("cannot attribute");
        // Never decided on the outer repository's tag.
        expect(decision.ledgerTag).not.toBe("preflight:outer-repo");
      });
    }

    it("is not satisfiable by any evidence: the nested repository's own tag does not unblock it", async () => {
      const world = makeWorld([BACKTICK_NAME]);
      const result = await run(`git -C 'vendor/${BACKTICK_NAME}' log`, world.outer, [
        ...OUTER_ONLY,
        `preflight:${BACKTICK_NAME} - evidence for the nested repository`,
      ]);
      expect(result.blocked).toBe(true);
      expect(result.decisions.map((d) => d.outcome)).toEqual(["deny"]);
    });

    it("a warn-enforcement policy warns instead of hard-blocking", async () => {
      const world = makeWorld([BACKTICK_NAME]);
      const result = await run(`git -C 'vendor/${BACKTICK_NAME}' log`, world.outer, OUTER_ONLY, "warn");
      expect(result.blocked).toBe(false);
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.outcome).toBe("warn");
    });

    for (const shape of shapes) {
      it(`${shape.label}: warned, not blocked, under warn enforcement`, async () => {
        const world = makeWorld([BACKTICK_NAME, "ok"]);
        const command = shape.command(world.nested[BACKTICK_NAME]!);

        const result = await run(command, world.outer, OUTER_ONLY, "warn");

        expect(result.blocked).toBe(false);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]!.outcome).toBe("warn");
        expect(result.decisions[0]!.reason).toContain("cannot attribute");
      });
    }
  });

  describe("an unusual character in an otherwise unattributable target fails closed", () => {
    const names = ["lib\u001bz", "lib\u202ez", "lib\u2028z", "lib\u2029z", "lib\u200bz"];
    for (const name of names) {
      it(`quoted name ${JSON.stringify(name)}`, async () => {
        const world = makeWorld([name]);
        const result = await run(`git -C 'vendor/${name}' log`, world.outer, OUTER_ONLY);
        expect(result.blocked).toBe(true);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]!.reason).toContain("cannot attribute");
      });
    }
  });

  describe("an unquoted target carrying control characters is attributed to that literal directory", () => {
    const names = [
      { label: "ESC", name: "lib\u001bz" },
      { label: "BEL", name: "lib\u0007z" },
      { label: "U+202E", name: "lib\u202ez" },
      { label: "U+2028", name: "lib\u2028z" },
      { label: "ESC, BEL, U+2028 and U+202E together", name: "lib\u001b\u0007\u2028\u202ez" },
    ];
    for (const { label, name } of names) {
      it(`${label}: demands the nested repository's tag next to the outer one`, async () => {
        const world = makeWorld([name]);
        const command = `git -C vendor/${name} log`;

        const outerOnly = await run(command, world.outer, OUTER_ONLY);
        expect(outerOnly.blocked).toBe(true);
        expect(outerOnly.decisions.map((d) => d.ledgerTag).sort()).toEqual(
          ["preflight:outer-repo", `preflight:${name}`].sort(),
        );
        expect(outerOnly.decisions.find((d) => d.ledgerTag === "preflight:outer-repo")?.outcome).toBe("allow");
        expect(outerOnly.decisions.find((d) => d.ledgerTag === `preflight:${name}`)?.outcome).toBe("deny");

        const both = await run(command, world.outer, [
          ...OUTER_ONLY,
          `preflight:${name} - evidence for the nested repository`,
        ]);
        expect(both.blocked).toBe(false);
        expect(both.decisions.every((d) => d.outcome === "allow")).toBe(true);
      });
    }

    it("the command is matched by the gate at all: an empty ledger is denied, not skipped", async () => {
      const name = "lib\u2028z";
      const world = makeWorld([name]);
      const result = await run(`git -C vendor/${name} log`, world.outer, []);
      expect(result.blocked).toBe(true);
      expect(result.decisions.length).toBeGreaterThan(0);
    });
  });

  describe("two-sided effect: forms that were attributable or cwd-only stay exactly as they were", () => {
    it("a plain nested -C still demands the nested tag next to the outer one", async () => {
      const world = makeWorld(["libplain"]);
      const result = await run("git -C vendor/libplain log", world.outer, OUTER_ONLY);
      expect(result.blocked).toBe(true);
      expect(result.decisions.map((d) => d.ledgerTag).sort()).toEqual([
        "preflight:libplain",
        "preflight:outer-repo",
      ]);
    });

    it("a quoted plain -C keeps the documented cwd-only fallback (one decision, outer tag)", async () => {
      const world = makeWorld(["libplain"]);
      const result = await run("git -C 'vendor/libplain' log", world.outer, OUTER_ONLY);
      expect(result.decisions.map((d) => d.ledgerTag)).toEqual(["preflight:outer-repo"]);
      expect(result.blocked).toBe(false);
    });

    it("a backtick in a later argument is not a target: the gated read is decided on the cwd tag", async () => {
      const world = makeWorld([]);
      const result = await run("git log --grep='`x`'", world.outer, OUTER_ONLY);
      expect(result.decisions.map((d) => d.ledgerTag)).toEqual(["preflight:outer-repo"]);
      expect(result.blocked).toBe(false);
    });

    it("an opaque cd on the other side of a pipe does not reach the gated read", async () => {
      const world = makeWorld([BACKTICK_NAME]);
      const result = await run(`cd 'vendor/${BACKTICK_NAME}' | git log`, world.outer, OUTER_ONLY);
      expect(result.decisions.map((d) => d.ledgerTag)).toEqual(["preflight:outer-repo"]);
      expect(result.blocked).toBe(false);
    });

    it("an absolute cd after an opaque cd names its directory outright and is attributed to it", async () => {
      const world = makeWorld(["libplain", BACKTICK_NAME]);
      const result = await run(
        `cd 'vendor/${BACKTICK_NAME}' && cd ${world.nested["libplain"]} && git log`,
        world.outer,
        OUTER_ONLY,
      );
      expect(result.decisions.map((d) => d.ledgerTag).sort()).toEqual([
        "preflight:libplain",
        "preflight:outer-repo",
      ]);
    });
  });
});
