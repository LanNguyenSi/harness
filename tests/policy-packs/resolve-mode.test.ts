import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  MODE_ENV,
  resolveMode,
  toPackageMode,
} from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { parseManifest, type PolicyPack } from "../../src/schema/index.js";

// resolveMode/toPackageMode close a config-drift gap (harness task
// 5d73d78d): `policy_packs[].config.mode` in harness.yaml used to drive
// only prose (instructions.md, doctor's UX-drift comparison) while the
// ACTUAL agent-facing enforcement — the @lannguyensi/understanding-gate
// npm-backed Claude bins, and harness's own stdin-report gap-fill default
// in approve/understanding.ts — never received the configured value at
// all and silently behaved as `fast_confirm` regardless of what the
// operator configured. These tests pin the resolution priority (Env >
// config.mode > DEFAULT_MODE) and the interop coercion for `strict`, a
// harness-only mode the npm package cannot represent.

function packWith(config: Record<string, unknown>): PolicyPack {
  const m = parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", config }],
  });
  return m.policy_packs[0]!;
}

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[MODE_ENV];
  delete process.env[MODE_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[MODE_ENV];
  else process.env[MODE_ENV] = savedEnv;
});

describe("resolveMode — priority Env > config.mode > DEFAULT_MODE", () => {
  it("falls back to DEFAULT_MODE (grill_me) when neither env nor config.mode is set", () => {
    const pack = packWith({});
    expect(resolveMode(pack)).toEqual({ mode: DEFAULT_MODE, warning: null });
  });

  it("uses config.mode when set and no env override is present", () => {
    const pack = packWith({ mode: "fast_confirm" });
    expect(resolveMode(pack)).toEqual({ mode: "fast_confirm", warning: null });
  });

  it("env wins over a differently-set config.mode (the drift this task closes)", () => {
    process.env[MODE_ENV] = "fast_confirm";
    const pack = packWith({ mode: "grill_me" });
    expect(resolveMode(pack)).toEqual({ mode: "fast_confirm", warning: null });
  });

  it("env still wins when it agrees with config.mode", () => {
    process.env[MODE_ENV] = "strict";
    const pack = packWith({ mode: "strict" });
    expect(resolveMode(pack)).toEqual({ mode: "strict", warning: null });
  });

  it("an invalid env value is ignored (with a warning) and config.mode still wins", () => {
    process.env[MODE_ENV] = "bogus";
    const pack = packWith({ mode: "grill_me" });
    const result = resolveMode(pack);
    expect(result.mode).toBe("grill_me");
    expect(result.warning).toMatch(/UNDERSTANDING_GATE_MODE.*bogus.*unrecognised/);
  });

  it("an invalid config.mode falls back to DEFAULT_MODE with a warning", () => {
    const pack = packWith({ mode: "fastConfirm" });
    const result = resolveMode(pack);
    expect(result.mode).toBe(DEFAULT_MODE);
    expect(result.warning).toMatch(/config\.mode: unrecognised value/);
  });

  it("empty-string env is treated as unset, not as an invalid override", () => {
    process.env[MODE_ENV] = "";
    const pack = packWith({ mode: "strict" });
    expect(resolveMode(pack)).toEqual({ mode: "strict", warning: null });
  });
});

describe("toPackageMode — interop with @lannguyensi/understanding-gate's two-value mode", () => {
  it("passes fast_confirm and grill_me through unchanged", () => {
    expect(toPackageMode("fast_confirm")).toBe("fast_confirm");
    expect(toPackageMode("grill_me")).toBe("grill_me");
  });

  it("coerces strict to grill_me — the package has no strict variant of its own", () => {
    expect(toPackageMode("strict")).toBe("grill_me");
  });
});
