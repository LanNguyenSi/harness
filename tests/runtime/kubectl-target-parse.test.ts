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

  it("reads -n (short-flag space form)", () => {
    expect(parseKubectlTarget("kubectl -n prod delete deployment web")).toEqual({
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
    // invocation — the narrow head anchor (module doc scope point 1)
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
});
