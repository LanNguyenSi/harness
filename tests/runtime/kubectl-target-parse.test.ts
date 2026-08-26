import { describe, expect, it } from "vitest";
import { parseKubectlTarget } from "../../src/runtime/kubectl-target-parse.js";

describe("parseKubectlTarget", () => {
  it("reads a trailing --context (space form)", () => {
    expect(
      parseKubectlTarget("kubectl delete namespace payments --context prod-eu-1"),
    ).toEqual({ context: "prod-eu-1", namespace: null });
  });

  it("reads a leading --context= (equals form)", () => {
    expect(
      parseKubectlTarget("kubectl --context=prod-eu-1 delete namespace payments"),
    ).toEqual({ context: "prod-eu-1", namespace: null });
  });

  it("reads --namespace (space and equals forms)", () => {
    expect(
      parseKubectlTarget("kubectl --namespace prod get pods"),
    ).toEqual({ context: null, namespace: "prod" });
    expect(
      parseKubectlTarget("kubectl --namespace=prod get pods"),
    ).toEqual({ context: null, namespace: "prod" });
  });

  it("reads -n (space, equals, and concatenated short-flag forms)", () => {
    expect(parseKubectlTarget("kubectl -n prod delete deployment web")).toEqual({
      context: null,
      namespace: "prod",
    });
    expect(parseKubectlTarget("kubectl -n=prod delete deployment web")).toEqual({
      context: null,
      namespace: "prod",
    });
    expect(parseKubectlTarget("kubectl -nprod delete deployment web")).toEqual({
      context: null,
      namespace: "prod",
    });
  });

  it("reads both --context and --namespace together", () => {
    expect(
      parseKubectlTarget("kubectl --context=prod-eu-1 -n payments delete namespace payments"),
    ).toEqual({ context: "prod-eu-1", namespace: "payments" });
  });

  it("returns null fields for a non-kubectl command head (negative control, AC4)", () => {
    // Same flag, same value shape, but the command is not a kubectl
    // invocation; the narrow head anchor (module doc scope point 1)
    // must not treat this as a kube signal at all.
    expect(parseKubectlTarget("terraform --context=prod-eu-1 destroy")).toEqual({
      context: null,
      namespace: null,
    });
    expect(parseKubectlTarget("echo --context=prod-eu-1")).toEqual({
      context: null,
      namespace: null,
    });
  });

  it("does not treat a kubectl-prefixed word as the kubectl head (word boundary)", () => {
    expect(parseKubectlTarget("kubectl-plugin --context=prod-eu-1 run")).toEqual({
      context: null,
      namespace: null,
    });
  });

  it("only reads flags from the first shell segment (chained command)", () => {
    // The kubectl invocation itself carries no --context; a SECOND,
    // chained command's --context must not be picked up.
    expect(
      parseKubectlTarget("kubectl get pods && echo --context=prod-eu-1"),
    ).toEqual({ context: null, namespace: null });
  });

  it("stops at a bare -- end-of-flags marker (review HIGH finding 2)", () => {
    // Measured pre-fix: this read the exec'd program's own --context as
    // a kubectl signal. Everything after a bare `--` belongs to the
    // exec'd command, not to kubectl itself.
    expect(
      parseKubectlTarget("kubectl exec -it pod -- myapp --context staging-1"),
    ).toEqual({ context: null, namespace: null });
  });

  it("last occurrence wins on a repeated flag", () => {
    expect(
      parseKubectlTarget("kubectl --context=staging-1 --context=prod-eu-1 delete namespace x"),
    ).toEqual({ context: "prod-eu-1", namespace: null });
  });

  it("returns null fields when neither flag is present", () => {
    expect(parseKubectlTarget("kubectl get pods")).toEqual({
      context: null,
      namespace: null,
    });
  });

  it("returns null fields for an empty or non-string command", () => {
    expect(parseKubectlTarget("")).toEqual({ context: null, namespace: null });
  });

  describe("blank values are treated as absent (review HIGH finding 2)", () => {
    // Measured pre-fix: `--context=` (empty string) overrode an
    // already-resolved ambient production context with "", which
    // `environment-resolver.ts` reads as "no context at all",
    // silencing a real ambient signal instead of leaving it alone.
    it("an empty --context= is absent, not the empty string", () => {
      expect(
        parseKubectlTarget("kubectl delete namespace payments --context="),
      ).toEqual({ context: null, namespace: null });
    });

    it("an empty quoted --context \"\" is absent", () => {
      expect(
        parseKubectlTarget('kubectl --context "" delete namespace payments'),
      ).toEqual({ context: null, namespace: null });
    });

    it("a whitespace-only quoted --namespace \"   \" is absent", () => {
      expect(
        parseKubectlTarget('kubectl --namespace "   " get pods'),
      ).toEqual({ context: null, namespace: null });
    });

    it("a trailing valueless --context (last token, no value follows) is absent", () => {
      expect(
        parseKubectlTarget("kubectl delete namespace payments --context"),
      ).toEqual({ context: null, namespace: null });
    });
  });

  describe("quote handling (review MEDIUM: untested quote branches)", () => {
    it("reads a double-quoted value containing a space", () => {
      expect(
        parseKubectlTarget('kubectl --context "prod eu" delete namespace payments'),
      ).toEqual({ context: "prod eu", namespace: null });
    });

    it("reads a single-quoted value", () => {
      expect(
        parseKubectlTarget("kubectl --context 'prod-eu-1' delete namespace payments"),
      ).toEqual({ context: "prod-eu-1", namespace: null });
    });

    it("reads a quoted value in the equals form (no space before the quote)", () => {
      expect(
        parseKubectlTarget('kubectl --context="prod eu" delete namespace payments'),
      ).toEqual({ context: "prod eu", namespace: null });
    });

    it("preserves a chain-boundary character (;) inside a quoted value", () => {
      // Discriminates the firstSegment quote-tracking: without it, the
      // `;` inside the quotes would be read as a real chain boundary
      // and truncate the segment mid-value.
      expect(
        parseKubectlTarget('kubectl --context "prod;eu" delete namespace payments'),
      ).toEqual({ context: "prod;eu", namespace: null });
    });

    it("preserves a chain-boundary character (|) inside a quoted value", () => {
      expect(
        parseKubectlTarget('kubectl --context "prod|eu" delete namespace payments'),
      ).toEqual({ context: "prod|eu", namespace: null });
    });

    it("does not throw on an unterminated quote", () => {
      // No throw is the contract; the exact swallow-the-rest value below
      // pins the current, documented, non-crashing fallback behavior
      // (module doc: "no escape/interpolation handling").
      expect(() =>
        parseKubectlTarget('kubectl --context "prod-eu delete namespace payments'),
      ).not.toThrow();
      expect(
        parseKubectlTarget('kubectl --context "prod-eu delete namespace payments'),
      ).toEqual({ context: "prod-eu delete namespace payments", namespace: null });
    });
  });
});
