import { describe, expect, it } from "vitest";
import { parseBashPrefix } from "../../src/runtime/bash-prefix-parse.js";

describe("parseBashPrefix", () => {
  describe("inline env", () => {
    it("parses a single VAR=value prefix", () => {
      const r = parseBashPrefix("DATABASE_URL=postgres://prod terraform destroy");
      expect(r.inlineEnv).toEqual({ DATABASE_URL: "postgres://prod" });
      expect(r.cdTarget).toBe(null);
    });

    it("parses multiple chained assignments", () => {
      const r = parseBashPrefix("A=1 B=2 C=3 ./run");
      expect(r.inlineEnv).toEqual({ A: "1", B: "2", C: "3" });
    });

    it("supports single-quoted values verbatim", () => {
      const r = parseBashPrefix("URL='postgres://prod-host/db?x=y' cmd");
      expect(r.inlineEnv).toEqual({ URL: "postgres://prod-host/db?x=y" });
    });

    it("supports double-quoted values without $ interpolation", () => {
      const r = parseBashPrefix('URL="postgres://prod-host/$x" cmd');
      expect(r.inlineEnv).toEqual({ URL: "postgres://prod-host/$x" });
    });

    it("returns empty when the command does not start with VAR=", () => {
      const r = parseBashPrefix("terraform destroy");
      expect(r.inlineEnv).toEqual({});
    });

    it("bails cleanly on an unterminated quoted value", () => {
      const r = parseBashPrefix("URL='unterminated terraform destroy");
      expect(r.inlineEnv).toEqual({});
    });
  });

  describe("cd prefix", () => {
    it("parses cd <abs-path> && rest", () => {
      const r = parseBashPrefix("cd /tmp/risk-gate-test && terraform destroy");
      expect(r.cdTarget).toBe("/tmp/risk-gate-test");
    });

    it("parses cd <path>; rest", () => {
      const r = parseBashPrefix("cd /tmp/x; terraform destroy");
      expect(r.cdTarget).toBe("/tmp/x");
    });

    it("supports quoted paths with spaces", () => {
      const r = parseBashPrefix('cd "/tmp/risk gate" && terraform destroy');
      expect(r.cdTarget).toBe("/tmp/risk gate");
    });

    it("returns null when cd is missing the separator", () => {
      const r = parseBashPrefix("cd /tmp/risk-gate-test terraform destroy");
      expect(r.cdTarget).toBe(null);
    });

    it("does not match commands that merely START with 'cd' (cdex, cd&&)", () => {
      expect(parseBashPrefix("cdex /tmp && rm").cdTarget).toBe(null);
      expect(parseBashPrefix("cd&& rm").cdTarget).toBe(null);
    });

    it("does not match pushd (out of scope in v1)", () => {
      expect(parseBashPrefix("pushd /tmp/x && rm").cdTarget).toBe(null);
    });
  });

  describe("combined prefixes", () => {
    it("parses inline-env then cd in either order", () => {
      const a = parseBashPrefix("A=1 cd /tmp/x && terraform destroy");
      expect(a.inlineEnv).toEqual({ A: "1" });
      expect(a.cdTarget).toBe("/tmp/x");

      const b = parseBashPrefix("cd /tmp/x && A=1 terraform destroy");
      expect(b.inlineEnv).toEqual({ A: "1" });
      expect(b.cdTarget).toBe("/tmp/x");
    });

    it("captures inline-env even when a later cd does not parse", () => {
      const r = parseBashPrefix("A=1 cd /tmp/x terraform");
      expect(r.inlineEnv).toEqual({ A: "1" });
      expect(r.cdTarget).toBe(null);
    });

    it("captures only the first cd target", () => {
      const r = parseBashPrefix("cd /tmp/x && cd /tmp/y && rm");
      expect(r.cdTarget).toBe("/tmp/x");
    });
  });

  describe("degenerate input", () => {
    it("returns empty for empty / whitespace-only command", () => {
      expect(parseBashPrefix("")).toEqual({ inlineEnv: {}, cdTarget: null });
      expect(parseBashPrefix("   \t  ")).toEqual({ inlineEnv: {}, cdTarget: null });
    });

    it("returns empty for non-string input", () => {
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(undefined)).toEqual({ inlineEnv: {}, cdTarget: null });
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(null)).toEqual({ inlineEnv: {}, cdTarget: null });
    });
  });
});
